import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import {
	containerConsoleActivationSchema,
	containerConsoleHost,
	DEFAULT_FEATURES,
	desiredStateSchema,
} from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-container-console-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:00Z');
const features = { ...DEFAULT_FEATURES, CONTAINER_CONSOLE: true };
const GIB = 1024 ** 3;

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
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const apiKey = buildPrincipal({
	kind: 'apiKey',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['container:inspect', 'container:files', 'container:exec', 'project:read'],
});
const mcp = buildPrincipal({
	kind: 'mcp',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	granted: ['container:inspect', 'container:files', 'container:exec', 'project:read'],
});
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

let edgeToken = '';
let edgeId = '';

function heartbeat(capabilities: string[]) {
	core.nodes.heartbeat(edgeToken, {
		nodeId: edgeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		capabilities,
		stats: {
			cpuPercent: 5,
			memoryBytes: GIB,
			memoryTotalBytes: 8 * GIB,
			diskUsedBytes: 10 * GIB,
			diskTotalBytes: 100 * GIB,
			diskFreeBytes: 90 * GIB,
		},
		releases: [],
	} as never);
}

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeToken = joined.token;
	edgeId = joined.nodeId;
	await core.projects.create(owner, {
		name: 'shop',
		slug: 'shop',
		runtime: 'container',
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shop'), {
		runtime: 'container',
		image: 'ghcr.io/acme/api:1.0',
		port: 8080,
		memoryMb: 256,
		cpus: 1,
		healthPath: '/',
		env: {},
		secrets: [],
	} as never);
	await core.uploads.deployInline(owner, core.projects.requireRow(owner, 'shop'), [file('README', 'x')], { promote: true });
	await core.projects.create(owner, {
		name: 'site',
		slug: 'site',
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
});

describe('container console', () => {
	test('lists the container target on its node', () => {
		expect(core.containerConsole.targets(owner, 'shop')).toEqual([
			{ replica: null, nodeId: edgeId, nodeName: 'edge', desiredId: expect.stringMatching(/^wld_/) },
		]);
		expect(core.containerConsole.targets(owner, 'site')).toEqual([]);
		expect(failure(() => core.containerConsole.targets(otherOrg, 'shop')).status).toBe(404);
	});

	test('refuses nodes whose agent cannot run the console', () => {
		heartbeat(['node-tasks']);
		expect(failure(() => core.containerConsole.endpoint(owner, 'shop', 'inspect')).message).toMatch(/Update the node/);
	});

	test('mints a token the node can activate, and only that node', async () => {
		heartbeat(['node-tasks', 'container-console']);
		const endpoint = core.containerConsole.endpoint(owner, 'shop', 'exec');
		expect(endpoint.host).toBe(containerConsoleHost(edgeId));
		expect(endpoint.scopes).toEqual(['inspect', 'files', 'exec']);
		expect(endpoint.token).toMatch(/^cc1\./);

		const activation = core.containerConsole.activation(edgeId, endpoint.token);
		expect(containerConsoleActivationSchema.parse(activation)).toMatchObject({
			workloadId: endpoint.desiredId,
			userId: 'user_1',
			scopes: ['inspect', 'files', 'exec'],
		});
		expect(failure(() => core.containerConsole.activation('node_other', endpoint.token)).status).toBe(403);
		const [version, payload, signature] = endpoint.token.split('.');
		const forged = `${version}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), u: 'user_x' })).toString('base64url')}.${signature}`;
		expect(failure(() => core.containerConsole.activation(edgeId, forged)).status).toBe(403);

		clock += 6 * 60_000;
		expect(failure(() => core.containerConsole.activation(edgeId, endpoint.token)).message).toMatch(/expired/);
	});

	test('scopes follow permissions; MCP never gets a shell', () => {
		const viewerEndpoint = core.containerConsole.endpoint(viewer, 'shop', 'inspect');
		expect(viewerEndpoint.scopes).toEqual(['inspect']);
		expect(failure(() => core.containerConsole.endpoint(viewer, 'shop', 'exec')).message).toMatch(/container:exec/);
		// The CLI authenticates with an API key: files and shells work when the key holds them.
		expect(core.containerConsole.endpoint(apiKey, 'shop', 'exec').scopes).toEqual(['inspect', 'files', 'exec']);
		expect(core.containerConsole.endpoint(mcp, 'shop', 'files').scopes).toEqual(['inspect', 'files']);
		expect(failure(() => core.containerConsole.endpoint(mcp, 'shop', 'exec')).message).toMatch(/MCP clients cannot open/);
		expect(failure(() => core.containerConsole.endpoint(owner, 'site', 'inspect')).message).toMatch(/no running container/);
	});

	test('desired state opens the front and routes the console host', async () => {
		const state = desiredStateSchema.parse(await core.nodes.desiredState(edgeToken));
		expect(state.containerConsole).toEqual({ port: 8084 });
		expect(state.databaseGateway.routes).toContainEqual({ host: containerConsoleHost(edgeId), upstream: '127.0.0.1:8084' });
	});

	test('the feature flag closes everything', async () => {
		features.CONTAINER_CONSOLE = false;
		try {
			const state = await core.nodes.desiredState(edgeToken);
			expect(state.containerConsole).toBeNull();
			expect(state.databaseGateway.routes.some((route) => route.host.endsWith('console.internal'))).toBe(false);
			expect(failure(() => core.containerConsole.endpoint(owner, 'shop', 'inspect')).status).toBe(409);
		} finally {
			features.CONTAINER_CONSOLE = true;
		}
	});

	test('restart bumps the activation version through desired state and is audited', async () => {
		const before = (await core.nodes.desiredState(edgeToken)).workloads.find((item) => item.projectSlug === 'shop')!;
		expect(core.containerConsole.restart(owner, 'shop')).toEqual({ generation: 1 });
		const after = (await core.nodes.desiredState(edgeToken)).workloads.find((item) => item.projectSlug === 'shop')!;
		expect(after.activationVersion).not.toBe(before.activationVersion);
		expect(core.workloads.activation(edgeId, after.id).activationVersion).toBe(after.activationVersion);
		expect(failure(() => core.containerConsole.restart(viewer, 'shop')).message).toMatch(/project:update/);
		expect(core.audit.list({ orgId: 'org_1', action: 'container.restart', limit: 5 })).toHaveLength(1);
	});

	test('records shell and file activity without contents', () => {
		core.containerConsole.record(owner, 'shop', { op: 'exec.open', shell: 'auto', user: 'root', replica: null });
		core.containerConsole.record(owner, 'shop', { op: 'files.download', path: '/data/app.db', sizeBytes: 4096, replica: null });
		const entries = core.audit.list({ orgId: 'org_1', limit: 50 }).filter((entry) => entry.action.startsWith('container.'));
		expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(['container.exec.open', 'container.files.download']));
		const download = entries.find((entry) => entry.action === 'container.files.download')!;
		expect(JSON.parse(download.argsJson ?? '{}')).toMatchObject({ slug: 'shop', path: '/data/app.db', sizeBytes: 4096 });
	});
});
