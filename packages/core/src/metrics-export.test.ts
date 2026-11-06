import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, MetricsExporter } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-metrics-export-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-06T10:00:00Z');

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

const owner = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner' });
const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_a', role: 'owner', platformAdmin: true });
const other = buildPrincipal({ kind: 'user', userId: 'user_b', orgId: 'org_b', role: 'owner' });
const noMetrics = buildPrincipal({ kind: 'apiKey', userId: 'user_a', orgId: 'org_a', role: 'owner', granted: ['project:read'] });
const appsOnly = buildPrincipal({ kind: 'apiKey', userId: 'user_a', orgId: 'org_a', role: 'owner', granted: ['metrics:read', 'project:read'] });

const sqlite = opened.sqlite;
const render = (principal: Parameters<Core['metricsExport']['render']>[0], path: string[] = []) =>
	core.metricsExport.render(principal, MetricsExporter.scopeFromPath(path));

/** Every sample line must be `name{labels} value`, and every family must have one HELP and TYPE. */
function assertValidExposition(text: string): void {
	const seen = new Map<string, number>();
	for (const line of text.trimEnd().split('\n')) {
		if (line.startsWith('# TYPE ')) {
			const name = line.split(' ')[2]!;
			seen.set(name, (seen.get(name) ?? 0) + 1);
			continue;
		}
		if (line.startsWith('#')) continue;
		expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? [-+0-9.eNaInf]+$/);
	}
	for (const [name, count] of seen) expect({ name, count }).toEqual({ name, count: 1 });
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('metrics export', () => {
	test('setup: apps, a database, storage and a node', async () => {
		await core.projects.create(owner, { slug: 'blog' } as never);
		await core.projects.create(owner, { slug: 'shop' } as never);
		await core.projects.create(other, { slug: 'secret-app' } as never);
		const now = clock;
		sqlite.run(
			`INSERT INTO nodes (id, name, mode, status, token_hash, stats_json, last_heartbeat_at, created_at, updated_at)
			VALUES ('node_1', 'edge-1', 'edge', 'online', 'x', ?, ?, ?, ?)`,
			[JSON.stringify({ cpuPercent: 12.5, memoryBytes: 100, memoryTotalBytes: 400, certs: [{ host: '*.sites.test', notAfter: '2027-01-01T00:00:00Z' }] }), now, now, now],
		);
		sqlite.run(
			`INSERT INTO node_volumes (id, node_id, name, kind, source_key, mount_path, fs_type, status, size_bytes, free_bytes, created_by, created_at, updated_at)
			VALUES ('vol_1', 'node_1', 'data', 'filesystem', 'uuid:1', '/mnt/data', 'ext4', 'ready', 1000, 250, 'user_admin', ?, ?)`,
			[now, now],
		);
		sqlite.run(
			`INSERT INTO databases (id, org_id, name, engine_name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, status, size_bytes, created_by, created_at, updated_at)
			VALUES ('dbs_1', 'org_a', 'main', 'postgres', '17', 'node_1', 15432, 256, 'x', 'x', 'running', 4096, 'user_a', ?, ?)`,
			[now, now],
		);
		sqlite.run(
			`INSERT INTO databases (id, org_id, name, engine_name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, status, created_by, created_at, updated_at)
			VALUES ('dbs_2', 'org_b', 'theirs', 'postgres', '17', 'node_1', 15433, 256, 'x', 'x', 'running', 'user_b', ?, ?)`,
			[now, now],
		);
	});

	test('the bare /metrics without a key is the fleet summary plus nodes and volumes', async () => {
		const text = await render(undefined);
		assertValidExposition(text);
		expect(text).toContain('skiff_projects_total 3');
		expect(text).toContain('skiff_node_up{node="edge-1",mode="edge"} 1');
		expect(text).toContain('skiff_node_cpu_percent{node="edge-1"} 12.5');
		expect(text).toContain('skiff_node_cert_expiry_timestamp_seconds{node="edge-1",host="*.sites.test"} 1798761600');
		expect(text).toContain('skiff_volume_free_bytes{node="edge-1",volume="data",kind="filesystem"} 250');
		expect(text).not.toContain('skiff_project_info');
	});

	test('scoped paths and unauthenticated access to them', async () => {
		await expect(render(undefined, ['apps'])).rejects.toMatchObject({ status: 401 });
		await expect(render(noMetrics, ['apps'])).rejects.toThrow('metrics:read');
		await expect(render(appsOnly, ['databases'])).rejects.toThrow('database:read');
		// A key without database:read still gets the sections it can read.
		const partial = await render(appsOnly);
		expect(partial).toContain('skiff_project_info');
		expect(partial).not.toContain('skiff_database_info');
		await expect(render(owner, ['platform'])).rejects.toMatchObject({ status: 403 });
		expect(() => MetricsExporter.scopeFromPath(['nope'])).toThrow();
		expect(() => MetricsExporter.scopeFromPath(['usage', 'x'])).toThrow();
		expect(MetricsExporter.scopeFromPath(['projects', 'blog'])).toEqual({ section: 'apps', name: 'blog' });
	});

	test('an org scrape covers every section, and only that org', async () => {
		const text = await render(owner);
		assertValidExposition(text);
		expect(text).toContain('skiff_project_info{project="blog",name="blog"');
		expect(text).toContain('skiff_project_info{project="shop"');
		expect(text).toContain('skiff_quota_used{metric="projects",unit="count"} 2');
		expect(text).toContain('skiff_database_info{database="main",database_id="dbs_1",engine="postgres",version="17"} 1');
		expect(text).toContain('skiff_database_size_bytes{database="main",database_id="dbs_1"} 4096');
		expect(text).toContain('skiff_database_memory_limit_bytes{database="main",database_id="dbs_1"} 268435456');
		expect(text).toContain('skiff_scrape_truncated{section="apps"} 0');
		expect(text).not.toContain('secret-app');
		expect(text).not.toContain('theirs');
		expect(text).not.toContain('skiff_node_up');
		// No ClickHouse in this test: the scrape still answers and says so.
		expect(text).toContain('skiff_telemetry_up 0');
	});

	test('a per-app scrape renders one app; an unknown or foreign app is a 404', async () => {
		const text = await render(owner, ['apps', 'blog']);
		assertValidExposition(text);
		expect(text).toContain('project="blog"');
		expect(text).not.toContain('project="shop"');
		expect(text).not.toContain('skiff_database_info');
		expect(text).not.toContain('skiff_quota_used');
		await expect(render(owner, ['apps', 'secret-app'])).rejects.toMatchObject({ status: 404 });
		const db = await render(owner, ['databases', 'main']);
		expect(db).toContain('skiff_database_running{database="main",database_id="dbs_1"} 1');
		await expect(render(owner, ['databases', 'theirs'])).rejects.toMatchObject({ status: 404 });
	});

	test('a platform admin key can scrape the fleet section', async () => {
		const text = await render(admin, ['platform']);
		expect(text).toContain('skiff_volume_up{node="edge-1",volume="data",kind="filesystem"} 1');
	});

	test('settings: cache, app cap, disabled sections and private /metrics', async () => {
		core.metricsExport.updateSettings({ maxApps: 1, cacheSeconds: 30 });
		const capped = await render(owner, ['apps']);
		expect(capped).toContain('skiff_scrape_truncated{section="apps"} 1');
		expect(capped).toContain('project="blog"');
		expect(capped).not.toContain('project="shop"');
		// The named path is never capped.
		expect(await render(owner, ['apps', 'shop'])).toContain('project="shop"');

		// Cached for 30 s: a new app does not appear until the cache expires.
		await core.projects.create(owner, { slug: 'aaa' } as never);
		expect(await render(owner, ['apps'])).toContain('project="blog"');
		clock += 31_000;
		expect(await render(owner, ['apps'])).toContain('project="aaa"');

		core.metricsExport.updateSettings({ sections: { databases: false }, publicPlatform: false });
		expect(core.metricsExport.settings().sections.apps).toBe(true);
		expect(await render(owner)).not.toContain('skiff_database_info');
		await expect(render(owner, ['databases'])).rejects.toMatchObject({ status: 404 });
		await expect(render(undefined)).rejects.toMatchObject({ status: 401 });

		expect(() => core.metricsExport.updateSettings({ cacheSeconds: 9999 })).toThrow();
		expect(() => core.metricsExport.updateSettings({ unknown: true })).toThrow();
	});
});
