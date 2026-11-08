import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, jobLimits, nodeCapabilities } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { JOB_LOG_LINES_MAX } from './jobs.ts';
import { LocalObjectStore } from './object-store.ts';

/** App cron jobs and one-off commands (plan 09): definitions, scheduling, the node protocol, sweep. */
const dir = mkdtempSync(join(tmpdir(), 'skiff-jobs-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:30Z');
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
		features: { ...DEFAULT_FEATURES, JOBS: true },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_2', role: 'owner' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

let nodeId = '';
let nodeToken = '';
let workloadId = '';
const project = () => core.projects.requireRow(owner, 'shop');
const advance = (ms: number) => {
	clock += ms;
};
const sql = <T>(query: string, ...params: Array<string | number>) => opened.sqlite.query<T, Array<string | number>>(query).all(...params);

function heartbeat(capabilities: string[]) {
	core.nodes.heartbeat(nodeToken, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 0,
		status: 'online',
		caddyOk: true,
		capabilities,
		releases: [],
	} as never);
}

/** Lease everything due, then report each run with the given outcome. */
function finishAll(status: 'succeeded' | 'failed' | 'timeout', exitCode: number | null = status === 'succeeded' ? 0 : 1) {
	const lease = core.jobs.lease(nodeId);
	for (const run of lease.runs)
		core.jobs.complete(nodeId, { runId: run.runId, status, exitCode, startedAt: clock, finishedAt: clock, error: null });
	return lease.runs;
}

beforeAll(async () => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	nodeId = joined.nodeId;
	nodeToken = joined.token;
	core.nodes.update(owner, nodeId, { sliceMemoryMb: 8192 });
	heartbeat(['functions']);
	for (const [slug, runtime] of [
		['shop', 'process'],
		['site', 'static'],
	] as const)
		await core.projects.create(owner, { name: slug, slug, runtime, placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
	core.workloads.setSpec(owner, project(), { runtime: 'process', command: ['bun', 'run', 'start'], memoryMb: 128 });
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('job definitions', () => {
	test('create checks permissions, the runtime, the name and the schedule', () => {
		expect(() => core.jobs.create(viewer, project(), { name: 'tidy', command: ['bun', 'tidy.ts'] })).toThrow(/project:update/);
		expect(() => core.jobs.create(owner, core.projects.requireRow(owner, 'site'), { name: 'tidy', command: ['x'] })).toThrow(/static site/);
		expect(() => core.jobs.create(owner, project(), { name: 'Bad Name', command: ['x'] })).toThrow();
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: [] })).toThrow(/command/);
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: ['echo', 'a\nb'] })).toThrow(/newlines/);
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: ['x'], schedule: '99 * * * *' })).toThrow();
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: ['x'], schedule: '0 0 31 2 *' })).toThrow(/never fires/);
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: ['x'], timeoutSeconds: 1 })).toThrow();
	});

	test('a scheduled job has a next run in UTC; a manual one does not', () => {
		const tidy = core.jobs.create(owner, project(), {
			name: 'tidy',
			command: ['bun', 'scripts/tidy.ts', '--older-than', '30 days'],
			schedule: '*/15 * * * *',
		});
		expect(tidy).toMatchObject({
			name: 'tidy',
			projectSlug: 'shop',
			// Spaces inside one argument survive: argv, never a shell string.
			command: ['bun', 'scripts/tidy.ts', '--older-than', '30 days'],
			schedule: '*/15 * * * *',
			timeoutSeconds: 600,
			concurrency: 'forbid',
			maxRetries: 0,
			enabled: true,
			nextRunAt: '2026-11-07T10:15:00.000Z',
			lastRun: null,
		});
		const manual = core.jobs.create(owner, project(), { name: 'migrate', command: ['bun', 'run', 'migrate'] });
		expect(manual.nextRunAt).toBeNull();
		expect(() => core.jobs.create(owner, project(), { name: 'tidy', command: ['x'] })).toThrow(/already has a job/);
		expect(core.jobs.list(viewer, project()).map((job) => job.name)).toEqual(['migrate', 'tidy']);
		expect(() => core.jobs.get(otherOrg, project(), 'tidy')).toThrow(/not found/i);
	});

	test('the quota counts jobs through the registered counter', () => {
		expect(core.ctx.quota.snapshotCounts('org_1').jobs).toBe(2);
		core.ctx.quota.set('org_1', { jobs: 2 });
		expect(() => core.jobs.create(owner, project(), { name: 'third', command: ['x'] })).toThrow(/Jobs quota/);
		core.ctx.quota.set('org_1', { jobs: -1 });
	});

	test('pause clears the next run, resume counts from now; update reschedules', () => {
		expect(core.jobs.setEnabled(owner, project(), 'tidy', false).nextRunAt).toBeNull();
		expect(core.jobs.setEnabled(owner, project(), 'tidy', true).nextRunAt).toBe('2026-11-07T10:15:00.000Z');
		const updated = core.jobs.update(owner, project(), 'tidy', { schedule: '0 3 * * *', maxRetries: 2 });
		expect(updated).toMatchObject({ schedule: '0 3 * * *', maxRetries: 2, nextRunAt: '2026-11-08T03:00:00.000Z' });
		expect(() => core.jobs.update(owner, project(), 'tidy', {})).toThrow(/Nothing to update/);
		core.jobs.update(owner, project(), 'tidy', { schedule: '*/15 * * * *', maxRetries: 0 });
	});
});

