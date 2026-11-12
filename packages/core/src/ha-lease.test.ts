import { describe, expect, test } from 'bun:test';
import { ControlLease, ControlLeaseError, MemoryConditionalStore } from './ha-lease.ts';

/** One simulated clock for the store and every node; `skew` offsets a node's wall clock only. */
function world() {
	let now = 1_000_000;
	const store = new MemoryConditionalStore(() => now);
	const node = (nodeId: string, skew = 0) => {
		const view = store.view();
		const lease = new ControlLease({ store: view, nodeId, monotonic: () => now, wallClock: () => now + skew });
		return { lease, view };
	};
	return {
		store,
		node,
		advance(ms: number) {
			now += ms;
		},
		get now() {
			return now;
		},
	};
}

describe('ControlLease (CLUSTERING §6.3)', () => {
	test('bootstrap makes the current control plane primary at the given epoch', async () => {
		const w = world();
		const a = w.node('a');
		expect((await a.lease.bootstrap(3)).role).toBe('primary');
		expect(a.lease.holds()).toBe(true);
		expect(w.store.peek()).toMatchObject({ epoch: 3, holderNodeId: 'a', expiresAt: w.now + 30_000 });
		// A second bootstrap from another node is refused, not a takeover.
		await expect(w.node('b').lease.bootstrap()).rejects.toThrow(ControlLeaseError);
	});

	test('a standby follows a renewing primary and never takes over', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		for (let i = 0; i < 30; i++) {
			w.advance(5_000);
			await a.lease.tick();
			expect((await b.lease.tick({ mayTakeOver: true })).role).toBe('standby');
		}
		expect(a.lease.status()).toMatchObject({ role: 'primary', epoch: 1 });
	});

	test('a dead primary is replaced only after expiry and 40 s of an unchanged object', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		await b.lease.tick({ mayTakeOver: true });
		// a stops renewing (crashed). Expired at +30 s, but b has watched only that long.
		w.advance(35_000);
		expect((await b.lease.tick({ mayTakeOver: true })).role).toBe('standby');
		w.advance(5_000);
		const status = await b.lease.tick({ mayTakeOver: true });
		expect(status).toMatchObject({ role: 'primary', epoch: 2, holderNodeId: 'b' });
		expect(b.lease.holds()).toBe(true);
	});

	test('without the promotion gate a standby never takes over', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		await b.lease.tick();
		w.advance(120_000);
		expect((await b.lease.tick({ mayTakeOver: false })).role).toBe('standby');
	});

	test('a primary cut off from the store fences at 20 s, before any takeover is possible', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		await b.lease.tick({ mayTakeOver: true });
		a.view.partitioned = true;
		let fencedAt: number | null = null;
		let takenAt: number | null = null;
		for (let t = 0; t <= 60_000; t += 1_000) {
			w.advance(1_000);
			const sa = await a.lease.tick();
			const sb = await b.lease.tick({ mayTakeOver: true });
			if (sa.role === 'fenced' && fencedAt === null) fencedAt = t;
			if (sb.role === 'primary' && takenAt === null) takenAt = t;
			// I1: never two writers at one instant.
			expect(a.lease.holds() && b.lease.holds()).toBe(false);
		}
		expect(fencedAt).not.toBeNull();
		expect(takenAt).not.toBeNull();
		expect(fencedAt!).toBeLessThan(20_000);
		expect(takenAt!).toBeGreaterThanOrEqual(40_000 - 1_000);
		expect(takenAt! - fencedAt!).toBeGreaterThanOrEqual(15_000);
	});

	test('a stale primary that comes back is fenced and never resumes', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		await b.lease.tick({ mayTakeOver: true });
		a.view.partitioned = true;
		for (let i = 0; i < 9; i++) {
			w.advance(5_000);
			await a.lease.tick();
			await b.lease.tick({ mayTakeOver: true });
		}
		expect(b.lease.status().role).toBe('primary');
		a.view.partitioned = false;
		expect((await a.lease.tick()).role).toBe('fenced');
		w.advance(120_000);
		expect((await a.lease.tick({ mayTakeOver: true })).role).toBe('fenced');
		expect(a.lease.holds()).toBe(false);
		expect(w.store.peek()).toMatchObject({ holderNodeId: 'b', epoch: 2 });
	});

	test('a short store outage does not fence the primary', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap();
		a.view.partitioned = true;
		for (let i = 0; i < 3; i++) {
			w.advance(5_000);
			await a.lease.tick();
		}
		expect(a.lease.status().role).toBe('primary');
		a.view.partitioned = false;
		w.advance(4_000);
		expect((await a.lease.tick()).role).toBe('primary');
		expect(a.lease.holds()).toBe(true);
	});

	test('holds() lapses when the primary stops ticking, even with no reply to judge', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap();
		w.advance(19_999);
		expect(a.lease.holds()).toBe(true);
		w.advance(1);
		expect(a.lease.holds()).toBe(false);
	});

	test('two standbys racing for an expired lease: exactly one wins', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		const c = w.node('c');
		await a.lease.bootstrap();
		await b.lease.tick({ mayTakeOver: true });
		await c.lease.tick({ mayTakeOver: true });
		w.advance(45_000);
		const [sb, sc] = await Promise.all([b.lease.tick({ mayTakeOver: true }), c.lease.tick({ mayTakeOver: true })]);
		expect([sb.role, sc.role].filter((role) => role === 'primary')).toHaveLength(1);
		expect(w.store.peek()?.epoch).toBe(2);
	});

	test('a released lease is taken at once, at the next epoch', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		await b.lease.tick({ mayTakeOver: true });
		w.advance(1_000);
		expect((await a.lease.release()).role).toBe('standby');
		expect(a.lease.holds()).toBe(false);
		w.advance(1_000);
		expect(await b.lease.tick({ mayTakeOver: true })).toMatchObject({ role: 'primary', epoch: 2 });
		w.advance(5_000);
		expect((await a.lease.tick()).role).toBe('standby');
	});

	test('a restarted primary continues its unexpired term; an expired one is followed', async () => {
		const w = world();
		await w.node('a').lease.bootstrap();
		w.advance(10_000);
		const restarted = w.node('a');
		expect(await restarted.lease.tick()).toMatchObject({ role: 'primary', epoch: 1 });
		w.advance(60_000);
		const late = w.node('a');
		expect((await late.lease.tick()).role).toBe('standby');
	});

	test('force promote takes an unexpired lease (break-glass) with a CAS', async () => {
		const w = world();
		const a = w.node('a');
		const b = w.node('b');
		await a.lease.bootstrap();
		expect(await b.lease.forcePromote()).toMatchObject({ role: 'primary', epoch: 2 });
		w.advance(1_000);
		expect((await a.lease.tick()).role).toBe('fenced');
	});

	test('a store without conditional writes fails closed', async () => {
		const w = world();
		const a = w.node('a');
		// The read works; the conditional PUT is not implemented.
		a.view.writeConditional = async () => ({ status: 501, etag: null, serverDate: w.now });
		await expect(a.lease.bootstrap()).rejects.toThrow();
		expect(a.lease.status().role).toBe('unavailable');
		const b = w.node('b');
		await b.lease.bootstrap();
		w.store.dropEtag = true;
		w.advance(5_000);
		const status = await b.lease.tick();
		expect(status.role).toBe('primary');
		expect(status.reason).toMatch(/ETag/);
		w.advance(20_000);
		expect((await b.lease.tick()).role).toBe('fenced');
	});

	test('a lost renewal (409/412) fences immediately', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap();
		w.store.failNext = { status: 503, count: 0 };
		// Another writer replaces the object between a's read and write.
		const view = a.view;
		const realWrite = view.writeConditional.bind(view);
		view.writeConditional = async (key: string, body: string, condition: Parameters<typeof realWrite>[2]) => {
			await w.store.writeConditional(key, JSON.stringify({ epoch: 9, holderNodeId: 'x', expiresAt: w.now + 30_000 }), {
				ifMatch: (await w.store.readVersioned(key)).etag!,
			});
			return realWrite(key, body, condition);
		};
		w.advance(5_000);
		expect((await a.lease.tick()).role).toBe('fenced');
	});

	test('reports clock skew against the store', async () => {
		const w = world();
		const a = w.node('a', 7_000);
		await a.lease.bootstrap();
		expect(a.lease.status()).toMatchObject({ skewMs: 7_000, skewExceeded: true });
	});

	test('refuses timings that would let two primaries overlap', () => {
		const store = new MemoryConditionalStore();
		expect(() => new ControlLease({ store, nodeId: 'a', policy: { ttlMs: 30_000, fenceAfterMs: 30_000 } })).toThrow();
		expect(() => new ControlLease({ store, nodeId: 'a', policy: { ttlMs: 30_000, takeoverAfterMs: 30_000 } })).toThrow();
	});

	test('randomised partitions never produce two writers (I1) and the epoch only rises (I2)', async () => {
		let seed = 42;
		const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
		for (let run = 0; run < 20; run++) {
			const w = world();
			const nodes = ['a', 'b', 'c'].map((id) => w.node(id));
			await nodes[0]!.lease.bootstrap();
			let lastEpoch = 1;
			for (let step = 0; step < 400; step++) {
				w.advance(1_000 + Math.floor(random() * 4_000));
				for (const node of nodes) if (random() < 0.05) node.view.partitioned = !node.view.partitioned;
				for (const node of nodes) {
					if (random() < 0.1) continue; // a stalled tick
					await node.lease.tick({ mayTakeOver: true });
				}
				// Fenced nodes are re-seeded by an operator now and then.
				for (const node of nodes) if (node.lease.status().role === 'fenced' && random() < 0.05) node.lease.resetAfterReseed();
				expect(nodes.filter((node) => node.lease.holds()).length).toBeLessThanOrEqual(1);
				const epoch = w.store.peek()?.epoch ?? 0;
				expect(epoch).toBeGreaterThanOrEqual(lastEpoch);
				lastEpoch = epoch;
			}
		}
	});
});
