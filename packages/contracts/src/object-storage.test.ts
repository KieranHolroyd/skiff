import { describe, expect, test } from 'bun:test';
import {
	STORAGE_SHARE_MAX_TTL_SECONDS,
	bucketCreateSchema,
	bucketUpdateSchema,
	storageShareLinkSchema,
} from './object-storage.ts';

const lock = { mode: 'governance' as const, retainDays: 30 };

describe('bucket configuration schema', () => {
	test('object lock requires versioning on create', () => {
		expect(() => bucketCreateSchema.parse({ name: 'uploads', objectLock: lock })).toThrow(/requires versioning/);
		expect(bucketCreateSchema.parse({ name: 'uploads', versioning: true, objectLock: lock })).toMatchObject({
			versioning: true,
			objectLock: lock,
		});
	});

	test('noncurrent lifecycle expiry requires versioning', () => {
		expect(() =>
			bucketCreateSchema.parse({
				name: 'uploads',
				lifecycle: [{ id: 'old', noncurrentExpireDays: 30 }],
			}),
		).toThrow(/requires versioning/);
		expect(() =>
			bucketCreateSchema.parse({
				name: 'uploads',
				versioning: true,
				lifecycle: [{ id: 'old', noncurrentExpireDays: 30 }],
			}),
		).not.toThrow();
	});

	test('a lifecycle rule needs at least one action and unique ids', () => {
		expect(() => bucketCreateSchema.parse({ name: 'uploads', lifecycle: [{ id: 'empty' }] })).toThrow(/at least one action/);
		expect(() =>
			bucketCreateSchema.parse({
				name: 'uploads',
				lifecycle: [
					{ id: 'same', expireDays: 1 },
					{ id: 'same', expireDays: 2 },
				],
			}),
		).toThrow(/ids must be unique/);
	});

	test('CORS origins are not duplicated within a bucket', () => {
		expect(() =>
			bucketCreateSchema.parse({
				name: 'uploads',
				cors: [
					{ origin: ['https://a.test'], method: ['GET'] },
					{ origin: ['https://A.test'], method: ['PUT'] },
				],
			}),
		).toThrow(/listed twice/);
	});

	test('quota is a positive byte cap and null is unlimited', () => {
		expect(bucketCreateSchema.parse({ name: 'uploads', quotaBytes: null }).quotaBytes).toBeNull();
		expect(bucketCreateSchema.parse({ name: 'uploads', quotaBytes: 1024 }).quotaBytes).toBe(1024);
		expect(() => bucketCreateSchema.parse({ name: 'uploads', quotaBytes: 0 })).toThrow();
		expect(() => bucketCreateSchema.parse({ name: 'uploads', quotaBytes: -1 })).toThrow();
	});

	test('object lock is create-only and cannot be patched', () => {
		expect(() => bucketUpdateSchema.parse({ objectLock: lock })).toThrow(/cannot be changed/);
		expect(bucketUpdateSchema.parse({ versioning: true })).toEqual({ versioning: true });
		expect(() => bucketUpdateSchema.parse({})).toThrow(/Nothing to update/);
	});
});

describe('share link schema', () => {
	test('caps expiry at seven days and requires an absolute method', () => {
		expect(storageShareLinkSchema.parse({ key: 'a.txt' })).toMatchObject({ method: 'GET', expiresIn: 3600 });
		expect(() =>
			storageShareLinkSchema.parse({ key: 'a.txt', expiresIn: STORAGE_SHARE_MAX_TTL_SECONDS + 1 }),
		).toThrow();
		expect(() => storageShareLinkSchema.parse({ key: '/escape' })).toThrow();
	});
});
