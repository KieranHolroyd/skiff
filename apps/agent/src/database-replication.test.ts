import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredStateSchema, type DatabaseReplicationSlotStatus, type DesiredState } from '@yoal/contracts';
import { DatabaseReplicationRunner } from './database-replication.ts';
import { REPLICA_LINK_SOCKET, ReplicaLinkForwarder } from './replica-links.ts';
import { withOptionalSpec } from './runtime.ts';

const PRIMARY = 'db_0123456789abcdef0123456789abcdef';
const REPLICA = 'db_dbr_0123456789abcdef0123456789abcdef';
const SLOT = 'yoal_dbr_0123456789abcdef0123456789abcdef';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

function state(extra: Partial<DesiredState> = {}): DesiredState {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_a',
		agentVersion: '0.1.0',
		generatedAt: new Date().toISOString(),
		contentDomain: 'sites.test',
		releases: [],
		routes: [],
		...extra,
	});
}

describe('ReplicaLinkForwarder', () => {
	test('serves a unix socket that pipes to the local primary, and removes it when the link goes', async () => {
		// A tiny echo server stands in for the primary's published loopback port.
		const primary: Server = createServer((socket) => socket.pipe(socket));
		await new Promise<void>((resolve) => primary.listen(0, '127.0.0.1', resolve));
		cleanup.push(() => new Promise((resolve) => primary.close(() => resolve())));
		const port = (primary.address() as { port: number }).port;
		const root = await fs.mkdtemp(join(tmpdir(), 'yoal-links-'));
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
		const links = new ReplicaLinkForwarder({ root: join(root, 'replication') });
		cleanup.push(() => links.close());

		const link = { workloadId: REPLICA, databaseId: PRIMARY, upstream: { kind: 'local' as const, port } };
		expect(await links.converge([link])).toEqual({ started: 1, stopped: 0 });
		const path = links.socketPath(REPLICA);
		expect(path).toBe(join(root, 'replication', REPLICA, REPLICA_LINK_SOCKET));
		expect((await fs.stat(path)).mode & 0o777).toBe(0o666);
		const echoed = await new Promise<string>((resolve, reject) => {
			const client = connect(path, () => client.write('ping'));
			client.on('data', (chunk) => {
				resolve(chunk.toString());
				client.destroy();
			});
			client.on('error', reject);
		});
		expect(echoed).toBe('ping');
		// Unchanged links are left alone (the container's mount holds the directory).
		expect(await links.converge([link])).toEqual({ started: 0, stopped: 0 });
		expect(await links.converge([])).toEqual({ started: 0, stopped: 1 });
		await expect(fs.stat(join(root, 'replication', REPLICA))).rejects.toThrow();
	});

	test('a changed upstream restarts the socket and drops open streams; stale dirs are swept', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'yoal-links-'));
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
		const stale = 'db_dbr_ffffffffffffffffffffffffffffffff';
		await fs.mkdir(join(root, stale), { recursive: true });
		const links = new ReplicaLinkForwarder({ root });
		cleanup.push(() => links.close());
		await links.converge([{ workloadId: REPLICA, databaseId: PRIMARY, upstream: { kind: 'local', port: 1 } }]);
		await expect(fs.stat(join(root, stale))).rejects.toThrow();
		const remote = {
			workloadId: REPLICA,
			databaseId: PRIMARY,
			upstream: { kind: 'remote' as const, nodeId: 'nod_b', address: '10.88.1.2', port: 15432, tlsFingerprint: 'a'.repeat(64) },
		};
		expect(await links.converge([remote])).toEqual({ started: 1, stopped: 1 });
		// The directory survived the restart; only the socket inside it was recreated.
		expect((await fs.stat(join(root, REPLICA))).isDirectory()).toBe(true);
	});
});

