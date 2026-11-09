/**
 * Pipelines (docs/PIPELINES.md §8): a thin client for `/api/v1/repositories/…` plus the CLI's
 * formatting. Every rule (workflow syntax, permissions, secrets) lives on the server; the only
 * local check is `yoal workflow lint`, which runs the same parser the control plane runs.
 *
 * Types come straight from the contracts package (type-only, so nothing is bundled for them).
 */
import type {
	PipelineConclusion,
	PipelineJobView,
	PipelineLogLine,
	PipelineRepositoryView,
	PipelineRunSummary,
	PipelineRunView,
	PipelineSecretView,
	PipelineStepView,
	PipelineTriggerView,
	PipelineVariableView,
	PipelineWorkflowIssue,
} from '../../../packages/contracts/src/pipeline.ts';
import type { ApiClient } from './api.ts';
import { CliError, UsageError } from './errors.ts';
import { formatBytes, formatTime, renderTable, truncate } from './output.ts';

export type {
	PipelineJobView,
	PipelineLogLine,
	PipelineRepositoryView,
	PipelineRunSummary,
	PipelineRunView,
	PipelineSecretView,
	PipelineStepView,
	PipelineTriggerView,
	PipelineVariableView,
	PipelineWorkflowIssue,
};

/** Run summaries carry the run's own error (a workflow that failed to start) on the wire. */
export type RunSummary = PipelineRunSummary & { error?: string | null };
export type RunView = PipelineRunView & { error?: string | null };

export interface LogPage {
	lines: PipelineLogLine[];
	next: number;
	complete: boolean;
}

export type RunListQuery = {
	status?: string;
	workflow?: string;
	ref?: string;
	event?: string;
	limit?: number;
};

/** Directory workflow files are read from (mirrors `PIPELINE_WORKFLOW_DIR`). */
export const WORKFLOW_DIR = '.yoal/workflows';

const RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const;
const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out'] as const;

// ---------------------------------------------------------------- API

const DEFAULT_TIMEOUT_MS = 30_000;

/** `/api/v1/repositories` through `ApiClient.raw`, so errors look like every other command's. */
export class PipelinesApi {
	constructor(
		private readonly client: Pick<ApiClient, 'raw' | 'baseUrl'>,
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {}

	get baseUrl(): string {
		return this.client.baseUrl;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		let response: Response;
		try {
			response = await this.client.raw(method, `/api/v1/repositories${path}`, {
				...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
				signal,
			});
		} catch (error) {
			if (signal.aborted)
				throw new CliError(`Request to ${this.client.baseUrl} timed out after ${this.timeoutMs}ms.`, { code: 'timeout', cause: error });
			throw error;
		}
		const text = await response.text();
		if (!text) return null as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new CliError('The platform returned a response that is not JSON.', { code: 'protocol', details: text.slice(0, 500) });
		}
	}

	listRepositories() {
		return this.call<{ repositories: PipelineRepositoryView[] }>('GET', '');
	}
	getRepository(repo: string) {
		return this.call<{ repository: PipelineRepositoryView }>('GET', seg(repo));
	}
	createRepository(input: Record<string, unknown>) {
		return this.call<{ repository: PipelineRepositoryView }>('POST', '', input);
	}
	deleteRepository(repo: string) {
		return this.call<{ ok: boolean }>('DELETE', seg(repo));
	}

	listRuns(repo: string, query: RunListQuery = {}) {
		return this.call<{ runs: RunSummary[] }>('GET', `${seg(repo, 'runs')}${queryString(query)}`);
	}
	getRun(repo: string, run: string) {
		return this.call<{ run: RunView }>('GET', seg(repo, 'runs', run));
	}
	cancelRun(repo: string, run: string) {
		return this.call<{ run: RunView }>('POST', seg(repo, 'runs', run, 'cancel'), {});
	}
	rerun(repo: string, run: string, failedOnly: boolean) {
		return this.call<{ run: RunView }>('POST', seg(repo, 'runs', run, 'rerun'), { failedOnly });
	}
	jobLogs(repo: string, run: string, jobId: string, options: { after?: number; limit?: number } = {}) {
		return this.call<LogPage>('GET', `${seg(repo, 'runs', run, 'jobs', jobId, 'logs')}${queryString(options)}`);
	}

	dispatch(repo: string, input: { workflow?: string; workflowText?: string; ref?: string; inputs: Record<string, string> }) {
		return this.call<{ trigger: PipelineTriggerView }>('POST', seg(repo, 'runs'), input);
	}
	getTrigger(repo: string, id: string) {
		return this.call<{ trigger: PipelineTriggerView }>('GET', seg(repo, 'triggers', id));
	}

