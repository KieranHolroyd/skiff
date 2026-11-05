import { describe, expect, test, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	desiredStateSchema,
	heartbeatSchema,
	type DesiredState,
	type ReleaseSpec,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@skiff/contracts';
import type { HelperApi, HelperLogResult, HelperWorkloadStatus } from './helper-client.ts';
import {
	probeDatabasePort,
	probeWorkloadHealth,
	WorkloadRuntime,
	workloadFingerprint,
	workloadHeartbeat,
} from './runtime.ts';

const SHA = 'a'.repeat(64);
const ACTIVATION = 'b'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function workload(id: string, overrides: Record<string, unknown> = {}): WorkloadDesired {
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
				id,
				projectId: `prj_${id}`,
				projectSlug: id,
				deploymentId: `dep_${id}`,
				runtime: 'process',
				status: 'running',
				release: SHA,
				upstream: `unix//run/skiff-workloads/prj_${id}.sock`,
				memoryMb: 256,
				cpus: 1,
				port: 3000,
				healthPath: '/health',
				socketActivation: true,
				activationVersion: ACTIVATION,
				env: { NODE_ENV: 'production' },
				secrets: [],
				dataSizeMb: null,
				...overrides,
			},
		],
	}).workloads[0]!;
}

function state(workloads: WorkloadDesired[], version = 1, releases: ReleaseSpec[] = [release()]): DesiredState {
	return desiredStateSchema.parse({
		version,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-03T00:00:00.000Z',
		contentDomain: 'example.com',
		releases,
		routes: [],
		workloads,
	});
}

function release(sha256 = SHA): ReleaseSpec {
	return { sha256, url: 'https://r2.example.com/a.zip', sizeBytes: 1, fileCount: 1, precompressed: false };
}

class FakeHelper implements HelperApi {
	applied = new Map<string, { workload: WorkloadDesired; activation: WorkloadActivation }>();
	removed: string[] = [];
	purged: string[] = [];
	failPurge = new Set<string>();
	sliceCalls: number[] = [];
	statusCalls: string[] = [];
	failApply = new Set<string>();
	failSlice = false;
	statuses = new Map<string, HelperWorkloadStatus>();
	applyCalls: string[] = [];

	async ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void> {
		if (this.failSlice) throw new Error('ENOENT: helper socket missing');
		this.sliceCalls.push(options.memoryMb);
	}

	async apply(input: {
		workload: WorkloadDesired;
		activation: WorkloadActivation;
	}): Promise<HelperWorkloadStatus> {
		if (this.failApply.has(input.workload.id)) throw new Error('systemctl restart failed');
		this.applyCalls.push(input.workload.id);
		this.applied.set(input.workload.id, input);
		return { id: input.workload.id, status: 'running', restarts: 0 };
	}

	async remove(id: string): Promise<void> {
		this.removed.push(id);
		this.applied.delete(id);
	}

	async purge(id: string): Promise<void> {
		if (this.failPurge.has(id)) throw new Error('rm: device busy');
		this.purged.push(id);
		this.applied.delete(id);
	}

	async dumpDatabase(): Promise<never> {
		throw new Error('dumpDatabase not used in this test');
	}

	async restoreDatabase(): Promise<void> {}
	async rotateDatabaseRole(): Promise<void> {}
	async restartPooler(): Promise<void> {}
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

	async status(id: string): Promise<HelperWorkloadStatus> {
		this.statusCalls.push(id);
		return this.statuses.get(id) ?? { id, status: 'running', restarts: 0 };
	}

	async logs(_id: string, _options: { cursor?: string; lines?: number } = {}): Promise<HelperLogResult> {
		return { entries: [], nextCursor: null };
	}
}

class FakeReleases {
	cached = new Set<string>();
	downloads: string[] = [];

	async hasRelease(sha256: string): Promise<boolean> {
		return this.cached.has(sha256);
	}

	async ensureRelease(spec: ReleaseSpec): Promise<boolean> {
		this.downloads.push(spec.sha256);
		if (this.cached.has(spec.sha256)) return false;
		this.cached.add(spec.sha256);
		return true;
	}
}

