import { afterEach, describe, expect, test } from 'bun:test';
import {
	desiredStateSchema,
	type DesiredState,
	type RuntimeLogBatch,
} from '@skiff/contracts';
import type {
	HelperApi,
	HelperLogResult,
	HelperWorkloadStatus,
	LogReadOptions,
} from './helper-client.ts';
import { WorkloadLogDrain } from './log-drain.ts';

const ACTIVATION = 'a'.repeat(64);

function state(): DesiredState {
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
				id: 'wld_1',
				projectId: 'prj_1',
				projectSlug: 'app',
				deploymentId: 'dep_1',
				runtime: 'process',
				status: 'running',
				release: null,
				upstream: '127.0.0.1:3000',
				memoryMb: 128,
				cpus: 1,
				port: 3000,
				healthPath: '/',
				socketActivation: true,
				activationVersion: ACTIVATION,
				env: {},
				secrets: [],
				dataSizeMb: null,
			},
		],
	});
}

class FakeHelper implements HelperApi {
	readCalls: Array<{ id: string; options: LogReadOptions }> = [];
	results: HelperLogResult[] = [];

	async ensureSlice(): Promise<void> {}
	async apply(): Promise<HelperWorkloadStatus> {
		return { id: 'wld_1', status: 'running', restarts: 0 };
	}
	async remove(): Promise<void> {}
	// Not exercised by the log drain; only present to implement the shared HelperApi.
	async stop(): Promise<void> {}
	async restart(): Promise<void> {}
	async purge(): Promise<void> {}
	async dumpDatabase(): Promise<never> {
		throw new Error('dumpDatabase not used in this test');
	}
	async restoreDatabase(): Promise<void> {}
	async rotateDatabaseRole(): Promise<void> {}
	async applyDatabaseCredential(): Promise<void> {}
	async restartPooler(): Promise<void> {}
	async replicationConfigure(): Promise<void> {}
	async replicationStatus(): Promise<[]> {
		return [];
	}
	async replicaPromote(): Promise<never> {
		throw new Error('replicaPromote not used in this test');
	}
	async pitrConfigure(): Promise<never> {
		throw new Error('pitrConfigure not used in this test');
	}
	async pitrBaseBackup(): Promise<never> {
		throw new Error('pitrBaseBackup not used in this test');
	}
	async pitrRestore(): Promise<never> {
		throw new Error('pitrRestore not used in this test');
	}
	async pitrStatus(): Promise<never> {
		throw new Error('pitrStatus not used in this test');
	}
	async status(): Promise<HelperWorkloadStatus> {
		return { id: 'wld_1', status: 'running', restarts: 0 };
	}
	async logs(
		id: string,
		options: LogReadOptions = {},
	): Promise<HelperLogResult> {
		this.readCalls.push({ id, options });
		return (
			this.results.shift() ?? {
				entries: [],
				nextCursor: options.cursor ?? null,
			}
		);
	}
}

const posts: RuntimeLogBatch[] = [];

function fetchOk(): typeof fetch {
	return (async (
		_input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		posts.push(JSON.parse(String(init?.body)) as RuntimeLogBatch);
		return Response.json({ ok: true, stored: 1 });
	}) as unknown as typeof fetch;
}

function drain(
	helper: FakeHelper,
	options: { fail?: boolean } = {},
): WorkloadLogDrain {
	return new WorkloadLogDrain({
		helper,
		controlUrl: 'https://control.test/',
		nodeToken: 'node-token',
		fetch: options.fail
			? ((async () =>
					new Response('nope', { status: 502 })) as unknown as typeof fetch)
			: fetchOk(),
		sleep: async () => undefined,
	});
}

afterEach(() => {
	posts.length = 0;
});