describe('runs and the node protocol', () => {
	test('a manual run is refused before the app is deployed, or on an agent without jobs', async () => {
		expect(() => core.jobs.run(owner, project(), 'migrate')).toThrow(/no running deployment/);
		await core.uploads.deployInline(owner, project(), [file('package.json', '{"scripts":{"start":"bun server.ts"}}'), file('server.ts', '')], {
			promote: true,
		});
		workloadId = sql<{ id: string }>('SELECT id FROM workloads WHERE project_id = ?', project().id)[0]!.id;
		expect(() => core.jobs.run(owner, project(), 'migrate')).toThrow(/predates jobs/);
		heartbeat([...nodeCapabilities]);
		expect(() => core.jobs.run(viewer, project(), 'migrate')).toThrow(/deployment:create/);
	});

	test('run → lease → heartbeat → complete', () => {
		const run = core.jobs.run(owner, project(), 'migrate');
		expect(run).toMatchObject({ jobName: 'migrate', trigger: 'manual', attempt: 1, status: 'queued', nodeId, createdBy: 'user_1' });
		expect(run.id).toMatch(/^jr_[a-f0-9]{32}$/);
		expect(core.jobs.hasQueued(nodeId)).toBe(true);
		const lease = core.jobs.lease(nodeId);
		expect(lease).toEqual({
			runs: [{ runId: run.id, workloadId, command: ['bun', 'run', 'migrate'], timeoutSeconds: 600 }],
			heartbeatSeconds: jobLimits.heartbeatSeconds,
		});
		// A second lease in the same window gets nothing.
		expect(core.jobs.lease(nodeId).runs).toEqual([]);
		expect(core.jobs.heartbeat(nodeId, { runIds: [run.id, 'jr_unknown'] })).toEqual({ stop: ['jr_unknown'] });
		// Another node cannot answer for it.
		core.jobs.complete('node_other', { runId: run.id, status: 'succeeded', exitCode: 0, startedAt: clock, finishedAt: clock, error: null });
		expect(core.jobs.getRun(owner, project(), run.id).status).toBe('running');
		advance(4_000);
		core.jobs.complete(nodeId, { runId: run.id, status: 'succeeded', exitCode: 0, startedAt: clock - 3_000, finishedAt: clock, error: null });
		const done = core.jobs.getRun(viewer, project(), run.id);
		expect(done).toMatchObject({ status: 'succeeded', exitCode: 0, durationMs: 3_000, error: null });
		expect(core.jobs.get(owner, project(), 'migrate').lastRun?.id).toBe(run.id);
	});

	test('a one-off command runs once and is not saved as a job', () => {
		const run = core.jobs.runOneOff(owner, project(), { command: ['bun', '-e', 'console.log("hi $USER")'], timeoutSeconds: 30 });
		expect(run).toMatchObject({ jobId: null, jobName: null, trigger: 'manual', timeoutSeconds: 30 });
		const [leased] = finishAll('failed', 2);
		expect(leased?.command).toEqual(['bun', '-e', 'console.log("hi $USER")']);
		expect(core.jobs.getRun(owner, project(), run.id)).toMatchObject({ status: 'failed', exitCode: 2, error: 'Exited with status 2.' });
		expect(core.jobs.runs(owner, project(), { oneOff: true }).map((item) => item.id)).toEqual([run.id]);
		expect(core.jobs.list(owner, project())).toHaveLength(2);
	});

	test('cancel: a queued run at once, a running one through the heartbeat', () => {
		const queued = core.jobs.run(owner, project(), 'migrate');
		expect(core.jobs.cancelRun(owner, project(), queued.id).status).toBe('cancelled');
		const running = core.jobs.run(owner, project(), 'migrate');
		core.jobs.lease(nodeId);
		expect(core.jobs.cancelRun(owner, project(), running.id)).toMatchObject({ status: 'running', cancelRequested: true });
		expect(core.jobs.heartbeat(nodeId, { runIds: [running.id] }).stop).toEqual([running.id]);
		core.jobs.complete(nodeId, { runId: running.id, status: 'failed', exitCode: null, startedAt: clock, finishedAt: clock, error: 'Stopped.' });
		expect(core.jobs.getRun(owner, project(), running.id).status).toBe('cancelled');
	});

	test('output is stored under the run and kept out of the app’s logs', () => {
		const run = core.jobs.run(owner, project(), 'migrate');
		core.jobs.lease(nodeId);
		const line = (message: string) => ({ ts: clock, stream: 'stdout' as const, level: 'info' as const, message });
		expect(core.logs.appendRuntime(nodeId, { workloadId, jobRunId: run.id, lines: [line('migrating 3 tables')] })).toBe(1);
		core.logs.appendRuntime(nodeId, { workloadId, lines: [line('GET / 200')] });
		expect(core.jobs.runLogs(owner, project(), run.id).events.map((event) => event.message)).toEqual(['migrating 3 tables']);
		expect(core.logs.query(owner, project()).events.map((event) => event.message)).toEqual(['GET / 200']);
		// Another node cannot write into the run; an unknown run is an empty drain.
		expect(() => core.logs.appendRuntime('node_other', { workloadId, jobRunId: run.id, lines: [line('x')] })).toThrow(/another node/);
		expect(core.logs.appendRuntime(nodeId, { workloadId, jobRunId: 'jr_gone', lines: [line('x')] })).toBe(0);
		// A chatty run keeps its first lines and one notice.
		const many = Array.from({ length: 500 }, (_, index) => line(`line ${index}`));
		let stored = 0;
		for (let index = 0; index < JOB_LOG_LINES_MAX / 500 + 1; index += 1) stored += core.logs.appendRuntime(nodeId, { workloadId, jobRunId: run.id, lines: many });
		expect(stored).toBe(JOB_LOG_LINES_MAX);
		expect(core.jobs.runLogs(owner, project(), run.id, { limit: 1 }).events[0]?.message).toMatch(/Output truncated/);
		core.jobs.complete(nodeId, { runId: run.id, status: 'succeeded', exitCode: 0, startedAt: clock, finishedAt: clock, error: null });
	});
});

