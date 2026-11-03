import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, nodes } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
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
});

function workoutId(state: Awaited<ReturnType<Core['nodes']['desiredState']>>): string {
	return state.workloads[0]!.id;
}