	listSecrets(repo: string) {
		return this.call<{ secrets: PipelineSecretView[] }>('GET', seg(repo, 'secrets'));
	}
	setSecret(repo: string, name: string, input: { value: string; environment?: string }) {
		return this.call<{ secret: PipelineSecretView }>('PUT', seg(repo, 'secrets', name), input);
	}
	deleteSecret(repo: string, name: string, environment?: string) {
		return this.call<{ ok: boolean }>('DELETE', `${seg(repo, 'secrets', name)}${queryString({ environment })}`);
	}

	listVariables(repo: string) {
		return this.call<{ variables: PipelineVariableView[] }>('GET', seg(repo, 'variables'));
	}
	setVariable(repo: string, name: string, value: string) {
		return this.call<{ variable: PipelineVariableView }>('PUT', seg(repo, 'variables', name), { value });
	}
	deleteVariable(repo: string, name: string) {
		return this.call<{ ok: boolean }>('DELETE', seg(repo, 'variables', name));
	}
}

function seg(...parts: string[]): string {
	return parts.map((part) => `/${encodeURIComponent(part)}`).join('');
}

function queryString(values: Record<string, string | number | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
	const text = params.toString();
	return text ? `?${text}` : '';
}

// ---------------------------------------------------------------- arguments

/** `-f key=value` pairs → dispatch inputs. Values stay strings; the server coerces them to the declared types. */
export function parseInputs(pairs: string[]): Record<string, string> {
	const inputs: Record<string, string> = {};
	for (const pair of pairs) {
		const equals = pair.indexOf('=');
		if (equals <= 0) throw new UsageError(`-f takes key=value, got "${pair}".`);
		inputs[pair.slice(0, equals)] = pair.slice(equals + 1);
	}
	return inputs;
}

/** `ci.yml` → `.yoal/workflows/ci.yml` (the server stores and filters by full path). */
export function workflowPath(workflow: string): string {
	return workflow.includes('/') ? workflow.replace(/^\.?\//, '') : `${WORKFLOW_DIR}/${workflow}`;
}

/**
 * `--status` accepts a run status (sent to the server) or a conclusion (`failure`, `success`, …),
 * which is asked of the server as `completed` and filtered here.
 */
export function statusFilter(value: string | undefined): { status?: string; conclusion?: PipelineConclusion } {
	if (value === undefined) return {};
	if ((RUN_STATUSES as readonly string[]).includes(value)) return { status: value };
	if (value === 'failed') return { status: 'completed', conclusion: 'failure' };
	if ((CONCLUSIONS as readonly string[]).includes(value)) return { status: 'completed', conclusion: value as PipelineConclusion };
	throw new UsageError(`--status must be one of ${[...RUN_STATUSES, ...CONCLUSIONS].join(', ')}.`);
}

export function parseLimit(value: string | undefined, fallback: number, max = 100): number {
	if (value === undefined) return fallback;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new UsageError(`--limit must be from 1 to ${max}.`);
	return limit;
}

/** Secret and variable names: letters, digits and underscores, not starting with a digit. */
export function assertVariableName(name: string, kind: 'secret' | 'variable'): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		throw new UsageError(`"${name}" is not a valid ${kind} name. Use letters, digits and underscores, not starting with a digit.`);
	if (/^(YOAL|GITHUB)_/i.test(name)) throw new UsageError(`${kind === 'secret' ? 'Secret' : 'Variable'} names starting with YOAL_ or GITHUB_ are reserved.`);
}

// ---------------------------------------------------------------- status

const FAILED: ReadonlySet<string> = new Set(['failure', 'timed_out', 'cancelled']);

export function statusLabel(item: { status: string; conclusion: string | null }): string {
	return item.conclusion ?? item.status.replace('_', ' ');
}

/** One-character marker for plain-text output (no colour). */
export function statusMark(item: { status: string; conclusion: string | null }): string {
	switch (item.conclusion) {
		case 'success':
			return '✓';
		case 'failure':
		case 'timed_out':
			return '✗';
		case 'cancelled':
			return '⊘';
		case 'skipped':
			return '-';
	}
	if (item.status === 'in_progress') return '●';
	if (item.status === 'waiting') return '⏸';
	return '○';
}

export function isFailed(item: { conclusion: string | null }): boolean {
	return item.conclusion !== null && FAILED.has(item.conclusion);
}

