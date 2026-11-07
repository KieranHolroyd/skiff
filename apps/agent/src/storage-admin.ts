import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import {
	STORAGE_NOTIFY_ARN,
	STORAGE_REGION,
	STORAGE_USER_KEY_PREFIX,
	publicReadBucketPolicy,
	storagePolicyName,
	storageUserPolicy,
	type BucketAccess,
	type BucketCorsRule,
	type BucketLifecycleRule,
	type BucketObjectLock,
	type StorageAdmin,
	type StorageBucketConfigReport,
	type StorageBucketDeletion,
	type StorageGrant,
	type StorageRootKeyReport,
	type WorkloadObjectStorage,
	type WorkloadStatus,
} from '@skiff/contracts';

/**
 * Managed object storage on the node (docs/OBJECT-STORAGE.md S4, S8). Each healthy RustFS
 * instance is converged over its loopback port with the root key, signed with SigV4:
 *
 * - desired buckets are created and their anonymous policy set (`public-read`) or removed;
 * - a bucket is only ever deleted through `deleteBuckets`, never because it is missing from
 *   `buckets` (a desired-state bug must not wipe data, as D59). `force` empties it first;
 * - every desired scoped key gets a RustFS user with a canned policy limited to its grants.
 *   `SKF*` users and `skiff-*` policies that are not desired are removed; anything else
 *   (built-in policies, users a human created with the root key) is never touched.
 *
 * The root key and user secrets come from the activation's `storageAdmin` and live only in the
 * workload runtime's memory. Every failure is logged and retried on the next round.
 */

export const STORAGE_RECONCILE_INTERVAL_MS = 60_000;
/** Re-assert bucket policies and users even when nothing changed, to repair out-of-band edits. */
const FULL_REASSERT_MS = 15 * 60_000;
/** A forced delete empties at most this many 1000-key pages per round, then continues next round. */
const FORCE_DELETE_PAGES_PER_ROUND = 50;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * A root key is reported `rejected` after this many consecutive authentication failures, spread
 * over at least `ROOT_KEY_REJECT_MIN_MS`: right after a new activation the old server may still be
 * running for a moment, and its refusals must not roll back a rotation that is about to work.
 */
export const ROOT_KEY_REJECT_FAILURES = 3;
export const ROOT_KEY_REJECT_MIN_MS = 2 * 60_000;

/** What the reconciler needs to know about one instance; provided by the workload runtime. */
export interface StorageTarget {
	id: string;
	activationVersion: string;
	/** Loopback host port. */
	port: number;
	status: WorkloadStatus;
	memoryBytes?: number;
	admin: StorageAdmin;
	desired: WorkloadObjectStorage;
}

export interface StorageTargetSource {
	storageTargets(): StorageTarget[];
}

export interface S3Object {
	key: string;
	size: number;
}

export interface S3Upload {
	key: string;
	uploadId: string;
}

export interface RustfsUser {
	policyName: string | null;
	status: string | null;
}

/** The S3 and admin calls the agent makes. `RustfsApi` in production, a fake in tests. */
export interface StorageApi {
	listBuckets(): Promise<string[]>;
	/** `objectLock` must be set at creation; RustFS enables versioning with it. */
	createBucket(name: string, options?: { objectLock?: boolean }): Promise<void>;
	/** `missing` covers 404/NoSuchBucket. */
	deleteBucket(name: string): Promise<'deleted' | 'not-empty' | 'missing'>;
	putBucketPolicy(name: string, policy: Record<string, unknown>): Promise<void>;
	deleteBucketPolicy(name: string): Promise<void>;
	getBucketVersioning(name: string): Promise<'enabled' | 'suspended' | 'unset'>;
	putBucketVersioning(name: string, enabled: boolean): Promise<void>;
	getBucketLifecycle(name: string): Promise<BucketLifecycleRule[]>;
	putBucketLifecycle(name: string, rules: BucketLifecycleRule[]): Promise<void>;
	deleteBucketLifecycle(name: string): Promise<void>;
	getBucketCors(name: string): Promise<BucketCorsRule[]>;
	putBucketCors(name: string, rules: BucketCorsRule[]): Promise<void>;
	deleteBucketCors(name: string): Promise<void>;
	/** Point every create/delete event at the `skiff` webhook target, or clear the config (D122). */
	putBucketNotifications(name: string, enabled: boolean): Promise<void>;
	/** Hard byte cap; null clears it. */
	getBucketQuota(name: string): Promise<number | null>;
	putBucketQuota(name: string, bytes: number | null): Promise<void>;
	getObjectLock(name: string): Promise<BucketObjectLock | null>;
	putObjectLock(name: string, lock: BucketObjectLock): Promise<void>;
	listObjects(bucket: string, continuationToken?: string | null): Promise<{ objects: S3Object[]; next: string | null }>;
	deleteObjects(bucket: string, keys: string[]): Promise<void>;
	listUploads(bucket: string): Promise<S3Upload[]>;
	abortUpload(bucket: string, upload: S3Upload): Promise<void>;
	listUsers(): Promise<Record<string, RustfsUser>>;
	addUser(accessKeyId: string, secretKey: string): Promise<void>;
	removeUser(accessKeyId: string): Promise<void>;
	listCannedPolicies(): Promise<string[]>;
	addCannedPolicy(name: string, policy: Record<string, unknown>): Promise<void>;
	removeCannedPolicy(name: string): Promise<void>;
	setUserPolicy(policyName: string, accessKeyId: string): Promise<void>;
	/** `GET /rustfs/admin/v3/datausageinfo`, as returned. */
	dataUsage(): Promise<Record<string, unknown>>;
}

export class StorageApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
	) {
		super(message);
		this.name = 'StorageApiError';
	}
}

export type SignedFetch = (request: Request) => Promise<Response>;

export interface RustfsApiOptions {
	/** `http://127.0.0.1:<port>`. */
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Defaults to the global `fetch`; tests inject a fake. */
	fetch?: SignedFetch;
	timeoutMs?: number;
}

