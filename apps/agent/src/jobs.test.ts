import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentJobRun, DesiredState, WorkloadActivation, WorkloadDesired } from '@yoal/contracts';
import { JobRunner, jobWorkloads, type HelperJobApi, type HelperJobStatus } from './jobs.ts';
import type { HelperLogResult } from './helper-client.ts';

const RUN = `jr_${'a'.repeat(32)}`;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const workload = (overrides: Partial<WorkloadDesired> = {}) =>
	({ id: 'wld_1', projectId: 'prj_1', projectSlug: 'shop', runtime: 'process', status: 'running', activationVersion: 'v1', ...overrides }) as WorkloadDesired;
const run = (overrides: Partial<AgentJobRun> = {}): AgentJobRun => ({ runId: RUN, workloadId: 'wld_1', command: ['bun', 'migrate.ts'], timeoutSeconds: 60, ...overrides });
const status = (outcome: HelperJobStatus['outcome'], extra: Partial<HelperJobStatus> = {}): HelperJobStatus => ({
	runId: RUN,
	outcome,
	exitCode: outcome === 'succeeded' ? 0 : null,
	signal: null,
	startedAt: 1_000,
	finishedAt: outcome === 'running' ? null : 2_000,
	...extra,
});

class FakeHelper implements HelperJobApi {
	calls: string[] = [];
	current: HelperJobStatus = status('running');
	logs: HelperLogResult[] = [];
	failStart: Error | null = null;
	async startJob(input: Parameters<HelperJobApi['startJob']>[0]): Promise<HelperJobStatus> {
		this.calls.push(`start:${input.run.runId}:${input.activation.env.SECRET ?? ''}`);
		if (this.failStart) throw this.failStart;
		return this.current;
	}
	async jobStatus(runId: string, timeout?: number): Promise<HelperJobStatus> {
		this.calls.push(`status:${runId}:${timeout}`);
		return this.current;
	}
	async jobLogs(): Promise<HelperLogResult> {
		return this.logs.shift() ?? { entries: [], nextCursor: null };
	}
	async stopJob(runId: string, force = false): Promise<void> {
		this.calls.push(`stop:${runId}:${force}`);
	}
	async removeJob(runId: string): Promise<void> {
		this.calls.push(`remove:${runId}`);
	}
}

/** A control plane that hands out queued runs once and records what the agent posts. */
class FakeControl {
	queued: AgentJobRun[] = [];
	stop: string[] = [];
	posts: Array<{ path: string; body: any }> = [];
	failResult = false;
	fetch = (async (url: string | URL, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		this.posts.push({ path, body });
		if (path === '/api/agent/jobs/lease') {
			const runs = this.queued.splice(0);
			return Response.json({ runs, heartbeatSeconds: 15 });
		}
		if (path === '/api/agent/jobs/heartbeat') return Response.json({ stop: this.stop.filter((id) => body.runIds.includes(id)) });
		if (path === '/api/agent/jobs/result' && this.failResult) return new Response('down', { status: 503 });
		return Response.json({ ok: true });
	}) as typeof fetch;
	of(path: string) {
		return this.posts.filter((post) => post.path === path).map((post) => post.body);
	}
}

function setup(options: { statePath?: string | null } = {}) {
	const helper = new FakeHelper();
	const control = new FakeControl();
	let clock = 10_000;
	const runner = new JobRunner({
		controlUrl: 'https://control.test',
		nodeToken: 'node-token',
		helper,
		fetchActivation: async (id) => ({ workloadId: id, activationVersion: 'v1', env: { SECRET: 's3cret' }, files: {} }) as WorkloadActivation,
		statePath: options.statePath ?? null,
		fetch: control.fetch,
		sleep: async () => undefined,
		now: () => clock,
	});
	return { helper, control, runner, advance: (ms: number) => (clock += ms), workloads: new Map([['wld_1', workload()]]) };
}

const signal = new AbortController().signal;

describe('jobWorkloads', () => {
	test('only app workloads run jobs', () => {
		const state = {
			workloads: [
				workload(),
				workload({ id: 'db_1', runtime: 'container', database: {} as never }),
				workload({ id: 'fn_1', function: {} as never }),
				workload({ id: 'ci_1', runtime: 'container', runner: { provider: 'github' } }),
				workload({ id: 'wld_2', runtime: 'container' }),
			],
		} as unknown as DesiredState;
		expect([...jobWorkloads(state).keys()]).toEqual(['wld_1', 'wld_2']);
	});
});

