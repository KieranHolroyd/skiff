import { UsageError } from './errors.ts';
import { formatTime, renderTable, truncate } from './output.ts';

/**
 * Jobs (plan 09): view types mirrored from `@yoal/contracts` (job.ts) and the CLI's formatting.
 * The server validates every field; these only shape output and catch obvious typos early.
 */

export type JobRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'skipped';
export const JOB_CONCURRENCY = ['forbid', 'allow', 'replace'] as const;

export interface JobRunView {
	id: string;
	jobId: string | null;
	jobName: string | null;
	trigger: 'schedule' | 'manual' | 'retry';
	attempt: number;
	status: JobRunStatus;
	command: string[];
	timeoutSeconds: number;
	deploymentId: string | null;
	nodeId: string | null;
	exitCode: number | null;
	error: string | null;
	createdBy: string | null;
	createdAt: string;
	runAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
	cancelRequested: boolean;
}

export interface JobView {
	id: string;
	projectSlug: string;
	name: string;
	command: string[];
	schedule: string | null;
	timeoutSeconds: number;
	concurrency: (typeof JOB_CONCURRENCY)[number];
	maxRetries: number;
	enabled: boolean;
	nextRunAt: string | null;
	lastRun: JobRunView | null;
	createdAt: string;
	updatedAt: string;
}

export interface JobLogEvent {
	seq: number;
	ts: number;
	stream: string;
	level: string;
	message: string;
}

export interface JobLogPage {
	events: JobLogEvent[];
	cursor: number;
	hasMore: boolean;
}

export function jobRunDone(status: JobRunStatus): boolean {
	return status !== 'queued' && status !== 'running';
}

/**
 * Split `<flags and positionals> -- <command…>`. Everything after the first `--` is the argv,
 * passed to the server exactly as the shell split it.
 */
export function splitCommand(argv: string[]): { before: string[]; command: string[] | null } {
	const index = argv.indexOf('--');
	if (index < 0) return { before: argv, command: null };
	return { before: argv.slice(0, index), command: argv.slice(index + 1) };
}

/** `90`, `90s`, `15m`, `2h` → seconds. */
export function parseDuration(value: string, flag: string): number {
	const match = /^(\d+)\s*(s|m|h)?$/i.exec(value.trim());
	if (!match) throw new UsageError(`${flag} takes seconds or a duration like 90s, 15m or 2h (got "${value}").`);
	const amount = Number(match[1]);
	const unit = (match[2] ?? 's').toLowerCase();
	return amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

export function parseConcurrency(value: string): (typeof JOB_CONCURRENCY)[number] {
	if ((JOB_CONCURRENCY as readonly string[]).includes(value)) return value as (typeof JOB_CONCURRENCY)[number];
	throw new UsageError(`--concurrency must be one of ${JOB_CONCURRENCY.join(', ')}.`);
}

export function parseRetries(value: string): number {
	const retries = Number(value);
	if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new UsageError('--retries must be a whole number from 0 to 10.');
	return retries;
}

/** Quote an argument for display only when the shell would need it. */
export function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(command: string[]): string {
	return command.map(shellQuote).join(' ');
}

export function formatDuration(ms: number | null): string {
	if (ms === null) return '-';
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

export function runOutcome(run: JobRunView): string {
	if (run.status === 'failed' && run.exitCode !== null) return `failed (exit ${run.exitCode})`;
	if (run.cancelRequested && !jobRunDone(run.status)) return `${run.status} (cancelling)`;
	return run.status;
}

export function jobTable(jobs: JobView[]): string {
	return renderTable(
		['NAME', 'SCHEDULE (UTC)', 'NEXT RUN', 'LAST RUN', 'COMMAND'],
		jobs.map((job) => [
			job.enabled ? job.name : `${job.name} (paused)`,
			job.schedule ?? 'manual',
			job.nextRunAt ? formatTime(job.nextRunAt) : '-',
			job.lastRun ? `${runOutcome(job.lastRun)} ${formatTime(job.lastRun.createdAt)}` : '-',
			truncate(formatCommand(job.command), 60),
		]),
	);
}

export function runTable(runs: JobRunView[]): string {
	return renderTable(
		['RUN', 'JOB', 'TRIGGER', 'STATUS', 'STARTED', 'DURATION'],
		runs.map((run) => [
			run.id,
			run.jobName ?? '(one-off)',
			run.attempt > 1 ? `${run.trigger} #${run.attempt}` : run.trigger,
			runOutcome(run),
			formatTime(run.startedAt ?? run.createdAt),
			formatDuration(run.durationMs),
		]),
	);
}

export function jobDetails(job: JobView): string[] {
	return [
		`Job          ${job.name}${job.enabled ? '' : ' (paused)'}`,
		`Project      ${job.projectSlug}`,
		`Command      ${formatCommand(job.command)}`,
		`Schedule     ${job.schedule ? `${job.schedule} (UTC)` : 'manual only'}`,
		`Next run     ${job.nextRunAt ? formatTime(job.nextRunAt) : '-'}`,
		`Timeout      ${job.timeoutSeconds}s`,
		`Concurrency  ${job.concurrency}`,
		`Retries      ${job.maxRetries}`,
		`Last run     ${job.lastRun ? `${job.lastRun.id} ${runOutcome(job.lastRun)}` : '-'}`,
	];
}

/** One line for stderr after a run: outcome, duration, error. */
export function runSummary(run: JobRunView): string {
	const parts = [`Run ${run.id} ${runOutcome(run)}`];
	if (run.durationMs !== null) parts.push(`in ${formatDuration(run.durationMs)}`);
	const line = parts.join(' ');
	return run.error && run.status !== 'succeeded' ? `${line}: ${run.error}` : line;
}

/**
 * What `yoal run` and `yoal jobs run` exit with: the command's own status when it ran, 124 for a
 * timeout (as timeout(1)), 130 for a cancel, 1 otherwise.
 */
export function runExitCode(run: JobRunView): number {
	if (run.status === 'succeeded') return 0;
	if (run.status === 'timeout') return 124;
	if (run.status === 'cancelled') return 130;
	if (run.status === 'failed' && run.exitCode !== null && run.exitCode > 0) return Math.min(run.exitCode, 255);
	return 1;
}
