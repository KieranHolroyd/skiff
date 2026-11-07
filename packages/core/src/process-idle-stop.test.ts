import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/** Scale to zero for process apps (D121): the spec field reaches the node's desired state. */
const dir = mkdtempSync(join(tmpdir(), 'skiff-idle-stop-'));
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

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('process apps that scale to zero', () => {
	let nodeToken = '';

	test('idleStopSeconds is sent to the node only for the app that sets it', async () => {
		nodeToken = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' }).token;
		for (const slug of ['php', 'always-on']) {
			await core.projects.create(principal, {
				name: slug,
				slug,
				runtime: 'process',
				placement: 'auto',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			const project = core.projects.requireRow(principal, slug);
			core.workloads.setSpec(principal, project, {
				runtime: 'process',
				command: ['./frankenphp', 'run', '--config', 'Caddyfile'],
				memoryMb: 128,
				...(slug === 'php' ? { idleStopSeconds: 120 } : {}),
			});
			// Re-read the row: setSpec stores the spec on the project, and the deploy plans from it.
			await core.uploads.deployInline(principal, core.projects.requireRow(principal, slug), [file('index.php', '<?php echo "hi";')], { promote: true });
		}

		const state = await core.nodes.desiredState(nodeToken);
		const php = state.workloads.find((workload) => workload.projectSlug === 'php');
		const alwaysOn = state.workloads.find((workload) => workload.projectSlug === 'always-on');
		expect(php).toMatchObject({ runtime: 'process', socketActivation: true, idleStopSeconds: 120 });
		expect(alwaysOn).toBeDefined();
		expect('idleStopSeconds' in alwaysOn!).toBe(false);
	});

	test('a spec that cannot scale to zero is refused before it is stored', () => {
		const project = core.projects.requireRow(principal, 'always-on');
		expect(() =>
			core.workloads.setSpec(principal, project, {
				runtime: 'process',
				command: ['./app'],
				socketActivation: false,
				idleStopSeconds: 60,
			}),
		).toThrow(/socket activation/);
	});
});
