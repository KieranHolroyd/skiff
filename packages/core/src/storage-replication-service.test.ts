import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { storageGatewayHost } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { replicationStatus } from './storage-replication-service.ts';
import { ROOT_ROTATION_TIMEOUT_MS } from './storage-instances.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-storage-repl-'));
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
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
const worker = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'worker').token, name: 'worker' });
const worker2 = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'worker-2').token, name: 'worker-2' });
for (const node of [edge, worker, worker2]) core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 4096 });
core.nodes.update(owner, worker.nodeId, { publicAddress: '10.88.1.2:8080' });
core.nodes.update(owner, worker2.nodeId, { publicAddress: '10.88.1.3:8080' });

const desiredOn = async (token: string, name: string) =>
	(await core.nodes.desiredState(token)).workloads.find((item) => item.projectSlug === name);
const heartbeat = (token: string, nodeId: string, extra: Record<string, unknown>) =>
	core.nodes.heartbeat(token, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		...extra,
	});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('storage replication', () => {
	test('a worker source pushes to a worker target with a scoped read-write key', async () => {
		core.storage.create(owner, { name: 'primary-store', placement: worker.nodeId, buckets: ['uploads', 'avatars'] });
		core.storage.create(owner, { name: 'passive-store', placement: worker2.nodeId });
		const sourceBefore = (await desiredOn(worker.token, 'primary-store'))!;

		const added = core.storageReplication.add(owner, 'primary-store', { target: 'passive-store' });
		expect(added).toMatchObject({
			sourceName: 'primary-store',
			targetName: 'passive-store',
			status: 'pending',
			runnerNodeId: worker.nodeId,
			objectsCopied: 0,
		});
		// The target gets its own copy of each bucket as ordinary desired state.
		expect(core.storage.get(owner, 'passive-store').buckets.map((bucket) => bucket.name)).toEqual(['avatars', 'uploads']);

		const source = (await desiredOn(worker.token, 'primary-store'))!;
		const target = (await desiredOn(worker2.token, 'passive-store'))!;
		const link = source.objectStorage!.replication[0]!;
		expect(link).toMatchObject({
			id: added.id,
			direction: 'push',
			peerId: target.id,
			endpoint: 'http://10.88.1.3:8080',
			host: storageGatewayHost(target.id),
			buckets: ['avatars', 'uploads'],
			intervalSeconds: 15 * 60,
		});
		expect(source.objectStorage!.keysVersion).not.toBe(sourceBefore.objectStorage!.keysVersion);
		expect(source.activationVersion).toBe(sourceBefore.activationVersion);
		expect(target.objectStorage!.users).toContainEqual({
			accessKeyId: link.accessKeyId,
			grants: [
				{ bucket: 'avatars', mode: 'read-write' },
				{ bucket: 'uploads', mode: 'read-write' },
			],
		});
		// The runner holds the link secret; the peer holds the same secret for its scoped user.
		const runnerActivation = core.workloads.activation(worker.nodeId, source.id);
		const peerActivation = core.workloads.activation(worker2.nodeId, target.id);
		expect(runnerActivation.storageAdmin!.replication[added.id]).toBeTruthy();
		expect(peerActivation.storageAdmin!.users[link.accessKeyId]).toBe(runnerActivation.storageAdmin!.replication[added.id]!);
		// The peer's root key never leaves its own node.
		expect(JSON.stringify(runnerActivation)).not.toContain(peerActivation.storageAdmin!.rootSecretAccessKey);
	});

	test('progress reports set status, lag and totals; reports from another node are ignored', async () => {
		const [rule] = core.storageReplication.list(owner, 'primary-store');
		const report = {
			id: rule!.id,
			status: 'syncing',
			lastSyncAt: null,
			attemptAt: new Date(clock).toISOString(),
			pending: 12,
			copiedObjects: 30,
			copiedBytes: 4096,
			error: null,
			buckets: [{ name: 'uploads', status: 'syncing', pending: 12, lastSyncAt: null, error: null }],
		};
		await heartbeat(worker2.token, worker2.nodeId, { storageReplication: [report] });
		expect(core.storageReplication.list(owner, 'primary-store')[0]!.objectsCopied).toBe(0);

		await heartbeat(worker.token, worker.nodeId, { storageReplication: [report] });
		let view = core.storageReplication.list(owner, 'primary-store')[0]!;
		expect(view).toMatchObject({ status: 'syncing', pendingObjects: 12, objectsCopied: 30, bytesCopied: 4096, initialSyncAt: null });
		expect(view.buckets[0]).toMatchObject({ name: 'uploads', pending: 12 });

		const passStart = clock;
		clock += 60_000;
		await heartbeat(worker.token, worker.nodeId, {
			storageReplication: [
				{ ...report, status: 'in-sync', lastSyncAt: new Date(passStart).toISOString(), pending: 0, copiedObjects: 12, copiedBytes: 100 },
			],
		});
		view = core.storageReplication.list(owner, 'primary-store')[0]!;
		expect(view).toMatchObject({ status: 'protected', lagSeconds: 60, objectsCopied: 42, bytesCopied: 4196 });
		expect(view.initialSyncAt).toBe(new Date(passStart).toISOString());
		// The target lists the rule too, so its page explains where its objects come from.
		expect(core.storageReplication.list(owner, 'passive-store')).toHaveLength(1);

		clock += 60_000;
		await heartbeat(worker.token, worker.nodeId, {
			storageReplication: [{ ...report, status: 'error', error: 'connect ECONNREFUSED', copiedObjects: 0, copiedBytes: 0 }],
		});
		view = core.storageReplication.list(owner, 'primary-store')[0]!;
		expect(view).toMatchObject({ status: 'lagging', lastError: 'connect ECONNREFUSED' });
	});

	test('a new source bucket joins the link on the next report', async () => {
		core.storage.createBucket(owner, 'primary-store', { name: 'exports' });
		const [rule] = core.storageReplication.list(owner, 'primary-store');
		await heartbeat(worker.token, worker.nodeId, {
			storageReplication: [{ id: rule!.id, status: 'syncing', attemptAt: new Date(clock).toISOString() }],
		});
		expect(core.storage.get(owner, 'passive-store').buckets.map((bucket) => bucket.name)).toContain('exports');
		const source = (await desiredOn(worker.token, 'primary-store'))!;
		expect(source.objectStorage!.replication[0]!.buckets).toContain('exports');
	});

	test('a target on the edge pulls from the worker source', async () => {
		core.storage.create(owner, { name: 'worker-src', placement: worker.nodeId, buckets: ['media'] });
		core.storage.create(owner, { name: 'edge-copy', placement: edge.nodeId });
		const added = core.storageReplication.add(owner, 'worker-src', { target: 'edge-copy' });
		expect(added.runnerNodeId).toBe(edge.nodeId);
		const local = (await desiredOn(edge.token, 'edge-copy'))!;
		const sourceWorkload = (await desiredOn(worker.token, 'worker-src'))!;
		expect(local.objectStorage!.replication[0]).toMatchObject({
			direction: 'pull',
			peerId: sourceWorkload.id,
			endpoint: 'http://10.88.1.2:8080',
		});
		expect(sourceWorkload.objectStorage!.replication).toEqual([]);
		expect(sourceWorkload.objectStorage!.users).toContainEqual({
			accessKeyId: local.objectStorage!.replication[0]!.accessKeyId,
			grants: [{ bucket: 'media', mode: 'read' }],
		});
		core.storageReplication.remove(owner, 'worker-src', added.id);
		expect((await desiredOn(edge.token, 'edge-copy'))!.objectStorage!.replication).toEqual([]);
	});

	test('refuses same-node, public, chained and cross-org targets', () => {
		core.storage.create(owner, { name: 'same-a', placement: edge.nodeId });
		core.storage.create(owner, { name: 'same-b', placement: edge.nodeId });
		expect(() => core.storageReplication.add(owner, 'same-a', { target: 'same-b' })).toThrow(/another node/);
		expect(() => core.storageReplication.add(owner, 'passive-store', { target: 'same-a' })).toThrow(/itself a replication target/);
		expect(() => core.storageReplication.add(owner, 'same-a', { target: 'passive-store' })).toThrow(/already the target/);
		expect(() => core.storageReplication.list(otherOrg, 'primary-store')).toThrow(/not found/i);
		expect(() => core.storageReplication.add(otherOrg, 'primary-store', { target: 'passive-store' })).toThrow(/not found/i);
	});

	test('status follows the last complete pass', () => {
		const interval = 15 * 60_000;
		const now = clock;
		expect(replicationStatus({ status: 'syncing', error: null }, null, now, interval)).toBe('syncing');
		expect(replicationStatus({ status: 'in-sync', error: null }, now - 1000, now, interval)).toBe('protected');
		expect(replicationStatus({ status: 'in-sync', error: null }, now - 3 * interval, now, interval)).toBe('lagging');
		expect(replicationStatus({ status: 'error', error: 'x' }, null, now, interval)).toBe('failed');
		expect(replicationStatus({ status: 'error', error: 'x' }, now - 1000, now, interval)).toBe('lagging');
	});
});