class FakeHelper {
	configured: Array<{ id: string; slots: string[]; password: string | null }> = [];
	promoted: string[] = [];
	failConfigure = false;
	failPromote = false;
	slots: DatabaseReplicationSlotStatus[] = [];
	async replicationConfigure(id: string, input: { slots: string[]; password: string | null }): Promise<void> {
		if (this.failConfigure) throw new Error('psql exited 2');
		this.configured.push({ id, ...input });
	}
	async replicationStatus(): Promise<DatabaseReplicationSlotStatus[]> {
		return this.slots;
	}
	async replicaPromote(replicaId: string): Promise<{ lsn: string | null }> {
		if (this.failPromote) throw new Error('target exists');
		this.promoted.push(replicaId);
		return { lsn: '0/5000060' };
	}
}

function runnerWith(options: { version?: string; slots?: string[] } = {}) {
	const helper = new FakeHelper();
	const held: string[] = [];
	let clock = 1_000_000;
	const requests: string[] = [];
	const runner = new DatabaseReplicationRunner({
		controlUrl: 'https://control.test',
		nodeToken: 'token',
		helper,
		runtime: { hold: (id) => held.push(id), release: (id) => held.splice(held.indexOf(id), 1) },
		now: () => clock,
		fetch: (async (url: string | URL | Request) => {
			requests.push(String(url));
			return Response.json({
				databaseId: PRIMARY,
				version: options.version ?? 'v1',
				slots: options.slots ?? [SLOT],
				password: (options.slots ?? [SLOT]).length ? 'Abcdefghijklmnop_qrstu' : null,
			});
		}) as typeof fetch,
	});
	return { helper, held, runner, requests, advance: (ms: number) => (clock += ms) };
}

const task = (version = 'v1', slots = [SLOT]) => state({ databaseReplication: [{ databaseId: PRIMARY, version, slots }] });
const signal = new AbortController().signal;

