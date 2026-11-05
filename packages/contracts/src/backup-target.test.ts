import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	backupTargetCreateSchema,
	backupTargetLocalPathSchema,
	backupTargetPathPrefixSchema,
	backupTargetTestResultSchema,
	backupTargetUpdateSchema,
	backupTargetViewSchema,
} from './backup-target.ts';

const local = { name: 'local-backups', kind: 'local', path: '/var/lib/skiff/backups' } as const;
const s3 = {
	name: 'offsite',
	kind: 's3',
	bucket: 'skiff-backups',
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
} as const;

describe('backup target schemas', () => {
	test('local targets default to writable files', () => {
		expect(backupTargetCreateSchema.parse(local)).toEqual({ ...local, writeOnly: false });
		expect(backupTargetCreateSchema.safeParse({ ...local, path: 'backups' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...local, path: '/var/lib/skiff/backups/' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...local, path: '/var/lib/skiff/../etc' }).success).toBe(false);
	});

	test('S3 targets fill self-hosted defaults and accept a custom endpoint', () => {
		const parsed = backupTargetCreateSchema.parse(s3);
		expect(parsed).toMatchObject({
			...s3,
			region: 'us-east-1',
			pathPrefix: 'skiff/backups',
			forcePathStyle: true,
			writeOnly: false,
			objectLock: false,
		});
		const withEndpoint = backupTargetCreateSchema.parse({
			...s3,
			endpoint: 'https://minio.example.com:9000',
			forcePathStyle: false,
		}) as { forcePathStyle: boolean };
		expect(withEndpoint.forcePathStyle).toBe(false);
	});

	test('kind-specific fields are strict', () => {
		expect(backupTargetCreateSchema.safeParse({ ...local, bucket: 'nope' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...local, objectLock: true }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, path: '/tmp/backups' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, extra: true }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, accessKeyId: undefined }).success).toBe(false);
	});

	test('endpoint and prefix rules keep credentials and traversal out', () => {
		expect(backupTargetCreateSchema.safeParse({ ...s3, endpoint: 'https://user:pw@minio.example.com' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, endpoint: 'ftp://minio.example.com' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, pathPrefix: '/skiff' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, pathPrefix: 'skiff/../etc' }).success).toBe(false);
		expect(backupTargetCreateSchema.safeParse({ ...s3, pathPrefix: 'skiff/backups/' }).success).toBe(false);
		expect(backupTargetPathPrefixSchema.parse('')).toBe('');
		expect(backupTargetLocalPathSchema.parse('/mnt/backups')).toBe('/mnt/backups');
	});

	test('updates are partial, immutable in kind, and keep omitted credentials', () => {
		expect(backupTargetUpdateSchema.parse({ bucket: 'new-bucket' })).toEqual({ bucket: 'new-bucket' });
		expect(backupTargetUpdateSchema.parse({ endpoint: null })).toEqual({ endpoint: null });
		expect(backupTargetUpdateSchema.safeParse({}).success).toBe(false);
		expect(backupTargetUpdateSchema.safeParse({ kind: 'local' }).success).toBe(false);
		expect(backupTargetUpdateSchema.safeParse({ secretAccessKey: 'short' }).success).toBe(false);
	});

	test('views never carry credentials', () => {
		const view: z.output<typeof backupTargetViewSchema> = {
			id: 'bt_0123456789abcdef',
			orgId: null,
			name: 'offsite',
			kind: 's3',
			path: null,
			endpoint: 'https://minio.example.com',
			bucket: 'skiff-backups',
			region: 'us-east-1',
			pathPrefix: 'skiff/backups',
			forcePathStyle: true,
			writeOnly: true,
			objectLock: false,
			hasCredentials: true,
			status: 'ok',
			lastCheckedAt: '2026-11-05T00:00:00.000Z',
			lastError: null,
			lastTest: {
				ok: true,
				checkedAt: '2026-11-05T00:00:00.000Z',
				message: 'ok',
				latencyMs: 12,
				versioning: true,
				objectLock: false,
			},
			createdAt: '2026-11-05T00:00:00.000Z',
			updatedAt: '2026-11-05T00:00:00.000Z',
		};
		const parsed = backupTargetViewSchema.parse(view);
		expect(parsed).toEqual(view);
		expect(backupTargetViewSchema.parse(parsed)).toEqual(parsed);
		expect(backupTargetViewSchema.safeParse({ ...view, secretAccessKey: 'leak' }).success).toBe(false);
		expect(backupTargetTestResultSchema.safeParse({ ok: true, checkedAt: 'now', message: 'ok' }).success).toBe(true);
	});
});
