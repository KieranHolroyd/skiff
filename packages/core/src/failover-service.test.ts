import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, databaseReplicas, databases } from '@yoal/db';
import { DEFAULT_FEATURES, type FailoverPlan } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import {
	FAILOVER_LEASE_KEY,
	FailoverService,
	startFailoverLoop,
	walkFailoverStages,
	type FailoverFence,
	type FailoverHandlerStage,
	type FailoverStageOutcome,
} from './failover-service.ts';

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-07T12:00:00Z');
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

interface Harness {
	core: Core;
	sqlite: ReturnType<typeof createDb>['sqlite'];
	clock: { now: number };
	node: Record<'edge' | 'w1' | 'w2' | 'w3' | 'w4', string>;
	advance(ms: number): void;
	/** Every node but `silent` heartbeats now. */
	heartbeat(...silent: string[]): void;
	app(slug: string, replicas: number, nodes: string[]): Promise<string[]>;
	copies(): Array<{ id: string; nodeId: string; status: string; replicaIndex: number; workloadId: string }>;
	events(kind?: string): Array<{ status: string; stage: string; subject_id: string; to_node_id: string | null; reason: string; epoch: number }>;
}

function harness(workers = ['w1', 'w2', 'w3', 'w4'], failover: Record<string, unknown> = { enabled: true }): Harness {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-failover-'));
	dirs.push(dir);
	const opened = createDb({ path: ':memory:' });
	const clock = { now: T0 };
	const core = createCore({
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
			now: () => clock.now,
			features: { ...DEFAULT_FEATURES, MULTI_NODE_REPLICAS: true, SERVICE_ENDPOINTS: false },
		},
	});
	const node: Record<string, string> = {};
	for (const name of ['edge', ...workers]) {
		core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = opened.sqlite.query<{ id: string }, [string]>('SELECT id FROM nodes WHERE name = ?').get(name)!.id;
	}
	core.cluster.update(principal, { failover });
	const h: Harness = {
		core,
		sqlite: opened.sqlite,
		clock,
		node: node as Harness['node'],
		advance: (ms) => {
			clock.now += ms;
		},
		heartbeat: (...silent) => {
			for (const [name, id] of Object.entries(node))
				if (!silent.includes(name))
					opened.sqlite.run("UPDATE nodes SET last_heartbeat_at = ?, status = CASE status WHEN 'draining' THEN 'draining' ELSE 'online' END WHERE id = ?", [clock.now, id]);
		},
		app: async (slug, replicas, nodes) => {
			const project = await core.projects.create(principal, {
				name: slug,
				slug,
				runtime: 'process',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			const row = core.projects.requireRow(principal, project.slug);
			const resolved = core.workloads.plan(principal, row, { replicas, ingress: 'http' });
			core.workloads.record(row, `dep_${slug}`, resolved);
			const ids = opened.sqlite
				.query<{ id: string }, [string]>(
					'SELECT r.id FROM workload_replicas r JOIN workloads w ON w.id = r.workload_id WHERE w.project_id = ? ORDER BY r.replica_index',
				)
				.all(row.id)
				.map((copy) => copy.id);
			ids.forEach((id, index) =>
				opened.sqlite.run("UPDATE workload_replicas SET node_id = ?, status = 'running' WHERE id = ?", [node[nodes[index]!]!, id]),
			);
			return ids;
		},
		copies: () =>
			opened.sqlite
				.query<{ id: string; nodeId: string; status: string; replicaIndex: number; workloadId: string }, []>(
					'SELECT id, node_id AS nodeId, status, replica_index AS replicaIndex, workload_id AS workloadId FROM workload_replicas',
				)
				.all(),
		events: (kind) =>
			opened.sqlite
				.query<{ status: string; stage: string; subject_id: string; to_node_id: string | null; reason: string; epoch: number }, []>(
					`SELECT status, stage, subject_id, to_node_id, reason, epoch FROM failover_events ${kind ? `WHERE kind = '${kind}'` : ''} ORDER BY detected_at, rowid`,
				)
				.all(),
	};
	h.heartbeat();
	return h;
}

const nodeOf = (h: Harness, copyId: string) => h.copies().find((copy) => copy.id === copyId)!.nodeId;

describe('failover controller lease', () => {
	test('one controller holds the lease; another takes over only after the TTL, at the next epoch', async () => {
		const h = harness([]);
		const a = h.core.failover;
		const b = new FailoverService(h.core.ctx, { holderId: 'standby-b' });
		expect((await a.tick()).lease).toBe('holder');
		expect((await b.tick()).lease).toBe('standby');

		// A stops ticking (crashed or paused). B waits the whole TTL (30 s by default).
		h.advance(29_000);
		expect((await b.tick()).lease).toBe('standby');
		h.advance(1_001);
		const takeover = await b.tick();
		expect(takeover).toMatchObject({ lease: 'holder', epoch: 2 });

		// A wakes up: it is deposed, records the loss and pages.
		expect((await a.tick()).lease).toBe('standby');
		const lease = h.events('lease');
		expect(lease.map((event) => event.status)).toEqual(['completed', 'completed', 'failed']);
		expect(lease.at(-1)!.reason).toContain('standby-b');
		expect(a.status(principal).lease).toMatchObject({ state: 'standby', holderId: 'standby-b', self: false, epoch: 2 });
	});

	test('the holder renews on every tick, so it never lapses while it runs', async () => {
		const h = harness([]);
		h.core.cluster.update(principal, { controlPlane: { leaseTtlSeconds: 30, renewSeconds: 5 } });
		expect(h.core.failover.intervalMs()).toBe(5_000);
		expect(h.core.failover.leasePolicy()).toEqual({ ttlMs: 30_000, renewBeforeMs: 25_000 });
		await h.core.failover.tick();
		const read = () => JSON.parse(h.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(FAILOVER_LEASE_KEY)!.value);
		const first = read();
		h.advance(4_000);
		await h.core.failover.tick();
		expect(read().version).toBe(first.version);
		h.advance(1_000);
		await h.core.failover.tick();
		expect(read().record.expiresAt).toBe(h.clock.now + 30_000);
		expect(read().record.epoch).toBe(1);
	});

	test('a renew interval longer than the TTL is capped to a third of it', () => {
		const h = harness([]);
		h.core.cluster.update(principal, { controlPlane: { leaseTtlSeconds: 6, renewSeconds: 60 } });
		expect(h.core.failover.intervalMs()).toBe(2_000);
		expect(h.core.failover.leasePolicy().renewBeforeMs).toBe(4_000);
	});

	test('only a platform admin reads status and history', () => {
		const h = harness([]);
		const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });
		expect(() => h.core.failover.status(member)).toThrow(/platform admin/);
		expect(() => h.core.failover.history(member)).toThrow(/platform admin/);
	});
});