describe('DatabaseReplicationRunner', () => {
	test('configures once per version with the fetched password, then samples and reports', async () => {
		const r = runnerWith();
		r.helper.slots = [
			{ slot: SLOT, active: true, walStatus: 'reserved', state: 'streaming', sentLsn: '0/1', replayLsn: '0/1', lagBytes: 0, lagSeconds: 0, syncState: 'async' },
		];
		await r.runner.runOnce(task(), signal);
		await r.runner.runOnce(task(), signal);
		expect(r.helper.configured).toEqual([{ id: PRIMARY, slots: [SLOT], password: 'Abcdefghijklmnop_qrstu' }]);
		expect(r.requests).toEqual([`https://control.test/api/agent/database-replication/${PRIMARY}`]);
		expect(r.runner.reports()).toEqual([
			expect.objectContaining({ databaseId: PRIMARY, appliedVersion: 'v1', error: null, slots: r.helper.slots }),
		]);
		// The password never lands in the report.
		expect(JSON.stringify(r.runner.reports())).not.toContain('Abcdefghijklmnop');
		// A database that left desired state is no longer reported.
		await r.runner.runOnce(state(), signal);
		expect(r.runner.reports()).toEqual([]);
	});

	test('a failed configure is reported and retried after the back-off', async () => {
		const r = runnerWith();
		r.helper.failConfigure = true;
		await r.runner.runOnce(task(), signal);
		expect(r.runner.reports()[0]).toMatchObject({ appliedVersion: null, error: 'psql exited 2' });
		r.helper.failConfigure = false;
		await r.runner.runOnce(task(), signal);
		expect(r.helper.configured).toHaveLength(0);
		r.advance(31_000);
		await r.runner.runOnce(task(), signal);
		expect(r.helper.configured).toHaveLength(1);
		expect(r.runner.reports()[0]).toMatchObject({ appliedVersion: 'v1', error: null });
	});

	test('a stale activation (newer version) is skipped until desired state catches up', async () => {
		const r = runnerWith({ version: 'v2' });
		await r.runner.runOnce(task('v1'), signal);
		expect(r.helper.configured).toEqual([]);
	});

	test('promotion holds the replica, reports once and releases it when it leaves desired state', async () => {
		const r = runnerWith();
		const promotion = { failoverId: 'dfo_1', databaseId: PRIMARY, replicaWorkloadId: REPLICA };
		const withReplica = state({
			databaseReplicaPromotions: [promotion],
			workloads: [
				{
					id: REPLICA,
					projectId: PRIMARY,
					projectSlug: 'orders',
					deploymentId: 'dbr_x',
					runtime: 'container',
					status: 'running',
					release: null,
					upstream: '127.0.0.1:15433',
					memoryMb: 256,
					cpus: 1,
					port: 15433,
					healthPath: '/',
					socketActivation: false,
					activationVersion: 'a'.repeat(64),
					env: {},
					secrets: [],
					dataSizeMb: null,
					database: { engine: 'postgres', version: '17', replica: { slot: SLOT } },
				},
			],
		});
		await r.runner.runOnce(withReplica, signal);
		await r.runner.runOnce(withReplica, signal);
		expect(r.helper.promoted).toEqual([REPLICA]);
		expect(r.held).toEqual([REPLICA]);
		expect(r.runner.pendingPromotionResults()).toEqual([{ failoverId: 'dfo_1', status: 'ok', lsn: '0/5000060' }]);
		r.runner.acknowledgePromotions(['dfo_1']);
		expect(r.runner.pendingPromotionResults()).toEqual([]);
		await r.runner.runOnce(withReplica, signal);
		expect(r.helper.promoted).toHaveLength(1);
		// Re-pointed: the replica is gone from desired state, so the hold is released.
		await r.runner.runOnce(state(), signal);
		expect(r.held).toEqual([]);
	});

	test('a failed promotion releases the replica at once and reports the error', async () => {
		const r = runnerWith();
		r.helper.failPromote = true;
		await r.runner.runOnce(
			state({ databaseReplicaPromotions: [{ failoverId: 'dfo_2', databaseId: PRIMARY, replicaWorkloadId: REPLICA }] }),
			signal,
		);
		expect(r.held).toEqual([]);
		expect(r.runner.pendingPromotionResults()).toEqual([{ failoverId: 'dfo_2', status: 'failed', error: 'target exists' }]);
	});

	test('the replica slot reaches the helper request', () => {
		const forwarded = withOptionalSpec({
			id: REPLICA,
			projectId: PRIMARY,
			projectSlug: 'orders',
			deploymentId: 'dbr_x',
			runtime: 'container',
			status: 'running',
			release: null,
			upstream: '127.0.0.1:15433',
			memoryMb: 256,
			cpus: 1,
			port: 15433,
			healthPath: '/',
			socketActivation: false,
			activationVersion: 'a'.repeat(64),
			env: {},
			secrets: [],
			dataSizeMb: null,
			database: { engine: 'postgres', version: '17', replica: { slot: SLOT } },
		});
		expect(forwarded.database).toEqual({ engine: 'postgres', version: '17', replica: { slot: SLOT } });
	});

	test('the PITR profile reaches the helper request (WAL archiving depends on it)', () => {
		const forwarded = withOptionalSpec({
			id: PRIMARY,
			projectId: PRIMARY,
			projectSlug: 'orders',
			deploymentId: 'db_x',
			runtime: 'container',
			status: 'running',
			release: null,
			upstream: '127.0.0.1:15432',
			memoryMb: 256,
			cpus: 1,
			port: 15432,
			healthPath: '/',
			socketActivation: false,
			activationVersion: 'b'.repeat(64),
			env: {},
			secrets: [],
			dataSizeMb: null,
			database: { engine: 'postgres', version: '18', tls: true, pitr: { stanza: 'orders', archiveTimeoutSeconds: 60 } },
		});
		expect(forwarded.database).toEqual({
			engine: 'postgres',
			version: '18',
			tls: true,
			pitr: { stanza: 'orders', archiveTimeoutSeconds: 60 },
		});
	});
});
