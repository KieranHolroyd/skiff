import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-workload-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const project = (overrides: Record<string, unknown> = {}) => ({
	id: 'prj_1',
	slug: 'shop',
	name: 'Shop',
	runtime: 'process',
	productionDeploymentId: null,
	productionUrl: 'https://shop.example.com',
	previewPattern: 'https://shop--<id>.example.com',
	productionAccess: 'public',
	previewAccess: 'platform',
	createdAt: '2026-11-01T10:00:00.000Z',
	...overrides,
});

const spec = (overrides: Record<string, unknown> = {}) => ({
	runtime: 'process',
	command: ['bun', 'run', 'start'],
	port: 3000,
	memoryMb: 256,
	cpus: 1,
	healthPath: '/',
	socketActivation: true,
	env: { NODE_ENV: 'production' },
	secrets: [{ name: 'STRIPE_KEY', version: 2, delivery: 'env' }],
	ingress: 'http',
	replicas: 1,
	...overrides,
});

const workload = (overrides: Record<string, unknown> = {}) => ({
	id: 'wld_1',
	projectId: 'prj_1',
	nodeId: 'nod_a',
	status: 'running',
	deploymentId: 'dep_1',
	memoryMb: 256,
	cpus: 1,
	updatedAt: '2026-11-01T10:05:00.000Z',
	...overrides,
});

function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
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
			SKIFF_CONFIG_DIR: dir,
			SKIFF_URL: `http://127.0.0.1:${server!.port}`,
			SKIFF_TOKEN: 'skif_test',
			SKIFF_CONTENT_DOMAIN: '',
			SKIFF_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('skif workload', () => {
	test('show prints the saved spec and the running workload', async () => {
		serve({
			'GET /api/v1/projects/shop': project(),
			'GET /api/v1/projects/shop/workload': { spec: spec(), workload: workload() },
		});
		const result = await cli('workload', 'show', 'shop');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Runtime     process');
		expect(result.stdout).toContain('Command     bun run start');
		expect(result.stdout).toContain('Variables   1 plain · 1 secret');
		expect(result.stdout).toContain('Status      running');
	});

	test('set merges the spec, parses sizes and sends only the changed fields', async () => {
		const seen = serve({
			'GET /api/v1/projects/shop': project(),
			'GET /api/v1/projects/shop/workload': { spec: spec(), workload: workload() },
			'PUT /api/v1/projects/shop/workload': { workload: workload({ memoryMb: 512 }) },
		});
		const result = await cli(
			'workload',
			'set',
			'shop',
			'--engine',
			'node',
			'--port',
			'8080',
			'--memory',
			'512M',
			'--cpus',
			'0.5',
			'--health-path',
			'/health',
			'--idle-stop',
			'300',
			'--env',
			'LOG_LEVEL=debug',
			'--secret',
			'NEW_KEY=3:file',
		);
		expect(result.code).toBe(0);
		const put = seen.find((call) => call.method === 'PUT')!;
		expect(put.body).toMatchObject({
			runtime: 'process',
			engine: 'node',
			port: 8080,
			memoryMb: 512,
			cpus: 0.5,
			healthPath: '/health',
			idleStopSeconds: 300,
			env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
			secrets: [
				{ name: 'STRIPE_KEY', version: 2, delivery: 'env' },
				{ name: 'NEW_KEY', version: 3, delivery: 'file' },
			],
			command: ['bun', 'run', 'start'],
		});
		expect(result.stdout).toContain('Saved runtime for shop.');
	});

	test('set accepts --no-socket-activation and --data none', async () => {
		const seen = serve({
			'GET /api/v1/projects/shop': project(),
			'GET /api/v1/projects/shop/workload': { spec: spec({ data: { sizeMb: 256 } }), workload: null },
			'PUT /api/v1/projects/shop/workload': { workload: null },
		});
		const result = await cli('workload', 'set', 'shop', '--no-socket-activation', '--data', 'none');
		expect(result.code).toBe(0);
		const put = seen.find((call) => call.method === 'PUT')!;
		expect((put.body as Record<string, unknown>).socketActivation).toBe(false);
		expect((put.body as Record<string, unknown>).data).toBeUndefined();
	});

	test('a static project is refused before any write', async () => {
		const seen = serve({ 'GET /api/v1/projects/site': project({ slug: 'site', runtime: 'static' }) });
		const result = await cli('workload', 'set', 'site', '--port', '8080');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('static');
		expect(seen.some((call) => call.method === 'PUT')).toBe(false);
	});

	test('reset asks first and deletes the spec with --yes', async () => {
		let seen = serve({ 'DELETE /api/v1/projects/shop/workload': { ok: true } });
		const refused = await cli('workload', 'reset', 'shop');
		expect(refused.code).not.toBe(0);
		expect(seen).toHaveLength(0);
		server?.stop(true);
		seen = serve({ 'DELETE /api/v1/projects/shop/workload': { ok: true } });
		const result = await cli('workload', 'reset', 'shop', '--yes');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/projects/shop/workload' });
	});

	test('capacity prints the slice reservation', async () => {
		serve({
			'GET /api/v1/nodes/capacity': {
				capacity: [
					{
						nodeId: 'nod_a',
						name: 'edge',
						mode: 'shared',
						status: 'online',
						sliceMemoryMb: 2048,
						reservedMemoryMb: 512,
						freeMemoryMb: 1536,
						workloadCount: 3,
					},
				],
			},
		});
		const result = await cli('workload', 'capacity');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('edge');
		expect(result.stdout).toContain('512/2,048 MB');
	});
});
