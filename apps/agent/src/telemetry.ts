import { promises as fs } from 'node:fs';
import type { AnalyticsEvent, FunctionTailEvent, MetricBucket, TelemetryBatch } from '@yoal/contracts';
import { normalizeHost } from './verify.ts';

/**
 * Aggregates Caddy's JSON access log into 1-minute buckets (DESIGN §8). Raw requests never leave
 * the node and memory is explicitly bounded: a control-plane outage degrades to dropped buckets,
 * never an OOM.
 */

const SAMPLE_LIMIT = 512;
const PATH_LIMIT = 100;
const REFERRER_LIMIT = 50;
const MAX_ACTIVE_BUCKETS = 2_000;
const MAX_PENDING_BUCKETS = 5_000;
/**
 * Analytics Engine datapoints waiting for the next POST. One agent serves every function on the
 * node, so this buffer is the only back-pressure between a chatty Worker and a control-plane
 * outage; past the cap the oldest events are dropped rather than growing memory (fail-open).
 */
const MAX_PENDING_ANALYTICS = 5_000;
/**
 * Tail-worker items waiting for the next POST. The telemetry batch caps `tails` at 2,000, so there
 * is no point buffering more: past the cap the oldest items are dropped (fail-open).
 */
const MAX_PENDING_TAILS = 2_000;
const TOP_LIMIT = 10;
const READ_CHUNK = 64 * 1024;
const MAX_CARRY = 1024 * 1024;

interface BucketState {
	host: string;
	minute: number;
	requests: number;
	status2xx: number;
	status3xx: number;
	status4xx: number;
	status5xx: number;
	bytes: number;
	samples: number[];
	sampleCount: number;
	paths: Map<string, number>;
	referrers: Map<string, number>;
}

interface AccessLogEntry {
	ts?: unknown;
	status?: unknown;
	size?: unknown;
	duration?: unknown;
	request?: {
		host?: unknown;
		uri?: unknown;
		headers?: Record<string, unknown>;
	};
}

export class AccessLogAggregator {
	private readonly buckets = new Map<string, BucketState>();
	private readonly pending: MetricBucket[] = [];
	private readonly resolveProject: (host: string) => string | null;
	private readonly now: () => number;
	private totalDropped = 0;

	constructor(resolveProject: (host: string) => string | null, now: () => number = Date.now) {
		this.resolveProject = resolveProject;
		this.now = now;
	}

	get dropped(): number {
		return this.totalDropped;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	/** Parse and aggregate one Caddy JSON log line. Bad lines are ignored. */
	addLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let entry: AccessLogEntry;
		try {
			entry = JSON.parse(trimmed) as AccessLogEntry;
		} catch {
			return;
		}
		this.addEntry(entry);
	}

	private addEntry(entry: AccessLogEntry): void {
		const host = normalizeHost(typeof entry.request?.host === 'string' ? entry.request.host : null);
		if (!host) return;

		const timestamp = numberOr(entry.ts, this.now() / 1000);
		const minute = Math.floor(timestamp / 60) * 60;
		const key = `${host}|${minute}`;
		let bucket = this.buckets.get(key);
		if (!bucket) {
			if (this.buckets.size >= MAX_ACTIVE_BUCKETS) {
				const oldest = this.buckets.keys().next();
				if (!oldest.done) this.buckets.delete(oldest.value);
			}
			bucket = {
				host,
				minute,
				requests: 0,
				status2xx: 0,
				status3xx: 0,
				status4xx: 0,
				status5xx: 0,
				bytes: 0,
				samples: [],
				sampleCount: 0,
				paths: new Map(),
				referrers: new Map(),
			};
			this.buckets.set(key, bucket);
		}

		bucket.requests += 1;
		const status = Math.trunc(numberOr(entry.status, 0));
		if (status >= 500) bucket.status5xx += 1;
		else if (status >= 400) bucket.status4xx += 1;
		else if (status >= 300) bucket.status3xx += 1;
		else if (status >= 200) bucket.status2xx += 1;

		bucket.bytes += Math.max(0, Math.trunc(numberOr(entry.size, 0)));
		addReservoirSample(bucket, Math.max(0, numberOr(entry.duration, 0) * 1000));

		const uri = typeof entry.request?.uri === 'string' ? entry.request.uri : '/';
		const path = uri.split('?')[0]?.slice(0, 512) || '/';
		incrementBounded(bucket.paths, path, PATH_LIMIT);

		const referrer = headerValue(entry.request?.headers, 'referer');
		if (referrer) incrementBounded(bucket.referrers, referrer.slice(0, 256), REFERRER_LIMIT);
	}

