import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FUNCTION_INTERNAL_HEADER,
	FUNCTION_INTERNAL_VALUE,
	workloadDesiredSchema,
	type DesiredState,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@skiff/contracts';
import type { HelperWorkloadStatus } from './helper-client.ts';
import { FunctionScheduler } from './function-scheduler.ts';

const SHA = 'a'.repeat(64);
const SOCKET_DIR = '/run/skiff-workloads';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const MINUTE = 60_000;
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeClock {
	value: number;

	constructor(start: number) {
		this.value = start;
	}

	now = (): number => this.value;

	advance(ms: number): void {
		this.value += ms;
	}
}

class FakeHelper {
	statuses = new Map<string, WorkloadStatus>();
	statusCalls: string[] = [];
	stops: string[] = [];
	restarts: string[] = [];
	failStatus = new Set<string>();
	failStop = new Set<string>();
	failRestart = new Set<string>();

	async status(id: string): Promise<HelperWorkloadStatus> {
		this.statusCalls.push(id);
		if (this.failStatus.has(id)) throw new Error('helper unavailable');
		return { id, status: this.statuses.get(id) ?? 'running', restarts: 0 };
	}

	async stop(id: string): Promise<void> {
		if (this.failStop.has(id)) throw new Error('systemctl stop failed');
		this.stops.push(id);
		this.statuses.set(id, 'stopped');
	}

	async restart(id: string): Promise<void> {
		if (this.failRestart.has(id)) throw new Error('systemctl restart failed');
		this.restarts.push(id);
		this.statuses.set(id, 'running');
	}
}

type FetchInit = RequestInit & { unix?: string };

function fakeFetch(options: { status?: number } = {}) {
	const calls: Array<{ url: string; init: FetchInit }> = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init: (init ?? {}) as FetchInit });
		const status = options.status ?? 200;
		return new Response(status >= 400 ? 'boom' : 'ok', { status });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

function functionWorkload(
	options: {
		id?: string;
		projectId?: string;
		idleStopSeconds?: number;
		crons?: string[];
	} = {},
): WorkloadDesired {
	const id = options.id ?? 'wld_fn';
	const projectId = options.projectId ?? 'prj_fn';
	return workloadDesiredSchema.parse({
		id,
		projectId,
		projectSlug: 'fn-app',
		deploymentId: 'dep_fn',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: `unix/${SOCKET_DIR}/${projectId}.sock`,
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: SHA }],
			compatibilityDate: '2026-10-01',
			compatibilityFlags: [],
			bindings: [],
			triggers: { crons: options.crons ?? [] },
			assets: null,
			idleStopSeconds: options.idleStopSeconds ?? 300,
			workerdVersion: '1.20261106.1',
		},
	});
}

/** The scheduler only reads `workloads`; a full desired state is irrelevant to these tests. */
function stateWith(workloads: WorkloadDesired[]): DesiredState {
	return { version: 1, workloads } as unknown as DesiredState;
}

interface HarnessOptions {
	at?: number;
	statePath?: string | null;
	helper?: FakeHelper;
	fetch?: typeof fetch;
	probeHealth?: (workload: WorkloadDesired, signal: AbortSignal) => Promise<boolean>;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	watchdogMisses?: number;
	restartCooldownMs?: number;
	cronIntervalMs?: number;
	activityEnabled?: boolean;
}

function make(options: HarnessOptions = {}) {
	const clock = new FakeClock(options.at ?? T0);
	const helper = options.helper ?? new FakeHelper();
	const logs: Array<{ level: string; message: string }> = [];
	const scheduler = new FunctionScheduler({
		helper,
		socketDir: SOCKET_DIR,
		statePath: options.statePath ?? null,
		probeHealth: options.probeHealth ?? (async () => true),
		fetch: options.fetch ?? fakeFetch().fetcher,
		now: clock.now,
		sleep: options.sleep ?? (async () => {}),
		log: (level, message) => logs.push({ level, message }),
		watchdogIntervalMs: 1_000,
		watchdogMisses: options.watchdogMisses,
		restartCooldownMs: options.restartCooldownMs,
		cronIntervalMs: options.cronIntervalMs ?? 0,
		...(options.activityEnabled === undefined ? {} : { activityEnabled: options.activityEnabled }),
	});
	return { clock, helper, logs, scheduler };
}

async function tempStatePath(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-function-scheduler-'));
	directories.push(dir);
	return join(dir, 'function-cron-state.json');
}

interface CronState {
	crons: Array<{ workloadId: string; cron: string; lastFiredAt: number | null }>;
}

async function readCronState(path: string): Promise<CronState> {
	return JSON.parse(await fs.readFile(path, 'utf8')) as CronState;
}

const signal = new AbortController().signal;

