import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AwsClient } from 'aws4fetch';
import {
	STORAGE_REGION,
	type StorageReplicationBucketReport,
	type StorageReplicationDesired,
	type StorageReplicationReport,
} from '@yoal/contracts';
import { StorageApiError, blocks, escapeXml, tagValue, type StorageTarget, type StorageTargetSource } from './storage-admin.ts';
import { atomicWriteFile } from './state.ts';

/**
 * Bucket replication runner (docs/OBJECT-STORAGE.md §12, CLUSTERING.md §10.2).
 *
 * The control plane sends the links this node runs in `objectStorage.replication` and each link's
 * scoped secret in the activation (`storageAdmin.replication`). One pass per link per interval:
 *
 * - both sides are listed in key order and walked together; an object is copied when it is missing
 *   on the target, its size differs, its ETag differs (only compared when neither side is a
 *   multipart ETag, whose value depends on part sizes) or, otherwise, the source is newer;
 * - small objects are copied in one GET/PUT; larger ones as a multipart upload fed by ranged reads
 *   pinned to the source ETag (`If-Match`), so memory stays bounded and a concurrent overwrite
 *   aborts the copy instead of mixing two versions; content type, standard headers and
 *   `x-amz-meta-*` are carried over;
 * - target objects missing on the source are deleted only after the source listing for that bucket
 *   completed without an error (a failed listing must never look like an empty bucket);
 * - progress is checkpointed to the agent's data dir, so a restart resumes mid-bucket.
 *
 * The local instance is read or written over loopback with its root key. The peer is reached
 * through its node's internal gateway (`endpoint`), signed for the peer's internal host, which is
 * sent as `Host` (D82), with the link's scoped key, never the peer's root key.
 */

export const REPLICATION_TICK_MS = 15_000;
/** Objects up to this size are copied in one request; larger ones as multipart uploads. */
export const REPLICATION_PART_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;
const DELETE_BATCH = 1000;
const LIST_PAGE = 1000;
const CHECKPOINT_EVERY_OBJECTS = 500;
const CHECKPOINT_EVERY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** A 16 MiB part over a slow overlay link can take a while. */
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
/** A heartbeat carries a link's report at least this often even when nothing changed. */
const REPORT_EVERY_MS = 60_000;
/** Retry delay after a failed pass: grows per consecutive failure, capped at the link interval. */
const RETRY_BASE_MS = 60_000;
const COPY_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'];

// ------------------------------------------------------------------ S3 side

export interface ReplicaObject {
	key: string;
	size: number;
	etag: string | null;
	/** Epoch ms. */
	lastModified: number | null;
}

export interface ReplicaHead {
	size: number;
	etag: string | null;
	/** Headers to carry to the copy (content type, standard headers, `x-amz-meta-*`). */
	headers: Record<string, string>;
}

export interface ReplicaRead {
	body: Uint8Array;
	etag: string | null;
	headers: Record<string, string>;
}

/** The S3 calls the replicator makes against one side. `S3ReplicaStore` in production. */
export interface ReplicaStore {
	listObjects(bucket: string, options: { startAfter?: string | null; token?: string | null }): Promise<{
		objects: ReplicaObject[];
		next: string | null;
	}>;
	/** null when the object is gone. */
	headObject(bucket: string, key: string): Promise<ReplicaHead | null>;
	/** `range` is inclusive. null when the object is gone. */
	getObject(bucket: string, key: string, options?: { range?: [number, number]; ifMatch?: string | null }): Promise<ReplicaRead | null>;
	putObject(bucket: string, key: string, body: Uint8Array, headers: Record<string, string>): Promise<void>;
	createMultipart(bucket: string, key: string, headers: Record<string, string>): Promise<string>;
	uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>;
	completeMultipart(bucket: string, key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
	abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
	deleteObjects(bucket: string, keys: string[]): Promise<void>;
}

export interface S3ReplicaStoreOptions {
	/** Where the connection goes: `http://127.0.0.1:<port>` or `http://<peer node address>`. */
	endpoint: string;
	/** Host the request is signed for and sent as `Host`; defaults to the endpoint's own host. */
	host?: string;
	accessKeyId: string;
	secretAccessKey: string;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/** Path-style S3 client for one side of a link, SigV4-signed (service `s3`, Yoal's region). */
export class S3ReplicaStore implements ReplicaStore {
	private readonly endpoint: string;
	private readonly host: string | null;
	private readonly aws: AwsClient;
	private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;

