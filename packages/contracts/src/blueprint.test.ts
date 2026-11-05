import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	blueprintApplyViewSchema,
	blueprintComposeImportResultSchema,
	blueprintPlanViewSchema,
	blueprintSchema,
} from './blueprint.ts';

const document = {
	apiVersion: 'skiff/v1',
	project: 'my-app',
	environments: { staging: { access: 'platform' } },
	services: {
		web: { type: 'static', path: './dist', spa: true },
		api: {
			type: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			healthPath: '/health',
			memoryMb: 256,
			cpus: 1,
			volumes: ['data:/var/lib/app'],
		},
		worker: {
			type: 'container',
			image: 'docker.io/library/worker:1.0',
			command: ['worker'],
			volumes: [{ volume: 'data', mountPath: '/var/lib/worker', readOnly: true }],
		},
	},
	databases: {
		main: { engine: 'postgres', version: '17', sizeMb: 10240, extensions: ['pgvector', 'pg_trgm'] },
	},
	storage: {
		assets: { public: true, buckets: { uploads: { access: 'private', versioning: true, quotaMb: 5120 } } },
	},
	jobs: {
		cleanup: { schedule: '0 3 * * *', command: ['bun', 'run', 'cleanup'], timeoutSeconds: 300 },
	},
	volumes: { data: { sizeMb: 1024 } },
	domains: [{ host: 'app.example.com', service: 'web' }],
	env: { production: { LOG_LEVEL: 'info' } },
	secrets: { production: ['DATABASE_URL'] },
	attachments: [
		{ database: 'main', prefix: 'DATABASE' },
		{ storage: 'assets', prefix: 'S3', grants: [{ bucket: 'uploads', mode: 'read-write' }] },
	],
	previews: { enabled: true, data: 'schema-seed', ttlHours: 72, maxConcurrent: 5 },
} as const;

