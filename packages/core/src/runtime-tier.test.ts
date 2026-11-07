import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DEFAULT_FEATURES, WORKERD_PINNED_VERSION, type FeatureFlags } from '@skiff/contracts';
import { createDb, deployments, projects, workloads } from '@skiff/db';
import { createCore } from './index.ts';
import { buildPrincipal } from './orgs.ts';
import { LocalObjectStore } from './object-store.ts';
import { sha256Hex } from './util.ts';
import { effectiveRuntime, storedRuntime } from './runtime-tier.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-runtime-tier-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.now();

const config = {
	dataDir: dir,
	platformOrigin: 'https://control.test',
	contentDomain: 'sites.test',
	objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
	masterKey: new Uint8Array(32).fill(7),
	siteCookieSecret: 'site-cookie-secret-123',
	objectStoreSecret: 'object-secret-123',
	desiredAgentVersion: '0.1.0',
	now: () => clock,
};

/** Functions on by default; a node/control plane can still disable the tier explicitly. */
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: { ...config, features: { ...DEFAULT_FEATURES, FUNCTIONS: true } satisfies FeatureFlags },
});

/** A second control plane on the same database with Functions explicitly disabled. */
const withoutFunctions: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: { ...config, features: { ...DEFAULT_FEATURES, FUNCTIONS: false } satisfies FeatureFlags },
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** The module bytes; the manifest digest and the expected resolved spec both use them. */
const moduleSource = 'export default { fetch() { return new Response("ok"); } };';

/** A resolved function spec: one ESM module and a static asset directory with a worker-first glob. */
const resolvedFunction = {
	main: 'index.js',
	modules: [{ name: 'index.js', type: 'esm' as const, sha256: sha256Hex(moduleSource) }],
	compatibilityDate: '2026-01-01',
	compatibilityFlags: [],
	bindings: [],
	triggers: { crons: [], queues: [] },
	assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
	idleStopSeconds: 300,
	workerdVersion: WORKERD_PINNED_VERSION,
};

/** The bundle B's FunctionService validates: the manifest, its module bytes and the asset files. */
const functionBundle = () => [
	file('index.js', moduleSource),
	file('public/index.html', '<h1>fn</h1>'),
	file(
		'skiff-function.json',
		JSON.stringify({
			version: 1,
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: sha256Hex(moduleSource) }],
			compatibilityDate: '2026-01-01',
			compatibilityFlags: [],
			bindings: [],
			triggers: { crons: [], queues: [] },
			assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
			idleStopSeconds: 300,
			memoryMb: 128,
			cpus: 1,
		}),
	),
];

const functionWorkload = {
	runtime: 'function' as const,
	function: resolvedFunction,
	memoryMb: 128,
	cpus: 1,
	port: 3000,
	healthPath: '/',
	socketActivation: true,
	env: {},
	secrets: [],
};

function joinNode(name: string, capabilities: string[]) {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
	core.nodes.heartbeat(joined.token, {
		nodeId: joined.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities,
	});
	return joined;
}

const project = (slug: string, runtime: 'static' | 'process' | 'container' | 'function', placement = 'auto') =>
	core.projects.create(principal, {
		name: slug,
		slug,
		runtime,
		placement,
		productionAccess: 'public',
		previewAccess: 'platform',
	});

describe('runtime tier conversions', () => {
	test('effectiveRuntime prefers runtime_name and falls back for legacy rows', () => {
		expect(effectiveRuntime({ runtime: 'process' })).toBe('process');
		expect(effectiveRuntime({ runtime: 'process', runtimeName: null })).toBe('process');
		expect(effectiveRuntime({ runtime: 'container', runtimeName: null })).toBe('container');
		expect(effectiveRuntime({ runtime: 'process', runtimeName: 'function' })).toBe('function');
		expect(effectiveRuntime({ runtime: 'static', runtimeName: 'static' })).toBe('static');
		// A value the CHECK could never hold is not trusted as a tier.
		expect(effectiveRuntime({ runtime: 'nonsense', runtimeName: null })).toBe('static');
	});

	test('storedRuntime maps function onto the legacy process column', () => {
		expect(storedRuntime('function')).toBe('process');
		expect(storedRuntime('process')).toBe('process');
		expect(storedRuntime('container')).toBe('container');
		expect(storedRuntime('static')).toBe('static');
	});
});

