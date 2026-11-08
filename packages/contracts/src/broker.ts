import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import type { VolumeSummary } from './volume.ts';

/**
 * Managed queue brokers (docs/BROKERS.md, D111).
 *
 * A broker is an org resource like a managed database: one message-broker server run as a
 * tier-3 container on one node, with the same lockdown (official image as a fixed uid, read-only
 * root, no capabilities, loopback-only port, org network alias). It is its own resource with its
 * own table, permissions and surfaces, because a broker has none of a database's data-layer verbs
 * (backups, studio, upgrade planner) and gains its own (streams, consumers) over time.
 *
 * Engines are registry data, as for databases (D95): NATS (with JetStream) ships first; RabbitMQ
 * is the next entry. Adding an engine is a registry change plus a helper profile, never a
 * migration (`brokers.engine` is unconstrained).
 */

export const brokerEngines = ['nats'] as const;
export type BrokerEngine = (typeof brokerEngines)[number];

/** What an engine supports; the service refuses and surfaces hide what an engine lacks. */
export interface BrokerEngineCapabilities {
	/** Durable, replayable streams (NATS JetStream, RabbitMQ streams). */
	streams: boolean;
	/** Competing-consumer work queues with acknowledgements. */
	workQueues: boolean;
	/** A built-in key-value store (NATS KV on JetStream). */
	keyValue: boolean;
	/** Request/reply over the core protocol. */
	requestReply: boolean;
}

export interface BrokerEngineInfo {
	engine: BrokerEngine;
	label: string;
	/** Newest first; a smaller index is newer. */
	versions: readonly string[];
	defaultVersion: string;
	/** Client port inside the container. */
	containerPort: number;
	/** URL scheme the attachment env uses. */
	scheme: string;
	/** Wire protocol, for the dashboard and docs. */
	protocol: string;
	/** Env prefix an attachment gets by default (`NATS` → `NATS_URL`). */
	defaultEnvPrefix: string;
	minMemoryMb: number;
	defaultMemoryMb: number;
	/** `forward`: a newer listed version may replace the running one in place. */
	inPlaceUpgrade: 'forward' | 'never';
	capabilities: BrokerEngineCapabilities;
}

export const brokerEngineRegistry: Record<BrokerEngine, BrokerEngineInfo> = {
	nats: {
		engine: 'nats',
		label: 'NATS',
		versions: ['2.12', '2.11'],
		defaultVersion: '2.12',
		containerPort: 4222,
		scheme: 'nats',
		protocol: 'NATS (JetStream on)',
		defaultEnvPrefix: 'NATS',
		minMemoryMb: 64,
		defaultMemoryMb: 256,
		inPlaceUpgrade: 'forward',
		capabilities: { streams: true, workQueues: true, keyValue: true, requestReply: true },
	},
};

/** Broker ids double as workload ids on the node; the helper reserves this prefix. */
export const BROKER_ID_PREFIX = 'mq_';

/** Per-node host ports for brokers, disjoint from databases (15432–17431) and storage (19000–19999). */
export const BROKER_PORT_MIN = 14222;
export const BROKER_PORT_MAX = 14721;

export const brokerStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type BrokerStatus = (typeof brokerStatuses)[number];

export const brokerNameSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Prefix for injected env vars: `NATS` → `NATS_URL`, `NATS_HOST`, … */
export const brokerEnvPrefixSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes must be UPPER_SNAKE_CASE')
	.refine((prefix) => !prefix.endsWith('_'), 'Env prefixes must not end with "_"');