/** RustFS S3 + `admin/v3` client (verified against 1.0.4: plain JSON bodies, SigV4 service `s3`). */
export class RustfsApi implements StorageApi {
	private readonly endpoint: string;
	private readonly aws: AwsClient;
	private readonly fetchImpl: SignedFetch;
	private readonly timeoutMs: number;

	constructor(options: RustfsApiOptions) {
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.aws = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			service: 's3',
			region: STORAGE_REGION,
		});
		this.fetchImpl = options.fetch ?? ((request) => fetch(request));
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	async listBuckets(): Promise<string[]> {
		const text = await this.call('GET', '/', { expect: [200] });
		return blocks(text, 'Bucket').map((block) => tagValue(block, 'Name') ?? '').filter(Boolean);
	}

	async createBucket(name: string, options: { objectLock?: boolean } = {}): Promise<void> {
		try {
			await this.call('PUT', `/${bucketPath(name)}`, {
				expect: [200],
				...(options.objectLock ? { headers: { 'x-amz-bucket-object-lock-enabled': 'true' } } : {}),
			});
		} catch (error) {
			// Created by an earlier, interrupted round.
			if (error instanceof StorageApiError && error.code === 'BucketAlreadyOwnedByYou') return;
			throw error;
		}
	}

	async deleteBucket(name: string): Promise<'deleted' | 'not-empty' | 'missing'> {
		try {
			await this.call('DELETE', `/${bucketPath(name)}`, { expect: [200, 204] });
			return 'deleted';
		} catch (error) {
			if (error instanceof StorageApiError) {
				if (error.status === 404 || error.code === 'NoSuchBucket') return 'missing';
				if (error.status === 409 || error.code === 'BucketNotEmpty') return 'not-empty';
			}
			throw error;
		}
	}

	async putBucketPolicy(name: string, policy: Record<string, unknown>): Promise<void> {
		await this.call('PUT', `/${bucketPath(name)}?policy`, {
			body: JSON.stringify(policy),
			headers: { 'content-type': 'application/json' },
			expect: [200, 204],
		});
	}

	async deleteBucketPolicy(name: string): Promise<void> {
		try {
			await this.call('DELETE', `/${bucketPath(name)}?policy`, { expect: [200, 204] });
		} catch (error) {
			if (error instanceof StorageApiError && error.code === 'NoSuchBucketPolicy') return;
			throw error;
		}
	}

	async getBucketVersioning(name: string): Promise<'enabled' | 'suspended' | 'unset'> {
		const text = await this.call('GET', `/${bucketPath(name)}?versioning`, { expect: [200] });
		const status = tagValue(text, 'Status');
		return status === 'Enabled' ? 'enabled' : status === 'Suspended' ? 'suspended' : 'unset';
	}

	async putBucketVersioning(name: string, enabled: boolean): Promise<void> {
		const body =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${enabled ? 'Enabled' : 'Suspended'}</Status></VersioningConfiguration>`;
		await this.call('PUT', `/${bucketPath(name)}?versioning`, {
			body,
			headers: { 'content-type': 'application/xml' },
			expect: [200, 204],
		});
	}

	async getBucketLifecycle(name: string): Promise<BucketLifecycleRule[]> {
		try {
			const text = await this.call('GET', `/${bucketPath(name)}?lifecycle`, { expect: [200] });
			return parseLifecycleXml(text);
		} catch (error) {
			if (isMissingConfiguration(error)) return [];
			throw error;
		}
	}

	async putBucketLifecycle(name: string, rules: BucketLifecycleRule[]): Promise<void> {
		await this.call('PUT', `/${bucketPath(name)}?lifecycle`, {
			body: lifecycleXml(rules),
			headers: { 'content-type': 'application/xml' },
			expect: [200, 204],
		});
	}

	async deleteBucketLifecycle(name: string): Promise<void> {
		try {
			await this.call('DELETE', `/${bucketPath(name)}?lifecycle`, { expect: [200, 204] });
		} catch (error) {
			if (isMissingConfiguration(error)) return;
			throw error;
		}
	}

	async getBucketCors(name: string): Promise<BucketCorsRule[]> {
		try {
			const text = await this.call('GET', `/${bucketPath(name)}?cors`, { expect: [200] });
			return parseCorsXml(text);
		} catch (error) {
			if (isMissingConfiguration(error)) return [];
			throw error;
		}
	}

	async putBucketCors(name: string, rules: BucketCorsRule[]): Promise<void> {
		await this.call('PUT', `/${bucketPath(name)}?cors`, {
			body: corsXml(rules),
			headers: { 'content-type': 'application/xml' },
			expect: [200, 204],
		});
	}

	async deleteBucketCors(name: string): Promise<void> {
		try {
			await this.call('DELETE', `/${bucketPath(name)}?cors`, { expect: [200, 204] });
		} catch (error) {
			if (isMissingConfiguration(error)) return;
			throw error;
		}
	}

	async putBucketNotifications(name: string, enabled: boolean): Promise<void> {
		await this.call('PUT', `/${bucketPath(name)}?notification`, {
			body: notificationXml(enabled),
			headers: { 'content-type': 'application/xml' },
			expect: [200, 204],
		});
	}

	async getBucketQuota(name: string): Promise<number | null> {
		try {
			const value = asRecord(await this.json('GET', `/rustfs/admin/v3/quota/${bucketPath(name)}`));
			const raw = value.quota ?? value.quota_limit ?? value.size ?? value.limit;
			const bytes = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
			return Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : null;
		} catch (error) {
			if (error instanceof StorageApiError && (error.status === 404 || error.code === 'NoSuchBucketQuota')) return null;
			throw error;
		}
	}

	async putBucketQuota(name: string, bytes: number | null): Promise<void> {
		if (bytes === null) {
			try {
				await this.call('DELETE', `/rustfs/admin/v3/quota/${bucketPath(name)}`, { expect: [200, 204] });
			} catch (error) {
				if (error instanceof StorageApiError && (error.status === 404 || error.code === 'NoSuchBucketQuota')) return;
				throw error;
			}
			return;
		}
		await this.call('PUT', `/rustfs/admin/v3/quota/${bucketPath(name)}`, {
			body: JSON.stringify({ quota: bytes, quota_type: 'HARD' }),
			headers: { 'content-type': 'application/json' },
			expect: [200, 204],
		});
	}

	async getObjectLock(name: string): Promise<BucketObjectLock | null> {
		try {
			const text = await this.call('GET', `/${bucketPath(name)}?object-lock`, { expect: [200] });
			const mode = tagValue(text, 'Mode');
			const days = Number(tagValue(text, 'Days') ?? 0);
			if (!mode || !Number.isFinite(days) || days <= 0) return null;
			return { mode: mode.toLowerCase() === 'compliance' ? 'compliance' : 'governance', retainDays: Math.trunc(days) };
		} catch (error) {
			if (isMissingConfiguration(error)) return null;
			throw error;
		}
	}

	async putObjectLock(name: string, lock: BucketObjectLock): Promise<void> {
		const mode = lock.mode === 'compliance' ? 'COMPLIANCE' : 'GOVERNANCE';
		const body =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
			'<ObjectLockEnabled>Enabled</ObjectLockEnabled>' +
			`<Rule><DefaultRetention><Mode>${mode}</Mode><Days>${lock.retainDays}</Days></DefaultRetention></Rule>` +
			'</ObjectLockConfiguration>';
		await this.call('PUT', `/${bucketPath(name)}?object-lock`, {
			body,
			headers: { 'content-type': 'application/xml' },
			expect: [200, 204],
		});
	}

	async listObjects(
		bucket: string,
		continuationToken?: string | null,
	): Promise<{ objects: S3Object[]; next: string | null }> {
		const params = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
		if (continuationToken) params.set('continuation-token', continuationToken);
		const text = await this.call('GET', `/${bucketPath(bucket)}?${params.toString()}`, { expect: [200] });
		const objects = blocks(text, 'Contents').map((block) => ({
			key: tagValue(block, 'Key') ?? '',
			size: nonNegative(Number(tagValue(block, 'Size') ?? 0)),
		}));
		const truncated = tagValue(text, 'IsTruncated') === 'true';
		const next = truncated ? tagValue(text, 'NextContinuationToken') : null;
		return { objects: objects.filter((object) => object.key !== ''), next: next || null };
	}

	async deleteObjects(bucket: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
			.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
			.join('')}</Delete>`;
		const text = await this.call('POST', `/${bucketPath(bucket)}?delete`, {
			body,
			headers: {
				'content-type': 'application/xml',
				// S3 requires an integrity header on DeleteObjects; RustFS accepts it either way.
				'content-md5': createHash('md5').update(body).digest('base64'),
			},
			expect: [200],
		});
		const errors = blocks(text, 'Error');
		if (errors.length > 0) {
			const first = errors[0]!;
			throw new StorageApiError(
				`DeleteObjects in ${bucket}: ${errors.length} failed (${tagValue(first, 'Code') ?? 'error'}: ${tagValue(first, 'Message') ?? ''})`,
				200,
				tagValue(first, 'Code'),
			);
		}
	}

	async listUploads(bucket: string): Promise<S3Upload[]> {
		const text = await this.call('GET', `/${bucketPath(bucket)}?uploads`, { expect: [200] });
		return blocks(text, 'Upload')
			.map((block) => ({ key: tagValue(block, 'Key') ?? '', uploadId: tagValue(block, 'UploadId') ?? '' }))
			.filter((upload) => upload.key !== '' && upload.uploadId !== '');
	}

	async abortUpload(bucket: string, upload: S3Upload): Promise<void> {
		try {
			await this.call(
				'DELETE',
				`/${bucketPath(bucket)}/${objectPath(upload.key)}?uploadId=${encodeURIComponent(upload.uploadId)}`,
				{ expect: [200, 204] },
			);
		} catch (error) {
			if (error instanceof StorageApiError && (error.status === 404 || error.code === 'NoSuchUpload')) return;
			throw error;
		}
	}

	async listUsers(): Promise<Record<string, RustfsUser>> {
		const value = await this.json('GET', '/rustfs/admin/v3/list-users');
		const users: Record<string, RustfsUser> = {};
		for (const [key, raw] of Object.entries(asRecord(value))) {
			const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
			users[key] = {
				policyName: typeof record.policyName === 'string' ? record.policyName : null,
				status: typeof record.status === 'string' ? record.status : null,
			};
		}
		return users;
	}

	async addUser(accessKeyId: string, secretKey: string): Promise<void> {
		await this.call('PUT', `/rustfs/admin/v3/add-user?accessKey=${encodeURIComponent(accessKeyId)}`, {
			body: JSON.stringify({ secretKey, status: 'enabled' }),
			headers: { 'content-type': 'application/json' },
			expect: [200, 204],
		});
	}

	async removeUser(accessKeyId: string): Promise<void> {
		await this.call('DELETE', `/rustfs/admin/v3/remove-user?accessKey=${encodeURIComponent(accessKeyId)}`, {
			expect: [200, 204],
		});
	}

	async listCannedPolicies(): Promise<string[]> {
		return Object.keys(asRecord(await this.json('GET', '/rustfs/admin/v3/list-canned-policies')));
	}

	async addCannedPolicy(name: string, policy: Record<string, unknown>): Promise<void> {
		await this.call('PUT', `/rustfs/admin/v3/add-canned-policy?name=${encodeURIComponent(name)}`, {
			body: JSON.stringify(policy),
			headers: { 'content-type': 'application/json' },
			expect: [200, 204],
		});
	}

	async removeCannedPolicy(name: string): Promise<void> {
		await this.call('DELETE', `/rustfs/admin/v3/remove-canned-policy?name=${encodeURIComponent(name)}`, {
			expect: [200, 204],
		});
	}

	async setUserPolicy(policyName: string, accessKeyId: string): Promise<void> {
		const params = new URLSearchParams({ policyName, userOrGroup: accessKeyId, isGroup: 'false' });
		await this.call('PUT', `/rustfs/admin/v3/set-user-or-group-policy?${params.toString()}`, {
			expect: [200, 204],
		});
	}

	async dataUsage(): Promise<Record<string, unknown>> {
		return asRecord(await this.json('GET', '/rustfs/admin/v3/datausageinfo'));
	}

	private async json(method: string, path: string): Promise<unknown> {
		const text = await this.call(method, path, { expect: [200] });
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new StorageApiError(`${method} ${stripQuery(path)}: response is not JSON`, 200, null);
		}
	}

	private async call(
		method: string,
		path: string,
		options: { body?: string; headers?: Record<string, string>; expect: number[] },
	): Promise<string> {
		const signed = await this.aws.sign(`${this.endpoint}${path}`, {
			method,
			headers: options.headers ?? {},
			...(options.body !== undefined ? { body: options.body } : {}),
		});
		const response = await this.fetchImpl(
			new Request(signed, { signal: AbortSignal.timeout(this.timeoutMs) }),
		);
		const text = await response.text().catch(() => '');
		if (!options.expect.includes(response.status)) {
			const code = tagValue(text, 'Code') ?? jsonCode(text);
			const message = tagValue(text, 'Message') ?? text.slice(0, 200);
			// Never echo the request: bodies can carry user secrets (add-user).
			throw new StorageApiError(
				`${method} ${stripQuery(path)} -> ${response.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
				response.status,
				code,
			);
		}
		return text;
	}
}

/** Loopback client for one instance, signed with its root key. */
export function rustfsApiFor(target: Pick<StorageTarget, 'port' | 'admin'>): StorageApi {
	return new RustfsApi({
		endpoint: `http://127.0.0.1:${target.port}`,
		accessKeyId: target.admin.rootAccessKeyId,
		secretAccessKey: target.admin.rootSecretAccessKey,
	});
}