describe('the fourth runtime tier, end to end', () => {
	const edge = joinNode('edge', ['functions']);
	const worker = joinNode('worker', ['functions']);
	core.nodes.update(principal, worker.nodeId, { publicAddress: '10.0.0.5:8080' });

	test('a function project is rejected while the flag is off', async () => {
		await expect(
			withoutFunctions.projects.create(principal, {
				name: 'fn-off',
				slug: 'fn-off',
				runtime: 'function',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			}),
		).rejects.toThrow('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');
		expect(opened.db.select().from(projects).where(eq(projects.slug, 'fn-off')).get()).toBeUndefined();
	});

	test('creating a function project stores the legacy runtime and reports the tier', async () => {
		const view = await project('fn-app', 'function', edge.nodeId);
		expect(view.runtime).toBe('function');
		const row = opened.db.select().from(projects).where(eq(projects.slug, 'fn-app')).get()!;
		expect(row.runtime).toBe('process');
		expect(row.runtimeName).toBe('function');
		// static/process/container store their own name too, so new rows are consistent.
		const plain = await project('plain-static', 'static');
		expect(plain.runtime).toBe('static');
		const plainRow = opened.db.select().from(projects).where(eq(projects.slug, 'plain-static')).get()!;
		expect(plainRow).toMatchObject({ runtime: 'static', runtimeName: 'static' });
	});

	test('a function project without a manifest cannot plan a deploy', async () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		expect(() => core.workloads.defaultSpec(fn)).toThrow(
			'Project "fn-app" needs a skiff-function.json bundle before it can deploy.',
		);
		expect(() => core.workloads.plan(principal, fn)).toThrow(/needs a skiff-function\.json bundle/);
	});

	test('a plan refuses a node whose heartbeat did not advertise functions', async () => {
		const plain = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'plain-node').token, name: 'plain-node' });
		core.nodes.heartbeat(plain.token, {
			nodeId: plain.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: ['studio-principal'],
		});
		await project('fn-unsupported', 'function', plain.nodeId);
		const unsupported = core.projects.requireRow(principal, 'fn-unsupported');
		core.workloads.setSpec(principal, unsupported, functionWorkload);
		expect(() => core.workloads.plan(principal, core.projects.requireRow(principal, 'fn-unsupported'))).toThrow(
			'Node "plain-node" does not support functions; update the node\'s agent first.',
		);
	});

	test('saving a function spec and deploying keeps the legacy columns, sends the tier', async () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		expect(core.workloads.setSpec(principal, fn, functionWorkload)).toBeNull();
		expect(core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-app'))?.function).toEqual(
			resolvedFunction,
		);

		const deployment = await core.uploads.deployInline(principal, fn, functionBundle(), { promote: true });
		expect(deployment.runtime).toBe('function');
		const deploymentRow = opened.db.select().from(deployments).where(eq(deployments.id, deployment.id)).get()!;
		expect(deploymentRow.runtime).toBe('process');
		expect(deploymentRow.runtimeName).toBe('function');

		const workloadRow = opened.db.select().from(workloads).where(eq(workloads.projectId, fn.id)).get()!;
		expect(workloadRow.runtime).toBe('process');
		expect(workloadRow.runtimeName).toBe('function');
		expect(core.workloads.view(core.projects.requireRow(principal, 'fn-app'))?.runtime).toBe('function');
		expect(core.deployments.get(principal, fn, deployment.id).runtime).toBe('function');

		const desired = core.workloads.desiredForNode(edge.nodeId).find((item) => item.projectId === fn.id)!;
		expect(desired.runtime).toBe('function');
		expect(desired.function).toEqual(resolvedFunction);
		expect(desired.socketActivation).toBe(true);
		// Phase 4: a function's socket is named after its workload id, not the project id.
		const workloadId = core.workloads.view(fn)!.id;
		expect(desired.id).toBe(workloadId);
		expect(desired.upstream).toBe(`unix//run/skiff-workloads/${workloadId}.sock`);
	});

	test('the local route carries the function assets and the edge route does not', async () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		const local = await core.nodes.desiredState(edge.token);
		const route = local.routes.find((item) => item.projectId === fn.id)!;
		expect(route.function).toEqual({ assetsDirectory: 'public', runWorkerFirst: ['/api/*'] });
		expect(route.upstream).toBe(`unix//run/skiff-workloads/${core.workloads.view(fn)!.id}.sock`);

		// A worker-placed function is proxied by the edge, which has no release to serve assets from.
		await project('fn-remote', 'function', worker.nodeId);
		const remote = core.projects.requireRow(principal, 'fn-remote');
		core.workloads.setSpec(principal, remote, functionWorkload);
		await core.uploads.deployInline(principal, remote, functionBundle(), { promote: true });

		const edgeState = await core.nodes.desiredState(edge.token);
		const edgeRoute = edgeState.routes.find((item) => item.projectId === remote.id)!;
		expect(edgeRoute.function).toBeUndefined();
		expect(edgeRoute.upstream).toBe('http://10.0.0.5:8080');

		const workerState = await core.nodes.desiredState(worker.token);
		const workerRoute = workerState.routes.find((item) => item.projectId === remote.id)!;
		expect(workerRoute.function).toEqual({ assetsDirectory: 'public', runWorkerFirst: ['/api/*'] });
	});

	test('static and process behaviour is unchanged', async () => {
		const staticView = core.projects.list(principal).find((item) => item.slug === 'plain-static')!;
		expect(staticView.runtime).toBe('static');

		await project('process-app', 'process', edge.nodeId);
		const processProject = core.projects.requireRow(principal, 'process-app');
		core.workloads.setSpec(principal, processProject, {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			memoryMb: 256,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: true,
			env: {},
			secrets: [],
		});
		const deployment = await core.uploads.deployInline(principal, processProject, [file('index.js', 'x')], {
			promote: true,
		});
		expect(deployment.runtime).toBe('process');
		const desired = core.workloads.desiredForNode(edge.nodeId).find((item) => item.projectId === processProject.id)!;
		expect(desired.runtime).toBe('process');
		expect(desired.function).toBeUndefined();
		expect(desired.upstream).toBe(`unix//run/skiff-workloads/${processProject.id}.sock`);
		const route = (await core.nodes.desiredState(edge.token)).routes.find(
			(item) => item.projectId === processProject.id,
		)!;
		expect(route.function).toBeUndefined();
		expect(route.upstream).toBe(`unix//run/skiff-workloads/${processProject.id}.sock`);
	});

	test('a process or container app on a worker is proxied by the edge to the worker Caddy', async () => {
		// The edge has no copy of a worker app: its route points at the worker's WireGuard address,
		// and the worker's own route is what Caddy dials locally (the socket or loopback port).
		const processProject = await project('process-remote', 'process', worker.nodeId);
		const processRow = core.projects.requireRow(principal, 'process-remote');
		core.workloads.setSpec(principal, processRow, {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			memoryMb: 256,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: true,
			env: {},
			secrets: [],
		});
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'process-remote'), [file('index.js', 'x')], {
			promote: true,
		});

		const edgeProcess = (await core.nodes.desiredState(edge.token)).routes.find(
			(item) => item.projectId === processRow.id,
		)!;
		expect(edgeProcess.upstream).toBe('http://10.0.0.5:8080');
		const workerProcess = (await core.nodes.desiredState(worker.token)).routes.find(
			(item) => item.projectId === processRow.id,
		)!;
		expect(workerProcess.upstream).toBe(`unix//run/skiff-workloads/${processRow.id}.sock`);

		const containerProject = await project('container-remote', 'container', worker.nodeId);
		const containerRow = core.projects.requireRow(principal, 'container-remote');
		core.workloads.setSpec(principal, containerRow, {
			runtime: 'container',
			image: 'docker.io/library/nginx:1.27',
			memoryMb: 256,
			cpus: 1,
			port: 8080,
			healthPath: '/',
			env: {},
			secrets: [],
		});
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'container-remote'), [file('index.html', 'x')], {
			promote: true,
		});

		const edgeContainer = (await core.nodes.desiredState(edge.token)).routes.find(
			(item) => item.projectId === containerRow.id,
		)!;
		expect(edgeContainer.upstream).toBe('http://10.0.0.5:8080');
		const workerContainer = (await core.nodes.desiredState(worker.token)).routes.find(
			(item) => item.projectId === containerRow.id,
		)!;
		expect(workerContainer.upstream).toBe('127.0.0.1:8080');
	});

	test('a binding change restarts the host', async () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		const before = core.workloads.desiredForNode(edge.nodeId).find((item) => item.projectId === fn.id)!;
		core.workloads.setSpec(principal, fn, {
			...functionWorkload,
			function: { ...resolvedFunction, bindings: [{ name: 'GREETING', type: 'text', value: 'hello' }] },
		});
		const after = core.workloads.desiredForNode(edge.nodeId).find((item) => item.projectId === fn.id)!;
		expect(after.activationVersion).not.toBe(before.activationVersion);
	});

	test('a stateless function scales to three hosts, each with its own socket', async () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		const workloadId = core.workloads.view(fn)!.id;
		// Scaling a deployed function: the spec change adds copies without a new deployment.
		core.workloads.setSpec(principal, fn, { ...functionWorkload, replicas: 3 });

		const copies = core.workloads
			.desiredForNode(edge.nodeId)
			.filter((item) => item.projectId === fn.id)
			.sort((a, b) => (a.replica?.index ?? 0) - (b.replica?.index ?? 0));
		expect(copies.map((item) => item.id)).toEqual([workloadId, `${workloadId}-r1`, `${workloadId}-r2`]);
		expect(copies.map((item) => item.replica?.index)).toEqual([0, 1, 2]);
		expect(copies.map((item) => item.upstream)).toEqual([
			`unix//run/skiff-workloads/${workloadId}.sock`,
			`unix//run/skiff-workloads/${workloadId}-r1.sock`,
			`unix//run/skiff-workloads/${workloadId}-r2.sock`,
		]);
		// Every copy renders the same function; only its socket and replica index differ.
		expect(copies.every((item) => item.function?.main === 'index.js')).toBe(true);
		// Admission reserves one share per replica (no quota change; D90 already multiplies).
		expect(core.workloads.view(fn)?.memoryMb).toBe(128 * 3);

		// The route's replica list comes from the deployment's own snapshot (rollback restores it).
		// A deploy must therefore carry the configured `replicas`; `applyBundle` currently rewrites
		// the spec with `replicas: 1` (reported as the remaining integration change). Emulate the
		// snapshot a fixed deploy path writes before checking route shape.
		const deployment = opened.db.select().from(deployments).where(eq(deployments.projectId, fn.id)).get()!;
		opened.db
			.update(deployments)
			.set({ workloadJson: JSON.stringify(core.workloads.projectSpec(core.projects.requireRow(principal, 'fn-app'))!) })
			.where(eq(deployments.id, deployment.id))
			.run();

		const state = await core.nodes.desiredState(edge.token);
		const route = state.routes.find((item) => item.projectId === fn.id)!;
		expect(route.function?.upstreams).toEqual(copies.map((item) => item.upstream));
		// `upstream` stays the primary target (replica 0) for an older agent and for the edge.
		expect(route.upstream).toBe(`unix//run/skiff-workloads/${workloadId}.sock`);
	});

	test('a stateful function cannot scale: the spec is refused with the phase-4 message', () => {
		const fn = core.projects.requireRow(principal, 'fn-app');
		expect(() =>
			core.workloads.setSpec(principal, fn, {
				...functionWorkload,
				replicas: 2,
				function: {
					...resolvedFunction,
					bindings: [{ name: 'ROOM', type: 'durable_object', className: 'Room', uniqueKey: 'prj_room' }],
				},
			}),
		).toThrow(/Functions with stateful bindings \(durable_object, kv, cache, d1\) run one host/);
	});
});
