import {
	BROKER_QUEUE_STREAM_PREFIX,
	BROKER_SNAPSHOT_MAX_CONSUMERS,
	BROKER_SNAPSHOT_MAX_STREAMS,
	brokerMetricBucketSchema,
	brokerQueueSnapshotSchema,
	type BrokerConsumerStats,
	type BrokerMetricBucket,
	type BrokerQueueSnapshot,
	type BrokerStreamStats,
	type WorkloadActivation,
	type WorkloadStatus,
} from '@skiff/contracts';
import { NatsConnection, jsApi } from '../../../packages/function-bindings/src/nats.js';
import type { BrokerConnector } from './function-queues.ts';
import { connectTcp } from './tcp-stream.ts';

/**
 * Managed broker sampler (docs/BROKERS.md §7, D123). Once a minute per broker on this node it
 * reads, over the broker's own authenticated client connection:
 *
 * - `$JS.API.INFO`: JetStream store use, stream and consumer counts;
 * - `$JS.API.STREAM.LIST` and `CONSUMER.LIST.<stream>`: per-stream messages, bytes and consumer
 *   backlog (pending, awaiting ack, redelivered);
 * - `$SYS.REQ.ACCOUNT.PING.STATZ`: the account's connections, messages and bytes in and out, and
 *   slow consumers. NATS exports it to every account, so no system user or monitor port is needed.
 *
 * Nothing new listens on the node: the HTTP monitor port would be unauthenticated on loopback,
 * where other tenants' process apps could read `/connz`. The sample and the newest stream listing
 * ride the telemetry batch, like object storage (S7).
 */

export const BROKER_STATS_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 5_000;
const MAX_SNAPSHOTS = 200;
/** STREAM.LIST pages of 256; totals cover at most this many pages. */
const MAX_STREAM_PAGES = 4;
const REQUEST_TIMEOUT_MS = 5_000;
const MIB = 1024 * 1024;

export interface BrokerStatsTarget {
	id: string;
	activationVersion: string;
	/** The loopback host port the helper published. */
	port: number;
	status: WorkloadStatus;
	memoryBytes?: number;
	/** The JetStream file store budget, MB. */
	storageMb: number;
}

export interface BrokerTargetSource {
	brokerTargets(): BrokerStatsTarget[];
}

export interface BrokerTelemetryPayload {
	brokers: BrokerMetricBucket[];
	brokerQueues: BrokerQueueSnapshot[];
}

export type BrokerStatsLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface BrokerStatsSamplerOptions {
	source: BrokerTargetSource;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	connect?: BrokerConnector;
	now?: () => number;
	log?: BrokerStatsLog;
	maxBuckets?: number;
	maxSnapshots?: number;
	timeoutMs?: number;
}

/** Cumulative account counters from STATZ, kept to turn the next reading into a delta. */
export interface AccountCounters {
	messagesIn: number;
	messagesOut: number;
	bytesIn: number;
	bytesOut: number;
	slowConsumers: number;
}

export interface PreviousReading {
	at: number;
	counters: AccountCounters | null;
	lastSeq: Map<string, number>;
}

interface Handle {
	activationVersion: string;
	connection: NatsConnection;
}

/** One stream as STREAM.LIST returns it, with its consumers when it has any. */
export interface StreamReading {
	name: string;
	subjects: string[];
	storage: string;
	retention: string;
	maxBytes: number;
	created: number;
	messages: number;
	bytes: number;
	firstSeq: number;
	lastSeq: number;
	firstTs: number | null;
	lastTs: number | null;
	consumerCount: number;
	consumers: ConsumerReading[];
}

export interface ConsumerReading {
	name: string;
	pending: number;
	ackPending: number;
	redelivered: number;
	waiting: number;
	lastActive: number | null;
}

/** Everything one round of API calls returned for a broker. */
export interface BrokerReading {
	storeBytes: number;
	memoryStoreBytes: number;
	streamCount: number;
	consumerCount: number;
	streams: StreamReading[];
	/** The listing stopped before the broker's last stream. */
	truncated: boolean;
	/** Null when STATZ is unavailable (an older server); connections and rates then read 0. */
	account: (AccountCounters & { connections: number }) | null;
	/** Requests this round made, so the next delta can leave them out. */
	requests: number;
}