	constructor(options: S3ReplicaStoreOptions) {
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.host = options.host ?? null;
		this.aws = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			service: 's3',
			region: STORAGE_REGION,
		});
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
	}

	async listObjects(
		bucket: string,
		options: { startAfter?: string | null; token?: string | null },
	): Promise<{ objects: ReplicaObject[]; next: string | null }> {
		const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(LIST_PAGE) };
		if (options.token) query['continuation-token'] = options.token;
		else if (options.startAfter) query['start-after'] = options.startAfter;
		const response = await this.send('GET', bucketPath(bucket), { query, expect: [200] });
		const xml = await response.text();
		const objects = blocks(xml, 'Contents')
			.map((block) => ({
				key: tagValue(block, 'Key') ?? '',
				size: nonNegative(Number(tagValue(block, 'Size') ?? 0)),
				etag: trimEtag(tagValue(block, 'ETag')),
				lastModified: parseDate(tagValue(block, 'LastModified')),
			}))
			.filter((object) => object.key !== '');
		const truncated = tagValue(xml, 'IsTruncated') === 'true';
		const next = truncated ? tagValue(xml, 'NextContinuationToken') : null;
		return { objects, next: next || null };
	}

	async headObject(bucket: string, key: string): Promise<ReplicaHead | null> {
		const response = await this.send('HEAD', objectPath(bucket, key), { expect: [200, 404] });
		if (response.status === 404) return null;
		return {
			size: nonNegative(Number(response.headers.get('content-length') ?? 0)),
			etag: trimEtag(response.headers.get('etag')),
			headers: copyHeaders(response.headers),
		};
	}

	async getObject(
		bucket: string,
		key: string,
		options: { range?: [number, number]; ifMatch?: string | null } = {},
	): Promise<ReplicaRead | null> {
		const headers: Record<string, string> = {};
		if (options.range) headers.range = `bytes=${options.range[0]}-${options.range[1]}`;
		if (options.ifMatch) headers['if-match'] = `"${options.ifMatch}"`;
		const response = await this.send('GET', objectPath(bucket, key), {
			headers,
			expect: options.range ? [206, 200, 404] : [200, 404],
			timeoutMs: TRANSFER_TIMEOUT_MS,
		});
		if (response.status === 404) {
			await response.body?.cancel().catch(() => undefined);
			return null;
		}
		return {
			body: new Uint8Array(await response.arrayBuffer()),
			etag: trimEtag(response.headers.get('etag')),
			headers: copyHeaders(response.headers),
		};
	}

	async putObject(bucket: string, key: string, body: Uint8Array, headers: Record<string, string>): Promise<void> {
		await this.send('PUT', objectPath(bucket, key), { headers, body, expect: [200], timeoutMs: TRANSFER_TIMEOUT_MS });
	}

	async createMultipart(bucket: string, key: string, headers: Record<string, string>): Promise<string> {
		const response = await this.send('POST', objectPath(bucket, key), { query: { uploads: '' }, headers, expect: [200] });
		const uploadId = tagValue(await response.text(), 'UploadId');
		if (!uploadId) throw new StorageApiError('CreateMultipartUpload returned no UploadId', 200, null);
		return uploadId;
	}

	async uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
		const response = await this.send('PUT', objectPath(bucket, key), {
			query: { partNumber: String(partNumber), uploadId },
			body,
			expect: [200],
			timeoutMs: TRANSFER_TIMEOUT_MS,
		});
		const etag = response.headers.get('etag');
		if (!etag) throw new StorageApiError(`UploadPart ${partNumber} returned no ETag`, 200, null);
		return etag;
	}

	async completeMultipart(
		bucket: string,
		key: string,
		uploadId: string,
		parts: Array<{ partNumber: number; etag: string }>,
	): Promise<void> {
		const xml =
			'<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
			parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join('') +
			'</CompleteMultipartUpload>';
		const response = await this.send('POST', objectPath(bucket, key), {
			query: { uploadId },
			headers: { 'content-type': 'application/xml' },
			body: new TextEncoder().encode(xml),
			expect: [200],
			timeoutMs: TRANSFER_TIMEOUT_MS,
		});
		// S3 can answer 200 and still report the failure in the body.
		const text = await response.text();
		if (/<Error>/.test(text))
			throw new StorageApiError(
				`CompleteMultipartUpload: ${tagValue(text, 'Code') ?? 'error'}: ${tagValue(text, 'Message') ?? ''}`,
				200,
				tagValue(text, 'Code'),
			);
	}

	async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
		await this.send('DELETE', objectPath(bucket, key), { query: { uploadId }, expect: [200, 204, 404] });
	}

	async deleteObjects(bucket: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
			.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
			.join('')}</Delete>`;
		const body = new TextEncoder().encode(xml);
		const response = await this.send('POST', bucketPath(bucket), {
			query: { delete: '' },
			headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') },
			body,
			expect: [200],
		});
		const errors = blocks(await response.text(), 'Error');
		if (errors.length > 0)
			throw new StorageApiError(
				`DeleteObjects in ${bucket}: ${errors.length} failed (${tagValue(errors[0]!, 'Code') ?? 'error'})`,
				200,
				tagValue(errors[0]!, 'Code'),
			);
	}

	private async send(
		method: string,
		path: string,
		options: {
			query?: Record<string, string>;
			headers?: Record<string, string>;
			body?: Uint8Array;
			expect: number[];
			timeoutMs?: number;
		},
	): Promise<Response> {
		const base = this.host ? `http://${this.host}` : this.endpoint;
		const signUrl = new URL(`${base}${path}`);
		for (const [name, value] of Object.entries(options.query ?? {})) signUrl.searchParams.set(name, value);
		// Bun's BodyInit has no typed arrays; an ArrayBuffer keeps the bytes and the payload hash equal.
		const payload = options.body ? (options.body.slice().buffer as ArrayBuffer) : undefined;
		// aws4fetch sends `UNSIGNED-PAYLOAD` for S3; object bytes are signed so RustFS verifies them.
		const headers0: Record<string, string> = { ...(options.headers ?? {}) };
		if (options.body) headers0['x-amz-content-sha256'] = createHash('sha256').update(options.body).digest('hex');
		const signed = await this.aws.sign(signUrl.toString(), {
			method,
			headers: headers0,
			...(payload ? { body: payload } : {}),
		});
		const headers = new Headers(signed.headers);
		// The peer's gateway routes by this Host and RustFS verifies the signature against it.
		if (this.host) headers.set('host', this.host);
		const response = await this.fetchImpl(`${this.endpoint}${path}${signUrl.search}`, {
			method,
			headers,
			...(payload ? { body: payload } : {}),
			signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
		if (options.expect.includes(response.status)) return response;
		const text = await response.text().catch(() => '');
		const code = tagValue(text, 'Code');
		const message = tagValue(text, 'Message') ?? (method === 'HEAD' ? '' : text.slice(0, 200));
		throw new StorageApiError(
			`${method} ${path.split('?')[0]} -> ${response.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
			response.status,
			code,
		);
	}
}

// ------------------------------------------------------------------ comparison

/** A multipart ETag (`<md5>-<parts>`) depends on part sizes, so it never matches a re-upload. */
export function isMultipartEtag(etag: string | null): boolean {
	return etag !== null && /-\d+$/.test(etag);
}

/** Whether `source` must be copied over `target` (undefined: missing on the target). */
export function needsCopy(source: ReplicaObject, target: ReplicaObject | undefined): boolean {
	if (!target) return true;
	if (source.size !== target.size) return true;
	if (source.etag && target.etag && !isMultipartEtag(source.etag) && !isMultipartEtag(target.etag))
		return source.etag !== target.etag;
	return source.lastModified !== null && target.lastModified !== null && source.lastModified > target.lastModified;
}

/** S3 lists keys in UTF-8 byte order, which differs from JS string order outside the BMP. */
export function compareKeys(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Keys with `.` or `..` path segments cannot be addressed path-style: URL parsing resolves them
 * (even percent-encoded), so the request would hit another key. They are reported, not copied.
 */
export function addressableKey(key: string): boolean {
	return !key.split('/').some((segment) => segment === '.' || segment === '..' || /^%2e(%2e)?$/i.test(segment));
}

// ------------------------------------------------------------------ runner

export interface ReplicationLink {
	desired: StorageReplicationDesired;
	/** Local instance id. */
	storageId: string;
	/** Local side, over loopback with the instance's root key. */
	local: ReplicaStore;
	/** Peer side, through its node gateway with the link's scoped key. */
	peer: ReplicaStore;
	/** Secrets to scrub from error text. */
	secrets: string[];
}

interface LinkCheckpoint {
	lastSyncAt: string | null;
	buckets: Record<string, string>;
	pass: {
		startedAt: string;
		/** Buckets finished this pass, with their outcome. */
		done: Record<string, StorageReplicationBucketReport>;
		/** Bucket in progress and the last source key fully handled in it. */
		bucket: string | null;
		afterKey: string | null;
	} | null;
}

interface CheckpointFile {
	version: 1;
	links: Record<string, LinkCheckpoint>;
}

interface LinkRuntime {
	nextPassAt: number;
	failures: number;
	status: StorageReplicationReport['status'];
	attemptAt: string | null;
	pending: number;
	error: string | null;
	buckets: Map<string, StorageReplicationBucketReport>;
	/** Copied since the last acknowledged heartbeat. */
	copiedObjects: number;
	copiedBytes: number;
	dirty: boolean;
	reportedAt: number;
}

export interface StorageReplicatorOptions {
	source: StorageTargetSource;
	/** `${dataDir}/storage-replication.json`. */
	statePath: string;
	/** Builds the S3 client for one side; tests inject in-memory stores. */
	storeFor?: (options: S3ReplicaStoreOptions) => ReplicaStore;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	partBytes?: number;
}

export class StorageReplicator {
	private readonly source: StorageTargetSource;
	private readonly statePath: string;
	private readonly storeFor: (options: S3ReplicaStoreOptions) => ReplicaStore;
	private readonly log: NonNullable<StorageReplicatorOptions['log']>;
	private readonly now: () => number;
	private readonly partBytes: number;
	private readonly runtime = new Map<string, LinkRuntime>();
	private checkpoints: CheckpointFile = { version: 1, links: {} };
	private loaded = false;
	private active: { id: string; controller: AbortController } | null = null;

	constructor(options: StorageReplicatorOptions) {
		this.source = options.source;
		this.statePath = options.statePath;
		this.storeFor = options.storeFor ?? ((store) => new S3ReplicaStore(store));
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.partBytes = Math.max(5 * 1024 * 1024, options.partBytes ?? REPLICATION_PART_BYTES);
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.tick(signal);
			} catch (error) {
				this.log('warn', `Storage replication: ${errorText(error)}`);
			}
			await sleep(REPLICATION_TICK_MS, signal);
		}
		this.active?.controller.abort();
	}

	/** Run every due link once, one pass at a time. Exposed for tests. */
	async tick(signal?: AbortSignal): Promise<void> {
		await this.load();
		const { links, waiting } = this.links();
		const ids = new Set([...links.map((link) => link.desired.id), ...waiting]);
		let dropped = false;
		for (const id of [...this.runtime.keys()]) if (!ids.has(id)) this.runtime.delete(id);
		for (const id of Object.keys(this.checkpoints.links))
			if (!ids.has(id)) {
				delete this.checkpoints.links[id];
				dropped = true;
			}
		if (dropped) await this.save();
		for (const link of links) {
			if (signal?.aborted) return;
			const state = this.stateOf(link.desired.id);
			// After a restart, a link whose last pass finished recently waits for its interval;
			// one with a checkpointed pass in progress resumes now.
			const saved = this.checkpoints.links[link.desired.id];
			if (state.attemptAt === null && state.nextPassAt === 0 && saved?.lastSyncAt && !saved.pass)
				state.nextPassAt = Date.parse(saved.lastSyncAt) + link.desired.intervalSeconds * 1000;
			if (this.now() < state.nextPassAt) continue;
			await this.pass(link, signal);
		}
	}

	/** Reports for the next heartbeat: a link that changed, or one not reported for a minute. */
	pendingReports(): StorageReplicationReport[] {
		const now = this.now();
		const out: StorageReplicationReport[] = [];
		for (const [id, state] of [...this.runtime.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			if (!state.attemptAt) continue;
			if (!state.dirty && now - state.reportedAt < REPORT_EVERY_MS) continue;
			out.push(this.reportOf(id, state));
		}
		return out.slice(0, 100);
	}

	/** Call only after the control plane accepted a heartbeat that carried `sent`. */
	acknowledgeReports(sent: readonly StorageReplicationReport[]): void {
		const now = this.now();
		for (const report of sent) {
			const state = this.runtime.get(report.id);
			if (!state) continue;
			state.copiedObjects = Math.max(0, state.copiedObjects - report.copiedObjects);
			state.copiedBytes = Math.max(0, state.copiedBytes - report.copiedBytes);
			state.dirty = state.copiedObjects > 0 || state.copiedBytes > 0;
			state.reportedAt = now;
		}
	}

	private reportOf(id: string, state: LinkRuntime): StorageReplicationReport {
		return {
			id,
			status: state.status,
			lastSyncAt: this.checkpoints.links[id]?.lastSyncAt ?? null,
			attemptAt: state.attemptAt!,
			pending: state.pending,
			copiedObjects: state.copiedObjects,
			copiedBytes: state.copiedBytes,
			error: state.error ? state.error.slice(0, 500) : null,
			buckets: [...state.buckets.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20),
		};
	}

	/**
	 * Links this node runs now: from running instances whose activation carries the link secret.
	 * `waiting` are links whose secret has not arrived yet (reported, not run).
	 */
	private links(): { links: ReplicationLink[]; waiting: string[] } {
		const links: ReplicationLink[] = [];
		const waiting: string[] = [];
		for (const target of this.source.storageTargets()) {
			if (target.status !== 'running') continue;
			for (const desired of target.desired.replication ?? []) {
				const secret = target.admin.replication?.[desired.id];
				if (!secret) {
					this.markWaiting(desired.id, 'Waiting for the link key in a fresh activation.');
					waiting.push(desired.id);
					continue;
				}
				links.push(this.linkFor(target, desired, secret));
			}
		}
		return { links, waiting };
	}

	/** Whether a link is still desired on a running instance; checked at checkpoints mid-pass. */
	private stillWanted(id: string): boolean {
		try {
			return this.source
				.storageTargets()
				.some((target) => target.status === 'running' && (target.desired.replication ?? []).some((link) => link.id === id));
		} catch {
			return true;
		}
	}

	private linkFor(target: StorageTarget, desired: StorageReplicationDesired, secret: string): ReplicationLink {
		return {
			desired,
			storageId: target.id,
			local: this.storeFor({
				endpoint: `http://127.0.0.1:${target.port}`,
				accessKeyId: target.admin.rootAccessKeyId,
				secretAccessKey: target.admin.rootSecretAccessKey,
			}),
			peer: this.storeFor({
				endpoint: desired.endpoint,
				host: desired.host,
				accessKeyId: desired.accessKeyId,
				secretAccessKey: secret,
			}),
			secrets: [target.admin.rootSecretAccessKey, secret],
		};
	}

	private stateOf(id: string): LinkRuntime {
		let state = this.runtime.get(id);
		if (!state) {
			state = {
				nextPassAt: 0,
				failures: 0,
				status: 'syncing',
				attemptAt: null,
				pending: 0,
				error: null,
				buckets: new Map(),
				copiedObjects: 0,
				copiedBytes: 0,
				dirty: false,
				reportedAt: 0,
			};
			this.runtime.set(id, state);
		}
		return state;
	}

	private markWaiting(id: string, message: string): void {
		const state = this.stateOf(id);
		if (state.error === message) return;
		state.status = 'error';
		state.error = message;
		state.attemptAt = new Date(this.now()).toISOString();
		state.dirty = true;
	}

	/** One full pass over every replicated bucket of a link (resuming a checkpointed pass). */
	private async pass(link: ReplicationLink, outer?: AbortSignal): Promise<void> {
		const id = link.desired.id;
		const state = this.stateOf(id);
		const checkpoint = (this.checkpoints.links[id] ??= { lastSyncAt: null, buckets: {}, pass: null });
		const startedAt = this.now();
		const pass = (checkpoint.pass ??= { startedAt: new Date(startedAt).toISOString(), done: {}, bucket: null, afterKey: null });
		if (pass.bucket && !link.desired.buckets.includes(pass.bucket)) {
			pass.bucket = null;
			pass.afterKey = null;
		}
		const controller = new AbortController();
		const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
		this.active = { id, controller };
		state.status = 'syncing';
		state.attemptAt = new Date(startedAt).toISOString();
		state.error = null;
		state.dirty = true;
		const [source, target] = link.desired.direction === 'push' ? [link.local, link.peer] : [link.peer, link.local];
		try {
			for (const bucket of [...link.desired.buckets].sort()) {
				if (signal.aborted) return;
				if (pass.done[bucket]) {
					state.buckets.set(bucket, pass.done[bucket]!);
					continue;
				}
				const resumeAfter = pass.bucket === bucket ? pass.afterKey : null;
				pass.bucket = bucket;
				pass.afterKey = resumeAfter;
				const outcome = await this.syncBucket(link, source, target, bucket, resumeAfter, pass, signal);
				if (signal.aborted) return;
				const report: StorageReplicationBucketReport = {
					name: bucket,
					status: outcome.error ? 'error' : 'in-sync',
					pending: outcome.failed,
					lastSyncAt: outcome.error ? (checkpoint.buckets[bucket] ?? null) : pass.startedAt,
					error: outcome.error ? scrub(outcome.error, link.secrets).slice(0, 500) : null,
				};
				if (!outcome.error) checkpoint.buckets[bucket] = pass.startedAt;
				pass.done[bucket] = report;
				pass.bucket = null;
				pass.afterKey = null;
				state.buckets.set(bucket, report);
				state.dirty = true;
				await this.save();
			}
			for (const name of [...state.buckets.keys()]) if (!link.desired.buckets.includes(name)) state.buckets.delete(name);
			const results = link.desired.buckets.map((bucket) => pass.done[bucket]!).filter(Boolean);
			const failed = results.filter((result) => result.status === 'error');
			state.pending = results.reduce((sum, result) => sum + result.pending, 0);
			if (failed.length === 0) {
				checkpoint.lastSyncAt = pass.startedAt;
				state.status = 'in-sync';
				state.error = null;
				state.failures = 0;
				state.nextPassAt = Date.parse(pass.startedAt) + link.desired.intervalSeconds * 1000;
			} else {
				state.status = 'error';
				state.error = failed.map((result) => `${result.name}: ${result.error}`).join('; ').slice(0, 500);
				this.scheduleRetry(state, link);
			}
			checkpoint.pass = null;
			state.dirty = true;
			await this.save();
			this.log(
				failed.length === 0 ? 'info' : 'warn',
				`Storage replication ${id}: pass ${failed.length === 0 ? 'in sync' : `finished with errors (${state.error})`}`,
			);
		} catch (error) {
			state.status = 'error';
			state.error = scrub(errorText(error), link.secrets).slice(0, 500);
			state.dirty = true;
			this.scheduleRetry(state, link);
			await this.save().catch(() => undefined);
			this.log('warn', `Storage replication ${id}: ${state.error}`);
		} finally {
			if (this.active?.id === id) this.active = null;
		}
	}

	private scheduleRetry(state: LinkRuntime, link: ReplicationLink): void {
		state.failures += 1;
		const delay = Math.min(link.desired.intervalSeconds * 1000, RETRY_BASE_MS * 2 ** Math.min(6, state.failures - 1));
		state.nextPassAt = this.now() + delay;
	}

	/**
	 * Walk both listings in key order. Copies happen as the walk goes; deletes are collected and
	 * applied only once the source listing is complete.
	 */
	private async syncBucket(
		link: ReplicationLink,
		source: ReplicaStore,
		target: ReplicaStore,
		bucket: string,
		startAfter: string | null,
		pass: NonNullable<LinkCheckpoint['pass']>,
		signal: AbortSignal,
	): Promise<{ failed: number; error: string | null }> {
		const state = this.stateOf(link.desired.id);
		const sourceList = listAll(source, bucket, startAfter);
		const targetList = listAll(target, bucket, startAfter);
		const deletes: string[] = [];
		let failed = 0;
		let firstFailure: string | null = null;
		let handled = 0;
		let checkpointAt = this.now();
		const done = async (key: string) => {
			pass.afterKey = key;
			handled += 1;
			if (handled % CHECKPOINT_EVERY_OBJECTS === 0 || this.now() - checkpointAt >= CHECKPOINT_EVERY_MS) {
				checkpointAt = this.now();
				await this.save();
				// A removed link (or a stopped instance) ends the pass at the next checkpoint.
				if (!this.stillWanted(link.desired.id)) this.active?.controller.abort();
			}
		};
		let s: ReplicaObject | null;
		let t: ReplicaObject | null;
		try {
			s = await sourceList.next();
		} catch (error) {
			return { failed: 0, error: `listing the source: ${errorText(error)}` };
		}
		try {
			t = await targetList.next();
		} catch (error) {
			return { failed: 0, error: `listing the target: ${errorText(error)}` };
		}
		while (s || t) {
			if (signal.aborted) return { failed, error: 'stopped' };
			const order = !s ? 1 : !t ? -1 : compareKeys(s.key, t.key);
			if (order > 0) {
				// On the target only.
				deletes.push(t!.key);
				try {
					t = await targetList.next();
				} catch (error) {
					return { failed, error: `listing the target: ${errorText(error)}` };
				}
				continue;
			}
			const object = s!;
			const counterpart = order === 0 ? t! : undefined;
			if (needsCopy(object, counterpart)) {
				try {
					if (!addressableKey(object.key)) throw new Error('the key has a "." or ".." path segment');
					const bytes = await this.copyObject(source, target, bucket, object);
					if (bytes !== null) {
						state.copiedObjects += 1;
						state.copiedBytes += bytes;
					}
				} catch (error) {
					failed += 1;
					firstFailure ??= `${object.key}: ${errorText(error)}`;
				}
				state.dirty = true;
			}
			await done(object.key);
			try {
				s = await sourceList.next();
				if (order === 0) t = await targetList.next();
			} catch (error) {
				return { failed, error: `listing: ${errorText(error)}` };
			}
		}
		// The source listing completed without an error: what is left only on the target is gone.
		if (link.desired.deletes && deletes.length > 0) {
			try {
				for (let index = 0; index < deletes.length; index += DELETE_BATCH) {
					if (signal.aborted) return { failed, error: 'stopped' };
					await target.deleteObjects(bucket, deletes.slice(index, index + DELETE_BATCH));
				}
				this.log('info', `Storage replication ${link.desired.id}: ${bucket}: removed ${deletes.length} deleted objects`);
			} catch (error) {
				failed += deletes.length;
				firstFailure ??= `deleting: ${errorText(error)}`;
			}
		}
		return { failed, error: failed > 0 ? `${failed} object(s) not copied (${firstFailure})` : null };
	}

	/** Copy one object. Returns the bytes copied, or null when it vanished from the source meanwhile. */
	private async copyObject(source: ReplicaStore, target: ReplicaStore, bucket: string, object: ReplicaObject): Promise<number | null> {
		if (object.size <= this.partBytes) {
			const read = await source.getObject(bucket, object.key);
			if (!read) return null;
			await target.putObject(bucket, object.key, read.body, read.headers);
			return read.body.length;
		}
		const head = await source.headObject(bucket, object.key);
		if (!head) return null;
		if (head.size <= this.partBytes) {
			const read = await source.getObject(bucket, object.key, { ifMatch: head.etag });
			if (!read) return null;
			await target.putObject(bucket, object.key, read.body, read.headers);
			return read.body.length;
		}
		const partBytes = Math.max(this.partBytes, Math.ceil(head.size / MAX_PARTS));
		const uploadId = await target.createMultipart(bucket, object.key, head.headers);
		try {
			const parts: Array<{ partNumber: number; etag: string }> = [];
			for (let offset = 0, partNumber = 1; offset < head.size; offset += partBytes, partNumber++) {
				const end = Math.min(offset + partBytes, head.size) - 1;
				const read = await source.getObject(bucket, object.key, { range: [offset, end], ifMatch: head.etag });
				if (!read) throw new Error('the source object was removed during the copy');
				if (read.body.length !== end - offset + 1)
					throw new Error(`short read at ${offset}: ${read.body.length} of ${end - offset + 1} bytes`);
				parts.push({ partNumber, etag: await target.uploadPart(bucket, object.key, uploadId, partNumber, read.body) });
			}
			await target.completeMultipart(bucket, object.key, uploadId, parts);
			return head.size;
		} catch (error) {
			await target.abortMultipart(bucket, object.key, uploadId).catch(() => undefined);
			throw error;
		}
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<CheckpointFile>;
			if (raw.version === 1 && raw.links && typeof raw.links === 'object') this.checkpoints = { version: 1, links: raw.links };
		} catch {
			// Missing or unreadable: start fresh; the next pass compares both sides anyway.
		}
	}

	private async save(): Promise<void> {
		try {
			await atomicWriteFile(this.statePath, JSON.stringify(this.checkpoints));
		} catch (error) {
			this.log('warn', `Storage replication: could not save progress: ${errorText(error)}`);
		}
	}
}

