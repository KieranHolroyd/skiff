import * as z from 'zod';

/**
 * Pipelines (docs/PIPELINES.md): GitHub-Actions-shaped workflows run as jobs on build nodes.
 *
 * This file holds the wire contract shared by the control plane, the runner on a build node, the
 * in-job step runner, the dashboard and the CLI. The workflow parser, matrix expansion, trigger
 * matching and the `${{ }}` evaluator live in `pipeline-workflow.ts` and `pipeline-expr.ts`.
 */

// --- statuses ---------------------------------------------------------------------------

export const pipelineRunStatuses = ['queued', 'in_progress', 'completed'] as const;
export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];

/**
 * `pending`: waiting for `needs`. `waiting`: waiting for an environment approval. `queued`: ready
 * for a node. `in_progress`: claimed. `completed`: has a conclusion.
 */
export const pipelineJobStatuses = ['pending', 'waiting', 'queued', 'in_progress', 'completed'] as const;
export type PipelineJobStatus = (typeof pipelineJobStatuses)[number];

export const pipelineConclusions = ['success', 'failure', 'cancelled', 'skipped', 'timed_out'] as const;
export type PipelineConclusion = (typeof pipelineConclusions)[number];

export const pipelineStepStatuses = ['pending', 'in_progress', 'completed'] as const;
export type PipelineStepStatus = (typeof pipelineStepStatuses)[number];

export const pipelineEvents = ['push', 'pull_request', 'workflow_dispatch', 'schedule', 'skiff_event'] as const;
export type PipelineEventName = (typeof pipelineEvents)[number];

/** W10: `trusted` runs get secrets and deploy rights; `untrusted` (fork PRs) get neither. */
export const pipelineTrustLevels = ['trusted', 'untrusted'] as const;
export type PipelineTrust = (typeof pipelineTrustLevels)[number];

/** Directory workflows are read from at the triggering commit (W1). */
export const PIPELINE_WORKFLOW_DIR = '.skiff/workflows';

/** Built-in actions (`uses:`). GitHub action names in `PIPELINE_ACTION_ALIASES` map onto these. */
export const pipelineBuiltinActions = [
	'skiff/checkout',
	'skiff/cache',
	'skiff/upload-artifact',
	'skiff/download-artifact',
	'skiff/deploy',
	'skiff/build-image',
	'skiff/image-index',
	'skiff/oidc-token',
] as const;
export type PipelineBuiltinAction = (typeof pipelineBuiltinActions)[number];

/**
 * W13: popular GitHub actions run as Skiff built-ins (any version), so most workflows need no
 * edit. Key is the `owner/repo` part of `uses:` (the `@ref` is ignored).
 */
export const PIPELINE_ACTION_ALIASES: Readonly<Record<string, PipelineBuiltinAction>> = {
	'actions/checkout': 'skiff/checkout',
	'actions/cache': 'skiff/cache',
	'actions/upload-artifact': 'skiff/upload-artifact',
	'actions/download-artifact': 'skiff/download-artifact',
};

/** Resolve `uses:` to a built-in, or null when Skiff cannot run it. */
export function resolvePipelineAction(uses: string): PipelineBuiltinAction | null {
	const name = uses.split('@')[0]!.trim().toLowerCase();
	if ((pipelineBuiltinActions as readonly string[]).includes(name)) return name as PipelineBuiltinAction;
	return PIPELINE_ACTION_ALIASES[name] ?? null;
}

// --- normalized workflow (output of parseWorkflow) --------------------------------------

/** String values may contain `${{ }}` templates; they are evaluated where GitHub would. */
export type TemplateMap = Record<string, string>;

export interface PipelineStepSpec {
	/** `id:` (for `steps.<id>.outputs`); null when not set. */
	id: string | null;
	/** Display name (template). Defaults to `Run <first line>` / `Run <uses>` like GitHub. */
	name: string;
	/** `if:` without the optional `${{ }}` wrapper; null means `success()`. */
	if: string | null;
	run: string | null;
	/** `bash` (default), `sh`, or a custom `cmd {0}` template. */
	shell: string | null;
	workingDirectory: string | null;
	uses: string | null;
	with: TemplateMap;
	env: TemplateMap;
	/** Boolean, or a template string evaluated at run time. */
	continueOnError: boolean | string;
	timeoutMinutes: number | null;
}

