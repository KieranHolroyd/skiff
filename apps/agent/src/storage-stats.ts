import {
	storageBucketSnapshotSchema,
	storageMetricBucketSchema,
	type StorageBucketSnapshot,
	type StorageMetricBucket,
} from '@yoal/contracts';
import { rustfsApiFor, scrub, type StorageApi, type StorageTarget, type StorageTargetSource } from './storage-admin.ts';

/**
 * Object storage sampler (S7). Once a minute per instance on this node it records usage, object
 * and bucket counts, container memory and whether the S3 API answered; every fifth sample it also
 * takes the per-bucket snapshot. Both ride the existing telemetry batch.
 *
 * Usage comes from RustFS's `datausageinfo`, a background-scanner snapshot. On a fresh server it
 * is incomplete (`usage_snapshot_complete: false`), so the sampler then sums ListObjectsV2 per
 * bucket instead, capped at `listPageCap` × 1000 keys per bucket so a huge bucket stays cheap.
 */

export const STORAGE_STATS_INTERVAL_MS = 60_000;
const SNAPSHOT_EVERY = 5;
const MAX_BUCKETS = 5_000;
const MAX_SNAPSHOTS = 200;
const MAX_SNAPSHOT_BUCKETS = 200;
const LIST_PAGE_CAP = 10;

export interface StorageTelemetryPayload {
	objectStorage: StorageMetricBucket[];
	objectStorageBuckets: StorageBucketSnapshot[];
}

export type StorageStatsLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface StorageStatsSamplerOptions {
	source: StorageTargetSource;
	apiFor?: (target: StorageTarget) => StorageApi;
	now?: () => number;
	log?: StorageStatsLog;
	snapshotEvery?: number;
	listPageCap?: number;
	maxBuckets?: number;
	maxSnapshots?: number;
}

export interface BucketUsage {
	name: string;
	sizeBytes: number;
	objects: number;
}

export interface StorageUsage {
	usedBytes: number;
	objects: number;
	bucketCount: number;
	buckets: BucketUsage[];
	/** `scanner` when RustFS's snapshot was complete, `listing` for the fallback. */
	source: 'scanner' | 'listing';
}

export class StorageStatsSampler {
	private readonly source: StorageTargetSource;
	private readonly apiFor: (target: StorageTarget) => StorageApi;
	private readonly now: () => number;
	private readonly log: StorageStatsLog;
	private readonly snapshotEvery: number;
	private readonly listPageCap: number;
	private readonly maxBuckets: number;
	private readonly maxSnapshots: number;

	/** Successful samples per instance; the snapshot is taken on 0, 5, 10, … */
	private readonly samples = new Map<string, number>();
	private buckets: StorageMetricBucket[] = [];
	private snapshots: StorageBucketSnapshot[] = [];
	private sampling = false;
	private totalDropped = 0;

	constructor(options: StorageStatsSamplerOptions) {
		this.source = options.source;
		this.apiFor = options.apiFor ?? rustfsApiFor;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.snapshotEvery = Math.max(1, options.snapshotEvery ?? SNAPSHOT_EVERY);
		this.listPageCap = Math.max(1, options.listPageCap ?? LIST_PAGE_CAP);
		this.maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
		this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
	}

	get dropped(): number {
		return this.totalDropped;
	}

	pending(): StorageTelemetryPayload {
		return { objectStorage: [...this.buckets], objectStorageBuckets: [...this.snapshots] };
	}

	/** Sample every instance once. Never throws; overlapping calls are skipped. */
	async sample(): Promise<number> {
		if (this.sampling) return 0;
		this.sampling = true;
		try {
			let targets: StorageTarget[];
			try {
				targets = this.source.storageTargets();
			} catch (error) {
				this.log('warn', `Storage sampling: no targets: ${errorText(error)}`);
				return 0;
			}
			const ids = new Set(targets.map((target) => target.id));
			for (const id of [...this.samples.keys()]) if (!ids.has(id)) this.samples.delete(id);
			const bucket = new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString();
			const results = await Promise.all(targets.map((target) => this.sampleOne(target, bucket)));
			return results.filter(Boolean).length;
		} finally {
			this.sampling = false;
		}
	}

	/** POST the buffer; cleared only after `post` resolves, kept (and rethrown) on failure. */
	async flush(post: (payload: StorageTelemetryPayload) => Promise<void>): Promise<boolean> {
		if (this.buckets.length === 0 && this.snapshots.length === 0) return false;
		const payload = this.pending();
		await post(payload);
		const sentBuckets = new Set(payload.objectStorage);
		const sentSnapshots = new Set(payload.objectStorageBuckets);
		this.buckets = this.buckets.filter((bucket) => !sentBuckets.has(bucket));
		this.snapshots = this.snapshots.filter((snapshot) => !sentSnapshots.has(snapshot));
		return true;
	}