/** Lazily pages through a bucket listing, one object at a time. */
function listAll(store: ReplicaStore, bucket: string, startAfter: string | null): { next(): Promise<ReplicaObject | null> } {
	let page: ReplicaObject[] = [];
	let index = 0;
	let token: string | null = null;
	let exhausted = false;
	let first = true;
	return {
		async next() {
			while (index >= page.length) {
				if (exhausted) return null;
				const result = await store.listObjects(bucket, first ? { startAfter } : { token });
				first = false;
				page = result.objects;
				index = 0;
				token = result.next;
				if (!token) exhausted = true;
			}
			return page[index++]!;
		},
	};
}

function copyHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of COPY_HEADERS) {
		const value = headers.get(name);
		if (value) out[name] = value;
	}
	headers.forEach((value, name) => {
		if (name.toLowerCase().startsWith('x-amz-meta-')) out[name.toLowerCase()] = value;
	});
	return out;
}

function bucketPath(bucket: string): string {
	if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new StorageApiError(`Invalid bucket name ${JSON.stringify(bucket)}`, 0, null);
	return `/${bucket}`;
}

function objectPath(bucket: string, key: string): string {
	return `${bucketPath(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function trimEtag(value: string | null): string | null {
	if (!value) return null;
	return value.replace(/^W\//, '').replace(/^"|"$/g, '') || null;
}

function parseDate(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function scrub(message: string, secrets: readonly string[]): string {
	let out = message;
	for (const secret of secrets) if (secret) out = out.split(secret).join('***');
	return out;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
	return String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}