/** 0 for a successful run, 1 for anything else that finished. */
export function runExitCode(run: { conclusion: string | null }): number {
	return run.conclusion === 'success' || run.conclusion === 'skipped' ? 0 : 1;
}

/** The job `yoal run logs` shows by default: the first failed one, else the last one. */
export function defaultLogJob(run: PipelineRunView): PipelineJobView | undefined {
	return run.jobs.find((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out') ?? run.jobs.find(isFailed) ?? run.jobs.at(-1);
}

/** `--job` by id, key or display name. Matrix jobs share a key: prefer the failed one, else ask for the id. */
export function selectJob(run: PipelineRunView, selector: string | undefined): PipelineJobView {
	if (run.jobs.length === 0) throw new CliError(`Run #${run.number} has no jobs${run.status === 'completed' ? '' : ' yet'}.`);
	if (selector === undefined) return defaultLogJob(run)!;
	const byId = run.jobs.find((job) => job.id === selector);
	if (byId) return byId;
	const matches = run.jobs.filter((job) => job.key === selector || job.name === selector);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) {
		const failed = matches.filter(isFailed);
		if (failed.length === 1) return failed[0]!;
		throw new UsageError(
			`"${selector}" matches ${matches.length} jobs; pass --job <id>:\n${matches.map((job) => `  ${job.id}  ${job.name}`).join('\n')}`,
		);
	}
	throw new UsageError(`Run #${run.number} has no job "${selector}". Jobs: ${run.jobs.map((job) => job.key).join(', ')}.`);
}

// ---------------------------------------------------------------- formatting

export function shortSha(sha: string): string {
	return sha ? sha.slice(0, 7) : '-';
}

export function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|tags)\//, '');
}

