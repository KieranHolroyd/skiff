import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import {
	nodes,
	pipelineArtifacts,
	pipelineCaches,
	pipelineDeploys,
	pipelineEnvironments,
	pipelineJobs,
	pipelineLogLines,
	pipelineProjectLinks,
	pipelineRepositories,
	pipelineRuns,
	pipelineSecrets,
	pipelineSteps,
	pipelineTriggers,
	pipelineVariables,
	projects,
} from '@skiff/db';
import {
	pipelineDispatchSchema,
	pipelineEnvironmentSetSchema,
	pipelineProjectLinkSchema,
	pipelineRepositoryCreateSchema,
	pipelineRepositoryUpdateSchema,
	pipelineSecretNameSchema,
	pipelineSecretSetSchema,
	pipelineVariableSetSchema,
	requirePermission,
	type PipelineConclusion,
	type PipelineDispatch,
	type PipelineEnvironmentSet,
	type PipelineEnvironmentView,
	type PipelineEventName,
	type PipelineIsolationTier,
	type PipelineJobView,
	type PipelineLogLine,
	type PipelineProjectLink,
	type PipelineProjectLinkView,
	type PipelineRepositoryCreate,
	type PipelineRepositoryUpdate,
	type PipelineRepositoryView,
	type PipelineRunSummary,
	type PipelineRunView,
	type PipelineSecretSet,
	type PipelineSecretView,
	type PipelineStepView,
	type PipelineTriggerView,
	type PipelineVariableView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { cronMatches } from './cron.ts';
import { decrypt, encrypt, newId } from './util.ts';
import {
	PipelineEngine,
	fullRef,
	type PipelineSubscription,
	type PipelineJobRow,
	type PipelineRepositoryRow,
	type PipelineRunRow,
	type PipelineTriggerRow,
} from './pipeline-engine.ts';

const iso = (value: number | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

function parse<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** What the webhook did, for the delivery log on GitHub's side. */
export interface PipelineWebhookResult {
	accepted: boolean;
	reason?: string;
	triggerId?: string;
}

interface GithubRepo {
	full_name?: string;
}

interface GithubPushPayload {
	ref?: string;
	after?: string;
	deleted?: boolean;
	head_commit?: { message?: string } | null;
	commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
	pusher?: { name?: string };
	sender?: { login?: string };
	repository?: GithubRepo;
}

interface GithubPullRequestPayload {
	action?: string;
	number?: number;
	pull_request?: {
		title?: string;
		head?: { sha?: string; ref?: string; repo?: GithubRepo | null };
		base?: { ref?: string; repo?: GithubRepo | null };
	};
	sender?: { login?: string };
}

/**
 * Pipelines (docs/PIPELINES.md): repositories, their secrets, variables, environments and deploy
 * targets, dispatch and webhook triggers, and the run/job/log views every surface reads. The job
 * DAG, claims and the job-token API are in `PipelineEngine` (`this.engine`).
 *
 * Permissions reuse `build:*` (W15: the git build is a one-job pipeline): `build:read` views,
 * `build:create` dispatches and manages repositories, `build:cancel` cancels. Secrets also need
 * `secret:create`; linking a deploy target needs `deployment:promote`; approving an environment
 * needs an org owner or admin.
 */
export class PipelineService {
	readonly engine: PipelineEngine;
	private lastScheduleMinute = 0;

	constructor(private readonly ctx: CoreContext) {
		this.engine = new PipelineEngine(ctx);
	}

	// --- repositories -------------------------------------------------------------------

	listRepositories(principal: Principal): PipelineRepositoryView[] {
		requirePermission(principal, 'build:read');
		return this.ctx.db
			.select()
			.from(pipelineRepositories)
			.where(eq(pipelineRepositories.orgId, principal.orgId))
			.orderBy(asc(pipelineRepositories.name))
			.all()
			.map((row) => this.repositoryView(row));
	}

	getRepository(principal: Principal, name: string): PipelineRepositoryView {
		requirePermission(principal, 'build:read');
		return this.repositoryView(this.requireRepository(principal, name));
	}

	createRepository(principal: Principal, input: PipelineRepositoryCreate): PipelineRepositoryView {
		requirePermission(principal, 'build:create');
		const parsed = pipelineRepositoryCreateSchema.parse(input);
		const taken = this.ctx.db
			.select({ id: pipelineRepositories.id })
			.from(pipelineRepositories)
			.where(and(eq(pipelineRepositories.orgId, principal.orgId), eq(pipelineRepositories.name, parsed.name)))
			.get();
		if (taken) throw new ConflictError(`A repository named "${parsed.name}" already exists.`);
		const now = this.ctx.now();
		const row: PipelineRepositoryRow = {
			id: newId('prp_'),
			orgId: principal.orgId,
			name: parsed.name,
			cloneUrl: parsed.cloneUrl,
			provider: parsed.provider,
			defaultBranch: parsed.defaultBranch,
			defaultImage: parsed.defaultImage ?? null,
			webhookSecret: parsed.webhookSecret ? this.sealWebhookSecret(parsed.webhookSecret) : null,
			enabled: true,
			nextRunNumber: 1,
			schedulesJson: '[]',
			minIsolationJson: JSON.stringify(parsed.minIsolation ?? {}),
			statusToken: parsed.statusToken ? this.ctx.secrets.seal(principal.orgId, parsed.statusToken) : null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(pipelineRepositories).values(row).run();
		this.audit(principal, 'pipeline.repository.create', row.id, { name: row.name, cloneUrl: row.cloneUrl });
		return this.repositoryView(row);
	}

	updateRepository(principal: Principal, name: string, input: PipelineRepositoryUpdate): PipelineRepositoryView {
		requirePermission(principal, 'build:create');
		const row = this.requireRepository(principal, name);
		const parsed = pipelineRepositoryUpdateSchema.parse(input);
		const patch: Partial<PipelineRepositoryRow> = { updatedAt: this.ctx.now() };
		if (parsed.cloneUrl !== undefined) patch.cloneUrl = parsed.cloneUrl;
		if (parsed.provider !== undefined) patch.provider = parsed.provider;
		if (parsed.defaultBranch !== undefined) patch.defaultBranch = parsed.defaultBranch;
		if (parsed.defaultImage !== undefined) patch.defaultImage = parsed.defaultImage;
		if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
		if (parsed.webhookSecret !== undefined)
			patch.webhookSecret = parsed.webhookSecret ? this.sealWebhookSecret(parsed.webhookSecret) : null;
		if (parsed.statusToken !== undefined)
			patch.statusToken = parsed.statusToken ? this.ctx.secrets.seal(row.orgId, parsed.statusToken) : null;
		if (parsed.minIsolation !== undefined) {
			// Loosening isolation is an owner/admin decision, like environment rules.
			if (principal.role !== 'owner' && principal.role !== 'admin')
				throw new CoreError('forbidden', 'Only org owners and admins can change isolation minimums.', 403);
			patch.minIsolationJson = JSON.stringify(parsed.minIsolation);
		}
		this.ctx.db.update(pipelineRepositories).set(patch).where(eq(pipelineRepositories.id, row.id)).run();
		this.audit(principal, 'pipeline.repository.update', row.id, {
			name: row.name,
			fields: Object.keys(parsed).filter((key) => (key !== 'webhookSecret' && key !== 'statusToken') || parsed[key] !== undefined),
		});
		return this.repositoryView({ ...row, ...patch });
	}

	/** Deletes the repository and everything it owns: runs, logs, artifacts, caches, secrets. */
	async deleteRepository(principal: Principal, name: string): Promise<void> {
		requirePermission(principal, 'build:create');
		const row = this.requireRepository(principal, name);
		const objectKeys = [
			...this.ctx.db.select({ key: pipelineArtifacts.objectKey }).from(pipelineArtifacts).where(eq(pipelineArtifacts.repositoryId, row.id)).all(),
			...this.ctx.db.select({ key: pipelineCaches.objectKey }).from(pipelineCaches).where(eq(pipelineCaches.repositoryId, row.id)).all(),
		].map((entry) => entry.key);
		this.ctx.db.transaction(() => {
			const runIds = this.ctx.db
				.select({ id: pipelineRuns.id })
				.from(pipelineRuns)
				.where(eq(pipelineRuns.repositoryId, row.id))
				.all()
				.map((run) => run.id);
			const jobIds = runIds.length
				? this.ctx.db
						.select({ id: pipelineJobs.id })
						.from(pipelineJobs)
						.where(inArray(pipelineJobs.runId, runIds))
						.all()
						.map((job) => job.id)
				: [];
			for (let i = 0; i < jobIds.length; i += 500) {
				const chunk = jobIds.slice(i, i + 500);
				this.ctx.db.delete(pipelineSteps).where(inArray(pipelineSteps.jobId, chunk)).run();
				this.ctx.db.delete(pipelineLogLines).where(inArray(pipelineLogLines.jobId, chunk)).run();
				this.ctx.db.delete(pipelineDeploys).where(inArray(pipelineDeploys.jobId, chunk)).run();
			}
			this.ctx.db.delete(pipelineJobs).where(eq(pipelineJobs.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineRuns).where(eq(pipelineRuns.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineTriggers).where(eq(pipelineTriggers.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineArtifacts).where(eq(pipelineArtifacts.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineCaches).where(eq(pipelineCaches.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineSecrets).where(eq(pipelineSecrets.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineVariables).where(eq(pipelineVariables.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineEnvironments).where(eq(pipelineEnvironments.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineProjectLinks).where(eq(pipelineProjectLinks.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineRepositories).where(eq(pipelineRepositories.id, row.id)).run();
		});
		for (const key of objectKeys) await this.ctx.objectStore.delete(key).catch(() => undefined);
		this.audit(principal, 'pipeline.repository.delete', row.id, { name: row.name });
	}

	private repositoryView(row: PipelineRepositoryRow): PipelineRepositoryView {
		const last = this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(eq(pipelineRuns.repositoryId, row.id))
			.orderBy(desc(pipelineRuns.createdAt))
			.limit(1)
			.get();
		return {
			id: row.id,
			name: row.name,
			cloneUrl: row.cloneUrl,
			provider: row.provider,
			defaultBranch: row.defaultBranch,
			defaultImage: row.defaultImage,
			enabled: row.enabled,
			hasWebhookSecret: Boolean(row.webhookSecret),
			hasStatusToken: Boolean(row.statusToken),
			minIsolation: {
				trusted: parse<Record<string, PipelineIsolationTier | null>>(row.minIsolationJson, {}).trusted ?? null,
				untrusted: parse<Record<string, PipelineIsolationTier | null>>(row.minIsolationJson, {}).untrusted ?? null,
			},
			webhookPath: `/api/webhooks/pipelines/${row.id}`,
			lastRun: last ? this.runSummary(row, last) : null,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	requireRepository(principal: Principal, name: string): PipelineRepositoryRow {
		const row = this.ctx.db
			.select()
			.from(pipelineRepositories)
			.where(and(eq(pipelineRepositories.orgId, principal.orgId), eq(pipelineRepositories.name, name)))
			.get();
		if (!row) throw new NotFoundError('Repository');
		return row;
	}

	// --- triggers ------------------------------------------------------------------------

	/** `workflow_dispatch` from the dashboard, REST, CLI or MCP. Inputs are checked once resolved. */
	dispatch(principal: Principal, name: string, input: PipelineDispatch): PipelineTriggerView {
		requirePermission(principal, 'build:create');
		const repository = this.requireRepository(principal, name);
		if (!repository.enabled) throw new ConflictError(`Repository "${name}" is disabled.`);
		const parsed = pipelineDispatchSchema.parse(input);
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		// An inline workflow is code nobody committed. Run as anyone with `build:create`, it could
		// print the repository's secrets, so it runs untrusted (no secrets, environments or deploys)
		// unless an org owner or admin dispatches it from a human session. Never trusted over MCP.
		const inlineTrusted =
			!parsed.workflowText || (principal.kind !== 'mcp' && (principal.role === 'owner' || principal.role === 'admin'));
		const trigger = this.engine.createTrigger({
			repository,
			event: 'workflow_dispatch',
			ref: parsed.ref ?? repository.defaultBranch,
			actor: principal.userId,
			trust: inlineTrusted ? 'trusted' : 'untrusted',
			createdBy: principal.userId,
			payload: {
				inputs: parsed.inputs,
				workflowPath: parsed.workflow ?? null,
				workflowText: parsed.workflowText ?? null,
				event: { inputs: parsed.inputs },
			},
		});
		this.audit(principal, 'pipeline.dispatch', trigger.id, {
			repository: name,
			ref: trigger.ref,
			workflow: parsed.workflow ?? '(inline)',
		});
		return this.triggerView(trigger);
	}

	listTriggers(principal: Principal, name: string, limit = 20): PipelineTriggerView[] {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		return this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(eq(pipelineTriggers.repositoryId, repository.id))
			.orderBy(desc(pipelineTriggers.createdAt))
			.limit(Math.min(Math.max(limit, 1), 100))
			.all()
			.map((row) => this.triggerView(row));
	}

	getTrigger(principal: Principal, name: string, triggerId: string): PipelineTriggerView {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const row = this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(and(eq(pipelineTriggers.id, triggerId), eq(pipelineTriggers.repositoryId, repository.id)))
			.get();
		if (!row) throw new NotFoundError('Trigger');
		return this.triggerView(row);
	}

	private triggerView(row: PipelineTriggerRow): PipelineTriggerView {
		return {
			id: row.id,
			event: row.event,
			ref: row.ref,
			status: row.status === 'queued' ? 'resolving' : row.status,
			error: row.error,
			runIds: parse<string[]>(row.runIdsJson, []),
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/**
	 * GitHub delivery for a repository. `push` and `pull_request` start runs; `ping` is accepted.
	 * The repository's webhook secret is mandatory, as for git builds (D45).
	 */
	handleGithubWebhook(repositoryId: string, rawBody: string, signature: string | null, event: string | null): PipelineWebhookResult {
		const repository = this.ctx.db.select().from(pipelineRepositories).where(eq(pipelineRepositories.id, repositoryId)).get();
		if (!repository) throw new NotFoundError('Repository');
		this.verifySignature(repository, rawBody, signature);
		if (!repository.enabled) return { accepted: false, reason: 'repository disabled' };
		if (event === 'ping') return { accepted: true, reason: 'pong' };
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			throw new ValidationError('GitHub payload is not valid JSON.');
		}
		if (event === 'push') return this.onPush(repository, payload as GithubPushPayload);
		if (event === 'pull_request') return this.onPullRequest(repository, payload as GithubPullRequestPayload);
		return { accepted: false, reason: `event ${event ?? '(none)'} is not handled` };
	}

	private onPush(repository: PipelineRepositoryRow, payload: GithubPushPayload): PipelineWebhookResult {
		if (!payload.ref || !payload.after || payload.deleted || /^0+$/.test(payload.after))
			return { accepted: false, reason: 'branch or tag deleted' };
		// GitHub lists at most 20 commits per push; beyond that the file list is incomplete, so
		// path filters must treat it as unknown rather than wrongly skip a workflow.
		const commits = payload.commits ?? [];
		const changedFiles =
			commits.length > 0 && commits.length < 20
				? [...new Set(commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]))]
				: null;
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		const trigger = this.engine.createTrigger({
			repository,
			event: 'push',
			ref: payload.ref,
			sha: payload.after,
			actor: payload.pusher?.name ?? payload.sender?.login ?? null,
			trust: 'trusted',
			createdBy: repository.createdBy,
			payload: {
				changedFiles,
				title: payload.head_commit?.message ?? null,
				event: { ref: payload.ref, after: payload.after, repository: payload.repository?.full_name ?? null },
			},
		});
		return { accepted: true, triggerId: trigger.id };
	}

	private onPullRequest(repository: PipelineRepositoryRow, payload: GithubPullRequestPayload): PipelineWebhookResult {
		const pr = payload.pull_request;
		const action = payload.action ?? '';
		if (!pr?.head?.sha || !payload.number) return { accepted: false, reason: 'not a pull request' };
		if (!['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review', 'labeled'].includes(action))
			return { accepted: false, reason: `action ${action} is not handled` };
		// W10: a PR from a fork runs untrusted: no secrets, no deploys, its own cache scope.
		const headRepo = pr.head.repo?.full_name ?? null;
		const baseRepo = pr.base?.repo?.full_name ?? null;
		const trust = headRepo && baseRepo && headRepo === baseRepo ? 'trusted' : 'untrusted';
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		const trigger = this.engine.createTrigger({
			repository,
			event: 'pull_request',
			ref: `refs/pull/${payload.number}/head`,
			sha: pr.head.sha,
			actor: payload.sender?.login ?? null,
			trust,
			createdBy: repository.createdBy,
			payload: {
				action,
				baseRef: pr.base?.ref ?? repository.defaultBranch,
				prNumber: payload.number,
				title: pr.title ?? null,
				event: { action, number: payload.number, pull_request: { title: pr.title ?? null, head: { ref: pr.head.ref ?? null, sha: pr.head.sha }, base: { ref: pr.base?.ref ?? null } } },
			},
		});
		return { accepted: true, triggerId: trigger.id };
	}

	private sealWebhookSecret(secret: string): string {
		const encrypted = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(secret));
		return `${encrypted.nonce}:${encrypted.ciphertext}`;
	}

	private verifySignature(repository: PipelineRepositoryRow, rawBody: string, signature: string | null): void {
		// An unsigned public webhook would let anyone start runs on your build nodes.
		if (!repository.webhookSecret)
			throw new CoreError('unauthorized', 'This repository has no webhook secret. Set one before using webhooks.', 401);
		if (!signature) throw new CoreError('unauthorized', 'Missing X-Hub-Signature-256.', 401);
		const [nonce, ciphertext] = repository.webhookSecret.split(':');
		if (!nonce || !ciphertext) throw new CoreError('error', 'Stored webhook secret is corrupt.', 500);
		const secret = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, ciphertext, nonce));
		const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
		const given = signature.trim();
		if (expected.length !== given.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(given)))
			throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
	}

	/**
	 * `schedule:` triggers (maintenance tick). Crons come from the default branch's workflows as
	 * last resolved; each fires at most once per minute per workflow.
	 */
	tickSchedules(now = this.ctx.now()): number {
		const minute = Math.floor(now / 60_000) * 60_000;
		if (minute <= this.lastScheduleMinute) return 0;
		this.lastScheduleMinute = minute;
		let fired = 0;
		for (const repository of this.ctx.db.select().from(pipelineRepositories).where(eq(pipelineRepositories.enabled, true)).all()) {
			const schedules = parse<PipelineSubscription[]>(repository.schedulesJson, []).filter(
				(entry): entry is { path: string; cron: string } => 'cron' in entry,
			);
			for (const schedule of schedules) {
				let due = false;
				try {
					due = cronMatches(new Date(minute), schedule.cron);
				} catch {
					continue;
				}
				if (!due) continue;
				const already = this.ctx.db
					.select({ payload: pipelineTriggers.payloadJson })
					.from(pipelineTriggers)
					.where(
						and(
							eq(pipelineTriggers.repositoryId, repository.id),
							eq(pipelineTriggers.event, 'schedule'),
							gt(pipelineTriggers.createdAt, minute - 1),
						),
					)
					.all()
					.some((row) => {
						const payload = parse<{ schedule?: string; workflowPath?: string }>(row.payload, {});
						return payload.schedule === schedule.cron && payload.workflowPath === schedule.path;
					});
				if (already) continue;
				this.engine.createTrigger({
					repository,
					event: 'schedule',
					ref: repository.defaultBranch,
					actor: 'schedule',
					createdBy: repository.createdBy,
					payload: { schedule: schedule.cron, workflowPath: schedule.path, event: { schedule: schedule.cron } },
				});
				fired++;
			}
		}
		return fired;
	}

	/**
	 * A platform event (`deployments.failed`, `alerts.firing`, …) for an org: start every default
	 * branch workflow subscribed to it with `on: skiff_event`. Called by `EventService` for every
	 * event it emits; never throws (an event source must not fail because of a workflow).
	 */
	onPlatformEvent(orgId: string, type: string, data: Record<string, unknown>): number {
		let started = 0;
		try {
			for (const repository of this.ctx.db
				.select()
				.from(pipelineRepositories)
				.where(and(eq(pipelineRepositories.orgId, orgId), eq(pipelineRepositories.enabled, true)))
				.all()) {
				const subscriptions = parse<PipelineSubscription[]>(repository.schedulesJson, []).filter(
					(entry): entry is { path: string; events: string[] } =>
						'events' in entry && (entry.events.length === 0 || entry.events.includes(type)),
				);
				for (const subscription of subscriptions) {
					this.engine.createTrigger({
						repository,
						event: 'skiff_event',
						ref: repository.defaultBranch,
						actor: 'skiff',
						createdBy: repository.createdBy,
						payload: {
							eventType: type,
							workflowPath: subscription.path,
							title: `${type}`,
							event: { type, data },
						},
					});
					started++;
				}
			}
		} catch (error) {
			console.error(`[pipelines] skiff_event ${type} for ${orgId} not started:`, error);
		}
		return started;
	}

	// --- runs ----------------------------------------------------------------------------

	listRuns(
		principal: Principal,
		name: string,
		options: { status?: string; workflow?: string; ref?: string; event?: string; limit?: number; before?: number } = {},
	): PipelineRunSummary[] {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const conditions = [eq(pipelineRuns.repositoryId, repository.id)];
		if (options.status === 'queued' || options.status === 'in_progress' || options.status === 'completed')
			conditions.push(eq(pipelineRuns.status, options.status));
		if (options.workflow) conditions.push(eq(pipelineRuns.workflowPath, options.workflow));
		if (options.ref) conditions.push(eq(pipelineRuns.ref, fullRef(options.ref)));
		if (options.event) conditions.push(eq(pipelineRuns.event, options.event));
		if (options.before) conditions.push(lt(pipelineRuns.number, options.before));
		return this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(and(...conditions))
			.orderBy(desc(pipelineRuns.number))
			.limit(Math.min(Math.max(options.limit ?? 30, 1), 100))
			.all()
			.map((row) => this.runSummary(repository, row));
	}

	/** Runs across every repository of the org, newest first (dashboard overview). */
	recentRuns(principal: Principal, limit = 20): PipelineRunSummary[] {
		requirePermission(principal, 'build:read');
		const repos = new Map(
			this.ctx.db
				.select()
				.from(pipelineRepositories)
				.where(eq(pipelineRepositories.orgId, principal.orgId))
				.all()
				.map((row) => [row.id, row]),
		);
		return this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(eq(pipelineRuns.orgId, principal.orgId))
			.orderBy(desc(pipelineRuns.createdAt))
			.limit(Math.min(Math.max(limit, 1), 100))
			.all()
			.flatMap((row) => {
				const repo = repos.get(row.repositoryId);
				return repo ? [this.runSummary(repo, row)] : [];
			});
	}

	async getRun(principal: Principal, name: string, runRef: string): Promise<PipelineRunView> {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		// Workflow order first (stable sort keeps matrix rows in insertion order within a key).
		const keyOrder = Object.keys(parse<{ jobs?: Record<string, unknown> }>(run.workflowJson, {}).jobs ?? {});
		const jobs = this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(eq(pipelineJobs.runId, run.id))
			.orderBy(asc(pipelineJobs.createdAt), sql`rowid`)
			.all()
			.sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key));
		const steps = jobs.length
			? this.ctx.db
					.select()
					.from(pipelineSteps)
					.where(inArray(pipelineSteps.jobId, jobs.map((job) => job.id)))
					.orderBy(asc(pipelineSteps.idx))
					.all()
			: [];
		const nodeIds = [...new Set(jobs.map((job) => job.nodeId).filter((id): id is string => Boolean(id)))];
		const nodeNames = new Map(
			nodeIds.length
				? this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, nodeIds)).all().map((n) => [n.id, n.name])
				: [],
		);
		return {
			...this.runSummary(repository, run),
			inputs: parse<Record<string, unknown>>(run.inputsJson, {}),
			jobs: jobs.map((job) => this.jobView(job, steps.filter((step) => step.jobId === job.id), nodeNames)),
			artifacts: await this.engine.listArtifacts(run.id),
		};
	}

	private jobView(
		job: PipelineJobRow,
		steps: Array<typeof pipelineSteps.$inferSelect>,
		nodeNames: Map<string, string>,
	): PipelineJobView {
		return {
			id: job.id,
			key: job.key,
			name: job.name,
			matrix: job.matrixJson && job.matrixJson !== '{}' ? parse<Record<string, unknown>>(job.matrixJson, {}) : null,
			needs: parse<string[]>(job.needsJson, []),
			runsOn: parse<string[]>(job.runsOnJson, []),
			status: job.status,
			conclusion: job.conclusion,
			environment: job.environment,
			nodeId: job.nodeId,
			nodeName: job.nodeId ? (nodeNames.get(job.nodeId) ?? null) : null,
			runtime: job.runtime ?? null,
			attempt: job.attempt,
			error: job.error,
			outputs: parse<Record<string, string>>(job.outputsJson, {}),
			steps: steps.map(
				(step): PipelineStepView => ({
					index: step.idx,
					name: step.name,
					status: step.status,
					conclusion: step.conclusion,
					summary: step.summary ?? null,
					startedAt: iso(step.startedAt),
					finishedAt: iso(step.finishedAt),
				}),
			),
			createdAt: new Date(job.createdAt).toISOString(),
			startedAt: iso(job.startedAt),
			finishedAt: iso(job.finishedAt),
		};
	}

	runSummary(repository: PipelineRepositoryRow, row: PipelineRunRow): PipelineRunSummary & { error: string | null } {
		return {
			id: row.id,
			repository: repository.name,
			number: row.number,
			workflowName: row.workflowName,
			workflowPath: row.workflowPath,
			event: row.event as PipelineEventName,
			ref: row.ref,
			sha: row.sha,
			title: row.title,
			actor: row.actor,
			trust: row.trust,
			status: row.status,
			conclusion: row.conclusion as PipelineConclusion | null,
			attempt: row.attempt,
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			startedAt: iso(row.startedAt),
			finishedAt: iso(row.finishedAt),
		};
	}

	/** A run by id or by its per-repository number (`42` or `#42`). */
	private requireRun(repository: PipelineRepositoryRow, runRef: string): PipelineRunRow {
		const number = /^#?(\d+)$/.exec(runRef);
		const row = number
			? this.ctx.db
					.select()
					.from(pipelineRuns)
					.where(and(eq(pipelineRuns.repositoryId, repository.id), eq(pipelineRuns.number, Number(number[1]))))
					.get()
			: this.ctx.db
					.select()
					.from(pipelineRuns)
					.where(and(eq(pipelineRuns.repositoryId, repository.id), eq(pipelineRuns.id, runRef)))
					.get();
		if (!row) throw new NotFoundError('Run');
		return row;
	}

	private requireRunJob(run: PipelineRunRow, jobId: string): PipelineJobRow {
		const row = this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(and(eq(pipelineJobs.runId, run.id), eq(pipelineJobs.id, jobId)))
			.get();
		if (!row) throw new NotFoundError('Job');
		return row;
	}

	async cancelRun(principal: Principal, name: string, runRef: string): Promise<PipelineRunView> {
		requirePermission(principal, 'build:cancel');
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		if (run.status === 'completed') throw new ConflictError('The run has already completed.');
		this.engine.cancelRun(run);
		this.audit(principal, 'pipeline.cancel', run.id, { repository: name, number: run.number });
		return this.getRun(principal, name, run.id);
	}

	async rerun(principal: Principal, name: string, runRef: string, failedOnly: boolean): Promise<PipelineRunView> {
		requirePermission(principal, 'build:create');
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		this.engine.rerun(run, failedOnly, principal.userId);
		this.audit(principal, 'pipeline.rerun', run.id, { repository: name, number: run.number, failedOnly });
		return this.getRun(principal, name, run.id);
	}

	/** Environment approval (W12): org owners and admins only. */
	async approveJob(principal: Principal, name: string, runRef: string, jobId: string, approve: boolean): Promise<PipelineRunView> {
		requirePermission(principal, 'build:read');
		if (principal.role !== 'owner' && principal.role !== 'admin')
			throw new CoreError('forbidden', 'Only org owners and admins can approve environment deployments.', 403);
		if (principal.kind === 'mcp') throw new CoreError('forbidden', 'Environment approvals are a human decision.', 403);
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		const job = this.requireRunJob(run, jobId);
		this.engine.approveJob(job, principal.userId, approve);
		this.audit(principal, approve ? 'pipeline.approve' : 'pipeline.reject', job.id, {
			repository: name,
			number: run.number,
			environment: job.environment,
		});
		return this.getRun(principal, name, run.id);
	}

	jobLogs(
		principal: Principal,
		name: string,
		runRef: string,
		jobId: string,
		options: { after?: number; limit?: number; step?: number } = {},
	): { lines: PipelineLogLine[]; next: number; complete: boolean } {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		const job = this.requireRunJob(run, jobId);
		const conditions = [eq(pipelineLogLines.jobId, job.id), gt(pipelineLogLines.seq, options.after ?? 0)];
		if (options.step !== undefined) conditions.push(eq(pipelineLogLines.step, options.step));
		const lines = this.ctx.db
			.select()
			.from(pipelineLogLines)
			.where(and(...conditions))
			.orderBy(asc(pipelineLogLines.seq))
			.limit(Math.min(Math.max(options.limit ?? 1000, 1), 5000))
			.all()
			.map((line) => ({
				seq: line.seq,
				jobId: line.jobId,
				step: line.step,
				stream: line.stream,
				text: line.text,
				ts: line.ts,
			}));
		return { lines, next: lines.at(-1)?.seq ?? options.after ?? 0, complete: job.status === 'completed' };
	}

	async artifactDownload(principal: Principal, name: string, runRef: string, artifactId: string): Promise<string> {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const run = this.requireRun(repository, runRef);
		return this.engine.artifactDownloadUrl(run.id, artifactId);
	}

	// --- secrets, variables, environments, deploy targets --------------------------------

	listSecrets(principal: Principal, name: string): PipelineSecretView[] {
		requirePermission(principal, 'secret:read-metadata');
		const repository = this.requireRepository(principal, name);
		return this.ctx.db
			.select()
			.from(pipelineSecrets)
			.where(eq(pipelineSecrets.repositoryId, repository.id))
			.orderBy(asc(pipelineSecrets.environment), asc(pipelineSecrets.name))
			.all()
			.map((row) => ({ name: row.name, environment: row.environment || null, updatedAt: new Date(row.updatedAt).toISOString() }));
	}

	setSecret(principal: Principal, name: string, secretName: string, input: PipelineSecretSet): PipelineSecretView {
		requirePermission(principal, 'build:create');
		requirePermission(principal, 'secret:create');
		const repository = this.requireRepository(principal, name);
		const key = pipelineSecretNameSchema.parse(secretName);
		const parsed = pipelineSecretSetSchema.parse(input);
		const environment = parsed.environment ?? '';
		const now = this.ctx.now();
		const sealed = this.ctx.secrets.seal(repository.orgId, parsed.value);
		const existing = this.ctx.db
			.select()
			.from(pipelineSecrets)
			.where(
				and(
					eq(pipelineSecrets.repositoryId, repository.id),
					eq(pipelineSecrets.environment, environment),
					eq(pipelineSecrets.name, key),
				),
			)
			.get();
		if (existing)
			this.ctx.db.update(pipelineSecrets).set({ valueSealed: sealed, updatedAt: now }).where(eq(pipelineSecrets.id, existing.id)).run();
		else
			this.ctx.db
				.insert(pipelineSecrets)
				.values({
					id: newId('psec_'),
					orgId: repository.orgId,
					repositoryId: repository.id,
					environment,
					name: key,
					valueSealed: sealed,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		this.audit(principal, 'pipeline.secret.set', repository.id, { repository: name, name: key, environment: environment || null });
		return { name: key, environment: environment || null, updatedAt: new Date(now).toISOString() };
	}

	deleteSecret(principal: Principal, name: string, secretName: string, environment?: string | null): void {
		requirePermission(principal, 'build:create');
		requirePermission(principal, 'secret:delete');
		const repository = this.requireRepository(principal, name);
		const removed = this.ctx.sqlite.run(
			'DELETE FROM pipeline_secrets WHERE repository_id = ? AND environment = ? AND name = ?',
			[repository.id, environment ?? '', secretName],
		);
		if (removed.changes === 0) throw new NotFoundError('Secret');
		this.audit(principal, 'pipeline.secret.delete', repository.id, { repository: name, name: secretName, environment: environment ?? null });
	}

	listVariables(principal: Principal, name: string): PipelineVariableView[] {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		return this.ctx.db
			.select()
			.from(pipelineVariables)
			.where(eq(pipelineVariables.repositoryId, repository.id))
			.orderBy(asc(pipelineVariables.name))
			.all()
			.map((row) => ({ name: row.name, value: row.value, updatedAt: new Date(row.updatedAt).toISOString() }));
	}

	setVariable(principal: Principal, name: string, variable: string, value: string): PipelineVariableView {
		requirePermission(principal, 'build:create');
		const repository = this.requireRepository(principal, name);
		const key = pipelineSecretNameSchema.parse(variable);
		const parsed = pipelineVariableSetSchema.parse({ value });
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineVariables)
			.values({ repositoryId: repository.id, name: key, value: parsed.value, updatedAt: now })
			.onConflictDoUpdate({
				target: [pipelineVariables.repositoryId, pipelineVariables.name],
				set: { value: parsed.value, updatedAt: now },
			})
			.run();
		this.audit(principal, 'pipeline.variable.set', repository.id, { repository: name, name: key });
		return { name: key, value: parsed.value, updatedAt: new Date(now).toISOString() };
	}

	deleteVariable(principal: Principal, name: string, variable: string): void {
		requirePermission(principal, 'build:create');
		const repository = this.requireRepository(principal, name);
		const removed = this.ctx.sqlite.run('DELETE FROM pipeline_variables WHERE repository_id = ? AND name = ?', [repository.id, variable]);
		if (removed.changes === 0) throw new NotFoundError('Variable');
		this.audit(principal, 'pipeline.variable.delete', repository.id, { repository: name, name: variable });
	}

	listEnvironments(principal: Principal, name: string): PipelineEnvironmentView[] {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const secrets = this.ctx.db
			.select({ name: pipelineSecrets.name, environment: pipelineSecrets.environment })
			.from(pipelineSecrets)
			.where(eq(pipelineSecrets.repositoryId, repository.id))
			.all();
		return this.ctx.db
			.select()
			.from(pipelineEnvironments)
			.where(eq(pipelineEnvironments.repositoryId, repository.id))
			.orderBy(asc(pipelineEnvironments.name))
			.all()
			.map((row) => ({
				name: row.name,
				allowedRefs: parse<string[]>(row.allowedRefsJson, []),
				requireApproval: row.requireApproval,
				secretNames: secrets.filter((s) => s.environment === row.name).map((s) => s.name),
				updatedAt: new Date(row.updatedAt).toISOString(),
			}));
	}

	setEnvironment(principal: Principal, name: string, environment: string, input: PipelineEnvironmentSet): PipelineEnvironmentView {
		requirePermission(principal, 'build:create');
		// Protection rules gate secrets and deploys; loosening them is an owner/admin decision.
		if (principal.role !== 'owner' && principal.role !== 'admin')
			throw new CoreError('forbidden', 'Only org owners and admins can change environment rules.', 403);
		const repository = this.requireRepository(principal, name);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(environment)) throw new ValidationError('Invalid environment name.');
		const parsed = pipelineEnvironmentSetSchema.parse(input);
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineEnvironments)
			.values({
				id: newId('penv_'),
				repositoryId: repository.id,
				name: environment,
				allowedRefsJson: JSON.stringify(parsed.allowedRefs),
				requireApproval: parsed.requireApproval,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [pipelineEnvironments.repositoryId, pipelineEnvironments.name],
				set: { allowedRefsJson: JSON.stringify(parsed.allowedRefs), requireApproval: parsed.requireApproval, updatedAt: now },
			})
			.run();
		this.audit(principal, 'pipeline.environment.set', repository.id, { repository: name, environment, ...parsed });
		return this.listEnvironments(principal, name).find((env) => env.name === environment)!;
	}

	deleteEnvironment(principal: Principal, name: string, environment: string): void {
		requirePermission(principal, 'build:create');
		if (principal.role !== 'owner' && principal.role !== 'admin')
			throw new CoreError('forbidden', 'Only org owners and admins can change environment rules.', 403);
		const repository = this.requireRepository(principal, name);
		this.ctx.db.transaction(() => {
			this.ctx.db
				.delete(pipelineEnvironments)
				.where(and(eq(pipelineEnvironments.repositoryId, repository.id), eq(pipelineEnvironments.name, environment)))
				.run();
			this.ctx.db
				.delete(pipelineSecrets)
				.where(and(eq(pipelineSecrets.repositoryId, repository.id), eq(pipelineSecrets.environment, environment)))
				.run();
		});
		this.audit(principal, 'pipeline.environment.delete', repository.id, { repository: name, environment });
	}

	listProjectLinks(principal: Principal, name: string): PipelineProjectLinkView[] {
		requirePermission(principal, 'build:read');
		const repository = this.requireRepository(principal, name);
		const links = this.ctx.db.select().from(pipelineProjectLinks).where(eq(pipelineProjectLinks.repositoryId, repository.id)).all();
		if (!links.length) return [];
		const rows = new Map(
			this.ctx.db
				.select()
				.from(projects)
				.where(inArray(projects.id, links.map((link) => link.projectId)))
				.all()
				.map((row) => [row.id, row]),
		);
		return links.flatMap((link) => {
			const project = rows.get(link.projectId);
			if (!project || project.deletedAt) return [];
			return [
				{
					projectSlug: project.slug,
					projectName: project.name,
					runtime: project.runtime,
					environment: link.environment,
					createdAt: new Date(link.createdAt).toISOString(),
				},
			];
		});
	}

	/** Allow this repository's trusted jobs to deploy to a project (§4.4). */
	linkProject(principal: Principal, name: string, slug: string, input: PipelineProjectLink): PipelineProjectLinkView {
		requirePermission(principal, 'build:create');
		requirePermission(principal, 'deployment:promote');
		const repository = this.requireRepository(principal, name);
		const project = this.ctx.projects.requireRow(principal, slug);
		const parsed = pipelineProjectLinkSchema.parse(input);
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineProjectLinks)
			.values({ repositoryId: repository.id, projectId: project.id, environment: parsed.environment, createdBy: principal.userId, createdAt: now })
			.onConflictDoUpdate({
				target: [pipelineProjectLinks.repositoryId, pipelineProjectLinks.projectId],
				set: { environment: parsed.environment },
			})
			.run();
		this.audit(principal, 'pipeline.project.link', repository.id, { repository: name, project: slug, environment: parsed.environment });
		return {
			projectSlug: project.slug,
			projectName: project.name,
			runtime: project.runtime,
			environment: parsed.environment,
			createdAt: new Date(now).toISOString(),
		};
	}

	unlinkProject(principal: Principal, name: string, slug: string): void {
		requirePermission(principal, 'build:create');
		const repository = this.requireRepository(principal, name);
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.db
			.delete(pipelineProjectLinks)
			.where(and(eq(pipelineProjectLinks.repositoryId, repository.id), eq(pipelineProjectLinks.projectId, project.id)))
			.run();
		this.audit(principal, 'pipeline.project.unlink', repository.id, { repository: name, project: slug });
	}

	// --- helpers --------------------------------------------------------------------------

	private audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'build', resourceId, args, result: 'ok' });
	}
}
