import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { desiredStateSchema, type DatabasePitrTask, type DesiredState } from '@skiff/contracts';
import { DatabasePitrRunner } from './database-pitr.ts';
import type { HelperPitrStatus } from './helper-client.ts';

const SOURCE = 'db_source';
const TARGET = 'db_target';
const repo = {
	kind: 's3' as const,
	endpoint: 'https://s3.example.test',
	bucket: 'skiff-pitr',
	region: 'us-east-1',
	pathPrefix: 'skiff/pitr',
	forcePathStyle: true,
	accessKeyId: 'access-key',
	secretAccessKey: 'super-secret-key',
};

let control: ReturnType<typeof Bun.serve>;
const activations: string[] = [];
const tasks = new Map<string, DatabasePitrTask>();

beforeAll(() => {
	control = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.headers.get('authorization') !== 'Bearer node-token') return new Response('no', { status: 401 });
			const match = /^\/api\/agent\/database-pitr\/(.+)$/.exec(new URL(request.url).pathname);
			const task = match ? tasks.get(decodeURIComponent(match[1]!)) : undefined;
			if (!task) return new Response('missing', { status: 404 });
			activations.push(task.id);
			return Response.json({
				taskId: task.id,
				databaseId: task.databaseId,
				action: task.action,
				stanza: task.stanza,
				repo,
				archiveTimeoutSeconds: 60,
			});
		},
	});
});

afterAll(() => {
	control.stop(true);
});

function task(overrides: Partial<DatabasePitrTask>): DatabasePitrTask {
	const value: DatabasePitrTask = {
		id: `pitr_${tasks.size + 1}`,
		action: 'status',
		databaseId: SOURCE,
		databaseName: 'orders',
		engine: 'postgres',
		stanza: SOURCE,
		baseBackupType: null,
		targetDatabaseId: null,
		targetTime: null,
		...overrides,
	};
	tasks.set(value.id, value);
	return value;
}

function state(databasePitrTasks: DatabasePitrTask[]): DesiredState {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-07T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		workloads: [],
		databasePitrTasks,
	});
}

const status: HelperPitrStatus = {
	configured: true,
	stanza: SOURCE,
	repo: { bucket: 'skiff-pitr', region: 'us-east-1', endpoint: 's3.example.test', path: '/skiff/pitr/db_source' },
	archiveStatus: 'ok',
	recoverableFrom: 1_000,
	recoverableTo: 5_000,
	backupCount: 1,
	newestBackupAt: 1_000,
	newestBackupType: 'full',
	lastArchivedAt: 5_000,
	repoMessage: null,
};

function harness() {
	const calls: string[] = [];
	let clock = 0;
	const runner = new DatabasePitrRunner({
		controlUrl: `http://127.0.0.1:${control.port}`,
		nodeToken: 'node-token',
		settleMs: 30_000,
		now: () => clock,
		helper: {
			async pitrConfigure(id) {
				calls.push(`configure:${id}`);
				return { stanza: id, configPath: `/run/skiff-workloads/${id}/pgbackrest/pgbackrest.conf` };
			},
			async pitrBaseBackup(id, type) {
				calls.push(`backup:${id}:${type}`);
				return { stanza: id, type };
			},
			async pitrRestore(id, input) {
				calls.push(`restore:${id}:${input.targetDatabaseId}`);
				return { ...input, verified: true };
			},
			async pitrStatus(id) {
				calls.push(`status:${id}`);
				return status;
			},
		},
	});
	return { runner, calls, advance: (ms: number) => (clock += ms) };
}

const signal = new AbortController().signal;

describe('database PITR runner', () => {
	test('waits until the database has been ready for the settle period', async () => {
		const { runner, calls, advance } = harness();
		const check = task({ action: 'status' });
		let ready = false;
		await runner.runOnce(state([check]), () => ready, signal);
		expect(calls).toEqual([]);
		ready = true;
		await runner.runOnce(state([check]), () => ready, signal);
		expect(calls).toEqual([]);
		advance(30_000);
		await runner.runOnce(state([check]), () => ready, signal);
		// The status check rewrites the tmpfs config first, then reads the window.
		expect(calls).toEqual([`configure:${SOURCE}`, `status:${SOURCE}`]);
		expect(runner.pendingResults()).toEqual([
			expect.objectContaining({
				taskId: check.id,
				action: 'status',
				status: 'ok',
				archiveStatus: 'ok',
				window: {
					recoverableFrom: 1_000,
					recoverableTo: 5_000,
					backupCount: 1,
					newestBackupAt: 1_000,
					newestBackupType: 'full',
					lastArchivedAt: 5_000,
					repoMessage: null,
				},
			}),
		]);
	});

	test('a restart resets the settle clock', async () => {
		const { runner, calls, advance } = harness();
		const backup = task({ action: 'basebackup', baseBackupType: 'full' });
		let ready = true;
		await runner.runOnce(state([backup]), () => ready, signal);
		advance(20_000);
		ready = false;
		await runner.runOnce(state([backup]), () => ready, signal);
		ready = true;
		advance(20_000);
		await runner.runOnce(state([backup]), () => ready, signal);
		expect(calls).toEqual([]);
		advance(30_000);
		await runner.runOnce(state([backup]), () => ready, signal);
		expect(calls).toEqual([`configure:${SOURCE}`, `backup:${SOURCE}:full`]);
	});

	test('a restore needs both the source and the target ready', async () => {
		const { runner, calls, advance } = harness();
		const restore = task({ action: 'restore', targetDatabaseId: TARGET, targetTime: 4_000 });
		const ready = new Set([SOURCE]);
		await runner.runOnce(state([restore]), (id) => ready.has(id), signal);
		advance(60_000);
		await runner.runOnce(state([restore]), (id) => ready.has(id), signal);
		expect(calls).toEqual([]);
		ready.add(TARGET);
		await runner.runOnce(state([restore]), (id) => ready.has(id), signal);
		advance(30_000);
		await runner.runOnce(state([restore]), (id) => ready.has(id), signal);
		expect(calls).toEqual([`configure:${SOURCE}`, `restore:${SOURCE}:${TARGET}`]);
		expect(runner.pendingResults()).toEqual([
			expect.objectContaining({ taskId: restore.id, status: 'ok', targetDatabaseId: TARGET, verified: true }),
		]);
		expect(JSON.stringify(runner.pendingResults())).not.toContain(repo.secretAccessKey);
	});
});