export function duration(startedAt: string | null, finishedAt: string | null, now = Date.now()): string {
	if (!startedAt) return '-';
	const ms = (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt);
	if (!Number.isFinite(ms) || ms < 0) return '-';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function repositoryTable(repositories: PipelineRepositoryView[]): string {
	return renderTable(
		['NAME', 'PROVIDER', 'BRANCH', 'ENABLED', 'LAST RUN', 'URL'],
		repositories.map((repo) => [
			repo.name,
			repo.provider,
			repo.defaultBranch,
			repo.enabled ? 'yes' : 'no',
			repo.lastRun ? `#${repo.lastRun.number} ${statusLabel(repo.lastRun)}` : '-',
			truncate(repo.cloneUrl, 60),
		]),
	);
}

export function repositoryDetails(repo: PipelineRepositoryView, baseUrl: string): string[] {
	return [
		`Name            ${repo.name}`,
		`Clone URL       ${repo.cloneUrl}`,
		`Provider        ${repo.provider}`,
		`Default branch  ${repo.defaultBranch}`,
		`Default image   ${repo.defaultImage ?? '(platform default)'}`,
		`Enabled         ${repo.enabled ? 'yes' : 'no'}`,
		`Webhook         ${baseUrl}${repo.webhookPath}${repo.hasWebhookSecret ? '' : '  (no secret set)'}`,
		`Last run        ${repo.lastRun ? `#${repo.lastRun.number} ${statusLabel(repo.lastRun)} — ${repo.lastRun.title} (${formatTime(repo.lastRun.createdAt)})` : '-'}`,
		`Created         ${formatTime(repo.createdAt)}`,
	];
}

export function runTable(runs: RunSummary[], now = Date.now()): string {
	return renderTable(
		['RUN', 'STATUS', 'WORKFLOW', 'EVENT', 'REF', 'SHA', 'TITLE', 'CREATED', 'DURATION'],
		runs.map((run) => [
			`#${run.number}`,
			`${statusMark(run)} ${statusLabel(run)}`,
			truncate(run.workflowName, 24),
			run.event,
			truncate(shortRef(run.ref), 24),
			shortSha(run.sha),
			truncate(run.title, 40),
			formatTime(run.createdAt),
			duration(run.startedAt, run.finishedAt, now),
		]),
	);
}

function stepLabel(step: PipelineStepView): string {
	return `${step.index + 1}. ${step.name}`;
}

/** `yoal run view`: header, jobs with their steps (the failing step marked), artifacts. */
export function runDetails(run: RunView, now = Date.now()): string[] {
	const out = [
		`Run #${run.number} ${run.workflowName}  ${statusMark(run)} ${statusLabel(run)}${run.attempt > 1 ? `  (attempt ${run.attempt})` : ''}`,
		`  ${run.title}`,
		`  ${run.event} on ${shortRef(run.ref)} @ ${shortSha(run.sha)}${run.actor ? ` by ${run.actor}` : ''}  ·  ${run.workflowPath}`,
		`  created ${formatTime(run.createdAt)}  ·  duration ${duration(run.startedAt, run.finishedAt, now)}${run.trust === 'untrusted' ? '  ·  untrusted (no secrets)' : ''}`,
		`  id ${run.id}`,
	];
	if (run.error) out.push(`  error: ${run.error}`);
	const inputs = Object.entries(run.inputs ?? {});
	if (inputs.length > 0) out.push(`  inputs: ${inputs.map(([key, value]) => `${key}=${String(value)}`).join(' ')}`);
	out.push('');
	if (run.jobs.length === 0) out.push(run.status === 'completed' ? 'No jobs ran.' : 'No jobs yet.');
	for (const job of run.jobs) {
		const where = job.nodeName ? `  on ${job.nodeName}` : job.status === 'queued' ? `  waiting for a runner (${job.runsOn.join(', ') || 'any'})` : '';
		const env = job.environment ? `  env ${job.environment}${job.status === 'waiting' ? ' (awaiting approval)' : ''}` : '';
		out.push(`${statusMark(job)} ${job.name}  ${statusLabel(job)}  ${duration(job.startedAt, job.finishedAt, now)}${where}${env}`);
		const failing = job.steps.find(isFailed);
		for (const step of job.steps) {
			const marker = step === failing ? '>>' : '  ';
			out.push(`  ${marker} ${statusMark(step)} ${stepLabel(step)}  ${step.status === 'pending' ? '' : duration(step.startedAt, step.finishedAt, now)}`.replace(/\s+$/, ''));
		}
		if (job.error) out.push(`     error: ${job.error}`);
	}
	if (run.artifacts.length > 0) {
		out.push('', 'Artifacts:');
		out.push(
			renderTable(
				['NAME', 'SIZE', 'EXPIRES', 'ID'],
				run.artifacts.map((artifact) => [artifact.name, formatBytes(artifact.size), formatTime(artifact.expiresAt), artifact.id]),
			)
				.split('\n')
				.map((line) => `  ${line}`)
				.join('\n'),
		);
	}
	const failedJob = run.jobs.find(isFailed);
	if (failedJob) out.push('', `Logs: yoal run logs ${run.repository} ${run.number} --job ${failedJob.id}`);
	return out;
}

/** What changed between two polls of a run, as lines for `yoal run watch`. `prev` null = first poll. */
export function runTransitions(prev: PipelineRunView | null, next: PipelineRunView): string[] {
	const out: string[] = [];
	const before = new Map((prev?.jobs ?? []).map((job) => [job.id, job]));
	for (const job of next.jobs) {
		const old = before.get(job.id);
		if (!old || old.status !== job.status || old.conclusion !== job.conclusion) {
			// On the first poll, don't announce jobs that are only pending.
			if (old || job.status !== 'pending') {
				const extra = job.status === 'in_progress' && job.nodeName ? ` on ${job.nodeName}` : job.status === 'waiting' ? ` for approval of ${job.environment ?? 'its environment'}` : '';
				out.push(`${statusMark(job)} ${job.name}: ${statusLabel(job)}${extra}`);
			}
		}
		const oldSteps = new Map((old?.steps ?? []).map((step) => [step.index, step]));
		for (const step of job.steps) {
			const was = oldSteps.get(step.index);
			const changed = !was || was.status !== step.status || was.conclusion !== step.conclusion;
			if (!changed || step.status === 'pending') continue;
			// A step that started and finished between polls is reported once, finished.
			out.push(`  ${statusMark(step)} ${job.name} › ${stepLabel(step)}${step.status === 'completed' ? `: ${statusLabel(step)}` : ''}`);
		}
	}
	if (prev && (prev.status !== next.status || prev.conclusion !== next.conclusion) && next.status === 'completed')
		out.push(`Run #${next.number} ${statusLabel(next)} in ${duration(next.startedAt, next.finishedAt)}`);
	return out;
}

/** `[2 Run tests] text` — 1-based step number like the run page; `-1` is job setup/teardown. */
export function logPrefix(job: PipelineJobView, step: number): string {
	if (step < 0) return '[setup]';
	const name = job.steps.find((entry) => entry.index === step)?.name ?? `Step ${step + 1}`;
	return `[${step + 1} ${truncate(name, 40)}]`;
}

export function formatLogLine(job: PipelineJobView, line: PipelineLogLine): string {
	return `${logPrefix(job, line.step)} ${line.text}`;
}

export function secretTable(secrets: PipelineSecretView[]): string {
	return renderTable(
		['NAME', 'ENVIRONMENT', 'UPDATED'],
		secrets.map((secret) => [secret.name, secret.environment ?? '(all)', formatTime(secret.updatedAt)]),
	);
}

export function variableTable(variables: PipelineVariableView[]): string {
	return renderTable(
		['NAME', 'VALUE', 'UPDATED'],
		variables.map((variable) => [variable.name, truncate(variable.value.replace(/\n/g, '\\n'), 60), formatTime(variable.updatedAt)]),
	);
}

export function formatIssues(file: string, issues: PipelineWorkflowIssue[]): string[] {
	return issues.map((issue) => `${file}: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
}

// ---------------------------------------------------------------- lint

export interface LintResult {
	ok: boolean;
	issues: PipelineWorkflowIssue[];
	name?: string;
	jobs?: string[];
}

/**
 * Parse a workflow file locally with the control plane's own parser. Loaded lazily so the rest of
 * the CLI doesn't pay for the parser (and zod) at startup.
 */
export async function lintWorkflow(text: string, path: string): Promise<LintResult> {
	const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
	if (!yaml) throw new CliError('yoal workflow lint needs the Bun runtime (Bun.YAML). Run it with bun, or use the standalone yoal binary.');
	let doc: unknown;
	try {
		doc = yaml.parse(text);
	} catch (error) {
		return { ok: false, issues: [{ path: '', message: `YAML: ${(error as Error).message ?? String(error)}` }] };
	}
	return lintDocument(doc, path);
}

/** Bun's YAML parser, or a clear error on Node (the npm bundle). */
export function bunYaml(command: string): { parse(text: string): unknown } {
	const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
	if (!yaml) throw new CliError(`${command} needs the Bun runtime (Bun.YAML). Run it with bun, or use the standalone yoal binary.`);
	return yaml;
}

/** `lintWorkflow` for an already-parsed YAML document. */
export async function lintDocument(doc: unknown, path: string): Promise<LintResult> {
	const { parseWorkflow, PipelineWorkflowError } = await import('../../../packages/contracts/src/pipeline-workflow.ts');
	try {
		const workflow = parseWorkflow(doc, path);
		return { ok: true, issues: [], name: workflow.name, jobs: Object.keys(workflow.jobs) };
	} catch (error) {
		if (error instanceof PipelineWorkflowError) return { ok: false, issues: error.issues };
		throw error;
	}
}

// ---------------------------------------------------------------- import (.github → .yoal)

export interface ImportNote {
	/** JSON-path-ish location in the source workflow (`jobs.build.steps[3].uses`). */
	path: string;
	/** `changed`: rewritten here; `unsupported`: will not run as written; `note`: works, worth a look. */
	kind: 'changed' | 'unsupported' | 'note';
	message: string;
}

export interface ImportResult {
	workflow: Record<string, unknown>;
	notes: ImportNote[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const SUPPORTED_EVENTS = new Set(['push', 'pull_request', 'workflow_dispatch', 'schedule', 'workflow_call']);
/** Built-in actions and their `actions/*` aliases (mirrors `resolvePipelineAction`). */
const BUILTIN_ACTIONS = new Set([
	'yoal/checkout',
	'yoal/cache',
	'yoal/upload-artifact',
	'yoal/download-artifact',
	'yoal/deploy',
	'yoal/build-image',
	'yoal/image-index',
	'yoal/oidc-token',
	'actions/checkout',
	'actions/cache',
	'actions/upload-artifact',
	'actions/download-artifact',
]);
const IMAGE_ACTIONS: Record<string, string> = {
	'docker/build-push-action': 'use yoal/build-image (BuildKit sidecar, registry/<name> tags, secrets as mounts) instead',
	'docker/setup-buildx-action': 'not needed with yoal/build-image; remove it',
	'docker/setup-qemu-action': 'not needed: build each arch natively (matrix over runs-on [linux, <arch>]) and join them with yoal/image-index',
	'docker/login-action': 'not needed for Yoal\'s registry (jobs log in with their job token); for other registries pass username/password to yoal/build-image',
	'docker/metadata-action': 'compute tags in a run: step and write them to $YOAL_OUTPUT',
};

/** A GitHub-hosted runner label → Yoal labels (`ubuntu-*` → `linux`, `*-arm` adds `arm64`). */
function mapRunnerLabel(label: string): { labels: string[]; unsupported?: string } {
	const lower = label.toLowerCase();
	if (/^ubuntu-.*-arm(64)?$/.test(lower)) return { labels: ['linux', 'arm64'] };
	if (lower.startsWith('ubuntu-')) return { labels: ['linux'] };
	if (lower === 'self-hosted') return { labels: [] };
	if (lower === 'x64' || lower === 'arm64' || lower === 'linux') return { labels: [lower] };
	if (lower.startsWith('macos-') || lower.startsWith('windows-') || lower === 'macos' || lower === 'windows')
		return { labels: [label], unsupported: `${label} runners do not exist on Yoal (jobs run in Linux containers); use the GitHub runner pool for this job` };
	return { labels: [label] };
}

/** A matrix value used as `runs-on` → an arch label (`ubuntu-24.04-arm` → `arm64`, `ubuntu-*` → `x64`). */
function mapMatrixRunner(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const lower = value.toLowerCase();
	if (/^ubuntu-.*-arm(64)?$/.test(lower)) return 'arm64';
	if (lower.startsWith('ubuntu-')) return 'x64';
	return value;
}

function rewriteStrings(value: unknown, rewrite: (text: string) => string): unknown {
	if (typeof value === 'string') return rewrite(value);
	if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, rewrite));
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, rewrite)]));
	return value;
}