describe('controller loop', () => {
	test('ticks, waits the configured interval, keeps going after an error, and releases on stop', async () => {
		const h = harness([]);
		h.core.cluster.update(principal, { controlPlane: { leaseTtlSeconds: 30, renewSeconds: 3 } });
		const queue: Array<{ run: () => void; ms: number }> = [];
		const errors: unknown[] = [];
		const service = h.core.failover;
		const tick = service.tick.bind(service);
		let calls = 0;
		service.tick = async () => {
			calls += 1;
			if (calls === 2) throw new Error('boom');
			return tick();
		};
		const stop = startFailoverLoop(service, {
			schedule: (run, ms) => {
				queue.push({ run, ms });
				return { cancel: () => queue.splice(queue.findIndex((item) => item.run === run), 1) };
			},
			onError: (error) => errors.push(error),
		});
		const step = async () => {
			queue.shift()!.run();
			await new Promise((resolve) => setTimeout(resolve, 0));
		};
		expect(queue.map((item) => item.ms)).toEqual([0]);
		await step();
		expect(calls).toBe(1);
		expect(queue.map((item) => item.ms)).toEqual([3_000]);
		expect(service.status(principal).lease.state).toBe('holder');
		await step();
		expect(errors).toHaveLength(1);
		expect(queue).toHaveLength(1);
		await stop();
		expect(queue).toHaveLength(0);
		// Released: another controller takes over at once, not after the TTL.
		expect((await new FailoverService(h.core.ctx, { holderId: 'next' }).tick()).lease).toBe('holder');
		service.tick = tick;
	});
});

