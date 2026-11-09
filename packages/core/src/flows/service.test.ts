import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, flowLimits } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { flow } from './types.ts';
import { flowRetryDelayMs } from './service.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-flows-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-08T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES },
		now: () => clock,
	},
});
const flows = core.flows;

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const stranger = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_2', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const events = (id: string) => flows.get(owner, id, { steps: true }).steps!.map((entry) => `${entry.step}:${entry.event}`);
const startIn = <S extends Record<string, unknown>>(kind: string, key: string, input: S, extra: Record<string, unknown> = {}) =>
	flows.start({ kind, key, input, orgId: 'org_1', readPermission: 'database:read', cancelPermission: 'database:update', ...extra });

// --- definitions under test ------------------------------------------------

const trail: string[] = [];

flows.register<{ n: number }>({
	kind: 'test.chain',
	title: 'Chain',
	steps: {
		one: { run: ({ state }) => flow.next('two', { state: { n: state.n + 1 } }) },
		two: { run: ({ state }) => flow.succeed({ n: state.n * 10 }) },
	},
});

let compensations: string[] = [];
flows.register<{ label: string }>({
	kind: 'test.wait',
	title: 'Waiter',
	steps: {
		ask: {
			run: () => flow.wait('answer', { timeoutMs: 60_000, detail: 'Asking.' }),
			onSignal: (_, signal) => {
				const payload = signal.payload as { ok?: boolean; ignore?: boolean };
				if (payload.ignore) return null;
				return payload.ok ? flow.next('done') : flow.fail('Answer was no.');
			},
			onTimeout: ({ state }) => {
				compensations.push(`timeout:${state.label}`);
				return flow.fail('Nobody answered.');
			},
		},
		bare: { run: () => flow.wait('never', { timeoutMs: 1_000 }) },
		done: { run: () => flow.succeed('answered') },
	},
	cancel: ({ run, state }) => {
		if (run.step !== 'ask') return null;
		compensations.push(`cancel:${state.label}`);
		return flow.cancel();
	},
	onFailure: ({ state }, error) => {
		compensations.push(`failure:${state.label}:${error}`);
	},
});

let flaky = 0;
flows.register<Record<string, never>>({
	kind: 'test.flaky',
	title: 'Flaky',
	maxAttempts: 3,
	steps: {
		go: {
			run: () => {
				flaky -= 1;
				if (flaky >= 0) throw new Error(`boom ${flaky}`);
				return flow.succeed();
			},
		},
	},
	onFailure: (_, error) => {
		compensations.push(`flaky-failure:${error}`);
	},
});

flows.register<{ value: string }>({
	kind: 'test.async',
	title: 'Async',
	steps: {
		fetch: {
			run: async ({ state }) => {
				await Bun.sleep(5);
				trail.push(`fetched:${state.value}`);
				return flow.next('store', { state: { value: state.value.toUpperCase() } });
			},
		},
		store: { run: ({ state }) => flow.succeed(state.value) },
	},
});

// --- tests ----------------------------------------------------------------

describe('running a flow', () => {
	test('synchronous steps finish before start returns, and every transition is logged', () => {
		const { id, created } = startIn('test.chain', 'k1', { n: 1 });
		expect(created).toBe(true);
		expect(id.startsWith('flw_')).toBe(true);
		const view = flows.get(owner, id);
		expect(view).toMatchObject({ status: 'succeeded', step: 'two', result: { n: 20 }, title: 'Chain' });
		expect(view.finishedAt).not.toBeNull();
		expect(events(id)).toEqual(['one:started', 'two:next', 'two:succeeded']);
	});

	test('an active key is idempotent; a finished key starts a fresh run', () => {
		const first = startIn('test.wait', 'same', { label: 'a' });
		const again = startIn('test.wait', 'same', { label: 'b' });
		expect(again).toMatchObject({ id: first.id, created: false });
		flows.signal('test.wait', 'same', 'answer', { ok: true });
		expect(flows.get(owner, first.id).status).toBe('succeeded');
		const next = startIn('test.wait', 'same', { label: 'c' });
		expect(next.created).toBe(true);
		expect(next.id).not.toBe(first.id);
		expect(flows.idFor('test.wait', 'same')).toBe(next.id);
	});

	test('asynchronous handlers settle later', async () => {
		const started = startIn('test.async', 'a1', { value: 'yoal' });
		expect(flows.get(owner, started.id).status).toBe('running');
		await started.settled;
		expect(flows.get(owner, started.id)).toMatchObject({ status: 'succeeded', result: 'YOAL' });
		expect(trail).toContain('fetched:yoal');
	});

	test('rejects unknown kinds, steps and non-object input', () => {
		expect(() => startIn('test.nope', 'x', {})).toThrow(/Unknown flow/);
		expect(() => startIn('test.chain', 'x', { n: 1 }, { step: 'three' })).toThrow(/no step "three"/);
		expect(() => flows.start({ kind: 'test.chain', key: 'x', input: 5 as unknown as Record<string, unknown> })).toThrow(/JSON object/);
		expect(() => flows.register({ kind: 'test.chain', title: 'Dup', steps: { a: { run: () => flow.succeed() } } })).toThrow(/already registered/);
	});
});