interface Fixture {
	runtime: WorkloadRuntime;
	helper: FakeHelper;
	releases: FakeReleases;
	activations: Map<string, WorkloadActivation>;
	activationCalls: string[];
	errors: string[];
}

function fixture(options: { healthy?: boolean } = {}): Fixture {
	const helper = new FakeHelper();
	const releases = new FakeReleases();
	const activations = new Map<string, WorkloadActivation>();
	const activationCalls: string[] = [];
	const errors: string[] = [];
	const runtime = new WorkloadRuntime({
		helper,
		releases,
		fetchActivation: async (id) => {
			activationCalls.push(id);
			const activation = activations.get(id);
			if (!activation) throw new Error(`no activation for ${id}`);
			return activation;
		},
		sliceMemoryMb: 1024,
		healthTimeoutMs: 5,
		probeHealth: async () => options.healthy ?? true,
		sleep: async () => undefined,
		log: (level, message) => {
			if (level === 'error') errors.push(message);
		},
	});
	return { runtime, helper, releases, activations, activationCalls, errors };
}

function activationFor(workloadId: string, version = ACTIVATION): WorkloadActivation {
	return {
		workloadId,
		activationVersion: version,
		env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://secret' },
		files: {},
	};
}

describe('WorkloadRuntime.converge', () => {
	test('applies the slice, ensures releases and starts workloads', async () => {
		const f = fixture();
		const desired = workload('app');
		f.activations.set('app', activationFor('app'));

		await f.runtime.converge(state([desired]));

		expect(f.helper.sliceCalls).toEqual([1024]);
		expect(f.releases.downloads).toEqual([SHA]);
		expect(f.helper.applyCalls).toEqual(['app']);
		expect(f.activationCalls).toEqual(['app']);
		expect(f.helper.applied.get('app')?.activation.env.DATABASE_URL).toBe('postgres://secret');
		expect(f.runtime.currentReports()).toEqual([{ id: 'app', status: 'running', restarts: 0 }]);
		expect(f.runtime.needsRetry()).toBe(false);
	});

	test('does not re-apply or re-fetch secrets when nothing changed', async () => {
		const f = fixture();
		const desired = workload('app');
		f.activations.set('app', activationFor('app'));

		await f.runtime.converge(state([desired]));
		await f.runtime.converge(state([desired], 2));

		expect(f.helper.applyCalls).toEqual(['app']);
		expect(f.activationCalls).toEqual(['app']);
		expect(f.helper.statusCalls).toEqual(['app']);
		expect(f.helper.sliceCalls).toEqual([1024, 1024]);
	});

	test('re-applies when activation or resources change', async () => {
		const f = fixture();
		const first = workload('app');
		f.activations.set('app', activationFor('app'));
		await f.runtime.converge(state([first]));

		const newVersion = 'c'.repeat(64);
		f.activations.set('app', activationFor('app', newVersion));
		await f.runtime.converge(state([workload('app', { activationVersion: newVersion })], 2));
		expect(f.helper.applyCalls).toEqual(['app', 'app']);
		expect(f.activationCalls).toEqual(['app', 'app']);

		// Memory is not part of the contract's activation hash, so the runtime's own diff must
		// catch it.
		await f.runtime.converge(state([workload('app', { activationVersion: newVersion, memoryMb: 512 })], 3));
		expect(f.helper.applyCalls).toEqual(['app', 'app', 'app']);
		expect(workloadFingerprint(workload('app', { memoryMb: 512 }))).not.toBe(
			workloadFingerprint(workload('app')),
		);
	});

	test('removes workloads that leave the node and is a no-op for an empty state', async () => {
		const f = fixture();
		f.activations.set('app', activationFor('app'));
		await f.runtime.converge(state([workload('app')]));
		expect(f.helper.applied.has('app')).toBe(true);

		await f.runtime.converge(state([], 2));
		expect(f.helper.removed).toEqual(['app']);
		expect(f.helper.applied.has('app')).toBe(false);
		expect(f.runtime.currentReports()).toEqual([]);
		// The slice is only applied when there is something to run.
		expect(f.helper.sliceCalls).toEqual([1024]);
	});

	test('one bad workload does not stop the others or throw', async () => {
		const f = fixture();
		f.activations.set('good', activationFor('good'));
		f.activations.set('bad', activationFor('bad'));
		f.helper.failApply.add('bad');

		await expect(
			f.runtime.converge(state([workload('good'), workload('bad')])),
		).resolves.toBeUndefined();

		expect(f.helper.applyCalls).toEqual(['good']);
		expect(f.runtime.currentReports()).toEqual([
			{ id: 'bad', status: 'failed', restarts: 0 },
			{ id: 'good', status: 'running', restarts: 0 },
		]);
		expect(f.errors.join('\n')).toContain('Workload bad (bad) failed');
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(true);
	});

	test('a missing helper reports every workload failed but keeps the converge alive', async () => {
		const f = fixture();
		f.helper.failSlice = true;
		f.activations.set('app', activationFor('app'));

		await f.runtime.converge(state([workload('app')]));

		expect(f.helper.applyCalls).toEqual([]);
		expect(f.activationCalls).toEqual([]);
		expect(f.runtime.currentReports()).toEqual([{ id: 'app', status: 'failed', restarts: 0 }]);
		expect(f.errors.join('\n')).toContain('Workload slice unavailable');
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(true);
	});

	test('a failed activation fetch is reported and does not abort the next workload', async () => {
		const f = fixture();
		f.activations.set('second', activationFor('second'));

		await f.runtime.converge(state([workload('first'), workload('second')]));

		expect(f.helper.applyCalls).toEqual(['second']);
		expect(f.runtime.currentReports()).toEqual([
			{ id: 'first', status: 'failed', restarts: 0 },
			{ id: 'second', status: 'running', restarts: 0 },
		]);
	});

	test('reports starting when the health path never answers', async () => {
		const f = fixture({ healthy: false });
		f.activations.set('app', activationFor('app'));

		await f.runtime.converge(state([workload('app')]));

		expect(f.runtime.currentReports()).toEqual([{ id: 'app', status: 'starting', restarts: 0 }]);
		expect(f.errors).toEqual([]);
	});

	test('reports actual systemd state when an unchanged unit keeps failing', async () => {
		const f = fixture({ healthy: false });
		f.activations.set('app', activationFor('app'));
		await f.runtime.converge(state([workload('app')]));

		f.helper.statuses.set('app', { id: 'app', status: 'failed', restarts: 4 });
		f.helper.failApply.add('app');
		await f.runtime.converge(state([workload('app')], 2));

		expect(f.runtime.currentReports()).toEqual([{ id: 'app', status: 'failed', restarts: 4 }]);
		// A failed unit is retried even though the desired spec is unchanged.
		expect(f.helper.applyCalls).toEqual(['app']);
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(true);
	});

	test('a heartbeat sees a stopped unit and schedules a retry', async () => {
		const f = fixture();
		f.activations.set('app', activationFor('app'));
		await f.runtime.converge(state([workload('app')]));

		f.helper.statuses.set('app', { id: 'app', status: 'stopped', restarts: 0 });
		expect(await f.runtime.refreshReports()).toEqual([
			{ id: 'app', status: 'stopped', restarts: 0 },
		]);
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(true);
	});

	test('persists only the diff cache, so removals survive an agent restart', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-runtime-'));
		directories.push(dir);
		const statePath = join(dir, 'workloads-state.json');

		const helper = new FakeHelper();
		const activations = new Map<string, WorkloadActivation>([['app', activationFor('app')]]);
		const makeRuntime = () =>
			new WorkloadRuntime({
				helper,
				releases: new FakeReleases(),
				fetchActivation: async (id) => activations.get(id)!,
				sliceMemoryMb: 1024,
				healthTimeoutMs: 5,
				probeHealth: async () => true,
				sleep: async () => undefined,
				statePath,
			});
		const first = makeRuntime();
		await first.converge(state([workload('app')]));
		const persisted = await fs.readFile(statePath, 'utf8');
		expect(persisted).not.toContain('postgres://secret');
		expect(persisted).toContain('"id":"app"');

		const second = makeRuntime();
		await second.converge(state([workload('app')], 2));
		// The second process knows the workload is unchanged and only reconciles status.
		expect(helper.applyCalls).toEqual(['app']);

		await second.converge(state([], 3));
		expect(helper.removed).toEqual(['app']);
	});
});

