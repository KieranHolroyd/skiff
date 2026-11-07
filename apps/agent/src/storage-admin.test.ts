import { describe, expect, test } from 'bun:test';
import { bucketCreateSchema } from '@skiff/contracts';
import type { BucketCorsRule, BucketLifecycleRule, BucketObjectLock, StorageAdmin, WorkloadObjectStorage } from '@skiff/contracts';
import {
	StorageApiError,
	StorageReconciler,
	notificationXml,
	type S3Object,
	type S3Upload,
	type StorageApi,
	type StorageTarget,
	type RustfsUser,
} from './storage-admin.ts';

const admin: StorageAdmin = {
	rootAccessKeyId: 'SKRROOT',
	rootSecretAccessKey: 'root-secret',
	port: 19000,
	keysVersion: 'a'.repeat(64),
	users: {},
};

const lifecycle: BucketLifecycleRule[] = [
	{ id: 'cleanup', prefix: 'tmp/', expireDays: 7, abortIncompleteDays: 3, enabled: true },
];
const cors: BucketCorsRule[] = [
	{ origin: ['https://app.test'], method: ['GET', 'PUT'], header: ['*'], expose: [], maxAge: 3600 },
];
const objectLock: BucketObjectLock = { mode: 'governance', retainDays: 30 };

class FakeApi implements StorageApi {
	readonly calls: string[] = [];
	readonly buckets = new Set<string>();
	quota: number | null = null;
	versioning = false;
	lifecycle: BucketLifecycleRule[] = [];
	cors: BucketCorsRule[] = [];
	lock: BucketObjectLock | null = null;
	unsupported = new Set<string>();
	policies = new Map<string, Record<string, unknown>>();

	private maybeUnsupported(name: string) {
		if (this.unsupported.has(name))
			throw new StorageApiError(`${name} is not supported`, 501, 'NotImplemented');
	}

	async listBuckets() {
		return [...this.buckets];
	}

	async createBucket(name: string, options: { objectLock?: boolean } = {}) {
		this.calls.push(`create:${name}:${options.objectLock ? 'lock' : 'plain'}`);
		this.buckets.add(name);
		this.lock = options.objectLock ? { mode: 'governance', retainDays: 1 } : null;
	}

	async deleteBucket(name: string): Promise<'deleted' | 'not-empty' | 'missing'> {
		this.calls.push(`delete:${name}`);
		// A versioned bucket always refuses a plain delete, as RustFS does.
		if (this.versioning && this.buckets.has(name)) return 'not-empty';
		this.buckets.delete(name);
		return 'deleted';
	}

	async putBucketPolicy(name: string, policy: Record<string, unknown>) {
		this.calls.push(`policy:${name}`);
		this.policies.set(name, policy);
	}

	async deleteBucketPolicy(name: string) {
		this.calls.push(`policy-delete:${name}`);
		this.policies.delete(name);
	}

	async getBucketVersioning() {
		return this.versioning ? ('enabled' as const) : ('unset' as const);
	}

	async putBucketVersioning(_name: string, enabled: boolean) {
		this.maybeUnsupported('versioning');
		this.calls.push(`versioning:${enabled}`);
		this.versioning = enabled;
	}

	async getBucketLifecycle() {
		return this.lifecycle;
	}

	async putBucketLifecycle(_name: string, rules: BucketLifecycleRule[]) {
		this.maybeUnsupported('lifecycle');
		this.calls.push(`lifecycle:${rules.length}`);
		this.lifecycle = rules;
	}

	async deleteBucketLifecycle() {
		this.maybeUnsupported('lifecycle');
		this.calls.push('lifecycle-delete');
		this.lifecycle = [];
	}

	async getBucketCors() {
		return this.cors;
	}

	notifications = new Map<string, boolean>();

	async putBucketNotifications(name: string, enabled: boolean) {
		this.maybeUnsupported('notifications');
		this.calls.push(`notify:${name}:${enabled ? 'on' : 'off'}`);
		this.notifications.set(name, enabled);
	}

	async putBucketCors(_name: string, rules: BucketCorsRule[]) {
		this.maybeUnsupported('cors');
		this.calls.push(`cors:${rules.length}`);
		this.cors = rules;
	}

	async deleteBucketCors() {
		this.maybeUnsupported('cors');
		this.calls.push('cors-delete');
		this.cors = [];
	}

	async getBucketQuota() {
		return this.quota;
	}

	async putBucketQuota(_name: string, bytes: number | null) {
		this.maybeUnsupported('quota');
		this.calls.push(`quota:${bytes ?? 'none'}`);
		this.quota = bytes;
	}

	async getObjectLock() {
		return this.lock;
	}

	async putObjectLock(_name: string, lock: BucketObjectLock) {
		this.maybeUnsupported('object-lock');
		this.calls.push(`lock:${lock.mode}:${lock.retainDays}`);
		this.lock = lock;
	}

	async listObjects(_bucket: string): Promise<{ objects: S3Object[]; next: string | null }> {
		return { objects: [], next: null };
	}
	async deleteObjects() {}
	async listUploads(): Promise<S3Upload[]> {
		return [];
	}
	async abortUpload() {}
	async listUsers(): Promise<Record<string, RustfsUser>> {
		return {};
	}
	async addUser() {}
	async removeUser() {}
	async listCannedPolicies() {
		return [];
	}
	async addCannedPolicy() {}
	async removeCannedPolicy() {}
	async setUserPolicy() {}
	async dataUsage() {
		return {};
	}
}