/**
 * Convert a `.github/workflows` file into a Yoal workflow (W1): hosted `runs-on` labels become
 * Yoal labels, `permissions` go, `secrets.GITHUB_TOKEN` becomes `secrets.GH_TOKEN`, and every
 * construct that will not carry over (or deserves a look) is listed with its path. The result
 * still goes through the real parser (`lintWorkflow`) afterwards.
 */
export function importGithubWorkflow(source: unknown): ImportResult {
	const notes: ImportNote[] = [];
	const note = (path: string, kind: ImportNote['kind'], message: string) => notes.push({ path, kind, message });
	if (!isObject(source)) throw new CliError('The workflow is not a YAML mapping');

	// github.token / secrets.GITHUB_TOKEN: Yoal has no ambient GitHub token.
	let tokenRewritten = false;
	const doc = rewriteStrings(source, (text) => {
		const next = text.replace(/\bsecrets\.GITHUB_TOKEN\b/g, 'secrets.GH_TOKEN').replace(/\bgithub\.token\b/g, 'secrets.GH_TOKEN');
		if (next !== text) tokenRewritten = true;
		return next;
	}) as Json;
	if (tokenRewritten)
		note('', 'changed', 'secrets.GITHUB_TOKEN / github.token became secrets.GH_TOKEN: Yoal has no ambient GitHub token, so add a GH_TOKEN secret (scoped to an environment if it can write)');

	const out: Json = {};
	for (const [key, value] of Object.entries(doc)) {
		if (key === 'permissions') {
			note('permissions', 'changed', 'Dropped: Yoal job tokens are already scoped to the repository and trust tier (W9/W10)');
			continue;
		}
		if (key === 'on') {
			out.on = convertTriggers(value, note);
			continue;
		}
		if (key === 'jobs' && isObject(value)) {
			out.jobs = Object.fromEntries(Object.entries(value).map(([id, job]) => [id, convertJob(id, job, note)]));
			continue;
		}
		out[key] = value;
	}
	return { workflow: out, notes };
}