export interface PipelineContainerSpec {
	image: string;
	env: TemplateMap;
	/** Extra ports for services (`"5432"` or `"8080:80"`); ignored for the job container. */
	ports: string[];
	/** Health command for services, like `--health-cmd` in GitHub `options:`. */
	healthCmd: string | null;
}

export interface PipelineEnvironmentRef {
	name: string;
	url: string | null;
}

export interface PipelineJobSpec {
	key: string;
	/** Display name (template; may use `matrix`). */
	name: string;
	needs: string[];
	if: string | null;
	/** Labels; each may be a template using `matrix` (resolved after expansion). */
	runsOn: string[];
	strategy: {
		/** An object of axes + include/exclude, or a single template (`${{ fromJSON(...) }}`). */
		matrix: Record<string, unknown> | string | null;
		failFast: boolean;
		maxParallel: number | null;
	};
	outputs: TemplateMap;
	env: TemplateMap;
	defaults: { shell: string | null; workingDirectory: string | null };
	timeoutMinutes: number;
	continueOnError: boolean | string;
	concurrency: { group: string; cancelInProgress: boolean } | null;
	environment: PipelineEnvironmentRef | null;
	container: PipelineContainerSpec | null;
	services: Record<string, PipelineContainerSpec>;
	steps: PipelineStepSpec[];
	/**
	 * A job that calls a reusable workflow (`uses: ./.skiff/workflows/x.yml`) instead of running
	 * steps. Only on parsed workflows: the engine replaces the caller with the called workflow's
	 * jobs (keys `<caller>--<callee>`) before anything is claimed.
	 */
	uses?: string | null;
	/** `with:` for a reusable-workflow call (templates over the caller's context). */
	with?: TemplateMap;
	/** `secrets: inherit` or an explicit map for a reusable-workflow call. */
	secrets?: 'inherit' | TemplateMap | null;
	/**
	 * Set by the engine on jobs inlined from a reusable workflow: the `inputs` context they see,
	 * already evaluated against the caller, and which secrets they may read.
	 */
	callInputs?: Record<string, unknown>;
	callSecrets?: 'inherit' | Record<string, string> | null;
}

export interface PipelineDispatchInput {
	type: 'string' | 'boolean' | 'number' | 'choice' | 'environment';
	description: string | null;
	required: boolean;
	default: string | number | boolean | null;
	options: string[];
}

export interface PipelineRefFilter {
	branches: string[] | null;
	branchesIgnore: string[] | null;
	tags: string[] | null;
	tagsIgnore: string[] | null;
	paths: string[] | null;
	pathsIgnore: string[] | null;
}

export interface PipelineWorkflowCall {
	inputs: Record<string, PipelineDispatchInput>;
	/** `outputs.<name>.value` templates over the `jobs` context. */
	outputs: Record<string, { value: string; description: string | null }>;
	secrets: Record<string, { required: boolean; description: string | null }>;
}

export interface PipelineTriggers {
	push: PipelineRefFilter | null;
	pullRequest: (PipelineRefFilter & { types: string[] }) | null;
	workflowDispatch: { inputs: Record<string, PipelineDispatchInput> } | null;
	schedule: string[];
	/** Optional on older parsed workflows. */
	workflowCall?: PipelineWorkflowCall | null;
	/** `skiff_event: { types: [deployment.failed, …] }` (EventService event types; empty = any). */
	skiffEvent?: { types: string[] } | null;
}

