import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, alertRuleTemplate, type ConfigImportView, type Principal } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';

/**
 * Config import (docs/OPERATIONS.md §14): export one instance, import into a fresh one, and check
 * that the second run has nothing left to do.
 */

const dirs: string[] = [];
const dbs: { close(): void }[] = [];
const clock = Date.parse('2026-11-09T10:00:00Z');

function instance(name: string): Core {
	const dir = mkdtempSync(join(tmpdir(), `yoal-import-${name}-`));
	dirs.push(dir);
	const opened = createDb({ path: ':memory:' });
	dbs.push(opened.sqlite);
	// Auth tables the real install has, so members can be matched by email.
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT)');
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT)');
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT)');
	return createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '1.0.0',
		config: {
			dataDir: dir,
			platformOrigin: `https://control.${name}.test`,
			contentDomain: `${name}.test`,
			objectStore: new LocalObjectStore(join(dir, 'objects'), `https://control.${name}.test`, 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(name === 'old' ? 7 : 9),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => clock,
			features: { ...DEFAULT_FEATURES },
		},
	});
}

function addNode(core: Core, owner: Principal): void {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	core.nodes.heartbeat(joined.token, {
		nodeId: joined.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: ['functions', 'brokers'],
		stats: {
			cpuPercent: 5,
			memoryBytes: 1024 ** 3,
			memoryTotalBytes: 16 * 1024 ** 3,
			diskUsedBytes: 10 * 1024 ** 3,
			diskTotalBytes: 200 * 1024 ** 3,
			diskFreeBytes: 190 * 1024 ** 3,
			uptimeSeconds: 100,
			load1: 0.1,
			certs: [],
		},
	});
	core.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 16_384 });
}

function member(core: Core, org: string, id: string, email: string, role: string): void {
	core.ctx.sqlite.run('INSERT INTO "user" (id, email, name) VALUES (?, ?, ?)', [id, email, email]);
	core.ctx.sqlite.run('INSERT INTO member (id, organizationId, userId, role) VALUES (?, ?, ?, ?)', [`m_${id}`, org, id, role]);
}

const old = instance('old');
const fresh = instance('new');
const oldOwner = buildPrincipal({ kind: 'user', userId: 'u_old_owner', orgId: 'org_old', role: 'owner', platformAdmin: true });
const newOwner = buildPrincipal({ kind: 'user', userId: 'u_new_owner', orgId: 'org_new', role: 'owner', platformAdmin: true });
let exported: Record<string, unknown>;
let yaml = '';