describe('skiff.yaml v1', () => {
	test('parses a full document and is idempotent', () => {
		const parsed = blueprintSchema.parse(document);
		expect(parsed.services.web).toMatchObject({ type: 'static', path: 'dist', spa: true, cleanUrls: false });
		expect(parsed.services.api).toMatchObject({
			type: 'process',
			volumes: [{ volume: 'data', mountPath: '/var/lib/app', readOnly: false }],
		});
		expect(parsed.services.worker).toMatchObject({ type: 'container', volumes: [{ readOnly: true }] });
		expect(parsed.databases.main).toMatchObject({ engine: 'postgres', sizeMb: 10240, pooler: true });
		expect(parsed.storage.assets?.buckets.uploads).toMatchObject({ versioning: true, quotaMb: 5120 });
		expect(parsed.jobs.cleanup).toMatchObject({ concurrency: 'forbid', environment: 'production' });
		expect(parsed.volumes.data).toMatchObject({ backing: 'state_dir', singleWriter: true });
		expect(parsed.previews).toEqual({ enabled: true, data: 'schema-seed', ttlHours: 72, maxConcurrent: 5 });
		expect(blueprintSchema.parse(parsed)).toEqual(parsed);
	});

	test('unknown fields fail with a path, at every level', () => {
		for (const bad of [
			{ ...document, extra: true },
			{ ...document, services: { ...document.services, web: { ...document.services.web, extra: true } } },
			{ ...document, databases: { main: { ...document.databases.main, extra: true } } },
			{ ...document, previews: { ...document.previews, extra: true } },
		]) {
			const result = blueprintSchema.safeParse(bad);
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error.message).toContain('Unrecognized key');
		}
	});

	test('cross references are checked before plan', () => {
		const cases = [
			{ ...document, services: { ...document.services, api: { ...document.services.api, volumes: ['missing:/var/lib/app'] } } },
			{ ...document, attachments: [{ database: 'missing', prefix: 'DATABASE' }] },
			{ ...document, domains: [{ host: 'app.example.com', service: 'missing' }] },
			{ ...document, env: { qa: { A: '1' } } },
			{ ...document, attachments: [{ storage: 'assets', prefix: 'S3', grants: [{ bucket: 'missing' }] }] },
			{
				...document,
				services: {
					...document.services,
					api: { ...document.services.api, volumes: ['data:/var/lib/app', 'data:/var/lib/app'] },
				},
			},
			{ ...document, previews: { enabled: true, data: 'fork', ttlHours: 72, maxConcurrent: 5 }, databases: {} },
		];
		for (const bad of cases) expect(blueprintSchema.safeParse(bad).success).toBe(false);
	});

	test('mounts accept both compact and object forms and reject bad paths', () => {
		const withMount = (mounts: unknown[]) =>
			blueprintSchema.safeParse({
				...document,
				services: { ...document.services, api: { ...document.services.api, volumes: mounts } },
			});
		expect(withMount(['data:/var/lib/app:ro']).success).toBe(true);
		expect(withMount([{ volume: 'data', mountPath: '/var/lib/app' }]).success).toBe(true);
		expect(withMount(['data:/etc']).success).toBe(false);
		expect(withMount(['data:relative']).success).toBe(false);
		expect(withMount(['data:/var/lib/app:rw']).success).toBe(false);
		expect(withMount([{ volume: 'data', mountPath: '/var/lib/app', extra: true }]).success).toBe(false);
	});

	test('databases only accept the registered engine and version', () => {
		expect(blueprintSchema.safeParse({ ...document, databases: { main: { engine: 'postgres', version: '99' } } }).success).toBe(
			false,
		);
		expect(blueprintSchema.safeParse({ ...document, databases: { main: { engine: 'valkey' } } }).success).toBe(false);
	});

	test('secret refs are names, never values', () => {
		expect(blueprintSchema.safeParse({ ...document, secrets: { production: 'value' } }).success).toBe(false);
		expect(blueprintSchema.safeParse({ ...document, secrets: { production: ['lowercase'] } }).success).toBe(false);
	});

	test('plan, apply and compose views round-trip', () => {
		const plan: z.output<typeof blueprintPlanViewSchema> = {
			planHash: 'a'.repeat(64),
			project: 'my-app',
			projectAction: 'update',
			resources: [
				{
					key: 'services.web',
					kind: 'service',
					action: 'create',
					changes: [{ path: 'type', from: null, to: 'static' }],
					reason: null,
				},
			],
			summary: { create: 1, update: 0, delete: 0, noop: 4 },
			warnings: [],
			costEstimate: { monthlyUsd: 12.5, currency: 'USD' },
			generatedAt: '2026-11-05T00:00:00.000Z',
		};
		expect(blueprintPlanViewSchema.parse(plan)).toEqual(plan);
		expect(blueprintPlanViewSchema.safeParse({ ...plan, planHash: 'short' }).success).toBe(false);

		const apply: z.output<typeof blueprintApplyViewSchema> = {
			operationId: 'op_1',
			planHash: 'a'.repeat(64),
			status: 'succeeded',
			projectId: 'prj_1',
			resources: [{ key: 'services.web', kind: 'service', id: 'wl_1' }],
			previewUrl: null,
			error: null,
			appliedAt: '2026-11-05T00:00:00.000Z',
		};
		expect(blueprintApplyViewSchema.parse(apply)).toEqual(apply);
		expect(blueprintApplyViewSchema.safeParse({ ...apply, status: 'unknown' }).success).toBe(false);

		const compose: z.output<typeof blueprintComposeImportResultSchema> = {
			services: [{ name: 'web', kind: 'container' }],
			warnings: [{ path: 'services.web.build', message: 'Build is not imported.' }],
			unsupported: [{ path: 'services.web.privileged', reason: 'Privileged containers are not allowed.' }],
			document: blueprintSchema.parse(document),
		};
		expect(blueprintComposeImportResultSchema.parse(compose)).toEqual(compose);
	});
});
