import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	attachmentTarget,
	blueprintApplyRequestSchema,
	blueprintApplyViewSchema,
	blueprintComposeImportResultSchema,
	blueprintPlanRequestSchema,
	blueprintPlanViewSchema,
	blueprintSchema,
	defaultAttachmentPrefix,
} from './blueprint.ts';

/** A v1 stack: one app with a database, a bucket and a queue, plus a static marketing site. */
const document = {
	apiVersion: 'skiff/v1',
	name: 'shop',
	projects: {
		'shop-web': {
			runtime: 'static',
			access: { production: 'public', previews: 'platform' },
			environments: { staging: { access: 'platform' } },
			domains: ['Shop.Example.com.'],
		},
		'shop-api': {
			name: 'Shop API',
			runtime: 'process',
			placement: 'auto',
			command: ['bun', 'run', 'start'],
			port: 3000,
			healthPath: '/health',
			memoryMb: 256,
			cpus: 1,
			env: { LOG_LEVEL: 'info' },
			secrets: ['STRIPE_KEY'],
		},
	},
	databases: {
		'shop-db': { engine: 'postgres', version: '18', storageMb: 10240, extensions: ['pgvector', 'pg_trgm'] },
		'shop-cache': { engine: 'valkey' },
	},
	storage: {
		'shop-assets': { public: true, buckets: { uploads: { access: 'private', versioning: true, quotaMb: 5120 } } },
	},
	brokers: { 'shop-queue': { engine: 'nats' } },
	attachments: [
		{ project: 'shop-api', database: 'shop-db' },
		{ project: 'shop-api', database: 'shop-cache' },
		{ project: 'shop-api', storage: 'shop-assets', grants: [{ bucket: 'uploads' }] },
		{ project: 'shop-api', broker: 'shop-queue', prefix: 'QUEUE' },
	],
} as const;

const fails = (value: unknown) => blueprintSchema.safeParse(value).success === false;
const messages = (value: unknown): string => {
	const result = blueprintSchema.safeParse(value);
	return result.success ? '' : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
};

