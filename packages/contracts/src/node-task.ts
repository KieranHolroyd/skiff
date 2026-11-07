import * as z from 'zod';
import { functionQueueNameSchema } from './function.ts';

/**
 * Node tasks (D124): one-shot reads and test actions that only the node running a service can do.
 *
 * Brokers and function hosts listen on node loopback, so the control plane cannot reach them
 * (D83, D112). A dashboard "peek this queue" or "run this cron now" is not desired state either:
 * it has a result, it happens once, and replaying it after an agent restart would be wrong. So the
 * control plane queues a task row, the target node's agent leases it over the agent protocol (the
 * event-outbox pattern, D122), runs one of a fixed set of verbs and posts the result back. Callers
 * wait for the result for a few seconds and otherwise poll `GET /api/v1/node-tasks/:id`.
 *
 * There is no generic verb: every kind below is a typed request with its own limits.
 */

/** The agent capability that says a build leases node tasks. Older agents never pick them up. */
export const NODE_TASKS_CAPABILITY = 'node-tasks';

export const nodeTaskLimits = {
	/** How long a leased task is the agent's before it counts as lost. */
	leaseSeconds: 90,
	/** A task nobody leased within this long fails as "node did not pick it up". */
	pickupMs: 60_000,
	/** How long the REST/dashboard call waits for a result before answering 202. */
	waitMs: 20_000,
	/** Finished tasks are kept this long (their results can hold message bodies). */
	retentionMs: 60 * 60_000,
	/** Messages a peek returns at most. */
	peekMessages: 50,
	/** Bytes of each peeked message body returned; the rest is cut. */
	peekBodyBytes: 16 * 1024,
	/** Copies one test send may publish (a quick load test). */
	sendCount: 100,
	/** Message body bytes, as the queue stream's own cap (D112). */
	messageBytes: 128 * 1024,
	/** Messages one redrive moves at most. */
	redriveMessages: 1_000,
	/** Request body bytes for a test request to a function. */
	requestBodyBytes: 1024 * 1024,
	/** Response body bytes returned from a test request; the rest is cut. */
	responseBodyBytes: 256 * 1024,
	/** Pending tasks per org; more are refused (a runaway script, not a person). */
	pendingPerOrg: 50,
} as const;

/** JetStream stream names: no whitespace, `.`, `*`, `>`, path separators or control characters. */
export const jetStreamNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[^\s.*>/\\\u0000-\u001f]+$/, 'Stream names cannot contain spaces, dots, wildcards or slashes.');

const headerMapSchema = z
	.record(z.string().min(1).max(256), z.string().max(8192))
	.refine((value) => Object.keys(value).length <= 50, 'At most 50 headers.');

export const queueMessageContentTypes = ['json', 'text'] as const;
export type QueueMessageContentType = (typeof queueMessageContentTypes)[number];

// ------------------------------------------------------------------ inputs (what callers send)

export const brokerQueueCreateInputSchema = z.object({ queue: functionQueueNameSchema });
export type BrokerQueueCreateInput = z.infer<typeof brokerQueueCreateInputSchema>;

export const brokerQueueSendInputSchema = z
	.object({
		queue: functionQueueNameSchema,
		/** The message body as the consumer's `message.body` sees it: JSON text for `json`. */
		body: z.string().max(nodeTaskLimits.messageBytes),
		contentType: z.enum(queueMessageContentTypes).default('json'),
		/** Held back this long before the consumer sees it (Cloudflare's `delaySeconds`). */
		delaySeconds: z.number().int().min(0).max(43_200).optional(),
		/** Publish this many copies, for a quick load test. */
		count: z.number().int().min(1).max(nodeTaskLimits.sendCount).default(1),
	})
	.superRefine((value, ctx) => {
		if (value.contentType !== 'json') return;
		try {
			JSON.parse(value.body);
		} catch {
			ctx.addIssue({ code: 'custom', path: ['body'], message: 'The body is not valid JSON. Send it as text instead, or fix the JSON.' });
		}
	});
export type BrokerQueueSendInput = z.input<typeof brokerQueueSendInputSchema>;

export const brokerStreamPeekInputSchema = z.object({
	stream: jetStreamNameSchema,
	limit: z.number().int().min(1).max(nodeTaskLimits.peekMessages).default(20),
	/** First sequence to read from; omitted means the oldest message held. */
	fromSeq: z.number().int().positive().optional(),
});
export type BrokerStreamPeekInput = z.input<typeof brokerStreamPeekInputSchema>;