// ------------------------------------------------------------------ reconciler

export type StorageAdminLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface StorageReconcilerOptions {
	source: StorageTargetSource;
	apiFor?: (target: StorageTarget) => StorageApi;
	log?: StorageAdminLog;
	now?: () => number;
	forceDeletePagesPerRound?: number;
}

interface InstanceState {
	activationVersion: string;
	/** Anonymous access last applied per bucket. */
	policies: Map<string, BucketAccess>;
	/** Bucket configuration signature last applied (config version + desired fields). */
	bucketConfigs: Map<string, string>;
	/** `keysVersion|grants` last applied per scoped key. */
	users: Map<string, string>;
	lastFullAt: number;
}

/** What the reconciler last proved about one instance's activation root key (§5). */
interface RootKeyState {
	accessKeyId: string;
	failures: number;
	firstFailureAt: number | null;
	/** The outcome last queued for this key. */
	reported: StorageRootKeyReport['result'] | null;
}

export class StorageReconciler {
	private readonly source: StorageTargetSource;
	private readonly apiFor: (target: StorageTarget) => StorageApi;
	private readonly log: StorageAdminLog;
	private readonly now: () => number;
	private readonly forceDeletePages: number;

	private readonly state = new Map<string, InstanceState>();
	/** Outcomes waiting for a heartbeat. */
	private deletions: StorageBucketDeletion[] = [];
	/** Latest convergence outcome per bucket, waiting for a heartbeat. */
	private readonly configReports = new Map<string, StorageBucketConfigReport>();
	/** The status last queued per bucket, so a steady state does not report every minute. */
	private readonly reportedConfigs = new Map<string, string>();
	/**
	 * Deletions already decided, keyed `<id>/<bucket>/<force>`, kept while the entry is still in
	 * `deleteBuckets` so each outcome is reported once and the bucket is not deleted twice.
	 */
	private readonly decided = new Set<string>();
	private readonly rootKeys = new Map<string, RootKeyState>();
	/** Root key outcomes waiting for a heartbeat, by storage id. */
	private readonly rootKeyReports = new Map<string, StorageRootKeyReport>();
	private running: Promise<void> | null = null;
	private again = false;

