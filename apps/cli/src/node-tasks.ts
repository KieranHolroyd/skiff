/**
 * Node tasks (D124): one-shot tools the control plane asks a broker's or function's node to run
 * (peek a queue, send a test message, invoke a function). The wire types the CLI reads mirror
 * `packages/contracts/src/node-task.ts`; the CLI bundle stays free of runtime dependencies (D40), so
 * keep them in sync. The server validates every input.
 */

/** Mirrors the limits in `nodeTaskLimits` that the CLI checks before asking. */
export const NODE_TASK_LIMITS = {
	peekMessages: 50,
	sendCount: 100,
	maxDelaySeconds: 43_200,
	redriveMessages: 1_000,
	/** How long the CLI keeps polling a task before giving up (the task itself keeps going). */
	cliWaitMs: 120_000,
} as const;

/** Mirrors `functionRequestMethods`. */
export const FUNCTION_REQUEST_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Mirrors `BROKER_QUEUE_STREAM_PREFIX`: a function queue `jobs` lives in stream `SKIFF_Q_jobs` (D112). */
export const QUEUE_STREAM_PREFIX = 'SKIFF_Q_';

/** Mirrors `QUEUE_HEADERS` in @skiff/function-bindings. */
export const QUEUE_HEADERS = {
	id: 'Nats-Msg-Id',
	contentType: 'Skiff-Content-Type',
	notBefore: 'Skiff-Not-Before',
	timestamp: 'Skiff-Timestamp',
	attempts: 'Skiff-Attempts',
} as const;

export type NodeTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface NodeTaskView<R = unknown> {
	id: string;
	kind: string;
	status: NodeTaskStatus;
	target: { type: 'broker' | 'workload'; name: string; nodeId: string };
	input: unknown;
	result: R | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface NodeTaskStreamState {
	stream: string;
	messages: number;
	bytes: number;
	firstAt: string | null;
	lastAt: string | null;
}

export interface PeekedMessage {
	seq: number;
	subject: string;
	time: string | null;
	size: number;
	headers: Record<string, string>;
	encoding: 'utf8' | 'base64';
	body: string;
	truncated: boolean;
}

export interface BrokerQueueCreateResult {
	stream: string;
	created: boolean;
	state: NodeTaskStreamState | null;
}

export interface BrokerQueueSendInput {
	body: string;
	contentType?: 'json' | 'text';
	delaySeconds?: number;
	count?: number;
}

export interface BrokerQueueSendResult {
	stream: string;
	sent: number;
	seqs: number[];
	durationMs: number;
	state: NodeTaskStreamState | null;
}

export interface BrokerQueueRedriveResult {
	moved: number;
	remaining: number;
	state: NodeTaskStreamState | null;
	source: NodeTaskStreamState | null;
}

export interface BrokerStreamPeekResult {
	stream: string;
	messages: PeekedMessage[];
	total: number;
	firstSeq: number;
	lastSeq: number;
	nextSeq: number | null;
}

export interface BrokerStreamPurgeResult {
	stream: string;
	purged: number;
	state: NodeTaskStreamState | null;
}

export interface BrokerStreamDeleteResult {
	stream: string;
	deleted: boolean;
}

export interface BrokerStreamDeleteMessageResult {
	stream: string;
	seq: number;
	deleted: boolean;
	state: NodeTaskStreamState | null;
}

export interface FunctionInvokeInput {
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface FunctionInvokeResult {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	encoding: 'utf8' | 'base64';
	body: string;
	size: number;
	truncated: boolean;
	durationMs: number;
	coldStart: boolean;
}

export interface FunctionScheduledResult {
	status: number;
	error: string | null;
	durationMs: number;
	coldStart: boolean;
}

/** Finished one way or the other. */
export function nodeTaskDone(task: { status: NodeTaskStatus }): boolean {
	return task.status === 'succeeded' || task.status === 'failed';
}