describe('scale to zero (FN4)', () => {
	test('stops a running host after idleStopSeconds and logs the idle time', async () => {
		const made = make();
		const state = stateWith([functionWorkload({ idleStopSeconds: 300 })]);

		// First sight seeds the timer: nothing is stopped immediately.
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);

		made.clock.advance(299_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);

		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual(['wld_fn']);
		expect(made.logs).toContainEqual({
			level: 'info',
			message: 'Function wld_fn stopped after 300s idle',
		});
	});

	test('without an access-log activity source scale-to-zero is disabled', async () => {
		const made = make({ activityEnabled: false });
		const state = stateWith([functionWorkload({ idleStopSeconds: 300 })]);
		await made.scheduler.tick(state, signal);
		made.clock.advance(3_600_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);
	});

	test('idleStopSeconds 0 keeps the host always on', async () => {
		const made = make();
		const state = stateWith([functionWorkload({ idleStopSeconds: 0 })]);
		await made.scheduler.tick(state, signal);
		made.clock.advance(10 * 60 * MINUTE);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);
	});

	test('a request resets the idle timer', async () => {
		const made = make();
		const state = stateWith([functionWorkload({ idleStopSeconds: 300 })]);
		await made.scheduler.tick(state, signal);

		made.clock.advance(200_000);
		made.scheduler.noteActivity('prj_fn', made.clock.now());
		made.clock.advance(200_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);

		made.clock.advance(100_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual(['wld_fn']);
	});

	test('a status transition (restart or apply) resets the timer', async () => {
		const made = make();
		const state = stateWith([functionWorkload({ idleStopSeconds: 300 })]);
		made.helper.statuses.set('wld_fn', 'running');
		await made.scheduler.tick(state, signal);

		made.clock.advance(200_000);
		made.helper.statuses.set('wld_fn', 'starting');
		await made.scheduler.tick(state, signal);

		made.clock.advance(100_000);
		made.helper.statuses.set('wld_fn', 'running');
		await made.scheduler.tick(state, signal);

		// 300 s have passed since the workload appeared, but 0 s since it started again.
		made.clock.advance(299_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);

		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual(['wld_fn']);
	});

	test('never stops a host that is not running', async () => {
		const made = make();
		const state = stateWith([functionWorkload({ idleStopSeconds: 1 })]);
		made.helper.statuses.set('wld_fn', 'stopped');
		await made.scheduler.tick(state, signal);
		made.clock.advance(60_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.stops).toEqual([]);
	});

	test('ignores every tier that is not a function', async () => {
		const made = make();
		const processWorkload = workloadDesiredSchema.parse({
			id: 'wld_proc',
			projectId: 'prj_proc',
			projectSlug: 'process-app',
			deploymentId: 'dep_proc',
			runtime: 'process',
			status: 'running',
			release: SHA,
			upstream: 'unix//run/skiff-workloads/prj_proc.sock',
			memoryMb: 256,
			cpus: 1,
			port: 3000,
			healthPath: '/health',
			socketActivation: true,
			activationVersion: 'b'.repeat(64),
			env: {},
			secrets: [],
			dataSizeMb: null,
		});
		const state = stateWith([processWorkload, functionWorkload({ idleStopSeconds: 0 })]);
		await made.scheduler.tick(state, signal);
		made.clock.advance(10 * 60 * MINUTE);
		await made.scheduler.tick(state, signal);
		expect(made.helper.statusCalls).not.toContain('wld_proc');
		expect(made.helper.stops).toEqual([]);
	});

	test('a failed stop is logged and does not escape the tick', async () => {
		const made = make();
		await made.scheduler.tick(stateWith([functionWorkload({ idleStopSeconds: 0 })]), signal);
		made.helper.failStop.add('wld_fn');
		made.clock.advance(60_000);
		await expect(
			made.scheduler.tick(stateWith([functionWorkload({ idleStopSeconds: 1 })]), signal),
		).resolves.toBeUndefined();
		expect(made.logs.some((entry) => entry.message.includes('idle stop failed'))).toBe(true);
		expect(made.helper.stops).toEqual([]);
	});
});

