import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import {
	STORAGE_REGION,
	STORAGE_USER_KEY_PREFIX,
	publicReadBucketPolicy,
	storagePolicyName,
	storageUserPolicy,
	type BucketAccess,
	type StorageAdmin,
	type StorageBucketDeletion,
	type StorageGrant,
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
	createBucket(name: string): Promise<void>;
	/** `missing` covers 404/NoSuchBucket. */
	deleteBucket(name: string): Promise<'deleted' | 'not-empty' | 'missing'>;
	putBucketPolicy(name: string, policy: Record<string, unknown>): Promise<void>;
	deleteBucketPolicy(name: string): Promise<void>;
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

	async createBucket(name: string): Promise<void> {
		try {
			await this.call('PUT', `/${bucketPath(name)}`, { expect: [200] });
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
	/** `keysVersion|grants` last applied per scoped key. */
	users: Map<string, string>;
	lastFullAt: number;
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
	/**
	 * Deletions already decided, keyed `<id>/<bucket>/<force>`, kept while the entry is still in
	 * `deleteBuckets` so each outcome is reported once and the bucket is not deleted twice.
	 */
	private readonly decided = new Set<string>();
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
			state = { activationVersion: target.activationVersion, policies: new Map(), users: new Map(), lastFullAt: this.now() };
			this.state.set(target.id, state);
		} else if (this.now() - state.lastFullAt >= FULL_REASSERT_MS) {
			state.policies.clear();
			state.users.clear();
			state.lastFullAt = this.now();
		}
		return state;
	}

	private async reconcileOne(target: StorageTarget): Promise<void> {
		const api = this.apiFor(target);
		const state = this.stateFor(target);
		const desired = target.desired;
		const existing = new Set(await api.listBuckets());

		// 1. Desired buckets and their anonymous access.
		for (const bucket of desired.buckets) {
			try {
				if (!existing.has(bucket.name)) {
					await api.createBucket(bucket.name);
					existing.add(bucket.name);
					state.policies.delete(bucket.name);
					this.log('info', `Storage ${target.id}: created bucket ${bucket.name}`);
				}
				if (state.policies.get(bucket.name) !== bucket.access) {
					if (bucket.access === 'public-read') await api.putBucketPolicy(bucket.name, publicReadBucketPolicy(bucket.name));
					else await api.deleteBucketPolicy(bucket.name);
					state.policies.set(bucket.name, bucket.access);
				}
			} catch (error) {
				state.policies.delete(bucket.name);
				this.log('warn', `Storage ${target.id}: bucket ${bucket.name}: ${scrub(errorText(error), target)}`);
			}
		}

		// 2. Deletions: only what Skiff asked for, never a bucket that is still desired.
		await this.deleteBuckets(target, api, existing, state);

		// 3. Scoped keys.
		await this.reconcileUsers(target, api, state);
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

function deletionKey(deletion: StorageBucketDeletion): string {
	return `${deletion.storageId}/${deletion.bucket}/${deletion.result}`;
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
	for (const secret of [target.admin.rootSecretAccessKey, ...Object.values(target.admin.users)]) {
		if (secret) scrubbed = scrubbed.split(secret).join('***');
	}
	return scrubbed;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
	return String(error);
}