describe('workload heartbeat payload', () => {
	test('serializes reports into the heartbeat schema', () => {
		const reports = [
			{ id: 'app', status: 'running' as const, restarts: 1, memoryBytes: 1024 },
			{ id: 'idle', status: 'failed' as const, restarts: 7 },
		];
		const payload = workloadHeartbeat(reports);
		expect(payload).toEqual([
			{ id: 'app', status: 'running', restarts: 1, memoryBytes: 1024 },
			{ id: 'idle', status: 'failed', restarts: 7 },
		]);

		const parsed = heartbeatSchema.parse({
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			actualStateVersion: 3,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: payload,
		});
		expect(parsed.workloads).toEqual(payload);
	});

	test('leaves workloads undefined for an empty node', () => {
		const reports = workloadHeartbeat([]);
		expect(reports).toEqual([]);
		const body = {
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online' as const,
			caddyOk: true,
			releases: [],
			...(reports.length > 0 ? { workloads: reports } : {}),
		};
		expect(heartbeatSchema.parse(body).workloads).toBeUndefined();
	});
});

const DB_ID = 'db_0123456789abcdef0123456789abcdef';
const OWNER_PASSWORD = 'owner-secret-1';
const MONITOR_PASSWORD = 'monitor-secret-2';

function databaseWorkload(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return workload(DB_ID, {
		projectId: DB_ID,
		projectSlug: 'orders',
		deploymentId: DB_ID,
		runtime: 'container',
		release: null,
		image: 'docker.io/library/postgres:17-alpine',
		upstream: '127.0.0.1:15432',
		port: 15432,
		healthPath: '/',
		socketActivation: false,
		env: { POSTGRES_USER: 'orders', POSTGRES_DB: 'orders', PGDATA: '/data/pgdata' },
		database: { engine: 'postgres', version: '17' },
		...overrides,
	});
}