describe('the scheduler', () => {
	test('a due job fires once; missed occurrences are not replayed', () => {
		clock = Date.parse('2026-11-07T10:15:05Z');
		expect(core.jobs.scheduleDue()).toEqual({ fired: 1, skipped: 0 });
		// The same due time does not fire twice (a second control plane, or the next tick).
		expect(core.jobs.scheduleDue()).toEqual({ fired: 0, skipped: 0 });
		expect(core.jobs.get(owner, project(), 'tidy').nextRunAt).toBe('2026-11-07T10:30:00.000Z');
		finishAll('succeeded');
		// Down for two hours: one run now, then the next occurrence after now.
		clock = Date.parse('2026-11-07T12:31:00Z');
		expect(core.jobs.scheduleDue()).toEqual({ fired: 1, skipped: 0 });
		expect(core.jobs.get(owner, project(), 'tidy').nextRunAt).toBe('2026-11-07T12:45:00.000Z');
	});

	test('forbid records an overlapping run as skipped', () => {
		clock = Date.parse('2026-11-07T12:45:01Z');
		expect(core.jobs.scheduleDue()).toEqual({ fired: 0, skipped: 1 });
		const [latest] = core.jobs.runs(owner, project(), { job: 'tidy', limit: 1 });
		expect(latest).toMatchObject({ trigger: 'schedule', status: 'skipped', error: expect.stringMatching(/still going/) });
		finishAll('succeeded');
	});

	test('replace cancels the running one; allow runs both', () => {
		core.jobs.update(owner, project(), 'tidy', { concurrency: 'replace' });
		clock = Date.parse('2026-11-07T13:00:01Z');
		core.jobs.scheduleDue();
		const [first] = core.jobs.lease(nodeId).runs;
		clock = Date.parse('2026-11-07T13:15:01Z');
		core.jobs.scheduleDue();
		expect(core.jobs.heartbeat(nodeId, { runIds: [first!.runId] }).stop).toEqual([first!.runId]);
		core.jobs.complete(nodeId, { runId: first!.runId, status: 'cancelled', exitCode: null, startedAt: clock, finishedAt: clock, error: null });
		expect(core.jobs.getRun(owner, project(), first!.runId).status).toBe('cancelled');
		expect(core.jobs.lease(nodeId).runs).toHaveLength(1);

		core.jobs.update(owner, project(), 'tidy', { concurrency: 'allow' });
		clock = Date.parse('2026-11-07T13:30:01Z');
		expect(core.jobs.scheduleDue()).toEqual({ fired: 1, skipped: 0 });
		expect(core.jobs.lease(nodeId).runs).toHaveLength(1);
		finishAll('succeeded');
		for (const run of core.jobs.runs(owner, project(), { job: 'tidy' }).filter((item) => item.status === 'running'))
			core.jobs.complete(nodeId, { runId: run.id, status: 'succeeded', exitCode: 0, startedAt: clock, finishedAt: clock, error: null });
		core.jobs.update(owner, project(), 'tidy', { concurrency: 'forbid', schedule: '0 0 1 1 *' });
	});

	test('a failure is retried with backoff until the retries run out', () => {
		core.jobs.update(owner, project(), 'migrate', { maxRetries: 2 });
		const first = core.jobs.run(owner, project(), 'migrate');
		core.jobs.lease(nodeId);
		core.jobs.complete(nodeId, { runId: first.id, status: 'timeout', exitCode: null, startedAt: clock, finishedAt: clock, error: 'Timed out after 600 s.' });
		const [retry] = core.jobs.runs(owner, project(), { job: 'migrate', limit: 1 });
		expect(retry).toMatchObject({ trigger: 'retry', attempt: 2, status: 'queued' });
		expect(Date.parse(retry!.runAt) - clock).toBe(30_000);
		// Not due yet.
		expect(core.jobs.lease(nodeId).runs).toEqual([]);
		advance(30_000);
		expect(finishAll('failed').map((run) => run.runId)).toEqual([retry!.id]);
		const [third] = core.jobs.runs(owner, project(), { job: 'migrate', limit: 1 });
		expect(third).toMatchObject({ attempt: 3, status: 'queued' });
		expect(Date.parse(third!.runAt) - clock).toBe(60_000);
		advance(60_000);
		finishAll('failed');
		expect(core.jobs.runs(owner, project(), { job: 'migrate', limit: 1 })[0]).toMatchObject({ attempt: 3, status: 'failed' });
		core.jobs.update(owner, project(), 'migrate', { maxRetries: 0 });
	});

	test('a refused scheduled run is recorded skipped; a manual one throws', () => {
		const used = core.ctx.quota.snapshotCounts('org_1').jobRunsPerDay;
		expect(used).toBeGreaterThan(0);
		core.ctx.quota.set('org_1', { jobRunsPerDay: used });
		expect(() => core.jobs.run(owner, project(), 'migrate')).toThrow(/Job runs today/);
		core.jobs.update(owner, project(), 'tidy', { schedule: '*/15 * * * *' });
		clock = Date.parse('2026-11-07T14:00:01Z');
		expect(core.jobs.scheduleDue()).toEqual({ fired: 0, skipped: 1 });
		expect(core.jobs.runs(owner, project(), { job: 'tidy', limit: 1 })[0]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/Job runs today/) });
		// Skipped runs do not use the budget.
		expect(core.ctx.quota.snapshotCounts('org_1').jobRunsPerDay).toBe(used);
		core.ctx.quota.set('org_1', { jobRunsPerDay: -1 });
		core.jobs.setEnabled(owner, project(), 'tidy', false);
	});
});