function desired(overrides: Partial<WorkloadObjectStorage['buckets'][number]> = {}): WorkloadObjectStorage {
	return {
		engine: 'rustfs',
		version: '1.0.4',
		buckets: [
			{
				name: 'uploads',
				access: 'private',
				versioning: true,
				lifecycle,
				cors,
				quotaBytes: 1024 * 1024,
				objectLock,
				configVersion: 1,
				notifications: false,
				...overrides,
			},
		],
		users: [],
		deleteBuckets: [],
		keysVersion: 'b'.repeat(64),
	};
}

function target(_api: FakeApi, overrides: Partial<StorageTarget> = {}): StorageTarget {
	return {
		id: 'st_1',
		activationVersion: 'v1',
		port: 19000,
		status: 'running',
		admin,
		desired: desired(),
		...overrides,
	};
}

async function converge(api: FakeApi, at: () => number = () => 1_000_000) {
	const reconciler = new StorageReconciler({
		source: { storageTargets: () => [target(api)] },
		apiFor: () => api,
		now: at,
	});
	await reconciler.reconcile();
	return reconciler;
}

describe('storage bucket configuration convergence', () => {
	test('creates the bucket with object lock and applies every desired setting', async () => {
		const api = new FakeApi();
		await converge(api);
		expect(api.calls).toEqual([
			'create:uploads:lock',
			'policy-delete:uploads',
			'versioning:true',
			'lifecycle:1',
			'cors:1',
			`quota:${1024 * 1024}`,
			'lock:governance:30',
			// Asserted off too, so a rule removed while the agent was down still clears RustFS.
			'notify:uploads:off',
		]);
		expect(api.lock).toEqual(objectLock);
	});

	test('a watched bucket points its events at the skiff target; unwatching clears it (D122)', async () => {
		const api = new FakeApi();
		const reconciler = new StorageReconciler({
			source: { storageTargets: () => [{ ...target(api), desired: desired({ notifications: true }) }] },
			apiFor: () => api,
			now: () => 1_000_000,
		});
		await reconciler.reconcile();
		expect(api.notifications.get('uploads')).toBe(true);
		expect(notificationXml(true)).toContain('<Queue>arn:rustfs:sqs:us-east-1:skiff:webhook</Queue>');
		expect(notificationXml(true)).toContain('<Event>s3:ObjectCreated:*</Event><Event>s3:ObjectRemoved:*</Event>');
		expect(notificationXml(false)).not.toContain('QueueConfiguration');

		// A build without the notification API reports `unsupported` instead of failing the bucket.
		const old = new FakeApi();
		old.unsupported.add('notifications');
		await new StorageReconciler({
			source: { storageTargets: () => [{ ...target(old), desired: desired({ notifications: true }) }] },
			apiFor: () => old,
			now: () => 1_000_000,
		}).reconcile();
		expect(old.calls).toContain(`quota:${1024 * 1024}`);
	});

	test('re-applying is idempotent until the full re-assert interval', async () => {
		const api = new FakeApi();
		let clock = 1_000_000;
		const reconciler = await converge(api, () => clock);
		const first = api.calls.length;
		await reconciler.reconcile();
		expect(api.calls).toHaveLength(first);
		clock += 15 * 60_000 + 1;
		await reconciler.reconcile();
		expect(api.calls.length).toBeGreaterThan(first);
	});

	test('a config version change re-applies without recreating the bucket', async () => {
		const api = new FakeApi();
		let current = target(api);
		const reconciler = new StorageReconciler({
			source: { storageTargets: () => [current] },
			apiFor: () => api,
			now: () => 1_000_000,
		});
		await reconciler.reconcile();
		const before = api.calls.length;
		current = target(api, { desired: desired({ configVersion: 2, access: 'public-read' }) });
		await reconciler.reconcile();
		expect(api.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
		expect(api.calls.length).toBeGreaterThan(before);
	});

	test('reports unsupported capabilities instead of silently ignoring them', async () => {
		const api = new FakeApi();
		api.unsupported.add('quota');
		const reconciler = await converge(api);
		const report = reconciler.pendingBucketConfigs().find((item) => item.bucket === 'uploads');
		expect(report).toMatchObject({
			storageId: 'st_1',
			configVersion: 1,
			status: 'unsupported',
		});
		expect(report?.message).toContain('quota');
		expect(api.quota).toBeNull();
		expect(api.calls).toContain('lock:governance:30');
	});

	test('reports a hard error and retries on the next reconcile', async () => {
		const api = new FakeApi();
		api.putBucketVersioning = async () => {
			throw new StorageApiError('versioning failed', 500, 'InternalError');
		};
		const reconciler = await converge(api);
		const report = reconciler.pendingBucketConfigs()[0];
		expect(report?.status).toBe('error');
		expect(report?.message).toContain('versioning failed');
		// Ack drops the pending report; the next round retries because the signature was not stored.
		reconciler.acknowledgeBucketConfigs([report!]);
		expect(reconciler.pendingBucketConfigs()).toHaveLength(0);
	});

	test('object lock without versioning is rejected by the contract before reaching the agent', () => {
		expect(() => bucketCreateSchema.parse({ name: 'uploads', objectLock })).toThrow(/requires versioning/);
	});
});