	/**
	 * Move completed minutes into the pending queue. `force` is used on shutdown so the current
	 * partial minute is not lost.
	 */
	flushReady(force = false): number {
		const currentMinute = Math.floor(this.now() / 60_000) * 60;
		const ready: BucketState[] = [];
		for (const [key, bucket] of this.buckets) {
			if (!force && bucket.minute >= currentMinute) continue;
			ready.push(bucket);
			this.buckets.delete(key);
		}
		if (ready.length === 0) return 0;

		for (const bucket of ready) this.pending.push(toMetricBucket(bucket, this.resolveProject(bucket.host)));
		if (this.pending.length > MAX_PENDING_BUCKETS) {
			const overflow = this.pending.length - MAX_PENDING_BUCKETS;
			this.pending.splice(0, overflow);
			this.totalDropped += overflow;
		}
		return ready.length;
	}

	/** Oldest-first chunks of at most 5000 (the contract's telemetry batch limit). */
	takePending(): MetricBucket[] {
		return this.pending.splice(0, Math.min(this.pending.length, 5_000));
	}

	requeue(buckets: MetricBucket[]): void {
		this.pending.unshift(...buckets);
		if (this.pending.length > MAX_PENDING_BUCKETS) {
			const overflow = this.pending.length - MAX_PENDING_BUCKETS;
			this.pending.splice(0, overflow);
			this.totalDropped += overflow;
		}
	}
}

function toMetricBucket(bucket: BucketState, projectId: string | null): MetricBucket {
	return {
		host: bucket.host,
		projectId,
		bucket: new Date(bucket.minute * 1000).toISOString(),
		requests: bucket.requests,
		status2xx: bucket.status2xx,
		status3xx: bucket.status3xx,
		status4xx: bucket.status4xx,
		status5xx: bucket.status5xx,
		bytes: bucket.bytes,
		durationP50Ms: quantile(bucket.samples, 0.5),
		durationP95Ms: quantile(bucket.samples, 0.95),
		topPaths: topEntries(bucket.paths),
		topReferrers: [...topEntries(bucket.referrers)].map(({ path, count }) => ({
			referrer: path,
			count,
		})),
	};
}

function addReservoirSample(bucket: BucketState, value: number): void {
	bucket.sampleCount += 1;
	if (bucket.samples.length < SAMPLE_LIMIT) {
		bucket.samples.push(value);
		return;
	}
	// Uniform reservoir sampling keeps p50/p95 honest without unbounded memory.
	const index = Math.floor(Math.random() * bucket.sampleCount);
	if (index < SAMPLE_LIMIT) bucket.samples[index] = value;
}