function convertTriggers(value: unknown, note: (path: string, kind: ImportNote['kind'], message: string) => void): unknown {
	const entries: Array<[string, unknown]> =
		typeof value === 'string' ? [[value, null]] : Array.isArray(value) ? value.map((event) => [String(event), null]) : isObject(value) ? Object.entries(value) : [];
	const kept: Json = {};
	for (const [event, config] of entries) {
		if (SUPPORTED_EVENTS.has(event)) {
			kept[event] = config;
			continue;
		}
		const hint =
			event === 'pull_request_target'
				? 'use pull_request: runs from forks are untrusted (no secrets) on Yoal'
				: event === 'release' || event === 'create'
					? 'use push with tags: filters'
					: 'Yoal triggers are push, pull_request, workflow_dispatch, schedule, workflow_call and yoal_event';
		note(`on.${event}`, 'unsupported', `Dropped the ${event} trigger: ${hint}`);
	}
	if (!Object.keys(kept).length) {
		note('on', 'changed', 'No supported trigger was left; added workflow_dispatch so the workflow can still be run by hand');
		kept.workflow_dispatch = null;
	}
	return typeof value === 'string' && Object.keys(kept).length === 1 && kept[value] === null ? value : kept;
}

function convertJob(id: string, raw: unknown, note: (path: string, kind: ImportNote['kind'], message: string) => void): unknown {
	if (!isObject(raw)) return raw;
	const base = `jobs.${id}`;
	const job: Json = {};
	const runnerKeys = new Set<string>();
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'permissions') {
			note(`${base}.permissions`, 'changed', 'Dropped: job tokens are scoped by Yoal, not by GitHub permissions');
			continue;
		}
		if (key === 'runs-on') {
			job[key] = convertRunsOn(value, `${base}.runs-on`, note, runnerKeys);
			continue;
		}
		if (key === 'uses' && typeof value === 'string') {
			if (value.startsWith('./.github/workflows/')) {
				job.uses = value.replace('./.github/workflows/', './.yoal/workflows/');
				note(`${base}.uses`, 'changed', `Reusable workflow now read from ${job.uses}; import that file too`);
			} else {
				job.uses = value;
				note(`${base}.uses`, 'unsupported', 'Reusable workflows from other repositories are not supported; copy it into .yoal/workflows');
			}
			continue;
		}
		if (key === 'steps' && Array.isArray(value)) {
			job.steps = value.map((step, index) => convertStep(step, `${base}.steps[${index}]`, note));
			continue;
		}
		if (key === 'environment') note(`${base}.environment`, 'note', 'Create this environment on the repository (allowed refs, approvers, secrets): yoal repo / dashboard → Environments');
		if (key === 'services' && isObject(value))
			for (const name of Object.keys(value)) note(`${base}.services.${name}`, 'note', `Services run on a per-job network: reach them by their service name (${name}:<port>), not localhost or a mapped port`);
		job[key] = value;
	}
	// `runs-on: ${{ matrix.runner }}` with hosted labels as values → arch labels in the matrix.
	if (runnerKeys.size && isObject(job.strategy) && isObject(job.strategy.matrix)) {
		const matrix = { ...job.strategy.matrix };
		let changed = false;
		for (const key of runnerKeys) {
			if (Array.isArray(matrix[key])) {
				const mapped = (matrix[key] as unknown[]).map(mapMatrixRunner);
				changed ||= JSON.stringify(mapped) !== JSON.stringify(matrix[key]);
				matrix[key] = mapped;
			}
			if (Array.isArray(matrix.include))
				matrix.include = (matrix.include as unknown[]).map((entry) => {
					if (!isObject(entry) || !(key in entry)) return entry;
					const mapped = mapMatrixRunner(entry[key]);
					changed ||= mapped !== entry[key];
					return { ...entry, [key]: mapped };
				});
		}
		if (changed) {
			job.strategy = { ...job.strategy, matrix };
			note(`${base}.strategy.matrix`, 'changed', `Hosted runner names in matrix.${[...runnerKeys].join('/matrix.')} became arch labels (x64, arm64)`);
		}
	}
	return job;
}

