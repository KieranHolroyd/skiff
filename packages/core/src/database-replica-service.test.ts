import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DATABASE_REPLICAS_CAPABILITY,
	nodeCapabilities,
	type DatabaseReplicationSlotStatus,
	type Heartbeat,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { DATABASE_FENCE_TIMEOUT_MS, replicaStatusFrom, slotName } from './database-replica-service.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-db-replicas-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-07T10:00:00Z');
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
		now: () => clock,
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type JoinedNode = { nodeId: string; token: string };
const joinNode = (name: string, address: string | null): JoinedNode => {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 8192 });
	if (address) opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [address, node.nodeId]);
	return node;
};
const edge = joinNode('edge', null);
const primary = joinNode('primary', '10.88.1.2');
const second = joinNode('second', '10.88.1.3');
const third = joinNode('third', '10.88.1.4');
const hostPortOf = (name: string) => Number(core.databases.get(owner, name).internalHost.process.split(':')[1]);
const fingerprint = (node: JoinedNode) => node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64);

function beat(node: JoinedNode, extra: Partial<Heartbeat> = {}): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: [...nodeCapabilities],
		nodeCertificate: { certPem: 'pem', fingerprint: fingerprint(node), expiresAt: new Date(clock + 86_400_000).toISOString() },
		...extra,
	});
}
for (const node of [edge, primary, second, third]) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const slotSample = (slot: string, extra: Partial<DatabaseReplicationSlotStatus> = {}): DatabaseReplicationSlotStatus => ({
	slot,
	active: true,
	walStatus: 'reserved',
	state: 'streaming',
	sentLsn: '0/3000148',
	replayLsn: '0/3000148',
	lagBytes: 0,
	lagSeconds: 0,
	syncState: 'async',
	...extra,
});

/** The primary's node reports one sample for its database. */
function report(node: JoinedNode, databaseId: string, slots: DatabaseReplicationSlotStatus[] | null) {
	const task = (core.databaseReplicas.replicationTasksForNode(node.nodeId).find((item) => item.databaseId === databaseId))!;
	beat(node, {
		databaseReplication: [
			{ databaseId, appliedVersion: task.version, error: null, slots, sampledAt: new Date(clock).toISOString() },
		],
	});
	return task;
}

