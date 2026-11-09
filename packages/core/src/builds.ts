import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { builds, deployments, gitSources, nodes, projects, releases } from '@yoal/db';
import {
	buildCreateSchema,
	contentUrl,
	gitSourceSchema,
	type BuildCreate,
	type BuildJob,
	type BuildReport,
	type BuildStatus,
	type BuildView,
	type GitSourceInput,
	type GitSourceView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { entriesFromZip } from './artifact.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { decrypt, encrypt, newId } from './util.ts';
import type { ProjectRow } from './projects.ts';
import type { GithubPushEvent } from './github-app.ts';
import {
	normaliseForgeEvent,
	pushedBranch,
	verifyDelivery,
	webhookEventName,
	webhookSource,
	type ForgePushEvent,
	type HeaderReader,
} from './forges/events.ts';
import type { RepositoryIdentity } from './forges/router.ts';

export type GitSourceRow = typeof gitSources.$inferSelect;
export type BuildRow = typeof builds.$inferSelect;

const ACTIVE: BuildStatus[] = ['queued', 'building'];
/** A Builder that dies mid-build leaves a claim behind; after this it is safe to retry. */
export const CLAIM_TTL_MS = 15 * 60 * 1000;
const LOG_LIMIT = 2_000_000;
const LOG_TAIL = 8_000;

/**
 * Git builds (D2, D3). The control plane never executes a build command: it queues a job and a
 * Builder on a node marked `can_build` claims it with that node's token. The Builder uploads the
 * artifact, and the control plane finalizes it through the normal release/deployment pipeline.
 */
export class BuildService {
	constructor(private readonly ctx: CoreContext) {}

	gitSource(principal: Principal, project: ProjectRow): GitSourceView | null {
		this.ctx.iam.require(principal, 'build:read', { type: 'project', id: project.id });
		const row = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		return row ? this.gitView(project, row) : null;
	}

	upsertGitSource(principal: Principal, project: ProjectRow, input: GitSourceInput): GitSourceView {
		this.ctx.iam.require(principal, 'build:create', { type: 'project', id: project.id });
		const parsed = gitSourceSchema.parse(input);
		const existing = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		const now = this.ctx.now();
		let secret = existing?.webhookSecret ?? null;
		if (parsed.webhookSecret) {
			const encrypted = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(parsed.webhookSecret));
			secret = `${encrypted.nonce}:${encrypted.ciphertext}`;
		}
		const values = {
			orgId: project.orgId,
			projectId: project.id,
			repoUrl: parsed.repoUrl,
			branch: parsed.branch,
			rootDir: parsed.rootDir,
			buildCommand: parsed.buildCommand,
			outputDir: parsed.outputDir,
			webhookSecret: secret,
			enabled: parsed.enabled,
			updatedAt: now,
		};
		if (existing) this.ctx.db.update(gitSources).set(values).where(eq(gitSources.id, existing.id)).run();
		else
			this.ctx.db
				.insert(gitSources)
				.values({ ...values, id: newId('git_'), createdBy: principal.userId, createdAt: now })
				.run();
		this.ctx.audit.record({
			principal,
			action: 'build.git_source',
			resource: 'build',
			resourceId: project.id,
			args: { project: project.slug, repoUrl: parsed.repoUrl, branch: parsed.branch },
			result: 'ok',
		});
		const row = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		if (!row) throw new CoreError('error', 'Git source was not saved.');
		// D174: a repository on a connected forge gets Yoal's webhook, so pushes need no setup.
		if (row.enabled) this.ctx.git.ensureWebhook(row.orgId, row.repoUrl);
		return this.gitView(project, row);
	}

	removeGitSource(principal: Principal, project: ProjectRow): void {
		this.ctx.iam.require(principal, 'build:create', { type: 'project', id: project.id });
		this.ctx.db.delete(gitSources).where(eq(gitSources.projectId, project.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'build.git_source_remove',
			resource: 'build',
			resourceId: project.id,
			args: { project: project.slug },
			result: 'ok',
		});
	}

	enqueue(principal: Principal, project: ProjectRow, input: BuildCreate): BuildView {
		this.ctx.iam.require(principal, 'build:create', { type: 'project', id: project.id });
		const parsed = buildCreateSchema.parse(input);
		const source = this.requireGitSource(project);
		if (!source.enabled) throw new ConflictError('Git builds are disabled for this project.');
		this.ctx.quota.assertCanCreateBuild(project.orgId, project.id);
		const now = this.ctx.now();
		const row: BuildRow = {
			id: newId('bld_'),
			orgId: project.orgId,
			projectId: project.id,
			gitSourceId: source.id,
			status: 'queued',
			ref: parsed.ref ?? source.branch,
			commitSha: null,
			commitMessage: parsed.message?.slice(0, 2000) ?? null,
			releaseId: null,
			deploymentId: null,
			nodeId: null,
			promote: parsed.promote,
			logTail: null,
			log: null,
			error: null,
			createdBy: principal.userId,
			createdAt: now,
			claimedAt: null,
			startedAt: null,
			finishedAt: null,
		};
		this.ctx.db.insert(builds).values(row).run();
		void this.reportGit(project, source, row);
		this.ctx.audit.record({
			principal,
			action: 'build.create',
			resource: 'build',
			resourceId: row.id,
			args: { project: project.slug, ref: row.ref, promote: row.promote },
			result: 'ok',
		});
		return this.view(project, row);
	}

	/**
	 * Return abandoned claims to the queue. A Builder crash (or a host reboot) would otherwise
	 * leave a build `building` forever. The log keeps a breadcrumb so the retry is explainable.
	 */
	recoverStaleClaims(now = this.ctx.now()): number {
		const stale = this.ctx.db
			.select()
			.from(builds)
			.where(and(eq(builds.status, 'building'), lt(builds.claimedAt, now - CLAIM_TTL_MS)))
			.all();
		for (const row of stale)
			this.requeue(row, `[builder] claim expired after ${Math.round(CLAIM_TTL_MS / 60_000)}m; requeued`);
		return stale.length;
	}

	/**
	 * Return every build a node holds to the queue, without waiting for the claim TTL. Used when
	 * the node is removed: its Builder can no longer report, so another Builder should take over.
	 */
	releaseNodeClaims(nodeId: string): number {
		const held = this.ctx.db
			.select()
			.from(builds)
			.where(and(eq(builds.status, 'building'), eq(builds.nodeId, nodeId)))
			.all();
		for (const row of held) this.requeue(row, '[builder] the claiming node was removed; requeued');
		return held.length;
	}

	private requeue(row: BuildRow, message: string): void {
		const log = this.appendText(row, `${message}\n`);
		this.ctx.logs.appendSystem({
			orgId: row.orgId,
			projectId: row.projectId,
			buildId: row.id,
			level: 'warn',
			message,
		});
		this.ctx.db
			.update(builds)
			.set({
				status: 'queued',
				nodeId: null,
				claimedAt: null,
				startedAt: null,
				finishedAt: null,
				...log,
			})
			.where(and(eq(builds.id, row.id), eq(builds.status, 'building')))
			.run();
	}

	/**
	 * Claim the oldest queued job. Only a node marked `can_build` may call this, and a node runs at
	 * most one build at a time: a second poll while a claim is live returns null. The select and
	 * conditional update happen in one synchronous transaction, so two pollers cannot claim the
	 * same row.
	 */
	async claim(nodeId: string): Promise<BuildJob | null> {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node || !node.canBuild) throw new CoreError('forbidden', 'This node is not a Builder.', 403);
		this.recoverStaleClaims();
		const now = this.ctx.now();
		const row = this.ctx.db.transaction((tx) => {
			const busy = tx
				.select({ id: builds.id })
				.from(builds)
				.where(and(eq(builds.nodeId, nodeId), eq(builds.status, 'building')))
				.get();
			if (busy) return null;
			const candidate = tx
				.select()
				.from(builds)
				.where(eq(builds.status, 'queued'))
				.orderBy(asc(builds.createdAt), asc(builds.id))
				.get();
			if (!candidate) return null;
			// Raw run so the conditional update can prove it won the row (Drizzle's bun-sqlite
			// `update().run()` does not surface `changes`).
			const updated = this.ctx.sqlite.run(
				"UPDATE builds SET status = 'building', node_id = ?, claimed_at = ?, started_at = ?, finished_at = NULL WHERE id = ? AND status = 'queued'",
				[nodeId, now, now, candidate.id],
			);
			return updated.changes === 1 ? candidate : null;
		});
		if (!row) return null;

		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.id, row.gitSourceId)).get();
		if (!source) {
			this.ctx.db
				.update(builds)
				.set({ status: 'failed', error: 'Git source was removed before the build started.', finishedAt: now })
				.where(eq(builds.id, row.id))
				.run();
			return null;
		}
		const objectKey = `builds/${row.id}.zip`;
		let uploadUrl: string;
		try {
			uploadUrl = await this.ctx.objectStore.presignPut(objectKey, 60 * 60);
		} catch (error) {
			// Never leave the row claimed when no Builder received a job.
			this.ctx.db
				.update(builds)
				.set({ status: 'queued', nodeId: null, claimedAt: null, startedAt: null })
				.where(eq(builds.id, row.id))
				.run();
			throw error;
		}
		// D164/D175: a repository covered by the org's GitHub App is cloned with a one-hour, read-only
		// token for that repository alone, one on a connected forge with a deploy or clone token for
		// its host; otherwise the Builder uses its own git credentials.
		const access = await this.ctx.git.cloneAuth(source.orgId, source.repoUrl);
		return {
			buildId: row.id,
			repoUrl: source.repoUrl,
			ref: row.ref,
			commitSha: row.commitSha,
			rootDir: source.rootDir,
			buildCommand: source.buildCommand,
			outputDir: source.outputDir,
			uploadUrl,
			auth: access ? { username: access.username, password: access.token, host: access.host } : null,
		};
	}

	/** Builder progress/completion. `succeeded` finalizes the uploaded artifact into a deployment. */
	async report(nodeId: string, buildId: string, input: BuildReport): Promise<BuildView> {
		const row = this.ctx.db.select().from(builds).where(eq(builds.id, buildId)).get();
		if (!row) throw new NotFoundError('Build');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This build was claimed by another node.', 403);
		if (row.status !== 'building') throw new ConflictError(`Build is already ${row.status}.`);
		if (input.status === 'queued') throw new ValidationError('A Builder cannot return a build to the queue.');
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		if (!project || project.deletedAt) {
			// The project was deleted mid-build: never deploy into it, and leave nothing claimed.
			this.ctx.db
				.update(builds)
				.set({ status: 'cancelled', error: 'Project was deleted.', finishedAt: this.ctx.now() })
				.where(eq(builds.id, row.id))
				.run();
			void this.cleanupObject(`builds/${row.id}.zip`);
			throw new NotFoundError('Project');
		}
		const now = this.ctx.now();
		const system = buildSystemPrincipal('system:build-claim', row.orgId, {
			actingFor: { kind: 'user', id: row.createdBy },
		});
		const objectKey = `builds/${row.id}.zip`;
		const patch: Partial<BuildRow> = {
			status: input.status,
			commitSha: input.commitSha ?? row.commitSha,
			commitMessage: input.commitMessage ?? row.commitMessage,
			error: input.error ?? null,
			finishedAt: input.status === 'building' ? null : now,
		};

		if (input.status === 'succeeded') {
			try {
				const zip = await this.ctx.objectStore.get(objectKey);
				const entries = entriesFromZip(zip);
				const deployment = await this.ctx.deployments.deployEntries(system, project, entries, {
					promote: row.promote,
					precompress: true,
					message: row.commitMessage ?? `Git build ${row.ref}`,
				});
				// `deployment.releaseId` points at the release row; keep both ids on the build.
				const deploymentRow = this.ctx.db.select().from(deployments).where(eq(deployments.id, deployment.id)).get();
				if (!deploymentRow) throw new CoreError('error', 'Deployment disappeared during finalize.', 500);
				patch.releaseId = deploymentRow.releaseId;
				patch.deploymentId = deploymentRow.id;
				patch.error = null;
				this.ctx.audit.record({
					principal: system,
					action: 'build.succeeded',
					resource: 'build',
					resourceId: row.id,
					args: {
						project: project.slug,
						ref: row.ref,
						deploymentId: deploymentRow.id,
						releaseSha256: deployment.release.sha256,
					},
					result: 'ok',
				});
			} catch (error) {
				// A malformed archive or a rejected release is a failed build, not a server error:
				// record it on the row so the dashboard can explain what happened.
				patch.status = 'failed';
				patch.error = this.errorText(error);
				patch.finishedAt = now;
				this.ctx.audit.record({
					principal: system,
					action: 'build.failed',
					resource: 'build',
					resourceId: row.id,
					args: { project: project.slug, ref: row.ref },
					result: 'error',
					error: patch.error,
				});
			}
			await this.cleanupObject(objectKey);
		} else if (input.status === 'failed' || input.status === 'cancelled') {
			if (!patch.error && input.status === 'cancelled') patch.error = 'Build was cancelled.';
			this.ctx.audit.record({
				principal: system,
				action: `build.${input.status}`,
				resource: 'build',
				resourceId: row.id,
				args: { project: project.slug, ref: row.ref, nodeId },
				result: input.status === 'failed' ? 'error' : 'ok',
				error: patch.error ?? undefined,
			});
			await this.cleanupObject(objectKey);
		}

		this.ctx.db.update(builds).set(patch).where(eq(builds.id, buildId)).run();
		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.id, row.gitSourceId)).get();
		if (source) void this.reportGit(project, source, { ...row, ...patch } as BuildRow);
		if (patch.status === 'failed')
			this.ctx.events.emitDeployment(row.orgId, row.projectId, 'failed', {
				project: project.slug,
				buildId: row.id,
				ref: row.ref,
				commitSha: patch.commitSha ?? null,
				error: patch.error ?? null,
			});
		this.ctx.logs.appendSystem({
			orgId: row.orgId,
			projectId: row.projectId,
			buildId,
			nodeId,
			level: patch.status === 'succeeded' ? 'info' : 'error',
			message:
				patch.status === 'succeeded'
					? `Build succeeded${patch.deploymentId ? `; deployment ${patch.deploymentId}` : ''}.`
					: `Build ${patch.status}: ${patch.error ?? 'no detail'}`,
		});
		this.ctx.projects.bump(row.orgId);
		return this.view(project, { ...row, ...patch } as BuildRow);
	}

	/**
	 * Append a chunk of Builder output. The ordered log drain keeps the full stream for SSE and
	 * the row keeps a bounded copy for the REST/CLI compatibility path.
	 */
	appendLog(nodeId: string, buildId: string, text: string): boolean {
		return this.ctx.logs.appendBuildText(nodeId, buildId, text);
	}

	/** Cancel every queued or running build of a project being deleted. Returns the count. */
	cancelForProject(projectId: string): number {
		const active = this.ctx.db
			.select({ id: builds.id })
			.from(builds)
			.where(and(eq(builds.projectId, projectId), inArray(builds.status, ACTIVE)))
			.all();
		if (!active.length) return 0;
		this.ctx.db
			.update(builds)
			.set({ status: 'cancelled', error: 'Project was deleted.', finishedAt: this.ctx.now() })
			.where(and(eq(builds.projectId, projectId), inArray(builds.status, ACTIVE)))
			.run();
		for (const { id } of active) void this.cleanupObject(`builds/${id}.zip`);
		return active.length;
	}

	cancel(principal: Principal, project: ProjectRow, buildId: string): BuildView {
		const row = this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, project.id))).get();
		if (!row) throw new NotFoundError('Build');
		this.ctx.iam.require(principal, 'build:cancel', { type: 'build', id: row.id, projectId: project.id });
		if (!ACTIVE.includes(row.status as BuildStatus)) throw new ConflictError(`Build is already ${row.status}.`);
		const now = this.ctx.now();
		const status = 'cancelled' as const;
		this.ctx.db
			.update(builds)
			.set({ status, error: 'Build was cancelled.', finishedAt: now })
			.where(and(eq(builds.id, buildId), eq(builds.status, row.status)))
			.run();
		this.ctx.logs.appendSystem({
			orgId: row.orgId,
			projectId: row.projectId,
			buildId,
			nodeId: row.nodeId,
			level: 'warn',
			message: 'Build was cancelled by an operator.',
		});
		void this.cleanupObject(`builds/${row.id}.zip`);
		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.id, row.gitSourceId)).get();
		if (source) void this.reportGit(project, source, { ...row, status, finishedAt: now });
		this.ctx.audit.record({
			principal,
			action: 'build.cancel',
			resource: 'build',
			resourceId: buildId,
			args: { project: project.slug, ref: row.ref },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return this.view(project, { ...row, status, error: 'Build was cancelled.', finishedAt: now });
	}

	list(principal: Principal, project: ProjectRow, options: { limit?: number; full?: boolean } = {}): BuildView[] {
		this.ctx.iam.require(principal, 'build:read', { type: 'project', id: project.id });
		return this.ctx.db
			.select()
			.from(builds)
			.where(eq(builds.projectId, project.id))
			.orderBy(desc(builds.createdAt))
			.limit(Math.min(options.limit ?? 50, 200))
			.all()
			.map((row) => this.view(project, row, options.full));
	}

	get(principal: Principal, project: ProjectRow, buildId: string): BuildView {
		const row = this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, project.id))).get();
		if (!row) throw new NotFoundError('Build');
		this.ctx.iam.require(principal, 'build:read', { type: 'build', id: row.id, projectId: project.id });
		return this.view(project, row, true);
	}

	/**
	 * A delivery to the project's own webhook (`/api/webhooks/git/<project>`). GitHub, Gitea and
	 * Forgejo sign it with the stored secret; GitLab sends it in `X-Gitlab-Token` (D174). Returns null
	 * when the push is for another branch, the source is disabled, or Yoal's GitHub App or a
	 * Yoal-created forge hook already delivers this repository's pushes (D165): one push must
	 * never queue two builds.
	 */
	async handleWebhook(project: ProjectRow, rawBody: string, headers: HeaderReader): Promise<BuildView | null> {
		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		const from = webhookSource(headers) ?? 'github';
		const eventName = webhookEventName(from, headers);
		if (from !== 'gitlab' && eventName !== 'push') return null;
		if (!source || !source.enabled) return null;
		this.verifySignature(source, from, rawBody, headers);
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			throw new ValidationError('Webhook payload is not valid JSON.');
		}
		const event = normaliseForgeEvent(from, eventName, payload);
		if (event.kind !== 'push') return null;
		if (await this.ctx.git.deliversFor(project.orgId, source.repoUrl, event.fullName)) return null;
		return this.queuePush(project, source, event, 'build.webhook');
	}

	/** `handleWebhook` with GitHub's two headers (kept for callers and tests that pass them). */
	async handleGithubWebhook(project: ProjectRow, rawBody: string, signature: string | null, event: string | null): Promise<BuildView | null> {
		return this.handleWebhook(project, rawBody, headerReader({ 'x-hub-signature-256': signature, 'x-github-event': event ?? 'push' }));
	}

	/** A push delivered through Yoal's GitHub App (D165). Returns the build ids. */
	async handleAppPush(orgId: string, fullName: string, payload: GithubPushEvent): Promise<string[]> {
		const event = normaliseForgeEvent('github', 'push', payload);
		if (event.kind !== 'push') return [];
		return this.handlePush(orgId, this.ctx.git.githubIdentity(fullName), event);
	}

	/**
	 * A push delivered by a Yoal-managed hook (the GitHub App, or a forge connection's hook, D174):
	 * every enabled git source in the org whose repository has `identity` and whose branch was
	 * pushed queues a build. Returns the build ids.
	 */
	async handlePush(orgId: string, identity: RepositoryIdentity, event: ForgePushEvent): Promise<string[]> {
		const candidates = this.ctx.db
			.select({ source: gitSources, project: projects })
			.from(gitSources)
			.innerJoin(projects, eq(projects.id, gitSources.projectId))
			.where(and(eq(gitSources.orgId, orgId), eq(gitSources.enabled, true)))
			.all()
			.filter(({ source, project }) => !project.deletedAt && this.ctx.git.identity(orgId, source.repoUrl) === identity);
		const queued: string[] = [];
		for (const { source, project } of candidates) {
			try {
				const build = this.queuePush(project, source, event, identity.startsWith('github:') ? 'build.github_app' : 'build.forge_hook');
				if (build) queued.push(build.id);
			} catch (error) {
				// A quota refusal for one project must not drop the push for the others.
				console.warn(`[builds] ${project.slug}: push ignored: ${(error as Error).message}`);
			}
		}
		return queued;
	}

	private queuePush(project: ProjectRow, source: GitSourceRow, event: ForgePushEvent, action: string): BuildView | null {
		const branch = pushedBranch(event);
		if (!branch || branch !== source.branch) return null;
		if (event.deleted || !event.after) return null;
		this.ctx.quota.assertCanCreateBuild(project.orgId, project.id);
		const now = this.ctx.now();
		const row: BuildRow = {
			id: newId('bld_'),
			orgId: project.orgId,
			projectId: project.id,
			gitSourceId: source.id,
			status: 'queued',
			ref: branch,
			commitSha: event.after,
			commitMessage: event.message?.slice(0, 2000) ?? null,
			releaseId: null,
			deploymentId: null,
			nodeId: null,
			promote: true,
			logTail: null,
			log: null,
			error: null,
			createdBy: source.createdBy,
			createdAt: now,
			claimedAt: null,
			startedAt: null,
			finishedAt: null,
		};
		this.ctx.db.insert(builds).values(row).run();
		void this.reportGit(project, source, row);
		this.ctx.audit.record({
			action,
			resource: 'build',
			resourceId: row.id,
			orgId: project.orgId,
			args: { project: project.slug, ref: branch, commit: event.after },
			result: 'ok',
		});
		return this.view(project, row);
	}

	/**
	 * Commit status `yoal-build/<project>` for every state a build passes through, and a
	 * deployment when it succeeds (D164, D176): through the GitHub App or the forge connection that
	 * serves the repository. Best effort, never throws.
	 */
	private async reportGit(project: ProjectRow, source: GitSourceRow, row: BuildRow): Promise<void> {
		try {
			if (!row.commitSha) return;
			const link = this.ctx.git.link(project.orgId, source.repoUrl);
			if (link.kind === 'generic') return;
			const origin = this.ctx.config.platformOrigin.replace(/\/+$/, '');
			const buildUrl = `${origin}/projects/${encodeURIComponent(project.slug)}?tab=builds`;
			const state =
				row.status === 'succeeded'
					? 'success'
					: row.status === 'failed'
						? 'failure'
						: row.status === 'cancelled'
							? 'error'
							: row.status === 'building'
								? 'running'
								: 'pending';
			const description =
				row.status === 'queued'
					? 'Waiting for a build node'
					: row.status === 'building'
						? 'Building'
						: row.status === 'succeeded'
							? row.promote
								? 'Built and deployed'
								: 'Built; preview deployed'
							: `${row.status}${row.error ? `: ${row.error.split('\n')[0]}` : ''}`;
			await this.ctx.git.commitStatus(project.orgId, source.repoUrl, {
				sha: row.commitSha,
				state,
				context: `yoal-build/${project.slug}`,
				description,
				targetUrl: buildUrl,
			});
			if (row.status !== 'succeeded' || !row.deploymentId) return;
			const deployment = this.ctx.db.select().from(deployments).where(eq(deployments.id, row.deploymentId)).get();
			const projectView = this.ctx.projects.view(project);
			const environmentUrl = row.promote
				? projectView.productionUrl
				: deployment?.previewHost
					? contentUrl(this.ctx.config.platformOrigin, deployment.previewHost)
					: projectView.productionUrl;
			await this.ctx.git.deployment(project.orgId, source.repoUrl, {
				sha: row.commitSha,
				ref: row.ref,
				environment: row.promote ? project.slug : `${project.slug}-preview`,
				production: row.promote,
				description: `Yoal build ${row.id}`,
				environmentUrl,
				logUrl: buildUrl,
			});
		} catch (error) {
			console.warn(`[builds] git provider report for ${row.id} skipped: ${(error as Error).message}`);
		}
	}

	private verifySignature(source: GitSourceRow, from: ReturnType<typeof webhookSource> & string, rawBody: string, headers: HeaderReader): void {
		// An unsigned public webhook would let anyone trigger builds (and spend build minutes).
		if (!source.webhookSecret)
			throw new CoreError('unauthorized', 'This project has no webhook secret. Set one before using webhooks.', 401);
		if (!headers.get('x-hub-signature-256') && !headers.get('x-gitea-signature') && !headers.get('x-forgejo-signature') && !headers.get('x-gitlab-token'))
			throw new CoreError('unauthorized', 'Missing webhook signature (X-Hub-Signature-256, X-Gitea-Signature or X-Gitlab-Token).', 401);
		const [nonce, ciphertext] = source.webhookSecret.split(':');
		if (!nonce || !ciphertext) throw new CoreError('error', 'Stored webhook secret is corrupt.', 500);
		const secret = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, ciphertext, nonce));
		if (!verifyDelivery(from, secret, rawBody, headers)) throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
	}

	private requireGitSource(project: ProjectRow): GitSourceRow {
		const row = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		if (!row) throw new NotFoundError('Git source');
		return row;
	}

	private appendText(row: BuildRow, text: string): { log: string; logTail: string } {
		const log = `${row.log ?? ''}${text}`.slice(-LOG_LIMIT);
		return { log, logTail: log.slice(-LOG_TAIL) };
	}

	private async cleanupObject(key: string): Promise<void> {
		try {
			await this.ctx.objectStore.delete(key);
		} catch {
			/* best effort: a stale upload is harmless and the presigned URL expires */
		}
	}

	private errorText(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
	}

	private releaseSha(releaseId: string | null): string | null {
		if (!releaseId) return null;
		return this.ctx.db.select({ sha256: releases.sha256 }).from(releases).where(eq(releases.id, releaseId)).get()?.sha256 ?? null;
	}

	private gitView(project: ProjectRow, row: GitSourceRow): GitSourceView {
		return {
			id: row.id,
			projectId: project.id,
			projectSlug: project.slug,
			repoUrl: row.repoUrl,
			branch: row.branch,
			rootDir: row.rootDir,
			buildCommand: row.buildCommand,
			outputDir: row.outputDir,
			enabled: row.enabled,
			hasWebhookSecret: Boolean(row.webhookSecret),
			githubAppInstallationId: this.ctx.githubApp.repositoryLink(row.orgId, row.repoUrl).installationId,
			gitProvider: this.ctx.git.link(row.orgId, row.repoUrl),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private view(project: ProjectRow, row: BuildRow, full = false): BuildView {
		return {
			id: row.id,
			projectId: project.id,
			projectSlug: project.slug,
			status: row.status,
			ref: row.ref,
			commitSha: row.commitSha,
			commitMessage: row.commitMessage,
			releaseSha256: this.releaseSha(row.releaseId),
			deploymentId: row.deploymentId,
			error: row.error,
			logTail: full ? (row.log ?? row.logTail) : row.logTail,
			createdAt: new Date(row.createdAt).toISOString(),
			startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
		};
	}
}

/** A header reader over a plain map (tests and the GitHub-only wrappers). */
export function headerReader(values: Record<string, string | null | undefined>): HeaderReader {
	const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value ?? null]));
	return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}