describe('JobRunner', () => {
	test('lease → start → logs → result → cleanup', async () => {
		const { helper, control, runner, workloads, advance } = setup();
		control.queued.push(run());
		await runner.tick(workloads, signal);
		expect(helper.calls[0]).toBe(`start:${RUN}:s3cret`);
		expect(runner.heldRuns()).toHaveLength(1);
		// The first round heartbeats what it holds.
		expect(control.of('/api/agent/jobs/heartbeat')).toEqual([{ runIds: [RUN] }]);

		helper.logs.push({ entries: [{ cursor: 'c1', ts: 5, priority: 6, message: 'migrating' }, { cursor: 'c2', ts: 6, priority: 3, message: 'warning: slow' }], nextCursor: 'c2' });
		advance(1_000);
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/logs')).toEqual([
			{
				workloadId: 'wld_1',
				jobRunId: RUN,
				lines: [
					{ ts: 5, stream: 'stdout', level: 'info', message: 'migrating' },
					{ ts: 6, stream: 'stderr', level: 'warn', message: 'warning: slow' },
				],
			},
		]);
		// No second lease long-poll while a run is held: wait=0.
		expect(control.posts.filter((post) => post.path === '/api/agent/jobs/lease')).toHaveLength(2);

		helper.current = status('succeeded');
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/jobs/result')).toEqual([{ runId: RUN, status: 'succeeded', exitCode: 0, startedAt: 1_000, finishedAt: 2_000, error: null }]);
		expect(helper.calls.at(-1)).toBe(`remove:${RUN}`);
		expect(runner.heldRuns()).toEqual([]);
	});

	test('a run whose app left the node, or that the helper refuses, fails with the reason', async () => {
		const { helper, control, runner, workloads } = setup();
		control.queued.push(run({ workloadId: 'wld_gone' }));
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/jobs/result')[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/not running on this node/) });

		helper.failStart = new Error('helper POST /v1/jobs -> 400: Release x is not present on this node');
		control.queued.push(run({ runId: `jr_${'b'.repeat(32)}` }));
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/jobs/result')[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Could not start: .*not present/) });
		expect(runner.heldRuns()).toEqual([]);
	});

	test('a cancel from the heartbeat stops the unit, escalates after the grace, and reports cancelled', async () => {
		const { helper, control, runner, workloads, advance } = setup();
		control.queued.push(run());
		await runner.tick(workloads, signal);
		control.stop.push(RUN);
		advance(15_000);
		await runner.tick(workloads, signal);
		expect(helper.calls).toContain(`stop:${RUN}:false`);
		advance(31_000);
		await runner.tick(workloads, signal);
		expect(helper.calls).toContain(`stop:${RUN}:true`);
		helper.current = status('killed', { signal: 9 });
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/jobs/result')[0]).toMatchObject({ status: 'cancelled' });
	});

	test('the agent enforces the timeout if systemd did not', async () => {
		const { helper, control, runner, workloads, advance } = setup();
		control.queued.push(run({ timeoutSeconds: 60 }));
		await runner.tick(workloads, signal);
		advance(60_000 + 31_000);
		await runner.tick(workloads, signal);
		expect(helper.calls).toContain(`stop:${RUN}:false`);
		helper.current = status('killed', { signal: 15 });
		await runner.tick(workloads, signal);
		expect(control.of('/api/agent/jobs/result')[0]).toMatchObject({ status: 'timeout', error: 'Timed out after 60 s.' });
	});

	test('a failed report is retried; a restarted agent resumes from its state file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-agent-jobs-'));
		dirs.push(dir);
		const statePath = join(dir, 'jobs-state.json');
		const first = setup({ statePath });
		first.control.queued.push(run());
		await first.runner.tick(first.workloads, signal);
		first.helper.current = status('failed', { exitCode: 203 });
		first.control.failResult = true;
		await first.runner.tick(first.workloads, signal);
		expect(first.helper.calls).not.toContain(`remove:${RUN}`);

		// A new process: it never re-leases or restarts the run, it reports the stored result.
		const second = setup({ statePath });
		await second.runner.tick(second.workloads, signal);
		expect(second.helper.calls.some((call) => call.startsWith('start:'))).toBe(false);
		expect(second.control.of('/api/agent/jobs/result')).toEqual([
			expect.objectContaining({ runId: RUN, status: 'failed', exitCode: 203, error: expect.stringMatching(/did not start: the program was not found/) }),
		]);
		expect(second.helper.calls).toContain(`remove:${RUN}`);
		expect(second.runner.heldRuns()).toEqual([]);
	});

	test('a unit that vanished is a failure', () => {
		const { runner } = setup();
		const held = { runId: RUN, workloadId: 'wld_1', command: ['x'], timeoutSeconds: 60, startedAt: 1, cursor: null, stop: null, result: null };
		expect(runner.resultFor(held, status('not-found'))).toMatchObject({ status: 'failed', error: expect.stringMatching(/gone/) });
		expect(runner.resultFor(held, status('failed', { exitCode: 3 }))).toMatchObject({ status: 'failed', error: 'Exited with status 3.' });
		expect(runner.resultFor(held, status('timeout'))).toMatchObject({ status: 'timeout' });
	});
});