describe('adding replicas', () => {
	test('refuses what is not implemented and nodes that cannot serve', () => {
		core.databases.create(owner, { name: 'refusals', placement: primary.nodeId });
		expect(() => core.databaseReplicas.add(owner, 'refusals', { node: second.nodeId, mode: 'sync' })).toThrow(/Synchronous/);
		core.databases.create(owner, { name: 'cache', engine: 'valkey', placement: primary.nodeId });
		expect(() => core.databaseReplicas.add(owner, 'cache', { node: second.nodeId })).toThrow(/only Postgres/);
		expect(() => core.databaseReplicas.add(owner, 'refusals', { node: edge.nodeId })).toThrow(/overlay/);
		const old = joinNode('old-agent', '10.88.1.9');
		beat(old, { capabilities: nodeCapabilities.filter((item) => item !== DATABASE_REPLICAS_CAPABILITY) });
		expect(() => core.databaseReplicas.add(owner, 'refusals', { node: old.nodeId })).toThrow(/too old/);
	});

	test('a cross-node replica gets a port, a slot, a link, a provider listener and a primary task', async () => {
		const db = { ...core.databases.create(owner, { name: 'orders', placement: primary.nodeId }), hostPort: hostPortOf('orders') };
		const replica = core.databaseReplicas.add(owner, 'orders', { node: second.nodeId });
		expect(replica).toMatchObject({ nodeId: second.nodeId, status: 'pending', sameNode: false, removing: false, mode: 'async' });
		expect(replica.workloadId).toBe(`db_${replica.id}`);
		expect(replica.slot).toBe(slotName(replica.id));
		expect(replica.hostPort).toBeGreaterThanOrEqual(15432);
		expect(() => core.databaseReplicas.add(owner, 'orders', { node: second.nodeId })).toThrow(/already has a replica/);

		const replicaState = await core.nodes.desiredState(second.token);
		const workload = replicaState.workloads.find((item) => item.id === replica.workloadId)!;
		expect(workload.database).toMatchObject({ engine: 'postgres', replica: { slot: replica.slot } });
		expect(workload.port).toBe(replica.hostPort!);
		expect(workload.pooler).toBeUndefined();
		expect(replicaState.databaseReplicaLinks).toEqual([
			{
				workloadId: replica.workloadId,
				databaseId: db.id,
				upstream: { kind: 'remote', nodeId: primary.nodeId, address: '10.88.1.2', port: db.hostPort, tlsFingerprint: fingerprint(primary) },
			},
		]);
		const activation = core.workloads.activation(second.nodeId, replica.workloadId);
		expect(activation.activationVersion).toBe(workload.activationVersion);
		expect(activation.env.PGPASSWORD).toMatch(/^[A-Za-z0-9_-]{16,}$/);
		expect(activation.env.POSTGRES_PASSWORD).toBeTruthy();
		expect(activation.monitor).toBeUndefined();
		expect(() => core.workloads.activation(third.nodeId, replica.workloadId)).toThrow(/another node/);

		const primaryState = await core.nodes.desiredState(primary.token);
		expect(primaryState.databaseReplication).toEqual([
			{ databaseId: db.id, version: expect.any(String), slots: [replica.slot!] },
		]);
		const provider = primaryState.serviceProviders.find((item) => item.listenPort === db.hostPort)!;
		expect(provider).toMatchObject({ listenAddress: '10.88.1.2', targetPort: db.hostPort, allowedClientFingerprints: [fingerprint(second)] });
		const secret = core.databaseReplicas.replicationActivation(primary.nodeId, db.id);
		expect(secret.password).toBe(activation.env.PGPASSWORD!);
		expect(() => core.databaseReplicas.replicationActivation(second.nodeId, db.id)).toThrow(/another node/);
	});

	test('a same-node replica links to the loopback port and reserves memory', async () => {
		const db = { ...core.databases.create(owner, { name: 'reads', placement: primary.nodeId, memoryMb: 512 }), hostPort: hostPortOf('reads') };
		const before = core.workloads.capacityInternal().find((item) => item.nodeId === primary.nodeId)!.reservedMemoryMb;
		const replica = core.databaseReplicas.add(owner, 'reads', { node: primary.nodeId });
		expect(replica.sameNode).toBe(true);
		expect(replica.hostPort).not.toBe(db.hostPort);
		const after = core.workloads.capacityInternal().find((item) => item.nodeId === primary.nodeId)!.reservedMemoryMb;
		expect(after - before).toBe(512);
		const state = await core.nodes.desiredState(primary.token);
		expect(state.databaseReplicaLinks).toContainEqual({
			workloadId: replica.workloadId,
			databaseId: db.id,
			upstream: { kind: 'local', port: db.hostPort },
		});
		// A same-node replica never needs an overlay listener.
		expect(state.serviceProviders.some((item) => item.listenPort === db.hostPort)).toBe(false);
		expect(() =>
			core.databaseReplicas.promote(owner, 'reads', replica.id, { confirm: true, acceptDataLoss: true }),
		).toThrow(/own node/);
	});
});

