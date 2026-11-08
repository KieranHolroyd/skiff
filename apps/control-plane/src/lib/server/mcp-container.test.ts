import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities, type InlineFile } from '@skiff/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@skiff/core';
import { createDb } from '@skiff/db';
import { needsConfirmation } from './assistant/confirm-policy';

/**
 * Container console MCP tools (D127): read-only plus restart. There is deliberately no shell
 * tool: command execution stays with people (dashboard, `skif container shell`).
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mcp-container-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123'
);
const features = { ...DEFAULT_FEATURES, CONTAINER_CONSOLE: true };
const realCore: Core = createCore({
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
		// Nothing listens here, so console calls fail fast with the gateway message.
		databaseGatewayPort: 1,
		features
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const file = (path: string, content: string): InlineFile => ({ path, content, encoding: 'utf8' });
const TOOLS = [
	'inspect_container',
	'list_container_files',
	'read_container_file',
	'restart_container'
];

async function call(name: string, args: Record<string, unknown>) {
	const tool = assistantTools(owner).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool.run(args);
}

describe('container console MCP tools', () => {
	test('setup: a console-capable node running a container project', async () => {
		const joined = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		realCore.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: [...nodeCapabilities],
			releases: []
		} as never);
		await realCore.projects.create(owner, {
			name: 'shop',
			slug: 'shop',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform'
		});
		realCore.workloads.setSpec(owner, realCore.projects.requireRow(owner, 'shop'), {
			runtime: 'container',
			image: 'ghcr.io/acme/shop:1',
			port: 8080,
			memoryMb: 128,
			cpus: 1,
			healthPath: '/',
			env: {},
			secrets: []
		} as never);
		await realCore.uploads.deployInline(
			owner,
			realCore.projects.requireRow(owner, 'shop'),
			[file('README', 'x')],
			{
				promote: true
			}
		);
	});

	test('are registered with read-only hints and no shell tool', () => {
		const definitions = skiffToolDefinitions(owner);
		const names = new Set(definitions.map((entry) => entry.name));
		for (const name of TOOLS) expect(names.has(name)).toBe(true);
		expect([...names].some((name) => /container.*(exec|shell|command)/.test(name))).toBe(false);
		for (const name of TOOLS.slice(0, 3))
			expect(
				definitions.find((entry) => entry.name === name)?.config.annotations?.readOnlyHint
			).toBe(true);
		expect(needsConfirmation('restart_container', { destructiveHint: false })).toBe(true);
	});

	test('reads go to the node through the gateway', async () => {
		const result = await call('inspect_container', { project: 'shop' });
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/internal gateway/);
	});

	test('restart bumps the generation', async () => {
		const result = await call('restart_container', { project: 'shop' });
		// The assistant asks before running it; the core change itself is covered in core tests.
		expect(JSON.stringify(result)).toMatch(/confirm|generation/i);
	});

	test('disappear with the feature flag', () => {
		features.CONTAINER_CONSOLE = false;
		try {
			const names = new Set(skiffToolDefinitions(owner).map((entry) => entry.name));
			for (const name of TOOLS) expect(names.has(name)).toBe(false);
		} finally {
			features.CONTAINER_CONSOLE = true;
		}
	});
});