describe('replica re-placement', () => {
	test('copies on a lost node wait for the grace, then move once, with an audit row', async () => {
		const h = harness();
		const [first, second] = await h.app('web', 2, ['w1', 'w2']);
		await h.core.failover.tick();

		// w1 goes silent: nothing moves before `replicas.failoverGraceSeconds` (120 s).
		h.advance(119_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).moved).toBe(0);
		h.advance(1_000);
		h.heartbeat('w1');
		const report = await h.core.failover.tick();
		expect(report.moved).toBe(1);
		const target = nodeOf(h, first!);
		expect([h.node.w3, h.node.w4]).toContain(target);
		expect(nodeOf(h, second!)).toBe(h.node.w2);
		expect(h.events('replica')).toMatchObject([{ status: 'in-progress', stage: 'promote', to_node_id: target, epoch: 1 }]);
		const audit = h.sqlite
			.query<{ action: string; actor_type: string; args_json: string }, []>("SELECT action, actor_type, args_json FROM audit_log WHERE action = 'ha.failover'")
			.all();
		expect(audit).toHaveLength(1);
		expect(audit[0]!.actor_type).toBe('system');
		expect(JSON.parse(audit[0]!.args_json)).toMatchObject({ from: h.node.w1, to: target, epoch: 1, reason: 'failover' });

		// The move completes when the new node reports the copy running.
		h.sqlite.run("UPDATE workload_replicas SET status = 'running' WHERE id = ?", [first!]);
		h.advance(5_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).completed).toBe(1);
		expect(h.events('replica')).toMatchObject([{ status: 'completed', stage: 'complete' }]);
		// No automatic move back when w1 returns.
		h.advance(5_000);
		h.heartbeat();
		await h.core.failover.tick();
		expect(nodeOf(h, first!)).toBe(target);
	});

	test('with failover off a lost node keeps its copies, but a drain still moves them', async () => {
		const h = harness(['w1', 'w2', 'w3'], { enabled: false });
		const [first] = await h.app('web', 2, ['w1', 'w2']);
		h.advance(300_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).moved).toBe(0);
		expect(nodeOf(h, first!)).toBe(h.node.w1);
		expect(h.core.failover.status(principal).nodes.find((node) => node.id === h.node.w1)).toMatchObject({ lost: true, copies: 1, replicaFailoverAt: null });

		h.heartbeat();
		h.sqlite.run("UPDATE nodes SET status = 'draining' WHERE id = ?", [h.node.w2]);
		const drained = await h.core.failover.tick();
		expect(drained.moved).toBe(1);
		expect(h.copies().every((copy) => copy.nodeId !== h.node.w2)).toBe(true);
	});

	test('a waiting move is cancelled when the node comes back first', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		const [first] = await h.app('web', 2, ['w1', 'w2']);
		h.advance(130_000);
		h.heartbeat('w1');
		// Only w2 is left and it holds the other copy: blocked.
		expect((await h.core.failover.tick()).blocked).toBe(1);
		expect(h.events('replica')).toMatchObject([{ status: 'blocked' }]);
		h.heartbeat();
		await h.core.failover.tick();
		expect(h.events('replica')).toMatchObject([{ status: 'cancelled' }]);
		expect(nodeOf(h, first!)).toBe(h.node.w1);
	});

	test('a move that cannot be placed expires after 10 minutes', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		await h.app('web', 2, ['w1', 'w2']);
		h.advance(130_000);
		h.heartbeat('w1');
		await h.core.failover.tick();
		h.advance(10 * 60_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).expired).toBe(1);
		expect(h.events('replica')).toMatchObject([{ status: 'expired' }]);
		const alerts = h.sqlite.query<{ key: string }, []>("SELECT key FROM alert_state WHERE key LIKE 'failover:%'").all();
		expect(alerts.length).toBeGreaterThan(0);
	});
});

