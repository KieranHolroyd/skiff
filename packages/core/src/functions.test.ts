import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, WORKERD_MAX_COMPATIBILITY_DATE } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import { sha256Hex } from './util.ts';
import type { Core } from './index.ts';
import type { InlineFile } from '@yoal/contracts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-functions-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const clock = Date.now();

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES, FUNCTIONS: true, MULTI_NODE_REPLICAS: false },
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const MODULE_SOURCE = 'export default { async fetch() { return new Response("ok"); } };';
const MODULE_BYTES = new TextEncoder().encode(MODULE_SOURCE);
const MODULE_SHA = sha256Hex(MODULE_BYTES);

const file = (path: string, content: string): InlineFile => ({ path, content, encoding: 'utf8' });

/** A manifest plus the matching `index.js` bytes and one static asset. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		main: 'index.js',
		modules: [{ name: 'index.js', type: 'esm', sha256: MODULE_SHA }],
		compatibilityDate: '2026-10-01',
		compatibilityFlags: ['nodejs_compat'],
		bindings: [],
		triggers: { crons: [], queues: [] },
		...overrides,
	};
}

function bundle(overrides: Record<string, unknown> = {}): InlineFile[] {
	return [
		file('yoal-function.json', JSON.stringify(manifest(overrides))),
		file('index.js', MODULE_SOURCE),
		file('public/index.html', '<!doctype html><title>function</title>'),
	];
}

async function createFunctionProject(slug: string) {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'function',
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('phase 1 functions', () => {
	let nodeToken = '';
	let nodeId = '';

	test('registers an edge node that advertises the functions capability', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		nodeId = joined.nodeId;
		core.nodes.heartbeat(nodeToken, {
			nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: ['functions'],
			releases: [],
		});
		expect(core.nodes.list(principal).find((node) => node.id === nodeId)?.capabilities).toContain('functions');
		// The function/database fixtures below exceed the default 1 GiB slice; this test is about
		// admission of bindings, not the node budget.
		core.nodes.update(principal, nodeId, { sliceMemoryMb: 16_384 });
	});

	test('deploys a valid bundle and exposes the resolved function', async () => {
		const project = await createFunctionProject('fn-app');
		await core.secrets.set(principal, { name: 'API_KEY', value: 'super-secret-value' });
		const deployment = await core.uploads.deployInline(
			principal,
			project,
			bundle({
				bindings: [
					{ name: 'GREETING', type: 'text', value: 'hello' },
					{ name: 'SETTINGS', type: 'json', value: { retries: 2 } },
					{ name: 'API_KEY', type: 'secret' },
					{ name: 'HELPER', type: 'service', entrypoint: 'Helper' },
				],
				assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
			}),
			{ promote: true },
		);
		expect(effectiveRuntime(core.projects.requireRow(principal, 'fn-app'))).toBe('function');

		const view = core.functions.view(principal, project);
		expect(view).toMatchObject({
			projectSlug: 'fn-app',
			runtime: 'function',
			deploymentId: deployment.id,
			main: 'index.js',
			moduleCount: 1,
			compatibilityDate: '2026-10-01',
			compatibilityFlags: ['nodejs_compat'],
			triggers: { crons: [], queues: [] },
			assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
			idleStopSeconds: 300,
			workerdVersion: '1.20261106.1',
		});
		expect(view?.bindings).toEqual([
			{ name: 'GREETING', type: 'text', summary: 'text' },
			{ name: 'SETTINGS', type: 'json', summary: 'json' },
			{ name: 'API_KEY', type: 'secret', summary: 'secret API_KEY' },
			{ name: 'HELPER', type: 'service', summary: 'service Helper' },
		]);
		// The view is safe to hand to any reader.
		expect(JSON.stringify(view)).not.toContain('super-secret-value');

		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-app'));
		expect(spec).toMatchObject({
			runtime: 'function',
			memoryMb: 128,
			cpus: 1,
			port: 3000,
			healthPath: '/__yoal/health',
			socketActivation: true,
			ingress: 'http',
			replicas: 1,
			env: {},
			secrets: [{ name: 'API_KEY', delivery: 'env' }],
			function: { main: 'index.js', idleStopSeconds: 300, workerdVersion: '1.20261106.1' },
		});

		const state = await core.nodes.desiredState(nodeToken);
		expect(JSON.stringify(state)).not.toContain('super-secret-value');
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-app');
		expect(workload).toBeDefined();
		expect(workload).toMatchObject({
			runtime: 'function',
			// Functions are socket-activated one socket per desired-state id (phase 4).
			upstream: `unix//run/yoal-workloads/${workload!.id}.sock`,
			function: { main: 'index.js' },
		});
		const route = state.routes.find((item) => item.slug === 'fn-app');
		expect(route?.function).toEqual({ assetsDirectory: 'public', runWorkerFirst: ['/api/*'] });

		const activation = core.workloads.activation(nodeId, workload!.id);
		expect(activation.env.API_KEY).toBe('super-secret-value');
	});

	test('rejects a module whose SHA-256 does not match', async () => {
		const project = await createFunctionProject('fn-bad-digest');
		const wrong = '0'.repeat(64);
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ modules: [{ name: 'index.js', type: 'esm', sha256: wrong }] }),
			),
		).rejects.toThrow(/Module "index\.js" has SHA-256/);
	});

	test('rejects the D1 JSRPC flag, bad cron expressions and an unlisted main module', async () => {
		const project = await createFunctionProject('fn-validation');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({
					bindings: [{ name: 'BUCKET', type: 'd1', database: 'app-db' }],
					compatibilityFlags: ['d1_binding_jsrpc'],
				}),
			),
		).rejects.toThrow('D1 bindings on Yoal use the HTTP binding path');
		await expect(
			core.uploads.deployInline(principal, project, bundle({ triggers: { crons: ['60 * * * *'] } })),
		).rejects.toThrow('Cron minute must be between 0 and 59.');
		await expect(
			core.uploads.deployInline(principal, project, bundle({ main: 'missing.js' })),
		).rejects.toThrow(/main.*must name one of the modules/);
	});

	test('deploys cron triggers and carries them into desired state', async () => {
		const project = await createFunctionProject('fn-cron');
		const crons = ['*/5 * * * *', '0 3 * * 1-5'];
		await core.uploads.deployInline(principal, project, bundle({ triggers: { crons } }));

		const view = core.functions.view(principal, project);
		expect(view?.triggers).toEqual({ crons, queues: [] });

		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-cron');
		expect(workload).toBeDefined();
		expect(workload?.function?.triggers).toEqual({ crons, queues: [] });
	});


	test('same-project service bindings need a named entrypoint', async () => {
		const project = await createFunctionProject('fn-service');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ bindings: [{ name: 'HELPER', type: 'service' }] }),
			),
		).rejects.toThrow('Binding HELPER: same-project service bindings need an entrypoint (Functions phase 1).');
	});

	test('deploys KV and Cache bindings and carries them into desired state', async () => {
		const project = await createFunctionProject('fn-kv-cache');
		await core.uploads.deployInline(
			principal,
			project,
			bundle({
				bindings: [
					{ name: 'CACHE', type: 'kv' },
					{ name: 'HTTP_CACHE', type: 'cache' },
				],
			}),
		);
		const view = core.functions.view(principal, project);
		expect(view?.bindings).toEqual([
			{ name: 'CACHE', type: 'kv', summary: `KV namespace ${project.id}-CACHE` },
			{ name: 'HTTP_CACHE', type: 'cache', summary: 'cache' },
		]);
		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-kv-cache');
		expect(workload?.function?.bindings).toEqual([
			{ name: 'CACHE', type: 'kv', namespaceId: expect.stringMatching(/^[A-Za-z0-9._-]+$/) },
			{ name: 'HTTP_CACHE', type: 'cache' },
		]);
	});

	test('a deploy keeps the project\'s configured stateless replica count', async () => {
		const project = await createFunctionProject('fn-replicas');
		await core.uploads.deployInline(principal, project, bundle());
		const configured = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-replicas'))!;
		core.workloads.setSpec(principal, core.projects.requireRow(principal, 'fn-replicas'), {
			...configured,
			replicas: 3,
		});
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'fn-replicas'), bundle());
		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-replicas'));
		expect(spec?.replicas).toBe(3);
	});

	test('refuses a second cache binding at deploy time', async () => {
		const project = await createFunctionProject('fn-2cache');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({
					bindings: [
						{ name: 'ONE', type: 'cache' },
						{ name: 'TWO', type: 'cache' },
					],
				}),
			),
		).rejects.toThrow(/at most one cache binding/);
	});

	test('rejects a compatibility date newer than the pinned workerd build', async () => {
		const project = await createFunctionProject('fn-future-date');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ compatibilityDate: '2099-01-01' }),
			),
		).rejects.toThrow(`newer than the pinned workerd build (${WORKERD_MAX_COMPATIBILITY_DATE})`);
	});

	test('deploy_site creates a function project from an inline bundle', async () => {
		const result = await core.deploy.deploySite(principal, { name: 'fn-site', files: bundle(), promote: true });
		expect(result.projectCreated).toBe(true);
		const project = core.projects.requireRow(principal, 'fn-site');
		expect(effectiveRuntime(project)).toBe('function');
		expect(core.functions.view(principal, project)?.main).toBe('index.js');
	});

	test('rejects a function bundle while the FUNCTIONS flag is off', async () => {
		const project = await createFunctionProject('fn-flag-off');
		const features = core.ctx.config.features as { FUNCTIONS: boolean };
		features.FUNCTIONS = false;
		try {
			await expect(core.uploads.deployInline(principal, project, bundle())).rejects.toThrow(
				'Functions are not enabled on this platform (YOAL_FEATURE_FUNCTIONS).',
			);
		} finally {
			features.FUNCTIONS = true;
		}
	});

	test('a static project without a manifest still deploys as before', async () => {
		await core.projects.create(principal, {
			name: 'plain-site',
			slug: 'plain-site',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(principal, 'plain-site');
		const deployment = await core.uploads.deployInline(principal, project, [file('index.html', '<h1>hi</h1>')]);
		expect(deployment.release.fileCount).toBe(1);
		expect(core.functions.view(principal, project)).toBeNull();
	});

	test('rejects an assets directory that would expose the worker source', async () => {
		const project = await createFunctionProject('fn-assets');
		await expect(
			core.uploads.deployInline(principal, project, bundle({ assets: { directory: '.' } })),
		).rejects.toThrow(/cannot be the bundle root/);
		await expect(
			core.uploads.deployInline(principal, project, bundle({ assets: { directory: 'static' } })),
		).rejects.toThrow(/Assets directory "static" has no files/);
	});

	test('resolves a Durable Object binding to a stable SQL namespace key', async () => {
		const project = await createFunctionProject('fn-do');
		await core.uploads.deployInline(
			principal,
			project,
			bundle({ bindings: [{ name: 'ROOMS', type: 'durable_object', className: 'Room' }] }),
			{ promote: true },
		);

		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-do'));
		expect(spec?.function?.bindings).toEqual([
			{
				name: 'ROOMS',
				type: 'durable_object',
				className: 'Room',
				// Project id, not the slug: a rename or redeploy keeps the object storage.
				uniqueKey: `${project.id}-ROOMS`,
			},
		]);
		expect(core.functions.view(principal, project)?.bindings).toEqual([
			{ name: 'ROOMS', type: 'durable_object', summary: 'Durable Object Room' },
		]);
	});

	test('resolves an attached Postgres database as Hyperdrive with its env prefix', async () => {
		const project = await createFunctionProject('fn-hyperdrive');
		core.databases.create(principal, {
			name: 'app-db',
			project: 'fn-hyperdrive',
			envPrefix: 'LEDGER',
		});
		await core.uploads.deployInline(
			principal,
			project,
			bundle({ bindings: [{ name: 'DB', type: 'hyperdrive', database: 'app-db' }] }),
			{ promote: true },
		);

		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-hyperdrive'));
		expect(spec?.function?.bindings).toEqual([
			{ name: 'DB', type: 'hyperdrive', database: 'app-db', envPrefix: 'LEDGER' },
		]);
		expect(core.functions.view(principal, project)?.bindings).toEqual([
			{ name: 'DB', type: 'hyperdrive', summary: 'Hyperdrive database app-db' },
		]);

		// The attachment's connection values arrive only through the activation env.
		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-hyperdrive')!;
		const activation = core.workloads.activation(nodeId, workload.id);
		expect(activation.env.LEDGER_POOL_HOST).toBe('127.0.0.1');
		expect(activation.env.LEDGER_USER).toBeTruthy();
		expect(activation.env.LEDGER_PASSWORD).toBeTruthy();
		// Desired state itself never carries them.
		expect(JSON.stringify(state)).not.toContain(activation.env.LEDGER_PASSWORD!);
	});

	test('refuses a Hyperdrive binding whose database is not attached', async () => {
		const project = await createFunctionProject('fn-hyperdrive-unattached');
		core.databases.create(principal, { name: 'free-db' });
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ bindings: [{ name: 'DB', type: 'hyperdrive', database: 'free-db' }] }),
			),
		).rejects.toThrow(
			'Binding DB: attach database "free-db" to this project before using it as a Hyperdrive binding.',
		);
	});

	test('refuses a missing Hyperdrive database', async () => {
		const project = await createFunctionProject('fn-hyperdrive-bad');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ bindings: [{ name: 'DB', type: 'hyperdrive', database: 'nope' }] }),
			),
		).rejects.toThrow('Binding DB: database "nope" does not exist in this organisation.');
	});

	test('a redeploy without yoal-function.json infers modules from the previous spec', async () => {
		const project = await createFunctionProject('fn-inferred');
		await core.uploads.deployInline(principal, project, bundle({ assets: { directory: 'public' } }));
		const updated = 'export default { async fetch() { return new Response("v2"); } };';
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'fn-inferred'), [
			file('index.js', updated),
			file('public/index.html', '<!doctype html><title>v2</title>'),
		]);
		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-inferred'));
		expect(spec?.function?.main).toBe('index.js');
		expect(spec?.function?.modules).toEqual([
			{ name: 'index.js', type: 'esm', sha256: sha256Hex(updated) },
		]);
		expect(spec?.function?.assets?.directory).toBe('public');
	});

	test('a first deploy without yoal-function.json accepts a prebuilt Worker', async () => {
		const project = await createFunctionProject('fn-no-manifest');
		await core.secrets.set(principal, { name: 'API_KEY', value: 'secret-value', projectId: project.id });
		await core.uploads.deployInline(principal, project, [
			file('index.js', 'export default { fetch() { return new Response("ok"); } };'),
			file('public/index.html', '<!doctype html><title>built</title>'),
		]);
		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-no-manifest'));
		expect(spec?.function?.main).toBe('index.js');
		expect(spec?.function?.assets?.directory).toBe('public');
		expect(spec?.function?.compatibilityDate).toBe('2026-10-01');
		expect(spec?.function?.bindings).toEqual([{ name: 'API_KEY', type: 'secret' }]);
		expect(spec?.secrets).toEqual([{ name: 'API_KEY', delivery: 'env' }]);
	});

	test('a manifest-less redeploy without a built module is refused', async () => {
		const project = await createFunctionProject('fn-no-module');
		await core.uploads.deployInline(principal, project, bundle());
		await expect(
			core.uploads.deployInline(principal, core.projects.requireRow(principal, 'fn-no-module'), [
				file('README.md', 'only docs'),
			]),
		).rejects.toThrow('No built Worker module was found');
	});

	test('an assets binding needs the manifest assets directory', async () => {
		const project = await createFunctionProject('fn-assets-required');
		await expect(
			core.uploads.deployInline(
				principal,
				project,
				bundle({ bindings: [{ name: 'SITE', type: 'assets' }] }),
			),
		).rejects.toThrow('Binding SITE: an assets binding needs the manifest');
	});

	// Queues need a managed broker (D112); function-queues.test.ts covers them.
	test('deploys D1, assets and Analytics Engine and carries them into desired state', async () => {
		const project = await createFunctionProject('fn-rest');
		await core.uploads.deployInline(
			principal,
			project,
			bundle({
				bindings: [
					{ name: 'DB', type: 'd1', database: 'app-db' },
					{ name: 'EVENTS', type: 'analytics_engine', dataset: 'events' },
					{ name: 'SITE', type: 'assets' },
				],
				assets: { directory: 'public' },
			}),
		);
		const view = core.functions.view(principal, project);
		expect(view?.bindings.map((binding) => binding.type)).toEqual([
			'd1',
			'analytics_engine',
			'assets',
		]);
		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-rest');
		expect(workload?.function?.bindings.map((binding) => binding.type)).toEqual([
			'd1',
			'analytics_engine',
			'assets',
		]);
	});

});

describe('resource-scoped access', () => {
	test('a project-scoped viewer reads only that function’s view and invocations', async () => {
		await createFunctionProject('scoped-fn-visible');
		await createFunctionProject('scoped-fn-hidden');
		const visible = core.projects.requireRow(principal, 'scoped-fn-visible');
		const hidden = core.projects.requireRow(principal, 'scoped-fn-hidden');
		// Inserted directly so iamVersion stays 0 and the owner in the rest of this file keeps its
		// legacy org-wide grants.
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_guest_functions', 'org_1', 'user', 'user_guest_functions', 'viewer', 'project', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({
			kind: 'user',
			userId: 'user_guest_functions',
			orgId: 'org_1',
			role: 'viewer',
		});

		expect(core.functions.view(guest, visible)).toBeNull();
		expect(() => core.functions.view(guest, hidden)).toThrow(/deployment:read/);
		expect(await core.functions.invocations(guest, visible, { from: 0, to: Date.now() })).toEqual({
			available: false,
			rows: [],
		});
		await expect(
			core.functions.invocations(guest, hidden, { from: 0, to: Date.now() }),
		).rejects.toThrow(/logs:read/);
	});
});
