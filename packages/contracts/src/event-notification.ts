import { z } from 'zod';

/**
 * Event notifications (docs/EVENTS.md, D122): platform events published into a function queue.
 *
 * Cloudflare's model, as with R2 event notifications: a rule watches one source and publishes a
 * message to a queue on a managed broker; a function consumes that queue with the ordinary queue
 * trigger and handles it in `queue()`. Skiff never calls a function directly for an event, so
 * delivery gets the queue's ack, retry and dead-letter behaviour for free.
 */

export const eventSources = [
	'storage',
	'alerts',
	'deployments',
	'database-backups',
	'registry',
	// Managed user pools (IAM.md I26–I28, §11.2): a pool's own end-user activity.
	'pools'
] as const;
export type EventSource = (typeof eventSources)[number];

/** Event types per source. The message `type` is `<source>.<event>` (`storage` keeps R2's body). */
export const eventTypesBySource = {
	storage: ['object-create', 'object-delete'],
	alerts: ['firing', 'resolved'],
	deployments: ['created', 'promoted', 'failed'],
	'database-backups': ['completed', 'failed'],
	// The platform registry (docs/REGISTRY.md): an image pushed to one of the org's repositories.
	registry: ['push'],
	// Pool events carry pool and user metadata, never a password, session token or client secret.
	pools: ['user.created', 'user.signed_in', 'user.deleted', 'mfa.enabled']
} as const satisfies Record<EventSource, readonly string[]>;
export type EventType<S extends EventSource = EventSource> = (typeof eventTypesBySource)[S][number];

/** Same rule as the queue binding (`packages/function-bindings/src/nats.js`). */
export const eventQueueNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const resourceName = z.string().trim().min(1).max(64);
const keyFilter = z.string().max(1024);

export const eventRuleCreateSchema = z
	.object({
		source: z.enum(eventSources),
		/** Empty means every event the source has. */
		events: z.array(z.string().min(1).max(32)).max(8).default([]),
		/** `storage`: the instance and bucket to watch (both required). */
		storage: resourceName.optional(),
		bucket: resourceName.optional(),
		/** `storage`: only keys with this prefix / suffix, as on R2 (`uploads/`, `.jpg`). */
		prefix: keyFilter.optional(),
		suffix: keyFilter.optional(),
		/** `deployments`: one project (slug); absent means every project in the org. */
		project: resourceName.optional(),
		/** `database-backups`: one database (name); absent means every database. */
		database: resourceName.optional(),
		/** `alerts`: one rule (id); absent means every rule. */
		alertRule: resourceName.optional(),
		/** `registry`: one repository (`<org>/<name>`); absent means every repository of the org. */
		repository: z.string().trim().min(3).max(255).optional(),
		/** `pools`: one pool (name); absent means every pool in the org. */
		pool: resourceName.optional(),
		/** The managed broker (name) and queue the message is published to. */
		broker: resourceName,
		queue: z.string().regex(eventQueueNamePattern, 'Queue names are lower-case letters, digits and dashes (max 63).'),
		description: z.string().trim().max(200).optional(),
		enabled: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		const known: readonly string[] = eventTypesBySource[input.source];
		for (const [index, event] of input.events.entries())
			if (!known.includes(event))
				ctx.addIssue({
					code: 'custom',
					path: ['events', index],
					message: `"${event}" is not a ${input.source} event (use ${known.join(', ')}).`,
				});
		const only = (field: 'storage' | 'bucket' | 'prefix' | 'suffix' | 'project' | 'database' | 'alertRule' | 'repository' | 'pool', source: EventSource) => {
			if (input[field] !== undefined && input.source !== source)
				ctx.addIssue({ code: 'custom', path: [field], message: `\`${field}\` only applies to ${source} rules.` });
		};
		for (const field of ['storage', 'bucket', 'prefix', 'suffix'] as const) only(field, 'storage');
		only('project', 'deployments');
		only('database', 'database-backups');
		only('alertRule', 'alerts');
		only('repository', 'registry');
		only('pool', 'pools');
		if (input.source === 'storage') {
			if (!input.storage) ctx.addIssue({ code: 'custom', path: ['storage'], message: 'Name the storage instance to watch.' });
			if (!input.bucket) ctx.addIssue({ code: 'custom', path: ['bucket'], message: 'Name the bucket to watch.' });
		}
	});