describe('rate limits', () => {
	test('the fleet-wide cap queues the rest until the next minute', async () => {
		const h = harness(['w1', 'w2', 'w3', 'w4'], { enabled: true, maxPerMinute: 1 });
		const [a] = await h.app('alpha', 2, ['w1', 'w2']);
		const [b] = await h.app('bravo', 2, ['w1', 'w3']);
		h.advance(130_000);
		h.heartbeat('w1');
		const report = await h.core.failover.tick();
		expect(report).toMatchObject({ moved: 1, queued: 1 });
		expect(h.events('replica').map((event) => event.status).sort()).toEqual(['in-progress', 'queued']);
		h.advance(30_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).moved).toBe(0);
		h.advance(31_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).moved).toBe(1);
		expect(nodeOf(h, a!)).not.toBe(h.node.w1);
		expect(nodeOf(h, b!)).not.toBe(h.node.w1);
	});

	test('a target takes at most two moves a minute; the third waits rather than blocks', async () => {
		const h = harness(['w1', 'w2', 'w3'], { enabled: true });
		const copies = [
			...(await h.app('alpha', 2, ['w1', 'w2'])),
			...(await h.app('bravo', 2, ['w1', 'w2'])),
			...(await h.app('charlie', 2, ['w1', 'w2'])),
		];
		h.sqlite.run('UPDATE nodes SET slice_memory_mb = 8192');
		h.advance(130_000);
		h.heartbeat('w1');
		const report = await h.core.failover.tick();
		expect(report).toMatchObject({ moved: 2, queued: 1, blocked: 0 });
		expect(h.events('replica').find((event) => event.status === 'queued')!.reason).toContain('per-target rate limit');
		h.advance(61_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).moved).toBe(1);
		expect(copies.filter((id) => nodeOf(h, id) === h.node.w3)).toHaveLength(3);
	});

	test('one move in flight per workload', async () => {
		const h = harness(['w1', 'w2', 'w3', 'w4'], { enabled: true });
		const [first, second] = await h.app('web', 2, ['w1', 'w2']);
		h.advance(130_000);
		h.heartbeat('w1', 'w2');
		const report = await h.core.failover.tick();
		expect(report).toMatchObject({ moved: 1, queued: 1 });
		// Lowest index first.
		expect(nodeOf(h, first!)).not.toBe(h.node.w1);
		expect(nodeOf(h, second!)).toBe(h.node.w2);
		h.sqlite.run("UPDATE workload_replicas SET status = 'running' WHERE id = ?", [first!]);
		h.advance(5_000);
		h.heartbeat('w1', 'w2');
		const next = await h.core.failover.tick();
		expect(next).toMatchObject({ completed: 1, moved: 1 });
		expect(new Set(h.copies().map((copy) => copy.nodeId))).toEqual(new Set([h.node.w3, h.node.w4]));
	});
});