export class BrokerStatsSampler {
	private readonly source: BrokerTargetSource;
	private readonly fetchActivation: BrokerStatsSamplerOptions['fetchActivation'];
	private readonly connect: BrokerConnector;
	private readonly now: () => number;
	private readonly log: BrokerStatsLog;
	private readonly maxBuckets: number;
	private readonly maxSnapshots: number;
	private readonly timeoutMs: number;

	private readonly handles = new Map<string, Handle>();
	private readonly previous = new Map<string, PreviousReading>();
	private buckets: BrokerMetricBucket[] = [];
	private snapshots: BrokerQueueSnapshot[] = [];
	private sampling = false;
	private totalDropped = 0;

	constructor(options: BrokerStatsSamplerOptions) {
		this.source = options.source;
		this.fetchActivation = options.fetchActivation;
		this.connect =
			options.connect ??
			(async (target) =>
				NatsConnection.connect(await connectTcp(target.host, target.port), {
					user: target.user,
					pass: target.pass,
					name: target.name,
				}));
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
		this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	get dropped(): number {
		return this.totalDropped;
	}

	pending(): BrokerTelemetryPayload {
		return { brokers: [...this.buckets], brokerQueues: [...this.snapshots] };
	}

	/** Sample every broker once. Never throws; overlapping calls are skipped. */
	async sample(signal: AbortSignal = new AbortController().signal): Promise<number> {
		if (this.sampling) return 0;
		this.sampling = true;
		try {
			let targets: BrokerStatsTarget[];
			try {
				targets = this.source.brokerTargets();
			} catch (error) {
				this.log('warn', `Broker sampling: no targets: ${errorText(error)}`);
				return 0;
			}
			const ids = new Set(targets.map((target) => target.id));
			for (const id of [...this.handles.keys()]) if (!ids.has(id)) this.drop(id);
			for (const id of [...this.previous.keys()]) if (!ids.has(id)) this.previous.delete(id);
			const bucket = new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString();
			const results = await Promise.all(targets.map((target) => this.sampleOne(target, bucket, signal)));
			return results.filter(Boolean).length;
		} finally {
			this.sampling = false;
		}
	}

	/** POST the buffer; cleared only after `post` resolves, kept (and rethrown) on failure. */
	async flush(post: (payload: BrokerTelemetryPayload) => Promise<void>): Promise<boolean> {
		if (this.buckets.length === 0 && this.snapshots.length === 0) return false;
		const payload = this.pending();
		await post(payload);
		const sentBuckets = new Set(payload.brokers);
		const sentSnapshots = new Set(payload.brokerQueues);
		this.buckets = this.buckets.filter((bucket) => !sentBuckets.has(bucket));
		this.snapshots = this.snapshots.filter((snapshot) => !sentSnapshots.has(snapshot));
		return true;
	}

	/** Close every cached connection (shutdown). */
	close(): void {
		for (const id of [...this.handles.keys()]) this.drop(id);
	}

	private async sampleOne(target: BrokerStatsTarget, bucket: string, signal: AbortSignal): Promise<boolean> {
		const base = { brokerId: target.id, bucket, memoryBytes: int(target.memoryBytes), storeLimitBytes: target.storageMb * MIB };
		if (target.status !== 'running') {
			this.drop(target.id);
			this.previous.delete(target.id);
			return this.pushBucket({ ...base, ...ZERO, up: false });
		}
		let reading: BrokerReading;
		try {
			const connection = await this.connectionFor(target, signal);
			reading = await readBroker(connection, this.timeoutMs);
		} catch (error) {
			this.drop(target.id);
			this.log('warn', `Broker ${target.id}: sample failed: ${errorText(error)}`);
			return this.pushBucket({ ...base, ...ZERO, up: false });
		}
		const at = this.now();
		const sample = summarize(reading, this.previous.get(target.id) ?? null, at);
		this.previous.set(target.id, {
			at,
			counters: reading.account,
			lastSeq: new Map(reading.streams.map((stream) => [stream.name, stream.lastSeq])),
		});
		const pushed = this.pushBucket({ ...base, ...sample, up: true });
		this.pushSnapshot({
			brokerId: target.id,
			at: new Date(at).toISOString(),
			truncated: reading.truncated || reading.streams.length > BROKER_SNAPSHOT_MAX_STREAMS,
			streams: reading.streams.slice(0, BROKER_SNAPSHOT_MAX_STREAMS).map(streamStats),
		});
		return pushed;
	}

	private async connectionFor(target: BrokerStatsTarget, signal: AbortSignal): Promise<NatsConnection> {
		const cached = this.handles.get(target.id);
		if (cached && cached.activationVersion === target.activationVersion && !cached.connection.closed) return cached.connection;
		this.drop(target.id);
		const activation = await this.fetchActivation(target.id, signal);
		const user = activation.env.SKIFF_BROKER_USER;
		const pass = activation.env.SKIFF_BROKER_PASSWORD;
		if (!user || !pass) throw new Error(`Broker ${target.id} has no credentials in its activation`);
		const connection = await this.connect({ host: '127.0.0.1', port: target.port, user, pass, name: 'skiff-stats' });
		this.handles.set(target.id, { activationVersion: target.activationVersion, connection });
		return connection;
	}

	private drop(id: string): void {
		const handle = this.handles.get(id);
		if (!handle) return;
		this.handles.delete(id);
		void Promise.resolve()
			.then(() => handle.connection.close())
			.catch(() => undefined);
	}

	private pushBucket(bucket: BrokerMetricBucket): boolean {
		const parsed = brokerMetricBucketSchema.safeParse(bucket);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid broker sample for ${bucket.brokerId}: ${parsed.error.message}`);
			return false;
		}
		this.buckets.push(parsed.data);
		const overflow = this.buckets.length - this.maxBuckets;
		if (overflow > 0) {
			this.buckets.splice(0, overflow);
			this.totalDropped += overflow;
		}
		return true;
	}

	/** Only the newest listing per broker matters. */
	private pushSnapshot(snapshot: BrokerQueueSnapshot): void {
		const parsed = brokerQueueSnapshotSchema.safeParse(snapshot);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid stream listing for ${snapshot.brokerId}: ${parsed.error.message}`);
			return;
		}
		this.snapshots = this.snapshots.filter((existing) => existing.brokerId !== snapshot.brokerId);
		this.snapshots.push(parsed.data);
		const overflow = this.snapshots.length - this.maxSnapshots;
		if (overflow > 0) {
			this.snapshots.splice(0, overflow);
			this.totalDropped += overflow;
		}
	}
}