export type EventRuleCreate = z.input<typeof eventRuleCreateSchema>;

/** What can change after create. The source, its target resource and the broker are fixed. */
export const eventRuleUpdateSchema = z
	.object({
		events: z.array(z.string().min(1).max(32)).max(8).optional(),
		prefix: keyFilter.nullable().optional(),
		suffix: keyFilter.nullable().optional(),
		queue: z.string().regex(eventQueueNamePattern).optional(),
		description: z.string().trim().max(200).nullable().optional(),
		enabled: z.boolean().optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, 'Nothing to update.');
export type EventRuleUpdate = z.input<typeof eventRuleUpdateSchema>;

export const eventRuleFilterSchema = z.object({
	storage: z.string().optional(),
	bucket: z.string().optional(),
	prefix: z.string().optional(),
	suffix: z.string().optional(),
	project: z.string().optional(),
	database: z.string().optional(),
	alertRule: z.string().optional(),
	repository: z.string().optional(),
	pool: z.string().optional(),
});
export type EventRuleFilter = z.infer<typeof eventRuleFilterSchema>;

export const eventDeliveryStatuses = ['pending', 'delivered', 'failed'] as const;
export type EventDeliveryStatus = (typeof eventDeliveryStatuses)[number];

export const eventRuleViewSchema = z.object({
	id: z.string(),
	source: z.enum(eventSources),
	/** Resolved: every event the rule matches (the source's full list when created empty). */
	events: z.array(z.string()),
	filter: eventRuleFilterSchema,
	broker: z.string(),
	queue: z.string(),
	description: z.string().nullable(),
	enabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** Last 24 hours, plus everything still waiting. */
	deliveries: z.object({ pending: z.number().int(), delivered: z.number().int(), failed: z.number().int() }),
	lastDeliveredAt: z.string().nullable(),
	lastError: z.string().nullable(),
});
export type EventRuleView = z.infer<typeof eventRuleViewSchema>;

export const eventDeliveryViewSchema = z.object({
	id: z.string(),
	ruleId: z.string(),
	type: z.string(),
	status: z.enum(eventDeliveryStatuses),
	attempts: z.number().int(),
	createdAt: z.string(),
	deliveredAt: z.string().nullable(),
	lastError: z.string().nullable(),
	body: z.unknown(),
});
export type EventDeliveryView = z.infer<typeof eventDeliveryViewSchema>;

// ------------------------------------------------------------------ message bodies

/**
 * A storage event, in Cloudflare's R2 event-notification shape so an R2 consumer runs unchanged.
 * `skiff` carries what R2 has no field for.
 */
export interface StorageEventBody {
	account: string;
	action: 'PutObject' | 'CopyObject' | 'CompleteMultipartUpload' | 'DeleteObject';
	bucket: string;
	object: { key: string; size?: number; eTag?: string };
	eventTime: string;
	skiff: { type: `storage.${EventType<'storage'>}`; storage: string; eventName: string };
}

/** Every other source: one envelope, typed by `type`. */
export interface PlatformEventBody<T extends string = string, D = Record<string, unknown>> {
	/** `alerts.firing`, `deployments.created`, … */
	type: T;
	id: string;
	time: string;
	account: string;
	data: D;
}

// ------------------------------------------------------------------ agent protocol

/** Pending deliveries for brokers on the calling node, leased for `leaseSeconds`. */
export const agentEventLeaseSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			brokerId: z.string(),
			queue: z.string(),
			body: z.unknown(),
		}),
	),
	leaseSeconds: z.number().int().positive(),
});
export type AgentEventLease = z.infer<typeof agentEventLeaseSchema>;

export const agentEventAckSchema = z.object({
	results: z
		.array(z.object({ id: z.string().min(1).max(64), ok: z.boolean(), error: z.string().max(500).optional() }))
		.max(500),
});
export type AgentEventAck = z.infer<typeof agentEventAckSchema>;

/** The RustFS webhook target id: env `RUSTFS_NOTIFY_WEBHOOK_*_SKIFF`, ARN `…:skiff:webhook`. */
export const STORAGE_NOTIFY_TARGET = 'skiff';
/** RustFS's default region; it appears in the target ARN (spiked on 1.0.4, D122). */
export const STORAGE_NOTIFY_ARN = 'arn:rustfs:sqs:us-east-1:skiff:webhook';