	constructor(options: StorageReconcilerOptions) {
		this.source = options.source;
		this.apiFor = options.apiFor ?? rustfsApiFor;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.forceDeletePages = Math.max(1, options.forceDeletePagesPerRound ?? FORCE_DELETE_PAGES_PER_ROUND);
	}

	/** Outcomes for the next heartbeat's `storageBucketDeletions`. */
	pendingBucketDeletions(): StorageBucketDeletion[] {
		return this.deletions.map((deletion) => ({ ...deletion }));
	}

	/** Call only after the control plane accepted a heartbeat that carried these outcomes. */
	acknowledgeBucketDeletions(sent: readonly StorageBucketDeletion[]): void {
		const keys = new Set(sent.map(deletionKey));
		this.deletions = this.deletions.filter((deletion) => !keys.has(deletionKey(deletion)));
	}

	/** Bucket configuration outcomes for the next heartbeat. */
	pendingBucketConfigs(): StorageBucketConfigReport[] {
		return [...this.configReports.values()].map((report) => ({ ...report }));
	}

	/** Call only after the control plane accepted a heartbeat that carried these reports. */
	acknowledgeBucketConfigs(sent: readonly StorageBucketConfigReport[]): void {
		for (const report of sent) this.configReports.delete(configReportKey(report));
	}

	/**
	 * Root key outcomes for the next heartbeat's `storageRootKeys`: `accepted` once an admin call
	 * signed with the activation's root key succeeded, `rejected` after repeated auth failures.
	 * The control plane only acts on a report for a pending (rotating) key.
	 */
	pendingRootKeyReports(): StorageRootKeyReport[] {
		return [...this.rootKeyReports.values()].map((report) => ({ ...report }));
	}

