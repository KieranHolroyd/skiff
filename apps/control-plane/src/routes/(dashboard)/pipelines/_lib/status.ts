import type { PipelineConclusion, PipelineRunSummary } from '@skiff/contracts';

/**
 * One vocabulary for run, job and step state. A completed item shows its conclusion; anything
 * else shows its status.
 */
export type PipelineState =
	| 'pending'
	| 'queued'
	| 'waiting'
	| 'in_progress'
	| 'success'
	| 'failure'
	| 'timed_out'
	| 'cancelled'
	| 'skipped'
	| 'completed';

export function pipelineState(status: string, conclusion: PipelineConclusion | null | undefined): PipelineState {
	if (status === 'completed') return conclusion ?? 'completed';
	return status as PipelineState;
}

export const STATE_LABEL: Record<PipelineState, string> = {
	pending: 'Pending',
	queued: 'Queued',
	waiting: 'Waiting',
	in_progress: 'In progress',
	success: 'Success',
	failure: 'Failed',
	timed_out: 'Timed out',
	cancelled: 'Cancelled',
	skipped: 'Skipped',
	completed: 'Completed'
};

export const STATE_TEXT: Record<PipelineState, string> = {
	pending: 'text-muted-foreground',
	queued: 'text-muted-foreground',
	waiting: 'text-warning',
	in_progress: 'text-info',
	success: 'text-success',
	failure: 'text-destructive',
	timed_out: 'text-destructive',
	cancelled: 'text-muted-foreground',
	skipped: 'text-muted-foreground',
	completed: 'text-muted-foreground'
};

export const STATE_BADGE: Record<PipelineState, 'neutral' | 'warning' | 'info' | 'success' | 'danger'> = {
	pending: 'neutral',
	queued: 'neutral',
	waiting: 'warning',
	in_progress: 'info',
	success: 'success',
	failure: 'danger',
	timed_out: 'danger',
	cancelled: 'neutral',
	skipped: 'neutral',
	completed: 'neutral'
};

export function isActive(item: { status: string }): boolean {
	return item.status !== 'completed';
}

export function anyActive(runs: Array<{ status: string }>): boolean {
	return runs.some(isActive);
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`, `refs/pull/7/merge` → `#7`. */
export function shortRef(ref: string): string {
	const pull = /^refs\/pull\/(\d+)\//.exec(ref);
	if (pull) return `#${pull[1]}`;
	return ref.replace(/^refs\/(heads|tags)\//, '');
}

export const EVENT_LABEL: Record<string, string> = {
	push: 'push',
	pull_request: 'pull request',
	workflow_dispatch: 'manual',
	schedule: 'schedule'
};

/** Elapsed time between two instants (or until now), compact: `42s`, `3m 12s`, `1h 4m`. */
export function elapsed(start: string | null, end: string | null, now = Date.now()): string {
	if (!start) return '—';
	const from = new Date(start).getTime();
	const to = end ? new Date(end).getTime() : now;
	const seconds = Math.max(0, Math.round((to - from) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function runDuration(run: Pick<PipelineRunSummary, 'startedAt' | 'finishedAt'>, now?: number): string {
	return elapsed(run.startedAt, run.finishedAt, now);
}