/** Isolation tiers, weakest first (W14). `sandbox` is the Builder's systemd unit, no container. */
export const pipelineIsolationTiers = ['sandbox', 'container', 'gvisor', 'microvm'] as const;
export type PipelineIsolationTier = (typeof pipelineIsolationTiers)[number];
/** OCI runtime per container tier: runc (`container`), runsc (`gvisor`), kata (`microvm`). */
export const pipelineContainerRuntimes = ['runc', 'runsc', 'kata'] as const;
export type PipelineContainerRuntime = (typeof pipelineContainerRuntimes)[number];

export interface PipelineWorkflow {
	/** Path relative to the repository root, e.g. `.skiff/workflows/ci.yml`. */
	path: string;
	name: string;
	runName: string | null;
	on: PipelineTriggers;
	env: TemplateMap;
	defaults: { shell: string | null; workingDirectory: string | null };
	concurrency: { group: string; cancelInProgress: boolean } | null;
	jobs: Record<string, PipelineJobSpec>;
}

/** A parse problem with a JSON-path-ish location (`jobs.build.steps[2].uses`). */
export interface PipelineWorkflowIssue {
	path: string;
	message: string;
}

/** The event a workflow is matched against (trigger filtering, W1). */
export interface PipelineTriggerEvent {
	event: PipelineEventName;
	/** Full ref, e.g. `refs/heads/main`, `refs/tags/v1.2.3`, `refs/pull/7/merge`. */
	ref: string;
	/** For pull_request: the base branch name. */
	baseRef?: string | null;
	/** For pull_request: `opened`, `synchronize`, `reopened`, … */
	action?: string | null;
	/** Changed files, when known; `null` means unknown (path filters then match). */
	changedFiles?: string[] | null;
	/** For workflow_dispatch: the workflow path the user picked. */
	workflowPath?: string | null;
	/** For schedule: the cron expression that fired. */
	schedule?: string | null;
	/** For skiff_event: the event type (`deployment.failed`, …). */
	eventType?: string | null;
}

// --- expression context ----------------------------------------------------------------

export interface PipelineNeedsContext {
	result: 'success' | 'failure' | 'cancelled' | 'skipped';
	outputs: Record<string, string>;
}

export interface PipelineStepContext {
	outcome: 'success' | 'failure' | 'cancelled' | 'skipped';
	conclusion: 'success' | 'failure' | 'cancelled' | 'skipped';
	outputs: Record<string, string>;
}

/** Everything `${{ }}` can see. `github` is an alias of `skiff` (W1). */
export interface PipelineExpressionContext {
	skiff: Record<string, unknown>;
	env?: Record<string, string>;
	vars?: Record<string, string>;
	secrets?: Record<string, string>;
	inputs?: Record<string, unknown>;
	matrix?: Record<string, unknown>;
	strategy?: Record<string, unknown>;
	needs?: Record<string, PipelineNeedsContext>;
	steps?: Record<string, PipelineStepContext>;
	job?: Record<string, unknown>;
	runner?: Record<string, unknown>;
	/** `on.workflow_call.outputs` only: the called workflow's jobs (`result`, `outputs`). */
	jobs?: Record<string, PipelineNeedsContext>;
}

/** Job/step status for `success()`, `failure()`, `cancelled()`, `always()`. */
export interface PipelineStatusState {
	/** Some earlier step (or a needed job) failed. */
	failed: boolean;
	/** The run was cancelled. */
	cancelled: boolean;
}

// --- runner protocol (node token) -----------------------------------------------------

export interface PipelineRepositoryRef {
	id: string;
	name: string;
	cloneUrl: string;
}

/** Ask a node to read the workflow files at a ref (any git host, node's git credentials). */
export interface PipelineResolveClaim {
	kind: 'resolve';
	triggerId: string;
	token: string;
	repository: PipelineRepositoryRef;
	ref: string;
	sha: string | null;
}

