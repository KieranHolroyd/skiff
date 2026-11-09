import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type BlueprintPlanView, type Principal } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { blueprintPlanHash, parseBlueprint, parseResourceKey } from './blueprints.ts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/** Blueprints (plan 11, docs/OPERATIONS.md §12): parse, plan, apply, re-apply, prune. */
const dir = mkdtempSync(join(tmpdir(), 'yoal-blueprints-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:00Z');
const features = { ...DEFAULT_FEATURES, BLUEPRINTS: true, BROKERS: true, OBJECT_BROWSER: true };

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
		features,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
const agent = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner', clientId: 'client_1' });
const outsider = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_9', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const yaml = `
apiVersion: yoal/v1
name: shop
projects:
  shop-web:
    access: { production: public, previews: platform }
    environments:
      staging: { access: platform }
    domains: [shop.example.com]
  shop-api:
    runtime: process
    placement: auto
    command: [bun, run, start]
    port: 3000
    healthPath: /health
    memoryMb: 128
    env: { LOG_LEVEL: info }
    secrets: [STRIPE_KEY]
databases:
  shop-db:
    engine: postgres
    version: 17
    storageMb: 1024
    extensions: [pg_trgm]
storage:
  shop-assets:
    storageMb: 1024
    buckets:
      uploads: { versioning: true, quotaMb: 100 }
brokers:
  shop-queue: {}
attachments:
  - { project: shop-api, database: shop-db }
  - { project: shop-api, storage: shop-assets, grants: [{ bucket: uploads }] }
  - { project: shop-api, broker: shop-queue }
`;

async function settle(view: { operationId: string }) {
	await core.operations.settled(view.operationId);
	return core.blueprints.applyView(owner, view.operationId);
}

const actions = (plan: BlueprintPlanView) => Object.fromEntries(plan.resources.map((resource) => [resource.key, resource.action]));

describe('parsing', () => {
	test('YAML and JSON parse to the same document; versions may be unquoted', () => {
		const fromYaml = parseBlueprint(yaml);
		expect(fromYaml.databases['shop-db']?.version).toBe('17');
		expect(fromYaml.projects['shop-web']?.runtime).toBe('static');
		const fromJson = parseBlueprint(JSON.stringify(fromYaml));
		expect(fromJson).toEqual(fromYaml);
		expect(parseBlueprint(fromYaml as unknown as Record<string, unknown>)).toEqual(fromYaml);
	});

	test('errors name the path; bad syntax and non-mappings are refused', () => {
		expect(() => parseBlueprint('apiVersion: yoal/v1\nname: shop\nprojects:\n  web:\n    spa: true\n')).toThrow(
			/projects\.web: Unrecognized key/,
		);
		try {
			parseBlueprint('apiVersion: yoal/v1\nname: shop\nprojects:\n  web:\n    spa: true\n');
		} catch (error) {
			expect((error as { issues: Array<{ path: string[] }> }).issues[0]?.path).toEqual(['projects', 'web']);
		}
		expect(() => parseBlueprint('{"apiVersion": ')).toThrow(/not valid JSON/);
		expect(() => parseBlueprint('a: [unclosed')).toThrow(/not valid YAML/);
		expect(() => parseBlueprint('- one\n- two\n')).toThrow(/one mapping/);
		expect(() => parseBlueprint('   ')).toThrow(/empty/);
		expect(() => parseBlueprint(`# ${'x'.repeat(600 * 1024)}`)).toThrow(/at most 512 KB/);
	});

	test('resource keys round-trip, hostnames included', () => {
		expect(parseResourceKey('projects.web')).toEqual({ kind: 'project', project: 'web' });
		expect(parseResourceKey('projects.web.domains.www.example.com')).toEqual({
			kind: 'domain',
			project: 'web',
			child: 'www.example.com',
		});
		expect(parseResourceKey('storage.media.buckets.uploads')).toEqual({ kind: 'bucket', name: 'media', child: 'uploads' });
		expect(parseResourceKey('attachments.api.broker.jobs')).toEqual({ kind: 'attachment', project: 'api', type: 'broker', name: 'jobs' });
		expect(parseResourceKey('jobs.cleanup')).toBeNull();
	});

	test('the plan hash depends on every step and the prune flag', () => {
		const base = { stack: 'shop', prune: false, documentHash: 'd', steps: [] };
		const step = { key: 'projects.web', kind: 'project' as const, action: 'create' as const, changes: [], reason: null };
		expect(blueprintPlanHash(base)).toBe(blueprintPlanHash({ ...base }));
		expect(blueprintPlanHash(base)).not.toBe(blueprintPlanHash({ ...base, prune: true }));
		expect(blueprintPlanHash({ ...base, steps: [step] })).not.toBe(blueprintPlanHash({ ...base, steps: [{ ...step, action: 'update' }] }));
		// Reasons are commentary, not part of what runs.
		expect(blueprintPlanHash({ ...base, steps: [step] })).toBe(blueprintPlanHash({ ...base, steps: [{ ...step, reason: 'x' }] }));
	});
});