	/** Call only after the control plane accepted a heartbeat that carried these reports. */
	acknowledgeRootKeyReports(sent: readonly StorageRootKeyReport[]): void {
		for (const report of sent) {
			const queued = this.rootKeyReports.get(report.storageId);
			if (queued && queued.accessKeyId === report.accessKeyId && queued.result === report.result)
				this.rootKeyReports.delete(report.storageId);
		}
	}

	/**
	 * Converge every running instance once. Never throws. A call while a round is in flight runs
	 * one more round afterwards (so a converge never waits on, or races, the minute loop).
	 */
	reconcile(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.round();
				} while (this.again);
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	private async round(): Promise<void> {
		let targets: StorageTarget[];
		try {
			targets = this.source.storageTargets();
		} catch (error) {
			this.log('warn', `Storage reconcile: no targets: ${errorText(error)}`);
			return;
		}
		const ids = new Set(targets.map((target) => target.id));
		for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
		for (const key of [...this.decided]) {
			const [id] = key.split('/');
			if (!ids.has(id!)) this.decided.delete(key);
		}
		for (const key of [...this.configReports.keys()]) {
			if (!ids.has(key.split('/')[0]!)) this.configReports.delete(key);
		}
		for (const key of [...this.reportedConfigs.keys()]) {
			if (!ids.has(key.split('/')[0]!)) this.reportedConfigs.delete(key);
		}
		for (const id of [...this.rootKeys.keys()]) if (!ids.has(id)) this.rootKeys.delete(id);
		for (const id of [...this.rootKeyReports.keys()]) if (!ids.has(id)) this.rootKeyReports.delete(id);
		for (const target of targets) {
			if (target.status !== 'running') continue;
			try {
				await this.reconcileOne(target);
			} catch (error) {
				this.log('warn', `Storage ${target.id}: reconcile failed: ${scrub(errorText(error), target)}`);
			}
		}
	}

	private stateFor(target: StorageTarget): InstanceState {
		let state = this.state.get(target.id);
		if (!state || state.activationVersion !== target.activationVersion) {
			// A new activation may be a fresh server (or new root key): re-assert everything.
			state = {
				activationVersion: target.activationVersion,
				policies: new Map(),
				bucketConfigs: new Map(),
				users: new Map(),
				lastFullAt: this.now(),
			};
			this.state.set(target.id, state);
		} else if (this.now() - state.lastFullAt >= FULL_REASSERT_MS) {
			state.policies.clear();
			state.bucketConfigs.clear();
			state.users.clear();
			state.lastFullAt = this.now();
		}
		return state;
	}

	private async reconcileOne(target: StorageTarget): Promise<void> {
		const api = this.apiFor(target);
		const state = this.stateFor(target);
		const desired = target.desired;
		let listed: string[];
		try {
			listed = await api.listBuckets();
		} catch (error) {
			this.noteRootKey(target, error);
			throw error;
		}
		this.noteRootKey(target, null);
		const existing = new Set(listed);

		// 1. Desired buckets, their anonymous access and their configuration.
		for (const bucket of desired.buckets) {
			try {
				if (!existing.has(bucket.name)) {
					await api.createBucket(bucket.name, { objectLock: Boolean(bucket.objectLock) });
					existing.add(bucket.name);
					state.policies.delete(bucket.name);
					state.bucketConfigs.delete(bucket.name);
					this.log('info', `Storage ${target.id}: created bucket ${bucket.name}`);
				}
				if (state.policies.get(bucket.name) !== bucket.access) {
					if (bucket.access === 'public-read') await api.putBucketPolicy(bucket.name, publicReadBucketPolicy(bucket.name));
					else await api.deleteBucketPolicy(bucket.name);
					state.policies.set(bucket.name, bucket.access);
				}
				await this.reconcileBucketConfig(target, api, bucket, state);
			} catch (error) {
				state.policies.delete(bucket.name);
				state.bucketConfigs.delete(bucket.name);
				this.log('warn', `Storage ${target.id}: bucket ${bucket.name}: ${scrub(errorText(error), target)}`);
			}
		}

		// 2. Deletions: only what Skiff asked for, never a bucket that is still desired.
		await this.deleteBuckets(target, api, existing, state);

		// 3. Scoped keys.
		await this.reconcileUsers(target, api, state);
	}

	/**
	 * Track whether the activation's root key works against the running server. Only
	 * authentication failures count towards `rejected`; a connection error (the server restarting)
	 * neither counts nor resets the streak.
	 */
	private noteRootKey(target: StorageTarget, error: unknown): void {
		const accessKeyId = target.admin.rootAccessKeyId;
		let state = this.rootKeys.get(target.id);
		if (!state || state.accessKeyId !== accessKeyId) {
			state = { accessKeyId, failures: 0, firstFailureAt: null, reported: null };
			this.rootKeys.set(target.id, state);
		}
		if (error === null) {
			state.failures = 0;
			state.firstFailureAt = null;
			if (state.reported !== 'accepted') {
				state.reported = 'accepted';
				this.rootKeyReports.set(target.id, { storageId: target.id, accessKeyId, result: 'accepted', message: null });
			}
			return;
		}
		if (!isAuthError(error)) return;
		const now = this.now();
		state.failures += 1;
		state.firstFailureAt ??= now;
		if (
			state.reported === null &&
			state.failures >= ROOT_KEY_REJECT_FAILURES &&
			now - state.firstFailureAt >= ROOT_KEY_REJECT_MIN_MS
		) {
			state.reported = 'rejected';
			const message = scrub(errorText(error), target).slice(0, 500);
			this.rootKeyReports.set(target.id, { storageId: target.id, accessKeyId, result: 'rejected', message });
			this.log('error', `Storage ${target.id}: RustFS keeps refusing root key ${accessKeyId}: ${message}`);
		}
	}