export interface PipelineJobClaim {
	kind: 'job';
	jobId: string;
	runId: string;
	runNumber: number;
	attempt: number;
	/** Bearer token for `/api/pipeline/*`, valid while the job runs. */
	token: string;
	repository: PipelineRepositoryRef;
	checkout: { ref: string; sha: string };
	workflow: { name: string; path: string };
	/** The job with matrix-dependent labels and name already resolved. */
	job: PipelineJobSpec;
	/** Workflow-level `env`, applied under the job's own `env`. */
	workflowEnv: TemplateMap;
	workflowDefaults: { shell: string | null; workingDirectory: string | null };
	/** Static expression context: skiff, inputs, vars, matrix, strategy, needs, job. */
	context: PipelineExpressionContext;
	/** Names of the secrets this job may read; values come from `GET /api/pipeline/secrets`. */
	secretNames: string[];
	trust: PipelineTrust;
	/** Container image for the job when `container:` is not set. */
	image: string;
	limits: { memoryMb: number; cpus: number; timeoutMinutes: number };
	/**
	 * The platform registry (docs/REGISTRY.md), when it is on: the job logs in as `job.<jobId>`
	 * with its job token. `namespace` is `<host>/<org slug>`; `registry/<name>` tags expand to it.
	 * Trusted runs may push there; untrusted runs only pull. Absent from older control planes.
	 */
	registry?: { host: string; namespace: string; push: boolean } | null;
	/**
	 * OCI runtime for container isolation (W14): `runc`, `runsc` (gVisor) or `kata` (microVM).
	 * Only set when the node claimed with container isolation. Absent from older control planes.
	 */
	runtime?: PipelineContainerRuntime | null;
	/** Start a per-job rootless BuildKit sidecar (W6): a step uses `skiff/build-image`. */
	buildkit?: boolean;
	/** BuildKit cache scope (W10): never shared between trusted and untrusted runs. */
	buildkitCacheScope?: string | null;
}

export type PipelineClaim = PipelineResolveClaim | PipelineJobClaim;

export const pipelineClaimRequestSchema = z.object({
	/** Labels this node offers (`linux`, `x64`, `oci-build`, …); the control plane adds its own. */
	labels: z.array(z.string().min(1).max(64)).max(64).default([]),
	/** Free job slots right now. */
	capacity: z.number().int().min(0).max(64).default(1),
	/** How jobs run here: `container` (Podman) or `sandbox` (systemd-run, no container image). */
	isolation: z.enum(['container', 'sandbox']).default('sandbox'),
	/** OCI runtimes this node can run job containers with (W14). `runc` is implied by `container`. */
	runtimes: z.array(z.enum(pipelineContainerRuntimes)).max(3).default([]),
});
export type PipelineClaimRequest = z.infer<typeof pipelineClaimRequestSchema>;
export type PipelineClaimRequestInput = z.input<typeof pipelineClaimRequestSchema>;

// --- job protocol (job token) ------------------------------------------------------------

export const pipelineResolveReportSchema = z.object({
	sha: z.string().min(7).max(64).optional(),
	commitMessage: z.string().max(4000).optional(),
	files: z
		.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(512_000) }))
		.max(100)
		.default([]),
	/** Changed files of the push, when the node could compute them (path filters). */
	changedFiles: z.array(z.string().max(1024)).max(5000).nullable().optional(),
	error: z.string().max(4000).optional(),
});
export type PipelineResolveReport = z.infer<typeof pipelineResolveReportSchema>;

export const pipelineHeartbeatSchema = z.object({
	/** Index of the running step, when any. */
	step: z.number().int().min(-1).max(1000).optional(),
});
export interface PipelineHeartbeatResponse {
	/** The run or job was cancelled: stop, run `always()` steps, then complete with `cancelled`. */
	cancelled: boolean;
	leaseExpiresAt: number;
}

export const pipelineStepReportSchema = z.object({
	status: z.enum(pipelineStepStatuses),
	conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped']).nullable().optional(),
	/** Resolved display name (templates evaluated). */
	name: z.string().max(500).optional(),
	outputs: z.record(z.string(), z.string().max(1_000_000)).optional(),
	/** What the step wrote to `$SKIFF_STEP_SUMMARY` (Markdown), shown on the run page. */
	summary: z.string().max(1_000_000).optional(),
});
export type PipelineStepReport = z.infer<typeof pipelineStepReportSchema>;