describe('runaway watchdog (FN5)', () => {
	test('restarts after three consecutive missed probes, then honours the cooldown', async () => {
		let probes = 0;
		const made = make({
			restartCooldownMs: 60_000,
			probeHealth: async () => {
				probes += 1;
				return false;
			},
		});
		const state = stateWith([functionWorkload()]);

		await made.scheduler.tick(state, signal);
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.restarts).toEqual([]);

		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.restarts).toEqual(['wld_fn']);
		expect(made.logs).toContainEqual({
			level: 'warn',
			message: 'Function wld_fn watchdog restart after 3 missed health probes',
		});

		// Inside the cooldown the host is neither probed nor restarted.
		const probesAfterRestart = probes;
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(probes).toBe(probesAfterRestart);
		expect(made.helper.restarts).toEqual(['wld_fn']);

		// After the cooldown it takes three fresh misses to restart again.
		made.clock.advance(60_000);
		await made.scheduler.tick(state, signal);
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(made.helper.restarts).toEqual(['wld_fn', 'wld_fn']);
	});

	test('a successful probe resets the miss counter', async () => {
		const results = [false, false, true, false, false];
		const made = make({ probeHealth: async () => results.shift() ?? false });
		const state = stateWith([functionWorkload()]);
		for (let index = 0; index < 5; index += 1) {
			await made.scheduler.tick(state, signal);
			made.clock.advance(1_000);
		}
		expect(made.helper.restarts).toEqual([]);
	});

	test('does not probe stopped or stopping hosts', async () => {
		let probes = 0;
		const made = make({
			probeHealth: async () => {
				probes += 1;
				return false;
			},
		});
		made.helper.statuses.set('wld_fn', 'stopped');
		const state = stateWith([functionWorkload()]);
		await made.scheduler.tick(state, signal);
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(probes).toBe(0);
		expect(made.helper.restarts).toEqual([]);
	});

	test('a failed restart is logged, never thrown, and does not set a cooldown', async () => {
		const made = make({ probeHealth: async () => false });
		made.helper.failRestart.add('wld_fn');
		const state = stateWith([functionWorkload()]);
		for (let index = 0; index < 3; index += 1) {
			await expect(made.scheduler.tick(state, signal)).resolves.toBeUndefined();
			made.clock.advance(1_000);
		}
		expect(made.logs.some((entry) => entry.message.includes('watchdog restart failed'))).toBe(true);
		expect(made.helper.restarts).toEqual([]);
	});
});