describe('waiting for signals', () => {
	test('a signal resumes the run; an early signal is kept until the step waits for it', () => {
		const { id } = startIn('test.wait', 'w1', { label: 'w1' });
		expect(flows.get(owner, id)).toMatchObject({ status: 'waiting', waitingFor: 'answer', detail: 'Asking.' });
		expect(flows.get(owner, id).waitDeadline).toBe(new Date(clock + 60_000).toISOString());

		expect(flows.signal('test.wait', 'missing', 'answer', {})).toBe(false);
		// A signal the step does not wait for stays queued and is not delivered.
		flows.signal('test.wait', 'w1', 'other', {});
		expect(flows.get(owner, id).status).toBe('waiting');

		flows.signal('test.wait', 'w1', 'answer', { ignore: true });
		expect(flows.get(owner, id).status).toBe('waiting');
		flows.signal('test.wait', 'w1', 'answer', { ok: true });
		expect(flows.get(owner, id)).toMatchObject({ status: 'succeeded', result: 'answered' });
		// The ignored signal is logged and the run keeps its original wait and deadline.
		expect(events(id)).toEqual(['ask:started', 'ask:wait', 'ask:signal', 'done:next', 'done:succeeded']);
	});

	test('a step can end the run on a signal', () => {
		const { id } = startIn('test.wait', 'w2', { label: 'w2' });
		flows.signal('test.wait', 'w2', 'answer', { ok: false });
		expect(flows.get(owner, id)).toMatchObject({ status: 'failed', error: 'Answer was no.' });
		// A step that fails by itself has compensated already: no onFailure.
		expect(compensations.some((entry) => entry.startsWith('failure:w2'))).toBe(false);
	});

	test('timeouts run onTimeout, or fail by default, from drive()', () => {
		compensations = [];
		const handled = startIn('test.wait', 't1', { label: 't1' });
		const bare = startIn('test.wait', 't2', { label: 't2' }, { step: 'bare' });
		expect(flows.drive().processed).toBe(0);
		clock += 60_001;
		// Runs left waiting by earlier tests time out too.
		expect(flows.drive().processed).toBeGreaterThanOrEqual(2);
		expect(flows.get(owner, handled.id)).toMatchObject({ status: 'failed', error: 'Nobody answered.' });
		expect(flows.get(owner, bare.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Timed out waiting for never/) });
		expect(compensations).toContain('timeout:t1');
		expect(compensations).not.toContain('timeout:t2');
	});
});

describe('failures and recovery', () => {
	test('a throwing step retries with backoff, then fails and compensates', () => {
		compensations = [];
		flaky = 2; // fails twice, then succeeds
		const ok = startIn('test.flaky', 'f1', {});
		expect(flows.get(owner, ok.id)).toMatchObject({ status: 'queued', attempt: 1 });
		expect(flows.drive({ kind: 'test.flaky' }).processed).toBe(0);
		clock += flowRetryDelayMs(1);
		flows.drive({ kind: 'test.flaky' });
		expect(flows.get(owner, ok.id)).toMatchObject({ status: 'queued', attempt: 2 });
		clock += flowRetryDelayMs(2);
		flows.drive({ kind: 'test.flaky' });
		expect(flows.get(owner, ok.id).status).toBe('succeeded');
		expect(events(ok.id)).toEqual(['go:started', 'go:retry', 'go:retry', 'go:succeeded']);

		flaky = 10;
		const bad = startIn('test.flaky', 'f2', {});
		for (let attempt = 1; attempt < 3; attempt += 1) {
			clock += flowRetryDelayMs(attempt);
			flows.drive({ kind: 'test.flaky' });
		}
		expect(flows.get(owner, bad.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^boom/) });
		expect(compensations).toEqual([expect.stringMatching(/^flaky-failure:boom/)]);
	});

	test('a run whose process died mid-step is resumed by tick(), and fails after its attempts', () => {
		const { id } = startIn('test.wait', 'lease', { label: 'lease' });
		// Simulate a crash: the run is held by a dead worker's lease.
		opened.sqlite.run("UPDATE flow_runs SET status = 'running', lease_owner = 'cp-dead', lease_until = ? WHERE id = ?", [clock - 1, id]);
		expect(flows.tick()).toEqual({ resumed: 1, failed: 0 });
		expect(flows.get(owner, id)).toMatchObject({ status: 'waiting', attempt: 1, waitingFor: 'answer' });
		expect(events(id).at(-1)).toBe('ask:resumed');
		flows.signal('test.wait', 'lease', 'answer', { ok: true });
		expect(flows.get(owner, id).status).toBe('succeeded');

		compensations = [];
		const doomed = startIn('test.wait', 'doomed', { label: 'doomed' });
		opened.sqlite.run(
			"UPDATE flow_runs SET status = 'running', lease_owner = 'cp-dead', lease_until = ?, attempt = ? WHERE id = ?",
			[clock - 1, flowLimits.maxAttempts - 1, doomed.id],
		);
		expect(flows.tick()).toEqual({ resumed: 0, failed: 1 });
		expect(flows.get(owner, doomed.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) });
		expect(compensations).toEqual([expect.stringMatching(/^failure:doomed:/)]);
	});

	test('a run past its deadline fails and compensates', () => {
		compensations = [];
		const { id } = startIn('test.wait', 'late', { label: 'late' }, { deadlineAt: clock + 1_000 });
		clock += 1_001;
		flows.drive();
		expect(flows.get(owner, id)).toMatchObject({ status: 'failed', error: 'The run passed its deadline.' });
		expect(compensations).toEqual(['failure:late:The run passed its deadline.']);
	});

	test('a transition by a process that lost the lease is fenced out', () => {
		const { id } = startIn('test.wait', 'fence', { label: 'fence' });
		// Another process took the run over; this process's write must not land.
		opened.sqlite.run("UPDATE flow_runs SET status = 'running', lease_owner = 'cp-other', lease_until = ? WHERE id = ?", [clock + 60_000, id]);
		flows.signal('test.wait', 'fence', 'answer', { ok: true });
		expect(flows.get(owner, id)).toMatchObject({ status: 'running' });
	});
});

