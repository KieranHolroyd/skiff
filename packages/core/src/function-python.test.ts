import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, FUNCTIONS_PYTHON_CAPABILITY, type InlineFile } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { sha256Hex } from './util.ts';

/** Python Workers in the control plane (D121): flag, memory default and placement. */
const dir = mkdtempSync(join(tmpdir(), 'skiff-fn-python-'));
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
		features: { ...DEFAULT_FEATURES, FUNCTIONS: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string): InlineFile => ({ path, content, encoding: 'utf8' });

const ENTRY = 'from workers import WorkerEntrypoint, Response\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        return Response("hi")\n';
function bundle(extra: Record<string, unknown> = {}): InlineFile[] {
	const manifest = {
		version: 1,
		main: 'entry.py',
		modules: [{ name: 'entry.py', type: 'python', sha256: sha256Hex(new TextEncoder().encode(ENTRY)) }],
		compatibilityDate: '2026-10-01',
		compatibilityFlags: [],
		bindings: [],
		triggers: { crons: [], queues: [] },
		...extra,
	};
	return [file('skiff-function.json', JSON.stringify(manifest)), file('entry.py', ENTRY)];
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('Python functions', () => {
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

	test('a node without the Pyodide cache refuses a Python function', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		nodeId = joined.nodeId;
		heartbeat(['functions']);
		core.nodes.update(principal, nodeId, { sliceMemoryMb: 4096 });
		await core.projects.create(principal, {
			name: 'py-fn',
			slug: 'py-fn',
			runtime: 'function',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		await expect(
			core.uploads.deployInline(principal, core.projects.requireRow(principal, 'py-fn'), bundle(), { promote: true }),
		).rejects.toThrow(/cannot run Python functions yet/);
	});

	test('with the cache it deploys, adds python_workers and reserves 384 MB', async () => {
		heartbeat(['functions', FUNCTIONS_PYTHON_CAPABILITY]);
		await core.uploads.deployInline(principal, core.projects.requireRow(principal, 'py-fn'), bundle(), { promote: true });
		const spec = core.workloads.projectSpec(core.projects.requireRow(principal, 'py-fn'));
		expect(spec?.memoryMb).toBe(384);
		expect(spec?.function?.compatibilityFlags).toEqual(['python_workers']);
		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'py-fn');
		expect(workload?.function?.modules.map((module) => module.type)).toEqual(['python']);
	});

	test('an explicit memory below the Pyodide floor is refused', async () => {
		await expect(
			core.uploads.deployInline(principal, core.projects.requireRow(principal, 'py-fn'), bundle({ memoryMb: 128 }), { promote: true }),
		).rejects.toThrow(/at least 256 MB/);
	});
});
