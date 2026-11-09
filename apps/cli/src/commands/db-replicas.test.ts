import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lagLabel } from './db-replicas.ts';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
	ifMatch: string | null;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-replicas-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const replica = (overrides: Record<string, unknown> = {}) => ({
	id: 'dbr_1',
	databaseId: 'db_1',
	nodeId: 'nod_b',
	nodeName: 'worker',
	zone: 'default',
	status: 'streaming',
	replayLsn: '0/3000148',
	lagBytes: 0,
	lagSeconds: 0.2,
	slot: 'yoal_dbr_1',
	primaryGeneration: 2,
	workloadId: 'db_dbr_1',
	mode: 'async',
	hostPort: 15433,
	diskId: null,
	sameNode: false,
	message: null,
	removing: false,
	reportedAt: '2026-11-07T10:00:00.000Z',
	createdAt: '2026-11-07T09:00:00.000Z',
	...overrides,
});

function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({
				method: request.method,
				path: url.pathname,
				body: text ? JSON.parse(text) : undefined,
				ifMatch: request.headers.get('if-match'),
			});
			const route = routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return route instanceof Response ? route : Response.json(route);
		},
	});
	return seen;
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server!.port}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('yoal db replica', () => {
	test('list shows status, lag and the promotion history', async () => {
		serve({
			'GET /api/v1/databases/main/replicas': {
				primaryGeneration: 2,
				replicas: [replica(), replica({ id: 'dbr_2', nodeName: 'edge', sameNode: true, status: 'pending', lagBytes: null, lagSeconds: null, replayLsn: null })],
				failovers: [
					{
						id: 'dfo_1',
						databaseId: 'db_1',
						replicaId: 'dbr_0',
						fromNodeId: 'nod_a',
						fromNodeName: 'homelab',
						toNodeId: 'nod_b',
						toNodeName: 'worker',
						generation: 2,
						stage: 'completed',
						reason: null,
						message: null,
						startedAt: '2026-11-07T08:00:00.000Z',
						finishedAt: '2026-11-07T08:01:30.000Z',
					},
				],
			},
		});
		const result = await cli('db', 'replica', 'list', 'main');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('dbr_1');
		expect(result.stdout).toContain('streaming');
		expect(result.stdout).toContain('edge (same node)');
		expect(result.stdout).toContain('homelab → worker  generation 2  completed');
	});

	test('add posts the node and the storage target (--volume is an alias of --disk)', async () => {
		const seen = serve({ 'POST /api/v1/databases/main/replicas': { replica: replica({ status: 'pending' }) } });
		const result = await cli('db', 'replica', 'add', 'main', '--node', 'worker', '--disk', 'fast');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({ method: 'POST', body: { node: 'worker', storage: 'fast' } });
		await cli('db', 'replica', 'add', 'main', '--node', 'worker', '--volume', 'nvme');
		expect(seen[1]).toMatchObject({ body: { node: 'worker', storage: 'nvme' } });
		expect(result.stdout).toContain('Added replica dbr_1 of "main" on worker');
	});

	test('add without --node is a usage error before any request', async () => {
		const seen = serve({});
		const result = await cli('db', 'replica', 'add', 'main');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--node');
		expect(seen).toHaveLength(0);
	});

	test('promote needs a confirmation and sends If-Match with the generation it saw', async () => {
		const routes = {
			'GET /api/v1/databases/main/replicas': { primaryGeneration: 2, replicas: [replica()], failovers: [] },
			'POST /api/v1/databases/main/replicas/dbr_1/promote': {
				failover: { id: 'dfo_2', generation: 3, stage: 'fencing', toNodeId: 'nod_b' },
			},
		};
		let seen = serve(routes);
		const refused = await cli('db', 'replica', 'promote', 'main', 'dbr_1');
		expect(refused.code).not.toBe(0);
		expect(seen.some((call) => call.method === 'POST')).toBe(false);
		server?.stop(true);
		seen = serve(routes);
		const result = await cli('db', 'replica', 'promote', 'main', 'dbr_1', '--yes', '--accept-data-loss');
		expect(result.code).toBe(0);
		const post = seen.find((call) => call.method === 'POST')!;
		expect(post.body).toEqual({ confirm: true, acceptDataLoss: true });
		expect(post.ifMatch).toBe('2');
		expect(result.stdout).toContain('generation 3');
	});

	test('remove asks first and calls DELETE', async () => {
		const seen = serve({ 'DELETE /api/v1/databases/main/replicas/dbr_1': { replica: replica({ removing: true }) } });
		const result = await cli('db', 'replica', 'remove', 'main', 'dbr_1', '--yes');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/databases/main/replicas/dbr_1' });
	});

	test('lag label', () => {
		expect(lagLabel({ lagBytes: null, lagSeconds: null })).toBe('—');
		expect(lagLabel({ lagBytes: 2048, lagSeconds: 1.25 })).toContain('1.3 s');
	});
});