describe('sweep', () => {
	test('unclaimed and silent runs fail; a lost run is retried', () => {
		core.jobs.update(owner, project(), 'migrate', { maxRetries: 1 });
		const unclaimed = core.jobs.run(owner, project(), 'migrate');
		advance(jobLimits.pickupMs + 1);
		core.jobs.sweep();
		expect(core.jobs.getRun(owner, project(), unclaimed.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not pick this run up/) });
		// The retry is queued in 30 s; lease it, then go silent.
		advance(30_000);
		const [retry] = core.jobs.lease(nodeId).runs;
		expect(retry).toBeDefined();
		advance(jobLimits.leaseSeconds * 1000 + 1);
		expect(core.jobs.sweep().failed).toBe(1);
		expect(core.jobs.getRun(owner, project(), retry!.runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/stopped reporting/) });
		// Attempt 2 of 1 retry: no third attempt.
		expect(core.jobs.runs(owner, project(), { job: 'migrate', limit: 1 })[0]?.id).toBe(retry!.runId);
		core.jobs.update(owner, project(), 'migrate', { maxRetries: 0 });
	});

	test('a job keeps its newest runs; deleting a job removes its history and output', () => {
		for (let index = 0; index < jobLimits.runsKept + 5; index += 1) {
			core.jobs.run(owner, project(), 'migrate');
			finishAll('succeeded');
			advance(1);
		}
		core.jobs.sweep();
		expect(core.jobs.runs(owner, project(), { job: 'migrate', limit: 200 })).toHaveLength(jobLimits.runsKept);

		const live = core.jobs.run(owner, project(), 'migrate');
		core.jobs.lease(nodeId);
		expect(core.jobs.remove(owner, project(), 'migrate')).toEqual({ deleted: true, stopping: 1 });
		expect(() => core.jobs.get(owner, project(), 'migrate')).toThrow(/not found/i);
		expect(core.jobs.heartbeat(nodeId, { runIds: [live.id] }).stop).toEqual([live.id]);
		core.jobs.complete(nodeId, { runId: live.id, status: 'cancelled', exitCode: null, startedAt: clock, finishedAt: clock, error: null });
		core.jobs.sweep();
		expect(sql<{ n: number }>("SELECT COUNT(*) AS n FROM job_runs WHERE job_name = 'migrate'")[0]?.n).toBe(0);
	});
});

