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
import type { HelperApi, HelperWorkloadStatus } from './helper-client.ts';
import { WorkloadRuntime, workloadFingerprint, workloadHeartbeat } from './runtime.ts';

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

	async status(id: string): Promise<HelperWorkloadStatus> {
		this.statusCalls.push(id);
		return this.statuses.get(id) ?? { id, status: 'running', restarts: 0 };
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
