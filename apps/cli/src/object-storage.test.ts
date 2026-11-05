import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors.ts';
import {
	credentialsEnv,
	defaultGrants,
	parseDuration,
	parseGrant,
	parseGrants,
	splitList,
	storageDetails,
	storageTable,
	usedVsBudget,
	type StorageBucketView,
	type StorageView,
} from './object-storage.ts';

function bucket(name: string, overrides: Partial<StorageBucketView> = {}): StorageBucketView {
	return {
		name,
		access: 'private',
		state: 'ready',
		sizeBytes: null,
		objects: null,
		versioning: false,
		lifecycle: [],
		cors: [],
		quotaBytes: null,
		objectLock: null,
		configVersion: 1,
		configStatus: 'pending',
		configMessage: null,
		lastConvergedAt: null,
		createdAt: '2026-11-05T10:00:00.000Z',
		statsAt: null,
		...overrides,
	};
}

function storageView(overrides: Partial<StorageView> = {}): StorageView {
	return {
		id: 'st_1',
		name: 'media',
		engine: 'rustfs',
		engineLabel: 'RustFS',
		version: '1.0.4',
		status: 'running',
		message: null,
		nodeId: 'node_home',
		nodeName: 'homelab',
		memoryMb: 512,
		cpus: 1,
		storageMb: 10_240,
		usedBytes: null,
		objects: null,
		public: false,
		publicUrl: null,
		internalEndpoint: { process: 'http://127.0.0.1:19000', container: 'http://s3-1:9000' },
		region: 'us-east-1',
		buckets: [],
		attachments: [],
		statsAt: null,
		createdAt: '2026-11-05T10:00:00.000Z',
		updatedAt: '2026-11-05T10:00:00.000Z',
		deletedAt: null,
		purgeAt: null,
		...overrides,
	};
}

describe('grants', () => {
	test('parseGrant defaults to read-write and accepts read / read-write (and ro / rw)', () => {
		expect(parseGrant('uploads')).toEqual({ bucket: 'uploads', mode: 'read-write' });
		expect(parseGrant('uploads:read')).toEqual({ bucket: 'uploads', mode: 'read' });
		expect(parseGrant('uploads:read-write')).toEqual({ bucket: 'uploads', mode: 'read-write' });
		expect(parseGrant('uploads:ro')).toEqual({ bucket: 'uploads', mode: 'read' });
		expect(() => parseGrant('uploads:write')).toThrow(UsageError);
		expect(() => parseGrant(':read')).toThrow(UsageError);
		expect(() => parseGrant('a:read:x')).toThrow(UsageError);
	});

	test('parseGrants splits commas and rejects duplicates', () => {
		expect(parseGrants(['a1a,b2b:read', 'c3c'])).toEqual([
			{ bucket: 'a1a', mode: 'read-write' },
			{ bucket: 'b2b', mode: 'read' },
			{ bucket: 'c3c', mode: 'read-write' },
		]);
		expect(() => parseGrants(['a1a', 'a1a:read'])).toThrow('granted twice');
		expect(splitList([' a, ,b '])).toEqual(['a', 'b']);
	});

	test('defaultGrants picks the only ready bucket, else asks for --bucket', () => {
		expect(defaultGrants(storageView({ buckets: [bucket('uploads'), bucket('old', { state: 'deleting' })] }))).toEqual([
			{ bucket: 'uploads', mode: 'read-write' },
		]);
		expect(() => defaultGrants(storageView())).toThrow('no buckets yet');
		expect(() => defaultGrants(storageView({ buckets: [bucket('a1a'), bucket('b2b')] }))).toThrow('--bucket');
	});
});

describe('formatting', () => {
	test('usedVsBudget shows the budget alone before the first sample', () => {
		expect(usedVsBudget({ usedBytes: null, storageMb: 10_240 })).toBe('- / 10 GiB');
		expect(usedVsBudget({ usedBytes: 5 * 1024 ** 3, storageMb: 10_240 })).toBe('5.0 GiB / 10 GiB (50%)');
	});

	test('storageTable and storageDetails cover the empty states', () => {
		expect(storageTable([storageView()])).toMatch(/media\s+running\s+homelab\s+0\s+- \/ 10 GiB\s+no\s+-/);
		const details = storageDetails(storageView({ public: true, publicUrl: 'https://media--s3.example.com' }));
		expect(details).toMatch(/Public\s+https:\/\/media--s3\.example\.com/);
		expect(details).toContain('Buckets: none.');
		expect(details).toContain('Attached projects: none.');
	});

	test('credentialsEnv names variables like an attachment', () => {
		const env = credentialsEnv(
			{
				storageId: 'st_1',
				name: 'media',
				accessKeyId: 'SKR1',
				secretAccessKey: 'secret',
				region: 'us-east-1',
				endpoint: 'https://media--s3.example.com',
				internalEndpoint: 'http://127.0.0.1:19000',
				publicEndpoint: 'https://media--s3.example.com',
				note: '',
			},
			'S3',
		);
		expect(env.split('\n')).toEqual([
			'S3_ENDPOINT_URL=https://media--s3.example.com',
			'S3_ACCESS_KEY_ID=SKR1',
			'S3_SECRET_ACCESS_KEY=secret',
			'S3_REGION=us-east-1',
			'S3_FORCE_PATH_STYLE=true',
		]);
	});

	test('parseDuration', () => {
		expect(parseDuration('30m', '--since')).toBe(1_800_000);
		expect(parseDuration('6h', '--since')).toBe(21_600_000);
		expect(parseDuration('7d', '--since')).toBe(604_800_000);
		expect(() => parseDuration('1w', '--since')).toThrow(UsageError);
		expect(() => parseDuration('0h', '--since')).toThrow(UsageError);
	});
});
