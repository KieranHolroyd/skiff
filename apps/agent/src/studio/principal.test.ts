import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { desiredStateSchema, type DatabaseStudioPrincipalTask, type DesiredState } from '@skiff/contracts';
import { StudioPrincipalRunner } from './principal.ts';

const PASSWORD = 'p'.repeat(32);
const NODE_TOKEN = 'node-token-123';

/** A fake control plane serving the node-authenticated activation. */
const requests: Array<{ path: string; auth: string | null }> = [];
let activationStatus = 200;
let activationGeneration: number | null = null;
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		requests.push({ path: url.pathname, auth: request.headers.get('authorization') });
		const match = /^\/api\/agent\/database-studio-principal\/(.+)$/.exec(url.pathname);
		if (!match) return new Response('not found', { status: 404 });
		if (activationStatus !== 200) return Response.json({ error: 'nope' }, { status: activationStatus });
		const databaseId = decodeURIComponent(match[1]!);
		return Response.json({
			databaseId,
			generation: activationGeneration ?? 1,
			engine: 'postgres',
			user: 'skiff_studio_ro',
			password: PASSWORD,
			database: 'shop_db',
		});
	},
});
afterAll(() => server.stop(true));

function state(tasks: DatabaseStudioPrincipalTask[]): DesiredState {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'node_1',
		agentVersion: '0.1.0',
		generatedAt: new Date(0).toISOString(),
		contentDomain: 'sites.test',
		releases: [],
		routes: [],
		databaseStudioPrincipals: tasks,
	});
}

function runner(helperFails: number, clock: { now: number }) {
	const calls: string[] = [];
	let failures = helperFails;
	const logs: string[] = [];
	const instance = new StudioPrincipalRunner({
		controlUrl: server.url.origin,
		nodeToken: NODE_TOKEN,
		helper: {
			async ensureStudioPrincipal(id, user, password) {
				calls.push(`${id}:${user}:${password}`);
				if (failures > 0) {
					failures -= 1;
					throw new Error('helper POST /v1/workloads/db_1/studio-principal -> 500: container not running');
				}
			},
		},
		log: (level, message) => logs.push(`${level}: ${message}`),
		now: () => clock.now,
		attempts: 3,
		retryDelayMs: 10_000,
	});
	return { instance, calls, logs };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
	requests.length = 0;
	activationStatus = 200;
	activationGeneration = null;
});

describe('StudioPrincipalRunner', () => {
	test('fetches the activation with the node token, calls the helper once and reports ok until acknowledged', async () => {
		const clock = { now: 0 };
		const { instance, calls, logs } = runner(0, clock);
		const desired = state([{ databaseId: 'db_1', generation: 1 }]);
		await instance.runOnce(desired, signal());
		expect(requests).toEqual([{ path: '/api/agent/database-studio-principal/db_1', auth: `Bearer ${NODE_TOKEN}` }]);
		expect(calls).toEqual([`db_1:skiff_studio_ro:${PASSWORD}`]);
		const results = instance.pendingResults();
		expect(results).toEqual([{ databaseId: 'db_1', generation: 1, status: 'ok' }]);
		// Not re-run while queued, nor after the heartbeat acknowledged it while the task is listed.
		await instance.runOnce(desired, signal());
		instance.acknowledge(results);
		expect(instance.pendingResults()).toEqual([]);
		await instance.runOnce(desired, signal());
		expect(calls).toHaveLength(1);
		// A new generation is new work.
		await instance.runOnce(state([{ databaseId: 'db_1', generation: 2 }]), signal());
		expect(calls).toHaveLength(2);
		expect(logs.join('\n')).not.toContain(PASSWORD);
	});

	test('retries a failure after a delay and reports it only after the last attempt', async () => {
		const clock = { now: 0 };
		const { instance, calls, logs } = runner(5, clock);
		const desired = state([{ databaseId: 'db_1', generation: 3 }]);
		await instance.runOnce(desired, signal());
		expect(instance.pendingResults()).toEqual([]);
		await instance.runOnce(desired, signal());
		expect(calls).toHaveLength(1); // still backing off
		clock.now += 10_000;
		await instance.runOnce(desired, signal());
		clock.now += 10_000;
		await instance.runOnce(desired, signal());
		expect(calls).toHaveLength(3);
		expect(instance.pendingResults()).toEqual([
			{
				databaseId: 'db_1',
				generation: 3,
				status: 'failed',
				error: 'helper POST /v1/workloads/db_1/studio-principal -> 500: container not running',
			},
		]);
		expect(logs.filter((line) => line.startsWith('warn'))).toHaveLength(2);
		expect(logs.join('\n')).not.toContain(PASSWORD);
	});

	test('a transient failure that then succeeds reports ok', async () => {
		const clock = { now: 0 };
		const { instance } = runner(1, clock);
		const desired = state([{ databaseId: 'db_1', generation: 1 }]);
		await instance.runOnce(desired, signal());
		clock.now += 10_000;
		await instance.runOnce(desired, signal());
		expect(instance.pendingResults()).toEqual([{ databaseId: 'db_1', generation: 1, status: 'ok' }]);
	});

	test('a refused activation (wrong node) never reaches the helper', async () => {
		activationStatus = 403;
		const clock = { now: 0 };
		const { instance, calls } = runner(0, clock);
		const runner1 = new StudioPrincipalRunner({
			controlUrl: server.url.origin,
			nodeToken: NODE_TOKEN,
			helper: { ensureStudioPrincipal: async () => void calls.push('called') },
			now: () => clock.now,
			attempts: 1,
		});
		await runner1.runOnce(state([{ databaseId: 'db_9', generation: 1 }]), signal());
		expect(calls).toEqual([]);
		expect(runner1.pendingResults()[0]).toMatchObject({ databaseId: 'db_9', generation: 1, status: 'failed' });
		expect(runner1.pendingResults()[0]?.error).toMatch(/activation -> 403/);
		expect(instance.pendingResults()).toEqual([]);
	});

	test('reports the newer generation when the control plane moved on', async () => {
		activationGeneration = 4;
		const clock = { now: 0 };
		const { instance } = runner(0, clock);
		await instance.runOnce(state([{ databaseId: 'db_1', generation: 3 }]), signal());
		expect(instance.pendingResults()).toEqual([{ databaseId: 'db_1', generation: 4, status: 'ok' }]);
	});
});