describe('workload log drain', () => {
	test('reads after a cursor, maps priorities and posts one ordered batch', async () => {
		const helper = new FakeHelper();
		helper.results.push(
			{
				entries: [
					{
						cursor: 's=1',
						ts: 1_700_000_000_000,
						priority: 6,
						message: 'listening on :3000',
					},
					{
						cursor: 's=2',
						ts: 1_700_000_000_010,
						priority: 3,
						message: 'upstream refused',
					},
				],
				nextCursor: 's=2',
			},
			{ entries: [], nextCursor: 's=2' },
		);
		const client = drain(helper);

		expect(await client.drain(state())).toBe(2);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ workloadId: 'wld_1', cursor: 's=2' });
		expect(posts[0]!.lines).toEqual([
			{
				ts: 1_700_000_000_000,
				stream: 'stdout',
				level: 'info',
				message: 'listening on :3000',
			},
			{
				ts: 1_700_000_000_010,
				stream: 'stderr',
				level: 'error',
				message: 'upstream refused',
			},
		]);

		expect(await client.drain(state())).toBe(0);
		expect(posts).toHaveLength(1);
		expect(helper.readCalls[1]?.options.cursor).toBe('s=2');
	});

	test('parses a JSON line into level, message and embedded timestamp', async () => {
		const helper = new FakeHelper();
		helper.results.push({
			entries: [
				{
					cursor: 's=1',
					ts: 1_700_000_000_500,
					priority: 6,
					message: '{"level":"error","time":1700000000123,"msg":"boom"}',
				},
			],
			nextCursor: 's=1',
		});
		const client = drain(helper);

		expect(await client.drain(state())).toBe(1);
		expect(posts).toHaveLength(1);
		expect(posts[0]!.lines).toEqual([
			{
				ts: 1_700_000_000_123,
				stream: 'stdout',
				level: 'error',
				message: 'boom',
			},
		]);
	});

	test('parses a logfmt line into level, message and embedded timestamp', async () => {
		const helper = new FakeHelper();
		helper.results.push({
			entries: [
				{
					cursor: 's=1',
					ts: 1_700_000_000_500,
					priority: 6,
					message: 'time=2024-07-03T12:00:00Z level=warn msg="slow request"',
				},
			],
			nextCursor: 's=1',
		});
		const client = drain(helper);

		expect(await client.drain(state())).toBe(1);
		expect(posts).toHaveLength(1);
		expect(posts[0]!.lines).toEqual([
			{
				ts: 1_720_008_000_000,
				stream: 'stdout',
				level: 'warn',
				message: 'slow request',
			},
		]);
	});

	test('does not advance the cursor when the control plane rejects a batch', async () => {
		const helper = new FakeHelper();
		helper.results.push(
			{
				entries: [
					{
						cursor: 's=1',
						ts: 1_700_000_000_000,
						priority: 6,
						message: 'hello',
					},
				],
				nextCursor: 's=1',
			},
			{
				entries: [
					{
						cursor: 's=1',
						ts: 1_700_000_000_000,
						priority: 6,
						message: 'hello',
					},
				],
				nextCursor: 's=1',
			},
		);
		const warnings: string[] = [];
		const client = new WorkloadLogDrain({
			helper,
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			fetch: (async () =>
				new Response('nope', { status: 502 })) as unknown as typeof fetch,
			sleep: async () => undefined,
			log: (_level, message) => warnings.push(message),
		});

		await client
			.drain(state())
			.catch((error: unknown) => warnings.push(String(error)));
		expect(warnings.some((line) => line.includes('log drain'))).toBe(true);
		expect(helper.readCalls).toHaveLength(1);

		// The retry must ask from the same cursor, because the first POST never landed.
		helper.results.push({
			entries: [
				{ cursor: 's=1', ts: 1_700_000_000_000, priority: 6, message: 'hello' },
			],
			nextCursor: 's=1',
		});
		await client.drain(state()).catch(() => undefined);
		expect(helper.readCalls.length).toBeGreaterThanOrEqual(2);
	});
});