describe('cron triggers (FN9)', () => {
	test('fires a due occurrence once, advances the cursor and sends the internal headers', async () => {
		const calls = fakeFetch();
		const made = make({ fetch: calls.fetcher });
		const state = stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]);

		await made.scheduler.tick(state, signal);
		expect(calls.calls).toHaveLength(1);
		const [call] = calls.calls;
		expect(call?.url).toBe('http://localhost/__skiff/scheduled');
		expect(call?.init.method).toBe('POST');
		expect(call?.init.unix).toBe(`${SOCKET_DIR}/wld_fn.sock`);
		expect(call?.init.headers).toEqual({
			[FUNCTION_INTERNAL_HEADER]: FUNCTION_INTERNAL_VALUE,
			'x-skiff-cron': '*/5 * * * *',
			'x-skiff-scheduled-time': String(T0),
		});

		// The same occurrence never fires twice.
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(calls.calls).toHaveLength(1);

		// The next occurrence does, with its own scheduled time.
		made.clock.advance(5 * MINUTE);
		await made.scheduler.tick(state, signal);
		expect(calls.calls).toHaveLength(2);
		expect(calls.calls[1]?.init.headers).toMatchObject({
			'x-skiff-scheduled-time': String(T0 + 5 * MINUTE),
		});
	});

	test('a fresh schedule does not replay occurrences from before the grace window', async () => {
		const calls = fakeFetch();
		const made = make({ at: T0 + 2 * MINUTE + 30_000, fetch: calls.fetcher });
		const state = stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]);
		// 10:00 already passed more than a minute ago; 10:05 is still future.
		await made.scheduler.tick(state, signal);
		expect(calls.calls).toHaveLength(0);

		made.clock.advance(2 * MINUTE + 30_000);
		await made.scheduler.tick(state, signal);
		expect(calls.calls).toHaveLength(1);
		expect(calls.calls[0]?.init.headers).toMatchObject({
			'x-skiff-scheduled-time': String(T0 + 5 * MINUTE),
		});
	});

	test('persists the cursor and never replays a backlog after a restart', async () => {
		const path = await tempStatePath();
		const first = make({ statePath: path });
		await first.scheduler.tick(stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]), signal);
		expect((await readCronState(path)).crons).toEqual([
			{ workloadId: 'wld_fn', cron: '*/5 * * * *', lastFiredAt: T0 },
		]);

		// Restart 30 minutes later: the occurrences in between are history, not a backlog.
		const second = make({ at: T0 + 30 * MINUTE, statePath: path });
		const calls = fakeFetch();
		const secondScheduler = new FunctionScheduler({
			helper: second.helper,
			socketDir: SOCKET_DIR,
			statePath: path,
			probeHealth: async () => true,
			fetch: calls.fetcher,
			now: second.clock.now,
			cronIntervalMs: 0,
		});
		const workload = functionWorkload({ crons: ['*/5 * * * *'] });
		await secondScheduler.tick(stateWith([workload]), signal);
		expect(calls.calls).toHaveLength(0);

		// The next real occurrence still fires exactly once.
		second.clock.advance(5 * MINUTE);
		await secondScheduler.tick(stateWith([workload]), signal);
		expect(calls.calls).toHaveLength(1);
		expect(calls.calls[0]?.init.headers).toMatchObject({
			'x-skiff-scheduled-time': String(T0 + 35 * MINUTE),
		});
	});

	test('fires an occurrence missed by less than the grace window on restart', async () => {
		const path = await tempStatePath();
		const first = make({ statePath: path });
		await first.scheduler.tick(stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]), signal);

		const calls = fakeFetch();
		const second = make({ at: T0 + 5 * MINUTE + 30_000, statePath: path, fetch: calls.fetcher });
		await second.scheduler.tick(stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]), signal);
		expect(calls.calls).toHaveLength(1);
		expect(calls.calls[0]?.init.headers).toMatchObject({
			'x-skiff-scheduled-time': String(T0 + 5 * MINUTE),
		});
	});

	test('prunes schedules for workloads that left desired state', async () => {
		const path = await tempStatePath();
		const made = make({ statePath: path });
		const kept = functionWorkload({ id: 'wld_kept', projectId: 'prj_kept', crons: ['*/5 * * * *'] });
		const removed = functionWorkload({ id: 'wld_gone', projectId: 'prj_gone', crons: ['0 * * * *'] });
		await made.scheduler.tick(stateWith([kept, removed]), signal);
		expect((await readCronState(path)).crons).toHaveLength(2);

		made.clock.advance(1_000);
		await made.scheduler.tick(stateWith([kept]), signal);
		expect((await readCronState(path)).crons).toEqual([
			{ workloadId: 'wld_kept', cron: '*/5 * * * *', lastFiredAt: T0 },
		]);
	});

	test('logs a failed POST without throwing and still advances the cursor', async () => {
		const path = await tempStatePath();
		const failed = fakeFetch({ status: 500 });
		const made = make({ statePath: path, fetch: failed.fetcher });
		const state = stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]);
		await expect(made.scheduler.tick(state, signal)).resolves.toBeUndefined();
		expect(failed.calls).toHaveLength(1);
		expect(made.logs.some((entry) => entry.level === 'warn' && entry.message.includes('500'))).toBe(
			true,
		);

		// Advanced to the occurrence anyway: the next tick in the same minute must not retry.
		made.clock.advance(1_000);
		await made.scheduler.tick(state, signal);
		expect(failed.calls).toHaveLength(1);
		expect((await readCronState(path)).crons[0]?.lastFiredAt).toBe(T0);
	});

	test('fires cron only for replica 0 so a scaled project runs once per occurrence', async () => {
		const calls = fakeFetch();
		const made = make({ fetch: calls.fetcher });
		const primary = functionWorkload({ crons: ['*/5 * * * *'] });
		const replica = workloadDesiredSchema.parse({
			...functionWorkload({ crons: ['*/5 * * * *'] }),
			id: 'wld_fn-r1',
			replica: { index: 1 },
		});
		await made.scheduler.tick(stateWith([primary, replica]), signal);
		expect(calls.calls).toHaveLength(1);
		expect(calls.calls[0]?.init.unix).toBe(`${SOCKET_DIR}/wld_fn.sock`);
	});

	test('a fetch that throws is logged, not thrown out of the tick', async () => {
		const made = make({
			fetch: (async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch,
		});
		await expect(
			made.scheduler.tick(stateWith([functionWorkload({ crons: ['*/5 * * * *'] })]), signal),
		).resolves.toBeUndefined();
		expect(made.logs.some((entry) => entry.message.includes('ECONNREFUSED'))).toBe(true);
	});
});

describe('run loop', () => {
	test('ticks until the shutdown signal aborts', async () => {
		const controller = new AbortController();
		let sleeps = 0;
		const made = make({
			sleep: async () => {
				sleeps += 1;
				if (sleeps >= 2) controller.abort();
			},
		});
		await made.scheduler.run(
			() => stateWith([functionWorkload({ idleStopSeconds: 0 })]),
			controller.signal,
		);
		expect(sleeps).toBe(2);
	});

	test('survives a throwing getState and keeps looping until aborted', async () => {
		const controller = new AbortController();
		let calls = 0;
		const made = make({
			sleep: async () => {
				if (calls >= 2) controller.abort();
			},
		});
		await expect(
			made.scheduler.run(() => {
				calls += 1;
				throw new Error('no desired state');
			}, controller.signal),
		).resolves.toBeUndefined();
		expect(calls).toBe(2);
		expect(made.logs.some((entry) => entry.message.includes('tick failed'))).toBe(true);
	});
});
