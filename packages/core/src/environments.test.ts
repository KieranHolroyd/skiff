import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentCreateSchema, workloadSpecSchema } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-environments-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-03T12:00:00Z');

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

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true,
});
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

let edge: { nodeId: string; token: string };

beforeAll(() => {
	edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function project(slug: string, runtime: 'static' | 'process' | 'container' = 'static') {
	await core.projects.create(owner, {
		name: slug,
		slug,
		runtime,
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(owner, slug);
}

function staging(slug: string, access: 'public' | 'password' | 'platform' = 'platform') {
	core.environments.create(owner, core.projects.requireRow(owner, slug), {
		name: 'Staging',
		access,
		...(access === 'password' ? { password: 'staging-password' } : {}),
	});
	return core.environments.requireRow(core.projects.requireRow(owner, slug), 'staging');
}

async function deploy(
	slug: string,
	body: string,
	options: { environment?: string; promote?: boolean } = {},
) {
	clock += 1_000;
	return core.uploads.deployInline(owner, core.projects.requireRow(owner, slug), [file('index.html', body)], options);
}

const requireProject = (slug: string) => core.projects.requireRow(owner, slug);
const pointer = (slug: string, environment: string) =>
	core.environments.requireRow(requireProject(slug), environment).deploymentId;

describe('environment host rules', () => {
	test('production keeps the bare host and other environments get one label', async () => {
		const row = await project('hosts');
		const production = core.environments.ensureProduction(row);
		const env = staging('hosts');

		expect(core.environments.hostFor(row, production)).toBe('hosts.sites.test');
		expect(core.environments.hostFor(row, env)).toBe('hosts--staging.sites.test');
		expect(core.environments.view(row, env).host).toBe('hosts--staging.sites.test');

		const listed = core.environments.list(owner, row);
		expect(listed.map((entry) => entry.slug)).toEqual(['production', 'staging']);
		expect(listed.find((entry) => entry.isProduction)?.host).toBe('hosts.sites.test');
	});

	test('environment slugs cannot shadow preview hosts or production', () => {
		expect(() => environmentCreateSchema.parse({ name: 'Bad', slug: 'bad--env' })).toThrow();
		expect(() => environmentCreateSchema.parse({ name: 'Prod', slug: 'production' })).toThrow();
		expect(environmentCreateSchema.parse({ name: 'Staging' }).slug).toBeUndefined();
	});
});

describe('production isolation', () => {
	test('a non-production deploy moves only that environment pointer', async () => {
		await project('isolation');
		staging('isolation');

		const view = await deploy('isolation', 'staging one', { environment: 'staging' });
		expect(view.isProduction).toBe(false);
		expect(view.environmentSlug).toBe('staging');
		expect(view.productionUrl).toBe('https://isolation--staging.sites.test');

		expect(requireProject('isolation').productionDeploymentId).toBeNull();
		expect(pointer('isolation', 'production')).toBeNull();
		expect(pointer('isolation', 'staging')).toBe(view.id);

		const live = await deploy('isolation', 'production one');
		expect(live.isProduction).toBe(true);
		expect(live.productionUrl).toBe('https://isolation.sites.test');
		expect(requireProject('isolation').productionDeploymentId).toBe(live.id);
		expect(pointer('isolation', 'production')).toBe(live.id);
		// Staging keeps serving its own deployment.
		expect(pointer('isolation', 'staging')).toBe(view.id);

		// Host resolution follows the environment pointer and its own access mode; the bare host
		// follows the project pointer (the dev content server and site-login bridge rely on this).
		expect(core.access.resolveContentHost('isolation--staging.sites.test')).toMatchObject({
			deploymentId: view.id,
			production: true,
			access: 'platform',
		});
		expect(core.access.resolveContentHost('isolation.sites.test')).toMatchObject({
			deploymentId: live.id,
			production: true,
			access: 'public',
		});
	});

	test('deployFiles carries the environment through the service', async () => {
		await project('files-env');
		staging('files-env');
		const view = await core.deploy.deployFiles(owner, {
			project: 'files-env',
			files: [file('index.html', 'via deployFiles')],
			promote: true,
			environment: 'staging',
		});
		expect(view.environmentSlug).toBe('staging');
		expect(pointer('files-env', 'staging')).toBe(view.id);
		expect(requireProject('files-env').productionDeploymentId).toBeNull();
	});

	test('a deploy that names an unknown environment fails', async () => {
		await project('missing-env');
		await expect(deploy('missing-env', 'nope', { environment: 'ghost' })).rejects.toMatchObject({
			code: 'not_found',
		});
	});
});

describe('promotion', () => {
	test('promote moves the named environment pointer only', async () => {
		await project('promote-env');
		staging('promote-env');
		const first = await deploy('promote-env', 'first', { environment: 'staging' });
		const second = await deploy('promote-env', 'second', { environment: 'staging', promote: false });
		expect(pointer('promote-env', 'staging')).toBe(first.id);

		const promoted = await core.environments.promote(owner, requireProject('promote-env'), 'staging', second.id);
		expect(promoted.id).toBe(second.id);
		expect(pointer('promote-env', 'staging')).toBe(second.id);
		expect(requireProject('promote-env').productionDeploymentId).toBeNull();

		// An explicit promotion to production is allowed and does not disturb staging.
		const live = await core.environments.promote(owner, requireProject('promote-env'), 'production', second.id);
		expect(live.isProduction).toBe(true);
		expect(requireProject('promote-env').productionDeploymentId).toBe(second.id);
		expect(pointer('promote-env', 'staging')).toBe(second.id);
		expect(pointer('promote-env', 'production')).toBe(second.id);
	});

	test('rollback walks the environment history', async () => {
		await project('rollback-env');
		staging('rollback-env');
		const a = await deploy('rollback-env', 'a', { environment: 'staging' });
		const b = await deploy('rollback-env', 'b', { environment: 'staging' });
		const c = await deploy('rollback-env', 'c', { environment: 'staging' });
		expect(pointer('rollback-env', 'staging')).toBe(c.id);

		expect((await core.environments.rollback(owner, requireProject('rollback-env'), 'staging')).id).toBe(b.id);
		expect((await core.environments.rollback(owner, requireProject('rollback-env'), 'staging')).id).toBe(a.id);
		await expect(core.environments.rollback(owner, requireProject('rollback-env'), 'staging')).rejects.toMatchObject({
			code: 'conflict',
		});
		// Production never had a pointer, so its own rollback is still the v1 conflict.
		await expect(core.environments.rollback(owner, requireProject('rollback-env'), 'production')).rejects.toMatchObject({
			code: 'conflict',
		});
	});

	test('deleting an environment current deployment falls back to the previous one', async () => {
		await project('delete-env');
		staging('delete-env');
		const first = await deploy('delete-env', 'one', { environment: 'staging' });
		const second = await deploy('delete-env', 'two', { environment: 'staging' });
		expect(pointer('delete-env', 'staging')).toBe(second.id);

		await core.deployments.delete(owner, requireProject('delete-env'), second.id);
		expect(pointer('delete-env', 'staging')).toBe(first.id);
		await core.deployments.delete(owner, requireProject('delete-env'), first.id);
		expect(pointer('delete-env', 'staging')).toBeNull();
	});
});

describe('desired state routes', () => {
	test('staging gets a production route at its environment host before production exists', async () => {
		await project('routes-env');
		staging('routes-env', 'public');
		const view = await deploy('routes-env', 'staging only', { environment: 'staging' });

		const state = await core.nodes.desiredState(edge.token);
		const hosts = state.routes.map((route) => route.host);
		expect(hosts).toContain('routes-env--staging.sites.test');
		expect(hosts).not.toContain('routes-env.sites.test');
		// Preview hosts keep their immutable shape.
		expect(hosts).toContain(view.previewUrl.replace('https://', ''));

		const stagingRoute = state.routes.find((route) => route.host === 'routes-env--staging.sites.test')!;
		expect(stagingRoute).toMatchObject({
			production: true,
			deploymentId: view.id,
			accessMode: 'public',
			projectId: requireProject('routes-env').id,
		});
	});

	test('production and staging routes are emitted side by side with their own access modes', async () => {
		await project('routes-both');
		staging('routes-both', 'password');
		const staged = await deploy('routes-both', 'staged', { environment: 'staging' });
		const live = await deploy('routes-both', 'live');

		const state = await core.nodes.desiredState(edge.token);
		const production = state.routes.find((route) => route.host === 'routes-both.sites.test')!;
		const stagingRoute = state.routes.find((route) => route.host === 'routes-both--staging.sites.test')!;

		expect(production).toMatchObject({ deploymentId: live.id, accessMode: 'public', production: true });
		expect(stagingRoute).toMatchObject({ deploymentId: staged.id, accessMode: 'password', production: true });
		// Both deployments still have their preview route, exactly once each.
		expect(state.routes.filter((route) => route.deploymentId === live.id)).toHaveLength(2);
		expect(state.routes.filter((route) => route.deploymentId === staged.id)).toHaveLength(2);
	});
});

describe('workload service calls used by the REST surface', () => {
	test('set, read, capacity and remove', async () => {
		const row = await project('workloads', 'process');

		expect(core.workloads.get(owner, row)).toBeNull();
		const set = core.workloads.setSpec(
			owner,
			row,
			workloadSpecSchema.parse({
				runtime: 'process',
				command: ['bun', 'run', 'start'],
				memoryMb: 128,
				env: { NODE_ENV: 'production' },
			}),
		);
		expect(set).toBeNull();
		expect(requireProject('workloads').workloadJson).toContain('128');

		const view = await deploy('workloads', 'app');
		const workload = core.workloads.get(owner, requireProject('workloads'))!;
		expect(workload).toMatchObject({
			deploymentId: view.id,
			nodeId: edge.nodeId,
			runtime: 'process',
			memoryMb: 128,
			status: 'pending',
		});

		const capacity = core.workloads.capacity(owner);
		const node = capacity.find((entry) => entry.nodeId === edge.nodeId)!;
		expect(node.reservedMemoryMb).toBeGreaterThanOrEqual(128);
		expect(node.freeMemoryMb).toBe(node.sliceMemoryMb - node.reservedMemoryMb);
		expect(node.workloadCount).toBeGreaterThanOrEqual(1);

		const spec = core.workloads.projectSpec(requireProject('workloads'))!;
		expect(spec.env).toEqual({ NODE_ENV: 'production' });

		core.workloads.remove(owner, requireProject('workloads'));
		expect(core.workloads.get(owner, requireProject('workloads'))).toBeNull();
		expect(requireProject('workloads').workloadJson).toBeNull();
	});

	test('static projects reject workload specs', async () => {
		const row = await project('static-workload');
		expect(() =>
			core.workloads.setSpec(owner, row, workloadSpecSchema.parse({ runtime: 'process' })),
		).toThrow(/static/i);
	});
});

describe('resource-scoped access', () => {
	test('project and environment bindings bound what a guest may list and update', async () => {
		const visible = await project('scoped-env-visible');
		await project('scoped-env-hidden');
		const hidden = requireProject('scoped-env-hidden');
		const stagingRow = staging('scoped-env-visible');
		core.environments.create(owner, visible, { name: 'QA' });
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_guest_envs', 'org_1', 'user', 'user_guest_envs', 'viewer', 'project', ?, 'test', 0)`,
			[visible.id],
		);
		const reader = buildPrincipal({
			kind: 'user',
			userId: 'user_guest_envs',
			orgId: 'org_1',
			role: 'viewer',
		});
		const slugs = core.environments.list(reader, visible).map((entry) => entry.slug);
		expect(slugs).toContain('staging');
		expect(slugs).toContain('qa');
		expect(() => core.environments.list(reader, hidden)).toThrow(/project:read/);

		// An environment-scope binding covers that environment only, even inside the same project.
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id, created_by, created_at)
			 VALUES ('bind_guest_env_staging', 'org_1', 'user', 'user_guest_env_staging', 'deployer', 'environment', ?, ?, 'test', 0)`,
			[stagingRow.id, visible.id],
		);
		const writer = buildPrincipal({
			kind: 'user',
			userId: 'user_guest_env_staging',
			orgId: 'org_1',
			role: 'viewer',
		});
		expect(core.environments.update(writer, visible, 'staging', { name: 'Renamed staging' }).name).toBe(
			'Renamed staging',
		);
		expect(() => core.environments.update(writer, visible, 'qa', { name: 'Q' })).toThrow(/project:update/);
		expect(() => core.environments.remove(writer, visible, 'qa')).toThrow(/project:update/);
	});
});