	/**
	 * Apply one bucket's desired configuration. A signature skips unchanged rounds; the periodic
	 * full re-assert repairs out-of-band edits. A missing RustFS capability is reported as
	 * `unsupported` instead of being silently ignored.
	 */
	private async reconcileBucketConfig(
		target: StorageTarget,
		api: StorageApi,
		bucket: WorkloadObjectStorage['buckets'][number],
		state: InstanceState,
	): Promise<void> {
		const signature = JSON.stringify({
			configVersion: bucket.configVersion,
			versioning: bucket.versioning,
			lifecycle: bucket.lifecycle,
			cors: bucket.cors,
			quotaBytes: bucket.quotaBytes,
			objectLock: bucket.objectLock,
			notifications: bucket.notifications,
		});
		if (state.bucketConfigs.get(bucket.name) === signature) return;

		const unsupported: string[] = [];
		const attempt = async (label: string, action: () => Promise<void>) => {
			try {
				await action();
			} catch (error) {
				if (isUnsupportedError(error)) {
					unsupported.push(label);
					return;
				}
				throw error;
			}
		};
		try {
			await attempt('versioning', () => api.putBucketVersioning(bucket.name, bucket.versioning));
			await attempt('lifecycle', () =>
				bucket.lifecycle.length > 0
					? api.putBucketLifecycle(bucket.name, bucket.lifecycle)
					: api.deleteBucketLifecycle(bucket.name),
			);
			await attempt('cors', () =>
				bucket.cors.length > 0 ? api.putBucketCors(bucket.name, bucket.cors) : api.deleteBucketCors(bucket.name),
			);
			await attempt('quota', () => api.putBucketQuota(bucket.name, bucket.quotaBytes));
			if (bucket.objectLock)
				await attempt('object lock', () => api.putObjectLock(bucket.name, bucket.objectLock!));
			// Always asserted, so turning a rule off clears the config RustFS keeps for the bucket.
			await attempt('event notifications', () => api.putBucketNotifications(bucket.name, bucket.notifications));
			state.bucketConfigs.set(bucket.name, signature);
			if (unsupported.length > 0) {
				const message = `This RustFS build does not support ${unsupported.join(', ')}.`;
				this.reportBucketConfig(target, bucket.name, bucket.configVersion, 'unsupported', message);
				this.log('warn', `Storage ${target.id}: bucket ${bucket.name}: ${message}`);
			} else {
				this.reportBucketConfig(target, bucket.name, bucket.configVersion, 'converged', null);
			}
		} catch (error) {
			state.bucketConfigs.delete(bucket.name);
			const message = scrub(errorText(error), target);
			this.reportBucketConfig(target, bucket.name, bucket.configVersion, 'error', message);
			this.log('warn', `Storage ${target.id}: bucket ${bucket.name} config: ${message}`);
		}
	}

	private reportBucketConfig(
		target: StorageTarget,
		bucket: string,
		configVersion: number,
		status: StorageBucketConfigReport['status'],
		message: string | null,
	): void {
		const key = `${target.id}/${bucket}`;
		const signature = `${configVersion}/${status}/${message ?? ''}`;
		if (this.reportedConfigs.get(key) === signature) return;
		this.reportedConfigs.set(key, signature);
		const report: StorageBucketConfigReport = { storageId: target.id, bucket, configVersion, status, message };
		this.configReports.set(configReportKey(report), report);
	}

	private async deleteBuckets(
		target: StorageTarget,
		api: StorageApi,
		existing: Set<string>,
		state: InstanceState,
	): Promise<void> {
		const desiredNames = new Set(target.desired.buckets.map((bucket) => bucket.name));
		const listed = new Set<string>();
		for (const entry of target.desired.deleteBuckets) {
			const key = `${target.id}/${entry.name}/${entry.force ? 'force' : 'plain'}`;
			listed.add(key);
			if (this.decided.has(key)) continue;
			if (desiredNames.has(entry.name)) {
				this.log('warn', `Storage ${target.id}: not deleting bucket ${entry.name}: it is still desired`);
				continue;
			}
			try {
				let result: 'deleted' | 'not-empty' | 'missing' | 'continue';
				if (!existing.has(entry.name)) result = 'missing';
				else if (entry.force) result = await this.forceDelete(target, api, entry.name);
				else result = await api.deleteBucket(entry.name);
				if (result === 'continue') continue;
				// A forced delete that still finds objects (e.g. versions) keeps trying; it is never
				// reported as blocked, since a human already confirmed it.
				if (result === 'not-empty' && entry.force) {
					this.log('warn', `Storage ${target.id}: bucket ${entry.name} is still not empty after emptying; retrying`);
					continue;
				}
				this.decided.add(key);
				existing.delete(entry.name);
				state.policies.delete(entry.name);
				state.bucketConfigs.delete(entry.name);
				this.reportedConfigs.delete(`${target.id}/${entry.name}`);
				this.deletions.push({
					storageId: target.id,
					bucket: entry.name,
					result: result === 'not-empty' ? 'not-empty' : 'deleted',
				});
				this.log(
					'info',
					result === 'not-empty'
						? `Storage ${target.id}: bucket ${entry.name} is not empty; left in place`
						: `Storage ${target.id}: deleted bucket ${entry.name}`,
				);
			} catch (error) {
				this.log('warn', `Storage ${target.id}: deleting bucket ${entry.name}: ${scrub(errorText(error), target)}`);
			}
		}
		for (const key of [...this.decided]) {
			if (key.startsWith(`${target.id}/`) && !listed.has(key)) this.decided.delete(key);
		}
	}