function quantile(samples: number[], q: number): number {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function topEntries(map: Map<string, number>): Array<{ path: string; count: number }> {
	return [...map.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP_LIMIT)
		.map(([path, count]) => ({ path, count }));
}

function incrementBounded(map: Map<string, number>, key: string, limit: number): void {
	const current = map.get(key);
	if (current !== undefined) {
		map.set(key, current + 1);
		return;
	}
	if (map.size < limit) map.set(key, 1);
}

function numberOr(value: unknown, fallback: number): number {
	const number = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | null {
	if (!headers) return null;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (typeof value === 'string') return value;
		if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
	}
	return null;
}

interface TailerState {
	handle: Awaited<ReturnType<typeof fs.open>>;
	inode: number;
	position: number;
	carry: Buffer;
}

/** Incremental tail of a Caddy JSON access log, with truncation/rotation handling. */
export class AccessLogTailer {
	readonly path: string;
	private readonly aggregator: AccessLogAggregator;
	private state: TailerState | null = null;

	constructor(path: string, aggregator: AccessLogAggregator) {
		this.path = path;
		this.aggregator = aggregator;
	}

	/** By default start at EOF: old logs were shipped by a previous run. */
	async open(startAtEnd = true): Promise<void> {
		await this.close();
		const handle = await fs.open(this.path, 'r');
		try {
			const stat = await handle.stat();
			this.state = {
				handle,
				inode: stat.ino,
				position: startAtEnd ? stat.size : 0,
				carry: Buffer.alloc(0),
			};
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	async poll(): Promise<void> {
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(this.path);
		} catch {
			await this.close();
			return;
		}

		if (!this.state || this.state.inode !== stat.ino || stat.size < this.state.position) {
			// A rotated/truncated file should be read from the beginning, not skipped.
			await this.open(false);
			if (!this.state) return;
		}
		const state = this.state;
		if (!state) return;

		while (state.position < stat.size) {
			const length = Math.min(READ_CHUNK, stat.size - state.position);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await state.handle.read(buffer, 0, length, state.position);
			if (bytesRead === 0) break;
			state.position += bytesRead;
			this.consume(buffer.subarray(0, bytesRead));
		}
	}

	async close(): Promise<void> {
		const state = this.state;
		this.state = null;
		if (state) await state.handle.close().catch(() => undefined);
	}

	private consume(chunk: Buffer): void {
		const state = this.state;
		if (!state) return;
		const data = state.carry.length > 0 ? Buffer.concat([state.carry, chunk]) : chunk;
		let start = 0;
		for (;;) {
			const newline = data.indexOf(0x0a, start);
			if (newline < 0) break;
			this.aggregator.addLine(data.subarray(start, newline).toString('utf8'));
			start = newline + 1;
		}
		const remainder = data.subarray(start);
		// A pathological line without a newline must not grow without bound.
		state.carry = remainder.length > MAX_CARRY ? Buffer.alloc(0) : Buffer.from(remainder);
	}
}

export interface TelemetryEndpoint {
	controlUrl: string;
	nodeToken: string;
	nodeId: string;
}

/**
 * One `POST /api/agent/telemetry`. Access-log buckets and managed-database samples (D57) share the
 * endpoint; either half may be empty. Throws on any non-2xx so callers keep their buffer.
 */
export async function postTelemetryBatch(
	endpoint: TelemetryEndpoint,
	batch: Partial<Omit<TelemetryBatch, 'nodeId'>>,
): Promise<void> {
	const response = await fetch(`${endpoint.controlUrl}/api/agent/telemetry`, {
		method: 'POST',
		signal: AbortSignal.timeout(10_000),
		headers: {
			authorization: `Bearer ${endpoint.nodeToken}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ nodeId: endpoint.nodeId, ...batch }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Telemetry POST -> ${response.status}${text ? `: ${text}` : ''}`);
	}
}

export interface TelemetryClientOptions {
	controlUrl: string;
	nodeToken: string;
	nodeId: string;
	accessLogPath: string;
	resolveProject: (host: string) => string | null;
	now?: () => number;
}

/** Owns the tailer + aggregator and ships batches to `POST /api/agent/telemetry`. */
export class TelemetryClient {
	private readonly options: TelemetryClientOptions;
	private readonly aggregator: AccessLogAggregator;
	private readonly tailer: AccessLogTailer;
	/** Analytics Engine datapoints from function bindings, waiting for the next POST. */
	private readonly analytics: AnalyticsEvent[] = [];
	private analyticsDropped = 0;
	/** Tail-worker items from function invocations, waiting for the next POST. */
	private readonly tails: FunctionTailEvent[] = [];
	private tailsDropped = 0;
	private flushFailures = 0;
	private batchesSent = 0;
	private bucketsSent = 0;
	private started = false;

	constructor(options: TelemetryClientOptions) {
		this.options = options;
		this.aggregator = new AccessLogAggregator(options.resolveProject, options.now);
		this.tailer = new AccessLogTailer(options.accessLogPath, this.aggregator);
	}

	get stats(): {
		flushFailures: number;
		batchesSent: number;
		bucketsSent: number;
		dropped: number;
		analyticsDropped: number;
		tailsDropped: number;
	} {
		return {
			flushFailures: this.flushFailures,
			batchesSent: this.batchesSent,
			bucketsSent: this.bucketsSent,
			dropped: this.aggregator.dropped,
			analyticsDropped: this.analyticsDropped,
			tailsDropped: this.tailsDropped,
		};
	}

	get ready(): boolean {
		return this.started;
	}

	async start(): Promise<void> {
		if (this.started) return;
		await this.tailer.open();
		this.started = true;
	}

	async poll(): Promise<void> {
		if (!this.started) return;
		await this.tailer.poll();
	}

	/**
	 * Buffer one Analytics Engine datapoint (from the loopback sink) for the next telemetry POST.
	 * Synchronous and never throws: the sink's `record` callback runs inside an HTTP handler and a
	 * full buffer must drop the oldest event, not fail the write.
	 */
	recordAnalytics(event: AnalyticsEvent): void {
		this.analytics.push(event);
		this.trimAnalytics();
	}

	/**
	 * Buffer one tail-worker item (from the loopback sink) for the next telemetry POST. Synchronous
	 * and never throws: the sink's `record` callback runs inside an HTTP handler and a full buffer
	 * must drop the oldest item, not fail the write.
	 */
	recordTail(event: FunctionTailEvent): void {
		this.tails.push(event);
		this.trimTails();
	}

	/** Aggregate completed minutes and POST them. Throws only after retaining the batch. */
	async flush(force = false): Promise<void> {
		if (!this.started) return;
		this.aggregator.flushReady(force);
		for (;;) {
			const batch = this.aggregator.takePending();
			const analytics = this.analytics.splice(0, this.analytics.length);
			const tails = this.tails.splice(0, this.tails.length);
			// Analytics-only and tail-only flushes must still reach the control plane.
			if (batch.length === 0 && analytics.length === 0 && tails.length === 0) return;
			try {
				await this.post(batch, analytics, tails);
				this.batchesSent += 1;
				this.bucketsSent += batch.length;
			} catch (error) {
				this.flushFailures += 1;
				this.aggregator.requeue(batch);
				this.analytics.unshift(...analytics);
				this.trimAnalytics();
				this.tails.unshift(...tails);
				this.trimTails();
				throw error;
			}
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		try {
			// Ship the current partial minute before going away.
			await this.flush(true);
		} catch {
			// Shutdown must not hang or throw because the control plane is unreachable.
		}
		this.started = false;
		await this.tailer.close();
	}

	private async post(
		buckets: MetricBucket[],
		analytics: AnalyticsEvent[],
		tails: FunctionTailEvent[],
	): Promise<void> {
		await postTelemetryBatch(this.options, {
			buckets,
			...(analytics.length > 0 ? { analytics } : {}),
			...(tails.length > 0 ? { tails } : {}),
		});
	}

	/** Keep the analytics buffer bounded by dropping the oldest events. */
	private trimAnalytics(): void {
		if (this.analytics.length <= MAX_PENDING_ANALYTICS) return;
		const overflow = this.analytics.length - MAX_PENDING_ANALYTICS;
		this.analytics.splice(0, overflow);
		this.analyticsDropped += overflow;
	}

	/** Keep the tail buffer bounded by dropping the oldest items. */
	private trimTails(): void {
		if (this.tails.length <= MAX_PENDING_TAILS) return;
		const overflow = this.tails.length - MAX_PENDING_TAILS;
		this.tails.splice(0, overflow);
		this.tailsDropped += overflow;
	}
}