function databaseActivation(version = ACTIVATION): WorkloadActivation {
	return {
		workloadId: DB_ID,
		activationVersion: version,
		env: { POSTGRES_PASSWORD: OWNER_PASSWORD },
		files: {},
		monitor: {
			databaseName: 'orders',
			ownerUser: 'orders',
			ownerPassword: OWNER_PASSWORD,
			monitorUser: 'skiff_monitor',
			monitorPassword: MONITOR_PASSWORD,
			port: 15432,
		},
	};
}

function purgeState(workloads: WorkloadDesired[], databasePurges: string[], version = 1): DesiredState {
	return desiredStateSchema.parse({ ...state(workloads, version, []), databasePurges });
}

describe('managed databases', () => {
	test('forwards the database profile and keeps monitor credentials away from the helper', async () => {
		const f = fixture();
		f.activations.set(DB_ID, databaseActivation());
		await f.runtime.converge(state([databaseWorkload()], 1, []));

		const applied = f.helper.applied.get(DB_ID);
		expect(applied?.workload.database).toEqual({ engine: 'postgres', version: '17' });
		expect(applied?.workload.image).toBe('docker.io/library/postgres:17-alpine');
		expect(applied?.activation.env.POSTGRES_PASSWORD).toBe(OWNER_PASSWORD);
		expect('monitor' in (applied?.activation ?? {})).toBe(false);
		expect(JSON.stringify(applied)).not.toContain(MONITOR_PASSWORD);

		const [target] = f.runtime.databaseTargets();
		expect(target).toMatchObject({
			id: DB_ID,
			port: 15432,
			status: 'running',
			activationVersion: ACTIVATION,
			monitor: { monitorUser: 'skiff_monitor', monitorPassword: MONITOR_PASSWORD, ownerPassword: OWNER_PASSWORD },
		});

		f.runtime.forgetOwnerPassword(DB_ID, 'c'.repeat(64));
		expect(f.runtime.databaseTargets()[0]?.monitor.ownerPassword).toBe(OWNER_PASSWORD);
		f.runtime.forgetOwnerPassword(DB_ID, ACTIVATION);
		expect(f.runtime.databaseTargets()[0]?.monitor.ownerPassword).toBeNull();
		// Targets are copies: a caller cannot resurrect the password in the runtime.
		f.runtime.databaseTargets()[0]!.monitor.ownerPassword = 'x';
		expect(f.runtime.databaseTargets()[0]?.monitor.ownerPassword).toBeNull();
	});

	test('app workloads expose no database targets', async () => {
		const f = fixture();
		f.activations.set('app', activationFor('app'));
		await f.runtime.converge(state([workload('app')]));
		expect(f.runtime.databaseTargets()).toEqual([]);
	});

	test('credentials never reach the diff cache, and a restart re-fetches them without re-applying', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-runtime-db-'));
		directories.push(dir);
		const statePath = join(dir, 'workloads-state.json');
		const helper = new FakeHelper();
		const fetches: string[] = [];
		const makeRuntime = () =>
			new WorkloadRuntime({
				helper,
				releases: new FakeReleases(),
				fetchActivation: async (id) => {
					fetches.push(id);
					return databaseActivation();
				},
				sliceMemoryMb: 1024,
				healthTimeoutMs: 5,
				probeHealth: async () => true,
				sleep: async () => undefined,
				statePath,
			});

		await makeRuntime().converge(state([databaseWorkload()], 1, []));
		const persisted = await fs.readFile(statePath, 'utf8');
		expect(persisted).not.toContain(OWNER_PASSWORD);
		expect(persisted).not.toContain(MONITOR_PASSWORD);
		expect(persisted).toContain(DB_ID);

		const restarted = makeRuntime();
		await restarted.converge(state([databaseWorkload()], 2, []));
		expect(helper.applyCalls).toEqual([DB_ID]);
		expect(fetches).toEqual([DB_ID, DB_ID]);
		expect(restarted.databaseTargets()[0]?.monitor.monitorPassword).toBe(MONITOR_PASSWORD);

		// Already held: no third fetch.
		await restarted.converge(state([databaseWorkload()], 3, []));
		expect(fetches).toHaveLength(2);
		expect(await fs.readFile(statePath, 'utf8')).not.toContain(MONITOR_PASSWORD);
	});

	test('removing a database drops its credentials but never purges it', async () => {
		const f = fixture();
		f.activations.set(DB_ID, databaseActivation());
		await f.runtime.converge(state([databaseWorkload()], 1, []));
		await f.runtime.converge(state([], 2, []));
		expect(f.helper.removed).toEqual([DB_ID]);
		expect(f.helper.purged).toEqual([]);
		expect(f.runtime.databaseTargets()).toEqual([]);
	});

	test('purges listed databases once and reports them until a heartbeat is acknowledged', async () => {
		const f = fixture();
		f.activations.set(DB_ID, databaseActivation());
		await f.runtime.converge(state([databaseWorkload()], 1, []));

		// Soft delete: the workload leaves, then the purge arrives.
		await f.runtime.converge(purgeState([], [DB_ID, DB_ID], 2));
		expect(f.helper.removed).toEqual([DB_ID]);
		expect(f.helper.purged).toEqual([DB_ID]);
		expect(f.runtime.pendingPurgedDatabases()).toEqual([DB_ID]);
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(false);

		// Same desired state again (no heartbeat yet): not purged twice, still pending.
		await f.runtime.converge(purgeState([], [DB_ID], 3));
		expect(f.helper.purged).toEqual([DB_ID]);
		expect(f.runtime.pendingPurgedDatabases()).toEqual([DB_ID]);

		// A heartbeat that carried other ids does not clear this one.
		f.runtime.acknowledgePurgedDatabases(['db_other']);
		expect(f.runtime.pendingPurgedDatabases()).toEqual([DB_ID]);

		const heartbeat = heartbeatSchema.parse({
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			actualStateVersion: 3,
			status: 'online',
			caddyOk: true,
			releases: [],
			purgedDatabases: f.runtime.pendingPurgedDatabases(),
		});
		expect(heartbeat.purgedDatabases).toEqual([DB_ID]);
		f.runtime.acknowledgePurgedDatabases(heartbeat.purgedDatabases ?? []);
		expect(f.runtime.pendingPurgedDatabases()).toEqual([]);

		// The control plane drops the entry once it has processed the report.
		await f.runtime.converge(purgeState([], [], 4));
		expect(f.helper.purged).toEqual([DB_ID]);
	});

	test('never purges an id that is still desired, even when stopped', async () => {
		const f = fixture();
		f.activations.set(DB_ID, databaseActivation());
		const warnings: string[] = [];
		const runtime = new WorkloadRuntime({
			helper: f.helper,
			releases: f.releases,
			fetchActivation: async () => databaseActivation(),
			sliceMemoryMb: 1024,
			healthTimeoutMs: 5,
			probeHealth: async () => true,
			sleep: async () => undefined,
			log: (level, message) => {
				if (level === 'warn') warnings.push(message);
			},
		});
		await runtime.converge(purgeState([databaseWorkload()], [DB_ID]));
		await runtime.converge(purgeState([databaseWorkload({ status: 'stopped' })], [DB_ID], 2));
		expect(f.helper.purged).toEqual([]);
		expect(runtime.pendingPurgedDatabases()).toEqual([]);
		expect(warnings.join('\n')).toContain('still a desired workload');
	});

	test('a failed purge is retried and not reported', async () => {
		const f = fixture();
		f.helper.failPurge.add(DB_ID);
		await f.runtime.converge(purgeState([], [DB_ID]));
		expect(f.runtime.pendingPurgedDatabases()).toEqual([]);
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(true);
		expect(f.errors.join('\n')).toContain(`Could not purge database ${DB_ID}`);

		f.helper.failPurge.clear();
		await f.runtime.converge(purgeState([], [DB_ID], 2));
		expect(f.helper.purged).toEqual([DB_ID]);
		expect(f.runtime.pendingPurgedDatabases()).toEqual([DB_ID]);
		expect(f.runtime.needsRetry(Date.now() + 120_000)).toBe(false);
	});

	test('the fingerprint covers the database profile without changing app fingerprints', () => {
		const pg17 = workloadFingerprint(databaseWorkload());
		const pg16 = workloadFingerprint(
			databaseWorkload({ image: 'docker.io/library/postgres:16-alpine', database: { engine: 'postgres', version: '16' } }),
		);
		expect(pg17).not.toBe(pg16);
		expect(pg17).toContain('"database"');
		// No `database` key for apps, so upgrading the agent restarts nothing.
		expect(workloadFingerprint(workload('app'))).not.toContain('database');
	});
});

