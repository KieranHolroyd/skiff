import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { QUOTA_UNLIMITED, resolveQuota, quotaPercent } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-quota-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');
const alerts: Array<{ key: string; title: string; severity: string }> = [];

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
		notifiers: [
			{
				name: 'spy',
				notify: async (alert: { key: string; title: string; severity: string }) => {
					alerts.push(alert);
				},
			},
		],
	},
});

const ownerA = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner', platformAdmin: true });
const ownerB = buildPrincipal({ kind: 'user', userId: 'user_b', orgId: 'org_b', role: 'owner', platformAdmin: true });
const ownerIso = buildPrincipal({ kind: 'user', userId: 'user_iso', orgId: 'org_iso', role: 'owner', platformAdmin: true });

const MB = 1024 * 1024;

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('quota math and inheritance', () => {
	test('percent is null for unlimited and can exceed 100', () => {
		expect(quotaPercent(5, QUOTA_UNLIMITED)).toBeNull();
		expect(quotaPercent(5, 10)).toBe(50);
		expect(quotaPercent(15, 10)).toBe(150);
	});

	test('project overrides inherit every field that is not set', () => {
		const base = {
			projects: 10,
			storageBytes: 100,
			retainedDeployments: 5,
			maxUploadBytes: 50,
			databases: 4,
			databaseStorageBytes: 1000,
			storageInstances: 2,
			storageObjects: 20,
			appVolumes: 1,
			appVolumeBytes: 100,
			jobs: 3,
			jobRunsPerDay: 30,
			buildsPerDay: 40,
			previews: 2,
			workloadMemoryMb: 512,
			egressBytes: 10_000,
		};
		const effective = resolveQuota(base, { databases: 1, egressBytes: null });
		expect(effective.databases).toBe(1);
		expect(effective.storageInstances).toBe(2);
		expect(effective.egressBytes).toBe(10_000);
	});

	test('the service resolves org base plus per-project overrides', async () => {
		core.ctx.quota.set('org_a', { databases: 3, databaseStorageBytes: 900 * MB });
		await core.projects.create(ownerA, { name: 'Quota math', slug: 'quota-math', runtime: 'static' } as never);
		const project = core.projects.requireRow(ownerA, 'quota-math');
		expect(project.slug).toBe('quota-math');
		core.ctx.quota.setProject('org_a', project.id, { databases: 1 });
		expect(core.ctx.quota.get('org_a').databases).toBe(3);
		expect(core.ctx.quota.effective('org_a', project.id).databases).toBe(1);
		expect(core.ctx.quota.effective('org_a').databases).toBe(3);
		expect(core.ctx.quota.overrides('org_a', project.id)).toEqual({ databases: 1 });
	});
});

describe('enforcement', () => {
	test('a node is available for placement', () => {
		const token = core.nodes.createJoinToken(ownerA, 'edge').token;
		core.nodes.join({ token, name: 'edge' });
		expect(core.nodes.list(ownerA).length).toBe(1);
	});

	test('database count and storage quotas refuse creates over the limit', () => {
		core.ctx.quota.set('org_a', { databases: 1, databaseStorageBytes: 1024 * MB });
		core.databases.create(ownerA, { name: 'db-one', storageMb: 256 });
		expect(() => core.databases.create(ownerA, { name: 'db-two', storageMb: 256 })).toThrow(/Databases quota/);
		core.ctx.quota.set('org_a', { databases: -1, databaseStorageBytes: 400 * MB });
		expect(() => core.databases.create(ownerA, { name: 'db-three', storageMb: 256 })).toThrow(
			/Database storage quota/,
		);
	});

	test('resizing a database checks only the delta', () => {
		core.ctx.quota.set('org_a', { databases: -1, databaseStorageBytes: 1024 * MB });
		const db = core.databases.create(ownerA, { name: 'db-resize', storageMb: 256 });
		core.ctx.quota.set('org_a', { databaseStorageBytes: 768 * MB });
		expect(() => core.databases.update(ownerA, db.name, { storageMb: 1024 })).toThrow(/Database storage quota/);
		expect(core.databases.update(ownerA, db.name, { storageMb: 512 }).storageMb).toBe(512);
	});

	test('storage instance count is enforced', () => {
		core.ctx.quota.set('org_a', { storageInstances: 1, storageBytes: 1024 * MB });
		core.storage.create(ownerA, { name: 'store-one', storageMb: 256, memoryMb: 256 });
		expect(() => core.storage.create(ownerA, { name: 'store-two', storageMb: 256, memoryMb: 256 })).toThrow(
			/Object storage instances quota/,
		);
	});

	test('memory quota covers databases and schema-only volume quotas still assert', () => {
		core.ctx.quota.set('org_a', { storageInstances: -1, databaseStorageBytes: -1, workloadMemoryMb: 256 });
		expect(() => core.databases.create(ownerA, { name: 'db-memory', memoryMb: 256, storageMb: 256 })).toThrow(
			/Workload memory quota/,
		);
		core.ctx.quota.set('org_a', { workloadMemoryMb: -1, appVolumes: 0 });
		expect(() => core.ctx.quota.assertCanCreateVolume('org_a', null, 1)).toThrow(/App volumes quota/);
	});

	test('daily build counters use rows from the last 24 hours', () => {
		core.ctx.quota.set('org_a', { buildsPerDay: 1 });
		const project = core.projects.requireRow(ownerA, 'quota-math');
		opened.sqlite.run(
			'INSERT INTO builds (id, org_id, project_id, git_source_id, status, ref, promote, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
			['bld_test', 'org_a', project.id, 'git_test', 'queued', 'main', 1, 'user_a', clock],
		);
		expect(() => core.ctx.quota.assertCanCreateBuild('org_a', project.id)).toThrow(/Builds today quota/);
		clock += 25 * 3_600_000;
		expect(() => core.ctx.quota.assertCanCreateBuild('org_a', project.id)).not.toThrow();
	});
});

