import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	search: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-domains-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const domain = (overrides: Record<string, unknown> = {}) => ({
	id: 'dmn_1',
	projectId: 'prj_1',
	projectSlug: 'shop',
	hostname: 'shop.example.com',
	kind: 'custom',
	status: 'pending',
	verification: { recordName: '_skiff.shop.example.com', recordValue: 'skiff-verify=abc' },
	redirectWww: false,
	wwwHostname: null,
	lastCheckedAt: null,
	lastError: null,
	createdAt: '2026-11-01T10:00:00.000Z',
	verifiedAt: null,
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
				search: url.search,
				body: text ? JSON.parse(text) : undefined,
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
			SKIFF_CONFIG_DIR: dir,
			SKIFF_URL: `http://127.0.0.1:${server!.port}`,
			SKIFF_TOKEN: 'skif_test',
			SKIFF_CONTENT_DOMAIN: 'sites.example.com',
			SKIFF_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('skif domains', () => {
	test('list filters by project and prints status', async () => {
		const seen = serve({
			'GET /api/v1/domains': { domains: [domain(), domain({ id: 'dmn_2', hostname: 'example.com', kind: 'apex', status: 'active' })] },
		});
		const result = await cli('domains', 'list', '--project', 'shop');
		expect(result.code).toBe(0);
		expect(seen[0]?.search).toBe('?project=shop');
		expect(result.stdout).toContain('shop.example.com');
		expect(result.stdout).toContain('active');
	});

	test('add posts the hostname and prints the CNAME and TXT records', async () => {
		const seen = serve({ 'POST /api/v1/domains': domain() });
		const result = await cli('domains', 'add', 'shop.example.com', '--project', 'shop', '--redirect-www');
		expect(result.code).toBe(0);
		expect(seen[0]).toMatchObject({
			method: 'POST',
			body: { project: 'shop', hostname: 'shop.example.com', redirectWww: true },
		});
		expect(result.stdout).toContain('Added shop.example.com to shop (pending).');
		expect(result.stdout).toContain('CNAME  shop.example.com  →  shop.sites.example.com');
		expect(result.stdout).toContain('TXT    _skiff.shop.example.com  →  skiff-verify=abc');
	});

	test('add requires a project', async () => {
		const seen = serve({});
		const result = await cli('domains', 'add', 'shop.example.com');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--project');
		expect(seen).toHaveLength(0);
	});

	test('check resolves a hostname to its id and prints the DNS detail', async () => {
		const seen = serve({
			'GET /api/v1/domains': { domains: [domain()] },
			'POST /api/v1/domains/dmn_1/check': {
				domain: domain(),
				detail: 'Waiting for the CNAME record.',
				records: [{ type: 'CNAME', name: 'shop.example.com', value: 'shop.sites.example.com' }],
			},
		});
		const result = await cli('domains', 'check', 'shop.example.com');
		expect(result.code).toBe(0);
		expect(seen.some((call) => call.path === '/api/v1/domains/dmn_1/check' && call.method === 'POST')).toBe(true);
		expect(result.stdout).toContain('Waiting for the CNAME record.');
		expect(result.stdout).toContain('CNAME  shop.example.com  →  shop.sites.example.com');
	});

	test('remove asks first, then deletes with --yes', async () => {
		const routes = {
			'GET /api/v1/domains': { domains: [domain()] },
			'DELETE /api/v1/domains/dmn_1': { ok: true },
		};
		let seen = serve(routes);
		const refused = await cli('domains', 'remove', 'shop.example.com');
		expect(refused.code).not.toBe(0);
		expect(seen.some((call) => call.method === 'DELETE')).toBe(false);
		server?.stop(true);
		seen = serve(routes);
		const result = await cli('domains', 'remove', 'shop.example.com', '--yes');
		expect(result.code).toBe(0);
		expect(seen.some((call) => call.method === 'DELETE' && call.path === '/api/v1/domains/dmn_1')).toBe(true);
	});
});