describe('plan and apply', () => {
	let edgeId = '';
	let edgeToken = '';
	const heartbeat = () =>
		core.nodes.heartbeat(edgeToken, {
			nodeId: edgeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: ['functions', 'brokers'],
			stats: {
				cpuPercent: 5,
				memoryBytes: 1024 ** 3,
				memoryTotalBytes: 8 * 1024 ** 3,
				diskUsedBytes: 10 * 1024 ** 3,
				diskTotalBytes: 100 * 1024 ** 3,
				diskFreeBytes: 90 * 1024 ** 3,
				uptimeSeconds: 100,
				load1: 0.1,
				certs: [],
			},
		});

	test('setup: one node, an org secret', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeId = joined.nodeId;
		edgeToken = joined.token;
		heartbeat();
		// Room for the database, but not the storage instance after it: the first apply fails midway.
		core.nodes.update(owner, edgeId, { sliceMemoryMb: 600 });
		await core.secrets.set(owner, { name: 'STRIPE_KEY', value: 'sk_test_123', projectId: null });
	});

	test('the feature flag gates every entry point', async () => {
		features.BLUEPRINTS = false;
		try {
			await expect(core.blueprints.plan(owner, { document: yaml })).rejects.toThrow(/YOAL_FEATURE_BLUEPRINTS/);
			expect(() => core.blueprints.validate(owner, yaml)).toThrow(/YOAL_FEATURE_BLUEPRINTS/);
		} finally {
			features.BLUEPRINTS = true;
		}
	});

	test('validate counts what the file declares without reading live state', () => {
		expect(core.blueprints.validate(owner, yaml)).toMatchObject({
			stack: 'shop',
			resources: { projects: 2, databases: 1, storage: 1, buckets: 1, brokers: 1, attachments: 3 },
		});
	});

	test('a plan is ordered by dependency, hashes stably and changes nothing', async () => {
		const plan = await core.blueprints.plan(owner, { document: yaml });
		expect(plan.stackAction).toBe('create');
		expect(plan.resources.map((resource) => resource.key)).toEqual([
			'projects.shop-web',
			'projects.shop-web.environments.staging',
			'projects.shop-api',
			'databases.shop-db',
			'storage.shop-assets',
			'storage.shop-assets.buckets.uploads',
			'brokers.shop-queue',
			'projects.shop-api.service',
			'projects.shop-web.domains.shop.example.com',
			'attachments.shop-api.database.shop-db',
			'attachments.shop-api.storage.shop-assets',
			'attachments.shop-api.broker.shop-queue',
		]);
		expect(plan.summary).toEqual({ create: 12, update: 0, delete: 0, noop: 0 });
		expect(plan.resources.find((resource) => resource.key === 'projects.shop-api.service')?.changes).toEqual(
			expect.arrayContaining([
				{ path: 'command', from: null, to: 'bun run start' },
				{ path: 'env.LOG_LEVEL', from: null, to: 'info' },
				{ path: 'secrets', from: null, to: 'STRIPE_KEY' },
			]),
		);
		// No secret value ever enters a plan.
		expect(JSON.stringify(plan)).not.toContain('sk_test_123');
		expect(plan.expiresAt).not.toBeNull();
		const again = await core.blueprints.plan(owner, { document: yaml });
		expect(again.planHash).toBe(plan.planHash);
		expect(again.operationId).not.toBe(plan.operationId);
		expect(core.projects.list(owner)).toHaveLength(0);
		expect(core.blueprints.list(owner)).toEqual([]);
		// The view hides the document; only the stack name shows as the target.
		const operation = core.operations.get(owner, plan.operationId);
		expect(operation).toMatchObject({ action: 'blueprint.apply', kind: 'bulk', status: 'planned', params: { targets: ['shop'] } });
		expect(JSON.stringify(operation)).not.toContain('apiVersion');
	});

	test('plan problems fail the whole plan with their resource path', async () => {
		const withSecret = yaml.replace('secrets: [STRIPE_KEY]', 'secrets: [MISSING_KEY]');
		await expect(core.blueprints.plan(owner, { document: withSecret })).rejects.toThrow(
			/projects\.shop-api\.service: Secret MISSING_KEY does not exist/,
		);
		// Slugs are platform-wide: another org's project holds this one.
		await core.projects.create(outsider, { slug: 'taken-site', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		await expect(
			core.blueprints.plan(owner, { document: 'apiVersion: yoal/v1\nname: other\nprojects:\n  taken-site: {}\n' }),
		).rejects.toThrow(/projects\.taken-site: "taken-site" is already taken/);
		// A deployer cannot add custom domains.
		await expect(core.blueprints.plan(deployer, { document: yaml })).rejects.toThrow(/Needs the domain:create permission/);
		// Agents never prune.
		await expect(core.blueprints.plan(agent, { document: yaml, prune: true })).rejects.toThrow(/dashboard or CLI/);
	});

	test('POST /operations cannot create a blueprint run without a plan', () => {
		expect(() => core.operations.create(owner, { action: 'blueprint.apply', targets: ['shop'] })).toThrow(/blueprints\/plan/);
	});

	test('a failed step stops the run; later steps are skipped and nothing is rolled back', async () => {
		const plan = await core.blueprints.plan(owner, { document: yaml });
		const started = core.blueprints.apply(owner, { planHash: plan.planHash });
		expect(started.operationId).toBe(plan.operationId);
		const result = await settle(started);
		expect(result.status).toBe('partial');
		const status = Object.fromEntries(result.resources.map((resource) => [resource.key, resource.status]));
		expect(status).toMatchObject({
			'projects.shop-web': 'succeeded',
			'projects.shop-web.environments.staging': 'succeeded',
			'projects.shop-api': 'succeeded',
			'databases.shop-db': 'succeeded',
			'storage.shop-assets': 'failed',
			'storage.shop-assets.buckets.uploads': 'skipped',
			'attachments.shop-api.broker.shop-queue': 'skipped',
		});
		expect(result.resources.find((resource) => resource.key === 'brokers.shop-queue')?.reason).toBe('an earlier step failed');
		expect(result.error).toMatch(/^storage\.shop-assets: /);
		// What ran stays; the stack remembers it so the next plan adopts nothing by surprise.
		expect(core.projects.list(owner).map((project) => project.slug).sort()).toEqual(['shop-api', 'shop-web']);
		expect(core.databases.get(owner, 'shop-db')).toMatchObject({ engine: 'postgres', version: '17', storageMb: 1024 });
		const stack = core.blueprints.get(owner, 'shop');
		expect(stack).toMatchObject({ lastStatus: 'partial', document: null, appliedAt: null });
		expect(stack.managed).toEqual([
			'databases.shop-db',
			'projects.shop-api',
			'projects.shop-web',
			'projects.shop-web.environments.staging',
		]);
		// Re-submitting the hash returns the same run, not a second one.
		expect(core.blueprints.apply(owner, { planHash: plan.planHash }).operationId).toBe(plan.operationId);
	});

	test('after fixing the cause, a re-plan only lists what is left', async () => {
		core.nodes.update(owner, edgeId, { sliceMemoryMb: 16_384 });
		const plan = await core.blueprints.plan(owner, { document: yaml });
		expect(plan.stackAction).toBe('update');
		expect(actions(plan)).toMatchObject({
			'projects.shop-web': 'noop',
			'databases.shop-db': 'noop',
			'storage.shop-assets': 'create',
			'brokers.shop-queue': 'create',
			'attachments.shop-api.database.shop-db': 'create',
		});
		expect(plan.resources.find((resource) => resource.key === 'databases.shop-db')?.reason).toBe('up to date');
		const result = await settle(core.blueprints.apply(owner, { planHash: plan.planHash }));
		expect(result.status).toBe('succeeded');
		expect(result.resources.filter((resource) => resource.status === 'failed')).toEqual([]);

		const api = core.projects.requireRow(owner, 'shop-api');
		expect(core.databases.attachments(owner, api).map((item) => item.envPrefix)).toEqual(['DATABASE']);
		expect(core.storage.attachments(owner, api)[0]).toMatchObject({ envPrefix: 'S3', grants: [{ bucket: 'uploads', mode: 'read-write' }] });
		expect(core.brokers.attachments(owner, api).map((item) => item.envPrefix)).toEqual(['NATS']);
		expect(core.workloads.projectSpec(api)).toMatchObject({
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			healthPath: '/health',
			memoryMb: 128,
			env: { LOG_LEVEL: 'info' },
			secrets: [{ name: 'STRIPE_KEY', delivery: 'env' }],
		});
		const bucket = core.storage.getBucketConfig(owner, 'shop-assets', 'uploads');
		expect(bucket).toMatchObject({ versioning: true, quotaBytes: 100 * 1024 * 1024 });
		expect(core.domains.list(owner).map((domain) => domain.hostname)).toEqual(['shop.example.com']);
		// Everything shares one node (D56).
		expect(new Set([core.databases.get(owner, 'shop-db').nodeId, core.storage.get(owner, 'shop-assets').nodeId, core.brokers.get(owner, 'shop-queue').nodeId])).toEqual(
			new Set([edgeId]),
		);
		const stack = core.blueprints.get(owner, 'shop');
		expect(stack).toMatchObject({ lastStatus: 'succeeded', appliedPlanHash: plan.planHash });
		expect(stack.document?.name).toBe('shop');
		expect(stack.managed).toHaveLength(12);
	});

	test('applying the same file again is a no-op', async () => {
		const audits = () => opened.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log WHERE action NOT LIKE 'operation.%' AND action != 'blueprint.apply'").get()!.n;
		const plan = await core.blueprints.plan(owner, { document: yaml });
		expect(plan.stackAction).toBe('noop');
		expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, noop: 12 });
		const before = audits();
		const result = await settle(core.blueprints.apply(owner, { planHash: plan.planHash }));
		expect(result.status).toBe('succeeded');
		expect(result.resources.every((resource) => resource.status === 'skipped' && resource.reason === 'up to date')).toBe(true);
		// No service call changed anything.
		expect(audits()).toBe(before);
	});

	test('changed fields show as updates and only they change', async () => {
		const edited = yaml.replace('memoryMb: 128', 'memoryMb: 192').replace('LOG_LEVEL: info', 'LOG_LEVEL: debug').replace('storageMb: 1024\n    extensions', 'storageMb: 2048\n    extensions');
		const plan = await core.blueprints.plan(owner, { document: edited });
		expect(plan.summary).toEqual({ create: 0, update: 2, delete: 0, noop: 10 });
		expect(plan.resources.find((resource) => resource.key === 'databases.shop-db')?.changes).toEqual([
			{ path: 'storageMb', from: '1024', to: '2048' },
		]);
		expect(plan.resources.find((resource) => resource.key === 'projects.shop-api.service')?.changes).toEqual([
			{ path: 'memoryMb', from: '128', to: '192' },
			{ path: 'env.LOG_LEVEL', from: 'info', to: 'debug' },
		]);
		expect((await settle(core.blueprints.apply(owner, { planHash: plan.planHash }))).status).toBe('succeeded');
		expect(core.databases.get(owner, 'shop-db').storageMb).toBe(2048);
		expect(core.workloads.projectSpec(core.projects.requireRow(owner, 'shop-api'))?.memoryMb).toBe(192);
	});

	test('immutable fields fail the plan', async () => {
		const cases: Array<[string, RegExp]> = [
			[yaml.replace('runtime: process', 'runtime: container\n    image: nginx:1.27'), /runtime is fixed/],
			[yaml.replace('version: 17', 'version: 18'), /major-version upgrade/],
			[yaml.replace('engine: postgres\n    version: 17\n    storageMb: 1024\n    extensions: [pg_trgm]', 'engine: mysql'), /engine is fixed/],
			[yaml.replace('    engine: postgres\n', '    engine: postgres\n    variant: postgis\n'), /variant is fixed/],
			[yaml.replace('shop-queue: {}', 'shop-queue: { version: "2.11" }'), /cannot be downgraded/],
		];
		for (const [document, message] of cases) await expect(core.blueprints.plan(owner, { document })).rejects.toThrow(message);
	});

	test('a plan whose live state moved is refused at apply', async () => {
		const edited = yaml.replace('memoryMb: 128', 'memoryMb: 256');
		const plan = await core.blueprints.plan(owner, { document: edited });
		await core.projects.update(owner, 'shop-web', { name: 'Renamed by hand' });
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shop-api'), {
			...core.workloads.projectSpec(core.projects.requireRow(owner, 'shop-api'))!,
			port: 4000,
		});
		expect(() => core.blueprints.apply(owner, { planHash: plan.planHash })).toThrow(/Live state changed/);
		// Another user cannot apply someone else's plan.
		expect(() => core.blueprints.apply(deployer, { planHash: plan.planHash })).toThrow(/plan it first/);
		// Put the port back the file's way.
		const fixed = await core.blueprints.plan(owner, { document: yaml });
		expect(actions(fixed)['projects.shop-api.service']).toBe('update');
		expect((await settle(core.blueprints.apply(owner, { planHash: fixed.planHash }))).status).toBe('succeeded');
	});

	test('removed resources are kept and warned about, or pruned with a typed confirmation', async () => {
		const smaller = yaml
			.replace('    environments:\n      staging: { access: platform }\n', '')
			.replace('  - { project: shop-api, broker: shop-queue }\n', '')
			.replace('brokers:\n  shop-queue: {}\n', '');
		const kept = await core.blueprints.plan(owner, { document: smaller });
		expect(kept.summary.delete).toBe(0);
		expect(kept.warnings).toEqual([
			'attachments.shop-api.broker.shop-queue is no longer in the file. It is kept; plan with prune to delete it.',
			'projects.shop-web.environments.staging is no longer in the file. It is kept; plan with prune to delete it.',
			'brokers.shop-queue is no longer in the file. It is kept; plan with prune to delete it.',
		]);

		const pruning = await core.blueprints.plan(owner, { document: smaller, prune: true });
		expect(pruning.resources.filter((resource) => resource.action === 'delete').map((resource) => resource.key)).toEqual([
			'attachments.shop-api.broker.shop-queue',
			'projects.shop-web.environments.staging',
			'brokers.shop-queue',
		]);
		expect(() => core.blueprints.apply(owner, { planHash: pruning.planHash })).toThrow(/Type the stack name "shop"/);
		expect(() => core.blueprints.apply(owner, { planHash: pruning.planHash, confirm: 'nope' })).toThrow(/Type the stack name/);
		// An agent may not run a pruning plan, even its own user's.
		expect(() => core.blueprints.apply(agent, { planHash: pruning.planHash, confirm: 'shop' })).toThrow(/dashboard or CLI/);
		const result = await settle(core.blueprints.apply(owner, { planHash: pruning.planHash, confirm: 'shop' }));
		expect(result.status).toBe('succeeded');
		expect(core.brokers.get(owner, 'shop-queue', { includeDeleted: true }).deletedAt).not.toBeNull();
		expect(core.environments.rows(core.projects.requireRow(owner, 'shop-web').id).map((env) => env.slug)).toEqual(['production']);
		expect(core.blueprints.get(owner, 'shop').managed).not.toContain('brokers.shop-queue');
		// Nothing left to prune.
		const after = await core.blueprints.plan(owner, { document: smaller, prune: true });
		expect(after.summary.delete).toBe(0);
		expect(after.stackAction).toBe('noop');
	});

	test('an agent applies a reviewed plan; resources it did not create are adopted', async () => {
		await core.projects.create(owner, { slug: 'adopt-me', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		const plan = await core.blueprints.plan(agent, {
			document: 'apiVersion: yoal/v1\nname: adopted\nprojects:\n  adopt-me:\n    access: { production: platform }\n',
		});
		expect(plan.resources).toEqual([
			{
				key: 'projects.adopt-me',
				kind: 'project',
				action: 'update',
				changes: [{ path: 'access.production', from: 'public', to: 'platform' }],
				reason: 'exists; this stack adopts it',
			},
		]);
		const result = await settle(core.blueprints.apply(agent, { planHash: plan.planHash }));
		expect(result.status).toBe('succeeded');
		expect(core.projects.requireRow(owner, 'adopt-me').productionAccess).toBe('platform');
		expect(core.blueprints.list(owner).map((stack) => stack.name)).toEqual(['adopted', 'shop']);
	});

	test('a pending plan can be read back by its author until it runs or expires', async () => {
		const plan = await core.blueprints.plan(owner, {
			document: 'apiVersion: yoal/v1\nname: adopted\nprojects:\n  adopt-me:\n    access: { production: public }\n',
		});
		expect(core.blueprints.pendingPlan(owner, plan.planHash)).toMatchObject({
			planHash: plan.planHash,
			operationId: plan.operationId,
			summary: { update: 1 },
		});
		expect(core.blueprints.pendingPlan(deployer, plan.planHash)).toBeNull();
		clock += 61 * 60 * 1000;
		expect(core.blueprints.pendingPlan(owner, plan.planHash)).toBeNull();
		core.operations.expireAndPrune();
		expect(() => core.blueprints.apply(owner, { planHash: plan.planHash })).toThrow(/expired/);
		// Runs of other actions are not blueprint runs.
		const bulk = core.operations.create(owner, { action: 'project.restore', targets: ['adopt-me'] });
		expect(() => core.blueprints.applyView(owner, bulk.id)).toThrow(/not found/);
	});
});