export const brokerStreamTargetSchema = z.object({ stream: jetStreamNameSchema });
export const brokerStreamMessageTargetSchema = z.object({ stream: jetStreamNameSchema, seq: z.number().int().positive() });

export const brokerQueueRedriveInputSchema = z
	.object({
		/** The dead-letter queue to drain. */
		from: functionQueueNameSchema,
		/** The queue that receives the messages (usually the one that dead-lettered them). */
		to: functionQueueNameSchema,
		limit: z.number().int().min(1).max(nodeTaskLimits.redriveMessages).default(nodeTaskLimits.redriveMessages),
	})
	.refine((value) => value.from !== value.to, { path: ['to'], message: 'Pick a different queue to move the messages to.' });
export type BrokerQueueRedriveInput = z.input<typeof brokerQueueRedriveInputSchema>;

export const functionRequestMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const functionInvokeInputSchema = z
	.object({
		method: z.enum(functionRequestMethods).default('GET'),
		/** Path and query, e.g. `/api/users?limit=5`. */
		path: z
			.string()
			.max(4096)
			.default('/')
			.refine((value) => value.startsWith('/'), 'The path starts with /.')
			.refine((value) => !/^\/__skiff(\/|$)/i.test(value.split('?')[0] ?? ''), 'Paths under /__skiff/ are internal to Skiff.'),
		headers: headerMapSchema.default({}),
		body: z.string().max(nodeTaskLimits.requestBodyBytes).optional(),
	})
	.refine((value) => value.body === undefined || (value.method !== 'GET' && value.method !== 'HEAD'), {
		path: ['body'],
		message: 'GET and HEAD requests have no body.',
	});
export type FunctionInvokeInput = z.input<typeof functionInvokeInputSchema>;

export const functionScheduledInputSchema = z.object({
	/** One of the function's `triggers.crons`; the handler sees it as `controller.cron`. */
	cron: z.string().min(1).max(120),
});
export type FunctionScheduledInput = z.infer<typeof functionScheduledInputSchema>;

// ------------------------------------------------------------------ what the agent receives

export const nodeTaskKinds = [
	'broker.queue.create',
	'broker.queue.send',
	'broker.queue.redrive',
	'broker.stream.peek',
	'broker.stream.purge',
	'broker.stream.delete',
	'broker.stream.deleteMessage',
	'function.invoke',
	'function.scheduled',
] as const;
export type NodeTaskKind = (typeof nodeTaskKinds)[number];

/** Which kind of service a task runs against. */
export function nodeTaskTargetType(kind: NodeTaskKind): 'broker' | 'workload' {
	return kind.startsWith('broker.') ? 'broker' : 'workload';
}

/** Tasks that change data. The listing on the dashboard is refreshed from their result. */
export const mutatingNodeTaskKinds: readonly NodeTaskKind[] = [
	'broker.queue.create',
	'broker.queue.send',
	'broker.queue.redrive',
	'broker.stream.purge',
	'broker.stream.delete',
	'broker.stream.deleteMessage',
];

export const nodeTaskSpecSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('broker.queue.create'), input: brokerQueueCreateInputSchema }),
	z.object({
		kind: z.literal('broker.queue.send'),
		// Re-validated on the node; the refine above already ran in the control plane.
		input: z.object({
			queue: functionQueueNameSchema,
			body: z.string().max(nodeTaskLimits.messageBytes),
			contentType: z.enum(queueMessageContentTypes),
			delaySeconds: z.number().int().min(0).max(43_200).optional(),
			count: z.number().int().min(1).max(nodeTaskLimits.sendCount),
		}),
	}),
	z.object({
		kind: z.literal('broker.queue.redrive'),
		input: z.object({ from: functionQueueNameSchema, to: functionQueueNameSchema, limit: z.number().int().min(1).max(nodeTaskLimits.redriveMessages) }),
	}),
	z.object({
		kind: z.literal('broker.stream.peek'),
		input: z.object({ stream: jetStreamNameSchema, limit: z.number().int().min(1).max(nodeTaskLimits.peekMessages), fromSeq: z.number().int().positive().optional() }),
	}),
	z.object({ kind: z.literal('broker.stream.purge'), input: brokerStreamTargetSchema }),
	z.object({ kind: z.literal('broker.stream.delete'), input: brokerStreamTargetSchema }),
	z.object({ kind: z.literal('broker.stream.deleteMessage'), input: brokerStreamMessageTargetSchema }),
	z.object({
		kind: z.literal('function.invoke'),
		input: z.object({
			method: z.enum(functionRequestMethods),
			path: z.string().max(4096),
			headers: z.record(z.string(), z.string()),
			body: z.string().max(nodeTaskLimits.requestBodyBytes).optional(),
		}),
	}),
	z.object({ kind: z.literal('function.scheduled'), input: functionScheduledInputSchema }),
]);
export type NodeTaskSpec = z.infer<typeof nodeTaskSpecSchema>;