	/** Empty a bucket (objects, then incomplete multipart uploads) and delete it. */
	private async forceDelete(
		target: StorageTarget,
		api: StorageApi,
		bucket: string,
	): Promise<'deleted' | 'not-empty' | 'missing' | 'continue'> {
		let removed = 0;
		for (let page = 0; ; page++) {
			if (page >= this.forceDeletePages) {
				this.log('info', `Storage ${target.id}: emptying bucket ${bucket} (${removed} objects so far); continuing next round`);
				return 'continue';
			}
			// Always list from the start: deleted keys drop out, so no continuation token is needed.
			const { objects } = await api.listObjects(bucket);
			if (objects.length === 0) break;
			await api.deleteObjects(
				bucket,
				objects.map((object) => object.key),
			);
			removed += objects.length;
		}
		for (const upload of await api.listUploads(bucket)) await api.abortUpload(bucket, upload);
		return api.deleteBucket(bucket);
	}

	private async reconcileUsers(target: StorageTarget, api: StorageApi, state: InstanceState): Promise<void> {
		const desiredUsers = new Map(target.desired.users.map((user) => [user.accessKeyId, user.grants]));
		const desiredPolicies = new Set(
			[...desiredUsers.entries()].filter(([, grants]) => grants.length > 0).map(([key]) => storagePolicyName(key)),
		);
		const actual = await api.listUsers();

		for (const [accessKeyId, grants] of desiredUsers) {
			if (!accessKeyId.startsWith(STORAGE_USER_KEY_PREFIX)) {
				this.log('warn', `Storage ${target.id}: ignoring user ${accessKeyId}: not a Skiff key`);
				continue;
			}
			const secret = target.admin.users[accessKeyId];
			if (!secret) {
				this.log('warn', `Storage ${target.id}: no secret for ${accessKeyId} yet; waiting for a fresh activation`);
				continue;
			}
			const policyName = storagePolicyName(accessKeyId);
			// Keyed on the activation's keysVersion: that is the version of the secret we hold.
			const signature = `${target.admin.keysVersion}|${grantsSignature(grants)}`;
			const current = actual[accessKeyId];
			const attached = grants.length === 0 ? true : current?.policyName === policyName;
			if (current && current.status === 'enabled' && attached && state.users.get(accessKeyId) === signature) continue;
			try {
				await api.addUser(accessKeyId, secret);
				if (grants.length > 0) {
					await api.addCannedPolicy(policyName, storageUserPolicy(grants));
					await api.setUserPolicy(policyName, accessKeyId);
				}
				state.users.set(accessKeyId, signature);
				this.log('info', `Storage ${target.id}: key ${accessKeyId} ready (${grants.length} bucket grants)`);
			} catch (error) {
				state.users.delete(accessKeyId);
				this.log('warn', `Storage ${target.id}: key ${accessKeyId}: ${scrub(errorText(error), target)}`);
			}
		}

		// Extras are always removed, so a detach takes effect on the next round.
		for (const accessKeyId of Object.keys(actual)) {
			if (!accessKeyId.startsWith(STORAGE_USER_KEY_PREFIX) || desiredUsers.has(accessKeyId)) continue;
			try {
				await api.removeUser(accessKeyId);
				state.users.delete(accessKeyId);
				this.log('info', `Storage ${target.id}: removed key ${accessKeyId}`);
			} catch (error) {
				this.log('warn', `Storage ${target.id}: removing key ${accessKeyId}: ${scrub(errorText(error), target)}`);
			}
		}
		const prefix = storagePolicyName('');
		for (const name of await api.listCannedPolicies()) {
			if (!name.startsWith(prefix) || desiredPolicies.has(name)) continue;
			try {
				await api.removeCannedPolicy(name);
				this.log('info', `Storage ${target.id}: removed policy ${name}`);
			} catch (error) {
				this.log('warn', `Storage ${target.id}: removing policy ${name}: ${scrub(errorText(error), target)}`);
			}
		}
	}
}

// ------------------------------------------------------------------ helpers

/** S3 answers a missing lifecycle/CORS/object-lock config with 404 + a NoSuch*Configuration code. */
function isMissingConfiguration(error: unknown): boolean {
	return (
		error instanceof StorageApiError &&
		(error.status === 404 ||
			error.code === 'NoSuchLifecycleConfiguration' ||
			error.code === 'NoSuchCORSConfiguration' ||
			error.code === 'NoSuchObjectLockConfiguration')
	);
}

/**
 * RustFS refused the key or its signature. The reconciler's first call is ListBuckets with the
 * root key, which no policy can deny, so any 401/403 there means the key itself is not accepted.
 */
export function isAuthError(error: unknown): boolean {
	if (!(error instanceof StorageApiError)) return false;
	return (
		error.code === 'InvalidAccessKeyId' ||
		error.code === 'SignatureDoesNotMatch' ||
		error.status === 401 ||
		error.status === 403
	);
}

/** A 404/405/501 from an admin or S3 endpoint means this RustFS build lacks the feature. */
export function isUnsupportedError(error: unknown): boolean {
	if (!(error instanceof StorageApiError)) return false;
	return (
		error.status === 404 ||
		error.status === 405 ||
		error.status === 501 ||
		error.code === 'NotImplemented' ||
		error.code === 'MethodNotAllowed' ||
		error.code === 'UnsupportedOperation'
	);
}