describe('staged root key rotation', () => {
	const running = (token: string, nodeId: string, id: string) =>
		heartbeat(token, nodeId, { workloads: [{ id, status: 'running', restarts: 0 }] });

	test('restarts with a pending key, then promotes it without another restart', async () => {
		core.storage.create(owner, { name: 'rot-store', placement: worker.nodeId, buckets: ['bk1'] });
		const before = (await desiredOn(worker.token, 'rot-store'))!;
		expect(() => core.storage.rotateRootKey(owner, 'rot-store')).toThrow(/running/);
		await running(worker.token, worker.nodeId, before.id);
		const oldKey = core.storage.get(owner, 'rot-store').rootKey.accessKeyId;

		const rotating = core.storage.rotateRootKey(owner, 'rot-store');
		expect(rotating.rootKey).toMatchObject({ status: 'rotating', accessKeyId: oldKey });
		const pending = rotating.rootKey.pendingAccessKeyId!;
		expect(pending).toStartWith('SKR');
		expect(() => core.storage.rotateRootKey(owner, 'rot-store')).toThrow(/already waiting/);

		const staged = (await desiredOn(worker.token, 'rot-store'))!;
		expect(staged.activationVersion).not.toBe(before.activationVersion);
		const activation = core.workloads.activation(worker.nodeId, staged.id);
		expect(activation.env.RUSTFS_ACCESS_KEY).toBe(pending);
		expect(activation.storageAdmin!.rootAccessKeyId).toBe(pending);
		// Humans still read the current key until the node proves the new one.
		expect(core.storage.credentials(owner, 'rot-store').accessKeyId).toBe(oldKey);

		// A stale report for the old key changes nothing.
		await heartbeat(worker.token, worker.nodeId, {
			storageRootKeys: [{ storageId: staged.id, accessKeyId: oldKey, result: 'accepted' }],
		});
		expect(core.storage.get(owner, 'rot-store').rootKey.status).toBe('rotating');

		await heartbeat(worker.token, worker.nodeId, {
			storageRootKeys: [{ storageId: staged.id, accessKeyId: pending, result: 'accepted' }],
		});
		const done = core.storage.get(owner, 'rot-store');
		expect(done.rootKey).toMatchObject({ status: 'current', accessKeyId: pending, pendingAccessKeyId: null });
		expect(done.rootKey.rotatedAt).not.toBeNull();
		expect(core.storage.credentials(owner, 'rot-store').secretAccessKey).toBe(activation.env.RUSTFS_SECRET_KEY!);
		const promoted = (await desiredOn(worker.token, 'rot-store'))!;
		expect(promoted.activationVersion).toBe(staged.activationVersion);
		expect(core.audit.list({ orgId: 'org_1', action: 'storage.root-key.rotated' }).length).toBe(1);
		expect(JSON.stringify(core.audit.list({ orgId: 'org_1', action: 'storage.root-key.rotate' }))).not.toContain(
			activation.env.RUSTFS_SECRET_KEY!,
		);
	});

	test('a rejected key, a timeout and a cancel all roll back to the current key', async () => {
		const workload = (await desiredOn(worker.token, 'rot-store'))!;
		const current = core.storage.get(owner, 'rot-store').rootKey.accessKeyId;

		let pending = core.storage.rotateRootKey(owner, 'rot-store').rootKey.pendingAccessKeyId!;
		await heartbeat(worker.token, worker.nodeId, {
			storageRootKeys: [{ storageId: workload.id, accessKeyId: pending, result: 'rejected', message: 'InvalidAccessKeyId' }],
		});
		let view = core.storage.get(owner, 'rot-store');
		expect(view.rootKey).toMatchObject({ status: 'failed', accessKeyId: current, pendingAccessKeyId: null });
		expect(view.rootKey.error).toMatch(/refused the new root key/);
		expect((await desiredOn(worker.token, 'rot-store'))!.activationVersion).toBe(workload.activationVersion);

		pending = core.storage.rotateRootKey(owner, 'rot-store').rootKey.pendingAccessKeyId!;
		clock += ROOT_ROTATION_TIMEOUT_MS + 1000;
		await running(worker.token, worker.nodeId, workload.id);
		view = core.storage.get(owner, 'rot-store');
		expect(view.rootKey.status).toBe('failed');
		expect(view.rootKey.error).toMatch(/did not confirm/);

		core.storage.rotateRootKey(owner, 'rot-store');
		view = core.storage.cancelRootKeyRotation(owner, 'rot-store');
		expect(view.rootKey).toMatchObject({ status: 'current', accessKeyId: current, error: null });
		expect(() => core.storage.cancelRootKeyRotation(owner, 'rot-store')).toThrow(/no root key rotation/);
		expect(pending).not.toBe(current);
	});
});