export const brokerCreateSchema = z
	.object({
		name: brokerNameSchema,
		engine: z.enum(brokerEngines).default('nats'),
		version: z.string().max(16).optional(),
		/** `auto`, `edge`, or a node id. Resolved once at create time (D41). */
		placement: z.string().min(1).max(64).default('auto'),
		memoryMb: z.number().int().min(64).max(16_384).optional(),
		cpus: z.number().positive().max(8).default(0.5),
		/** Persistent message storage (JetStream file store) in MB; also the engine's own cap. */
		storageMb: z.number().int().min(256).max(1_048_576).default(2_048),
		/** Pin one node volume for the data dir (advanced; bypasses storage pools, D74). */
		volume: z.string().min(3).max(40).optional(),
		/** Storage pool (or `system`) for the data dir; omitted uses the default from Settings → Storage (docs/STORAGE.md). */
		pool: z.string().trim().min(2).max(40).optional(),
		/** Attach to this project right away (placement then follows the project's workload node). */
		project: z.string().min(1).max(64).optional(),
		envPrefix: brokerEnvPrefixSchema.optional(),
	})
	.superRefine((input, ctx) => {
		const info = brokerEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({
				code: 'custom',
				path: ['version'],
				message: `${info.label} versions: ${info.versions.join(', ')}.`,
			});
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({
				code: 'custom',
				path: ['memoryMb'],
				message: `${info.label} needs at least ${info.minMemoryMb} MB.`,
			});
	});
export type BrokerCreate = z.input<typeof brokerCreateSchema>;

export const brokerUpdateSchema = z.object({
	memoryMb: z.number().int().min(64).max(16_384).optional(),
	cpus: z.number().positive().max(8).optional(),
	storageMb: z.number().int().min(256).max(1_048_576).optional(),
	/** A newer listed version of the same engine; downgrades are refused. */
	version: z.string().max(16).optional(),
});
export type BrokerUpdate = z.input<typeof brokerUpdateSchema>;

export const brokerAttachSchema = z.object({
	broker: brokerNameSchema,
	/** Defaults to the engine's prefix (`NATS`). */
	envPrefix: brokerEnvPrefixSchema.optional(),
});
export type BrokerAttach = z.input<typeof brokerAttachSchema>;

export interface BrokerAttachmentView {
	brokerId: string;
	brokerName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	envNames: string[];
	createdAt: string;
}

