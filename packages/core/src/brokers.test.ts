import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { brokerAlias, DEFAULT_FEATURES, workloadDesiredSchema } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/** Managed queue brokers (docs/BROKERS.md, D111). */
const dir = mkdtempSync(join(tmpdir(), 'skiff-brokers-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:00Z');

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
		features: { ...DEFAULT_FEATURES },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const agent = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner', clientId: 'client_1' });
const GIB = 1024 ** 3;
const stats = {
	cpuPercent: 5,
	memoryBytes: GIB,
	memoryTotalBytes: 8 * GIB,
	diskUsedBytes: 10 * GIB,
	diskTotalBytes: 100 * GIB,
	diskFreeBytes: 90 * GIB,
	uptimeSeconds: 100,
	load1: 0.1,
	certs: [],
};

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('queue brokers', () => {
	let edgeId = '';
	let edgeToken = '';
	const heartbeat = (extra: Record<string, unknown> = {}) =>
		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			stats,
			releases: [],
			...extra,
		});

	test('a node whose agent does not advertise brokers is never a candidate', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeId = joined.nodeId;
		edgeToken = joined.token;
		core.nodes.update(owner, edgeId, { sliceMemoryMb: 4096 });
		heartbeat({ capabilities: ['functions'] });
		expect(() => core.brokers.create(owner, { name: 'jobs' })).toThrow(/No node supports queue brokers/);
		expect(() => core.brokers.create(owner, { name: 'jobs', placement: 'edge' })).toThrow(/does not support queue brokers/);
	});

	test('create places a NATS broker with its defaults and the fixed profile', async () => {
		heartbeat({ capabilities: ['functions', 'brokers'] });
		const broker = core.brokers.create(owner, { name: 'jobs' });
		expect(broker).toMatchObject({
			name: 'jobs',
			engine: 'nats',
			engineLabel: 'NATS',
			version: '2.12',
			status: 'pending',
			nodeId: edgeId,
			memoryMb: 256,
			cpus: 0.5,
			storageMb: 2048,
			username: 'jobs',
			upgradeVersions: [],
			internalHost: { container: `${brokerAlias(broker.id)}:4222` },
		});
		expect(broker.id).toMatch(/^mq_[0-9a-f]{32}$/);
		expect(broker.internalHost.process).toMatch(/^127\.0\.0\.1:142\d\d$/);
		expect(() => core.brokers.create(owner, { name: 'jobs' })).toThrow(/already exists/);

		const state = await core.nodes.desiredState(edgeToken);
		const desired = state.workloads.find((item) => item.id === broker.id)!;
		// The node reads the same shape the helper validates.
		expect(workloadDesiredSchema.parse(desired)).toMatchObject({
			runtime: 'container',
			status: 'running',
			image: 'docker.io/library/nats:2.12-alpine',
			broker: { engine: 'nats', version: '2.12', storageMb: 2048 },
			env: {},
		});
		// The password never rides desired state; only the activation carries it.
		const activation = core.workloads.activation(edgeId, broker.id);
		expect(Object.keys(activation.env).sort()).toEqual(['SKIFF_BROKER_PASSWORD', 'SKIFF_BROKER_USER']);
		expect(activation.env.SKIFF_BROKER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(JSON.stringify(state)).not.toContain(activation.env.SKIFF_BROKER_PASSWORD!);
		expect(() => core.workloads.activation('nod_other', broker.id)).toThrow(/another node/);
	});

	test('heartbeats drive status; a restart loop marks it failed', () => {
		const id = core.brokers.get(owner, 'jobs').id;
		heartbeat({ capabilities: ['brokers'], workloads: [{ id, status: 'running', restarts: 0 }] });
		expect(core.brokers.get(owner, 'jobs').status).toBe('running');
		heartbeat({ capabilities: ['brokers'], workloads: [{ id, status: 'running', restarts: 6 }] });
		expect(core.brokers.get(owner, 'jobs')).toMatchObject({ status: 'failed', message: 'Restart loop (6 restarts)' });
		heartbeat({ capabilities: ['brokers'], workloads: [{ id, status: 'running', restarts: 0 }] });
		expect(core.brokers.get(owner, 'jobs').status).toBe('running');
	});

	test('attach injects NATS_* for the runtime, re-activates the app and pins its node', async () => {
		await core.projects.create(owner, {
			name: 'shop',
			slug: 'shop',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(owner, 'shop');
		const before = core.brokers.consumerVersion(project.id, edgeId, 'container');
		expect(before).toBe('');
		const { attachment } = core.brokers.attach(owner, project, { broker: 'jobs' });
		expect(attachment).toMatchObject({
			envPrefix: 'NATS',
			envNames: ['NATS_URL', 'NATS_HOST', 'NATS_PORT', 'NATS_USER', 'NATS_PASSWORD'],
		});
		expect(() => core.brokers.attach(owner, project, { broker: 'jobs' })).toThrow(/already attached/);

		const broker = core.brokers.get(owner, 'jobs');
		const password = core.workloads.activation(edgeId, broker.id).env.SKIFF_BROKER_PASSWORD!;
		const container = core.brokers.consumerEnv(project.id, edgeId, 'container');
		expect(container).toEqual({
			NATS_URL: `nats://jobs:${encodeURIComponent(password)}@${brokerAlias(broker.id)}:4222`,
			NATS_HOST: brokerAlias(broker.id),
			NATS_PORT: '4222',
			NATS_USER: 'jobs',
			NATS_PASSWORD: password,
		});
		const process = core.brokers.consumerEnv(project.id, edgeId, 'process');
		expect(process.NATS_HOST).toBe('127.0.0.1');
		expect(process.NATS_PORT).toBe(broker.internalHost.process.split(':')[1]);
		// Another node gets nothing: the next deploy moves the app next to the broker.
		expect(core.brokers.consumerEnv(project.id, 'nod_other', 'process')).toEqual({});
		expect(core.brokers.consumerVersion(project.id, edgeId, 'container')).toHaveLength(64);
		expect(core.workloads.attachmentNode(project.id)).toBe(edgeId);
		expect(core.brokers.requiredNode(project.id)).toBe(edgeId);
	});

	test('static projects cannot use a broker (functions can, for queues)', async () => {
		await core.projects.create(owner, {
			name: 'site',
			slug: 'site',
			runtime: 'static',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(() => core.brokers.attach(owner, core.projects.requireRow(owner, 'site'), { broker: 'jobs' })).toThrow(
			/only process, container and function projects/,
		);
	});

	test('credentials are interactive-only and audited', () => {
		const credentials = core.brokers.credentials(owner, 'jobs');
		expect(credentials.url).toMatch(/^nats:\/\/jobs:[^@]+@127\.0\.0\.1:\d+$/);
		expect(credentials.connectionSnippets['nats.js']).toContain('NATS_URL');
		expect(credentials.note).toContain('unencrypted');
		expect(() => core.brokers.credentials(agent, 'jobs')).toThrow(/interactive user session/);
		expect(core.audit.list({ orgId: 'org_1' }).some((row) => row.action === 'broker.credentials')).toBe(true);
	});

	test('updates admit memory and only move versions forward', () => {
		expect(() => core.brokers.update(owner, 'jobs', { memoryMb: 32 })).toThrow();
		expect(() => core.brokers.update(owner, 'jobs', { memoryMb: 1_000_000 })).toThrow();
		expect(core.brokers.update(owner, 'jobs', { memoryMb: 512, storageMb: 4096 })).toMatchObject({
			memoryMb: 512,
			storageMb: 4096,
		});
		expect(() => core.brokers.update(owner, 'jobs', { version: '2.11' })).toThrow(/cannot be downgraded/);
		expect(() => core.brokers.update(owner, 'jobs', { version: '9.9' })).toThrow(/NATS versions/);
		const older = core.brokers.create(owner, { name: 'events', version: '2.11' });
		expect(older.upgradeVersions).toEqual(['2.12']);
		expect(core.brokers.update(owner, 'events', { version: '2.12' }).version).toBe('2.12');
	});

	test('restart bumps the activation and leaves a breadcrumb in the broker log', async () => {
		const id = core.brokers.get(owner, 'jobs').id;
		const before = (await core.nodes.desiredState(edgeToken)).workloads.find((item) => item.id === id)!;
		core.brokers.restart(owner, 'jobs');
		const after = (await core.nodes.desiredState(edgeToken)).workloads.find((item) => item.id === id)!;
		expect(after.activationVersion).not.toBe(before.activationVersion);
		const logs = core.logs.queryService(owner, 'broker', id);
		expect(logs.events.at(-1)).toMatchObject({ kind: 'broker', source: 'system' });
		expect(logs.events.at(-1)!.message).toContain('Restart requested');
	});

	test('runtime logs from the owning node land in the broker stream', () => {
		const id = core.brokers.get(owner, 'jobs').id;
		const stored = core.logs.appendRuntime(edgeId, {
			workloadId: id,
			lines: [{ ts: clock, stream: 'stderr', level: 'info', message: '[INF] Server is ready' }],
		});
		expect(stored).toBe(1);
		expect(core.logs.queryService(owner, 'broker', id, { q: 'ready' }).events).toHaveLength(1);
		expect(() =>
			core.logs.appendRuntime('nod_other', { workloadId: id, lines: [{ ts: clock, stream: 'stdout', level: 'info', message: 'x' }] }),
		).toThrow(/another node/);
	});

	test('delete is refused while attached, then trash → restore → purge', async () => {
		expect(() => core.brokers.delete(owner, 'jobs')).toThrow(/Detach it first/);
		core.brokers.detach(owner, core.projects.requireRow(owner, 'shop'), 'jobs');
		const id = core.brokers.get(owner, 'jobs').id;

		const deleted = core.brokers.delete(owner, 'jobs');
		expect(deleted.deletedAt).not.toBeNull();
		expect(core.brokers.list(owner).map((item) => item.name)).not.toContain('jobs');
		let state = await core.nodes.desiredState(edgeToken);
		expect(state.workloads.some((item) => item.id === id)).toBe(false);
		expect(state.brokerPurges).toEqual([]);

		expect(core.brokers.restore(owner, 'jobs').status).toBe('pending');
		core.brokers.delete(owner, 'jobs');
		core.brokers.purgeNow(owner, 'jobs');
		expect(() => core.brokers.restore(owner, 'jobs')).toThrow(/being purged/);
		state = await core.nodes.desiredState(edgeToken);
		expect(state.brokerPurges).toEqual([id]);

		heartbeat({ capabilities: ['brokers'], purgedBrokers: [id] });
		expect(core.brokers.list(owner, { includeDeleted: true }).map((item) => item.name)).not.toContain('jobs');
		expect(core.audit.list({ orgId: 'org_1' }).some((row) => row.action === 'broker.purged')).toBe(true);
	});

	test('expired trash is handed to the node by the maintenance sweep', () => {
		const id = core.brokers.delete(owner, 'events').id;
		clock += 30 * 86_400_000;
		expect(core.brokers.requestExpiredPurges()).toBe(1);
		expect(core.brokers.purgesForNode(edgeId)).toEqual([id]);
	});

	test('reserved memory counts toward node capacity', () => {
		core.brokers.create(owner, { name: 'fanout', memoryMb: 1024 });
		const capacity = core.workloads.capacityInternal().find((item) => item.nodeId === edgeId)!;
		expect(capacity.reservedMemoryMb).toBeGreaterThanOrEqual(1024);
	});
});