const ZERO = {
	connections: 0,
	streams: 0,
	consumers: 0,
	storeBytes: 0,
	memoryStoreBytes: 0,
	messages: 0,
	pending: 0,
	ackPending: 0,
	redelivered: 0,
	oldestAgeSeconds: 0,
	published: 0,
	messagesIn: 0,
	messagesOut: 0,
	bytesIn: 0,
	bytesOut: 0,
	slowConsumers: 0,
} as const;

type SampleFields = Omit<BrokerMetricBucket, 'brokerId' | 'bucket' | 'up' | 'memoryBytes' | 'storeLimitBytes'>;

/** One round of API calls. Throws when JetStream does not answer; STATZ is optional. */
export async function readBroker(connection: NatsConnection, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BrokerReading> {
	let requests = 0;
	const api = (subject: string, body?: unknown) => {
		requests += 1;
		return jsApi(connection, subject, body, timeoutMs);
	};
	const info = record(await api('INFO'));

	const streams: StreamReading[] = [];
	let truncated = false;
	for (let page = 0; ; page++) {
		const reply = record(await api('STREAM.LIST', { offset: streams.length }));
		const items = Array.isArray(reply.streams) ? reply.streams : [];
		for (const item of items) streams.push(readStream(record(item)));
		const total = int(reply.total);
		if (items.length === 0 || streams.length >= total) break;
		if (page + 1 >= MAX_STREAM_PAGES) {
			truncated = true;
			break;
		}
	}
	streams.sort((a, b) => a.name.localeCompare(b.name));

	// Consumer detail for the streams the listing keeps; each is one request.
	for (const stream of streams.slice(0, BROKER_SNAPSHOT_MAX_STREAMS)) {
		if (stream.consumerCount === 0) continue;
		const reply = record(await api(`CONSUMER.LIST.${stream.name}`, { offset: 0 }));
		const items = Array.isArray(reply.consumers) ? reply.consumers : [];
		stream.consumers = items.map((item) => readConsumer(record(item))).sort((a, b) => a.name.localeCompare(b.name));
	}

	let account: BrokerReading['account'] = null;
	try {
		requests += 1;
		const reply = await connection.request('$SYS.REQ.ACCOUNT.PING.STATZ', '{}', { timeoutMs });
		account = readStatz(JSON.parse(new TextDecoder().decode(reply.data)));
	} catch {
		// Servers before 2.2 do not export STATZ to accounts; JetStream numbers still count.
	}

	return {
		storeBytes: int(info.storage),
		memoryStoreBytes: int(info.memory),
		streamCount: int(info.streams),
		consumerCount: int(info.consumers),
		streams,
		truncated,
		account,
		requests,
	};
}

/**
 * Turn a reading into the sample's fields. Rates are deltas against the previous reading of the
 * same broker (0 for the first one), with this sampler's own request/reply pairs taken out.
 */
export function summarize(reading: BrokerReading, previous: PreviousReading | null, now: number): SampleFields {
	let messages = 0;
	let pending = 0;
	let ackPending = 0;
	let redelivered = 0;
	let oldestMs = 0;
	let published = 0;
	for (const stream of reading.streams) {
		messages += stream.messages;
		for (const consumer of stream.consumers) {
			pending += consumer.pending;
			ackPending += consumer.ackPending;
			redelivered += consumer.redelivered;
		}
		// Only queues count towards the backlog age: in a work-queue or interest stream a held
		// message is unprocessed by definition. A limits stream keeps messages on purpose, and a
		// stream nobody consumes (a parked dead-letter queue) is not lagging.
		const draining = stream.retention === 'workqueue' || stream.retention === 'interest';
		if (draining && stream.consumerCount > 0 && stream.messages > 0 && stream.firstTs !== null)
			oldestMs = Math.max(oldestMs, now - stream.firstTs);
		if (previous) {
			const before = previous.lastSeq.get(stream.name);
			if (before === undefined) {
				// A stream created since the last reading: everything in it is new.
				if (stream.created >= previous.at) published += stream.lastSeq;
			} else if (stream.lastSeq >= before) published += stream.lastSeq - before;
			else published += stream.lastSeq; // purged or recreated under the same name
		}
	}

	const account = reading.account;
	const counters = previous?.counters ?? null;
	// This round's requests landed between the two STATZ readings; each is one message in and its
	// reply one message out.
	const own = reading.requests;
	const delta = (key: keyof AccountCounters, ownMessages = 0): number => {
		if (!account || !counters) return 0;
		const current = account[key];
		const before = counters[key];
		// A restarted server starts its counters again from 0.
		const raw = current >= before ? current - before : current;
		return Math.max(0, raw - ownMessages);
	};

	return {
		connections: account ? Math.max(0, account.connections - 1) : 0,
		streams: reading.streamCount || reading.streams.length,
		consumers: reading.consumerCount,
		storeBytes: reading.storeBytes,
		memoryStoreBytes: reading.memoryStoreBytes,
		messages,
		pending,
		ackPending,
		redelivered,
		oldestAgeSeconds: Math.round(Math.max(0, oldestMs) / 1000),
		published,
		messagesIn: delta('messagesIn', own),
		messagesOut: delta('messagesOut', own),
		bytesIn: delta('bytesIn'),
		bytesOut: delta('bytesOut'),
		slowConsumers: delta('slowConsumers'),
	};
}

function readStream(item: Record<string, unknown>): StreamReading {
	const config = record(item.config);
	const state = record(item.state);
	const messages = int(state.messages);
	const subjects = Array.isArray(config.subjects) ? config.subjects.filter((s): s is string => typeof s === 'string') : [];
	const maxBytes = Number(config.max_bytes);
	return {
		name: String(config.name ?? ''),
		subjects,
		storage: config.storage === 'memory' ? 'memory' : 'file',
		retention: typeof config.retention === 'string' ? config.retention : 'limits',
		maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0,
		created: timestamp(item.created) ?? 0,
		messages,
		bytes: int(state.bytes),
		firstSeq: int(state.first_seq),
		lastSeq: int(state.last_seq),
		firstTs: messages > 0 ? timestamp(state.first_ts) : null,
		lastTs: int(state.last_seq) > 0 ? timestamp(state.last_ts) : null,
		consumerCount: int(state.consumer_count),
		consumers: [],
	};
}

function readConsumer(item: Record<string, unknown>): ConsumerReading {
	const delivered = record(item.delivered);
	return {
		name: String(item.name ?? record(item.config).durable_name ?? ''),
		pending: int(item.num_pending),
		ackPending: int(item.num_ack_pending),
		redelivered: int(item.num_redelivered),
		waiting: int(item.num_waiting),
		lastActive: timestamp(delivered.last_active),
	};
}

/** The account's entry in a STATZ reply (`$G` with config users, else the only one). */
export function readStatz(reply: unknown): (AccountCounters & { connections: number }) | null {
	const list = record(record(reply).data).account_statz;
	if (!Array.isArray(list) || list.length === 0) return null;
	const entry = record(list.find((item) => record(item).acc === '$G') ?? list[0]);
	const sent = record(entry.sent);
	const received = record(entry.received);
	return {
		connections: int(entry.conns),
		// The server's "received" is what clients sent in.
		messagesIn: int(received.msgs),
		messagesOut: int(sent.msgs),
		bytesIn: int(received.bytes),
		bytesOut: int(sent.bytes),
		slowConsumers: int(entry.slow_consumers),
	};
}

function streamStats(stream: StreamReading): BrokerStreamStats {
	const consumers: BrokerConsumerStats[] = stream.consumers.slice(0, BROKER_SNAPSHOT_MAX_CONSUMERS).map((consumer) => ({
		name: consumer.name.slice(0, 256),
		pending: consumer.pending,
		ackPending: consumer.ackPending,
		redelivered: consumer.redelivered,
		waiting: consumer.waiting,
		lastDeliveredAt: consumer.lastActive === null ? null : new Date(consumer.lastActive).toISOString(),
	}));
	const queue = stream.name.startsWith(BROKER_QUEUE_STREAM_PREFIX) ? stream.name.slice(BROKER_QUEUE_STREAM_PREFIX.length) : null;
	return {
		stream: stream.name.slice(0, 256),
		queue: queue && queue.length <= 63 ? queue : null,
		subjects: stream.subjects.slice(0, 10).map((subject) => subject.slice(0, 256)),
		storage: stream.storage === 'memory' ? 'memory' : 'file',
		retention: stream.retention.slice(0, 32),
		messages: stream.messages,
		bytes: stream.bytes,
		maxBytes: stream.maxBytes > 0 ? stream.maxBytes : null,
		firstAt: stream.firstTs === null ? null : new Date(stream.firstTs).toISOString(),
		lastAt: stream.lastTs === null ? null : new Date(stream.lastTs).toISOString(),
		consumerCount: stream.consumerCount,
		pending: stream.consumers.reduce((sum, consumer) => sum + consumer.pending, 0),
		ackPending: stream.consumers.reduce((sum, consumer) => sum + consumer.ackPending, 0),
		redelivered: stream.consumers.reduce((sum, consumer) => sum + consumer.redelivered, 0),
		consumers,
	};
}

/** RFC 3339 → epoch ms; NATS's zero time (`0001-01-01T00:00:00Z`) and garbage are null. */
function timestamp(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function int(value: unknown): number {
	const number = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
	return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
	return String(error);
}