describe('flap protection', () => {
	test('a node that was a failover source in the last 30 minutes is never a target', async () => {
		const h = harness(['w1', 'w2', 'w3'], { enabled: true });
		const [a] = await h.app('alpha', 2, ['w3', 'w2']);
		// w3 is lost, its copy moves to w1.
		h.advance(130_000);
		h.heartbeat('w3');
		await h.core.failover.tick();
		expect(nodeOf(h, a!)).toBe(h.node.w1);
		h.sqlite.run("UPDATE workload_replicas SET status = 'running' WHERE id = ?", [a!]);
		// w3 comes back, then w1 is lost ten minutes later: w3 is the only free node but still flapping.
		h.advance(10 * 60_000);
		h.heartbeat();
		await h.core.failover.tick();
		h.advance(130_000);
		h.heartbeat('w1');
		const report = await h.core.failover.tick();
		expect(report).toMatchObject({ moved: 0, blocked: 1 });
		expect(nodeOf(h, a!)).toBe(h.node.w1);
		// After the window it is admissible again.
		h.advance(20 * 60_000);
		h.heartbeat('w1');
		h.sqlite.run("UPDATE failover_events SET detected_at = ? WHERE status = 'blocked'", [h.clock.now]);
		expect((await h.core.failover.tick()).moved).toBe(1);
		expect(nodeOf(h, a!)).toBe(h.node.w3);
	});

	test('ingress: withdraw after the hold-down, re-add once, pin a node withdrawn twice', async () => {
		const h = harness(['w1'], { enabled: true });
		h.core.policies.update(principal, { ingressDriver: 'dns-failover' });
		h.sqlite.run(`UPDATE nodes SET roles_json = '["ingress","compute"]' WHERE id = ?`, [h.node.w1]);
		const tick = async (...silent: string[]) => {
			h.heartbeat(...silent);
			return (await h.core.failover.tick()).ingress;
		};
		await tick();
		// w1 stops: hold-down is max(2 × 45 s, 120 s) from the first failed observation.
		h.advance(31_000);
		expect((await tick('w1')).withdrawn).toEqual([]);
		h.advance(119_000);
		expect((await tick('w1')).withdrawn).toEqual([]);
		h.advance(1_000);
		expect((await tick('w1')).withdrawn).toEqual([h.node.w1]);
		expect(h.events('ingress')).toMatchObject([{ status: 'manual' }]);
		expect(h.events('ingress')[0]!.reason).toContain('by hand');
		// The edge is never withdrawn while it is the last healthy record.
		expect(h.core.failover.status(principal).ingress.nodes.find((node) => node.id === h.node.edge)).toMatchObject({ inRotation: true });

		// Back and healthy for the re-add hold-down (120 s): added back.
		await tick();
		h.advance(120_000);
		expect((await tick()).added).toEqual([h.node.w1]);

		// Fails again: second withdrawal inside 30 minutes pins it.
		h.advance(31_000);
		await tick('w1');
		h.advance(121_000);
		expect((await tick('w1')).withdrawn).toEqual([h.node.w1]);
		const view = h.core.failover.status(principal).ingress.nodes.find((node) => node.id === h.node.w1)!;
		expect(view).toMatchObject({ inRotation: false, pinned: true });
		await tick();
		h.advance(5 * 60_000);
		expect((await tick()).added).toEqual([]);
		// The pin releases after the window.
		h.advance(26 * 60_000);
		expect((await tick()).added).toEqual([h.node.w1]);
	});

	test('the direct driver tracks no record set', async () => {
		const h = harness(['w1'], { enabled: true });
		h.advance(10 * 60_000);
		h.heartbeat('edge');
		expect((await h.core.failover.tick()).ingress.withdrawn).toEqual([]);
		expect(h.core.failover.status(principal).ingress).toMatchObject({ driver: 'direct', rotates: false, steers: false });
	});
});

describe('fencing', () => {
	test('a controller that loses the lease mid-tick writes no move', async () => {
		const h = harness(['w1', 'w2', 'w3'], { enabled: true });
		const [first] = await h.app('web', 2, ['w1', 'w2']);
		await h.core.failover.tick();
		h.advance(130_000);
		h.heartbeat('w1');
		const original = h.core.workloads.planReplicaMove.bind(h.core.workloads);
		// Another control plane takes the lease between the decision and the write.
		h.core.workloads.planReplicaMove = (...args) => {
			h.sqlite.run('UPDATE settings SET value = ? WHERE key = ?', [
				JSON.stringify({ version: 99, record: { epoch: 9, holderNodeId: 'other', expiresAt: h.clock.now + 30_000 } }),
				FAILOVER_LEASE_KEY,
			]);
			return original(...args);
		};
		const report = await h.core.failover.tick();
		h.core.workloads.planReplicaMove = original;
		expect(report).toMatchObject({ lease: 'fenced', moved: 0 });
		expect(nodeOf(h, first!)).toBe(h.node.w1);
		expect(h.events('replica').every((event) => event.status === 'queued')).toBe(true);
		expect(h.sqlite.query("SELECT count(*) AS n FROM audit_log WHERE action = 'ha.failover'").get()).toEqual({ n: 0 });
	});

	test('the stage machine never skips a stage', () => {
		expect(walkFailoverStages('detect', 'promote')).toBe('promote');
		expect(() => walkFailoverStages('promote', 'decide')).toThrow();
	});
});

