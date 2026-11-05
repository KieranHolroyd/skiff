import { describe, expect, test } from 'bun:test';
import {
	desiredStateSchema,
	type DatabaseConsoleActivation,
	type DesiredState,
	type WorkloadDesired
} from '@skiff/contracts';
import { DatabaseConsoleRunner } from './database-consoles.ts';

const DB_ID = 'db_0123456789abcdef0123456789abcdef';
const ACTIVATION = 'a'.repeat(64);

function databaseWorkload(): WorkloadDesired {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-03T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		workloads: [
			{
				id: DB_ID,
				projectId: DB_ID,
				projectSlug: 'orders',
				deploymentId: DB_ID,
				runtime: 'container',
				status: 'running',
				release: null,
				image: 'docker.io/library/postgres:17-alpine',
				upstream: '127.0.0.1:15432',
				memoryMb: 512,
				cpus: 0.5,
				port: 15432,
				healthPath: '/',
				socketActivation: false,
				activationVersion: ACTIVATION,
				env: {},
				secrets: [],
				dataSizeMb: null,
				database: { engine: 'postgres', version: '17' }
			}
		]
	}).workloads[0]!;
}

function state(
	tasks: DesiredState['databaseConsoles'],
	workloads = [databaseWorkload()]
): DesiredState {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-03T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		workloads,
		databaseConsoles: tasks
	});
}

function activation(overrides: Partial<DatabaseConsoleActivation> = {}): DatabaseConsoleActivation {
	return {
		databaseId: DB_ID,
		port: 17432,
		webRoot: '/databases/orders/studio/proxy',
		readOnly: true,
		authUser: 'skiff',
		authPassword: 'session-password-1234',
		tls: true,
		...overrides
	};
}

class FakeHelper {
	starts: Array<{
		workload: WorkloadDesired;
		activation: DatabaseConsoleActivation;
	}> = [];
	stops: string[] = [];
	failStart = false;

	async startConsole(
		workload: WorkloadDesired,
		activation: DatabaseConsoleActivation
	): Promise<void> {
		if (this.failStart) throw new Error('systemctl restart failed');
		this.starts.push({ workload, activation });
	}

	async stopConsole(id: string): Promise<void> {
		this.stops.push(id);
	}
}

function controlFetch(value: DatabaseConsoleActivation, status = 200) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		if (status !== 200) return new Response('nope', { status });
		return Response.json(value);
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function runner(
	helper: FakeHelper,
	fetchImpl: typeof fetch,
	options: { controlUrl?: string; nodeToken?: string } = {}
): DatabaseConsoleRunner {
	return new DatabaseConsoleRunner({
		controlUrl: options.controlUrl ?? 'https://control.test',
		nodeToken: options.nodeToken ?? 'node-token',
		helper,
		fetch: fetchImpl,
		// Readiness is a separate probe; tests do not need a real DBGate socket.
		probe: (async () => new Response('ok')) as unknown as typeof fetch
	});
}

const signal = new AbortController().signal;

describe('database console runner', () => {
	test('fetches the node activation, starts the sidecar and queues one result', async () => {
		const helper = new FakeHelper();
		const control = controlFetch(activation());
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 3 }]), signal);

		expect(control.calls).toHaveLength(1);
		expect(control.calls[0]!.url).toBe(`https://control.test/api/agent/database-consoles/${DB_ID}`);
		const headers = control.calls[0]!.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer node-token');
		expect(helper.starts).toHaveLength(1);
		expect(helper.starts[0]!.workload.id).toBe(DB_ID);
		expect(helper.starts[0]!.activation.authPassword).toBe('session-password-1234');
		expect(consoles.pendingResults()).toEqual([
			{ id: DB_ID, action: 'start', generation: 3, status: 'ok' }
		]);

		// A queued result is not executed again while it waits for a heartbeat.
		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 3 }]), signal);
		expect(helper.starts).toHaveLength(1);

		consoles.acknowledge(consoles.pendingResults());
		expect(consoles.pendingResults()).toEqual([]);
		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 3 }]), signal);
		expect(helper.starts).toHaveLength(1);
	});

	test('a new generation re-runs a start task', async () => {
		const helper = new FakeHelper();
		const control = controlFetch(activation());
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 1 }]), signal);
		consoles.acknowledge(consoles.pendingResults());
		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 2 }]), signal);

		expect(control.calls).toHaveLength(2);
		expect(helper.starts).toHaveLength(2);
		expect(consoles.pendingResults()[0]!.generation).toBe(2);
	});

	test('stops the sidecar without fetching an activation', async () => {
		const helper = new FakeHelper();
		const control = controlFetch(activation());
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'stop', generation: 4 }]), signal);

		expect(control.calls).toHaveLength(0);
		expect(helper.stops).toEqual([DB_ID]);
		expect(consoles.pendingResults()).toEqual([
			{ id: DB_ID, action: 'stop', generation: 4, status: 'ok' }
		]);
	});

	test('reports a helper failure instead of throwing', async () => {
		const helper = new FakeHelper();
		helper.failStart = true;
		const control = controlFetch(activation());
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 5 }]), signal);

		const [result] = consoles.pendingResults();
		expect(result).toMatchObject({
			id: DB_ID,
			action: 'start',
			generation: 5,
			status: 'failed'
		});
		expect(result!.error).toContain('systemctl restart failed');
	});

	test('reports a failed activation fetch and never leaks the URL body', async () => {
		const helper = new FakeHelper();
		const control = controlFetch(activation(), 503);
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 6 }]), signal);

		const [result] = consoles.pendingResults();
		expect(result!.status).toBe('failed');
		expect(result!.error).toContain('console activation -> 503');
		expect(helper.starts).toEqual([]);
	});

	test('refuses a start for a database that is not a workload on this node', async () => {
		const helper = new FakeHelper();
		const control = controlFetch(activation());
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 1 }], []), signal);

		expect(control.calls).toHaveLength(0);
		expect(consoles.pendingResults()[0]).toMatchObject({
			id: DB_ID,
			action: 'start',
			status: 'failed'
		});
		expect(consoles.pendingResults()[0]!.error).toContain('not a managed database');
	});

	test('rejects an activation for a different database', async () => {
		const helper = new FakeHelper();
		const control = controlFetch({ ...activation(), databaseId: 'db_other' });
		const consoles = runner(helper, control.impl);

		await consoles.runOnce(state([{ id: DB_ID, action: 'start', generation: 1 }]), signal);

		expect(helper.starts).toEqual([]);
		expect(consoles.pendingResults()[0]!.error).toContain('does not match');
	});
});