describe('status from the primary', () => {
	test('slot samples drive streaming, lagging, stopped and lost', () => {
		const pending = { status: 'pending' as const, replayLsn: null };
		expect(replicaStatusFrom(slotSample('yoal_x'), pending).status).toBe('streaming');
		expect(replicaStatusFrom(slotSample('yoal_x', { lagSeconds: 45 }), pending).status).toBe('lagging');
		expect(replicaStatusFrom(slotSample('yoal_x', { lagBytes: 300 * 1024 * 1024 }), pending).status).toBe('lagging');
		expect(replicaStatusFrom(slotSample('yoal_x', { active: false, state: null, replayLsn: null }), pending).status).toBe('pending');
		expect(
			replicaStatusFrom(slotSample('yoal_x', { active: false, state: null }), { status: 'streaming', replayLsn: '0/1' }).status,
		).toBe('stopped');
		expect(replicaStatusFrom(slotSample('yoal_x', { walStatus: 'lost' }), pending).status).toBe('lost');
	});

	test('a streaming replica gives attached apps read URLs on its node', async () => {
		const project = await core.projects.create(owner, {
			name: 'Reader',
			slug: 'reader',
			runtime: 'process',
			placement: second.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const db = core.databases.create(owner, { name: 'catalog', placement: second.nodeId, project: 'reader' });
		const replica = core.databaseReplicas.add(owner, 'catalog', { node: second.nodeId });
		const versionBefore = core.databases.consumerVersion(project.id, second.nodeId, 'process');
		expect(core.databases.consumerEnv(project.id, second.nodeId, 'process').DATABASE_READ_URL).toBeUndefined();
		expect(core.databases.attachments(owner, core.projects.requireRow(owner, 'reader'))[0]!.envNames).toContain('DATABASE_READ_URL');

		report(second, db.id, [slotSample(replica.slot!)]);
		expect(core.databaseReplicas.list(owner, 'catalog')[0]).toMatchObject({ status: 'streaming', replayLsn: '0/3000148', lagBytes: 0 });
		const env = core.databases.consumerEnv(project.id, second.nodeId, 'process');
		expect(env.DATABASE_READ_URL).toContain(`@127.0.0.1:${replica.hostPort}/`);
		expect(env.DATABASE_READ_URLS).toBe(env.DATABASE_READ_URL);
		expect(env.DATABASE_READ_PORT).toBe(String(replica.hostPort));
		expect(core.databases.consumerVersion(project.id, second.nodeId, 'process')).not.toBe(versionBefore);
		const container = core.databases.consumerEnv(project.id, second.nodeId, 'container');
		expect(container.DATABASE_READ_HOST).toBe(`db-${replica.id.replace(/_/g, '')}`);
		expect(container.DATABASE_READ_PORT).toBe('5432');

		// Stopped streaming: the read URL goes away again.
		report(second, db.id, [slotSample(replica.slot!, { active: false, state: null })]);
		expect(core.databaseReplicas.list(owner, 'catalog')[0]!.status).toBe('stopped');
		expect(core.databases.consumerEnv(project.id, second.nodeId, 'process').DATABASE_READ_URL).toBeUndefined();
	});

	test('a restart loop on the replica node marks it failed', () => {
		const db = core.databases.create(owner, { name: 'flaky', placement: primary.nodeId });
		const replica = core.databaseReplicas.add(owner, 'flaky', { node: third.nodeId });
		beat(third, { workloads: [{ id: replica.workloadId, status: 'running', restarts: 6 }] });
		expect(core.databaseReplicas.list(owner, 'flaky')[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Restart loop') });
		void db;
	});
});

describe('removing a replica', () => {
	test('waits for the purge and the slot drop, then deletes the row', async () => {
		const db = core.databases.create(owner, { name: 'temp', placement: primary.nodeId });
		const replica = core.databaseReplicas.add(owner, 'temp', { node: second.nodeId });
		const removed = core.databaseReplicas.remove(owner, 'temp', replica.id);
		expect(removed.removing).toBe(true);
		const replicaState = await core.nodes.desiredState(second.token);
		expect(replicaState.workloads.some((item) => item.id === replica.workloadId)).toBe(false);
		expect(replicaState.databasePurges).toContain(replica.workloadId);
		expect(replicaState.databaseReplicaLinks.some((link) => link.workloadId === replica.workloadId)).toBe(false);
		// The primary's task no longer lists the slot (an empty list tears the role down).
		const task = core.databaseReplicas.replicationTasksForNode(primary.nodeId).find((item) => item.databaseId === db.id)!;
		expect(task.slots).toEqual([]);

		beat(second, { purgedDatabases: [replica.workloadId] });
		expect(core.databaseReplicas.list(owner, 'temp')).toHaveLength(1);
		report(primary, db.id, []);
		expect(core.databaseReplicas.list(owner, 'temp')).toEqual([]);
		// The teardown was confirmed with nothing left: the role's secret is forgotten.
		expect(core.databaseReplicas.replicationTasksForNode(primary.nodeId).some((item) => item.databaseId === db.id)).toBe(false);
	});

	test('moves and major upgrades refuse while replicas exist', () => {
		core.databases.create(owner, { name: 'pinned', placement: primary.nodeId, version: '17' });
		core.databaseReplicas.add(owner, 'pinned', { node: second.nodeId });
		expect(() => core.moves.moveDatabase(owner, 'pinned', { node: third.nodeId })).toThrow(/replica/);
		const plan = core.databases.upgradeDatabase(owner, 'pinned', { targetVersion: '18' });
		expect(plan.blockers.join(' ')).toContain('replicas');
	});
});

describe('promotion', () => {
	test('fence, promote, re-point, complete, then clean up and rebuild the others', async () => {
		const db = core.databases.create(owner, { name: 'ledger', placement: primary.nodeId });
		const target = core.databaseReplicas.add(owner, 'ledger', { node: second.nodeId });
		const other = core.databaseReplicas.add(owner, 'ledger', { node: third.nodeId });
		expect(() => core.databaseReplicas.promote(owner, 'ledger', target.id, { confirm: true })).toThrow(/not streamed/);
		report(primary, db.id, [slotSample(target.slot!), slotSample(other.slot!)]);
		expect(() =>
			core.databaseReplicas.promote(owner, 'ledger', target.id, { confirm: true }, { ifMatch: 7 }),
		).toThrow(/generation 0/);

		// A stale report needs acceptDataLoss.
		clock += 5 * 60_000;
		for (const node of [edge, second, third]) beat(node);
		expect(() => core.databaseReplicas.promote(owner, 'ledger', target.id, { confirm: true })).toThrow(/acceptDataLoss/);
		report(primary, db.id, [slotSample(target.slot!), slotSample(other.slot!)]);

		const started = core.databaseReplicas.promote(owner, 'ledger', target.id, { confirm: true }, { ifMatch: 0 });
		expect(started).toMatchObject({ stage: 'fencing', fromNodeId: primary.nodeId, toNodeId: second.nodeId, generation: 1 });
		// Fenced: the primary left its node's desired state, and nothing is promoted yet.
		const fencedState = await core.nodes.desiredState(primary.token);
		expect(fencedState.workloads.some((item) => item.id === db.id)).toBe(false);
		expect(fencedState.databaseReplication.some((item) => item.databaseId === db.id)).toBe(false);
		expect(core.databaseReplicas.promotionsForNode(second.nodeId)).toEqual([]);
		// The node still reports the primary running: not fenced yet.
		beat(primary, { workloads: [{ id: db.id, status: 'running', restarts: 0 }] });
		expect(core.databaseReplicas.failovers(owner, 'ledger')[0]!.stage).toBe('fencing');
		beat(primary, { workloads: [] });
		expect(core.databaseReplicas.failovers(owner, 'ledger')[0]!.stage).toBe('promoting');
		expect(core.databaseReplicas.promotionsForNode(second.nodeId)).toEqual([
			{ failoverId: started.id, databaseId: db.id, replicaWorkloadId: target.workloadId },
		]);

		beat(second, { databaseReplicaPromotionResults: [{ failoverId: started.id, status: 'ok', lsn: '0/4000000' }] });
		const moved = core.databases.get(owner, 'ledger');
		expect(moved.nodeId).toBe(second.nodeId);
		expect(moved.internalHost.process).toBe(`127.0.0.1:${target.hostPort}`);
		expect(core.databaseReplicas.failovers(owner, 'ledger')[0]!.stage).toBe('repointing');
		const afterState = await core.nodes.desiredState(second.token);
		expect(afterState.workloads.some((item) => item.id === db.id)).toBe(true);
		expect(afterState.workloads.some((item) => item.id === target.workloadId)).toBe(false);
		// The other replica streamed from the old timeline: it is rebuilt.
		const rows = core.databaseReplicas.list(owner, 'ledger');
		expect(rows).toEqual([expect.objectContaining({ id: other.id, removing: true })]);

		beat(second, { workloads: [{ id: db.id, status: 'running', restarts: 0 }] });
		expect(core.databaseReplicas.failovers(owner, 'ledger')[0]).toMatchObject({ stage: 'completed' });
		// Leftovers: the replica dir on the new node, the fenced primary on the old one.
		expect((await core.nodes.desiredState(second.token)).databasePurges).toContain(target.workloadId);
		expect((await core.nodes.desiredState(primary.token)).databasePurges).toContain(db.id);
		beat(primary, { purgedDatabases: [db.id] });
		expect((await core.nodes.desiredState(primary.token)).databasePurges).not.toContain(db.id);
		expect(core.databases.get(owner, 'ledger').nodeId).toBe(second.nodeId);

		// The third node purges the old copy; a fresh replica of the new primary replaces it.
		beat(third, { purgedDatabases: [other.workloadId] });
		const rebuilt = core.databaseReplicas.list(owner, 'ledger');
		expect(rebuilt).toEqual([expect.objectContaining({ nodeId: third.nodeId, status: 'pending', removing: false, primaryGeneration: 1 })]);
		expect(rebuilt[0]!.id).not.toBe(other.id);
		const link = (await core.nodes.desiredState(third.token)).databaseReplicaLinks.find((item) => item.databaseId === db.id)!;
		expect(link.upstream).toMatchObject({ kind: 'remote', nodeId: second.nodeId });
	});

	test('a failed promotion puts the old primary back; an unconfirmed fence times out', async () => {
		const db = core.databases.create(owner, { name: 'safe', placement: primary.nodeId });
		const replica = core.databaseReplicas.add(owner, 'safe', { node: third.nodeId });
		report(primary, db.id, [slotSample(replica.slot!)]);
		const started = core.databaseReplicas.promote(owner, 'safe', replica.id, { confirm: true });
		beat(primary, { workloads: [] });
		beat(third, { databaseReplicaPromotionResults: [{ failoverId: started.id, status: 'failed', error: 'target exists' }] });
		expect(core.databaseReplicas.failovers(owner, 'safe')[0]).toMatchObject({ stage: 'failed', message: expect.stringContaining('target exists') });
		expect((await core.nodes.desiredState(primary.token)).workloads.some((item) => item.id === db.id)).toBe(true);
		expect(core.databaseReplicas.list(owner, 'safe')[0]!.status).toBe('failed');

		const again = core.databases.create(owner, { name: 'slow-fence', placement: primary.nodeId });
		const next = core.databaseReplicas.add(owner, 'slow-fence', { node: third.nodeId });
		report(primary, again.id, [slotSample(next.slot!)]);
		core.databaseReplicas.promote(owner, 'slow-fence', next.id, { confirm: true });
		clock += DATABASE_FENCE_TIMEOUT_MS + 1;
		expect(core.databaseReplicas.tick()).toBe(1);
		expect(core.databaseReplicas.failovers(owner, 'slow-fence')[0]!.stage).toBe('failed');
		for (const node of [edge, primary, second, third]) beat(node);
	});

	test('the failover controller handler fences an unreachable primary at once and reports each stage', () => {
		const db = core.databases.create(owner, { name: 'auto', placement: third.nodeId });
		const replica = core.databaseReplicas.add(owner, 'auto', { node: second.nodeId });
		report(third, db.id, [slotSample(replica.slot!)]);
		opened.sqlite.run(`UPDATE nodes SET status = 'offline' WHERE id = ?`, [third.nodeId]);
		const handler = core.databaseReplicas.failoverHandler();
		const fence = { epoch: 1, holderId: 'test', holds: () => true };
		const plan = { databaseId: db.id, candidateNodeId: second.nodeId, generation: 1, stage: 'fence' as const, reason: 'lost' };
		expect(handler.run('fence', plan, fence)).toMatchObject({ status: 'done' });
		expect(handler.run('promote', { ...plan, stage: 'promote' }, fence)).toMatchObject({ status: 'waiting' });
		const task = core.databaseReplicas.promotionsForNode(second.nodeId).find((item) => item.databaseId === db.id)!;
		beat(second, { databaseReplicaPromotionResults: [{ failoverId: task.failoverId, status: 'ok', lsn: null }] });
		expect(handler.run('promote', { ...plan, stage: 'promote' }, fence)).toMatchObject({ status: 'done' });
		expect(handler.run('repoint', { ...plan, stage: 'repoint' }, fence)).toMatchObject({ status: 'waiting' });
		beat(second, { workloads: [{ id: db.id, status: 'running', restarts: 0 }] });
		expect(handler.run('repoint', { ...plan, stage: 'repoint' }, fence)).toMatchObject({ status: 'done' });
		expect(handler.run('heal', { ...plan, stage: 'heal' }, fence)).toMatchObject({ status: 'done' });
		// A stale plan (wrong generation) never starts a second promotion.
		expect(handler.run('fence', { ...plan, generation: 5 }, fence)).toMatchObject({ status: 'failed' });
		opened.sqlite.run(`UPDATE nodes SET status = 'online' WHERE id = ?`, [third.nodeId]);
	});
});
