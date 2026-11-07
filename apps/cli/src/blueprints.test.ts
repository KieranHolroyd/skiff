import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import {
	findBlueprintFile,
	hasChanges,
	issueLines,
	planLines,
	planSummary,
	runOutcome,
	runTable,
	type BlueprintPlanView,
	type BlueprintRunView,
} from './blueprints.ts';
import { ApiError } from './errors.ts';

const hash = 'a'.repeat(64);

const plan: BlueprintPlanView = {
	planHash: hash,
	stack: 'shop',
	stackAction: 'update',
	operationId: 'op_1',
	prune: false,
	resources: [
		{ key: 'projects.shop-web', kind: 'project', action: 'noop', changes: [], reason: 'up to date' },
		{
			key: 'databases.shop-db',
			kind: 'database',
			action: 'update',
			changes: [{ path: 'storageMb', from: '1024', to: '2048' }],
			reason: null,
		},
		{ key: 'brokers.shop-queue', kind: 'broker', action: 'create', changes: [{ path: 'engine', from: null, to: 'nats' }], reason: null },
		{ key: 'projects.old', kind: 'project', action: 'delete', changes: [], reason: 'no longer in the file' },
	],
	summary: { create: 1, update: 1, delete: 1, noop: 1 },
	warnings: [],
	generatedAt: '2026-11-07T10:00:00.000Z',
	expiresAt: '2026-11-07T11:00:00.000Z',
};

describe('blueprint output', () => {
	test('finds the default file names in order', () => {
		const present = new Set(['/w/skiff.blueprint.yml', '/w/skiff.blueprint.json']);
		expect(findBlueprintFile(undefined, '/w', (path) => present.has(path))).toBe('/w/skiff.blueprint.yml');
		expect(findBlueprintFile('stack.yaml', '/w', () => false)).toBe('stack.yaml');
		expect(findBlueprintFile(undefined, '/w', () => false)).toBeNull();
	});

	test('plans list changes, hide up-to-date resources by default and summarise', () => {
		expect(planLines(plan)).toEqual([
			'~ update databases.shop-db',
			'      storageMb: 1024 → 2048',
			'+ create brokers.shop-queue',
			'      engine: - → nats',
			'- delete projects.old  (no longer in the file)',
		]);
		expect(planLines(plan, { all: true })[0]).toBe('= noop   projects.shop-web');
		expect(planSummary(plan)).toBe('Stack "shop": 1 to create, 1 to update, 1 to delete, 1 up to date.');
		expect(hasChanges(plan)).toBe(true);
		expect(hasChanges({ summary: { create: 0, update: 0, delete: 0, noop: 4 } })).toBe(false);
	});

	test('runs show every step and why one was skipped', () => {
		const run: BlueprintRunView = {
			operationId: 'op_1',
			planHash: hash,
			stack: 'shop',
			status: 'partial',
			done: 3,
			total: 3,
			resources: [
				{ key: 'projects.shop-web', kind: 'project', action: 'noop', status: 'skipped', reason: 'up to date', error: null },
				{ key: 'databases.shop-db', kind: 'database', action: 'update', status: 'succeeded', reason: null, error: null },
				{ key: 'storage.media', kind: 'storage', action: 'create', status: 'failed', reason: null, error: 'No node has room' },
				{ key: 'brokers.jobs', kind: 'broker', action: 'create', status: 'skipped', reason: 'an earlier step failed', error: null },
			],
			error: 'storage.media: No node has room',
			appliedAt: null,
		};
		expect(runTable(run)).toContain('storage.media      create  failed     No node has room');
		expect(runOutcome(run)).toBe('Partial: 1 succeeded, 1 failed, 1 skipped, 1 up to date.\nStopped at storage.media: No node has room');
		expect(runOutcome({ ...run, status: 'succeeded', error: null, resources: run.resources.slice(0, 2) })).toBe(
			'Applied: 1 succeeded, 1 up to date.',
		);
	});

	test('422 issues are printed one per line with their path', () => {
		expect(
			issueLines({
				issues: [
					{ path: ['projects.api.service'], message: 'Secret STRIPE_KEY does not exist.' },
					{ path: [], message: 'Top-level problem.' },
				],
			}),
		).toEqual(['  projects.api.service: Secret STRIPE_KEY does not exist.', '  Top-level problem.']);
		expect(issueLines(null)).toEqual([]);
	});
});

describe('blueprint API calls', () => {
	test('send the document as text and unwrap plan and run', async () => {
		const seen: Array<{ method: string; path: string; body: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const body = request.method === 'GET' ? null : await request.json();
				seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
				if (url.pathname.endsWith('/validate'))
					return Response.json({ validation: { stack: 'shop', document: {}, resources: { projects: 2 } } });
				if (url.pathname.endsWith('/plan')) return Response.json({ plan });
				if (url.pathname === '/api/v1/blueprints/apply')
					return Response.json({ run: { operationId: 'op_1', planHash: hash, stack: 'shop', status: 'applying', done: 0, total: 3 } }, { status: 202 });
				if (url.pathname === '/api/v1/blueprints/apply/op_1')
					return Response.json({ run: { operationId: 'op_1', planHash: hash, stack: 'shop', status: 'succeeded', done: 3, total: 3, resources: [] } });
				return Response.json(
					{ error: 'validation', message: 'The plan has 2 problems.', issues: [{ path: ['a'], message: 'x' }, { path: ['b'], message: 'y' }] },
					{ status: 422 },
				);
			},
		});
		try {
			const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'sk_test', origin: 'http://127.0.0.1' });
			expect((await client.validateBlueprint('apiVersion: skiff/v1\nname: shop\n')).validation.stack).toBe('shop');
			expect((await client.planBlueprint('name: shop', { prune: true })).plan.planHash).toBe(hash);
			const started = await client.applyBlueprint({ planHash: hash, confirm: 'shop' }, { waitSeconds: 5 });
			expect(started.run).toMatchObject({ status: 'applying', resources: [] });
			expect((await client.getBlueprintRun('op_1')).run.status).toBe('succeeded');
			expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
				'POST /api/v1/blueprints/validate',
				'POST /api/v1/blueprints/plan',
				'POST /api/v1/blueprints/apply?wait=5',
				'GET /api/v1/blueprints/apply/op_1',
			]);
			expect(seen[1]?.body).toEqual({ document: 'name: shop', prune: true });
			expect(seen[2]?.body).toEqual({ planHash: hash, confirm: 'shop' });
			const error = await client.getBlueprintRun('missing').catch((caught) => caught);
			expect(error).toBeInstanceOf(ApiError);
			expect(issueLines((error as ApiError).body)).toEqual(['  a: x', '  b: y']);
		} finally {
			server.stop(true);
		}
	});
});
