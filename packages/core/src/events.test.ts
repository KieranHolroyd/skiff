import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, EVENT_EXPIRY_MS, decodeS3Key, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/** Event notifications into function queues (docs/EVENTS.md, D122). */
const dir = mkdtempSync(join(tmpdir(), 'yoal-events-'));
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
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
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

/** A RustFS webhook body for one record, as spiked on 1.0.4. */
function rustfsEvent(eventName: string, key: string, bucket = 'uploads', size = 8) {
	return JSON.stringify({
		EventName: eventName,
		Key: `${bucket}/${key}`,
		Records: [
			{
				eventVersion: '2.1',
				eventSource: 'rustfs:s3',
				awsRegion: 'us-east-1',
				eventTime: '2026-11-07T11:04:18.532Z',
				eventName,
				s3: {
					s3SchemaVersion: '1.0',
					configurationId: 'yoal',
					bucket: { name: bucket, arn: `arn:aws:s3:::${bucket}` },
					object: { key: encodeURIComponent(key), size, eTag: '82d23a757508346d5a74089eadddf9fa', contentType: 'image/jpeg' },
				},
			},
		],
	});
}

describe('event notifications', () => {
	let edgeId = '';
	let edgeToken = '';
	let storageId = '';

	test('setup: a node with brokers, a broker and a storage bucket', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeId = joined.nodeId;
		edgeToken = joined.token;
		core.nodes.update(owner, edgeId, { sliceMemoryMb: 8192 });
		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			stats,
			releases: [],
			capabilities: ['functions', 'brokers'],
		});
		core.brokers.create(owner, { name: 'events' });
		storageId = core.storage.create(owner, { name: 'media', buckets: ['uploads', 'other'] }).id;
	});

	test('a storage rule needs a real instance and bucket, and only storage fields', () => {
		expect(() => core.events.create(owner, { source: 'storage', broker: 'events', queue: 'images' })).toThrow(/storage instance/);
		expect(() => core.events.create(owner, { source: 'storage', storage: 'media', bucket: 'nope', broker: 'events', queue: 'images' })).toThrow(/Bucket "nope"/);
		expect(() => core.events.create(owner, { source: 'alerts', prefix: 'x/', broker: 'events', queue: 'images' })).toThrow(/only applies to storage/);
		expect(() => core.events.create(owner, { source: 'alerts', events: ['exploded'], broker: 'events', queue: 'images' })).toThrow(/not a alerts event/);
		expect(() => core.events.create(owner, { source: 'alerts', broker: 'events', queue: 'Bad_Name' })).toThrow(/Queue names/);
		expect(() => core.events.create(viewer, { source: 'alerts', broker: 'events', queue: 'pages' })).toThrow(/broker:update/);
	});

	test('watching a bucket turns on its notifications and the RustFS webhook target', async () => {
		const before = (await core.nodes.desiredState(edgeToken)).workloads.find((workload) => workload.id === storageId)!;
		expect(before.objectStorage!.buckets.every((bucket) => !bucket.notifications)).toBe(true);
		expect(Object.keys(before.env).some((key) => key.startsWith('RUSTFS_NOTIFY'))).toBe(false);

		const rule = core.events.create(owner, {
			source: 'storage',
			storage: 'media',
			bucket: 'uploads',
			events: ['object-create'],
			prefix: 'incoming/',
			suffix: '.jpg',
			broker: 'events',
			queue: 'images',
		});
		expect(rule).toMatchObject({ source: 'storage', events: ['object-create'], broker: 'events', queue: 'images', enabled: true });
		expect(rule.filter).toEqual({ storage: 'media', bucket: 'uploads', prefix: 'incoming/', suffix: '.jpg' });

		const after = (await core.nodes.desiredState(edgeToken)).workloads.find((workload) => workload.id === storageId)!;
		expect(after.objectStorage!.buckets.find((bucket) => bucket.name === 'uploads')!.notifications).toBe(true);
		expect(after.objectStorage!.buckets.find((bucket) => bucket.name === 'other')!.notifications).toBe(false);
		expect(after.env).toMatchObject({
			RUSTFS_NOTIFY_ENABLE: 'true',
			RUSTFS_NOTIFY_WEBHOOK_ENABLE_YOAL: 'on',
			RUSTFS_NOTIFY_WEBHOOK_ENDPOINT_YOAL: `https://control.test/api/webhooks/storage/${storageId}`,
		});
		// Switching notifications on restarts the instance once; the token is a secret.
		expect(after.activationVersion).not.toBe(before.activationVersion);
		expect(JSON.stringify(after)).not.toContain(core.events.storageNotifyToken(storageId));
		const activation = core.storage.activation(edgeId, storageId);
		expect(activation.activationVersion).toBe(after.activationVersion);
		expect(activation.env.RUSTFS_NOTIFY_WEBHOOK_AUTH_TOKEN_YOAL).toBe(core.events.storageNotifyToken(storageId));
	});

	test('the webhook needs the instance token, and filters by event, prefix and suffix', () => {
		const token = core.events.storageNotifyToken(storageId);
		const body = rustfsEvent('s3:ObjectCreated:Put', 'incoming/cat.jpg');
		expect(() => core.events.ingestStorage(storageId, null, body)).toThrow(/bad token/);
		expect(() => core.events.ingestStorage(storageId, 'Bearer wrong', body)).toThrow(/bad token/);
		expect(() => core.events.ingestStorage('st_missing', `Bearer ${token}`, body)).toThrow(/bad token/);

		expect(core.events.ingestStorage(storageId, `Bearer ${token}`, body)).toBe(1);
		// RustFS may send the bare token too.
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectCreated:CompleteMultipartUpload', 'incoming/big.jpg'))).toBe(1);
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectCreated:Put', 'incoming/notes.txt'))).toBe(0);
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectCreated:Put', 'elsewhere/cat.jpg'))).toBe(0);
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectRemoved:Delete', 'incoming/cat.jpg'))).toBe(0);
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectCreated:Put', 'incoming/cat.jpg', 'other'))).toBe(0);
		// Tagging and retention changes are not object events.
		expect(core.events.ingestStorage(storageId, token, rustfsEvent('s3:ObjectCreated:PutTagging', 'incoming/cat.jpg'))).toBe(0);

		const deliveries = core.events.deliveries(owner);
		expect(deliveries).toHaveLength(2);
		expect(deliveries.map((delivery) => delivery.type)).toEqual(['storage.object-create', 'storage.object-create']);
		// Cloudflare's R2 notification body, so an R2 consumer runs unchanged.
		expect(deliveries.find((delivery) => (delivery.body as { object: { key: string } }).object.key === 'incoming/cat.jpg')!.body).toEqual({
			account: 'org_1',
			action: 'PutObject',
			bucket: 'uploads',
			object: { key: 'incoming/cat.jpg', size: 8, eTag: '82d23a757508346d5a74089eadddf9fa' },
			eventTime: '2026-11-07T11:04:18.532Z',
			yoal: { type: 'storage.object-create', storage: 'media', eventName: 's3:ObjectCreated:Put' },
		});
		expect(decodeS3Key('incoming%2Fmy+cat.jpg')).toBe('incoming/my cat.jpg');
	});

	test('platform sources publish typed envelopes to every matching rule', () => {
		core.events.create(owner, { source: 'alerts', events: ['firing'], broker: 'events', queue: 'pages' });
		core.events.create(owner, { source: 'database-backups', broker: 'events', queue: 'backups' });
		core.events.emitAlert('org_1', 'alr_1', 'firing', { title: 'Site down' });
		core.events.emitAlert('org_1', 'alr_1', 'resolved', { title: 'Site down' });
		core.events.emitBackup('org_1', 'db_1', 'failed', { database: 'shop', error: 'disk full' });
		// Another org's events never match this org's rules.
		core.events.emitAlert('org_2', 'alr_9', 'firing', { title: 'Theirs' });

		const types = core.events.deliveries(owner).map((delivery) => delivery.type);
		expect(types.filter((type) => type === 'alerts.firing')).toHaveLength(1);
		expect(types).not.toContain('alerts.resolved');
		expect(types).toContain('database-backups.failed');
		const alert = core.events.deliveries(owner).find((delivery) => delivery.type === 'alerts.firing')!;
		expect(alert.body).toMatchObject({ type: 'alerts.firing', account: 'org_1', data: { title: 'Site down' } });
		expect((alert.body as { id: string }).id).toMatch(/^evt_/);
	});

	test('the broker node leases, publishes and acks; a failure backs off and later expires', () => {
		const pending = core.events.deliveries(owner, { status: 'pending' }).length;
		const lease = core.events.lease(edgeId);
		expect(lease.items).toHaveLength(pending);
		// (Plain checks: Bun's toMatchObject writes asymmetric matchers back into the object.)
		expect(lease.items.every((item) => item.brokerId.startsWith('mq_') && item.queue.length > 0)).toBe(true);
		// A second lease in the same window gets nothing: the rows are the first caller's.
		expect(core.events.lease(edgeId).items).toHaveLength(0);
		// Another node can never ack this node's deliveries.
		core.events.ack('nod_other', { results: lease.items.map((item) => ({ id: item.id, ok: true })) });
		expect(core.events.deliveries(owner, { status: 'delivered' })).toHaveLength(0);

		const [failed, ...rest] = lease.items;
		core.events.ack(edgeId, {
			results: [{ id: failed!.id, ok: false, error: 'nats: connection refused' }, ...rest.map((item) => ({ id: item.id, ok: true }))],
		});
		expect(core.events.deliveries(owner, { status: 'delivered' })).toHaveLength(rest.length);
		// Backoff: not leased again straight away, then retried once it is due.
		expect(core.events.lease(edgeId).items).toHaveLength(0);
		clock += 2_000;
		const retry = core.events.lease(edgeId);
		expect(retry.items.map((item) => item.id)).toEqual([failed!.id]);
		core.events.ack(edgeId, { results: [{ id: failed!.id, ok: false, error: 'still down' }] });

		const rule = core.events.list(owner).find((view) => view.queue === lease.items.find((item) => item.id === failed!.id)!.queue)!;
		expect(rule.lastError).toBe('still down');
		expect(rule.deliveries.pending).toBe(1);

		clock += EVENT_EXPIRY_MS;
		expect(core.events.sweep().expired).toBe(1);
		const gone = core.events.deliveries(owner, { status: 'failed' });
		expect(gone.map((delivery) => delivery.id)).toEqual([failed!.id]);
		expect(gone[0]!.attempts).toBe(2);
	});

	test('test sends one synthetic event; delete drops the rule and its pending deliveries', async () => {
		const rule = core.events.list(owner).find((view) => view.source === 'storage')!;
		const sent = core.events.test(owner, rule.id);
		expect(sent).toMatchObject({ type: 'storage.object-create', status: 'pending' });
		expect((sent.body as { object: { key: string } }).object.key).toBe('incoming/yoal-test-event.jpg');

		core.events.delete(owner, rule.id);
		expect(core.events.list(owner).some((view) => view.id === rule.id)).toBe(false);
		expect(core.events.deliveries(owner, { status: 'pending' }).some((delivery) => delivery.ruleId === rule.id)).toBe(false);
		// No rule watches the bucket any more: notifications switch off again.
		const storage = (await core.nodes.desiredState(edgeToken)).workloads.find((workload) => workload.id === storageId)!;
		expect(storage.objectStorage!.buckets.every((bucket) => !bucket.notifications)).toBe(true);
		expect(Object.keys(storage.env).some((key) => key.startsWith('RUSTFS_NOTIFY'))).toBe(false);
	});

	test('deployments emit created and promoted events', async () => {
		await core.projects.create(owner, {
			name: 'site',
			slug: 'site',
			runtime: 'static',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.events.create(owner, { source: 'deployments', project: 'site', broker: 'events', queue: 'deploys' });
		const project = core.projects.requireRow(owner, 'site');
		await core.uploads.deployInline(owner, project, [{ path: 'index.html', content: '<h1>hi</h1>', encoding: 'utf8' }], { promote: true });
		const created = core.events.deliveries(owner).find((delivery) => delivery.type === 'deployments.created')!;
		expect(created.body).toMatchObject({ type: 'deployments.created', data: { project: 'site', production: true, environment: 'production' } });
		expect((created.body as { data: { previewUrl: string } }).data.previewUrl).toMatch(/^https:\/\/site--.+\.sites\.test$/);
	});
});

describe('resource-scoped access', () => {
	test('a broker binding covers only rules that publish to it', () => {
		const visible = core.brokers.requireRow(owner, 'events');
		const hidden = core.brokers.create(owner, { name: 'scope-hidden' });
		const visibleRule = core.events.create(owner, { source: 'alerts', broker: visible.name, queue: 'scope-visible' });
		const hiddenRule = core.events.create(owner, { source: 'alerts', broker: hidden.name, queue: 'scope-hidden' });
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_scope_events', 'org_1', 'user', 'user_scope_events', 'viewer', 'broker', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({ kind: 'user', userId: 'user_scope_events', orgId: 'org_1', role: 'viewer' });
		expect(core.events.get(guest, visibleRule.id).id).toBe(visibleRule.id);
		expect(core.events.deliveries(guest, { ruleId: visibleRule.id })).toEqual([]);
		expect(() => core.events.get(guest, hiddenRule.id)).toThrow(/broker:read/);
		expect(() => core.events.deliveries(guest, { ruleId: hiddenRule.id })).toThrow(/broker:read/);
		// Listing every rule is an org-wide read, not one covered by a single-broker binding.
		expect(() => core.events.list(guest)).toThrow(/broker:read/);
	});
});