describe('blueprint v1 document', () => {
	test('parses a full stack, fills defaults and is idempotent', () => {
		const parsed = blueprintSchema.parse(document);
		expect(parsed.projects['shop-web']).toMatchObject({ runtime: 'static', domains: ['shop.example.com'] });
		expect(parsed.projects['shop-api']).toMatchObject({ runtime: 'process', environments: {}, domains: [] });
		expect(parsed.databases['shop-db']).toMatchObject({ engine: 'postgres', version: '18', extensions: ['pgvector', 'pg_trgm'] });
		// Unset fields stay unset, so they are never managed.
		expect(parsed.databases['shop-cache']).toEqual({ engine: 'valkey' });
		expect(parsed.storage['shop-assets']?.buckets.uploads).toEqual({ access: 'private', versioning: true, quotaMb: 5120 });
		expect(parsed.brokers['shop-queue']).toEqual({ engine: 'nats' });
		expect(parsed.attachments[2]?.grants).toEqual([{ bucket: 'uploads', mode: 'read-write' }]);
		expect(blueprintSchema.parse(parsed)).toEqual(parsed);
	});

	test('the smallest document is a name and an apiVersion', () => {
		expect(blueprintSchema.parse({ apiVersion: 'skiff/v1', name: 'empty' })).toEqual({
			apiVersion: 'skiff/v1',
			name: 'empty',
			projects: {},
			databases: {},
			storage: {},
			brokers: {},
			attachments: [],
		});
		expect(fails({ apiVersion: 'skiff/v2', name: 'empty' })).toBe(true);
		expect(fails({ name: 'empty' })).toBe(true);
	});

	test('unknown fields fail with their path, at every level', () => {
		const cases: Array<[unknown, string]> = [
			[{ ...document, extra: true }, ''],
			[{ ...document, projects: { 'shop-web': { ...document.projects['shop-web'], spa: true } } }, 'projects.shop-web'],
			[{ ...document, databases: { 'shop-db': { engine: 'postgres', sizeMb: 1 } } }, 'databases.shop-db'],
			[{ ...document, storage: { 'shop-assets': { buckets: { uploads: { lock: true } } } } }, 'storage.shop-assets.buckets.uploads'],
			[{ ...document, attachments: [{ project: 'shop-api', database: 'shop-db', role: 'app' }] }, 'attachments.0'],
		];
		for (const [bad, path] of cases) {
			const text = messages(bad);
			expect(text).toContain('Unrecognized key');
			expect(text.startsWith(path)).toBe(true);
		}
	});

	test('names are checked like the resources they create', () => {
		expect(fails({ ...document, name: 'plan' })).toBe(true);
		expect(fails({ ...document, name: 'Shop' })).toBe(true);
		expect(fails({ apiVersion: 'skiff/v1', name: 'x', projects: {} })).toBe(true);
		expect(fails({ apiVersion: 'skiff/v1', name: 'ok-name', projects: { 'a--b': {} } })).toBe(true);
		expect(messages({ apiVersion: 'skiff/v1', name: 'pgs', databases: { 'pg-main': {} } })).toContain('cannot start with "pg-"');
		expect(fails({ apiVersion: 'skiff/v1', name: 'envs', projects: { site: { environments: { production: {} } } } })).toBe(true);
		expect(fails({ apiVersion: 'skiff/v1', name: 'envs', projects: { site: { environments: { s3: {} } } } })).toBe(true);
	});

	test('workload settings only fit process and container projects', () => {
		const project = (value: Record<string, unknown>) => ({ apiVersion: 'skiff/v1', name: 'apps', projects: { app: value } });
		expect(messages(project({ runtime: 'static', port: 3000 }))).toContain('Static projects have no workload settings');
		expect(messages(project({ runtime: 'function', memoryMb: 128 }))).toContain('function bundle');
		expect(messages(project({ runtime: 'process', image: 'nginx:1' }))).toContain('Only container projects take an image');
		expect(fails(project({ runtime: 'container', image: 'nginx:1.27', port: 8080 }))).toBe(false);
		expect(messages(project({ runtime: 'process', secrets: ['A', 'A'] }))).toContain('referenced once');
		expect(messages(project({ runtime: 'process', env: { A: '1' }, secrets: ['A'] }))).toContain('also a secret reference');
		expect(messages(project({ domains: ['a.example.com', 'A.example.com'] }))).toContain('listed once');
		expect(fails(project({ domains: ['https://a.example.com/'] }))).toBe(true);
	});

	test('secret references are names, never values', () => {
		const withSecrets = (secrets: unknown) => ({
			apiVersion: 'skiff/v1',
			name: 'apps',
			projects: { app: { runtime: 'process', secrets } },
		});
		expect(fails(withSecrets(['STRIPE_KEY']))).toBe(false);
		expect(fails(withSecrets('sk_live_123'))).toBe(true);
		expect(fails(withSecrets(['lowercase']))).toBe(true);
		expect(fails(withSecrets({ STRIPE_KEY: 'sk_live_123' }))).toBe(true);
	});

	test('databases and brokers only accept their registered engine, version and features', () => {
		const db = (value: Record<string, unknown>) => ({ apiVersion: 'skiff/v1', name: 'data', databases: { main: value } });
		expect(fails(db({ engine: 'postgres', version: '99' }))).toBe(true);
		expect(fails(db({ engine: 'oracle' }))).toBe(true);
		expect(fails(db({ engine: 'valkey', version: '18' }))).toBe(true);
		expect(messages(db({ engine: 'mysql', extensions: ['pg_trgm'] }))).toContain('has no extensions');
		expect(messages(db({ engine: 'valkey', pooler: true }))).toContain('no connection pooler');
		expect(messages(db({ engine: 'postgres', memoryMb: 128 }))).toBe('');
		expect(fails({ apiVersion: 'skiff/v1', name: 'data', brokers: { jobs: { version: '1.0' } } })).toBe(true);
		expect(fails({ apiVersion: 'skiff/v1', name: 'data', brokers: { jobs: { engine: 'kafka' } } })).toBe(true);
	});

	test('cross references are checked before any live state is read', () => {
		const withAttachments = (attachments: unknown[]) => ({ ...document, attachments });
		expect(messages(withAttachments([{ project: 'missing', database: 'shop-db' }]))).toContain('not declared under projects');
		expect(messages(withAttachments([{ project: 'shop-web', database: 'shop-db' }]))).toContain('is static');
		expect(messages(withAttachments([{ project: 'shop-api', database: 'missing' }]))).toContain('Database "missing" is not declared');
		expect(messages(withAttachments([{ project: 'shop-api', broker: 'missing' }]))).toContain('Broker "missing"');
		expect(messages(withAttachments([{ project: 'shop-api', database: 'shop-db', storage: 'shop-assets' }]))).toContain(
			'exactly one',
		);
		expect(messages(withAttachments([{ project: 'shop-api' }]))).toContain('exactly one');
		expect(
			messages(withAttachments([{ project: 'shop-api', storage: 'shop-assets', grants: [{ bucket: 'missing' }] }])),
		).toContain('Bucket "missing" is not declared');
		expect(messages(withAttachments([{ project: 'shop-api', storage: 'shop-assets' }]))).toContain('at least one bucket');
		expect(messages(withAttachments([{ project: 'shop-api', database: 'shop-db', grants: [{ bucket: 'uploads' }] }]))).toContain(
			'Only storage attachments',
		);
		expect(
			messages(
				withAttachments([
					{ project: 'shop-api', database: 'shop-db' },
					{ project: 'shop-api', database: 'shop-db' },
				]),
			),
		).toContain('listed twice');
		// Two Postgres databases would both default to DATABASE_URL.
		const twoPostgres = {
			...document,
			databases: { ...document.databases, 'shop-db-2': { engine: 'postgres' } },
			attachments: [
				{ project: 'shop-api', database: 'shop-db' },
				{ project: 'shop-api', database: 'shop-db-2' },
			],
		};
		expect(messages(twoPostgres)).toContain('already uses this env prefix');
		expect(
			fails({
				...twoPostgres,
				attachments: [
					{ project: 'shop-api', database: 'shop-db' },
					{ project: 'shop-api', database: 'shop-db-2', prefix: 'ANALYTICS' },
				],
			}),
		).toBe(false);
		expect(messages(withAttachments([{ project: 'shop-api', database: 'shop-db', prefix: 'database_' }]))).not.toBe('');
	});

	test('attachment helpers name the target and its default prefix', () => {
		const parsed = blueprintSchema.parse(document);
		expect(parsed.attachments.map(attachmentTarget)).toEqual([
			{ type: 'database', name: 'shop-db' },
			{ type: 'database', name: 'shop-cache' },
			{ type: 'storage', name: 'shop-assets' },
			{ type: 'broker', name: 'shop-queue' },
		]);
		expect(defaultAttachmentPrefix(parsed, { type: 'database', name: 'shop-db' })).toBe('DATABASE');
		expect(defaultAttachmentPrefix(parsed, { type: 'database', name: 'shop-cache' })).toBe('REDIS');
		expect(defaultAttachmentPrefix(parsed, { type: 'storage', name: 'shop-assets' })).toBe('S3');
		expect(defaultAttachmentPrefix(parsed, { type: 'broker', name: 'shop-queue' })).toBe('NATS');
	});
});