describe('cancelling', () => {
	test('a cancellable step cancels with compensation; others refuse', () => {
		compensations = [];
		const { id } = startIn('test.wait', 'c1', { label: 'c1' });
		expect(() => flows.cancel(viewer, id)).toThrow(/database:update/);
		expect(flows.cancel(owner, id)).toMatchObject({ status: 'cancelled', cancelRequested: false });
		expect(compensations).toEqual(['cancel:c1']);
		// Cancelling a cancelled run is idempotent.
		expect(flows.cancel(owner, id).status).toBe('cancelled');

		const bare = startIn('test.wait', 'c2', { label: 'c2' }, { step: 'bare' });
		expect(() => flows.cancel(owner, bare.id)).toThrow(/cannot be cancelled while it is in step "bare"/);
		expect(flows.get(owner, bare.id)).toMatchObject({ status: 'waiting', cancelRequested: false });

		const chain = startIn('test.chain', 'c3', { n: 1 });
		expect(() => flows.cancel(owner, chain.id)).toThrow(/cannot be cancelled/);
	});
});

describe('reading runs', () => {
	test('other orgs and missing permissions see nothing', () => {
		const { id } = startIn('test.wait', 'r1', { label: 'r1' });
		expect(flows.get(viewer, id).id).toBe(id);
		expect(() => flows.get(stranger, id)).toThrow(/not found/);
		const locked = startIn('test.wait', 'r2', { label: 'r2' }, { readPermission: 'database:update' });
		expect(() => flows.get(viewer, locked.id)).toThrow(/not found/);
		expect(flows.list(viewer, { kind: 'test.wait' }).map((run) => run.id)).not.toContain(locked.id);
		expect(flows.list(owner, { kind: 'test.wait', status: 'waiting' }).map((run) => run.id)).toEqual(
			expect.arrayContaining([id, locked.id]),
		);
		expect(flows.list(stranger)).toEqual([]);
	});

	test('wait() resolves on the next transition, or on its timeout', async () => {
		const { id } = startIn('test.wait', 'wait1', { label: 'wait1' });
		const pending = flows.wait(owner, id, 5_000);
		setTimeout(() => flows.signal('test.wait', 'wait1', 'answer', { ok: true }), 10);
		expect((await pending).status).toBe('succeeded');
		const idle = startIn('test.wait', 'wait2', { label: 'wait2' });
		const started = Date.now();
		expect((await flows.wait(owner, idle.id, 50)).status).toBe('waiting');
		expect(Date.now() - started).toBeLessThan(1_500);
	});

	test('events() streams progress and ends with done', async () => {
		const { id } = startIn('test.wait', 'ev', { label: 'ev' });
		const seen: string[] = [];
		setTimeout(() => flows.signal('test.wait', 'ev', 'answer', { ok: true }), 10);
		for await (const event of flows.events(owner, id)) seen.push(`${event.type}:${event.flow.status}`);
		expect(seen).toEqual(['progress:waiting', 'done:succeeded']);
	});

	test('prune() drops finished runs after the retention window', () => {
		const before = flows.list(owner, { status: 'succeeded', limit: 200 }).length;
		expect(before).toBeGreaterThan(0);
		clock += flowLimits.retentionDays * 86_400_000 + 1;
		expect(flows.prune()).toBeGreaterThanOrEqual(before);
		expect(flows.list(owner, { status: 'succeeded', limit: 200 })).toEqual([]);
		expect(opened.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM flow_steps WHERE run_id NOT IN (SELECT id FROM flow_runs)").get()!.n).toBe(0);
	});
});