export const agentNodeTaskSchema = z.intersection(
	z.object({
		id: z.string(),
		/** Broker id, or the desired-state workload id of the function host (replica 0). */
		targetId: z.string(),
	}),
	nodeTaskSpecSchema,
);
export type AgentNodeTask = z.infer<typeof agentNodeTaskSchema>;

export const agentNodeTaskLeaseSchema = z.object({
	tasks: z.array(agentNodeTaskSchema).max(20),
	leaseSeconds: z.number().int().positive(),
});
export type AgentNodeTaskLease = z.infer<typeof agentNodeTaskLeaseSchema>;

// ------------------------------------------------------------------ results

/** The newest facts about one stream after a change, so the listing does not wait a minute. */
export const nodeTaskStreamStateSchema = z.object({
	stream: z.string().max(256),
	messages: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	firstAt: z.string().nullable(),
	lastAt: z.string().nullable(),
});
export type NodeTaskStreamState = z.infer<typeof nodeTaskStreamStateSchema>;

export const peekedMessageSchema = z.object({
	seq: z.number().int().nonnegative(),
	subject: z.string().max(512),
	time: z.string().nullable(),
	size: z.number().int().nonnegative(),
	headers: z.record(z.string(), z.string()),
	/** `utf8` when the bytes decode as UTF-8, else `base64`. */
	encoding: z.enum(['utf8', 'base64']),
	body: z.string(),
	truncated: z.boolean(),
});
export type PeekedMessage = z.infer<typeof peekedMessageSchema>;

export const brokerQueueCreateResultSchema = z.object({ stream: z.string(), created: z.boolean(), state: nodeTaskStreamStateSchema.nullable().default(null) });
export const brokerQueueSendResultSchema = z.object({
	stream: z.string(),
	sent: z.number().int().nonnegative(),
	/** Stream sequence of each stored copy. */
	seqs: z.array(z.number().int().nonnegative()).max(nodeTaskLimits.sendCount),
	durationMs: z.number().nonnegative(),
	state: nodeTaskStreamStateSchema.nullable().default(null),
});
export const brokerQueueRedriveResultSchema = z.object({
	moved: z.number().int().nonnegative(),
	/** Messages still in the dead-letter queue (more than `limit`, or newer than the run). */
	remaining: z.number().int().nonnegative(),
	state: nodeTaskStreamStateSchema.nullable().default(null),
	source: nodeTaskStreamStateSchema.nullable().default(null),
});
export const brokerStreamPeekResultSchema = z.object({
	stream: z.string(),
	messages: z.array(peekedMessageSchema).max(nodeTaskLimits.peekMessages),
	total: z.number().int().nonnegative(),
	firstSeq: z.number().int().nonnegative(),
	lastSeq: z.number().int().nonnegative(),
	/** Where to continue from; null at the end of the stream. */
	nextSeq: z.number().int().positive().nullable(),
});
export const brokerStreamPurgeResultSchema = z.object({ stream: z.string(), purged: z.number().int().nonnegative(), state: nodeTaskStreamStateSchema.nullable().default(null) });
export const brokerStreamDeleteResultSchema = z.object({ stream: z.string(), deleted: z.boolean() });
export const brokerStreamDeleteMessageResultSchema = z.object({ stream: z.string(), seq: z.number().int(), deleted: z.boolean(), state: nodeTaskStreamStateSchema.nullable().default(null) });
export const functionInvokeResultSchema = z.object({
	status: z.number().int(),
	statusText: z.string().max(200),
	headers: z.array(z.tuple([z.string(), z.string()])).max(200),
	encoding: z.enum(['utf8', 'base64']),
	body: z.string(),
	size: z.number().int().nonnegative(),
	truncated: z.boolean(),
	durationMs: z.number().nonnegative(),
	/** True when the host was idle-stopped and this request started it. */
	coldStart: z.boolean(),
});
export const functionScheduledResultSchema = z.object({
	status: z.number().int(),
	/** The handler's error, or the shim's reason (e.g. no `scheduled` handler). */
	error: z.string().max(2000).nullable(),
	durationMs: z.number().nonnegative(),
	coldStart: z.boolean(),
});