export const pipelineLogBatchSchema = z.object({
	lines: z
		.array(
			z.object({
				/** Step index; -1 for job setup/teardown lines. */
				step: z.number().int().min(-1).max(1000),
				stream: z.enum(['stdout', 'stderr', 'system']).default('stdout'),
				text: z.string().max(16_384),
				ts: z.number().int().optional(),
			}),
		)
		.max(1000),
});
export type PipelineLogBatch = z.infer<typeof pipelineLogBatchSchema>;

export const pipelineJobCompleteSchema = z.object({
	conclusion: z.enum(['success', 'failure', 'cancelled', 'timed_out']),
	outputs: z.record(z.string(), z.string().max(1_000_000)).default({}),
	error: z.string().max(4000).optional(),
});
export type PipelineJobComplete = z.infer<typeof pipelineJobCompleteSchema>;

export interface PipelineSecretsResponse {
	secrets: Record<string, string>;
}

const artifactName = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[^\\/:*?"<>|\0]+$/, 'Artifact names cannot contain path separators or : * ? " < > |');

export const pipelineArtifactCreateSchema = z.object({
	name: artifactName,
	size: z.number().int().min(0).max(10 * 1024 ** 3),
	/** sha256 of the uploaded archive (tar.gz of the paths). */
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	retentionDays: z.number().int().min(1).max(90).optional(),
});
export type PipelineArtifactCreate = z.infer<typeof pipelineArtifactCreateSchema>;

export interface PipelineArtifactUpload {
	artifactId: string;
	uploadUrl: string;
}

export interface PipelineArtifactView {
	id: string;
	runId: string;
	jobId: string | null;
	name: string;
	size: number;
	sha256: string;
	createdAt: string;
	expiresAt: string;
	/** Present on runner/job-token responses and on explicit download requests. */
	downloadUrl?: string;
}

export const pipelineCacheLookupSchema = z.object({
	key: z.string().min(1).max(512),
	restoreKeys: z.array(z.string().min(1).max(512)).max(10).default([]),
	/** Hash of the cached paths (+ compression), so different path sets never collide. */
	version: z.string().min(1).max(128),
});
export type PipelineCacheLookup = z.infer<typeof pipelineCacheLookupSchema>;

export interface PipelineCacheHit {
	key: string;
	downloadUrl: string;
	size: number;
}

export const pipelineCacheReserveSchema = z.object({
	key: z.string().min(1).max(512),
	version: z.string().min(1).max(128),
	size: z.number().int().min(0).max(10 * 1024 ** 3),
});
export type PipelineCacheReserve = z.infer<typeof pipelineCacheReserveSchema>;

/** `uploadUrl` null means the key already exists (or this job may not write the cache). */
export interface PipelineCacheReservation {
	cacheId: string | null;
	uploadUrl: string | null;
	reason?: string;
}

/**
 * `skiff/deploy`: deploy to a linked project. Exactly one of `image` (a container project; a
 * digest reference is recommended) or an uploaded zip (`archive: true`, static/process/function).
 */
export const pipelineDeploySchema = z
	.object({
		project: z.string().min(1).max(100),
		image: z.string().min(1).max(512).optional(),
		archive: z.boolean().default(false),
		promote: z.boolean().default(false),
		message: z.string().max(2000).optional(),
	})
	.refine((value) => Boolean(value.image) !== value.archive, 'Set exactly one of image or archive');
export type PipelineDeployRequest = z.infer<typeof pipelineDeploySchema>;

export interface PipelineDeployStart {
	deployId: string;
	/** For an archive deploy: PUT the zip here, then call `/deploy/:id/finalize`. */
	uploadUrl: string | null;
	/** For an image deploy the deployment is created at once. */
	deploymentId: string | null;
	url: string | null;
}

export interface PipelineDeployResult {
	deploymentId: string;
	url: string | null;
}

// --- REST (user principal) ---------------------------------------------------------------

const repositoryName = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/, 'Use lowercase letters, digits, dots, dashes and underscores');