export interface BrokerView {
	id: string;
	name: string;
	engine: BrokerEngine;
	engineLabel: string;
	protocol: string;
	capabilities: BrokerEngineCapabilities;
	version: string;
	/** Newer versions this broker can move to in place. */
	upgradeVersions: string[];
	status: BrokerStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	username: string;
	/** Where attached apps reach it: process apps on loopback, containers by network alias. */
	internalHost: { process: string; container: string };
	volume: VolumeSummary | null;
	attachments: BrokerAttachmentView[];
	/** From the newest sample the node reported (D123); null before the first one. */
	storeBytes: number | null;
	messages: number | null;
	statsAt: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

/** Revealed by an audited, interactive-only call (`broker:credentials`, as D58). */
export interface BrokerCredentials {
	brokerId: string;
	name: string;
	username: string;
	password: string;
	url: string;
	host: string;
	port: number;
	/** Copy-paste client snippets keyed by tool (`nats-cli`, `nats.js`, `nats.go`, …). */
	connectionSnippets: Record<string, string>;
	note: string;
}

/** The `broker` profile on a workload sent to the helper: engine + version only (as D61). */
export const workloadBrokerSchema = z.object({
	engine: z.enum(brokerEngines),
	version: z.string().min(1).max(16),
	/** Persistent store cap in MB; the helper writes it into the engine's own config. */
	storageMb: z.number().int().min(256).max(1_048_576),
});
export type WorkloadBroker = z.infer<typeof workloadBrokerSchema>;

/** The image the helper runs for a broker (the vendor's official image). */
export function brokerImage(engine: BrokerEngine, version: string): string {
	switch (engine) {
		case 'nats':
			return `docker.io/library/nats:${version}-alpine`;
	}
}

/** `mq-<hex>`: the DNS alias on the workload's org network; the helper derives the same. */
export function brokerAlias(id: string): string {
	return `mq-${id.replace(/^mq_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** The broker's single client user: `my-queue` → `my_queue`. */
export function brokerIdentifier(name: string): string {
	return name.replace(/-/g, '_');
}

/** Env var names a project receives for one attachment. */
export function brokerEnvNames(prefix: string): string[] {
	return ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD'].map((suffix) => `${prefix}_${suffix}`);
}

export function brokerConnectionUrl(input: {
	scheme: string;
	user: string;
	pass: string;
	host: string;
	port: number;
}): string {
	return `${input.scheme}://${encodeURIComponent(input.user)}:${encodeURIComponent(input.pass)}@${input.host}:${input.port}`;
}

/** Client snippets for the credentials dialog; the URL already carries the user and password. */
export function brokerConnectionSnippets(engine: BrokerEngine, url: string): Record<string, string> {
	switch (engine) {
		case 'nats':
			return {
				'nats-cli': `nats --server '${url}' stream ls`,
				'nats.js': `import { connect } from '@nats-io/transport-node';\nconst nc = await connect({ servers: process.env.NATS_URL });`,
				'nats.go': `nc, err := nats.Connect(os.Getenv("NATS_URL"))\njs, err := jetstream.New(nc)`,
				'nats.py': `import nats, os\nnc = await nats.connect(os.environ["NATS_URL"])\njs = nc.jetstream()`,
			};
	}
}

/** Newer listed versions a broker may move to in place (none when the engine forbids it). */
export function brokerUpgradeVersions(engine: BrokerEngine, current: string): string[] {
	const info = brokerEngineRegistry[engine];
	if (info.inPlaceUpgrade === 'never') return [];
	const index = info.versions.indexOf(current);
	return index <= 0 ? [] : info.versions.slice(0, index);
}

// ---------------------------------------------------------------- metrics (D123)

/**
 * One broker's 1-minute sample, taken by the node agent over the broker's own client connection
 * (JetStream `$JS.API.INFO`, `STREAM.LIST`, `CONSUMER.LIST` and the account's
 * `$SYS.REQ.ACCOUNT.PING.STATZ`; docs/BROKERS.md §7). `bucket` is the time bucket, as in every
 * telemetry schema. Gauges describe the broker at the sample; the `*In`/`*Out`/`published`/
 * `slowConsumers` fields are deltas over the minute before it.
 */
export const brokerMetricBucketSchema = z.object({
	brokerId: z.string().max(100),
	bucket: z.string(),
	up: z.boolean(),
	/** Client connections, not counting the sampler's own. */
	connections: z.number().int().nonnegative().default(0),
	streams: z.number().int().nonnegative().default(0),
	consumers: z.number().int().nonnegative().default(0),
	/** JetStream file store in use, bytes (capped by the broker's store budget). */
	storeBytes: z.number().int().nonnegative().default(0),
	/** The broker's file store budget, bytes (`storageMb`), so ClickHouse can compute utilization. */
	storeLimitBytes: z.number().int().nonnegative().default(0),
	/** JetStream memory store in use, bytes. */
	memoryStoreBytes: z.number().int().nonnegative().default(0),
	/** Messages held across streams. */
	messages: z.number().int().nonnegative().default(0),
	/** Messages not yet delivered to a consumer, summed over consumers. */
	pending: z.number().int().nonnegative().default(0),
	/** Delivered but not acknowledged yet. */
	ackPending: z.number().int().nonnegative().default(0),
	/** Messages delivered more than once and still unacknowledged. */
	redelivered: z.number().int().nonnegative().default(0),
	/** Age of the oldest message held in any stream, seconds (0 when every stream is empty). */
	oldestAgeSeconds: z.number().nonnegative().default(0),
	/** Messages stored by JetStream in the minute. */
	published: z.number().int().nonnegative().default(0),
	/** Core NATS messages and bytes clients sent to / received from the server in the minute. */
	messagesIn: z.number().int().nonnegative().default(0),
	messagesOut: z.number().int().nonnegative().default(0),
	bytesIn: z.number().int().nonnegative().default(0),
	bytesOut: z.number().int().nonnegative().default(0),
	/** Clients the server cut off for not keeping up, in the minute. */
	slowConsumers: z.number().int().nonnegative().default(0),
	/** Container memory use, bytes. */
	memoryBytes: z.number().int().nonnegative().default(0),
});
export type BrokerMetricBucket = z.infer<typeof brokerMetricBucketSchema>;

/** Stream prefix of a function queue (D112): `SKIFF_Q_<queue>`. */
export const BROKER_QUEUE_STREAM_PREFIX = 'SKIFF_Q_';

/** At most this many streams, and consumers per stream, are reported per broker. */
export const BROKER_SNAPSHOT_MAX_STREAMS = 200;
export const BROKER_SNAPSHOT_MAX_CONSUMERS = 20;

export const brokerConsumerStatsSchema = z.object({
	name: z.string().max(256),
	pending: z.number().int().nonnegative(),
	ackPending: z.number().int().nonnegative(),
	redelivered: z.number().int().nonnegative(),
	/** Pull requests waiting for messages (a live consumer keeps at least one open). */
	waiting: z.number().int().nonnegative(),
	/** Last delivery to this consumer, when the server reports it. */
	lastDeliveredAt: z.string().nullable().default(null),
});
export type BrokerConsumerStats = z.infer<typeof brokerConsumerStatsSchema>;

/** One JetStream stream as the dashboard lists it. Function queues carry their queue name. */
export const brokerStreamStatsSchema = z.object({
	stream: z.string().max(256),
	/** The function queue (`SKIFF_Q_<queue>`), or null for a stream an app created itself. */
	queue: z.string().max(63).nullable(),
	subjects: z.array(z.string().max(256)).max(10).default([]),
	storage: z.enum(['file', 'memory']).default('file'),
	retention: z.string().max(32).default('limits'),
	messages: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	/** The stream's own byte cap, when it has one. */
	maxBytes: z.number().int().nonnegative().nullable().default(null),
	/** Publish time of the oldest / newest message held (null when empty). */
	firstAt: z.string().nullable().default(null),
	lastAt: z.string().nullable().default(null),
	consumerCount: z.number().int().nonnegative(),
	pending: z.number().int().nonnegative(),
	ackPending: z.number().int().nonnegative(),
	redelivered: z.number().int().nonnegative(),
	consumers: z.array(brokerConsumerStatsSchema).max(BROKER_SNAPSHOT_MAX_CONSUMERS).default([]),
});
export type BrokerStreamStats = z.infer<typeof brokerStreamStatsSchema>;

/** Newest stream listing for one broker (only the latest is kept, in SQLite). */
export const brokerQueueSnapshotSchema = z.object({
	brokerId: z.string().max(100),
	at: z.string(),
	/** True when the broker has more streams than `BROKER_SNAPSHOT_MAX_STREAMS`. */
	truncated: z.boolean().default(false),
	streams: z.array(brokerStreamStatsSchema).max(BROKER_SNAPSHOT_MAX_STREAMS),
});
export type BrokerQueueSnapshot = z.infer<typeof brokerQueueSnapshotSchema>;

/** Point returned by `GET /brokers/:name/metrics` (hourly points average gauges, sum deltas). */
export interface BrokerMetricPoint {
	bucket: string;
	up: number;
	connections: number;
	streams: number;
	consumers: number;
	storeBytes: number;
	storeLimitBytes: number;
	memoryStoreBytes: number;
	messages: number;
	pending: number;
	ackPending: number;
	redelivered: number;
	oldestAgeSeconds: number;
	published: number;
	messagesIn: number;
	messagesOut: number;
	bytesIn: number;
	bytesOut: number;
	slowConsumers: number;
	memoryBytes: number;
}

/** `GET /brokers/:name/queues`: the newest listing the broker's node reported. */
export interface BrokerQueuesView {
	brokerId: string;
	name: string;
	/** When the node took the listing; null before the first sample. */
	at: string | null;
	truncated: boolean;
	streams: BrokerStreamStats[];
}
