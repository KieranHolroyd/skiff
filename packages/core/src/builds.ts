import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { builds, gitSources, nodes, projects, releases } from '@skiff/db';
import {
	buildCreateSchema,
	gitSourceSchema,
	requirePermission,
	type BuildCreate,
	type BuildJob,
	type BuildReport,
	type BuildStatus,
	type BuildView,
	type GitSourceInput,
	type GitSourceView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { entriesFromZip } from './artifact.ts';
import { buildPrincipal } from './orgs.ts';
import { decrypt, encrypt, newId } from './util.ts';
import type { ProjectRow } from './projects.ts';

export type GitSourceRow = typeof gitSources.$inferSelect;
export type BuildRow = typeof builds.$inferSelect;

const ACTIVE: BuildStatus[] = ['queued', 'building'];

/**
 * Git builds (D2, D3). The control plane never executes a build command: it queues a job and a
 * Builder on a node marked `can_build` claims it with that node's token. The Builder uploads the
 * artifact, and the control plane finalizes it through the normal release/deployment pipeline.
 */
export class BuildService {
	constructor(private readonly ctx: CoreContext) {}

	gitSource(principal: Principal, project: ProjectRow): GitSourceView | null {
		requirePermission(principal, 'build:read');
		const row = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		return row ? this.gitView(project, row) : null;
	}

	upsertGitSource(principal: Principal, project: ProjectRow, input: GitSourceInput): GitSourceView {
		requirePermission(principal, 'build:create');
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
		return this.gitView(project, row);
	}

	removeGitSource(principal: Principal, project: ProjectRow): void {
		requirePermission(principal, 'build:create');
		this.ctx.db.delete(gitSources).where(eq(gitSources.projectId, project.id)).run();
	}

	enqueue(principal: Principal, project: ProjectRow, input: BuildCreate): BuildView {
		requirePermission(principal, 'build:create');
		const parsed = buildCreateSchema.parse(input);
		const source = this.requireGitSource(project);
		if (!source.enabled) throw new ConflictError('Git builds are disabled for this project.');
		const now = this.ctx.now();
		const row: BuildRow = {
			id: newId('bld_'),
			orgId: project.orgId,
			projectId: project.id,
			gitSourceId: source.id,
			status: 'queued',
			ref: parsed.ref ?? source.branch,
			commitSha: null,
			commitMessage: null,
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

	/** Claim the oldest queued job. Only a node marked `can_build` may call this. */
	async claim(nodeId: string): Promise<BuildJob | null> {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node || !node.canBuild) throw new CoreError('forbidden', 'This node is not a Builder.', 403);
		const row = this.ctx.db
			.select()
			.from(builds)
			.where(eq(builds.status, 'queued'))
			.orderBy(asc(builds.createdAt))
			.get();
		if (!row) return null;
		const now = this.ctx.now();
		this.ctx.db
			.update(builds)
			.set({ status: 'building', nodeId, claimedAt: now, startedAt: now })
			.where(eq(builds.id, row.id))
			.run();
		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.id, row.gitSourceId)).get();
		if (!source) throw new NotFoundError('Git source');
		const uploadUrl = await this.ctx.objectStore.presignPut(`builds/${row.id}.zip`, 60 * 60);
		return {
			buildId: row.id,
			repoUrl: source.repoUrl,
			ref: row.ref,
			commitSha: row.commitSha,
			rootDir: source.rootDir,
			buildCommand: source.buildCommand,
			outputDir: source.outputDir,
			uploadUrl,
			auth: null,
		};
	}

	/** Builder progress/completion. `succeeded` finalizes the uploaded artifact into a deployment. */
	async report(nodeId: string, buildId: string, input: BuildReport): Promise<BuildView> {
		const row = this.ctx.db.select().from(builds).where(eq(builds.id, buildId)).get();
		if (!row) throw new NotFoundError('Build');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This build was claimed by another node.', 403);
		if (!ACTIVE.includes(row.status as BuildStatus))
			throw new ConflictError(`Build is already ${row.status}.`);
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		if (!project) throw new NotFoundError('Project');
		const now = this.ctx.now();
		const patch: Partial<BuildRow> = {
			status: input.status,
			commitSha: input.commitSha ?? row.commitSha,
			commitMessage: input.commitMessage ?? row.commitMessage,
			error: input.error ?? null,
			finishedAt: input.status === 'building' ? null : now,
		};
		if (input.status === 'succeeded') {
			const objectKey = `builds/${row.id}.zip`;
			const zip = await this.ctx.objectStore.get(objectKey);
			const entries = entriesFromZip(zip);
			const system = buildPrincipal({
				kind: 'system',
				userId: row.createdBy,
				orgId: row.orgId,
				role: 'owner',
			});
			const deployment = await this.ctx.deployments.deployEntries(system, project, entries, {
				promote: row.promote,
				precompress: true,
				message: row.commitMessage ?? `Git build ${row.ref}`,
			});
			await this.ctx.objectStore.delete(objectKey);
			patch.releaseId = deployment.id;
			patch.deploymentId = deployment.id;
		}
		this.ctx.db.update(builds).set(patch).where(eq(builds.id, buildId)).run();
		this.ctx.projects.bump(row.orgId);
		return this.view(project, { ...row, ...patch } as BuildRow);
	}

	/** Compressed build logs; `tail` is enough for the list view. */
	appendLog(nodeId: string, buildId: string, text: string): void {
		const row = this.ctx.db.select().from(builds).where(eq(builds.id, buildId)).get();
		if (!row || row.nodeId !== nodeId) return;
		const log = `${row.log ?? ''}${text}`.slice(-2_000_000);
		this.ctx.db.update(builds).set({ log, logTail: log.slice(-8_000) }).where(eq(builds.id, buildId)).run();
	}

	cancel(principal: Principal, project: ProjectRow, buildId: string): BuildView {
		requirePermission(principal, 'build:cancel');
		const row = this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, project.id))).get();
		if (!row) throw new NotFoundError('Build');
		if (!ACTIVE.includes(row.status as BuildStatus)) throw new ConflictError(`Build is already ${row.status}.`);
		this.ctx.db
			.update(builds)
			.set({ status: 'cancelled', finishedAt: this.ctx.now() })
			.where(eq(builds.id, buildId))
			.run();
		return this.view(project, { ...row, status: 'cancelled', finishedAt: this.ctx.now() });
	}

	list(principal: Principal, project: ProjectRow, options: { limit?: number; full?: boolean } = {}): BuildView[] {
		requirePermission(principal, 'build:read');
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
		requirePermission(principal, 'build:read');
		const row = this.ctx.db.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, project.id))).get();
		if (!row) throw new NotFoundError('Build');
		return this.view(project, row, true);
	}

	/**
	 * GitHub push delivery. The URL names the project; the signature (when configured) proves the
	 * payload. Returns null when the push is for another branch or the repository is not configured.
	 */
	async handleGithubWebhook(
		project: ProjectRow,
		rawBody: string,
		signature: string | null,
		event: string | null,
	): Promise<BuildView | null> {
		if (event !== 'push') return null;
		const source = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		if (!source || !source.enabled) return null;
		this.verifySignature(source, rawBody, signature);
		const payload = JSON.parse(rawBody) as {
			ref?: string;
			after?: string;
			head_commit?: { message?: string };
		};
		const branch = payload.ref?.replace('refs/heads/', '');
		if (!branch || branch !== source.branch) return null;
		const now = this.ctx.now();
		const row: BuildRow = {
			id: newId('bld_'),
			orgId: project.orgId,
			projectId: project.id,
			gitSourceId: source.id,
			status: 'queued',
			ref: branch,
			commitSha: payload.after ?? null,
			commitMessage: payload.head_commit?.message?.slice(0, 2000) ?? null,
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
		this.ctx.audit.record({
			action: 'build.webhook',
			resource: 'build',
			resourceId: row.id,
			args: { project: project.slug, ref: branch, commit: payload.after },
			result: 'ok',
		});
		return this.view(project, row);
	}

	private verifySignature(source: GitSourceRow, rawBody: string, signature: string | null): void {
		if (!source.webhookSecret) return;
		if (!signature) throw new CoreError('unauthorized', 'Missing X-Hub-Signature-256.', 401);
		const [nonce, ciphertext] = source.webhookSecret.split(':');
		if (!nonce || !ciphertext) throw new CoreError('error', 'Stored webhook secret is corrupt.', 500);
		const secret = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, ciphertext, nonce));
		const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
		const given = signature.trim();
		if (expected.length !== given.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(given)))
			throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
	}

	private requireGitSource(project: ProjectRow): GitSourceRow {
		const row = this.ctx.db.select().from(gitSources).where(eq(gitSources.projectId, project.id)).get();
		if (!row) throw new NotFoundError('Git source');
		return row;
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
