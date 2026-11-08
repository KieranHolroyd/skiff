/**
 * Flows: durable, resumable multi-step work on the control plane (docs/FLOWS.md, D167).
 *
 * A flow run is the server-side record of one long-running change (a database move, a replica
 * promotion, a restore). Every step transition is written to SQLite before the next one starts,
 * so a restart resumes a run where it stopped, and every path ends in a terminal status.
 *
 * Surfaces read runs through the async-operation contract shared with mass operations:
 * `GET /api/v1/operations/<flw_…>?wait=<s>`, `POST …/cancel`, `GET …/stream`, and the MCP
 * `get_task` / `get_operation` tools.
 */

export const flowStatuses = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;
export type FlowStatus = (typeof flowStatuses)[number];

export const terminalFlowStatuses: readonly FlowStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isTerminalFlow = (status: string): boolean => (terminalFlowStatuses as readonly string[]).includes(status);

/** Every id a flow run gets starts with this, so one async-operation route can dispatch by id. */
export const FLOW_ID_PREFIX = 'flw_';
export const isFlowId = (id: string): boolean => id.startsWith(FLOW_ID_PREFIX);

/** What happened at one point of a run; the step log is append-only. */
export const flowStepEvents = [
	'started',
	'next',
	'wait',
	'signal',
	'timeout',
	'retry',
	'resumed',
	'cancel-requested',
	'cancel-refused',
	'succeeded',
	'failed',
	'cancelled',
] as const;
export type FlowStepEvent = (typeof flowStepEvents)[number];

export interface FlowStepLogEntry {
	seq: number;
	step: string;
	attempt: number;
	event: FlowStepEvent;
	detail: string | null;
	at: string;
}

export interface FlowRunView {
	id: string;
	/** The flow definition, e.g. `database.move`. */
	kind: string;
	/** Human title of the definition ("Database move"). */
	title: string;
	status: FlowStatus;
	/** The step the run is in (or ended in). */
	step: string;
	/** The resource the run changes, for linking from its page. */
	subject: { kind: string; id: string } | null;
	/** The signal a waiting run expects, e.g. `backup-result`. */
	waitingFor: string | null;
	/** When a waiting run gives up on its signal. */
	waitDeadline: string | null;
	/** Failed attempts of the current step (handler errors, lost leases). */
	attempt: number;
	/** Latest human-readable progress line. */
	detail: string | null;
	error: string | null;
	result: unknown;
	/** A cancel was asked for and has not been handled yet. */
	cancelRequested: boolean;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	/** Only when asked for (`?steps=1`): the append-only step log, oldest first. */
	steps?: FlowStepLogEntry[];
}

/** The status an MCP task reports for a flow run (`get_task`). */
export function flowTaskStatus(status: FlowStatus): 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' {
	if (status === 'waiting' || status === 'running') return 'running';
	return status;
}

export const flowLimits = {
	/** Finished runs, their step logs and signals are kept this long. */
	retentionDays: 30,
	/** A handler that has not returned by then is presumed dead; the run is resumed. */
	leaseMs: 5 * 60_000,
	/** Transitions one drive may make on a run before it yields to others. */
	maxHopsPerDrive: 50,
	/** Default retries when a step handler throws. */
	maxAttempts: 5,
	retryBaseMs: 5_000,
	retryCapMs: 10 * 60_000,
	/** Longest `?wait=` a surface may hold a request open for. */
	maxWaitMs: 25_000,
} as const;