describe('database primaries', () => {
	function database(h: Harness, replicaStatus: 'streaming' | 'pending' = 'streaming') {
		h.core.ctx.db
			.insert(databases)
			.values({
				id: 'db_1',
				orgId: 'org_1',
				name: 'billing',
				engine: 'postgres',
				version: '17',
				nodeId: h.node.w1!,
				hostPort: 25432,
				memoryMb: 256,
				ownerSecret: 'x',
				monitorSecret: 'y',
				createdBy: 'user_1',
			})
			.run();
		h.core.ctx.db
			.insert(databaseReplicas)
			.values({ id: 'dbr_1', databaseId: 'db_1', nodeId: h.node.w2!, status: replicaStatus, replayLsn: '0/16B3740', lagBytes: 0, lagSeconds: 0.2, primaryGeneration: 3 })
			.run();
	}

	test('without a handler a lost primary is a manual event and a critical alert, once', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		database(h);
		h.advance(120_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).databases.manual).toBe(1);
		expect(h.events('database')).toMatchObject([{ status: 'manual', stage: 'decide', to_node_id: h.node.w2 }]);
		expect(h.events('database')[0]!.reason).toContain('no automatic promotion path');
		h.advance(5_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).databases.manual).toBe(0);
		const status = h.core.failover.status(principal).databases[0]!;
		expect(status).toMatchObject({ primaryLost: true, automatic: false, candidate: { nodeId: h.node.w2 } });
		// The primary returns: the manual event is closed.
		h.heartbeat();
		await h.core.failover.tick();
		expect(h.events('database')).toMatchObject([{ status: 'cancelled' }]);
	});

	test('a pending replica is never a candidate', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		database(h, 'pending');
		h.advance(120_000);
		h.heartbeat('w1');
		await h.core.failover.tick();
		expect(h.events('database')).toMatchObject([{ status: 'blocked' }]);
		expect(h.core.failover.status(principal).databases[0]!.refusals[0]).toContain('pending');
	});

	test('a registered handler runs fence, promote, repoint and heal under the lease', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		database(h);
		const calls: Array<{ stage: FailoverHandlerStage; plan: FailoverPlan; epoch: number }> = [];
		let waitOnce = true;
		const unregister = h.core.failover.registerDatabaseHandler({
			run(stage, plan, fence: FailoverFence): FailoverStageOutcome {
				expect(fence.holds()).toBe(true);
				calls.push({ stage, plan, epoch: fence.epoch });
				if (stage === 'promote' && waitOnce) {
					waitOnce = false;
					return { status: 'waiting', message: 'pg_ctl promote running' };
				}
				return { status: 'done' };
			},
		});
		h.advance(120_000);
		h.heartbeat('w1');
		const first = await h.core.failover.tick();
		expect(first.databases).toMatchObject({ started: 1, advanced: 1 });
		expect(h.events('database')).toMatchObject([{ status: 'in-progress', stage: 'fence' }]);
		h.advance(5_000);
		h.heartbeat('w1');
		await h.core.failover.tick();
		expect(h.events('database')).toMatchObject([{ status: 'completed', stage: 'complete' }]);
		expect(calls.map((call) => call.stage)).toEqual(['fence', 'promote', 'promote', 'repoint', 'heal']);
		expect(calls[0]!.plan).toMatchObject({ databaseId: 'db_1', candidateNodeId: h.node.w2, generation: 4 });
		expect(h.core.failover.status(principal).databaseHandler).toBe(true);
		unregister();
		expect(h.core.failover.status(principal).databaseHandler).toBe(false);
	});

	test('a handler that loses the lease cannot advance the stage', async () => {
		const h = harness(['w1', 'w2'], { enabled: true });
		database(h);
		h.core.failover.registerDatabaseHandler({
			run(): FailoverStageOutcome {
				h.sqlite.run('UPDATE settings SET value = ? WHERE key = ?', [
					JSON.stringify({ version: 99, record: { epoch: 9, holderNodeId: 'other', expiresAt: h.clock.now + 30_000 } }),
					FAILOVER_LEASE_KEY,
				]);
				return { status: 'done' };
			},
		});
		h.advance(120_000);
		h.heartbeat('w1');
		expect((await h.core.failover.tick()).lease).toBe('fenced');
		expect(h.events('database')).toMatchObject([{ status: 'in-progress', stage: 'decide' }]);
	});
});