	private async sampleOne(target: StorageTarget, bucket: string): Promise<boolean> {
		const memoryBytes = int(target.memoryBytes);
		if (target.status !== 'running') return this.pushBucket(downBucket(target.id, bucket, memoryBytes));
		let usage: StorageUsage;
		try {
			usage = await readUsage(this.apiFor(target), this.listPageCap);
		} catch (error) {
			this.log('warn', `Storage ${target.id}: sample failed: ${scrub(errorText(error), target)}`);
			return this.pushBucket(downBucket(target.id, bucket, memoryBytes));
		}
		const pushed = this.pushBucket({
			storageId: target.id,
			bucket,
			up: true,
			usedBytes: usage.usedBytes,
			objects: usage.objects,
			bucketCount: usage.bucketCount,
			memoryBytes,
		});
		const count = this.samples.get(target.id) ?? 0;
		if (count % this.snapshotEvery === 0) {
			this.pushSnapshot({
				storageId: target.id,
				at: new Date(this.now()).toISOString(),
				buckets: usage.buckets.slice(0, MAX_SNAPSHOT_BUCKETS),
			});
		}
		this.samples.set(target.id, count + 1);
		return pushed;
	}

	private pushBucket(bucket: StorageMetricBucket): boolean {
		const parsed = storageMetricBucketSchema.safeParse(bucket);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid storage sample for ${bucket.storageId}: ${parsed.error.message}`);
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

	/** Only the newest snapshot per instance matters. */
	private pushSnapshot(snapshot: StorageBucketSnapshot): void {
		const parsed = storageBucketSnapshotSchema.safeParse(snapshot);
		if (!parsed.success) {
			this.log('warn', `Dropping an invalid bucket snapshot for ${snapshot.storageId}: ${parsed.error.message}`);
			return;
		}
		this.snapshots = this.snapshots.filter((existing) => existing.storageId !== snapshot.storageId);
		this.snapshots.push(parsed.data);
		const overflow = this.snapshots.length - this.maxSnapshots;
		if (overflow > 0) {
			this.snapshots.splice(0, overflow);
			this.totalDropped += overflow;
		}
	}
}

/**
 * Usage for one instance: the scanner snapshot when complete, otherwise a capped listing. The
 * bucket list itself always comes from ListBuckets, so a bucket the scanner has not seen yet still
 * shows up (with zero usage until it is scanned).
 */
export async function readUsage(api: StorageApi, listPageCap = LIST_PAGE_CAP): Promise<StorageUsage> {
	const names = (await api.listBuckets()).sort();
	let info: Record<string, unknown> | null = null;
	try {
		info = await api.dataUsage();
	} catch {
		// Older builds or a scanner hiccup: fall back to listing.
	}
	if (info && info.usage_snapshot_complete === true) {
		const perBucket = scannerBuckets(info);
		const buckets = names.map((name) => perBucket.get(name) ?? { name, sizeBytes: 0, objects: 0 });
		return {
			usedBytes: int(info.objects_total_size) || sum(buckets, 'sizeBytes'),
			objects: int(info.objects_total_count) || sum(buckets, 'objects'),
			bucketCount: names.length,
			buckets,
			source: 'scanner',
		};
	}
	const buckets: BucketUsage[] = [];
	for (const name of names) {
		let sizeBytes = 0;
		let objects = 0;
		let token: string | null = null;
		for (let page = 0; page < listPageCap; page++) {
			const result = await api.listObjects(name, token);
			for (const object of result.objects) {
				sizeBytes += object.size;
				objects += 1;
			}
			token = result.next;
			if (!token) break;
		}
		buckets.push({ name, sizeBytes, objects });
	}
	return {
		usedBytes: sum(buckets, 'sizeBytes'),
		objects: sum(buckets, 'objects'),
		bucketCount: names.length,
		buckets,
		source: 'listing',
	};
}

/**
 * Per-bucket figures from `buckets_usage` (`{ size, objects_count, … }`), with `bucket_sizes`
 * (`{ name: bytes }`) as a fallback for the size.
 */
function scannerBuckets(info: Record<string, unknown>): Map<string, BucketUsage> {
	const out = new Map<string, BucketUsage>();
	const usage = record(info.buckets_usage);
	const sizes = record(info.bucket_sizes);
	for (const name of new Set([...Object.keys(usage), ...Object.keys(sizes)])) {
		const entry = record(usage[name]);
		out.set(name, {
			name,
			sizeBytes: int(entry.size ?? entry.objects_size ?? sizes[name]),
			objects: int(entry.objects_count ?? entry.object_count ?? entry.objectsCount),
		});
	}
	return out;
}

function downBucket(storageId: string, bucket: string, memoryBytes: number): StorageMetricBucket {
	return { storageId, bucket, up: false, usedBytes: 0, objects: 0, bucketCount: 0, memoryBytes };
}

function sum(buckets: BucketUsage[], field: 'sizeBytes' | 'objects'): number {
	return buckets.reduce((total, bucket) => total + bucket[field], 0);
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