export function lifecycleXml(rules: readonly BucketLifecycleRule[]): string {
	const ruleXml = rules
		.map((rule) => {
			const actions: string[] = [];
			if (rule.expireDays !== undefined)
				actions.push(`<Expiration><Days>${rule.expireDays}</Days></Expiration>`);
			if (rule.noncurrentExpireDays !== undefined)
				actions.push(
					`<NoncurrentVersionExpiration><NoncurrentDays>${rule.noncurrentExpireDays}</NoncurrentDays></NoncurrentVersionExpiration>`,
				);
			if (rule.abortIncompleteDays !== undefined)
				actions.push(
					`<AbortIncompleteMultipartUpload><DaysAfterInitiation>${rule.abortIncompleteDays}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`,
				);
			return (
				`<Rule><ID>${escapeXml(rule.id)}</ID><Status>${rule.enabled ? 'Enabled' : 'Disabled'}</Status>` +
				`<Filter><Prefix>${escapeXml(rule.prefix ?? '')}</Prefix></Filter>${actions.join('')}</Rule>`
			);
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${ruleXml}</LifecycleConfiguration>`;
}

export function parseLifecycleXml(xml: string): BucketLifecycleRule[] {
	return blocks(xml, 'Rule').map((block) => {
		const filter = tagValue(block, 'Filter') ?? block;
		const expire = blocks(block, 'Expiration')[0] ?? '';
		const noncurrent = blocks(block, 'NoncurrentVersionExpiration')[0] ?? '';
		const abort = blocks(block, 'AbortIncompleteMultipartUpload')[0] ?? '';
		const rule: BucketLifecycleRule = {
			id: tagValue(block, 'ID') ?? 'rule',
			prefix: tagValue(filter, 'Prefix') ?? '',
			enabled: tagValue(block, 'Status') !== 'Disabled',
		};
		const expireDays = Number(tagValue(expire, 'Days') ?? 0);
		const noncurrentDays = Number(tagValue(noncurrent, 'NoncurrentDays') ?? 0);
		const abortDays = Number(tagValue(abort, 'DaysAfterInitiation') ?? 0);
		if (expireDays > 0) rule.expireDays = Math.trunc(expireDays);
		if (noncurrentDays > 0) rule.noncurrentExpireDays = Math.trunc(noncurrentDays);
		if (abortDays > 0) rule.abortIncompleteDays = Math.trunc(abortDays);
		return rule;
	});
}

export function corsXml(rules: readonly BucketCorsRule[]): string {
	const ruleXml = rules
		.map((rule) => {
			const parts = rule.origin.map((origin) => `<AllowedOrigin>${escapeXml(origin)}</AllowedOrigin>`);
			parts.push(...rule.method.map((method) => `<AllowedMethod>${method}</AllowedMethod>`));
			parts.push(...rule.header.map((header) => `<AllowedHeader>${escapeXml(header)}</AllowedHeader>`));
			parts.push(...rule.expose.map((header) => `<ExposeHeader>${escapeXml(header)}</ExposeHeader>`));
			if (rule.maxAge !== undefined) parts.push(`<MaxAgeSeconds>${rule.maxAge}</MaxAgeSeconds>`);
			return `<CORSRule>${parts.join('')}</CORSRule>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${ruleXml}</CORSConfiguration>`;
}

export function parseCorsXml(xml: string): BucketCorsRule[] {
	return blocks(xml, 'CORSRule').map((block) => {
		const rule: BucketCorsRule = {
			origin: tagValues(block, 'AllowedOrigin'),
			method: tagValues(block, 'AllowedMethod') as BucketCorsRule['method'],
			header: tagValues(block, 'AllowedHeader'),
			expose: tagValues(block, 'ExposeHeader'),
		};
		const maxAge = Number(tagValue(block, 'MaxAgeSeconds') ?? NaN);
		if (Number.isFinite(maxAge)) rule.maxAge = Math.trunc(maxAge);
		return rule;
	});
}

function tagValues(xml: string, tag: string): string[] {
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
	return [...xml.matchAll(pattern)].map((match) => unescapeXml(match[1] ?? ''));
}

function deletionKey(deletion: StorageBucketDeletion): string {
	return `${deletion.storageId}/${deletion.bucket}/${deletion.result}`;
}

function configReportKey(report: StorageBucketConfigReport): string {
	return `${report.storageId}/${report.bucket}/${report.configVersion}`;
}

function grantsSignature(grants: readonly StorageGrant[]): string {
	return JSON.stringify(
		[...grants].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((grant) => [grant.bucket, grant.mode]),
	);
}

/** Bucket names are `[a-z0-9-]` (contract), so they need no encoding; refuse anything else. */
function bucketPath(name: string): string {
	if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(name)) throw new StorageApiError(`Invalid bucket name ${JSON.stringify(name)}`, 0, null);
	return name;
}

function objectPath(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}

function stripQuery(path: string): string {
	const index = path.indexOf('?');
	return index < 0 ? path : path.slice(0, index);
}

/** Contents of every `<tag>…</tag>` element (non-nested use: Contents, Bucket, Upload, Error). */
export function blocks(xml: string, tag: string): string[] {
	const out: string[] = [];
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
	for (const match of xml.matchAll(pattern)) out.push(match[1] ?? '');
	return out;
}

/** First `<tag>value</tag>`, entity-decoded. */
export function tagValue(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? unescapeXml(match[1] ?? '') : null;
}

export function unescapeXml(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
		switch (entity) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
			default: {
				const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : '';
			}
		}
	});
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function jsonCode(text: string): string | null {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		return typeof value.Code === 'string' ? value.Code : typeof value.code === 'string' ? value.code : null;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Error text must never carry a key's secret. */
export function scrub(message: string, target: Pick<StorageTarget, 'admin'>): string {
	let scrubbed = message;
	for (const secret of [
		target.admin.rootSecretAccessKey,
		...Object.values(target.admin.users),
		...Object.values(target.admin.replication ?? {}),
	]) {
		if (secret) scrubbed = scrubbed.split(secret).join('***');
	}
	return scrubbed;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
	return String(error);
}

/**
 * A bucket's notification config (D122). Skiff sends every create/delete event to its one `skiff`
 * webhook target and filters by prefix, suffix and event in the control plane, so rules can
 * change without touching RustFS. Disabled is an empty config, which removes the bucket's rules.
 */
export function notificationXml(enabled: boolean): string {
	if (!enabled) return '<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></NotificationConfiguration>';
	return (
		'<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
		`<QueueConfiguration><Id>skiff</Id><Queue>${STORAGE_NOTIFY_ARN}</Queue>` +
		'<Event>s3:ObjectCreated:*</Event><Event>s3:ObjectRemoved:*</Event></QueueConfiguration>' +
		'</NotificationConfiguration>'
	);
}
