import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatSchema, type MetricBucket } from '@skiff/contracts';
import { createDb, migrate } from '@skiff/db';
import { Database } from 'bun:sqlite';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { isPromoteSpike } from './maintenance.ts';
import { LocalObjectStore } from './object-store.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';
import { migrations } from '../../db/src/migrations.ts';
import type { Core } from './index.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), 'skiff-promotion-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
// Minute-aligned so telemetry buckets and promote minutes line up predictably.
let clock = Math.floor(Date.parse('2026-11-03T12:00:00Z') / MINUTE) * MINUTE;
const alerts: Array<{ key: string; title: string; detail: string; severity: string }> = [];

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
		notifiers: [{ name: 'capture', notify: async (alert) => void alerts.push(alert) }],
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const telemetry = testTelemetryStore();

beforeAll(async () => {
	await telemetry.open();
	core.ctx.telemetry = telemetry;
});

afterAll(async () => {
	await disposeTelemetryStore(telemetry);
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function project(slug: string) {
	await core.projects.create(owner, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(owner, slug);
}

async function deploy(slug: string, body: string, promote = true) {
	clock += 1_000;
	return core.uploads.deployInline(owner, core.projects.requireRow(owner, slug), [file('index.html', body)], { promote });
}

const production = (slug: string) => core.projects.requireRow(owner, slug).productionDeploymentId;

describe('promotion history', () => {
	test('rollback skips previews that were never promoted', async () => {
		await project('history');
		const v1 = await deploy('history', 'v1');
		const preview = await deploy('history', 'preview', false);
		const v2 = await deploy('history', 'v2');
		expect(production('history')).toBe(v2.id);

		const rolled = await core.deployments.rollback(owner, core.projects.requireRow(owner, 'history'));
		expect(rolled.id).toBe(v1.id);
		expect(rolled.id).not.toBe(preview.id);
		expect(production('history')).toBe(v1.id);
	});

	test('repeated rollbacks keep walking back instead of toggling', async () => {
		await project('walkback');
		const a = await deploy('walkback', 'a');
		const b = await deploy('walkback', 'b');
		const c = await deploy('walkback', 'c');
		expect(production('walkback')).toBe(c.id);
		expect((await core.deployments.rollback(owner, core.projects.requireRow(owner, 'walkback'))).id).toBe(b.id);
		expect((await core.deployments.rollback(owner, core.projects.requireRow(owner, 'walkback'))).id).toBe(a.id);
		await expect(core.deployments.rollback(owner, core.projects.requireRow(owner, 'walkback'))).rejects.toMatchObject({
			code: 'conflict',
		});
		// An explicit promote is new history: rolling back from it goes to the most recently
		// promoted deployment before it (b), never to an unpromoted preview.
		clock += 1_000;
		await core.deployments.promote(owner, core.projects.requireRow(owner, 'walkback'), c.id);
		expect((await core.deployments.rollback(owner, core.projects.requireRow(owner, 'walkback'))).id).toBe(b.id);
	});

	test('rollback with only previews to go to is a clear conflict', async () => {
		await project('lonely');
		await deploy('lonely', 'live');
		await deploy('lonely', 'preview', false);
		await expect(core.deployments.rollback(owner, core.projects.requireRow(owner, 'lonely'))).rejects.toThrow(
			/No earlier production deployment/,
		);
	});

	test('deleting production falls back to the previously promoted deployment, never a preview', async () => {
		await project('fallback');
		const live1 = await deploy('fallback', 'one');
		await deploy('fallback', 'preview', false);
		const live2 = await deploy('fallback', 'two');
		await core.deployments.delete(owner, core.projects.requireRow(owner, 'fallback'), live2.id);
		expect(production('fallback')).toBe(live1.id);
		await core.deployments.delete(owner, core.projects.requireRow(owner, 'fallback'), live1.id);
		expect(production('fallback')).toBeNull();
	});
});

describe('migration backfill', () => {
	test('promoted_at is backfilled from the audit log and the current production pointer', () => {
		const db = new Database(':memory:');
		const before = migrations.filter((migration) => migration.id < '0004');
		db.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		for (const migration of before) {
			db.run(migration.sql);
			db.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [migration.id, 0]);
		}
		const insertDeployment = (id: string, createdAt: number) =>
			db.run(
				`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, status, preview_host, created_by, created_at)
				 VALUES (?, 'org', 'prj', 'rel', 'cfg', ?, 'active', ?, 'u', ?)`,
				[id, id, `${id}.test`, createdAt],
			);
		insertDeployment('d_old', 100);
		insertDeployment('d_preview', 200);
		insertDeployment('d_live', 300);
		db.run(
			`INSERT INTO projects (id, org_id, slug, name, created_by, production_deployment_id, created_at, updated_at)
			 VALUES ('prj', 'org', 'proj', 'Proj', 'u', 'd_live', 0, 0)`,
		);
		const audit = (id: string, action: string, resourceId: string, args: unknown, at: number) =>
			db.run(
				`INSERT INTO audit_log (id, org_id, actor_type, action, resource, resource_id, args_json, result, created_at)
				 VALUES (?, 'org', 'user', ?, 'deployment', ?, ?, 'ok', ?)`,
				[id, action, resourceId, JSON.stringify(args), at],
			);
		audit('a1', 'deployment.create', 'd_old', { promote: true }, 101);
		audit('a2', 'deployment.create', 'd_preview', { promote: false }, 201);

		expect(migrate(db)).toContain('0004_deployment_promoted_at.sql');
		const promotedAt = (id: string) =>
			db.query<{ promoted_at: number | null }, [string]>('SELECT promoted_at FROM deployments WHERE id = ?').get(id)
				?.promoted_at;
		expect(promotedAt('d_old')).toBe(101);
		expect(promotedAt('d_preview')).toBeNull();
		expect(promotedAt('d_live')).toBe(300);
		db.close();
	});
});

function bucket(host: string, at: number, requests: number, status5xx: number): MetricBucket {
	return {
		host,
		projectId: null,
		bucket: new Date(at).toISOString(),
		requests,
		status2xx: requests - status5xx,
		status3xx: 0,
		status4xx: 0,
		status5xx,
		bytes: 0,
		durationP50Ms: 1,
		durationP95Ms: 2,
		topPaths: [],
		topReferrers: [],
	};
}

describe('5xx spike after promote', () => {
	test('the rule needs traffic, a real error rate and a clear regression', () => {
		expect(isPromoteSpike({ requests: 100, status5xx: 0 }, { requests: 10, status5xx: 10 })).toBeNull();
		expect(isPromoteSpike({ requests: 100, status5xx: 0 }, { requests: 100, status5xx: 4 })).toBeNull();
		expect(isPromoteSpike({ requests: 100, status5xx: 0 }, { requests: 100, status5xx: 5 })).toMatchObject({
			afterRatio: 0.05,
		});
		expect(isPromoteSpike({ requests: 100, status5xx: 10 }, { requests: 100, status5xx: 15 })).toBeNull();
		expect(isPromoteSpike({ requests: 100, status5xx: 10 }, { requests: 100, status5xx: 20 })).not.toBeNull();
		expect(isPromoteSpike({ requests: 0, status5xx: 0 }, { requests: 50, status5xx: 50 })).not.toBeNull();
	});

	test.skipIf(!hasClickHouse)('alerts once when production starts failing after a promote', async () => {
		clock = Math.ceil(clock / MINUTE) * MINUTE + 10 * MINUTE;
		await project('spiky');
		const host = 'spiky.sites.test';
		// Healthy traffic in the 5 minutes before the promote.
		await telemetry.ingest([1, 2, 3, 4, 5].map((n) => bucket(host, clock - n * MINUTE, 40, 0)));
		const bad = await deploy('spiky', 'broken');
		clock += 4 * MINUTE;
		const promoteMinute = Math.floor((clock - 4 * MINUTE) / MINUTE) * MINUTE;
		await telemetry.ingest([0, 1, 2, 3].map((n) => bucket(host, promoteMinute + n * MINUTE, 40, 12)));

		const key = `promote_5xx:${bad.id}`;
		expect((await core.maintenance.run()).alertsFired).toContain(key);
		const alert = alerts.find((entry) => entry.key === key)!;
		expect(alert.severity).toBe('critical');
		expect(alert.detail).toContain(bad.shortId);
		expect(alert.detail).toContain('rollback');
		// Fires once per deployment, even after the notifier cooldown would allow a repeat.
		clock += 31 * MINUTE;
		expect((await core.maintenance.run()).alertsFired).not.toContain(key);
	});

	test.skipIf(!hasClickHouse)('stays quiet when errors were already as bad before the promote', async () => {
		await project('steady');
		const host = 'steady.sites.test';
		await telemetry.ingest([1, 2, 3].map((n) => bucket(host, clock - n * MINUTE, 40, 10)));
		const dep = await deploy('steady', 'same');
		clock += 3 * MINUTE;
		const promoteMinute = Math.floor((clock - 3 * MINUTE) / MINUTE) * MINUTE;
		await telemetry.ingest([0, 1, 2].map((n) => bucket(host, promoteMinute + n * MINUTE, 40, 12)));
		expect((await core.maintenance.run()).alertsFired).not.toContain(`promote_5xx:${dep.id}`);
	});
});

describe('certificate expiry', () => {
	function reportCerts(nodeId: string, token: string, certs: Array<{ host: string; notAfter: string }>) {
		core.nodes.heartbeat(
			token,
			heartbeatSchema.parse({
				nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 0,
				status: 'online',
				caddyOk: true,
				stats: { certs },
			}),
		);
	}

	test('warns under 14 days, escalates under 3, once per certificate', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'tls-edge').token, name: 'tls-edge' });
		const iso = (ms: number) => new Date(ms).toISOString();
		const soon = iso(clock + 10 * DAY);
		reportCerts(node.nodeId, node.token, [
			{ host: '*.sites.test', notAfter: soon },
			{ host: 'sites.test', notAfter: iso(clock + 60 * DAY) },
		]);
		const first = await core.maintenance.run();
		expect(first.alertsFired).toContain(`cert:warning:*.sites.test:${soon}`);
		expect(first.alertsFired.some((key) => key.includes(':sites.test:'))).toBe(false);
		expect(alerts.find((entry) => entry.key === `cert:warning:*.sites.test:${soon}`)?.severity).toBe('warning');

		clock += 40 * MINUTE;
		reportCerts(node.nodeId, node.token, [{ host: '*.sites.test', notAfter: soon }]);
		expect((await core.maintenance.run()).alertsFired.some((key) => key.startsWith('cert:'))).toBe(false);

		clock += 8 * DAY;
		reportCerts(node.nodeId, node.token, [{ host: '*.sites.test', notAfter: soon }]);
		const critical = await core.maintenance.run();
		expect(critical.alertsFired).toContain(`cert:critical:*.sites.test:${soon}`);

		// A renewed certificate clears the condition; nothing fires for it.
		const renewed = iso(clock + 90 * DAY);
		reportCerts(node.nodeId, node.token, [{ host: '*.sites.test', notAfter: renewed }]);
		expect((await core.maintenance.run()).alertsFired.some((key) => key.startsWith('cert:'))).toBe(false);
	});

	test('ignores malformed cert entries', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'odd').token, name: 'odd' });
		reportCerts(node.nodeId, node.token, [{ host: 'x.test', notAfter: 'not a date' }]);
		expect((await core.maintenance.run()).alertsFired.some((key) => key.includes('x.test'))).toBe(false);
	});
});
