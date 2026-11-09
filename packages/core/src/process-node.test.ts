import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROCESS_NODE_CAPABILITY, workloadSpecSchema } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { withEngineCommand } from './workloads.ts';

/** Node.js process apps (D125): engine, default command, placement and desired state. */
const dir = mkdtempSync(join(tmpdir(), 'yoal-process-node-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');

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
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const release = () => [
	file('package.json', JSON.stringify({ name: 'app', scripts: { start: 'node server.js' } })),
	file('server.js', "require('node:http').createServer((_, res) => res.end('ok')).listen(3000);"),
];

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('withEngineCommand', () => {
	const parse = (input: Record<string, unknown>) => workloadSpecSchema.parse({ runtime: 'process', ...input });

	test('a Node app with the Bun default loses it, so the node runs the start script', () => {
		expect(withEngineCommand(parse({ engine: 'node', command: ['bun', 'run', 'start'] })).command).toBeUndefined();
		expect(withEngineCommand(parse({ engine: 'node' })).command).toBeUndefined();
	});

	test('an explicit command and every Bun spec are left alone', () => {
		expect(withEngineCommand(parse({ engine: 'node', command: ['node', 'dist/server.js'] })).command).toEqual([
			'node',
			'dist/server.js',
		]);
		expect(withEngineCommand(parse({ command: ['bun', 'run', 'start'] })).command).toEqual(['bun', 'run', 'start']);
		expect(withEngineCommand(parse({})).command).toBeUndefined();
	});

	test('launchers that drop the activated socket are refused while socket activation is on', () => {
		for (const command of [['npm', 'start'], ['node', '--run', 'start'], ['/usr/local/bin/npx', 'serve']]) {
			const result = workloadSpecSchema.safeParse({ runtime: 'process', engine: 'node', command });
			expect(result.success).toBe(false);
			expect(result.error?.issues[0]?.message).toMatch(/without the activated socket/);
		}
		expect(
			workloadSpecSchema.safeParse({ runtime: 'process', engine: 'node', command: ['npm', 'start'], socketActivation: false })
				.success,
		).toBe(true);
		// Bun apps are not Node's business.
		expect(workloadSpecSchema.safeParse({ runtime: 'process', command: ['npm', 'start'] }).success).toBe(true);
	});

	test('only process apps choose an engine', () => {
		expect(workloadSpecSchema.safeParse({ runtime: 'container', image: 'nginx', engine: 'node' }).success).toBe(false);
		expect(workloadSpecSchema.safeParse({ runtime: 'process', engine: 'deno' }).success).toBe(false);
	});
});

describe('Node.js process apps', () => {
	let nodeToken = '';
	let nodeId = '';
	const heartbeat = (capabilities: string[]) =>
		core.nodes.heartbeat(nodeToken, {
			nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities,
			releases: [],
		});

	test('a node without Node.js refuses a Node app', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		nodeId = joined.nodeId;
		heartbeat(['functions']);
		for (const slug of ['node-app', 'bun-app']) {
			await core.projects.create(principal, {
				name: slug,
				slug,
				runtime: 'process',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
		}
		core.workloads.setSpec(principal, core.projects.requireRow(principal, 'node-app'), {
			runtime: 'process',
			engine: 'node',
			memoryMb: 128,
		});
		core.workloads.setSpec(principal, core.projects.requireRow(principal, 'bun-app'), {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			memoryMb: 128,
		});
		await expect(
			core.uploads.deployInline(principal, core.projects.requireRow(principal, 'node-app'), release(), { promote: true }),
		).rejects.toThrow(/cannot run Node.js apps yet/);
	});

	test('once the node advertises process-node, the app deploys and the node picks the start script', async () => {
		heartbeat(['functions', PROCESS_NODE_CAPABILITY]);
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'node-app'), release(), {
			promote: true,
		});
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'bun-app'), release(), {
			promote: true,
		});
		const state = await core.nodes.desiredState(nodeToken);
		const nodeApp = state.workloads.find((workload) => workload.projectSlug === 'node-app');
		const bunApp = state.workloads.find((workload) => workload.projectSlug === 'bun-app');
		expect(nodeApp).toMatchObject({ runtime: 'process', engine: 'node', socketActivation: true });
		expect('command' in nodeApp!).toBe(false);
		// Bun apps' desired state carries no engine field, so it is unchanged by D125.
		expect(bunApp).toBeDefined();
		expect('engine' in bunApp!).toBe(false);
	});
});
