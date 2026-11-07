import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, nodes } from '@skiff/db';
import { workloadReplicaId, workloadSpecSchema } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { upstreamFor } from './workloads.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-workloads-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.now();

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

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('tier 2 workloads', () => {
	let nodeToken = '';
	let nodeId = '';

	test('registers an edge node with a workload budget', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		nodeId = joined.nodeId;
		expect(core.nodes.list(principal).find((node) => node.id === nodeId)?.mode).toBe('edge');
	});

	test('creates a process project and persists a workload spec', async () => {
		await core.projects.create(principal, {
			name: 'app',
			slug: 'app',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(principal, 'app');
		const view = core.workloads.setSpec(principal, project, {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: true,
			env: { NODE_ENV: 'production' },
			secrets: [],
		});
		expect(view).toBeNull();
		expect(core.workloads.projectSpec(core.projects.requireRow(principal, 'app'))?.memoryMb).toBe(256);
	});

	test('deploying admits the workload and records it for the node', async () => {
		const project = core.projects.requireRow(principal, 'app');
		const deployment = await core.uploads.deployInline(
			principal,
			project,
			[file('index.js', 'console.log("hi")'), file('package.json', '{"name":"app"}')],
			{ promote: true },
		);
		expect(deployment.runtime).toBe('process');
		const workload = core.workloads.view(core.projects.requireRow(principal, 'app'));
		expect(workload).toMatchObject({ deploymentId: deployment.id, nodeId, status: 'pending', memoryMb: 256 });
		expect(core.workloads.capacity(principal).find((row) => row.nodeId === nodeId)?.reservedMemoryMb).toBe(256);

		const state = await core.nodes.desiredState(nodeToken);
		expect(state.workloads).toHaveLength(1);
		expect(state.workloads[0]).toMatchObject({
			projectSlug: 'app',
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			upstream: `unix//run/skiff-workloads/${project.id}.sock`,
			env: { NODE_ENV: 'production' },
		});
		expect(state.sliceMemoryMb).toBe(1024);
	});

	test('refuses a deploy that exceeds the slice budget', async () => {
		opened.db.update(nodes).set({ sliceMemoryMb: 300 }).where(eq(nodes.id, nodeId)).run();
		const project = core.projects.requireRow(principal, 'app');
		await expect(
			core.uploads.deployInline(principal, project, [file('other.js', 'x')], { promote: false }),
		).rejects.toMatchObject({ code: 'validation' });
		opened.db.update(nodes).set({ sliceMemoryMb: 1024 }).where(eq(nodes.id, nodeId)).run();
	});

	test('delivers secret values only through the activation endpoint', async () => {
		const project = core.projects.requireRow(principal, 'app');
		await core.secrets.set(principal, { name: 'DATABASE_URL', value: 'postgres://secret', type: 'secret' });
		core.workloads.setSpec(principal, project, {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: true,
			env: {},
			secrets: [{ name: 'DATABASE_URL', delivery: 'env' }],
		});
		const workload = core.workloads.view(core.projects.requireRow(principal, 'app'));
		expect(workload).not.toBeNull();
		const state = await core.nodes.desiredState(nodeToken);
		expect(JSON.stringify(state)).not.toContain('postgres://secret');
		const activation = core.workloads.activation(nodeId, workoutId(state));
		expect(activation.env.DATABASE_URL).toBe('postgres://secret');
		expect(() => core.workloads.activation('nod_other', workoutId(state))).toThrow();
	});

	test('scopes secrets to their project and lets a project secret override the organisation', async () => {
		await core.projects.create(principal, {
			name: 'other',
			slug: 'other',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const app = core.projects.requireRow(principal, 'app');
		const other = core.projects.requireRow(principal, 'other');
		const otherSecret = await core.secrets.set(principal, { name: 'API_KEY', value: 'other-key', projectId: other.id });
		const spec = {
			runtime: 'process' as const,
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: true,
			env: {},
			secrets: [{ name: 'API_KEY', delivery: 'env' as const }],
		};
		// Another project's secret is invisible: referencing it is refused up front.
		expect(() => core.workloads.setSpec(principal, app, spec)).toThrow(/API_KEY does not exist/);
		expect(core.secrets.getValue('org_1', 'API_KEY', undefined, app.id)).toBeNull();
		expect(otherSecret.version).toBe(1);

		const orgSecret = await core.secrets.set(principal, { name: 'API_KEY', value: 'org-key' });
		expect(orgSecret.version).toBe(1);
		core.workloads.setSpec(principal, app, spec);
		const state = await core.nodes.desiredState(nodeToken);
		const appWorkload = state.workloads.find((item) => item.projectSlug === 'app')!;
		expect(core.workloads.activation(nodeId, appWorkload.id).env.API_KEY).toBe('org-key');

		await core.secrets.set(principal, { name: 'API_KEY', value: 'app-key', projectId: app.id });
		expect(core.workloads.activation(nodeId, appWorkload.id).env.API_KEY).toBe('app-key');
		expect(core.secrets.getValue('org_1', 'API_KEY', undefined, other.id)?.value).toBe('other-key');
		const visible = core.secrets.list(principal, { visibleTo: app.id }).filter((item) => item.name === 'API_KEY');
		expect(visible.map((item) => item.projectId).sort()).toEqual([app.id, null].sort());
		await expect(
			core.secrets.set(principal, { name: 'API_KEY', value: 'x', projectId: 'prj_missing' }),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	test('refuses specs that set a variable twice or pin a missing version', () => {
		const app = core.projects.requireRow(principal, 'app');
		const base = {
			runtime: 'process' as const,
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: true,
		};
		expect(() =>
			core.workloads.setSpec(principal, app, {
				...base,
				env: { API_KEY: 'plain' },
				secrets: [{ name: 'API_KEY', delivery: 'env' }],
			}),
		).toThrow(/set both as a plain variable/);
		expect(() =>
			core.workloads.setSpec(principal, app, {
				...base,
				env: {},
				secrets: [{ name: 'API_KEY', delivery: 'env', version: 9 }],
			}),
		).toThrow(/has no version 9/);
	});

	test('saves plain env and new secrets together, and restarts on a new secret value', async () => {
		const app = core.projects.requireRow(principal, 'app');
		await core.workloads.setVariables(principal, app, {
			env: { NODE_ENV: 'production' },
			secrets: [{ name: 'STRIPE_KEY', delivery: 'env' }],
			newSecrets: [{ name: 'STRIPE_KEY', value: 'sk_one' }],
		});
		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'app'))!;
		expect(spec.env).toEqual({ NODE_ENV: 'production' });
		expect(spec.command).toEqual(['bun', 'run', 'start']);
		expect(JSON.stringify(spec)).not.toContain('sk_one');

		const before = (await core.nodes.desiredState(nodeToken)).workloads.find((item) => item.projectSlug === 'app');
		await core.workloads.setVariables(principal, core.projects.requireRow(principal, 'app'), {
			env: { NODE_ENV: 'production' },
			secrets: [{ name: 'STRIPE_KEY', delivery: 'env' }],
			newSecrets: [{ name: 'STRIPE_KEY', value: 'sk_two' }],
		});
		const after = (await core.nodes.desiredState(nodeToken)).workloads.find((item) => item.projectSlug === 'app');
		expect(before).toBeDefined();
		expect(after!.activationVersion).not.toBe(before!.activationVersion);
		expect(core.secrets.getValue('org_1', 'STRIPE_KEY', undefined, app.id)?.value).toBe('sk_two');
	});

	test('a refused save writes no secret versions', async () => {
		const app = core.projects.requireRow(principal, 'app');
		const count = () => core.secrets.list(principal, { projectId: app.id }).filter((item) => item.name === 'LEAK_TEST').length;
		await expect(
			core.workloads.setVariables(principal, app, {
				env: { LEAK_TEST: 'plain' },
				secrets: [{ name: 'LEAK_TEST', delivery: 'env' }],
				newSecrets: [{ name: 'LEAK_TEST', value: 'value' }],
			}),
		).rejects.toMatchObject({ code: 'validation' });
		expect(count()).toBe(0);
	});
});

function workoutId(state: Awaited<ReturnType<Core['nodes']['desiredState']>>): string {
	return state.workloads[0]!.id;
}

describe('workload upstreams', () => {
	const fnSpec = workloadSpecSchema.parse({
		runtime: 'function',
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: 'a'.repeat(64) }],
			compatibilityDate: '2026-10-01',
			compatibilityFlags: [],
			bindings: [],
			triggers: { crons: [], queues: [] },
			assets: null,
			idleStopSeconds: 300,
			workerdVersion: '1.20261106.1',
		},
	});

	test('a function socket is named after the desired-state id, one per replica', () => {
		expect(upstreamFor(workloadReplicaId('wld_1', 0), fnSpec)).toBe('unix//run/skiff-workloads/wld_1.sock');
		expect(upstreamFor(workloadReplicaId('wld_1', 2), fnSpec)).toBe('unix//run/skiff-workloads/wld_1-r2.sock');
	});

	test('a process socket keeps the project id it has always used', () => {
		const processSpec = workloadSpecSchema.parse({ runtime: 'process', command: ['bun', 'run', 'start'] });
		expect(upstreamFor('prj_1', processSpec)).toBe('unix//run/skiff-workloads/prj_1.sock');
	});
});
