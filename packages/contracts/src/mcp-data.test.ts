import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	applyStackInputSchema,
	backupArtifactSchema,
	createPresignedUrlInputSchema,
	createPresignedUrlOutputSchema,
	forkDatabaseInputSchema,
	forkDatabaseOutputSchema,
	getDataHealthInputSchema,
	getDataHealthOutputSchema,
	getTaskInputSchema,
	getTaskOutputSchema,
	listBackupsInputSchema,
	listBackupsOutputSchema,
	planStackInputSchema,
	queryDatabaseInputSchema,
	queryDatabaseOutputSchema,
	restoreBackupInputSchema,
	restoreBackupOutputSchema,
} from './mcp-data.ts';

const token = 'c'.repeat(40);

describe('MCP data tool schemas', () => {
	test('plan_stack takes the document text and nothing else', () => {
		expect(planStackInputSchema.safeParse({}).success).toBe(false);
		expect(planStackInputSchema.safeParse({ blueprint: '' }).success).toBe(false);
		expect(planStackInputSchema.safeParse({ blueprint: 'apiVersion: skiff/v1' }).success).toBe(true);
		// No server-local paths and no pruning from an agent.
		expect(planStackInputSchema.safeParse({ path: 'skiff.blueprint.yaml' }).success).toBe(false);
		expect(planStackInputSchema.safeParse({ blueprint: 'apiVersion: skiff/v1', prune: true }).success).toBe(false);
	});

	test('apply_stack takes a plan hash; confirmation is the elicitation, not an argument', () => {
		expect(applyStackInputSchema.parse({ planHash: 'a'.repeat(64) })).toEqual({ planHash: 'a'.repeat(64) });
		expect(applyStackInputSchema.safeParse({ planHash: 'short' }).success).toBe(false);
		expect(applyStackInputSchema.safeParse({ planHash: 'a'.repeat(64), prune: true }).success).toBe(false);
	});

	test('get_data_health defaults to a project summary with no secrets', () => {
		expect(getDataHealthInputSchema.parse({ project: 'my-app' })).toEqual({ project: 'my-app' });
		expect(getDataHealthInputSchema.safeParse({ project: 'my-app', kind: 'bucket' }).success).toBe(false);
		const health = {
			project: 'my-app',
			generatedAt: '2026-11-05T00:00:00.000Z',
			database: null,
			storage: null,
			workload: null,
			quota: null,
			checks: [],
			warnings: [],
		};
		expect(getDataHealthOutputSchema.parse({ project: 'my-app', generatedAt: health.generatedAt })).toEqual(health);
		expect(getDataHealthOutputSchema.safeParse({ ...health, password: 'leak' }).success).toBe(false);
	});

	test('query_database is read-only, parameterised and bounded', () => {
		expect(queryDatabaseInputSchema.safeParse({ project: 'my-app', database: 'main', sql: 'delete from users' }).success).toBe(
			false,
		);
		expect(queryDatabaseInputSchema.parse({ project: 'my-app', database: 'main', sql: 'select $1' })).toMatchObject({
			params: [],
			maxRows: 100,
			timeoutMs: 5000,
		});
		expect(
			queryDatabaseInputSchema.safeParse({ project: 'my-app', database: 'main', sql: 'select 1', maxRows: 1001 }).success,
		).toBe(false);

		const output: z.output<typeof queryDatabaseOutputSchema> = {
			columns: [{ name: 'id', type: 'int4' }],
			rows: [{ id: 1, tags: ['a', 'b'], meta: { active: true, note: null } }],
			rowCount: 1,
			truncated: false,
			durationMs: 4,
			fingerprint: 'b'.repeat(64),
			readOnly: true,
		};
		expect(queryDatabaseOutputSchema.parse(output)).toEqual(output);
	});

	test('create_presigned_url pins method, key and expiry', () => {
		const input = { project: 'my-app', storage: 'assets', bucket: 'uploads', key: 'avatars/a.png' };
		expect(createPresignedUrlInputSchema.parse(input)).toMatchObject({ method: 'GET', expiresIn: 3600 });
		expect(createPresignedUrlInputSchema.safeParse({ ...input, expiresIn: 604_801 }).success).toBe(false);
		expect(createPresignedUrlInputSchema.safeParse({ ...input, key: '../etc/passwd' }).success).toBe(false);
		const output: z.output<typeof createPresignedUrlOutputSchema> = {
			url: 'https://assets.example.com/uploads/avatars/a.png?X-Amz-Signature=x',
			method: 'GET',
			storage: 'assets',
			bucket: 'uploads',
			key: 'avatars/a.png',
			expiresAt: '2026-11-05T01:00:00.000Z',
			maxBytes: null,
		};
		expect(createPresignedUrlOutputSchema.parse(output)).toEqual(output);
	});

	test('list_backups returns summaries only', () => {
		expect(listBackupsInputSchema.parse({ project: 'my-app' })).toEqual({ project: 'my-app', limit: 20 });
		const artifact: z.output<typeof backupArtifactSchema> = {
			id: 'bkp_1',
			databaseId: 'db_1',
			databaseName: 'main',
			kind: 'manual',
			status: 'ok',
			format: 'pg_dump-custom',
			sizeBytes: 1024,
			sha256: 'd'.repeat(64),
			objectKey: 'skiff/backups/db_1.dump',
			pinned: false,
			createdAt: '2026-11-05T00:00:00.000Z',
			verifiedAt: null,
			expiresAt: null,
			target: { id: 'bt_1', name: 'offsite' },
		};
		expect(backupArtifactSchema.parse(artifact)).toEqual(artifact);
		expect(backupArtifactSchema.safeParse({ ...artifact, secretAccessKey: 'leak' }).success).toBe(false);
		expect(listBackupsOutputSchema.parse({ backups: [artifact], truncated: false })).toEqual({
			backups: [artifact],
			truncated: false,
		});
	});

	test('restore_backup is new-target only and confirmation-gated', () => {
		expect(
			restoreBackupInputSchema.safeParse({ project: 'my-app', backupId: 'bkp_1', targetName: 'restored' }).success,
		).toBe(false);
		expect(
			restoreBackupInputSchema.parse({
				project: 'my-app',
				backupId: 'bkp_1',
				targetName: 'restored',
				confirmationToken: token,
			}),
		).toMatchObject({ mode: 'new' });
		expect(
			restoreBackupInputSchema.safeParse({
				project: 'my-app',
				backupId: 'bkp_1',
				targetName: 'restored',
				mode: 'in-place',
				confirmationToken: token,
			}).success,
		).toBe(false);
		const output: z.output<typeof restoreBackupOutputSchema> = {
			taskId: 'task_1',
			operationId: null,
			databaseId: null,
			status: 'queued',
			message: null,
		};
		expect(restoreBackupOutputSchema.parse(output)).toEqual(output);
	});

	test('fork_database defaults to schema mode and a 24-hour TTL', () => {
		expect(
			forkDatabaseInputSchema.parse({ project: 'my-app', source: 'main', targetName: 'main-preview' }),
		).toMatchObject({ mode: 'schema', ttlHours: 24 });
		expect(
			forkDatabaseInputSchema.safeParse({ project: 'my-app', source: 'main', targetName: 'main-preview', mode: 'all' })
				.success,
		).toBe(false);
		const output: z.output<typeof forkDatabaseOutputSchema> = {
			taskId: 'task_1',
			cloneId: 'cl_1',
			databaseName: 'main_preview',
			status: 'creating',
			expiresAt: '2026-11-06T00:00:00.000Z',
		};
		expect(forkDatabaseOutputSchema.parse(output)).toEqual(output);
	});

	test('get_task round-trips approval state and a JSON result', () => {
		expect(getTaskInputSchema.parse({ taskId: 'task_1' })).toEqual({ taskId: 'task_1' });
		const output: z.output<typeof getTaskOutputSchema> = {
			id: 'task_1',
			tool: 'apply_stack',
			status: 'input_required',
			progress: null,
			result: null,
			error: null,
			approval: { required: true, requestState: 'state_1', expiresAt: '2026-11-05T00:05:00.000Z' },
			createdAt: '2026-11-05T00:00:00.000Z',
			updatedAt: '2026-11-05T00:00:00.000Z',
			expiresAt: '2026-11-06T00:00:00.000Z',
		};
		expect(getTaskOutputSchema.parse(output)).toEqual(output);
		expect(
			getTaskOutputSchema.parse({
				...output,
				status: 'succeeded',
				result: { planHash: 'a'.repeat(64), resources: ['services.web'] },
			}).result,
		).toEqual({ planHash: 'a'.repeat(64), resources: ['services.web'] });
	});
});
