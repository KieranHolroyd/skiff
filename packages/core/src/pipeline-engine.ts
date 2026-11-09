import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
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
} from '@yoal/db';
import {
	PIPELINE_DEFAULT_IMAGE,
	PIPELINE_WORKFLOW_DIR,
	PipelineWorkflowError,
	coerceDispatchInputs,
	containsStatusFunction,
	pipelineIsolationTiers,
	resolvePipelineAction,
	evaluateCondition,
	expandMatrix,
	globMatch,
	interpolate,
	interpolateValue,
	matrixJobName,
	parseWorkflow,
	workflowTriggerMatches,
	type PipelineArtifactCreate,
	type PipelineArtifactUpload,
	type PipelineArtifactView,
	type PipelineCacheHit,
	type PipelineCacheLookup,
	type PipelineCacheReservation,
	type PipelineCacheReserve,
	type PipelineClaim,
	type PipelineClaimRequest,
	type PipelineClaimRequestInput,
	pipelineClaimRequestSchema,
	type PipelineConclusion,
	type PipelineDeployRequest,
	type PipelineDeployResult,
	type PipelineDeployStart,
	type PipelineEventName,
	type PipelineExpressionContext,
	type PipelineIsolationTier,
	type PipelineContainerRuntime,
	type PipelineHeartbeatResponse,
	type PipelineJobClaim,
	type PipelineJobComplete,
	type PipelineJobSpec,
	type PipelineLogBatch,
	type PipelineNeedsContext,
	type PipelineResolveReport,
	type PipelineStepReport,
	type PipelineTrust,
	type PipelineWorkflow,
	type Permission,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { entriesFromZip } from './artifact.ts';
import { newId } from './util.ts';
import { PipelineOidc } from './pipeline-oidc.ts';
import { commitState, githubTarget, postCommitStatus } from './pipeline-status.ts';
import { forgeClient } from './forges/clients.ts';
import { forgeFullName, parseRepoUrl, type ForgeKind } from '@yoal/contracts';

/** The secret name App-covered repositories get a repository-scoped installation token under. */
export const GITHUB_TOKEN_SECRET = 'GITHUB_TOKEN';
import { inlineWorkflowCalls, type InlinedJobSpec, type PipelineCallInfo, type WorkflowWithCalls } from './pipeline-calls.ts';

export type PipelineRepositoryRow = typeof pipelineRepositories.$inferSelect;
export type PipelineTriggerRow = typeof pipelineTriggers.$inferSelect;
export type PipelineRunRow = typeof pipelineRuns.$inferSelect;
export type PipelineJobRow = typeof pipelineJobs.$inferSelect;

/** A claimed job or resolve holds this lease; the runner renews it every 15 s (W4). */
export const PIPELINE_LEASE_MS = 60_000;
/** A job token stays valid this long after the job completes, for the final log flush. */
const TOKEN_GRACE_MS = 5 * 60_000;
const MAX_LOG_LINES_PER_JOB = 50_000;
const ARTIFACT_DEFAULT_DAYS = 30;
const CACHE_UNUSED_DAYS = 7;
const CACHE_BYTES_PER_REPOSITORY = 10 * 1024 ** 3;
const DAY = 86_400_000;
/** Per-job resource limits until per-repository settings exist (W5). */
const JOB_MEMORY_MB = 4096;
const JOB_CPUS = 2;

/**
 * Runner labels GitHub workflows use for hosted runners. A Yoal node is Linux, so these are
 * treated as `linux` rather than leaving the job queued forever (Gitea does the same mapping).
 */
const HOSTED_LABEL_ALIASES: Array<[RegExp, string]> = [
	[/^ubuntu(-[\w.]+)?$/i, 'linux'],
	[/^debian(-[\w.]+)?$/i, 'linux'],
];

/** sha256 of a job/resolve token; tokens are stored only as this. */
export function pipelineTokenHash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function mintToken(prefix: string): { token: string; hash: string } {
	const token = `${prefix}${randomBytes(32).toString('base64url')}`;
	return { token, hash: pipelineTokenHash(token) };
}

function parse<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/**
 * `refs/heads/main` → `main`; `refs/tags/v1` → `v1`; `refs/pull/7/head` → `7/head`; GitLab's
 * `refs/merge-requests/7/head` → `7/head` (D174).
 */
export function refName(ref: string): string {
	return ref.replace(/^refs\/(heads|tags|pull|merge-requests)\//, '');
}

function refType(ref: string): 'branch' | 'tag' | 'pull' {
	if (ref.startsWith('refs/tags/')) return 'tag';
	if (ref.startsWith('refs/pull/') || ref.startsWith('refs/merge-requests/')) return 'pull';
	return 'branch';
}

/** Expand a short ref (`main`, `v1.2`) to a full one; a 40-hex sha is kept as is. */
export function fullRef(ref: string): string {
	if (ref.startsWith('refs/') || /^[a-f0-9]{40}$/i.test(ref)) return ref;
	return `refs/heads/${ref}`;
}

export function normalizeLabel(label: string): string {
	const trimmed = label.trim().toLowerCase();
	for (const [pattern, alias] of HOSTED_LABEL_ALIASES) if (pattern.test(trimmed)) return alias;
	return trimmed;
}

/** Labels a job asks for are a subset of the node's (`self-hosted` is always satisfied). */
export function labelsSatisfied(required: readonly string[], offered: readonly string[]): boolean {
	const have = new Set(offered.map(normalizeLabel));
	have.add('self-hosted');
	return required.every((label) => have.has(normalizeLabel(label)));
}

/** OCI runtime for each container tier (W14). */
const TIER_RUNTIME: Record<PipelineIsolationTier, PipelineContainerRuntime | null> = {
	sandbox: null,
	container: 'runc',
	gvisor: 'runsc',
	microvm: 'kata',
};

const tierRank = (tier: PipelineIsolationTier) => pipelineIsolationTiers.indexOf(tier);

/** Tiers a node can give: `sandbox` only, or the container tiers its runtimes support. */
export function offeredTiers(request: PipelineClaimRequest): PipelineIsolationTier[] {
	if (request.isolation !== 'container') return ['sandbox'];
	const runtimes = new Set(request.runtimes.length ? request.runtimes : ['runc']);
	runtimes.add('runc');
	return (['container', 'gvisor', 'microvm'] as const).filter((tier) => runtimes.has(TIER_RUNTIME[tier]!));
}

/**
 * The weakest tier a job may run under: the repository's minimum for the run's trust level, and
 * at least `container` when the job needs Podman (`container:` or `services:`).
 */
export function requiredTier(
	spec: PipelineJobSpec,
	repository: { minIsolationJson: string },
	trust: PipelineTrust,
): PipelineIsolationTier {
	const minimums = parse<Partial<Record<PipelineTrust, PipelineIsolationTier | null>>>(repository.minIsolationJson, {});
	let tier: PipelineIsolationTier = minimums[trust] ?? 'sandbox';
	if ((spec.container || Object.keys(spec.services).length) && tierRank(tier) < tierRank('container')) tier = 'container';
	return tier;
}

/** The weakest offered tier that is at least `required`; null when the node cannot run the job. */
export function chooseTier(required: PipelineIsolationTier, offered: readonly PipelineIsolationTier[]): PipelineIsolationTier | null {
	return [...offered].sort((a, b) => tierRank(a) - tierRank(b)).find((tier) => tierRank(tier) >= tierRank(required)) ?? null;
}

interface TriggerPayload {
	inputs?: Record<string, string | number | boolean>;
	workflowPath?: string | null;
	workflowText?: string | null;
	baseRef?: string | null;
	action?: string | null;
	prNumber?: number | null;
	changedFiles?: string[] | null;
	title?: string | null;
	schedule?: string | null;
	/** For yoal_event triggers: the event type that fired. */
	eventType?: string | null;
	/** Small event object exposed as `yoal.event`. */
	event?: Record<string, unknown>;
}

/** What a repository's default branch subscribes to: a cron, or Yoal event types (`[]` = any). */
export type PipelineSubscription = { path: string; cron: string } | { path: string; events: string[] };

interface RunStatusUpdate {
	status: PipelineRunRow['status'];
	conclusion: PipelineConclusion | null;
}

/**
 * The pipeline engine (docs/PIPELINES.md §4.1): turns triggers into runs, schedules the job DAG,
 * hands jobs to build nodes with a lease, and serves the job-token API. The user-facing surface
 * (repositories, secrets, views, webhooks) is `PipelineService`.
 */
export class PipelineEngine {
	/** Overridable in tests: the fetch used for GitHub commit statuses. */
	statusFetch: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init);
	/** Overridable in tests: the GitHub API base. */
	statusApiBase = 'https://api.github.com';
	/** OIDC ID tokens for jobs (W9). */
	readonly oidc: PipelineOidc;

	constructor(private readonly ctx: CoreContext) {
		this.oidc = new PipelineOidc(ctx);
	}

	/**
	 * `POST /api/pipeline/oidc-token`: an OIDC ID token for cloud federation (W9). Untrusted runs
	 * (fork pull requests, inline workflows) get none, as on GitHub.
	 */
	mintOidcToken(job: PipelineJobRow, audience: string | undefined): { token: string; expiresAt: number } {
		const run = this.requireRun(job.runId);
		if (run.trust === 'untrusted') throw new CoreError('forbidden', 'Untrusted runs cannot request an OIDC token.', 403);
		const repository = this.requireRepository(run.repositoryId);
		let org = job.orgId;
		try {
			org =
				this.ctx.sqlite.query<{ slug: string }, [string]>('SELECT slug FROM organization WHERE id = ? LIMIT 1').get(job.orgId)?.slug ??
				job.orgId;
		} catch {
			// Better Auth's table is absent in some test databases; the id is a stable fallback.
		}
		return this.oidc.mint(
			{
				org,
				repository: repository.name,
				repositoryId: repository.id,
				ref: run.ref,
				sha: run.sha,
				workflow: run.workflowName,
				workflowPath: run.workflowPath,
				job: job.key,
				runId: run.id,
				runNumber: run.number,
				runAttempt: run.attempt,
				event: run.event,
				actor: run.actor,
				environment: job.environment,
				trust: run.trust,
			},
			audience,
		);
	}

	/**
	 * Best-effort commit status for a run (WP3, D176): `yoal/<workflow>` on the run's commit,
	 * linking to the run page. Uses the repository's status token, else the org's GitHub App or the
	 * forge connection serving the repository; never throws.
	 */
	reportStatus(run: PipelineRunRow): void {
		try {
			const repository = this.requireRepository(run.repositoryId);
			if (repository.provider === 'generic' || !/^[a-f0-9]{40}$/i.test(run.sha)) return;
			const state = commitState(run.status, run.conclusion);
			const description =
				run.status === 'queued'
					? 'Queued'
					: run.status === 'in_progress'
						? 'Running'
						: `${run.conclusion ?? 'completed'}${run.error ? `: ${run.error.split('\n')[0]}` : ''}`;
			const context = `yoal/${run.workflowName}`;
			const targetUrl = `${this.ctx.config.platformOrigin}/pipelines/${encodeURIComponent(repository.name)}/runs/${run.number}`;
			const warn = (error: unknown) =>
				console.warn(`[pipelines] commit status for ${repository.name}#${run.number} failed: ${(error as Error).message}`);
			if (repository.statusToken) {
				const token = this.ctx.secrets.open(repository.orgId, repository.statusToken);
				if (repository.provider === 'github') {
					const target = githubTarget(repository.cloneUrl);
					if (!target) return;
					void postCommitStatus({ token, target, sha: run.sha, state, context, description, targetUrl, apiBase: this.statusApiBase, fetch: this.statusFetch }).catch(
						warn,
					);
					return;
				}
				// A GitLab, Gitea or Forgejo status token: the API base is the connection's, else the URL's origin.
				const target = forgeStatusTarget(this.ctx, repository);
				if (!target) return;
				void forgeClient({ kind: target.kind, baseUrl: target.baseUrl, token, fetch: this.ctx.config.forgeFetch })
					.commitStatus(target.fullName, { sha: run.sha, state: run.status === 'in_progress' ? 'running' : state, context, description, targetUrl })
					.catch(warn);
				return;
			}
			// No stored token: Yoal's GitHub App or the forge connection reports (D164, D176).
			void this.ctx.git
				.commitStatus(repository.orgId, repository.cloneUrl, {
					sha: run.sha,
					state: run.status === 'in_progress' ? 'running' : state,
					context,
					description,
					targetUrl,
				})
				.catch(warn);
		} catch (error) {
			console.warn('[pipelines] commit status skipped:', (error as Error).message);
		}
	}

	// --- triggers ------------------------------------------------------------------------

	createTrigger(input: {
		repository: PipelineRepositoryRow;
		event: PipelineEventName;
		ref: string;
		sha?: string | null;
		actor?: string | null;
		trust?: PipelineTrust;
		payload?: TriggerPayload;
		createdBy?: string | null;
	}): PipelineTriggerRow {
		const row: PipelineTriggerRow = {
			id: newId('ptr_'),
			orgId: input.repository.orgId,
			repositoryId: input.repository.id,
			event: input.event,
			ref: fullRef(input.ref),
			sha: input.sha ?? null,
			actor: input.actor ?? null,
			trust: input.trust ?? 'trusted',
			payloadJson: JSON.stringify(input.payload ?? {}),
			status: 'queued',
			nodeId: null,
			tokenHash: null,
			leaseExpiresAt: null,
			error: null,
			runIdsJson: '[]',
			createdBy: input.createdBy ?? null,
			createdAt: this.ctx.now(),
			finishedAt: null,
		};
		this.ctx.db.insert(pipelineTriggers).values(row).run();
		return row;
	}

	/**
	 * A node read the workflow files at the trigger's ref. Parse each, keep the ones whose `on:`
	 * matches the event, and create one run per workflow. An invalid workflow becomes a failed run
	 * with the parse issues, the way GitHub reports it, rather than vanishing.
	 */
	resolveTrigger(trigger: PipelineTriggerRow, report: PipelineResolveReport): string[] {
		if (trigger.status !== 'resolving') throw new ConflictError(`Trigger is already ${trigger.status}.`);
		const repository = this.requireRepository(trigger.repositoryId);
		const now = this.ctx.now();
		const finish = (status: 'resolved' | 'failed', error: string | null, runIds: string[]) =>
			this.ctx.db
				.update(pipelineTriggers)
				.set({
					status,
					error,
					runIdsJson: JSON.stringify(runIds),
					sha: report.sha ?? trigger.sha,
					tokenHash: null,
					leaseExpiresAt: null,
					finishedAt: now,
				})
				.where(eq(pipelineTriggers.id, trigger.id))
				.run();
		if (report.error) {
			finish('failed', report.error.slice(0, 4000), []);
			return [];
		}
		const sha = report.sha ?? trigger.sha;
		if (!sha) {
			finish('failed', 'The runner did not report a commit.', []);
			return [];
		}
		const payload = parse<TriggerPayload>(trigger.payloadJson, {});
		const files: Array<{ path: string; content: string }> = payload.workflowText
			? [{ path: payload.workflowPath ?? `${PIPELINE_WORKFLOW_DIR}/inline.yml`, content: payload.workflowText }]
			: report.files.filter((file) => file.path.startsWith(`${PIPELINE_WORKFLOW_DIR}/`));
		const event = {
			event: trigger.event,
			ref: trigger.ref,
			baseRef: payload.baseRef ?? null,
			action: payload.action ?? null,
			changedFiles: payload.changedFiles ?? report.changedFiles ?? null,
			workflowPath: payload.workflowPath ?? null,
			schedule: payload.schedule ?? null,
			eventType: payload.eventType ?? null,
		};
		// Parse every file first: a workflow may call another one (`uses: ./.yoal/workflows/x.yml`).
		const parsed = new Map<string, PipelineWorkflow>();
		const parseErrors = new Map<string, unknown>();
		for (const file of [...files, ...(payload.workflowText ? report.files.filter((f) => f.path.startsWith(`${PIPELINE_WORKFLOW_DIR}/`)) : [])]) {
			if (parsed.has(file.path) || parseErrors.has(file.path)) continue;
			try {
				parsed.set(file.path, parseWorkflow(Bun.YAML.parse(file.content), file.path));
			} catch (error) {
				parseErrors.set(file.path, error);
			}
		}
		const title = (payload.title ?? report.commitMessage ?? '').split('\n')[0]!.slice(0, 500);
		const runIds: string[] = [];
		const schedules: PipelineSubscription[] = [];
		for (const file of files) {
			const workflow = parsed.get(file.path);
			if (workflow) {
				for (const cron of workflow.on.schedule) schedules.push({ path: file.path, cron });
				if (workflow.on.yoalEvent) schedules.push({ path: file.path, events: workflow.on.yoalEvent.types });
			} else {
				const error = parseErrors.get(file.path);
				// A dispatch names one workflow; any other event reports every broken file it may have run.
				if (trigger.event === 'workflow_dispatch' && !payload.workflowText && !this.samePath(file.path, payload.workflowPath))
					continue;
				runIds.push(this.createFailedRun(repository, trigger, file.path, sha, title, this.workflowErrorText(error)));
				continue;
			}
			if (trigger.event === 'workflow_dispatch') {
				if (!this.samePath(file.path, payload.workflowPath) && !payload.workflowText) continue;
				if (!workflow.on.workflowDispatch) {
					finish('failed', `${file.path} has no workflow_dispatch trigger.`, runIds);
					return runIds;
				}
			} else if (!workflowTriggerMatches(workflow, { ...event, workflowPath: file.path })) continue;
			try {
				runIds.push(this.createRun({ repository, trigger, workflow, sha, title, payload, files: parsed }));
			} catch (error) {
				runIds.push(this.createFailedRun(repository, trigger, file.path, sha, title, this.workflowErrorText(error)));
			}
		}
		if (trigger.event === 'workflow_dispatch' && runIds.length === 0) {
			finish('failed', `No workflow named ${payload.workflowPath ?? '(none)'} at ${trigger.ref}.`, []);
			return [];
		}
		// The default branch's `schedule:` crons and `yoal_event` subscriptions are remembered so the
		// minute tick and the event hook need no clone.
		if (trigger.event === 'push' && trigger.ref === `refs/heads/${repository.defaultBranch}` && !payload.workflowText)
			this.ctx.db
				.update(pipelineRepositories)
				.set({ schedulesJson: JSON.stringify(schedules.slice(0, 50)) })
				.where(eq(pipelineRepositories.id, repository.id))
				.run();
		finish('resolved', null, runIds);
		return runIds;
	}

	private samePath(path: string, wanted: string | null | undefined): boolean {
		if (!wanted) return false;
		const name = wanted.replace(/^\.?\/+/, '');
		return path === name || path === `${PIPELINE_WORKFLOW_DIR}/${name}` || path.split('/').pop() === name;
	}

	private workflowErrorText(error: unknown): string {
		if (error instanceof PipelineWorkflowError)
			return error.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`).join('\n').slice(0, 4000);
		return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
	}

	private nextRunNumber(repositoryId: string): number {
		const row = this.ctx.sqlite
			.query<{ next_run_number: number }, [string]>(
				'UPDATE pipeline_repositories SET next_run_number = next_run_number + 1 WHERE id = ? RETURNING next_run_number',
			)
			.get(repositoryId);
		if (!row) throw new NotFoundError('Repository');
		return row.next_run_number - 1;
	}

	private createFailedRun(
		repository: PipelineRepositoryRow,
		trigger: PipelineTriggerRow,
		path: string,
		sha: string,
		title: string,
		error: string,
	): string {
		const now = this.ctx.now();
		const id = newId('prn_');
		this.ctx.db
			.insert(pipelineRuns)
			.values({
				id,
				orgId: repository.orgId,
				repositoryId: repository.id,
				triggerId: trigger.id,
				number: this.nextRunNumber(repository.id),
				workflowPath: path,
				workflowName: path.split('/').pop() ?? path,
				workflowJson: '{}',
				event: trigger.event,
				ref: trigger.ref,
				sha,
				title: title || 'Invalid workflow',
				actor: trigger.actor,
				trust: trigger.trust,
				inputsJson: '{}',
				status: 'completed',
				conclusion: 'failure',
				error,
				createdBy: trigger.createdBy,
				createdAt: now,
				startedAt: now,
				finishedAt: now,
			})
			.run();
		this.reportStatus(this.requireRun(id));
		return id;
	}

	/** Expression context shared by every job of a run (`yoal`, `inputs`, `vars`). */
	runContext(run: PipelineRunRow, repository: PipelineRepositoryRow): PipelineExpressionContext {
		const payload = this.triggerPayload(run.triggerId);
		const vars = Object.fromEntries(
			this.ctx.db
				.select()
				.from(pipelineVariables)
				.where(eq(pipelineVariables.repositoryId, repository.id))
				.all()
				.map((row) => [row.name, row.value]),
		);
		return {
			yoal: {
				sha: run.sha,
				ref: run.ref,
				ref_name: refName(run.ref),
				ref_type: refType(run.ref),
				base_ref: payload.baseRef ?? '',
				head_ref: '',
				event_name: run.event,
				event: payload.event ?? {},
				repository: repository.name,
				repository_id: repository.id,
				repository_owner: run.orgId,
				run_id: run.id,
				run_number: run.number,
				run_attempt: run.attempt,
				actor: run.actor ?? '',
				triggering_actor: run.actor ?? '',
				workflow: run.workflowName,
				workflow_ref: `${repository.name}/${run.workflowPath}@${run.ref}`,
				workspace: '/workspace',
				server_url: this.ctx.config.platformOrigin,
				api_url: `${this.ctx.config.platformOrigin}/api/pipeline`,
				default_branch: repository.defaultBranch,
			},
			inputs: parse<Record<string, unknown>>(run.inputsJson, {}),
			vars,
		};
	}

	private triggerPayload(triggerId: string | null): TriggerPayload {
		if (!triggerId) return {};
		const row = this.ctx.db.select().from(pipelineTriggers).where(eq(pipelineTriggers.id, triggerId)).get();
		return parse<TriggerPayload>(row?.payloadJson, {});
	}

	createRun(input: {
		repository: PipelineRepositoryRow;
		trigger: PipelineTriggerRow;
		workflow: PipelineWorkflow;
		sha: string;
		title: string;
		payload: TriggerPayload;
		/** Every workflow at the commit, for reusable-workflow calls. */
		files?: Map<string, PipelineWorkflow>;
	}): string {
		const { repository, trigger } = input;
		// Throws PipelineWorkflowError for a bad call; the caller turns that into a failed run.
		const workflow: WorkflowWithCalls = inlineWorkflowCalls(input.workflow, input.files ?? new Map());
		const inputs =
			trigger.event === 'workflow_dispatch' ? coerceDispatchInputs(workflow, input.payload.inputs ?? {}) : {};
		const now = this.ctx.now();
		const id = newId('prn_');
		const row: PipelineRunRow = {
			id,
			orgId: repository.orgId,
			repositoryId: repository.id,
			triggerId: trigger.id,
			number: this.nextRunNumber(repository.id),
			workflowPath: workflow.path,
			workflowName: workflow.name,
			workflowJson: JSON.stringify(workflow),
			event: trigger.event,
			ref: trigger.ref,
			sha: input.sha,
			title: input.title,
			actor: trigger.actor,
			trust: trigger.trust,
			inputsJson: JSON.stringify(inputs),
			status: 'queued',
			conclusion: null,
			attempt: 1,
			concurrencyGroup: null,
			cancelRequested: false,
			error: null,
			createdBy: trigger.createdBy,
			createdAt: now,
			startedAt: null,
			finishedAt: null,
		};
		const context = this.runContext(row, repository);
		if (workflow.runName) row.title = interpolate(workflow.runName, context).slice(0, 500) || row.title;
		if (workflow.concurrency) row.concurrencyGroup = interpolate(workflow.concurrency.group, context).slice(0, 255);
		this.ctx.db.transaction(() => {
			this.ctx.db.insert(pipelineRuns).values(row).run();
			for (const job of Object.values(workflow.jobs)) this.insertPlaceholder(row, job, now);
		});
		if (row.concurrencyGroup && workflow.concurrency?.cancelInProgress)
			for (const other of this.ctx.db
				.select()
				.from(pipelineRuns)
				.where(
					and(
						eq(pipelineRuns.repositoryId, repository.id),
						eq(pipelineRuns.concurrencyGroup, row.concurrencyGroup),
						inArray(pipelineRuns.status, ['queued', 'in_progress']),
					),
				)
				.all())
				if (other.id !== row.id) this.cancelRun(other, 'Cancelled by a newer run in the same concurrency group.');
		this.reportStatus(row);
		this.advance(id);
		return id;
	}

	/**
	 * One `pending` row per job key. It is replaced by the real (matrix-expanded) rows once its
	 * `needs` are done, because the matrix and `if:` may read `needs.*.outputs`.
	 */
	private insertPlaceholder(run: PipelineRunRow, job: PipelineJobSpec, now: number): void {
		this.ctx.db
			.insert(pipelineJobs)
			.values({
				id: newId('pjb_'),
				runId: run.id,
				orgId: run.orgId,
				repositoryId: run.repositoryId,
				key: job.key,
				name: job.name,
				matrixJson: null,
				needsJson: JSON.stringify(job.needs),
				runsOnJson: JSON.stringify(job.runsOn),
				environment: job.environment?.name ?? null,
				status: 'pending',
				conclusion: null,
				nodeId: null,
				tokenHash: null,
				leaseExpiresAt: null,
				attempt: run.attempt,
				outputsJson: '{}',
				specJson: JSON.stringify(job),
				error: null,
				cancelRequested: false,
				approvedBy: null,
				createdAt: now,
				queuedAt: null,
				startedAt: null,
				finishedAt: null,
			})
			.run();
	}

	// --- scheduling ---------------------------------------------------------------------

	/** `needs.<key>` for a key whose rows are all complete (matrix rows fold into one result). */
	private needsContext(rows: PipelineJobRow[]): PipelineNeedsContext {
		const conclusions = rows.map((row) => row.conclusion);
		const result: PipelineNeedsContext['result'] = conclusions.some((c) => c === 'failure' || c === 'timed_out')
			? 'failure'
			: conclusions.some((c) => c === 'cancelled')
				? 'cancelled'
				: conclusions.every((c) => c === 'skipped')
					? 'skipped'
					: 'success';
		const outputs: Record<string, string> = {};
		// Matrix rows merge last-writer-wins, but like GitHub an empty value never overwrites one.
		for (const row of [...rows].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)))
			for (const [name, value] of Object.entries(parse<Record<string, string>>(row.outputsJson, {})))
				if (value !== '' || !(name in outputs)) outputs[name] = value;
		return { result, outputs };
	}

	private callsOf(run: PipelineRunRow): Record<string, PipelineCallInfo> {
		return parse<WorkflowWithCalls>(run.workflowJson, {} as WorkflowWithCalls).calls ?? {};
	}

	/** Rows that make up `key`: its own, or every job inlined for a reusable-workflow call. */
	private rowsForKey(key: string, byKey: Map<string, PipelineJobRow[]>, calls: Record<string, PipelineCallInfo>): PipelineJobRow[] | null {
		if (calls[key]) {
			const rows = calls[key]!.jobs.flatMap((inner) => byKey.get(inner) ?? []);
			return rows.length ? rows : null;
		}
		return byKey.get(key) ?? null;
	}

	/**
	 * `needs.<key>`. For a call key the result folds over the inlined jobs and the outputs come
	 * from the callee's `on.workflow_call.outputs`, evaluated over its `jobs` context.
	 */
	private keyContext(key: string, byKey: Map<string, PipelineJobRow[]>, calls: Record<string, PipelineCallInfo>): PipelineNeedsContext {
		const call = calls[key];
		if (!call) return this.needsContext(byKey.get(key) ?? []);
		const folded = this.needsContext(call.jobs.flatMap((inner) => byKey.get(inner) ?? []));
		const prefix = `${key}--`;
		const children = new Set<string>();
		for (const inner of [...call.jobs, ...Object.keys(calls)])
			if (inner.startsWith(prefix)) children.add(inner.slice(prefix.length).split('--')[0]!);
		const jobs = Object.fromEntries([...children].map((child) => [child, this.keyContext(`${prefix}${child}`, byKey, calls)]));
		const outputs: Record<string, string> = {};
		for (const [name, template] of Object.entries(call.outputs)) {
			try {
				outputs[name] = interpolate(template, { yoal: {}, jobs });
			} catch {
				outputs[name] = '';
			}
		}
		return { result: folded.result, outputs };
	}

	/**
	 * Move a run forward: expand every placeholder whose needs are done, complete the run when
	 * every job is. Idempotent and synchronous, so it runs after every state change.
	 */
	advance(runId: string): void {
		for (let guard = 0; guard < 100; guard++) {
			const run = this.ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
			if (!run || run.status === 'completed') return;
			const jobs = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, runId)).all();
			const byKey = new Map<string, PipelineJobRow[]>();
			for (const job of jobs) byKey.set(job.key, [...(byKey.get(job.key) ?? []), job]);
			let changed = false;
			const calls = this.callsOf(run);
			for (const placeholder of jobs.filter((job) => job.status === 'pending' && job.matrixJson === null)) {
				const needs = parse<string[]>(placeholder.needsJson, []);
				const needRows = needs.map((key) => this.rowsForKey(key, byKey, calls));
				if (needRows.some((rows) => !rows || rows.some((row) => row.status !== 'completed'))) continue;
				if (run.cancelRequested) {
					this.completeJob(placeholder, 'cancelled', 'The run was cancelled.');
					changed = true;
					continue;
				}
				// The workflow must not wait behind an older run of the same concurrency group.
				if (this.blockedByConcurrency(run)) break;
				this.expand(run, placeholder, Object.fromEntries(needs.map((key) => [key, this.keyContext(key, byKey, calls)])));
				changed = true;
			}
			if (!changed) break;
		}
		this.updateRunStatus(runId);
	}

	private blockedByConcurrency(run: PipelineRunRow): boolean {
		if (!run.concurrencyGroup) return false;
		const older = this.ctx.db
			.select({ id: pipelineRuns.id })
			.from(pipelineRuns)
			.where(
				and(
					eq(pipelineRuns.repositoryId, run.repositoryId),
					eq(pipelineRuns.concurrencyGroup, run.concurrencyGroup),
					eq(pipelineRuns.status, 'in_progress'),
					lt(pipelineRuns.createdAt, run.createdAt),
				),
			)
			.get();
		return Boolean(older);
	}

	private expand(run: PipelineRunRow, placeholder: PipelineJobRow, needs: Record<string, PipelineNeedsContext>): void {
		const spec = parse<InlinedJobSpec>(placeholder.specJson, null as unknown as InlinedJobSpec);
		const repository = this.requireRepository(run.repositoryId);
		const base: PipelineExpressionContext = { ...this.runContext(run, repository), needs };
		// A job inlined from a reusable workflow sees the call's `with:` as `inputs`.
		if (spec.callKey) {
			try {
				spec.callInputs = this.callInputs(run, spec, base);
				base.inputs = spec.callInputs;
			} catch (error) {
				this.completeJob(placeholder, 'failure', `with: ${(error as Error).message}`);
				return;
			}
		}
		const status = {
			failed: Object.values(needs).some((need) => need.result === 'failure' || need.result === 'cancelled'),
			cancelled: run.cancelRequested,
		};
		let runs: boolean;
		try {
			// Like GitHub, a job whose need was skipped is skipped unless its `if:` decides itself.
			const skippedNeed = Object.values(needs).some((need) => need.result === 'skipped');
			runs = skippedNeed && !(spec.if && containsStatusFunction(spec.if)) ? false : evaluateCondition(spec.if, base, { status });
		} catch (error) {
			this.completeJob(placeholder, 'failure', `if: ${(error as Error).message}`);
			return;
		}
		if (!runs) {
			this.completeJob(placeholder, 'skipped', null);
			return;
		}
		let combos: Record<string, unknown>[];
		try {
			const raw = typeof spec.strategy.matrix === 'string' ? interpolateValue(spec.strategy.matrix, base) : spec.strategy.matrix;
			if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw)))
				throw new ValidationError('strategy.matrix must evaluate to an object');
			combos = expandMatrix((raw as Record<string, unknown> | null) ?? null);
		} catch (error) {
			this.completeJob(placeholder, 'failure', `strategy.matrix: ${(error as Error).message}`);
			return;
		}
		const matrices: Array<Record<string, unknown> | null> = combos.length ? combos : [null];
		const now = this.ctx.now();
		const rows = matrices.map((matrix, index) => {
			const context: PipelineExpressionContext = {
				...base,
				matrix: matrix ?? {},
				strategy: {
					'fail-fast': spec.strategy.failFast,
					'max-parallel': spec.strategy.maxParallel ?? matrices.length,
					'job-index': index,
					'job-total': matrices.length,
				},
			};
			const name = matrix ? matrixJobName(interpolate(spec.name, context), matrix) : interpolate(spec.name, context);
			const runsOn = spec.runsOn.flatMap((label) => {
				const value = interpolateValue(label, context);
				return Array.isArray(value) ? value.map(String) : [String(value ?? '')];
			}).filter(Boolean);
			const resolved: PipelineJobSpec = { ...spec, name, runsOn };
			return { matrix, name, runsOn, resolved };
		});
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(pipelineJobs).where(eq(pipelineJobs.id, placeholder.id)).run();
			for (const row of rows) {
				const job: typeof pipelineJobs.$inferInsert = {
					id: newId('pjb_'),
					runId: run.id,
					orgId: run.orgId,
					repositoryId: run.repositoryId,
					key: spec.key,
					name: row.name.slice(0, 500),
					matrixJson: JSON.stringify(row.matrix ?? {}),
					needsJson: placeholder.needsJson,
					runsOnJson: JSON.stringify(row.runsOn),
					environment: spec.environment?.name ?? null,
					status: 'queued',
					attempt: run.attempt,
					outputsJson: '{}',
					specJson: JSON.stringify(row.resolved),
					createdAt: now,
					queuedAt: now,
				};
				const gate = this.environmentGate(run, repository, spec.environment?.name ?? null);
				if (gate.kind === 'refuse') {
					job.status = 'completed';
					job.conclusion = 'failure';
					job.error = gate.reason;
					job.finishedAt = now;
				} else if (gate.kind === 'approval') job.status = 'waiting';
				this.ctx.db.insert(pipelineJobs).values(job).run();
			}
		});
		this.applyMaxParallel(run.id, spec);
	}

	/** Evaluate a call's `with:` against the caller's context and coerce it to the callee's inputs. */
	private callInputs(run: PipelineRunRow, spec: InlinedJobSpec, context: PipelineExpressionContext): Record<string, unknown> {
		const call = this.callsOf(run)[spec.callKey!];
		const raw: Record<string, unknown> = {};
		for (const [name, template] of Object.entries(spec.callWith ?? {})) raw[name] = interpolateValue(template, context);
		if (!call) return raw;
		const declared = call.inputs;
		const out: Record<string, unknown> = {};
		for (const name of Object.keys(raw))
			if (!(name in declared)) throw new ValidationError(`${call.path} has no input named "${name}"`);
		for (const [name, input] of Object.entries(declared)) {
			let value = raw[name] ?? input.default ?? null;
			if (value === null || value === '') {
				if (input.required) throw new ValidationError(`input "${name}" of ${call.path} is required`);
				if (input.type === 'boolean') value = false;
				else if (input.type === 'number') value = 0;
				else value = '';
			}
			if (input.type === 'boolean') value = value === true || value === 'true';
			else if (input.type === 'number') {
				const number = Number(value);
				if (!Number.isFinite(number)) throw new ValidationError(`input "${name}" must be a number`);
				value = number;
			} else value = String(value);
			out[name] = value;
		}
		return out;
	}

	/**
	 * `strategy.max-parallel`: keep only that many of a key's rows queued or running; the rest stay
	 * `pending` (with a matrix, so `advance` does not treat them as placeholders) until one ends.
	 */
	private applyMaxParallel(runId: string, spec: PipelineJobSpec): void {
		const limit = spec.strategy.maxParallel;
		if (!limit) return;
		const rows = this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.key, spec.key)))
			.orderBy(asc(pipelineJobs.createdAt), sql`rowid`)
			.all();
		let active = rows.filter((row) => row.status === 'in_progress' || row.status === 'queued').length;
		// Demote from the end, so the first combinations run first.
		for (const row of [...rows].reverse()) {
			if (active > limit && row.status === 'queued') {
				this.ctx.db.update(pipelineJobs).set({ status: 'pending', queuedAt: null }).where(eq(pipelineJobs.id, row.id)).run();
				active--;
			}
		}
		for (const row of rows) {
			if (active >= limit) break;
			if (row.status === 'pending' && row.matrixJson !== null) {
				this.ctx.db
					.update(pipelineJobs)
					.set({ status: 'queued', queuedAt: this.ctx.now() })
					.where(eq(pipelineJobs.id, row.id))
					.run();
				active++;
			}
		}
	}

	/** W12: allowed refs, approvals, and no environments at all for untrusted runs. */
	private environmentGate(
		run: PipelineRunRow,
		repository: PipelineRepositoryRow,
		environment: string | null,
	): { kind: 'open' } | { kind: 'approval' } | { kind: 'refuse'; reason: string } {
		if (!environment) return { kind: 'open' };
		if (run.trust === 'untrusted')
			return { kind: 'refuse', reason: `Untrusted runs (pull requests from forks) cannot use environment "${environment}".` };
		const row = this.ctx.db
			.select()
			.from(pipelineEnvironments)
			.where(and(eq(pipelineEnvironments.repositoryId, repository.id), eq(pipelineEnvironments.name, environment)))
			.get();
		// GitHub creates an environment on first use; so does Yoal, with no rules.
		if (!row) {
			const now = this.ctx.now();
			this.ctx.db
				.insert(pipelineEnvironments)
				.values({ id: newId('penv_'), repositoryId: repository.id, name: environment, createdAt: now, updatedAt: now })
				.onConflictDoNothing()
				.run();
			return { kind: 'open' };
		}
		const allowed = parse<string[]>(row.allowedRefsJson, []);
		if (allowed.length && !allowed.some((pattern) => globMatch(pattern, run.ref) || globMatch(fullRef(pattern), run.ref)))
			return { kind: 'refuse', reason: `${run.ref} is not allowed to use environment "${environment}".` };
		return row.requireApproval ? { kind: 'approval' } : { kind: 'open' };
	}

	completeJob(job: PipelineJobRow, conclusion: PipelineConclusion, error: string | null, outputs?: Record<string, string>): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(pipelineJobs)
			.set({
				status: 'completed',
				conclusion,
				error,
				outputsJson: outputs ? JSON.stringify(outputs) : job.outputsJson,
				finishedAt: now,
				leaseExpiresAt: null,
				// The token stays valid for TOKEN_GRACE_MS (final log flush); see `authenticateJob`.
			})
			.where(eq(pipelineJobs.id, job.id))
			.run();
		this.ctx.db
			.update(pipelineSteps)
			.set({ status: 'completed', conclusion: conclusion === 'success' ? 'skipped' : 'cancelled', finishedAt: now })
			.where(and(eq(pipelineSteps.jobId, job.id), inArray(pipelineSteps.status, ['pending', 'in_progress'])))
			.run();
		if ((conclusion === 'failure' || conclusion === 'timed_out') && job.matrixJson !== null) {
			const spec = parse<PipelineJobSpec | null>(job.specJson, null);
			if (spec?.strategy.failFast !== false)
				for (const sibling of this.ctx.db
					.select()
					.from(pipelineJobs)
					.where(and(eq(pipelineJobs.runId, job.runId), eq(pipelineJobs.key, job.key)))
					.all())
					if (sibling.id !== job.id && sibling.status !== 'completed') this.cancelJob(sibling, 'Cancelled by fail-fast.');
		}
		const spec = parse<PipelineJobSpec | null>(job.specJson, null);
		if (spec) this.applyMaxParallel(job.runId, spec);
	}

	private cancelJob(job: PipelineJobRow, reason: string): void {
		if (job.status === 'in_progress')
			this.ctx.db.update(pipelineJobs).set({ cancelRequested: true }).where(eq(pipelineJobs.id, job.id)).run();
		else if (job.status !== 'completed') this.completeJob(job, 'cancelled', reason);
	}

	cancelRun(run: PipelineRunRow, reason = 'The run was cancelled.'): void {
		if (run.status === 'completed') return;
		this.ctx.db.update(pipelineRuns).set({ cancelRequested: true }).where(eq(pipelineRuns.id, run.id)).run();
		for (const job of this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, run.id)).all())
			this.cancelJob(job, reason);
		this.advance(run.id);
	}

	private updateRunStatus(runId: string): RunStatusUpdate | null {
		const run = this.ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
		if (!run || run.status === 'completed') return null;
		const jobs = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, runId)).all();
		const now = this.ctx.now();
		if (jobs.length && jobs.every((job) => job.status === 'completed')) {
			const failed = jobs.some((job) => {
				if (job.conclusion !== 'failure' && job.conclusion !== 'timed_out') return false;
				// A job with `continue-on-error: true` does not fail the run.
				const spec = parse<PipelineJobSpec | null>(job.specJson, null);
				return spec?.continueOnError !== true;
			});
			const conclusion: PipelineConclusion = run.cancelRequested
				? 'cancelled'
				: failed
					? 'failure'
					: jobs.every((job) => job.conclusion === 'skipped')
						? 'skipped'
						: jobs.some((job) => job.conclusion === 'cancelled')
							? 'cancelled'
							: 'success';
			this.ctx.db
				.update(pipelineRuns)
				.set({ status: 'completed', conclusion, finishedAt: now, startedAt: run.startedAt ?? now })
				.where(eq(pipelineRuns.id, runId))
				.run();
			this.onRunCompleted({ ...run, status: 'completed', conclusion });
			this.reportStatus({ ...run, status: 'completed', conclusion });
			return { status: 'completed', conclusion };
		}
		const started = jobs.some((job) => job.status === 'in_progress' || (job.status === 'completed' && job.startedAt));
		if (started && run.status === 'queued') {
			this.ctx.db
				.update(pipelineRuns)
				.set({ status: 'in_progress', startedAt: run.startedAt ?? now })
				.where(eq(pipelineRuns.id, runId))
				.run();
			this.reportStatus({ ...run, status: 'in_progress' });
			return { status: 'in_progress', conclusion: null };
		}
		return null;
	}

	/** Unblock the next run of a concurrency group, and tell anyone listening. */
	private onRunCompleted(run: PipelineRunRow): void {
		if (run.concurrencyGroup)
			for (const next of this.ctx.db
				.select({ id: pipelineRuns.id })
				.from(pipelineRuns)
				.where(
					and(
						eq(pipelineRuns.repositoryId, run.repositoryId),
						eq(pipelineRuns.concurrencyGroup, run.concurrencyGroup),
						eq(pipelineRuns.status, 'queued'),
					),
				)
				.orderBy(asc(pipelineRuns.createdAt))
				.all())
				this.advance(next.id);
		if (run.conclusion === 'failure') console.warn(`[pipelines] run ${run.id} (#${run.number} ${run.workflowName}) failed`);
	}

	approveJob(job: PipelineJobRow, approver: string, approve: boolean): void {
		if (job.status !== 'waiting') throw new ConflictError(`Job is ${job.status}, not waiting for approval.`);
		if (!approve) {
			this.completeJob(job, 'failure', `Deployment to "${job.environment}" was rejected.`);
		} else {
			this.ctx.db
				.update(pipelineJobs)
				.set({ status: 'queued', queuedAt: this.ctx.now(), approvedBy: approver })
				.where(eq(pipelineJobs.id, job.id))
				.run();
		}
		this.advance(job.runId);
	}

	/**
	 * Re-run a completed run as a new attempt. `failedOnly` keeps successful jobs (and their
	 * outputs) and re-plans failed/cancelled ones plus everything downstream of them.
	 */
	rerun(run: PipelineRunRow, failedOnly: boolean, actor: string): void {
		if (run.status !== 'completed') throw new ConflictError('Only a completed run can be re-run.');
		const workflow = parse<PipelineWorkflow | null>(run.workflowJson, null);
		if (!workflow?.jobs) throw new ConflictError('This run has no valid workflow to re-run.');
		const jobs = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, run.id)).all();
		const reset = new Set<string>();
		if (!failedOnly) for (const key of Object.keys(workflow.jobs)) reset.add(key);
		else {
			for (const job of jobs) if (job.conclusion !== 'success' && job.conclusion !== 'skipped') reset.add(job.key);
			// Anything that needs a reset job runs again too.
			for (let changed = true; changed; ) {
				changed = false;
				for (const spec of Object.values(workflow.jobs))
					if (!reset.has(spec.key) && spec.needs.some((need) => reset.has(need))) {
						reset.add(spec.key);
						changed = true;
					}
			}
		}
		if (reset.size === 0) throw new ConflictError('Nothing to re-run: every job succeeded.');
		const attempt = run.attempt + 1;
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			const removed = jobs.filter((job) => reset.has(job.key));
			const ids = removed.map((job) => job.id);
			if (ids.length) {
				this.ctx.db.delete(pipelineSteps).where(inArray(pipelineSteps.jobId, ids)).run();
				this.ctx.db.delete(pipelineLogLines).where(inArray(pipelineLogLines.jobId, ids)).run();
				this.ctx.db.delete(pipelineJobs).where(inArray(pipelineJobs.id, ids)).run();
			}
			this.ctx.db
				.update(pipelineRuns)
				.set({
					attempt,
					status: 'queued',
					conclusion: null,
					cancelRequested: false,
					finishedAt: null,
					actor,
				})
				.where(eq(pipelineRuns.id, run.id))
				.run();
			const updated = { ...run, attempt };
			for (const key of reset) {
				const spec = workflow.jobs[key];
				if (spec) this.insertPlaceholder(updated, spec, now);
			}
		});
		this.advance(run.id);
	}

	// --- claims (node token) ------------------------------------------------------------

	/** Leases that lapsed: resolves go back to the queue; jobs fail (they may have had effects). */
	recoverExpiredLeases(now = this.ctx.now()): number {
		let count = 0;
		for (const trigger of this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(and(eq(pipelineTriggers.status, 'resolving'), lt(pipelineTriggers.leaseExpiresAt, now)))
			.all()) {
			this.ctx.db
				.update(pipelineTriggers)
				.set({ status: 'queued', nodeId: null, tokenHash: null, leaseExpiresAt: null })
				.where(eq(pipelineTriggers.id, trigger.id))
				.run();
			count++;
		}
		for (const job of this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(and(eq(pipelineJobs.status, 'in_progress'), lt(pipelineJobs.leaseExpiresAt, now)))
			.all()) {
			this.appendSystemLine(job, 'The runner stopped responding (lease expired).');
			this.completeJob(job, 'failure', 'The runner stopped responding.');
			this.advance(job.runId);
			count++;
		}
		return count;
	}

	/** A node was removed: everything it held fails or requeues at once. */
	releaseNode(nodeId: string): void {
		this.ctx.db
			.update(pipelineTriggers)
			.set({ status: 'queued', nodeId: null, tokenHash: null, leaseExpiresAt: null })
			.where(and(eq(pipelineTriggers.status, 'resolving'), eq(pipelineTriggers.nodeId, nodeId)))
			.run();
		for (const job of this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(and(eq(pipelineJobs.status, 'in_progress'), eq(pipelineJobs.nodeId, nodeId)))
			.all()) {
			this.completeJob(job, 'failure', 'The node running this job was removed.');
			this.advance(job.runId);
		}
	}

	async claim(nodeId: string, input: PipelineClaimRequestInput): Promise<PipelineClaim | null> {
		const request = pipelineClaimRequestSchema.parse(input);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node || !node.canBuild) throw new CoreError('forbidden', 'This node is not a Builder.', 403);
		this.recoverExpiredLeases();
		if (request.capacity < 1) return null;
		const now = this.ctx.now();

		// Resolves first: they are quick and every run waits on one.
		const trigger = this.ctx.db.transaction(() => {
			const candidate = this.ctx.db
				.select()
				.from(pipelineTriggers)
				.where(eq(pipelineTriggers.status, 'queued'))
				.orderBy(asc(pipelineTriggers.createdAt))
				.get();
			if (!candidate) return null;
			const minted = mintToken('ptk_');
			const updated = this.ctx.sqlite.run(
				"UPDATE pipeline_triggers SET status = 'resolving', node_id = ?, token_hash = ?, lease_expires_at = ? WHERE id = ? AND status = 'queued'",
				[nodeId, minted.hash, now + PIPELINE_LEASE_MS, candidate.id],
			);
			return updated.changes === 1 ? { row: candidate, token: minted.token } : null;
		});
		if (trigger) {
			const repository = this.requireRepository(trigger.row.repositoryId);
			return {
				kind: 'resolve',
				triggerId: trigger.row.id,
				token: trigger.token,
				repository: { id: repository.id, name: repository.name, cloneUrl: repository.cloneUrl },
				ref: trigger.row.ref,
				sha: trigger.row.sha,
				...(await this.cloneToken(repository)),
			};
		}

		const offered = [...request.labels, node.name];
		const tiers = offeredTiers(request);
		const repositories = new Map<string, PipelineRepositoryRow>();
		const runs = new Map<string, PipelineRunRow>();
		const claimed = this.ctx.db.transaction(() => {
			const queued = this.ctx.db
				.select()
				.from(pipelineJobs)
				.where(eq(pipelineJobs.status, 'queued'))
				.orderBy(asc(pipelineJobs.queuedAt), sql`rowid`)
				.limit(200)
				.all();
			for (const job of queued) {
				if (!labelsSatisfied(parse<string[]>(job.runsOnJson, []), offered)) continue;
				const spec = parse<PipelineJobSpec | null>(job.specJson, null);
				if (!spec) continue;
				// W14: the weakest isolation this job accepts, and the node's best match for it.
				const run = runs.get(job.runId) ?? this.requireRun(job.runId);
				runs.set(run.id, run);
				const repository = repositories.get(job.repositoryId) ?? this.requireRepository(job.repositoryId);
				repositories.set(repository.id, repository);
				const tier = chooseTier(requiredTier(spec, repository, run.trust), tiers);
				if (!tier) continue;
				const runtime = TIER_RUNTIME[tier];
				const minted = mintToken('pjt_');
				const updated = this.ctx.sqlite.run(
					"UPDATE pipeline_jobs SET status = 'in_progress', node_id = ?, token_hash = ?, lease_expires_at = ?, started_at = ?, runtime = ? WHERE id = ? AND status = 'queued'",
					[nodeId, minted.hash, now + PIPELINE_LEASE_MS, now, runtime, job.id],
				);
				if (updated.changes === 1) return { job: { ...job, runtime }, spec, token: minted.token };
			}
			return null;
		});
		if (!claimed) return null;
		try {
			return await this.jobClaim(claimed.job, claimed.spec, claimed.token);
		} catch (error) {
			const fresh = this.requireJob(claimed.job.id);
			this.completeJob(fresh, 'failure', `Could not start the job: ${(error as Error).message}`);
			this.advance(fresh.runId);
			throw error;
		}
	}

	private async jobClaim(job: PipelineJobRow, spec: InlinedJobSpec, token: string): Promise<PipelineJobClaim> {
		const run = this.requireRun(job.runId);
		const repository = this.requireRepository(run.repositoryId);
		const workflow = parse<PipelineWorkflow>(run.workflowJson, null as unknown as PipelineWorkflow);
		this.ctx.db.delete(pipelineSteps).where(eq(pipelineSteps.jobId, job.id)).run();
		if (spec.steps.length)
			this.ctx.db
				.insert(pipelineSteps)
				.values(spec.steps.map((step, idx) => ({ jobId: job.id, idx, name: step.name.slice(0, 500), status: 'pending' as const })))
				.run();
		this.updateRunStatus(run.id);

		const allJobs = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, run.id)).all();
		const byKey = new Map<string, PipelineJobRow[]>();
		for (const row of allJobs) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
		const calls = this.callsOf(run);
		const needs = Object.fromEntries(spec.needs.map((key) => [key, this.keyContext(key, byKey, calls)]));
		const matrix = parse<Record<string, unknown>>(job.matrixJson, {});
		const siblings = allJobs.filter((row) => row.key === job.key);
		const context: PipelineExpressionContext = {
			...this.runContext(run, repository),
			needs,
			matrix,
			strategy: {
				'fail-fast': spec.strategy.failFast,
				'max-parallel': spec.strategy.maxParallel ?? siblings.length,
				'job-index': Math.max(0, siblings.findIndex((row) => row.id === job.id)),
				'job-total': siblings.length,
			},
			job: { status: 'success', key: job.key },
		};
		// A job inlined from a reusable workflow sees the call's inputs, not the run's.
		if (spec.callKey) context.inputs = spec.callInputs ?? {};
		(context.yoal as Record<string, unknown>).job = job.key;
		// The platform registry (docs/REGISTRY.md): where `registry/<name>` tags push to.
		const registry = this.ctx.registry.jobRegistry(job.orgId, run.trust);
		if (registry) {
			(context.yoal as Record<string, unknown>).registry = registry.host;
			(context.yoal as Record<string, unknown>).registry_namespace = registry.namespace;
		}
		// The engine-only call fields stay here; the runner gets a plain job spec.
		const { callWith: _with, callKey: _key, callSecretMap: _secrets, ...jobSpec } = spec;
		const buildkit = spec.steps.some((step) => step.uses !== null && resolvePipelineAction(step.uses) === 'yoal/build-image');
		return {
			kind: 'job',
			jobId: job.id,
			runId: run.id,
			runNumber: run.number,
			attempt: run.attempt,
			token,
			repository: { id: repository.id, name: repository.name, cloneUrl: repository.cloneUrl },
			checkout: { ref: run.ref, sha: run.sha },
			workflow: { name: run.workflowName, path: run.workflowPath },
			job: jobSpec,
			workflowEnv: workflow?.env ?? {},
			workflowDefaults: workflow?.defaults ?? { shell: null, workingDirectory: null },
			context,
			secretNames: this.secretNames(run, repository, job.environment, spec.callKey ? (spec.callSecretMap ?? {}) : 'inherit'),
			trust: run.trust,
			image: spec.container?.image ?? repository.defaultImage ?? PIPELINE_DEFAULT_IMAGE,
			limits: { memoryMb: JOB_MEMORY_MB, cpus: JOB_CPUS, timeoutMinutes: spec.timeoutMinutes },
			registry,
			runtime: (job.runtime as PipelineContainerRuntime | null) ?? null,
			buildkit,
			buildkitCacheScope: buildkit ? this.buildkitCacheScope(run) : null,
			...(await this.cloneToken(repository)),
		};
	}

	/**
	 * D164: a one-hour, read-only token for this repository alone, minted from the org's GitHub App
	 * installation (or, D175, a forge deploy/clone token), so the node can clone a private repository
	 * without credentials of its own. Null when nothing covers it (the node's own git credentials
	 * apply, D149).
	 */
	private async cloneToken(
		repository: PipelineRepositoryRow,
	): Promise<{ gitToken: string | null; gitTokenHost?: string; gitTokenUsername?: string }> {
		// D175: a connected forge sends a deploy or clone token with the host and user it is for.
		const access = await this.ctx.git.cloneAuth(repository.orgId, repository.cloneUrl);
		if (!access) return { gitToken: null };
		return { gitToken: access.token, gitTokenHost: access.host, gitTokenUsername: access.username };
	}

	/** Trusted jobs of an App-covered repository get `secrets.GITHUB_TOKEN` (unless one is set). */
	private offersGithubToken(run: PipelineRunRow, repository: PipelineRepositoryRow): boolean {
		return run.trust === 'trusted' && repository.provider === 'github' && this.ctx.githubApp.repositoryLink(repository.orgId, repository.cloneUrl).installationId !== null;
	}

	/** W6/W10: one BuildKit cache per repository for trusted runs, one per ref for untrusted. */
	buildkitCacheScope(run: PipelineRunRow): string {
		return run.trust === 'untrusted'
			? `${run.repositoryId}-untrusted-${pipelineTokenHash(run.ref).slice(0, 16)}`
			: `${run.repositoryId}-trusted`;
	}

	/**
	 * Untrusted runs get no secrets at all (W10); environment secrets override repository ones; a
	 * job inlined from a reusable workflow sees only what its call passed (`inherit` or a map).
	 */
	private secretNames(
		run: PipelineRunRow,
		repository: PipelineRepositoryRow,
		environment: string | null,
		map: 'inherit' | Record<string, string>,
	): string[] {
		if (run.trust === 'untrusted') return [];
		const rows = this.ctx.db
			.select({ name: pipelineSecrets.name, environment: pipelineSecrets.environment })
			.from(pipelineSecrets)
			.where(eq(pipelineSecrets.repositoryId, repository.id))
			.all();
		const available = new Set(rows.filter((row) => row.environment === '' || row.environment === environment).map((row) => row.name));
		if (this.offersGithubToken(run, repository)) available.add(GITHUB_TOKEN_SECRET);
		if (map === 'inherit') return [...available].sort();
		return Object.entries(map)
			.filter(([, source]) => available.has(source))
			.map(([name]) => name)
			.sort();
	}

	// --- job token API ------------------------------------------------------------------

	authenticateTrigger(token: string): PipelineTriggerRow {
		const row = this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(eq(pipelineTriggers.tokenHash, pipelineTokenHash(token)))
			.get();
		if (!row || row.status !== 'resolving') throw new CoreError('unauthorized', 'Invalid or expired token.', 401);
		return row;
	}

	/** A job token is valid while the job runs and for a short grace after it completes. */
	authenticateJob(token: string, options: { allowCompleted?: boolean } = {}): PipelineJobRow {
		if (!token.startsWith('pjt_')) throw new CoreError('unauthorized', 'Invalid or expired token.', 401);
		const row = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.tokenHash, pipelineTokenHash(token))).get();
		if (!row) throw new CoreError('unauthorized', 'Invalid or expired token.', 401);
		if (row.status === 'in_progress') return row;
		if (
			options.allowCompleted &&
			row.status === 'completed' &&
			row.finishedAt !== null &&
			this.ctx.now() - row.finishedAt < TOKEN_GRACE_MS
		)
			return row;
		throw new CoreError('unauthorized', 'This job is no longer running.', 401);
	}

	heartbeat(job: PipelineJobRow): PipelineHeartbeatResponse {
		const leaseExpiresAt = this.ctx.now() + PIPELINE_LEASE_MS;
		this.ctx.db.update(pipelineJobs).set({ leaseExpiresAt }).where(eq(pipelineJobs.id, job.id)).run();
		const run = this.requireRun(job.runId);
		return { cancelled: job.cancelRequested || run.cancelRequested, leaseExpiresAt };
	}

	heartbeatTrigger(trigger: PipelineTriggerRow): PipelineHeartbeatResponse {
		const leaseExpiresAt = this.ctx.now() + PIPELINE_LEASE_MS;
		this.ctx.db.update(pipelineTriggers).set({ leaseExpiresAt }).where(eq(pipelineTriggers.id, trigger.id)).run();
		return { cancelled: false, leaseExpiresAt };
	}

	async secrets(job: PipelineJobRow): Promise<Record<string, string>> {
		const run = this.requireRun(job.runId);
		if (run.trust === 'untrusted') return {};
		const map = parse<InlinedJobSpec | null>(job.specJson, null);
		const all = this.allSecrets(job);
		// D164: like GitHub Actions' GITHUB_TOKEN, scoped to this repository and short-lived. A
		// repository secret of the same name wins.
		const repository = this.requireRepository(job.repositoryId);
		if (all[GITHUB_TOKEN_SECRET] === undefined && this.offersGithubToken(run, repository)) {
			const access = await this.ctx.githubApp.repoToken(repository.orgId, repository.cloneUrl, {
				contents: 'read',
				statuses: 'write',
				pull_requests: 'read',
			});
			if (access) all[GITHUB_TOKEN_SECRET] = access.token;
		}
		if (!map?.callKey || map.callSecretMap === 'inherit') return all;
		return Object.fromEntries(
			Object.entries(map.callSecretMap ?? {}).flatMap(([name, source]) => (all[source] !== undefined ? [[name, all[source]!]] : [])),
		);
	}

	private allSecrets(job: PipelineJobRow): Record<string, string> {
		const rows = this.ctx.db.select().from(pipelineSecrets).where(eq(pipelineSecrets.repositoryId, job.repositoryId)).all();
		const out: Record<string, string> = {};
		// Repository-wide first, then the job's environment overrides by name.
		for (const row of rows.filter((r) => r.environment === '')) out[row.name] = this.ctx.secrets.open(job.orgId, row.valueSealed);
		if (job.environment)
			for (const row of rows.filter((r) => r.environment === job.environment))
				out[row.name] = this.ctx.secrets.open(job.orgId, row.valueSealed);
		return out;
	}

	reportStep(job: PipelineJobRow, index: number, report: PipelineStepReport): void {
		const now = this.ctx.now();
		const existing = this.ctx.db
			.select()
			.from(pipelineSteps)
			.where(and(eq(pipelineSteps.jobId, job.id), eq(pipelineSteps.idx, index)))
			.get();
		const patch = {
			status: report.status,
			conclusion: report.conclusion ?? null,
			...(report.name ? { name: report.name.slice(0, 500) } : {}),
			...(report.outputs ? { outputsJson: JSON.stringify(report.outputs) } : {}),
			...(report.summary !== undefined ? { summary: report.summary.slice(0, 1_000_000) } : {}),
			...(report.status === 'in_progress' ? { startedAt: now } : {}),
			...(report.status === 'completed' ? { finishedAt: now } : {}),
		};
		if (existing)
			this.ctx.db
				.update(pipelineSteps)
				.set(patch)
				.where(and(eq(pipelineSteps.jobId, job.id), eq(pipelineSteps.idx, index)))
				.run();
		else
			this.ctx.db
				.insert(pipelineSteps)
				.values({ jobId: job.id, idx: index, name: report.name ?? `Step ${index + 1}`, ...patch })
				.run();
	}

	appendLogs(job: PipelineJobRow, batch: PipelineLogBatch): number {
		if (!batch.lines.length) return 0;
		const count =
			this.ctx.sqlite
				.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM pipeline_log_lines WHERE job_id = ?')
				.get(job.id)?.n ?? 0;
		if (count >= MAX_LOG_LINES_PER_JOB) return 0;
		const now = this.ctx.now();
		const room = MAX_LOG_LINES_PER_JOB - count;
		const lines = batch.lines.slice(0, room).map((line) => ({
			jobId: job.id,
			runId: job.runId,
			step: line.step,
			stream: line.stream,
			text: line.text,
			ts: line.ts ?? now,
		}));
		if (batch.lines.length > room)
			lines.push({
				jobId: job.id,
				runId: job.runId,
				step: -1,
				stream: 'system',
				text: `[yoal] log limit of ${MAX_LOG_LINES_PER_JOB} lines reached; further output is dropped`,
				ts: now,
			});
		for (let i = 0; i < lines.length; i += 200)
			this.ctx.db.insert(pipelineLogLines).values(lines.slice(i, i + 200)).run();
		return lines.length;
	}

	appendSystemLine(job: PipelineJobRow, text: string): void {
		this.ctx.db
			.insert(pipelineLogLines)
			.values({ jobId: job.id, runId: job.runId, step: -1, stream: 'system', text: `[yoal] ${text}`, ts: this.ctx.now() })
			.run();
	}

	complete(job: PipelineJobRow, input: PipelineJobComplete): void {
		const conclusion: PipelineConclusion =
			input.conclusion === 'success' && (job.cancelRequested || this.requireRun(job.runId).cancelRequested)
				? 'cancelled'
				: input.conclusion;
		this.completeJob(job, conclusion, input.error ?? null, input.outputs);
		this.advance(job.runId);
	}

	// --- artifacts -----------------------------------------------------------------------

	async createArtifact(job: PipelineJobRow, input: PipelineArtifactCreate): Promise<PipelineArtifactUpload> {
		const existing = this.ctx.db
			.select()
			.from(pipelineArtifacts)
			.where(and(eq(pipelineArtifacts.runId, job.runId), eq(pipelineArtifacts.name, input.name)))
			.get();
		if (existing?.status === 'ready')
			throw new ConflictError(`An artifact named "${input.name}" already exists in this run.`);
		const id = existing?.id ?? newId('part_');
		const objectKey = `pipelines/${job.repositoryId}/${job.runId}/artifacts/${id}.tar.gz`;
		const now = this.ctx.now();
		const expiresAt = now + (input.retentionDays ?? ARTIFACT_DEFAULT_DAYS) * DAY;
		if (existing)
			this.ctx.db
				.update(pipelineArtifacts)
				.set({ jobId: job.id, size: input.size, sha256: input.sha256, expiresAt })
				.where(eq(pipelineArtifacts.id, id))
				.run();
		else
			this.ctx.db
				.insert(pipelineArtifacts)
				.values({
					id,
					orgId: job.orgId,
					repositoryId: job.repositoryId,
					runId: job.runId,
					jobId: job.id,
					name: input.name,
					objectKey,
					size: input.size,
					sha256: input.sha256,
					status: 'pending',
					createdAt: now,
					expiresAt,
				})
				.run();
		return { artifactId: id, uploadUrl: await this.ctx.objectStore.presignPut(objectKey, 60 * 60, 'application/gzip') };
	}

	async finalizeArtifact(job: PipelineJobRow, artifactId: string): Promise<PipelineArtifactView> {
		const row = this.ctx.db.select().from(pipelineArtifacts).where(eq(pipelineArtifacts.id, artifactId)).get();
		if (!row || row.runId !== job.runId) throw new NotFoundError('Artifact');
		const size = this.ctx.objectStore.size ? await this.ctx.objectStore.size(row.objectKey) : null;
		if (size === null && !(await this.ctx.objectStore.exists(row.objectKey)))
			throw new ValidationError('The artifact was not uploaded.');
		this.ctx.db
			.update(pipelineArtifacts)
			.set({ status: 'ready', size: size ?? row.size })
			.where(eq(pipelineArtifacts.id, row.id))
			.run();
		return this.artifactView({ ...row, status: 'ready', size: size ?? row.size });
	}

	async listArtifacts(runId: string, options: { name?: string; withUrls?: boolean } = {}): Promise<PipelineArtifactView[]> {
		const rows = this.ctx.db
			.select()
			.from(pipelineArtifacts)
			.where(and(eq(pipelineArtifacts.runId, runId), eq(pipelineArtifacts.status, 'ready')))
			.orderBy(asc(pipelineArtifacts.createdAt))
			.all()
			.filter((row) => !options.name || row.name === options.name);
		return Promise.all(
			rows.map(async (row) => ({
				...this.artifactView(row),
				...(options.withUrls ? { downloadUrl: await this.ctx.objectStore.presignGet(row.objectKey, 60 * 60) } : {}),
			})),
		);
	}

	artifactView(row: typeof pipelineArtifacts.$inferSelect): PipelineArtifactView {
		return {
			id: row.id,
			runId: row.runId,
			jobId: row.jobId,
			name: row.name,
			size: row.size,
			sha256: row.sha256,
			createdAt: new Date(row.createdAt).toISOString(),
			expiresAt: new Date(row.expiresAt).toISOString(),
		};
	}

	async artifactDownloadUrl(runId: string, artifactId: string): Promise<string> {
		const row = this.ctx.db.select().from(pipelineArtifacts).where(eq(pipelineArtifacts.id, artifactId)).get();
		if (!row || row.runId !== runId || row.status !== 'ready') throw new NotFoundError('Artifact');
		return this.ctx.objectStore.presignGet(row.objectKey, 10 * 60);
	}

	// --- caches (W10, W13) ---------------------------------------------------------------

	/** Untrusted runs read and write only their own scope; trusted ones their branch. */
	cacheScope(run: PipelineRunRow): string {
		return run.trust === 'untrusted' ? `untrusted:${run.ref}` : `ref:${run.ref}`;
	}

	async lookupCache(job: PipelineJobRow, input: PipelineCacheLookup): Promise<PipelineCacheHit | null> {
		const run = this.requireRun(job.runId);
		const repository = this.requireRepository(run.repositoryId);
		const scopes = [this.cacheScope(run), `ref:refs/heads/${repository.defaultBranch}`];
		const ready = (scope: string) =>
			this.ctx.db
				.select()
				.from(pipelineCaches)
				.where(
					and(
						eq(pipelineCaches.repositoryId, repository.id),
						eq(pipelineCaches.scope, scope),
						eq(pipelineCaches.version, input.version),
						eq(pipelineCaches.status, 'ready'),
					),
				)
				.all();
		for (const scope of [...new Set(scopes)]) {
			const rows = ready(scope).sort((a, b) => b.createdAt - a.createdAt);
			const hit =
				rows.find((row) => row.key === input.key) ??
				input.restoreKeys.map((prefix) => rows.find((row) => row.key.startsWith(prefix))).find(Boolean);
			if (hit) {
				this.ctx.db.update(pipelineCaches).set({ lastUsedAt: this.ctx.now() }).where(eq(pipelineCaches.id, hit.id)).run();
				return { key: hit.key, size: hit.size, downloadUrl: await this.ctx.objectStore.presignGet(hit.objectKey, 60 * 60) };
			}
		}
		return null;
	}

	async reserveCache(job: PipelineJobRow, input: PipelineCacheReserve): Promise<PipelineCacheReservation> {
		const run = this.requireRun(job.runId);
		const scope = this.cacheScope(run);
		const existing = this.ctx.db
			.select()
			.from(pipelineCaches)
			.where(
				and(
					eq(pipelineCaches.repositoryId, job.repositoryId),
					eq(pipelineCaches.scope, scope),
					eq(pipelineCaches.key, input.key),
					eq(pipelineCaches.version, input.version),
				),
			)
			.get();
		if (existing?.status === 'ready') return { cacheId: null, uploadUrl: null, reason: 'exists' };
		if (input.size > CACHE_BYTES_PER_REPOSITORY) return { cacheId: null, uploadUrl: null, reason: 'too large' };
		const id = existing?.id ?? newId('pch_');
		const objectKey = `pipelines/${job.repositoryId}/caches/${id}.tar.gz`;
		const now = this.ctx.now();
		if (!existing)
			this.ctx.db
				.insert(pipelineCaches)
				.values({
					id,
					orgId: job.orgId,
					repositoryId: job.repositoryId,
					scope,
					key: input.key,
					version: input.version,
					objectKey,
					size: input.size,
					status: 'pending',
					createdAt: now,
					lastUsedAt: now,
				})
				.run();
		return { cacheId: id, uploadUrl: await this.ctx.objectStore.presignPut(objectKey, 60 * 60, 'application/gzip') };
	}

	async commitCache(job: PipelineJobRow, cacheId: string): Promise<void> {
		const row = this.ctx.db.select().from(pipelineCaches).where(eq(pipelineCaches.id, cacheId)).get();
		if (!row || row.repositoryId !== job.repositoryId) throw new NotFoundError('Cache');
		const size = this.ctx.objectStore.size ? await this.ctx.objectStore.size(row.objectKey) : row.size;
		if (size === null) throw new ValidationError('The cache was not uploaded.');
		this.ctx.db.update(pipelineCaches).set({ status: 'ready', size }).where(eq(pipelineCaches.id, row.id)).run();
		await this.evictCaches(row.repositoryId);
	}

	/** Keep each repository under its cache budget, least recently used first. */
	private async evictCaches(repositoryId: string): Promise<void> {
		const rows = this.ctx.db
			.select()
			.from(pipelineCaches)
			.where(and(eq(pipelineCaches.repositoryId, repositoryId), eq(pipelineCaches.status, 'ready')))
			.orderBy(asc(pipelineCaches.lastUsedAt))
			.all();
		let total = rows.reduce((sum, row) => sum + row.size, 0);
		for (const row of rows) {
			if (total <= CACHE_BYTES_PER_REPOSITORY) break;
			await this.deleteCacheRow(row);
			total -= row.size;
		}
	}

	private async deleteCacheRow(row: typeof pipelineCaches.$inferSelect): Promise<void> {
		this.ctx.db.delete(pipelineCaches).where(eq(pipelineCaches.id, row.id)).run();
		await this.ctx.objectStore.delete(row.objectKey).catch(() => undefined);
	}

	// --- deploys (§4.4) -----------------------------------------------------------------

	private deployTarget(job: PipelineJobRow, slug: string) {
		const run = this.requireRun(job.runId);
		if (run.trust === 'untrusted') throw new CoreError('forbidden', 'Untrusted runs cannot deploy.', 403);
		const project = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, job.orgId), eq(projects.slug, slug)))
			.get();
		if (!project || project.deletedAt) throw new NotFoundError('Project');
		const link = this.ctx.db
			.select()
			.from(pipelineProjectLinks)
			.where(and(eq(pipelineProjectLinks.repositoryId, job.repositoryId), eq(pipelineProjectLinks.projectId, project.id)))
			.get();
		if (!link)
			throw new CoreError(
				'forbidden',
				`Project "${slug}" is not linked to this repository. Link it under Pipelines → repository → Deploy targets.`,
				403,
			);
		if (link.environment && link.environment !== job.environment)
			throw new CoreError('forbidden', `Deploys to "${slug}" are only allowed from jobs in environment "${link.environment}".`, 403);
		const repository = this.requireRepository(job.repositoryId);
		const serviceAccountId = this.ctx.serviceAccounts.ensurePipelineAccount({
			orgId: job.orgId,
			repositoryId: repository.id,
			repositoryName: repository.name,
			createdBy: run.createdBy ?? repository.createdBy,
		});
		if (!this.ctx.serviceAccounts.pipelineAccountEnabled(job.orgId, serviceAccountId))
			throw new CoreError(
				'forbidden',
				'The repository pipeline service account is disabled. Re-enable it in Settings → Access to resume deploys.',
				403,
			);
		// IAM.md §7.2: the control-plane side acts as the repository's account, with the run's
		// creator recorded as `actingFor` for audit. `pipeline_project_links` above remains the
		// extra gate, so the account's project binding is never the only thing allowing a deploy.
		const shell: Principal = {
			kind: 'serviceAccount',
			userId: serviceAccountId,
			orgId: job.orgId,
			role: 'viewer',
			permissions: new Set<Permission>(),
			credential: 'job',
			...(run.createdBy ? { actingFor: { kind: 'user' as const, id: run.createdBy } } : {}),
		};
		const principal: Principal = {
			...shell,
			permissions: new Set<Permission>([...this.ctx.iam.compiledFor(shell).index.keys()]),
		};
		return { run, project, principal };
	}

	async startDeploy(job: PipelineJobRow, input: PipelineDeployRequest): Promise<PipelineDeployStart> {
		const { run, project, principal } = this.deployTarget(job, input.project);
		const message = input.message ?? `${run.workflowName} #${run.number} (${run.sha.slice(0, 7)})`;
		const id = newId('pdp_');
		if (input.image) {
			if (project.runtime !== 'container')
				throw new ValidationError(`Project "${project.slug}" is ${project.runtime}; image deploys need a container project.`);
			// Keep everything else about the workload; only the image changes (it is pinned at deploy, R1).
			const current = parse<Record<string, unknown>>(project.workloadJson, {});
			this.ctx.workloads.setSpec(principal, project, { ...current, runtime: 'container', image: input.image } as never);
			const manifest = new TextEncoder().encode(
				JSON.stringify({ image: input.image, run: run.id, sha: run.sha, workflow: run.workflowPath }, null, 2),
			);
			const fresh = this.ctx.projects.requireById(principal, project.id);
			const deployment = await this.ctx.deployments.deployEntries(principal, fresh, [{ path: 'yoal-pipeline.json', data: manifest }], {
				promote: input.promote,
				message,
			});
			this.ctx.db
				.insert(pipelineDeploys)
				.values({ id, jobId: job.id, projectId: project.id, promote: input.promote, message, status: 'done', deploymentId: deployment.id, createdAt: this.ctx.now() })
				.run();
			this.audit(principal, job, project.slug, deployment.id);
			return { deployId: id, uploadUrl: null, deploymentId: deployment.id, url: input.promote ? deployment.productionUrl : deployment.previewUrl };
		}
		const objectKey = `pipelines/${job.repositoryId}/${job.runId}/deploys/${id}.zip`;
		this.ctx.db
			.insert(pipelineDeploys)
			.values({ id, jobId: job.id, projectId: project.id, objectKey, promote: input.promote, message, status: 'pending', createdAt: this.ctx.now() })
			.run();
		return { deployId: id, uploadUrl: await this.ctx.objectStore.presignPut(objectKey, 60 * 60, 'application/zip'), deploymentId: null, url: null };
	}

	async finalizeDeploy(job: PipelineJobRow, deployId: string): Promise<PipelineDeployResult> {
		const row = this.ctx.db.select().from(pipelineDeploys).where(eq(pipelineDeploys.id, deployId)).get();
		if (!row || row.jobId !== job.id || !row.objectKey) throw new NotFoundError('Deploy');
		if (row.status !== 'pending') throw new ConflictError(`Deploy is already ${row.status}.`);
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		if (!project) throw new NotFoundError('Project');
		const { principal } = this.deployTarget(job, project.slug);
		try {
			const zip = await this.ctx.objectStore.get(row.objectKey);
			const deployment = await this.ctx.deployments.deployEntries(principal, project, entriesFromZip(zip), {
				promote: row.promote,
				precompress: true,
				message: row.message ?? undefined,
			});
			this.ctx.db.update(pipelineDeploys).set({ status: 'done', deploymentId: deployment.id }).where(eq(pipelineDeploys.id, row.id)).run();
			this.audit(principal, job, project.slug, deployment.id);
			return { deploymentId: deployment.id, url: row.promote ? deployment.productionUrl : deployment.previewUrl };
		} catch (error) {
			this.ctx.db.update(pipelineDeploys).set({ status: 'failed' }).where(eq(pipelineDeploys.id, row.id)).run();
			throw error;
		} finally {
			await this.ctx.objectStore.delete(row.objectKey).catch(() => undefined);
		}
	}

	private audit(principal: Principal, job: PipelineJobRow, project: string, deploymentId: string): void {
		this.ctx.audit.record({
			principal,
			action: 'pipeline.deploy',
			resource: 'project',
			resourceId: project,
			args: { job: job.id, run: job.runId, deploymentId },
			result: 'ok',
		});
	}

	// --- retention ----------------------------------------------------------------------

	/** Maintenance tick: leases, expired artifacts, idle caches, old log lines. */
	async prune(now = this.ctx.now()): Promise<{ artifacts: number; caches: number; logLines: number }> {
		this.recoverExpiredLeases(now);
		let artifacts = 0;
		for (const row of this.ctx.db.select().from(pipelineArtifacts).where(lt(pipelineArtifacts.expiresAt, now)).limit(500).all()) {
			this.ctx.db.delete(pipelineArtifacts).where(eq(pipelineArtifacts.id, row.id)).run();
			await this.ctx.objectStore.delete(row.objectKey).catch(() => undefined);
			artifacts++;
		}
		let caches = 0;
		for (const row of this.ctx.db
			.select()
			.from(pipelineCaches)
			.where(lt(pipelineCaches.lastUsedAt, now - CACHE_UNUSED_DAYS * DAY))
			.limit(500)
			.all()) {
			await this.deleteCacheRow(row);
			caches++;
		}
		const logDays = 90;
		const logLines = this.ctx.sqlite.run('DELETE FROM pipeline_log_lines WHERE ts < ?', [now - logDays * DAY]).changes;
		return { artifacts, caches, logLines };
	}

	// --- lookups ------------------------------------------------------------------------

	requireRepository(id: string): PipelineRepositoryRow {
		const row = this.ctx.db.select().from(pipelineRepositories).where(eq(pipelineRepositories.id, id)).get();
		if (!row) throw new NotFoundError('Repository');
		return row;
	}

	requireRun(id: string): PipelineRunRow {
		const row = this.ctx.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get();
		if (!row) throw new NotFoundError('Run');
		return row;
	}

	requireJob(id: string): PipelineJobRow {
		const row = this.ctx.db.select().from(pipelineJobs).where(eq(pipelineJobs.id, id)).get();
		if (!row) throw new NotFoundError('Job');
		return row;
	}
}

/** Where a stored status token posts for a GitLab, Gitea or Forgejo repository (D176). */
function forgeStatusTarget(
	ctx: CoreContext,
	repository: PipelineRepositoryRow,
): { kind: ForgeKind; baseUrl: string; fullName: string } | null {
	if (repository.provider !== 'gitlab' && repository.provider !== 'gitea' && repository.provider !== 'forgejo') return null;
	const connection = ctx.forges.connectionFor(repository.orgId, repository.cloneUrl);
	if (connection) return { kind: repository.provider, baseUrl: connection.row.baseUrl, fullName: connection.fullName };
	const parsed = parseRepoUrl(repository.cloneUrl);
	if (!parsed) return null;
	const baseUrl = `https://${parsed.host}`;
	const fullName = forgeFullName(baseUrl, repository.cloneUrl);
	return fullName ? { kind: repository.provider, baseUrl, fullName } : null;
}
