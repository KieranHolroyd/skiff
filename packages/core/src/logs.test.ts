import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-logs-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123',
);
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

const principal = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true,
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function projectWithBuild(): Promise<{
	project: ReturnType<typeof core.projects.requireRow>;
	buildId: string;
	nodeId: string;
	deploymentId: string;
}> {
	const slug = `logs-${Math.random().toString(36).slice(2, 8)}`;
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const project = core.projects.requireRow(principal, slug);
	core.builds.upsertGitSource(principal, project, {
		repoUrl: 'https://github.com/acme/logs.git',
		branch: 'main',
		rootDir: '.',
		buildCommand: 'bun run build',
		outputDir: 'dist',
		enabled: true,
	});
	const node = core.nodes.join({
		token: core.nodes.createJoinToken(principal, `builder-${slug}`).token,
		name: `builder-${slug}`,
	});
	core.nodes.setBuilder(principal, node.nodeId, true);
	const build = core.builds.enqueue(principal, project, {
		ref: 'main',
		promote: false,
	});
	expect((await core.builds.claim(node.nodeId))?.buildId).toBe(build.id);
	const deployment = await core.deployments.deployEntries(
		principal,
		project,
		[{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }],
		{ promote: true },
	);
	return {
		project: core.projects.requireRow(principal, slug),
		buildId: build.id,
		nodeId: node.nodeId,
		deploymentId: deployment.id,
	};
}

describe('log drain', () => {
	test('stores ordered build chunks and queries from a cursor', async () => {
		const { project, buildId, nodeId } = await projectWithBuild();
		expect(
			core.logs.appendBuild(nodeId, buildId, {
				stream: 'stdout',
				lines: ['bun install', 'installed 120 packages'],
			}),
		).toBe(true);
		clock += 10;
		expect(
			core.logs.appendBuild(nodeId, buildId, {
				stream: 'stderr',
				lines: ['warning: peer dependency'],
			}),
		).toBe(true);

		const all = core.logs.query(principal, project, {
			source: 'build',
			buildId,
		});
		expect(all.events.map((event) => event.message)).toEqual([
			'bun install',
			'installed 120 packages',
			'warning: peer dependency',
		]);
		expect(all.events[0]?.level).toBe('info');
		expect(all.events[2]?.level).toBe('warn');
		expect(all.events[2]?.stream).toBe('stderr');

		const after = core.logs.query(principal, project, {
			source: 'build',
			buildId,
			after: all.events[0]!.seq,
		});
		expect(after.events).toHaveLength(2);
		expect(after.cursor).toBe(all.cursor);
	});

	test('appends runtime lines only for the workload node', async () => {
		const { project, nodeId, deploymentId } = await projectWithBuild();
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
			[
				'wld_test',
				project.orgId,
				project.id,
				deploymentId,
				nodeId,
				clock,
				clock,
			],
		);

		const stored = core.logs.appendRuntime(nodeId, {
			workloadId: 'wld_test',
			lines: [
				{
					ts: clock,
					stream: 'stdout',
					level: 'info',
					message: 'listening on :3000',
				},
				{ ts: clock, stream: 'stderr', level: 'error', message: 'boom' },
			],
		});
		expect(stored).toBe(2);

		const runtime = core.logs.query(principal, project, {
			source: 'runtime',
			deploymentId,
		});
		expect(runtime.events.map((event) => event.message)).toEqual([
			'listening on :3000',
			'boom',
		]);
		expect(
			runtime.events.every((event) => event.deploymentId === deploymentId),
		).toBe(true);

		expect(() =>
			core.logs.appendRuntime('nod_other', {
				workloadId: 'wld_test',
				lines: [
					{ ts: clock, stream: 'stdout', level: 'info', message: 'nope' },
				],
			}),
		).toThrow(/another node/);
	});

	test('requires logs:read and prunes by age', async () => {
		const { project } = await projectWithBuild();
		const reader = buildPrincipal({
			kind: 'apiKey',
			userId: 'user_1',
			orgId: 'org_1',
			role: 'viewer',
			granted: ['project:read'],
		});
		expect(() => core.logs.query(reader, project, {})).toThrow(/logs:read/);

		const pruned = core.logs.prune(clock + 1_000, 500);
		expect(pruned).toBeGreaterThan(0);
	});
});