describe('blueprint plan and apply wire shapes', () => {
	const hash = 'a'.repeat(64);

	test('plan and apply requests', () => {
		expect(blueprintPlanRequestSchema.parse({ document: 'apiVersion: skiff/v1\nname: shop\n' })).toEqual({
			document: 'apiVersion: skiff/v1\nname: shop\n',
			prune: false,
		});
		expect(blueprintPlanRequestSchema.parse({ document: { apiVersion: 'skiff/v1' }, prune: true }).prune).toBe(true);
		expect(blueprintPlanRequestSchema.safeParse({ document: '' }).success).toBe(false);
		expect(blueprintPlanRequestSchema.safeParse({ document: 'x', extra: 1 }).success).toBe(false);
		expect(blueprintApplyRequestSchema.parse({ planHash: hash })).toEqual({ planHash: hash });
		expect(blueprintApplyRequestSchema.safeParse({ planHash: 'short' }).success).toBe(false);
	});

	test('plan, apply and compose views round-trip', () => {
		const plan: z.output<typeof blueprintPlanViewSchema> = {
			planHash: hash,
			stack: 'shop',
			stackAction: 'create',
			operationId: 'op_1',
			prune: false,
			resources: [
				{
					key: 'projects.shop-web',
					kind: 'project',
					action: 'create',
					changes: [{ path: 'runtime', from: null, to: 'static' }],
					reason: null,
				},
				{ key: 'databases.shop-db', kind: 'database', action: 'noop', changes: [], reason: 'up to date' },
			],
			summary: { create: 1, update: 0, delete: 0, noop: 1 },
			warnings: [],
			generatedAt: '2026-11-07T00:00:00.000Z',
			expiresAt: '2026-11-07T01:00:00.000Z',
		};
		expect(blueprintPlanViewSchema.parse(plan)).toEqual(plan);
		expect(blueprintPlanViewSchema.safeParse({ ...plan, planHash: 'short' }).success).toBe(false);
		expect(blueprintPlanViewSchema.safeParse({ ...plan, stackAction: 'delete' }).success).toBe(false);
		expect(
			blueprintPlanViewSchema.safeParse({ ...plan, resources: [{ ...plan.resources[0], kind: 'job' }] }).success,
		).toBe(false);

		const apply: z.output<typeof blueprintApplyViewSchema> = {
			operationId: 'op_1',
			planHash: hash,
			stack: 'shop',
			status: 'partial',
			done: 2,
			total: 3,
			resources: [
				{ key: 'projects.shop-web', kind: 'project', action: 'create', status: 'succeeded', reason: null, error: null },
				{ key: 'databases.shop-db', kind: 'database', action: 'create', status: 'failed', reason: null, error: 'No room' },
				{
					key: 'attachments.shop-api.database.shop-db',
					kind: 'attachment',
					action: 'create',
					status: 'skipped',
					reason: 'an earlier step failed',
					error: null,
				},
			],
			error: null,
			appliedAt: null,
		};
		expect(blueprintApplyViewSchema.parse(apply)).toEqual(apply);
		expect(blueprintApplyViewSchema.safeParse({ ...apply, status: 'unknown' }).success).toBe(false);
		expect(
			blueprintApplyViewSchema.parse({ operationId: 'op_2', planHash: hash, stack: 'shop', status: 'applying', done: 0, total: 1 }),
		).toMatchObject({ resources: [], error: null, appliedAt: null });

		const compose: z.output<typeof blueprintComposeImportResultSchema> = {
			services: [{ name: 'web', kind: 'container' }],
			warnings: [{ path: 'services.web.build', message: 'Build is not imported.' }],
			unsupported: [{ path: 'services.web.privileged', reason: 'Privileged containers are not allowed.' }],
			document: blueprintSchema.parse(document),
		};
		expect(blueprintComposeImportResultSchema.parse(compose)).toEqual(compose);
	});
});