const cloneUrl = z
	.string()
	.min(4)
	.max(512)
	.refine((value) => /^(https:\/\/|ssh:\/\/|git@)/.test(value), 'Repository must be an https or ssh URL');

export const pipelineRepositoryCreateSchema = z.object({
	name: repositoryName,
	cloneUrl,
	provider: z.enum(['github', 'generic']).default('github'),
	defaultBranch: z.string().min(1).max(255).default('main'),
	/** GitHub webhook secret (≥ 16 chars). Write-only. */
	webhookSecret: z.string().min(16).max(256).optional(),
	/** Default image for jobs without `container:` (container isolation only). */
	defaultImage: z.string().min(1).max(512).optional(),
	/**
	 * W14: the weakest isolation a job of each trust tier may run under. A job is only offered to
	 * nodes that can give at least this. Null = any (sandbox included).
	 */
	minIsolation: z
		.object({
			trusted: z.enum(pipelineIsolationTiers).nullable().default(null),
			untrusted: z.enum(pipelineIsolationTiers).nullable().default(null),
		})
		.optional(),
	/**
	 * A GitHub token allowed to write commit statuses (fine-grained: "Commit statuses: write") for
	 * this repository. Write-only. When set, every run reports its status on the commit.
	 */
	statusToken: z.string().min(10).max(512).optional(),
});
export type PipelineRepositoryCreate = z.infer<typeof pipelineRepositoryCreateSchema>;

export const pipelineRepositoryUpdateSchema = pipelineRepositoryCreateSchema
	.omit({ name: true })
	.partial()
	.extend({
		enabled: z.boolean().optional(),
		/** Explicit null clears the webhook secret. */
		webhookSecret: z.string().min(16).max(256).nullable().optional(),
		defaultImage: z.string().min(1).max(512).nullable().optional(),
		statusToken: z.string().min(10).max(512).nullable().optional(),
	});
export type PipelineRepositoryUpdate = z.infer<typeof pipelineRepositoryUpdateSchema>;

export interface PipelineRepositoryView {
	id: string;
	name: string;
	cloneUrl: string;
	provider: 'github' | 'generic';
	defaultBranch: string;
	defaultImage: string | null;
	enabled: boolean;
	hasWebhookSecret: boolean;
	hasStatusToken?: boolean;
	minIsolation?: { trusted: PipelineIsolationTier | null; untrusted: PipelineIsolationTier | null };
	/** Path of the webhook receiver, relative to the platform origin. */
	webhookPath: string;
	lastRun: PipelineRunSummary | null;
	createdAt: string;
	updatedAt: string;
}

export const pipelineDispatchSchema = z
	.object({
		/** Workflow file path (`.skiff/workflows/ci.yml`) or its file name (`ci.yml`). */
		workflow: z.string().min(1).max(512).optional(),
		/** Inline workflow YAML, run against `ref` instead of a file in the repository. */
		workflowText: z.string().min(1).max(512_000).optional(),
		ref: z.string().min(1).max(255).optional(),
		inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
	})
	.refine((value) => Boolean(value.workflow) !== Boolean(value.workflowText), 'Set exactly one of workflow or workflowText');
export type PipelineDispatch = z.infer<typeof pipelineDispatchSchema>;

export interface PipelineTriggerView {
	id: string;
	event: PipelineEventName;
	ref: string;
	status: 'resolving' | 'resolved' | 'failed';
	error: string | null;
	runIds: string[];
	createdAt: string;
}

