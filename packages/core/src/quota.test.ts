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
			registryBytes: -1,
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

	test('only a platform admin changes quotas, in core, with an audit entry', () => {
		const member = buildPrincipal({ kind: 'user', userId: 'user_a2', orgId: 'org_a', role: 'owner' });
		const original = core.ctx.quota.get('org_a').retainedDeployments;
		expect(() => core.usage.setQuotas(member, { retainedDeployments: 7 })).toThrow(/Platform admin required/);
		expect(() => core.usage.setQuotas(member, { databases: 2 }, { projectSlug: 'quota-math' })).toThrow(
			/Platform admin required/,
		);
		expect(() => core.usage.clearProjectQuotas(member, 'quota-math')).toThrow(/Platform admin required/);
		expect(core.ctx.quota.get('org_a').retainedDeployments).toBe(original);
		// A platform admin's API key (the CLI) may change quotas too.
		const adminKey = buildPrincipal({ kind: 'apiKey', userId: 'user_a', orgId: 'org_a', role: 'owner', platformAdmin: true });
		expect(core.usage.setQuotas(adminKey, { retainedDeployments: 7 }).base.retainedDeployments).toBe(7);
		const projectView = core.usage.setQuotas(ownerA, { databases: 2 }, { projectSlug: 'quota-math' });
		expect(projectView.overrides).toEqual({ databases: 2 });
		expect(projectView.effective.databases).toBe(2);
		expect(core.usage.clearProjectQuotas(ownerA, 'quota-math')).toEqual({ ok: true });
		expect(core.usage.quotas(ownerA, { projectSlug: 'quota-math' }).overrides).toEqual({});
		// The project still resolves inside the caller's org.
		expect(() => core.usage.setQuotas(ownerB, { databases: 2 }, { projectSlug: 'quota-math' })).toThrow();
		const actions = core.audit
			.list({ orgId: 'org_a', limit: 50 })
			.filter((entry) => entry.action.startsWith('quota.'))
			.map((entry) => `${entry.action}:${entry.resource}`);
		expect(actions).toEqual(expect.arrayContaining(['quota.set:org', 'quota.set:project', 'quota.clear:project']));
		core.usage.setQuotas(ownerA, { retainedDeployments: original });
		core.ctx.quota.setProject('org_a', core.projects.requireRow(ownerA, 'quota-math').id, { databases: 1 });
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
		expect(csv.split('\n').filter(Boolean).length).toBe(16);
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

describe('previews, jobs and egress', () => {
	const ownerP = buildPrincipal({ kind: 'user', userId: 'user_p', orgId: 'org_p', role: 'owner', platformAdmin: true });
	const page = (body: string) => [{ path: 'index.html', content: body, encoding: 'utf8' as const }];
	/** Traffic store stand-in: `query` returns the given bytes; anything else reads as empty. */
	const fakeTelemetry = (bytes: () => number, queries: unknown[] = []) =>
		new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (prop === 'then') return undefined;
					if (prop === 'ready') return async () => true;
					if (prop === 'query')
						return async (input: unknown) => {
							queries.push(input);
							return [{ bytes: bytes() / 2 }, { bytes: bytes() / 2 }];
						};
					return async () => [];
				},
			},
		) as never;
	let previewId = '';
	let pastProductionId = '';

	test('promote-on-deploy history is not a preview; promote: false deploys are capped', async () => {
		clock = Date.parse('2026-11-06T10:00:00Z');
		await core.projects.create(ownerP, { name: 'Preview app', slug: 'preview-app', runtime: 'static' } as never);
		const project = () => core.projects.requireRow(ownerP, 'preview-app');
		core.ctx.quota.set('org_p', { previews: 1 });
		// Three production deploys leave two past releases: rollback history, not previews.
		for (const body of ['one', 'two', 'three'])
			pastProductionId = (await core.uploads.deployInline(ownerP, project(), page(body))).id;
		expect(core.ctx.quota.snapshotCounts('org_p').previews).toBe(0);
		previewId = (await core.uploads.deployInline(ownerP, project(), page('pr-1'), { promote: false })).id;
		expect(core.ctx.quota.snapshotCounts('org_p').previews).toBe(1);
		await expect(core.uploads.deployInline(ownerP, project(), page('pr-2'), { promote: false })).rejects.toThrow(
			/Previews quota \(previews\) exceeded: 2 used of 1/,
		);
		// A production deploy still goes through at the cap.
		await core.uploads.deployInline(ownerP, project(), page('four'));
		const view = await core.usage.view(ownerP);
		expect(view.metrics.previews).toMatchObject({ used: 1, limit: 1, percent: 100 });
	});

	test('a refused preview deploy reports the 409 quota_exceeded shape', async () => {
		const project = core.projects.requireRow(ownerP, 'preview-app');
		const error = await core.uploads
			.deployInline(ownerP, project, page('pr-3'), { promote: false })
			.catch((caught: unknown) => caught as { code: string; status: number });
		expect(error).toMatchObject({ code: 'quota_exceeded', status: 409 });
	});

	test('promoting a preview frees its slot; moving a staging pointer off one adds a preview', async () => {
		const project = () => core.projects.requireRow(ownerP, 'preview-app');
		await core.deployments.promote(ownerP, project(), previewId);
		expect(core.ctx.quota.snapshotCounts('org_p').previews).toBe(0);
		core.environments.create(ownerP, project(), { name: 'Staging' } as never);
		await core.uploads.deployInline(ownerP, project(), page('staging-1'), { environment: 'staging' });
		expect(core.ctx.quota.snapshotCounts('org_p').previews).toBe(0);
		// The second staging deploy turns the first into a preview, filling the quota of 1.
		await core.uploads.deployInline(ownerP, project(), page('staging-2'), { environment: 'staging' });
		expect(core.ctx.quota.snapshotCounts('org_p').previews).toBe(1);
		await expect(
			core.uploads.deployInline(ownerP, project(), page('staging-3'), { environment: 'staging' }),
		).rejects.toThrow(/Previews quota/);
		core.ctx.quota.set('org_p', { previews: -1 });
	});

	test('job quotas count through the registered counters', () => {
		core.ctx.quota.set('org_p', { jobs: 2, jobRunsPerDay: 3 });
		// Nothing registered: usage reads 0, so only a limit of 0 refuses.
		expect(() => core.ctx.quota.assertCanCreateJob('org_p', null)).not.toThrow();
		const seen: Array<{ orgId: string; projectId: string | null; since: number }> = [];
		core.ctx.quota.registerCounter('jobs', (scope) => {
			seen.push(scope);
			return scope.orgId === 'org_p' ? 2 : 0;
		});
		core.ctx.quota.registerCounter('jobRunsPerDay', (scope) => (scope.since === clock - 86_400_000 ? 3 : 0));
		expect(() => core.ctx.quota.assertCanCreateJob('org_p', null)).toThrow(/Jobs quota \(jobs\) exceeded: 3 used of 2/);
		expect(() => core.ctx.quota.assertCanRunJob('org_p', null)).toThrow(/Job runs today quota \(jobRunsPerDay\)/);
		expect(() => core.ctx.quota.assertCanCreateJob('org_b', null)).not.toThrow();
		expect(seen[0]).toMatchObject({ orgId: 'org_p', projectId: null });
		const counts = core.ctx.quota.snapshotCounts('org_p');
		expect(counts.jobs).toBe(2);
		expect(counts.jobRunsPerDay).toBe(3);
		core.ctx.quota.set('org_p', { jobs: -1, jobRunsPerDay: -1 });
	});

	test('over the egress quota new deploys are refused; under it they go through', async () => {
		const project = () => core.projects.requireRow(ownerP, 'preview-app');
		let bytes = 2 * 1024 * MB;
		const queries: unknown[] = [];
		core.ctx.telemetry = fakeTelemetry(() => bytes, queries);
		core.ctx.quota.set('org_p', { egressBytes: 1024 * MB });
		clock += 61_000;
		const error = await core.uploads
			.deployInline(ownerP, project(), page('egress'))
			.catch((caught: unknown) => caught as { code: string; status: number; message: string });
		expect(error).toMatchObject({ code: 'quota_exceeded', status: 409 });
		expect((error as { message: string }).message).toContain('Egress quota (egressBytes) exceeded: 2.00 GB');
		expect((error as { message: string }).message).toContain('Running sites keep serving');
		// Rollback and promote are the recovery path and stay available.
		await expect(core.deployments.promote(ownerP, project(), pastProductionId)).resolves.toBeDefined();
		const view = await core.usage.view(ownerP);
		expect(view.metrics.egressBytes).toMatchObject({ used: 2 * 1024 * MB, limit: 1024 * MB, percent: 200 });
		expect(view.warnings.map((warning) => warning.metric)).toContain('egressBytes');
		// The total is cached for 60 seconds, then re-read.
		bytes = 512 * MB;
		clock += 61_000;
		await expect(core.uploads.deployInline(ownerP, project(), page('egress-ok'))).resolves.toBeDefined();
		expect(queries.length).toBeGreaterThanOrEqual(2);
		core.ctx.telemetry = undefined;
		core.ctx.quota.set('org_p', { egressBytes: -1 });
	});

	test('egress at 80% raises the quota warning alert', async () => {
		core.ctx.telemetry = fakeTelemetry(() => 900 * MB);
		core.ctx.quota.set('org_p', { egressBytes: 1024 * MB });
		clock += 86_400_000;
		alerts.length = 0;
		await core.maintenance.run();
		const egress = alerts.filter((alert) => alert.title.includes('egressBytes'));
		expect(egress.length).toBe(1);
		expect(egress[0]!.title).toContain('80%');
		expect(egress[0]!.severity).toBe('warning');
		core.ctx.telemetry = undefined;
		core.ctx.quota.set('org_p', { egressBytes: -1 });
	});
});
