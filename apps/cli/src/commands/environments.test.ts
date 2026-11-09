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
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-environments-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const environment = (overrides: Record<string, unknown> = {}) => ({
	id: 'env_1',
	projectId: 'prj_1',
	projectSlug: 'shop',
	name: 'Staging',
	slug: 'staging',
	isProduction: false,
	access: 'platform',
	accessPolicyId: null,
	passwordSet: false,
	host: 'staging--shop.sites.example.com',
	deploymentId: 'dep_1',
	createdAt: '2026-11-01T10:00:00.000Z',
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

describe('skif environments', () => {
	test('list prints name, slug, host and deployment', async () => {
		serve({
			'GET /api/v1/projects/shop/environments': {
				environments: [environment(), environment({ id: 'env_0', name: 'Production', slug: 'production', isProduction: true })],
			},
		});
		const result = await cli('environments', 'list', 'shop');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Staging');
		expect(result.stdout).toContain('production');
		expect(result.stdout).toContain('dep_1');
	});

	test('create posts the name and access details', async () => {
		const seen = serve({ 'POST /api/v1/projects/shop/environments': environment() });
		const result = await cli(
			'environments',
			'create',
			'shop',
			'Staging',
			'--access',
			'password',
			'--password',
			'correct horse',
		);
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({
			method: 'POST',
			path: '/api/v1/projects/shop/environments',
			body: { name: 'Staging', access: 'password', password: 'correct horse' },
		});
		expect(result.stdout).toContain('Created environment "Staging" in shop.');
	});

	test('update patches only the flags given', async () => {
		const seen = serve({
			'PATCH /api/v1/projects/shop/environments/staging': environment({ name: 'Preview' }),
		});
		const result = await cli('environments', 'update', 'shop', 'staging', '--name', 'Preview', '--policy', 'none');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({
			method: 'PATCH',
			body: { name: 'Preview', policyId: null },
		});
	});

	test('update without changes is a usage error', async () => {
		const seen = serve({});
		const result = await cli('environments', 'update', 'shop', 'staging');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Nothing to change');
		expect(seen).toHaveLength(0);
	});

	test('promote points the environment at a deployment', async () => {
		const seen = serve({
			'POST /api/v1/projects/shop/environments/staging/promote': {
				id: 'dep_2',
				shortId: 'abc123',
				status: 'active',
				projectSlug: 'shop',
			},
		});
		const result = await cli('environments', 'promote', 'shop', 'staging', 'dep_2');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({ method: 'POST', body: { deploymentId: 'dep_2' } });
		expect(result.stdout).toContain('abc123');
	});

	test('remove asks first, then deletes with --yes', async () => {
		const routes = { 'DELETE /api/v1/projects/shop/environments/staging': { ok: true } };
		let seen = serve(routes);
		const refused = await cli('environments', 'remove', 'shop', 'staging');
		expect(refused.code).not.toBe(0);
		expect(seen).toHaveLength(0);
		server?.stop(true);
		seen = serve(routes);
		const result = await cli('environments', 'remove', 'shop', 'staging', '--yes');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({ method: 'DELETE' });
	});

	test('an unknown access mode is refused before any request', async () => {
		const seen = serve({});
		const result = await cli('environments', 'create', 'shop', 'Staging', '--access', 'secret');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--access must be one of');
		expect(seen).toHaveLength(0);
	});
});