describe('the JOBS flag', () => {
	test('off: no new jobs or runs, and the scheduler does nothing; reads still work', async () => {
		const offDir = mkdtempSync(join(tmpdir(), 'skiff-jobs-off-'));
		const db = createDb({ path: ':memory:' });
		const off = createCore({
			db: db.db,
			sqlite: db.sqlite,
			version: '0.1.0',
			config: {
				dataDir: offDir,
				platformOrigin: 'https://control.test',
				contentDomain: 'sites.test',
				objectStore: new LocalObjectStore(join(offDir, 'objects'), 'https://control.test', 'object-secret-123'),
				masterKey: new Uint8Array(32).fill(7),
				siteCookieSecret: 'site-cookie-secret-123',
				objectStoreSecret: 'object-secret-123',
				features: { ...DEFAULT_FEATURES, JOBS: false },
			},
		});
		try {
			await off.projects.create(owner, { name: 'shop', slug: 'shop', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
			const row = off.projects.requireRow(owner, 'shop');
			expect(off.jobs.enabled()).toBe(false);
			expect(() => off.jobs.create(owner, row, { name: 'tidy', command: ['x'] })).toThrow(/SKIFF_FEATURE_JOBS/);
			expect(() => off.jobs.runOneOff(owner, row, { command: ['x'] })).toThrow(/SKIFF_FEATURE_JOBS/);
			expect(off.jobs.list(owner, row)).toEqual([]);
			expect(off.jobs.scheduleDue()).toEqual({ fired: 0, skipped: 0 });
		} finally {
			db.sqlite.close();
			rmSync(offDir, { recursive: true, force: true });
		}
	});
});

describe('resource-scoped access', () => {
	test('a project binding covers only that project jobs', () => {
		const visible = project();
		const hidden = core.projects.requireRow(owner, 'site');
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_scope_jobs', 'org_1', 'user', 'user_scope_jobs', 'viewer', 'project', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({ kind: 'user', userId: 'user_scope_jobs', orgId: 'org_1', role: 'viewer' });
		expect(core.jobs.list(guest, visible).map((job) => job.id)).toEqual(core.jobs.list(owner, visible).map((job) => job.id));
		expect(() => core.jobs.list(guest, hidden)).toThrow(/project:read/);
		expect(() => core.jobs.runs(guest, hidden)).toThrow(/project:read/);
	});
});
