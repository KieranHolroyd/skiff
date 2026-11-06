import { describe, expect, test } from 'bun:test';
import { ControlPlaneLease, MemoryLeaseStore } from './lease.ts';

const policy = { ttlMs: 30_000, renewBeforeMs: 5_000 };

describe('control-plane lease', () => {
	test('one writer wins the initial lease', async () => {
		const store = new MemoryLeaseStore();
		const a = new ControlPlaneLease(store, 'a', policy);
		const b = new ControlPlaneLease(store, 'b', policy);
		expect((await a.acquire(0)).state).toBe('holder');
		expect((await b.acquire(0)).state).toBe('standby');
	});

	test('renews a held lease and fences on a lost CAS', async () => {
		const store = new MemoryLeaseStore();
		const a = new ControlPlaneLease(store, 'a', policy);
		await a.acquire(0);
		expect((await a.acquire(26_000)).state).toBe('holder');
		const current = await store.read();
		await store.compareAndSwap(current!.version, { epoch: 2, holderNodeId: 'b', expiresAt: 90_000 });
		expect((await a.acquire(27_000)).state).toBe('standby');
	});

	test('takes over an expired lease at the next epoch', async () => {
		const store = new MemoryLeaseStore();
		const a = new ControlPlaneLease(store, 'a', policy);
		await a.acquire(0);
		const b = new ControlPlaneLease(store, 'b', policy);
		const decision = await b.acquire(30_001);
		expect(decision).toMatchObject({ state: 'holder', record: { epoch: 2, holderNodeId: 'b' } });
	});

	test('release expires the lease for the next holder', async () => {
		const store = new MemoryLeaseStore();
		const a = new ControlPlaneLease(store, 'a', policy);
		await a.acquire(0);
		await a.release();
		const b = new ControlPlaneLease(store, 'b', policy);
		expect((await b.acquire(1)).state).toBe('holder');
	});
});