beforeAll(async () => {
	addNode(old, oldOwner);
	addNode(fresh, newOwner);
	member(old, 'org_old', 'u_old_owner', 'owner@example.com', 'owner');
	member(old, 'org_old', 'u_old_dev', 'dev@example.com', 'member');
	member(fresh, 'org_new', 'u_new_owner', 'owner@example.com', 'owner');
	member(fresh, 'org_new', 'u_new_dev', 'dev@example.com', 'member');

	const c = old;
	await c.projects.create(oldOwner, { name: 'Shop API', slug: 'shop-api', runtime: 'process', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	await c.projects.create(oldOwner, { name: 'Site', slug: 'site', runtime: 'static', placement: 'edge', productionAccess: 'password', previewAccess: 'platform', password: 'hunter2-hunter2' });
	const api = c.projects.requireRow(oldOwner, 'shop-api');
	await c.secrets.set(oldOwner, { name: 'STRIPE_KEY', value: 'sk_live_old_value', projectId: null });
	await c.secrets.set(oldOwner, { name: 'STRIPE_KEY', value: 'sk_live_rotated', projectId: null });
	await c.secrets.set(oldOwner, { name: 'API_TOKEN', value: 'project-token-old', projectId: api.id });
	c.workloads.setSpec(oldOwner, api, {
		runtime: 'process',
		command: ['bun', 'run', 'start'],
		port: 3000,
		memoryMb: 256,
		cpus: 1,
		healthPath: '/health',
		socketActivation: false,
		env: { LOG_LEVEL: 'info' },
		secrets: [
			{ name: 'STRIPE_KEY', delivery: 'env' },
			{ name: 'API_TOKEN', delivery: 'env' },
		],
	});
	c.environments.create(oldOwner, api, { name: 'Staging', access: 'platform' });
	await c.domains.create(oldOwner, { project: 'shop-api', hostname: 'api.shop.example', redirectWww: false });
	c.jobs.create(oldOwner, api, { name: 'nightly', command: ['bun', 'run', 'nightly'], schedule: '0 3 * * *' });
	c.databases.create(oldOwner, { name: 'shop-db', engine: 'postgres', version: '17', extensions: ['pg_trgm'] });
	c.databases.attach(oldOwner, api, { database: 'shop-db', envPrefix: 'MAIN_DB' });
	c.storage.create(oldOwner, { name: 'shop-assets' });
	c.storage.createBucket(oldOwner, 'shop-assets', { name: 'uploads' });
	c.storage.attach(oldOwner, api, { storage: 'shop-assets', grants: [{ bucket: 'uploads', mode: 'read-write' }] });
	c.brokers.create(oldOwner, { name: 'jobs-queue' });
	c.brokers.attach(oldOwner, api, { broker: 'jobs-queue' });
	c.iam.createRole(oldOwner, { name: 'auditor', permissions: ['project:read', 'logs:read'] });
	const group = c.iam.createGroup(oldOwner, { name: 'ops' });
	c.iam.addGroupMember(oldOwner, group.id, 'u_old_dev');
	const auditor = c.iam.listRoles('org_old').find((role) => role.name === 'auditor')!;
	c.iam.bind(oldOwner, { principalType: 'group', principalId: group.id, roleId: auditor.id, scope: { type: 'project', id: api.id } });
	c.iam.bind(oldOwner, { principalType: 'user', principalId: 'u_old_dev', roleId: 'deployer', scope: { type: 'project', id: api.id } });
	c.serviceAccounts.create(oldOwner, { name: 'ci-bot' });
	c.pipelines.createRepository(oldOwner, { name: 'shop', cloneUrl: 'https://github.com/acme/shop.git', provider: 'github' } as never);
	c.pipelines.setVariable(oldOwner, 'shop', 'NODE_ENV', 'production');
	c.pipelines.setEnvironment(oldOwner, 'shop', 'prod', { allowedRefs: ['main'], requireApproval: true });
	c.pipelines.linkProject(oldOwner, 'shop', 'shop-api', { environment: null });
	c.alerts.createRule(oldOwner, { ...alertRuleTemplate('site_down')!.rule, name: 'Site down' });
	c.logDrains.create(oldOwner, { name: 'ops', kind: 'webhook', url: 'https://logs.example.com/in', headers: { Authorization: 'Bearer drain-secret' } });

	const pool = await c.userPools.create(oldOwner, { name: 'customers', signupMode: 'open' });
	c.userPools.createClient(oldOwner, pool.id, { name: 'web', redirectUris: ['https://shop.example/callback'] });
	c.userPools.createGroup(oldOwner, pool.id, 'vip');

	exported = (await c.configExport.export(oldOwner)) as unknown as Record<string, unknown>;
	yaml = Bun.YAML.stringify(JSON.parse(JSON.stringify(exported)), null, 2);
});

afterAll(() => {
	for (const db of dbs) db.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const byKey = (view: ConfigImportView) => new Map(view.steps.map((step) => [step.key, step]));

describe('config import', () => {
	test('refuses something that is not an export', async () => {
		await expect(fresh.configImport.plan(newOwner, { document: 'apiVersion: yoal/v1\nname: x' })).rejects.toThrow(/yoal.export\/v1/);
		await expect(fresh.configImport.plan(newOwner, { document: '{ nope' })).rejects.toThrow(/not valid (JSON|YAML)/);
	});

	test('plan lists what would be created and changes nothing', async () => {
		const plan = await fresh.configImport.plan(newOwner, { document: yaml });
		const steps = byKey(plan);
		for (const key of [
			'projects.shop-api',
			'projects.site',
			'projects.shop-api.environments.staging',
			'databases.shop-db',
			'storage.shop-assets',
			'storage.shop-assets.buckets.uploads',
			'brokers.jobs-queue',
			'projects.shop-api.jobs.nightly',
			'projects.shop-api.domains.api.shop.example',
			'attachments.shop-api.database.shop-db',
			'attachments.shop-api.storage.shop-assets',
			'attachments.shop-api.broker.jobs-queue',
			'iam.roles.auditor',
			'iam.groups.ops',
			'serviceAccounts.ci-bot',
			'pipelines.shop',
			'pipelines.shop.variables.NODE_ENV',
			'pipelines.shop.environments.prod',
			'pipelines.shop.links.shop-api',
			'alertRules.Site down',
			'logDrains.ops',
		])
			expect(steps.get(key)?.status).toBe('planned');
		// No values were given, so secrets and the workload that needs them wait.
		expect(steps.get('secrets.STRIPE_KEY')?.status).toBe('skipped');
		expect(steps.get('projects.shop-api.workload')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('STRIPE_KEY') });
		expect(plan.manual.some((entry) => entry.item === 'STRIPE_KEY')).toBe(true);
		expect(plan.manual.some((entry) => entry.item === 'site production' && /password/.test(entry.what))).toBe(true);
		// Secret versions are deduplicated: one step per name.
		expect(plan.steps.filter((step) => step.key === 'secrets.STRIPE_KEY')).toHaveLength(1);
		expect(fresh.projects.list(newOwner)).toEqual([]);
	});

	test('apply recreates the configuration with new ids and supplied secrets', async () => {
		const result = await fresh.configImport.apply(newOwner, {
			document: yaml,
			secrets: { STRIPE_KEY: 'sk_live_new', 'shop-api/API_TOKEN': 'project-token-new' },
		});
		const failed = result.steps.filter((step) => step.status === 'failed');
		expect(failed).toEqual([]);
		expect(result.summary.failed).toBe(0);

		const api = fresh.projects.requireRow(newOwner, 'shop-api');
		expect(api.id).not.toBe(old.projects.requireRow(oldOwner, 'shop-api').id);
		expect(fresh.workloads.projectSpec(api)).toMatchObject({ port: 3000, env: { LOG_LEVEL: 'info' } });
		expect(fresh.secrets.getValue('org_new', 'STRIPE_KEY')?.value).toBe('sk_live_new');
		expect(fresh.environments.rows(api.id).map((row) => row.slug).sort()).toEqual(['production', 'staging']);
		// Password access cannot be carried over; it lands on platform-only, never public.
		expect((await fresh.projects.get(newOwner, 'site')).productionAccess).toBe('platform');
		expect(fresh.databases.attachments(newOwner, api)).toMatchObject([{ databaseName: 'shop-db', envPrefix: 'MAIN_DB' }]);
		expect(fresh.storage.attachments(newOwner, api)).toMatchObject([{ storageName: 'shop-assets', grants: [{ bucket: 'uploads', mode: 'read-write' }] }]);
		expect(fresh.brokers.attachments(newOwner, api).map((a) => a.brokerName)).toEqual(['jobs-queue']);
		expect(fresh.jobs.list(newOwner, api).map((job) => job.name)).toEqual(['nightly']);

		// IAM: the custom role, the group with its member (matched by email) and both bindings.
		const role = fresh.iam.listRoles('org_new').find((r) => r.name === 'auditor');
		const group = fresh.iam.listGroups('org_new').find((g) => g.name === 'ops');
		expect(role && group).toBeTruthy();
		expect(group!.members).toBe(1);
		const bindings = fresh.iam.listBindings('org_new');
		expect(bindings.some((b) => b.principalType === 'group' && b.principalId === group!.id && b.roleId === role!.id && (b.scope as { id?: string }).id === api.id)).toBe(true);
		expect(bindings.some((b) => b.principalType === 'user' && b.principalId === 'u_new_dev' && b.roleId === 'deployer')).toBe(true);

		expect(fresh.pipelines.listVariables(newOwner, 'shop')).toMatchObject([{ name: 'NODE_ENV', value: 'production' }]);
		expect(fresh.pipelines.listProjectLinks(newOwner, 'shop').map((link) => link.projectSlug)).toEqual(['shop-api']);
		expect(fresh.alerts.listRules(newOwner).map((rule) => rule.name)).toEqual(['Site down']);
		// A drain whose header values were not exported stays off until they are set.
		expect(fresh.logDrains.list(newOwner)).toMatchObject([{ name: 'ops', enabled: false }]);
		expect(result.manual.some((entry) => entry.section === 'logDrains' && /Authorization/.test(entry.what))).toBe(true);
		const pool = fresh.userPools.list(newOwner).find((row) => row.name === 'customers')!;
		expect(pool.signupMode).toBe('open');
		expect(fresh.userPools.listClients(newOwner, pool.id).map((client) => client.name)).toEqual(['web']);
		expect(fresh.userPools.listGroups(newOwner, pool.id).map((group) => group.name)).toEqual(['vip']);
		expect(fresh.audit.list({ orgId: 'org_new', action: 'config.import' })).toHaveLength(1);
	});

	test('a second run has nothing left to do', async () => {
		const again = await fresh.configImport.plan(newOwner, {
			document: JSON.stringify(exported),
			secrets: { STRIPE_KEY: 'sk_live_new', 'shop-api/API_TOKEN': 'project-token-new' },
		});
		expect(again.steps.filter((step) => step.status === 'planned')).toEqual([]);
		expect(again.summary.exists).toBeGreaterThan(20);
	});

	test('only, skip and project filters narrow the plan', async () => {
		const other = instance('filtered');
		const owner = buildPrincipal({ kind: 'user', userId: 'u_f', orgId: 'org_f', role: 'owner', platformAdmin: true });
		addNode(other, owner);
		const plan = await other.configImport.plan(owner, { document: yaml, only: ['projects', 'databases'], projects: ['site'] });
		const sections = new Set(plan.steps.map((step) => step.section));
		expect([...sections].sort()).toEqual(['projects']);
		expect(plan.steps.map((step) => step.key)).toEqual(['projects.site']);
		const skipped = await other.configImport.plan(owner, { document: yaml, skip: ['pipelines', 'nope'] });
		expect(skipped.steps.some((step) => step.section === 'pipelines')).toBe(false);
		expect(skipped.warnings).toContain('"nope" is not an export section; it was ignored.');
	});

	test('a failed step skips its dependants and the rest carry on', async () => {
		const other = instance('nonode');
		const owner = buildPrincipal({ kind: 'user', userId: 'u_n', orgId: 'org_n', role: 'owner', platformAdmin: true });
		// No node: databases, storage and brokers cannot be placed.
		const result = await other.configImport.apply(owner, { document: yaml, only: ['projects', 'databases'] });
		const steps = byKey(result);
		expect(steps.get('databases.shop-db')?.status).toBe('failed');
		expect(steps.get('attachments.shop-api.database.shop-db')).toMatchObject({ status: 'skipped', reason: 'databases.shop-db failed' });
		expect(steps.get('projects.shop-api')?.status).toBe('done');
	});
});