function convertRunsOn(value: unknown, path: string, note: (path: string, kind: ImportNote['kind'], message: string) => void, runnerKeys: Set<string>): unknown {
	const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.map(String) : isObject(value) && Array.isArray(value.labels) ? value.labels.map(String) : null;
	if (!list) return value;
	if (isObject(value) && value.group !== undefined) note(`${path}.group`, 'changed', 'Dropped: Yoal places jobs by labels only');
	const labels: string[] = [];
	let expression = false;
	for (const label of list) {
		const matrixKey = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(label.trim())?.[1];
		if (label.includes('${{')) {
			expression = true;
			if (matrixKey) runnerKeys.add(matrixKey);
			labels.push(label);
			continue;
		}
		const mapped = mapRunnerLabel(label);
		if (mapped.unsupported) note(path, 'unsupported', mapped.unsupported);
		for (const entry of mapped.labels) if (!labels.includes(entry)) labels.push(entry);
	}
	if (expression && !labels.includes('linux')) labels.unshift('linux');
	if (!labels.length) labels.push('linux');
	const result = labels.length === 1 ? labels[0]! : labels;
	if (JSON.stringify(result) !== JSON.stringify(value)) note(path, 'changed', `runs-on ${JSON.stringify(value)} → ${JSON.stringify(result)} (Yoal node labels: linux, x64/arm64, oci-build, …)`);
	return result;
}

