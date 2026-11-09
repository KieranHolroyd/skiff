import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_EXPORT_VERSION, DEFAULT_FEATURES } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/** Config export (docs/OPERATIONS.md §13): read-only, secrets by name, skips what it can't read. */
const dir = mkdtempSync(join(tmpdir(), 'skiff-config-export-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-09T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
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
		features: { ...DEFAULT_FEATURES },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const outsider = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_9', role: 'owner' });

const SECRET_VALUES = ['sk_live_super_secret_value', 'project-secret-value-42', 'drain-header-token-xyz', 'staging-password-123'];

beforeAll(async () => {
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT)');
	opened.sqlite.run("INSERT INTO organization (id, name, slug) VALUES ('org_1', 'Acme', 'acme')");
	await core.projects.create(owner, { name: 'Shop web', slug: 'shop-web', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	await core.projects.create(owner, { name: 'Shop API', slug: 'shop-api', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
	const api = core.projects.requireRow(owner, 'shop-api');
	await core.secrets.set(owner, { name: 'STRIPE_KEY', value: 'sk_live_super_secret_value', projectId: null });
	core.workloads.setSpec(owner, api, {
		runtime: 'process',
		command: ['bun', 'run', 'start'],
		port: 3000,
		memoryMb: 256,
		cpus: 1,
		healthPath: '/health',
		socketActivation: false,
		env: { LOG_LEVEL: 'info' },
		secrets: [{ name: 'STRIPE_KEY', delivery: 'env' }],
	});
	core.environments.create(owner, core.projects.requireRow(owner, 'shop-web'), { name: 'Staging', access: 'password', password: 'staging-password-123' });
	await core.secrets.set(owner, { name: 'API_TOKEN', value: 'project-secret-value-42', projectId: api.id });
	core.logDrains.create(owner, { name: 'ops', kind: 'webhook', url: 'https://logs.example.com/in', headers: { Authorization: 'drain-header-token-xyz' } });
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('config export', () => {
	test('exports projects with their settings and org-level config', async () => {
		const doc = await core.configExport.export(owner);
		expect(doc.apiVersion).toBe(CONFIG_EXPORT_VERSION);
		expect(doc.exportedAt).toBe('2026-11-09T10:00:00.000Z');
		expect(doc.platform).toEqual({ url: 'https://control.test', contentDomain: 'sites.test', version: '1.2.3' });
		expect(doc.org).toEqual({ id: 'org_1', name: 'Acme', slug: 'acme' });
		expect(doc.projectFilter).toBeNull();

		expect(doc.projects.map((project) => project.slug)).toEqual(['shop-api', 'shop-web']);
		const api = doc.projects[0]!;
		expect(api.workload).toMatchObject({ runtime: 'process', port: 3000, env: { LOG_LEVEL: 'info' }, secrets: [{ name: 'STRIPE_KEY' }] });
		expect((api.secrets as { name: string }[]).map((secret) => secret.name)).toEqual(['API_TOKEN']);
		const web = doc.projects[1]!;
		expect((web.environments as { slug: string; access: string }[]).find((env) => env.slug === 'staging')).toMatchObject({ access: 'password' });
		expect(web.workload).toBeNull();

		expect((doc.secrets as { name: string }[]).map((secret) => secret.name)).toEqual(['STRIPE_KEY']);
		expect(doc.logDrains).toMatchObject([{ name: 'ops', headerNames: ['Authorization'] }]);
		expect(doc.iam).toBeDefined();
	});

	test('never contains a secret value', async () => {
		const text = JSON.stringify(await core.configExport.export(owner));
		for (const value of SECRET_VALUES) expect(text).not.toContain(value);
	});

	test('skips what the caller cannot read instead of failing', async () => {
		const doc = await core.configExport.export(viewer);
		expect(doc.projects.length).toBe(2);
		expect(doc.iam).toBeUndefined();
		expect(doc.skipped.find((skip) => skip.section === 'iam')).toMatchObject({ code: 'forbidden' });
		expect(Object.keys(doc)).not.toContain('iam');
	});

	test('filters projects and reports unknown slugs', async () => {
		const doc = await core.configExport.export(owner, { projects: ['shop-web', 'nope-nope'] });
		expect(doc.projects.map((project) => project.slug)).toEqual(['shop-web']);
		expect(doc.projectFilter).toEqual(['nope-nope', 'shop-web']);
		expect(doc.skipped).toContainEqual({ section: 'projects.nope-nope', code: 'not_found', reason: 'Project "nope-nope" not found' });
	});

	test('records an audit entry', async () => {
		await core.configExport.export(owner, { projects: ['shop-api'] });
		const entry = core.audit.list({ orgId: 'org_1' }).find((row) => row.action === 'config.export');
		expect(entry).toMatchObject({ resource: 'org', result: 'ok' });
	});

	test('is scoped to the caller org', async () => {
		const doc = await core.configExport.export(outsider);
		expect(doc.projects).toEqual([]);
		expect(doc.logDrains).toEqual([]);
	});
});