export interface PipelineStepView {
	index: number;
	name: string;
	/** `$SKIFF_STEP_SUMMARY` Markdown, when the step wrote one. */
	summary?: string | null;
	status: PipelineStepStatus;
	conclusion: PipelineConclusion | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface PipelineJobView {
	id: string;
	key: string;
	name: string;
	matrix: Record<string, unknown> | null;
	needs: string[];
	runsOn: string[];
	status: PipelineJobStatus;
	conclusion: PipelineConclusion | null;
	environment: string | null;
	nodeId: string | null;
	nodeName: string | null;
	/** OCI runtime the job ran with (`runc`, `runsc`, `kata`); null in the Builder sandbox. */
	runtime?: string | null;
	attempt: number;
	error: string | null;
	outputs: Record<string, string>;
	steps: PipelineStepView[];
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface PipelineRunSummary {
	id: string;
	repository: string;
	number: number;
	workflowName: string;
	workflowPath: string;
	event: PipelineEventName;
	ref: string;
	sha: string;
	title: string;
	actor: string | null;
	trust: PipelineTrust;
	status: PipelineRunStatus;
	conclusion: PipelineConclusion | null;
	attempt: number;
	/** Why the run failed before any job ran (an invalid workflow, a bad reusable-workflow call). */
	error?: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface PipelineRunView extends PipelineRunSummary {
	inputs: Record<string, unknown>;
	jobs: PipelineJobView[];
	artifacts: PipelineArtifactView[];
}

export interface PipelineLogLine {
	seq: number;
	jobId: string;
	step: number;
	stream: 'stdout' | 'stderr' | 'system';
	text: string;
	ts: number;
}

export const pipelineRerunSchema = z.object({
	/** Only failed/cancelled jobs (and everything that depends on them). */
	failedOnly: z.boolean().default(false),
});
export type PipelineRerun = z.infer<typeof pipelineRerunSchema>;

const secretName = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Secret names are letters, digits and underscores')
	.refine((value) => !/^(SKIFF|GITHUB)_/i.test(value), 'Names starting with SKIFF_ or GITHUB_ are reserved');

export const pipelineSecretSetSchema = z.object({
	value: z.string().max(64 * 1024),
	/** Environment-scoped secret (W12); omitted means repository-wide. */
	environment: z.string().min(1).max(100).optional(),
});
export type PipelineSecretSet = z.infer<typeof pipelineSecretSetSchema>;
export const pipelineSecretNameSchema = secretName;

export interface PipelineSecretView {
	name: string;
	environment: string | null;
	updatedAt: string;
}

export const pipelineVariableSetSchema = z.object({ value: z.string().max(64 * 1024) });
export interface PipelineVariableView {
	name: string;
	value: string;
	updatedAt: string;
}

export const pipelineEnvironmentSetSchema = z.object({
	/** Ref globs that may use this environment (`refs/heads/main`, `refs/tags/v*`); empty = any. */
	allowedRefs: z.array(z.string().min(1).max(255)).max(50).default([]),
	/** A job naming this environment waits until an org owner/admin approves it. */
	requireApproval: z.boolean().default(false),
});
export type PipelineEnvironmentSet = z.infer<typeof pipelineEnvironmentSetSchema>;

export interface PipelineEnvironmentView {
	name: string;
	allowedRefs: string[];
	requireApproval: boolean;
	secretNames: string[];
	updatedAt: string;
}

/** Link a project so `skiff/deploy` may target it (W3, §4.4). */
export const pipelineProjectLinkSchema = z.object({
	/** Only jobs in this environment may deploy; null = any trusted job of this repository. */
	environment: z.string().min(1).max(100).nullable().default(null),
});
export type PipelineProjectLink = z.infer<typeof pipelineProjectLinkSchema>;

export interface PipelineProjectLinkView {
	projectSlug: string;
	projectName: string;
	runtime: string;
	environment: string | null;
	createdAt: string;
}

/**
 * Default job image for container isolation (W5): Debian with git, curl, Node and Python. The
 * step runner and Bun are bind-mounted from the node, so any glibc image works.
 */
export const PIPELINE_DEFAULT_IMAGE = 'docker.io/library/node:24-bookworm';

/** `POST /api/pipeline/oidc-token` (W9): an OIDC ID token for cloud federation. */
export const pipelineOidcTokenSchema = z.object({
	/** `aud` claim; defaults to the platform origin. */
	audience: z.string().min(1).max(512).optional(),
});
export interface PipelineOidcTokenResponse {
	token: string;
	expiresAt: number;
}