function convertStep(raw: unknown, path: string, note: (path: string, kind: ImportNote['kind'], message: string) => void): unknown {
	if (!isObject(raw)) return raw;
	const uses = typeof raw.uses === 'string' ? raw.uses.trim() : null;
	if (uses) {
		const name = uses.split('@')[0]!.toLowerCase();
		const ref = uses.includes('@') ? uses.slice(uses.indexOf('@') + 1) : '';
		if (uses.startsWith('docker://')) note(`${path}.uses`, 'unsupported', `Docker-container actions (${uses}) do not run on Yoal; use a run: step with the tool, or container: on the job`);
		else if (BUILTIN_ACTIONS.has(name)) {
			if (name === 'actions/checkout' && isObject(raw.with) && (raw.with.path || raw.with.repository))
				note(`${path}.with`, 'note', 'yoal/checkout only checks out this repository into the workspace root; path/repository are not supported');
		} else if (IMAGE_ACTIONS[name]) note(`${path}.uses`, 'unsupported', `${uses}: ${IMAGE_ACTIONS[name]}`);
		else if (uses.startsWith('./')) note(`${path}.uses`, 'note', 'Local action: composite and JavaScript actions run on Yoal; Docker actions do not');
		else
			note(
				`${path}.uses`,
				'note',
				`${uses} is fetched and run as a composite or JavaScript action (Docker actions do not run)${/^[0-9a-f]{40}$/.test(ref) ? '' : '; pin it to a full commit SHA'}`,
			);
	}
	const shell = typeof raw.shell === 'string' ? raw.shell.trim().toLowerCase() : '';
	if (['pwsh', 'powershell', 'cmd'].includes(shell)) note(`${path}.shell`, 'unsupported', `shell: ${shell} is not available in Linux job containers`);
	return raw;
}

// ---------------------------------------------------------------- YAML out

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i;

function yamlScalar(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	const text = String(value);
	if (text === '') return "''";
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return JSON.stringify(text);
	const plain =
		/^[A-Za-z0-9_./$(][^\n]*$/.test(text) &&
		!/: |:$| #|^\$\{\{|[{}[\],&*!|>'"%@`]/.test(text.replace(/\$\{\{[^}]*\}\}/g, 'x')) &&
		!text.startsWith('${{') &&
		!YAML_RESERVED.test(text) &&
		!/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text) &&
		!/^0[xo]/i.test(text) &&
		text.trim() === text;
	return plain ? text : `'${text.replace(/'/g, "''")}'`;
}

function yamlKey(key: string): string {
	return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) && !YAML_RESERVED.test(key.replace(/^on$/, 'x')) ? key : yamlScalar(key);
}

function yamlBlock(text: string, indent: string): string {
	const chomp = text.endsWith('\n\n') ? '+' : text.endsWith('\n') ? '' : '-';
	const body = text.endsWith('\n') ? text.replace(/\n$/, '') : text;
	const indicator = /^\s/.test(body) ? '2' : '';
	return `|${indicator}${chomp}\n${body
		.split('\n')
		.map((line) => (line ? `${indent}${line}` : ''))
		.join('\n')}`;
}

/** A small, readable YAML emitter (block style, `|` for multi-line strings) for imported workflows. */
export function toYaml(value: unknown, depth = 0): string {
	const indent = '  '.repeat(depth);
	const inline = (item: unknown, nextDepth: number): string | null => {
		if (typeof item === 'string' && item.includes('\n')) return ` ${yamlBlock(item, '  '.repeat(nextDepth))}`;
		if (Array.isArray(item)) return item.length ? null : ' []';
		if (isObject(item)) return Object.keys(item).length ? null : ' {}';
		if (item === null || item === undefined) return '';
		return ` ${yamlScalar(item)}`;
	};
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				const simple = inline(item, depth + 1);
				if (simple !== null) return `${indent}-${simple || ' null'}`;
				const nested = toYaml(item, depth + 1).replace(/^\s+/, '');
				return `${indent}- ${nested}`;
			})
			.join('\n');
	}
	if (isObject(value)) {
		return Object.entries(value)
			.map(([key, item]) => {
				const simple = inline(item, depth + 1);
				if (simple !== null) return `${indent}${yamlKey(key)}:${simple}`;
				return `${indent}${yamlKey(key)}:\n${toYaml(item, depth + 1)}`;
			})
			.join('\n');
	}
	return `${indent}${yamlScalar(value)}`;
}

export function formatImportNotes(file: string, notes: ImportNote[]): string[] {
	return notes.map((entry) => `${file}: ${entry.path ? `${entry.path}: ` : ''}[${entry.kind}] ${entry.message}`);
}