export type BrokerQueueCreateResult = z.infer<typeof brokerQueueCreateResultSchema>;
export type BrokerQueueSendResult = z.infer<typeof brokerQueueSendResultSchema>;
export type BrokerQueueRedriveResult = z.infer<typeof brokerQueueRedriveResultSchema>;
export type BrokerStreamPeekResult = z.infer<typeof brokerStreamPeekResultSchema>;
export type BrokerStreamPurgeResult = z.infer<typeof brokerStreamPurgeResultSchema>;
export type BrokerStreamDeleteResult = z.infer<typeof brokerStreamDeleteResultSchema>;
export type BrokerStreamDeleteMessageResult = z.infer<typeof brokerStreamDeleteMessageResultSchema>;
export type FunctionInvokeResult = z.infer<typeof functionInvokeResultSchema>;
export type FunctionScheduledResult = z.infer<typeof functionScheduledResultSchema>;

export const nodeTaskResultSchemas = {
	'broker.queue.create': brokerQueueCreateResultSchema,
	'broker.queue.send': brokerQueueSendResultSchema,
	'broker.queue.redrive': brokerQueueRedriveResultSchema,
	'broker.stream.peek': brokerStreamPeekResultSchema,
	'broker.stream.purge': brokerStreamPurgeResultSchema,
	'broker.stream.delete': brokerStreamDeleteResultSchema,
	'broker.stream.deleteMessage': brokerStreamDeleteMessageResultSchema,
	'function.invoke': functionInvokeResultSchema,
	'function.scheduled': functionScheduledResultSchema,
} as const satisfies Record<NodeTaskKind, z.ZodType>;

export interface NodeTaskResultMap {
	'broker.queue.create': BrokerQueueCreateResult;
	'broker.queue.send': BrokerQueueSendResult;
	'broker.queue.redrive': BrokerQueueRedriveResult;
	'broker.stream.peek': BrokerStreamPeekResult;
	'broker.stream.purge': BrokerStreamPurgeResult;
	'broker.stream.delete': BrokerStreamDeleteResult;
	'broker.stream.deleteMessage': BrokerStreamDeleteMessageResult;
	'function.invoke': FunctionInvokeResult;
	'function.scheduled': FunctionScheduledResult;
}

export const agentNodeTaskResultSchema = z.object({
	results: z
		.array(
			z.object({
				id: z.string(),
				ok: z.boolean(),
				result: z.unknown().optional(),
				error: z.string().max(2000).optional(),
			}),
		)
		.max(20),
});
export type AgentNodeTaskResult = z.infer<typeof agentNodeTaskResultSchema>;

// ------------------------------------------------------------------ the caller's view

export const nodeTaskStatuses = ['pending', 'running', 'succeeded', 'failed'] as const;
export type NodeTaskStatus = (typeof nodeTaskStatuses)[number];

export const nodeTaskViewSchema = z.object({
	id: z.string(),
	kind: z.enum(nodeTaskKinds),
	status: z.enum(nodeTaskStatuses),
	target: z.object({
		type: z.enum(['broker', 'workload']),
		/** Broker name, or the function project's slug. */
		name: z.string(),
		nodeId: z.string(),
	}),
	input: z.unknown(),
	result: z.unknown().nullable(),
	error: z.string().nullable(),
	createdAt: z.string(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
});
export type NodeTaskView<K extends NodeTaskKind = NodeTaskKind> = Omit<z.infer<typeof nodeTaskViewSchema>, 'kind' | 'result'> & {
	kind: K;
	result: NodeTaskResultMap[K] | null;
};

/** Finished one way or the other. */
export function nodeTaskDone(task: { status: NodeTaskStatus }): boolean {
	return task.status === 'succeeded' || task.status === 'failed';
}
