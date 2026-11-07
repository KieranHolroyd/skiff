import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { brokerAlias, DEFAULT_FEATURES, observabilityQueryRequestSchema, workloadDesiredSchema } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, MetricsExporter } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';

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

const telemetry = testTelemetryStore({ now: () => clock });

afterAll(async () => {
	await disposeTelemetryStore(telemetry);
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

	test('node samples land in SQLite and ClickHouse, and feed /metrics and the store alert (D123)', async () => {
		const jobs = core.brokers.get(owner, 'jobs');
		expect(jobs).toMatchObject({ storeBytes: null, messages: null, statsAt: null });
		expect(core.brokers.queues(owner, 'jobs')).toEqual({ brokerId: jobs.id, name: 'jobs', at: null, truncated: false, streams: [] });
		if (hasClickHouse) core.ctx.telemetry = telemetry;

		const GIB2 = 2048 * 1024 * 1024;
		const sample = (minute: number, overrides: Record<string, unknown> = {}) => ({
			brokerId: jobs.id,
			bucket: new Date(clock - (3 - minute) * 60_000).toISOString(),
			up: true,
			connections: 2,
			streams: 2,
			consumers: 1,
			storeBytes: Math.round(GIB2 * 0.9) + minute,
			storeLimitBytes: GIB2,
			memoryStoreBytes: 0,
			messages: 40 + minute,
			pending: 30,
			ackPending: 2,
			redelivered: 1,
			oldestAgeSeconds: 120,
			published: 10,
			messagesIn: 12,
			messagesOut: 14,
			bytesIn: 1_000,
			bytesOut: 2_000,
			slowConsumers: 0,
			memoryBytes: 50_000_000,
			...overrides,
		});
		const listing = {
			brokerId: jobs.id,
			at: new Date(clock).toISOString(),
			truncated: false,
			streams: [
				{
					stream: 'SKIFF_Q_jobs',
					queue: 'jobs',
					subjects: ['skiff.q.jobs'],
					storage: 'file' as const,
					retention: 'workqueue',
					messages: 42,
					bytes: 4_200,
					maxBytes: null,
					firstAt: new Date(clock - 120_000).toISOString(),
					lastAt: new Date(clock).toISOString(),
					consumerCount: 1,
					pending: 30,
					ackPending: 2,
					redelivered: 1,
					consumers: [{ name: 'skiff-consumer', pending: 30, ackPending: 2, redelivered: 1, waiting: 1, lastDeliveredAt: null }],
				},
			],
		};

		// Another node cannot write this broker's numbers.
		expect(await core.brokers.ingestTelemetry('nod_other', [sample(1)], [listing])).toEqual({ stored: 0 });
		expect(core.brokers.get(owner, 'jobs').statsAt).toBeNull();

		const result = await core.brokers.ingestTelemetry(
			edgeId,
			[sample(1), sample(2), { ...sample(2), brokerId: 'mq_not_mine' }],
			[listing, { ...listing, brokerId: 'mq_not_mine' }],
		);
		expect(result.stored).toBe(hasClickHouse ? 2 : 0);
		expect(core.brokers.get(owner, 'jobs')).toMatchObject({
			storeBytes: Math.round(GIB2 * 0.9) + 2,
			messages: 42,
			statsAt: new Date(clock).toISOString(),
		});
		const queues = core.brokers.queues(owner, 'jobs');
		expect(queues.at).toBe(new Date(clock).toISOString());
		expect(queues.streams).toEqual([{ ...listing.streams[0]! }]);
		expect(() => core.brokers.queues(owner, 'missing')).toThrow(/not found/i);

		// A down sample does not overwrite the last good totals.
		await core.brokers.ingestTelemetry(edgeId, [sample(3, { up: false, storeBytes: 0, messages: 0 })], []);
		expect(core.brokers.get(owner, 'jobs').messages).toBe(42);

		// 90% of the store budget raises the built-in alert.
		const report = await core.maintenance.run();
		expect(report.alertsFired).toContain(`broker_store:${jobs.id}`);

		const text = await core.metricsExport.render(owner, MetricsExporter.scopeFromPath(['brokers', 'jobs']));
		const labels = `broker="jobs",broker_id="${jobs.id}"`;
		expect(text).toContain(`skiff_broker_info{${labels},engine="nats",version="2.12"} 1`);
		expect(text).toContain(`skiff_broker_storage_limit_bytes{${labels}} ${GIB2}`);
		expect(text).toContain(`skiff_broker_messages{${labels}} 42`);
		expect(text).toContain(`skiff_broker_stream_pending{${labels},stream="SKIFF_Q_jobs",queue="jobs"} 30`);
		expect(text).toContain(`skiff_broker_stream_oldest_message_age_seconds{${labels},stream="SKIFF_Q_jobs",queue="jobs"} 120`);
		expect(() => MetricsExporter.scopeFromPath(['brokers', 'jobs', 'extra'])).toThrow();
		await expect(core.metricsExport.render(owner, MetricsExporter.scopeFromPath(['brokers', 'nope']))).rejects.toThrow(/not found/i);
		// The broker section needs broker:read on top of metrics:read.
		const appsOnly = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', granted: ['metrics:read', 'project:read'] });
		expect(await core.metricsExport.render(appsOnly, MetricsExporter.scopeFromPath([]))).not.toContain('skiff_broker_');

		if (!hasClickHouse) return;
		expect(text).toContain(`skiff_broker_up{${labels}} 0`); // the newest sample was down
		expect(text).toContain(`skiff_broker_published_1h{${labels}} 30`);
		expect(text).toContain(`skiff_broker_messages_1h{${labels},direction="in"} 36`);

		const points = await core.brokers.metrics(owner, 'jobs', { from: clock - 3_600_000, to: clock, interval: '1m' });
		expect(points).toHaveLength(3);
		expect(points[0]).toMatchObject({ up: 1, connections: 2, pending: 30, published: 10, messagesIn: 12, storeLimitBytes: GIB2 });
		expect(points[2]).toMatchObject({ up: 0 });
		await telemetry.rollupHourly(clock - 2 * 3_600_000, clock + 3_600_000);
		const hourly = await core.brokers.metrics(owner, 'jobs', { from: clock - 3_600_000, to: clock, interval: '1h' });
		// 09:58 and 09:59 fall in the 09:00 hour; the down sample at 10:00 starts the next one.
		expect(hourly.map((point) => point.bucket)).toEqual(['2026-11-07T09:00:00.000Z', '2026-11-07T10:00:00.000Z']);
		expect(hourly[0]).toMatchObject({ up: 1, published: 20, messagesIn: 24, pending: 30, storeBytes: Math.round(GIB2 * 0.9) + 2 });
		expect(hourly[1]).toMatchObject({ up: 0 });

		// The query builder's `brokers` dataset is scoped to the caller's brokers.
		const utilization = await core.observability.query(
			owner,
			observabilityQueryRequestSchema.parse({
				range: { from: new Date(clock - 3_600_000).toISOString(), to: new Date(clock + 60_000).toISOString() },
				query: {
					mode: 'builder',
					builder: { dataset: 'brokers', metrics: [{ field: 'store_utilization', agg: 'max' }], groupBy: ['broker_id'], timeSeries: false },
				},
			}),
		);
		expect(JSON.stringify(utilization)).toContain(jobs.id);
		expect(JSON.stringify(utilization)).toContain('0.9');
		core.ctx.telemetry = undefined;
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

	test('credentials go to sessions and API keys with broker:credentials, never MCP, and are audited', () => {
		const credentials = core.brokers.credentials(owner, 'jobs');
		expect(credentials.url).toMatch(/^nats:\/\/jobs:[^@]+@127\.0\.0\.1:\d+$/);
		expect(credentials.connectionSnippets['nats.js']).toContain('NATS_URL');
		expect(credentials.note).toContain('unencrypted');
		// MCP never receives the secret, even with the permission granted.
		expect(() => core.brokers.credentials(agent, 'jobs')).toThrow(/never returned over MCP/);
		// The CLI authenticates with an API key: it reads credentials only when the key holds the permission.
		const cliKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', keyId: 'key_cli' });
		expect(core.brokers.credentials(cliKey, 'jobs').password).toBe(credentials.password);
		const narrowKey = buildPrincipal({
			kind: 'apiKey',
			userId: 'user_1',
			orgId: 'org_1',
			role: 'owner',
			keyId: 'key_narrow',
			granted: ['broker:read'],
		});
		expect(() => core.brokers.credentials(narrowKey, 'jobs')).toThrow(/broker:credentials/);
		const reads = core.audit.list({ orgId: 'org_1', action: 'broker.credentials' });
		expect(reads.length).toBe(2);
		expect(JSON.stringify(reads)).not.toContain(credentials.password);
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