describe('usage aggregation', () => {
	test('counts, actual bytes and reserved memory are scoped to the org', async () => {
		clock = Date.parse('2026-11-05T10:00:00Z');
		core.ctx.quota.set('org_a', { databases: -1, databaseStorageBytes: -1, storageInstances: -1, buildsPerDay: -1 });
		await core.projects.create(ownerA, { name: 'Usage app', slug: 'usage-app', runtime: 'process' } as never);
		const project = core.projects.requireRow(ownerA, 'usage-app');
		const db = core.databases.create(ownerA, { name: 'db-usage', project: project.slug, storageMb: 256 });
		opened.sqlite.run('UPDATE databases SET size_bytes = ? WHERE id = ?', [128 * MB, db.id]);
		opened.sqlite.run(
			'INSERT INTO builds (id, org_id, project_id, git_source_id, status, ref, promote, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
			['bld_usage', 'org_a', project.id, 'git_test', 'queued', 'main', 1, 'user_a', clock],
		);
		const view = await core.usage.view(ownerA, { projectSlug: project.slug });
		expect(view.orgId).toBe('org_a');
		expect(view.projectId).toBe(project.id);
		expect(view.metrics.projects.used).toBe(1);
		expect(view.metrics.databases.used).toBe(1);
		expect(view.metrics.databaseStorageBytes.used).toBe(128 * MB);
		expect(view.metrics.buildsPerDay.used).toBeGreaterThan(0);
		// The hard-limit value remains the configured budget, not the sampled size.
		expect(core.ctx.quota.snapshotCounts('org_a', project.id).databaseStorageBytes).toBeGreaterThanOrEqual(256 * MB);
	});

	test('the view is cached for 60 seconds and then refreshed', async () => {
		const project = core.projects.requireRow(ownerA, 'usage-app');
		const first = await core.usage.view(ownerA, { projectSlug: project.slug });
		const db = core.databases.get(ownerA, 'db-usage');
		opened.sqlite.run('UPDATE databases SET size_bytes = ? WHERE id = ?', [256 * MB, db.id]);
		const cached = await core.usage.view(ownerA, { projectSlug: project.slug });
		expect(cached.metrics.databaseStorageBytes.used).toBe(first.metrics.databaseStorageBytes.used);
		clock += 61_000;
		const refreshed = await core.usage.view(ownerA, { projectSlug: project.slug });
		expect(refreshed.metrics.databaseStorageBytes.used).toBe(256 * MB);
	});

	test('CSV and history reflect the same metric keys', async () => {
		const view = await core.usage.view(ownerA);
		const csv = core.usage.csv(view);
		expect(csv).toContain('metric,unit,used,limit,percent');
		expect(csv).toContain('databaseStorageBytes,bytes');
		expect(csv.split('\n').filter(Boolean).length).toBe(15);
		const history = core.usage.history(ownerA);
		expect(history.orgId).toBe('org_a');
		expect(Array.isArray(history.points)).toBe(true);
	});

	test('another org cannot read this org usage or project', async () => {
		const other = await core.usage.view(ownerB);
		expect(other.orgId).toBe('org_b');
		expect(other.metrics.projects.used).toBe(0);
		expect(other.metrics.databases.used).toBe(0);
		expect(() => core.usage.quotas(ownerB, { projectSlug: 'quota-math' })).toThrow();
		expect(core.ctx.quota.getConfigured('org_b').databases).toBe(-1);
	});
});

describe('quota alerts', () => {
	test('80/95 alerts fire once per day, not every sweep', async () => {
		clock = Date.parse('2026-11-05T12:00:00Z');
		core.projects.create(ownerIso, { name: 'Alert app', slug: 'alert-app', runtime: 'static' } as never);
		core.ctx.quota.set('org_iso', { projects: 1 });
		alerts.length = 0;
		await core.maintenance.run();
		await core.maintenance.run();
		const quotaAlerts = alerts.filter((alert) => alert.title.includes('projects'));
		expect(quotaAlerts.length).toBe(1);
		expect(quotaAlerts[0]!.severity).toBe('warning');
	});
});
