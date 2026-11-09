import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { CoreContext } from './context.ts';
import { createCore, DEFAULT_LEASE_MS, nextRun, retryDelayMs, SchedulerService } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-scheduler-'));
const dbPath = join(dir, 'yoal.db');
const opened = createDb({ path: dbPath });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const base = Date.parse('2026-11-05T10:00:00Z');
let clock = base;

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
	},
});

const count = (): number =>
	opened.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM scheduled_tasks').get()!.n;

beforeEach(() => {
	clock = base;
	opened.sqlite.run('DELETE FROM scheduled_tasks');
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('scheduler', () => {
	test('enqueue is idempotent by kind + key while a task is active', () => {
		const first = core.scheduler.enqueue({
			kind: 'test',
			key: 'one',
			runAt: clock,
			payload: { value: 1 },
		});
		const second = core.scheduler.enqueue({
			kind: 'test',
			key: 'one',
			runAt: clock + 60_000,
			payload: { value: 2 },
		});

		expect(second).toBe(first);
		expect(count()).toBe(1);
		expect(core.scheduler.getByKey('test', 'one')).toMatchObject({
			id: first,
			status: 'queued',
			runAt: clock,
			attempts: 0,
			payloadJson: '{"value":1}',
		});

		// The same key under another kind is a different task.
		const other = core.scheduler.enqueue({ kind: 'other', key: 'one', runAt: clock });
		expect(other).not.toBe(first);
		expect(count()).toBe(2);
	});

	test('claim leases only due tasks and increments attempts', () => {
		core.scheduler.enqueue({ kind: 'test', key: 'later', runAt: clock + 1 });
		const due = core.scheduler.enqueue({ kind: 'test', key: 'due', runAt: clock, payload: { n: 1 } });

		const claimed = core.scheduler.claim('worker-1', 10, clock);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({
			id: due,
			key: 'due',
			status: 'leased',
			attempts: 1,
			leaseUntil: clock + DEFAULT_LEASE_MS,
			workerId: 'worker-1',
		});
		// No worker can claim it again before the lease expires.
		expect(core.scheduler.claim('worker-2', 10, clock)).toHaveLength(0);
		expect(core.scheduler.get(due)?.status).toBe('leased');
	});

	test('concurrent claims cannot lease the same task', () => {
		core.scheduler.enqueue({ kind: 'test', key: 'only', runAt: clock });
		// A second connection to the same SQLite file, as another control plane would have.
		const other = createDb({ path: dbPath });
		const second = new SchedulerService({
			db: other.db,
			sqlite: other.sqlite,
			now: () => clock,
		} as unknown as CoreContext);
		try {
			const first = core.scheduler.claim('worker-1', 1, clock);
			const again = second.claim('worker-2', 1, clock);
			expect(first).toHaveLength(1);
			expect(again).toHaveLength(0);
			expect(core.scheduler.get(first[0]!.id)).toMatchObject({ status: 'leased', attempts: 1 });
		} finally {
			other.sqlite.close();
		}
	});

	test('tick expires a stale lease, requeues it and is idempotent', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'crash', runAt: clock });
		core.scheduler.claim('worker-1', 1, clock, 1_000);

		clock = base + 1_001;
		expect(core.scheduler.tick()).toEqual({ expired: 1, requeued: 1, failed: 0 });
		expect(core.scheduler.get(id)).toMatchObject({
			status: 'queued',
			attempts: 1,
			leaseUntil: null,
			runAt: clock,
			lastError: 'Lease expired before completion',
		});

		// Nothing is leased now, so a second sweep changes nothing.
		expect(core.scheduler.tick()).toEqual({ expired: 0, requeued: 0, failed: 0 });

		const reclaimed = core.scheduler.claim('worker-2', 1, clock);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]).toMatchObject({ id, attempts: 2 });
	});

	test('failed attempts retry with exponential backoff', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'retry', runAt: clock });
		core.scheduler.claim('worker-1', 1, clock);
		expect(core.scheduler.fail(id, 'boom')).toBe(true);

		let task = core.scheduler.get(id)!;
		expect(task).toMatchObject({ status: 'queued', attempts: 1, lastError: 'boom' });
		expect(task.runAt).toBe(clock + retryDelayMs(1));
		expect(core.scheduler.claim('worker-1', 1, clock + retryDelayMs(1) - 1)).toHaveLength(0);

		clock += retryDelayMs(1);
		const retried = core.scheduler.claim('worker-1', 1, clock);
		expect(retried[0]).toMatchObject({ id, attempts: 2 });
		core.scheduler.fail(id, 'boom again');
		task = core.scheduler.get(id)!;
		expect(task.status).toBe('queued');
		expect(task.runAt).toBe(clock + retryDelayMs(2));
		expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
	});

	test('max attempts is a hard cap', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'cap', runAt: clock, maxAttempts: 2 });
		core.scheduler.claim('worker-1', 1, clock);
		core.scheduler.fail(id, 'first failure');
		clock += retryDelayMs(1);
		core.scheduler.claim('worker-1', 1, clock);
		expect(core.scheduler.fail(id, 'second failure')).toBe(true);

		expect(core.scheduler.get(id)).toMatchObject({
			status: 'failed',
			attempts: 2,
			leaseUntil: null,
			lastError: 'second failure',
		});
		expect(core.scheduler.fail(id, 'too late')).toBe(false);
		expect(core.scheduler.claim('worker-1', 1, clock + 86_400_000)).toHaveLength(0);
	});

	test('a lease expiry at the attempt cap fails the task', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'expire-cap', runAt: clock, maxAttempts: 1 });
		core.scheduler.claim('worker-1', 1, clock, 1_000);
		clock = base + 1_001;
		expect(core.scheduler.tick()).toEqual({ expired: 1, requeued: 0, failed: 1 });
		expect(core.scheduler.get(id)).toMatchObject({ status: 'failed', attempts: 1 });
	});

	test('complete records the result and re-enqueueing re-arms the key', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'recurring', runAt: clock, payload: { run: 1 } });
		core.scheduler.claim('worker-1', 1, clock);
		expect(core.scheduler.complete(id, '{"ok":true}')).toBe(true);
		expect(core.scheduler.get(id)).toMatchObject({
			status: 'ok',
			resultJson: '{"ok":true}',
			leaseUntil: null,
		});
		expect(core.scheduler.complete(id)).toBe(false);

		clock += 60_000;
		const rearmed = core.scheduler.enqueue({
			kind: 'test',
			key: 'recurring',
			runAt: clock,
			payload: { run: 2 },
		});
		expect(rearmed).toBe(id);
		expect(core.scheduler.get(id)).toMatchObject({
			status: 'queued',
			runAt: clock,
			attempts: 0,
			resultJson: null,
			payloadJson: '{"run":2}',
		});
	});

	test('cancel is idempotent and stops claims', () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'cancel', runAt: clock });
		expect(core.scheduler.cancel(id)).toBe(true);
		expect(core.scheduler.cancel(id)).toBe(true);
		expect(core.scheduler.get(id)?.status).toBe('cancelled');
		expect(core.scheduler.claim('worker-1', 1, clock)).toHaveLength(0);
		expect(core.scheduler.complete(id)).toBe(false);
	});

	test('cron next-run feeds enqueue and claim', () => {
		const from = Date.parse('2026-11-05T10:04:30Z');
		clock = from;
		expect(new Date(nextRun('*/15 * * * *', from)!).toISOString()).toBe('2026-11-05T10:15:00.000Z');
		expect(nextRun('0 0 31 2 *', from)).toBeNull();

		const runAt = core.scheduler.nextRun('0 3 * * *')!;
		expect(new Date(runAt).toISOString()).toBe('2026-11-06T03:00:00.000Z');
		const id = core.scheduler.enqueue({ kind: 'cron', key: 'daily-report', runAt });
		expect(core.scheduler.claim('worker-1', 1, from)).toHaveLength(0);

		clock = runAt;
		const claimed = core.scheduler.claim('worker-1', 1, clock);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({ id, key: 'daily-report', attempts: 1 });
	});

	test('the 60 s maintenance sweep calls tick', async () => {
		const id = core.scheduler.enqueue({ kind: 'test', key: 'maintenance', runAt: clock });
		core.scheduler.claim('worker-1', 1, clock, 1_000);
		clock = base + 1_001;

		await core.maintenance.run();

		expect(core.scheduler.get(id)).toMatchObject({ status: 'queued', attempts: 1 });
	});
});
