import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { environmentSlugSchema, storageAlias, storageUserPolicy } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { TelemetryStore } from './telemetry.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-storage-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');

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
const telemetry = new TelemetryStore({ path: ':memory:', now: () => clock });
core.ctx.telemetry = telemetry;

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const agent = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['storage:read', 'storage:create', 'storage:update'],
});
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
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

afterAll(async () => {
	await telemetry.close();
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('managed object storage', () => {
	let edgeToken = '';
	let edgeId = '';
	let workerToken = '';
	let workerId = '';

	test('creates a private RustFS instance on the edge with a loopback port and buckets', () => {
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeToken = edge.token;
		edgeId = edge.nodeId;

		const st = core.storage.create(owner, { name: 'media', buckets: ['uploads', 'avatars'] });
		expect(st).toMatchObject({
			name: 'media',
			engine: 'rustfs',
			version: '1.0.4',
			nodeId: edgeId,
			memoryMb: 512,
			status: 'pending',
			public: false,
			publicUrl: null,
			region: 'us-east-1',
			internalEndpoint: { process: 'http://127.0.0.1:19000', container: `http://${storageAlias(st.id)}:9000` },
		});
		expect(st.id).toStartWith('st_');
		expect(st.buckets.map((bucket) => [bucket.name, bucket.access, bucket.state])).toEqual([
			['avatars', 'private', 'ready'],
			['uploads', 'private', 'ready'],
		]);
		expect(JSON.stringify(st)).not.toMatch(/secret/i);
		expect(core.storage.create(owner, { name: 'scratch' }).internalEndpoint.process).toBe('http://127.0.0.1:19001');
	});

	test('validates names, buckets and permissions', () => {
		expect(() => core.storage.create(owner, { name: 'media' })).toThrow(/already exists/);
		expect(() => core.storage.create(owner, { name: 'bad', buckets: ['Has.Dots'] })).toThrow();
		expect(() => core.storage.create(owner, { name: 'dupe', buckets: ['a-b', 'a-b'] })).toThrow(/unique/);
		expect(() => core.storage.create(owner, { name: 'tiny', memoryMb: 128 })).toThrow(/256/);
		expect(() => core.storage.create(viewer, { name: 'nope' })).toThrow();
		expect(() => core.storage.createBucket(owner, 'media', { name: 'uploads' })).toThrow(/already exists/);
		expect(environmentSlugSchema.safeParse('s3').success).toBe(false);
	});

	test('instances reserve slice memory alongside workloads', () => {
		const capacity = core.workloads.capacity(owner).find((row) => row.nodeId === edgeId);
		expect(capacity?.reservedMemoryMb).toBe(1024);
		expect(capacity?.workloadCount).toBe(2);
		expect(() => core.storage.update(owner, 'scratch', { memoryMb: 600 })).toThrow(/budget/);
		expect(core.storage.update(owner, 'scratch', { memoryMb: 256 }).memoryMb).toBe(256);
	});

	test('desired state carries the storage profile and buckets but never a secret key', async () => {
		const state = await core.nodes.desiredState(edgeToken);
		const entry = state.workloads.find((workload) => workload.projectSlug === 'media')!;
		expect(entry).toMatchObject({
			runtime: 'container',
			image: 'docker.io/rustfs/rustfs:1.0.4',
			port: 19000,
			upstream: '127.0.0.1:19000',
			healthPath: '/health',
			env: { RUSTFS_VOLUMES: '/data', RUSTFS_CONSOLE_ENABLE: 'false', RUSTFS_OBS_LOG_DIRECTORY: '' },
			objectStorage: {
				engine: 'rustfs',
				version: '1.0.4',
				buckets: [
					{ name: 'avatars', access: 'private' },
					{ name: 'uploads', access: 'private' },
				],
				users: [],
				deleteBuckets: [],
			},
		});
		const creds = core.storage.credentials(owner, 'media');
		expect(creds.accessKeyId).toMatch(/^SKR[A-Z2-7]{17}$/);
		expect(JSON.stringify(state)).not.toContain(creds.secretAccessKey);
		expect(state.storageRoutes).toEqual([]);

		const activation = core.workloads.activation(edgeId, entry.id);
		expect(activation.activationVersion).toBe(entry.activationVersion);
		expect(activation.env).toEqual({ RUSTFS_ACCESS_KEY: creds.accessKeyId, RUSTFS_SECRET_KEY: creds.secretAccessKey });
		expect(activation.storageAdmin).toMatchObject({
			rootAccessKeyId: creds.accessKeyId,
			rootSecretAccessKey: creds.secretAccessKey,
			port: 19000,
			keysVersion: entry.objectStorage!.keysVersion,
			users: {},
		});
		expect(() => core.workloads.activation('nod_other', entry.id)).toThrow();
	});

	test('credentials need storage:credentials and are audited', () => {
		expect(() => core.storage.credentials(viewer, 'media')).toThrow();
		expect(() => core.storage.credentials(agent, 'media')).toThrow();
		const creds = core.storage.credentials(owner, 'media');
		expect(creds).toMatchObject({ endpoint: 'http://127.0.0.1:19000', publicEndpoint: null, region: 'us-east-1' });
		const audit = core.audit.list({ orgId: 'org_1', action: 'storage.credentials' });
		expect(audit.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit)).not.toContain(creds.secretAccessKey);
	});

	test('attaching mints a scoped key, injects S3 env at activation and never restarts the instance', async () => {
		await core.projects.create(owner, {
			name: 'backend',
			slug: 'backend',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		await core.uploads.deployInline(
			owner,
			core.projects.requireRow(owner, 'backend'),
			[file('index.js', 'x'), file('package.json', '{}')],
			{ promote: true },
		);
		const stateBefore = await core.nodes.desiredState(edgeToken);
		const before = stateBefore.workloads.find((w) => w.projectSlug === 'backend')!;
		const mediaBefore = stateBefore.workloads.find((w) => w.projectSlug === 'media')!;

		expect(() =>
			core.storage.attach(owner, core.projects.requireRow(owner, 'backend'), {
				storage: 'media',
				grants: [{ bucket: 'missing' }],
			}),
		).toThrow(/no bucket/);
		const result = core.storage.attach(owner, core.projects.requireRow(owner, 'backend'), {
			storage: 'media',
			grants: [{ bucket: 'uploads' }],
		});
		expect(result.warning).toBeNull();
		expect(result.attachment.accessKeyId).toMatch(/^SKF[A-Z2-7]{17}$/);
		expect(result.attachment.envNames).toEqual([
			'S3_ENDPOINT_URL',
			'S3_ACCESS_KEY_ID',
			'S3_SECRET_ACCESS_KEY',
			'S3_REGION',
			'S3_FORCE_PATH_STYLE',
			'S3_BUCKET',
		]);

		const stateAfter = await core.nodes.desiredState(edgeToken);
		const after = stateAfter.workloads.find((w) => w.projectSlug === 'backend')!;
		const mediaAfter = stateAfter.workloads.find((w) => w.projectSlug === 'media')!;
		expect(after.activationVersion).not.toBe(before.activationVersion);
		// Keys change, the container does not.
		expect(mediaAfter.activationVersion).toBe(mediaBefore.activationVersion);
		expect(mediaAfter.objectStorage!.keysVersion).not.toBe(mediaBefore.objectStorage!.keysVersion);
		expect(mediaAfter.objectStorage!.users).toEqual([
			{ accessKeyId: result.attachment.accessKeyId, grants: [{ bucket: 'uploads', mode: 'read-write' }] },
		]);

		const env = core.workloads.activation(edgeId, after.id).env;
		expect(env).toMatchObject({
			S3_ENDPOINT_URL: 'http://127.0.0.1:19000',
			S3_ACCESS_KEY_ID: result.attachment.accessKeyId,
			S3_REGION: 'us-east-1',
			S3_FORCE_PATH_STYLE: 'true',
			S3_BUCKET: 'uploads',
		});
		expect(env.S3_PUBLIC_ENDPOINT_URL).toBeUndefined();
		const admin = core.workloads.activation(edgeId, mediaAfter.id).storageAdmin!;
		expect(admin.users[result.attachment.accessKeyId]).toBe(env.S3_SECRET_ACCESS_KEY);
		expect(admin.keysVersion).toBe(mediaAfter.objectStorage!.keysVersion);
		expect(JSON.stringify(stateAfter)).not.toContain(env.S3_SECRET_ACCESS_KEY!);

		// Grants can widen without a new key; two buckets drop the single-bucket var.
		const updated = core.storage.updateAttachment(owner, core.projects.requireRow(owner, 'backend'), 'media', {
			grants: [{ bucket: 'uploads' }, { bucket: 'avatars', mode: 'read' }],
		});
		expect(updated.accessKeyId).toBe(result.attachment.accessKeyId);
		expect(core.workloads.activation(edgeId, after.id).env.S3_BUCKET).toBeUndefined();
	});

	test('restart re-activates the container without touching buckets', async () => {
		const before = await core.nodes.desiredState(edgeToken);
		const beforeWorkload = before.workloads.find((item) => item.projectSlug === 'media')!;
		const restarted = core.storage.restart(owner, 'media');
		expect(restarted.message).toBe('Restart requested.');
		const after = await core.nodes.desiredState(edgeToken);
		const afterWorkload = after.workloads.find((item) => item.projectSlug === 'media')!;
		expect(afterWorkload.activationVersion).not.toBe(beforeWorkload.activationVersion);
		expect(afterWorkload.objectStorage?.buckets).toEqual(beforeWorkload.objectStorage?.buckets);
		expect(() => core.storage.restart(viewer, 'media')).toThrow(/storage:update/);
		expect(core.audit.list({ principal: owner, limit: 50 }).some((entry) => entry.action === 'storage.restart')).toBe(
			true,
		);
	});

	test('AWS prefix produces the SDK variable names', async () => {
		core.storage.createBucket(owner, 'scratch', { name: 'uploads' });
		const { attachment } = core.storage.attach(owner, core.projects.requireRow(owner, 'backend'), {
			storage: 'scratch',
			envPrefix: 'AWS',
			grants: [{ bucket: 'uploads' }],
		});
		const backend = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'backend')!;
		const env = core.workloads.activation(edgeId, backend.id).env;
		expect(env.AWS_ENDPOINT_URL).toBe('http://127.0.0.1:19001');
		expect(env.AWS_ACCESS_KEY_ID).toBe(attachment.accessKeyId);
		expect(env.AWS_SECRET_ACCESS_KEY).toBeString();
		expect(env.AWS_REGION).toBe('us-east-1');
		core.storage.detach(owner, core.projects.requireRow(owner, 'backend'), 'scratch');
	});

	test('public instances get a route on the edge and are reachable from other nodes', async () => {
		const worker = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'homelab').token, name: 'homelab' });
		workerToken = worker.token;
		workerId = worker.nodeId;
		core.nodes.update(owner, workerId, { publicAddress: '10.8.0.2:8080', sliceMemoryMb: 4096 });

		const photos = core.storage.create(owner, {
			name: 'photos',
			placement: workerId,
			public: true,
			buckets: ['originals'],
		});
		expect(photos.publicUrl).toBe('https://photos--s3.sites.test');
		const edgeState = await core.nodes.desiredState(edgeToken);
		expect(edgeState.storageRoutes).toEqual([
			{ storageId: photos.id, host: 'photos--s3.sites.test', upstream: 'http://10.8.0.2:8080' },
		]);
		const workerState = await core.nodes.desiredState(workerToken);
		expect(workerState.storageRoutes).toEqual([
			{ storageId: photos.id, host: 'photos--s3.sites.test', upstream: '127.0.0.1:19000' },
		]);
		expect(workerState.workloads.map((w) => w.projectSlug)).toEqual(['photos']);

		// The edge-placed backend uses it through the public URL; public storage never pins placement.
		core.storage.attach(owner, core.projects.requireRow(owner, 'backend'), {
			storage: 'photos',
			envPrefix: 'PHOTOS',
			grants: [{ bucket: 'originals', mode: 'read' }],
		});
		expect(core.workloads.attachmentNode(core.projects.requireRow(owner, 'backend').id)).toBe(edgeId);
		const backend = edgeState.workloads.find((w) => w.projectSlug === 'backend')!;
		const env = core.workloads.activation(edgeId, backend.id).env;
		expect(env.PHOTOS_ENDPOINT_URL).toBe('https://photos--s3.sites.test');
		expect(env.PHOTOS_PUBLIC_ENDPOINT_URL).toBe('https://photos--s3.sites.test');
		expect(env.PHOTOS_BUCKET).toBe('originals');

		// Going private would strand the remote consumer.
		expect(() => core.storage.update(owner, 'photos', { public: false })).toThrow(/another node/);
	});

	test('public hosts are global across orgs; private storage on another node is refused', () => {
		expect(() => core.storage.create(otherOrg, { name: 'photos', public: true })).toThrow(/already used/);
		const shadow = core.storage.create(otherOrg, { name: 'photos' });
		expect(() => core.storage.update(otherOrg, 'photos', { public: true })).toThrow(/already used/);
		expect(shadow.public).toBe(false);

		const privateWorker = core.storage.create(owner, { name: 'cold', placement: workerId, buckets: ['archive'] });
		expect(privateWorker.public).toBe(false);
		expect(() =>
			core.storage.attach(owner, core.projects.requireRow(owner, 'backend'), {
				storage: 'cold',
				envPrefix: 'COLD',
				grants: [{ bucket: 'archive' }],
			}),
		).toThrow(/another node/);
		expect(() => core.databases.create(owner, { name: 'cold-db', placement: workerId, project: 'backend' })).toThrow();
	});

	test('bucket policies and deletion go through desired state', async () => {
		core.storage.updateBucket(owner, 'media', 'avatars', { access: 'public-read' });
		expect(() => core.storage.deleteBucket(owner, 'media', 'uploads')).toThrow(/granted/);
		core.storage.createBucket(owner, 'media', { name: 'tmp' });

		// Non-empty according to the last snapshot: needs force.
		const media = core.storage.get(owner, 'media');
		await core.storage.ingestTelemetry(
			edgeId,
			[],
			[{ storageId: media.id, at: new Date(clock).toISOString(), buckets: [{ name: 'tmp', sizeBytes: 10, objects: 2 }] }],
		);
		expect(() => core.storage.deleteBucket(owner, 'media', 'tmp')).toThrow(/2 objects/);
		expect(() => core.storage.deleteBucket(agent, 'media', 'tmp', { force: true })).toThrow();
		expect(core.storage.deleteBucket(owner, 'media', 'tmp', { force: true }).state).toBe('deleting');

		let entry = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'media')!;
		expect(entry.objectStorage!.buckets.map((bucket) => bucket.name)).toEqual(['avatars', 'uploads']);
		expect(entry.objectStorage!.buckets[0]).toMatchObject({
			name: 'avatars',
			access: 'public-read',
			versioning: false,
			lifecycle: [],
			cors: [],
			quotaBytes: null,
			objectLock: null,
			configVersion: 2,
		});
		expect(entry.objectStorage!.deleteBuckets).toEqual([{ name: 'tmp', force: true }]);

		heartbeat(edgeToken, edgeId, { storageBucketDeletions: [{ storageId: media.id, bucket: 'tmp', result: 'deleted' }] });
		expect(core.storage.get(owner, 'media').buckets.map((bucket) => bucket.name)).toEqual(['avatars', 'uploads']);

		// A plain delete the node finds non-empty is blocked, then cancelled by re-creating it.
		core.storage.createBucket(owner, 'media', { name: 'logs' });
		core.storage.deleteBucket(owner, 'media', 'logs');
		heartbeat(edgeToken, edgeId, { storageBucketDeletions: [{ storageId: media.id, bucket: 'logs', result: 'not-empty' }] });
		expect(core.storage.get(owner, 'media').buckets.find((bucket) => bucket.name === 'logs')?.state).toBe('delete-blocked');
		entry = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'media')!;
		expect(entry.objectStorage!.deleteBuckets).toEqual([]);
		expect(core.storage.createBucket(owner, 'media', { name: 'logs' }).state).toBe('ready');
	});

	test('heartbeats drive status and telemetry lands in DuckDB and SQLite', async () => {
		const media = core.storage.get(owner, 'media');
		heartbeat(edgeToken, edgeId, { workloads: [{ id: media.id, status: 'running', restarts: 0 }] });
		expect(core.storage.get(owner, 'media').status).toBe('running');

		const sample = (minute: number) => ({
			storageId: media.id,
			bucket: new Date(clock - (3 - minute) * 60_000).toISOString(),
			up: true,
			usedBytes: 9_500_000_000 + minute,
			objects: 1200,
			bucketCount: 3,
			memoryBytes: 70_000_000,
		});
		const result = await core.storage.ingestTelemetry(
			edgeId,
			[sample(1), sample(2), { ...sample(3), storageId: 'st_not_mine' }],
			[
				{
					storageId: media.id,
					at: new Date(clock).toISOString(),
					buckets: [{ name: 'uploads', sizeBytes: 9_000_000_000, objects: 1200 }],
				},
			],
		);
		expect(result.stored).toBe(2);
		const view = core.storage.get(owner, 'media');
		expect(view.usedBytes).toBe(9_500_000_002);
		expect(view.buckets.find((bucket) => bucket.name === 'uploads')).toMatchObject({ sizeBytes: 9_000_000_000, objects: 1200 });

		const points = await core.storage.metrics(owner, 'media', { from: clock - 3_600_000, to: clock, interval: '1m' });
		expect(points).toHaveLength(2);
		expect(points[0]).toMatchObject({ objects: 1200, bucketCount: 3, up: 1 });
		expect(await telemetry.getPrometheusMetrics()).toContain(`skiff_storage_up{storage_id="${media.id}"} 1`);

		await telemetry.rollupHourly(clock - 2 * 3_600_000, clock + 3_600_000);
		const hourly = await core.storage.metrics(owner, 'media', { from: clock - 3_600_000, to: clock, interval: '1h' });
		expect(hourly[0]?.usedBytes).toBe(9_500_000_002);

		// 9.5 GB of a 10 GiB budget fires the usage alert.
		const report = await core.maintenance.run();
		expect(report.alertsFired).toContain(`storage_usage:${media.id}`);
	});

	test('delete is refused while attached, then soft, restorable and purged by the node', async () => {
		expect(() => core.storage.delete(owner, 'photos')).toThrow(/attached/);
		core.storage.detach(owner, core.projects.requireRow(owner, 'backend'), 'photos');
		const trashed = core.storage.delete(owner, 'photos');
		expect(trashed.deletedAt).not.toBeNull();
		let workerState = await core.nodes.desiredState(workerToken);
		expect(workerState.workloads.some((w) => w.id === trashed.id)).toBe(false);
		expect(workerState.storageRoutes).toEqual([]);
		// The public host stays reserved while trashed.
		expect(() => core.storage.update(otherOrg, 'photos', { public: true })).toThrow(/already used/);

		core.storage.restore(owner, 'photos');
		workerState = await core.nodes.desiredState(workerToken);
		expect(workerState.storageRoutes).toHaveLength(1);

		core.storage.delete(owner, 'photos');
		clock += 8 * 86_400_000;
		await core.maintenance.run();
		const id = core.storage.get(owner, 'photos', { includeDeleted: true }).id;
		workerState = await core.nodes.desiredState(workerToken);
		expect(workerState.storagePurges).toEqual([id]);
		expect(() => core.storage.restore(owner, 'photos')).toThrow(/purged/);

		heartbeat(workerToken, workerId, { purgedStorage: [id] });
		expect(() => core.storage.get(owner, 'photos', { includeDeleted: true })).toThrow(/not found/);
	});

	test('project purge drops its attachments, which revokes the keys on the node', async () => {
		await core.projects.softDelete(owner, 'backend');
		let entry = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'media')!;
		expect(entry.objectStorage!.users).toEqual([]);
		await core.projects.purgeNow(owner, 'backend');
		expect(core.storage.get(owner, 'media').attachments).toEqual([]);
		entry = (await core.nodes.desiredState(edgeToken)).workloads.find((w) => w.projectSlug === 'media')!;
		expect(entry.objectStorage!.users).toEqual([]);
	});

	test('scoped policies only reach the granted buckets', () => {
		const policy = storageUserPolicy([
			{ bucket: 'uploads', mode: 'read-write' },
			{ bucket: 'avatars', mode: 'read' },
		]) as { Statement: Array<{ Action: string[]; Resource: string[] }> };
		expect(policy.Statement[0]!.Resource).toEqual(['arn:aws:s3:::uploads', 'arn:aws:s3:::uploads/*']);
		expect(policy.Statement[0]!.Action).toContain('s3:PutObject');
		expect(policy.Statement[1]!.Action).not.toContain('s3:PutObject');
	});
});
