import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	previewBucketPrefixSchema,
	previewBucketViewSchema,
	previewCreateSchema,
	previewDatabaseCloneCreateSchema,
	previewDatabaseCloneViewSchema,
	previewHostSchema,
	previewListViewSchema,
	previewPolicySchema,
	previewTtlHoursSchema,
	previewUpdateSchema,
	previewViewSchema,
} from './preview.ts';

describe('preview schemas', () => {
	test('policy defaults to schema-seed with a 72-hour TTL', () => {
		expect(previewPolicySchema.parse({ enabled: true })).toEqual({
			enabled: true,
			data: 'schema-seed',
			ttlHours: 72,
			maxConcurrent: 3,
		});
		expect(previewPolicySchema.safeParse({ enabled: true, extra: true }).success).toBe(false);
		expect(previewTtlHoursSchema.safeParse(0).success).toBe(false);
		expect(previewTtlHoursSchema.safeParse(721).success).toBe(false);
	});

	test('create defaults to a protected, data-free preview', () => {
		expect(previewCreateSchema.parse({})).toEqual({
			source: 'api',
			fromFork: false,
			dataMode: 'none',
			bucketMode: 'none',
			ttlHours: 72,
			access: 'platform',
		});
		expect(previewCreateSchema.parse({ dataMode: 'schema-seed', database: 'main' }).dataMode).toBe('schema-seed');
	});

	test('source, data and bucket requirements are explicit', () => {
		expect(previewCreateSchema.safeParse({ source: 'github' }).success).toBe(false);
		expect(previewCreateSchema.safeParse({ source: 'github', repo: 'acme/app', prNumber: 42 }).success).toBe(true);
		expect(previewCreateSchema.safeParse({ dataMode: 'schema-seed' }).success).toBe(false);
		expect(previewCreateSchema.safeParse({ dataMode: 'fork', database: 'main', fromFork: true }).success).toBe(false);
		expect(previewCreateSchema.safeParse({ bucketMode: 'prefix' }).success).toBe(false);
		expect(previewCreateSchema.safeParse({ bucketMode: 'prefix', storage: 'assets' }).success).toBe(true);
		expect(previewCreateSchema.safeParse({ access: 'public', unknown: true }).success).toBe(false);
	});

	test('updates are partial and non-empty', () => {
		expect(previewUpdateSchema.parse({ ttlHours: 24 })).toEqual({ ttlHours: 24 });
		expect(previewUpdateSchema.safeParse({}).success).toBe(false);
		expect(previewUpdateSchema.safeParse({ access: 'public' }).success).toBe(true);
	});

	test('database clones require an artifact only for fork mode', () => {
		expect(previewDatabaseCloneCreateSchema.parse({ sourceDatabaseId: 'db_1', mode: 'schema-seed' })).toEqual({
			sourceDatabaseId: 'db_1',
			mode: 'schema-seed',
		});
		expect(previewDatabaseCloneCreateSchema.safeParse({ sourceDatabaseId: 'db_1', mode: 'fork' }).success).toBe(false);
		expect(
			previewDatabaseCloneCreateSchema.safeParse({
				sourceDatabaseId: 'db_1',
				mode: 'fork',
				sourceArtifactId: 'bkp_1',
			}).success,
		).toBe(true);
	});

	test('preview hosts are normalized hostnames', () => {
		expect(previewHostSchema.parse(' My-App--PR-42.Example.COM. ')).toBe('my-app--pr-42.example.com');
		expect(previewHostSchema.safeParse('https://example.com').success).toBe(false);
	});

	test('bucket prefixes stay inside the bucket', () => {
		expect(previewBucketPrefixSchema.parse('previews/pr-42/')).toBe('previews/pr-42/');
		for (const prefix of ['/previews/pr-42/', 'previews/../etc/', 'previews//pr-42/', 'previews/pr-42'])
			expect(previewBucketPrefixSchema.safeParse(prefix).success).toBe(false);
	});

	test('views round-trip', () => {
		const clone = {
			id: 'cl_1',
			previewId: 'pv_1',
			sourceDatabaseId: 'db_1',
			sourceDatabaseName: 'main',
			databaseName: 'main_preview_42',
			role: 'preview_42',
			mode: 'schema-seed',
			sourceArtifactId: null,
			status: 'ready',
			error: null,
			expiresAt: '2026-11-08T00:00:00.000Z',
			createdAt: '2026-11-05T00:00:00.000Z',
		} as const;
		expect(previewDatabaseCloneViewSchema.parse(clone)).toEqual(clone);

		const bucket = {
			storageId: 'st_1',
			storageName: 'assets',
			bucket: 'uploads',
			mode: 'prefix',
			prefix: 'previews/pr-42/',
			scopedKeyId: 'SKFEXAMPLE',
		} as const;
		expect(previewBucketViewSchema.parse(bucket)).toEqual(bucket);

		const view: z.output<typeof previewViewSchema> = {
			id: 'pv_1',
			projectId: 'prj_1',
			projectSlug: 'my-app',
			environmentId: 'env_1',
			environmentSlug: 'preview-pr-42',
			host: 'my-app--pr-42.example.com',
			source: 'github',
			status: 'ready',
			url: 'https://my-app--pr-42.example.com',
			repo: 'acme/app',
			prNumber: 42,
			headSha: 'a'.repeat(40),
			baseBranch: 'main',
			dataMode: 'schema-seed',
			databaseClone: clone,
			bucket,
			access: 'platform',
			ttlHours: 72,
			expiresAt: '2026-11-08T00:00:00.000Z',
			createdAt: '2026-11-05T00:00:00.000Z',
			teardownAt: null,
			error: null,
		};
		expect(previewViewSchema.parse(view)).toEqual(view);
		expect(previewViewSchema.safeParse({ ...view, databaseClone: { ...clone, role: 'secret' }, secret: 'x' }).success).toBe(
			false,
		);

		const list = { projectId: 'prj_1', projectSlug: 'my-app', policy: { enabled: true }, previews: [view] };
		const parsed = previewListViewSchema.parse(list);
		expect(parsed.previews).toEqual([view]);
		expect(parsed.policy).toEqual({ enabled: true, data: 'schema-seed', ttlHours: 72, maxConcurrent: 3 });
	});
});