describe('database health probe', () => {
	const listeners: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
	afterEach(() => {
		for (const listener of listeners.splice(0)) listener.stop(true);
	});

	function listen(reply: Uint8Array | null): { port: number; received: Uint8Array[] } {
		const received: Uint8Array[] = [];
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket, data) {
					received.push(new Uint8Array(data));
					if (reply) socket.write(reply);
				},
			},
		});
		listeners.push(listener);
		return { port: listener.port, received };
	}

	async function closedPort(): Promise<number> {
		const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
		const port = listener.port;
		listener.stop(true);
		return port;
	}

	test('a Postgres SSLRequest answer means healthy; no HTTP is spoken', async () => {
		const server = listen(new TextEncoder().encode('N'));
		const signal = new AbortController().signal;
		expect(await probeWorkloadHealth(databaseWorkload({ port: server.port }), '/run/x', signal)).toBe(true);
		expect([...server.received[0]!]).toEqual([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
		expect(new TextDecoder().decode(server.received[0]!)).not.toContain('HTTP');
	});

	test('a port that accepts but never answers, or answers garbage, is not healthy', async () => {
		const silent = listen(null);
		const signal = new AbortController().signal;
		expect(await probeDatabasePort(silent.port, signal, { timeoutMs: 100 })).toBe(false);
		const http = listen(new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n'));
		expect(await probeDatabasePort(http.port, signal, { timeoutMs: 500 })).toBe(false);
	});

	test('a closed port is not healthy, and a plain TCP probe only needs a connect', async () => {
		const signal = new AbortController().signal;
		expect(await probeDatabasePort(await closedPort(), signal, { timeoutMs: 500 })).toBe(false);
		const silent = listen(null);
		expect(await probeDatabasePort(silent.port, signal, { postgres: false, timeoutMs: 500 })).toBe(true);
	});

	test('an aborted signal short-circuits', async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await probeDatabasePort(1, controller.signal)).toBe(false);
	});
});
