import { describe, expect, test } from 'bun:test';
import { CONTAINER_CONSOLE_TOKEN_HEADER, ForbiddenError, type Principal } from '@skiff/contracts';
import { handleContainerConsole, type ContainerConsoleDeps } from './container-console.js';

const principal = {
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	permissions: new Set()
} as unknown as Principal;
const EXEC_ID = 'cx_abcdefghijklmnopqrstuvwx';

function setup(
	options: { refuse?: boolean; upstream?: (url: string, init: RequestInit) => Response } = {}
) {
	const seen: Array<{ url: string; init: RequestInit }> = [];
	const records: unknown[] = [];
	const deps: ContainerConsoleDeps = {
		console: {
			enabled: () => true,
			endpoint: (_principal, _slug, scope) => {
				if (options.refuse) throw new ForbiddenError('container:exec');
				return {
					token: 'cc1.secret-token.sig',
					host: 'n-edge.console.internal',
					nodeId: 'node_edge',
					desiredId: 'wld_app',
					projectId: 'prj_1',
					scopes: [scope],
					expiresAt: Date.now() + 300_000
				};
			},
			targets: () => [
				{ replica: null, nodeId: 'node_edge', nodeName: 'edge', desiredId: 'wld_app' }
			],
			record: (_principal, _slug, activity) => records.push(activity),
			restart: () => ({ generation: 3 })
		},
		gatewayPort: () => 8082,
		fetch: (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return (
				options.upstream?.(url, init) ?? Response.json({ ok: true, container: { id: 'wld_app' } })
			);
		}) as unknown as typeof fetch
	};
	const call = (
		op: string,
		init: RequestInit = {},
		query = '',
		who: Principal | null = principal
	) => {
		const url = new URL(`http://control.test/projects/app/container/${op}${query}`);
		return handleContainerConsole(deps, {
			principal: who ?? undefined,
			slug: 'app',
			op,
			request: new Request(url, init),
			url
		});
	};
	return { call, seen, records };
}

describe('handleContainerConsole', () => {
	test('adds the token on the gateway hop only', async () => {
		const { call, seen } = setup();
		const response = await call('inspect');
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(text).not.toContain('secret-token');
		expect(seen[0]!.url).toBe('http://127.0.0.1:8082/v1/inspect');
		const headers = new Headers(seen[0]!.init.headers);
		expect(headers.get('host')).toBe('n-edge.console.internal');
		expect(headers.get(CONTAINER_CONSOLE_TOKEN_HEADER)).toBe('cc1.secret-token.sig');
		expect(JSON.parse(text).targets).toHaveLength(1);
	});

	test('refuses without a user or permission', async () => {
		const { call } = setup({ refuse: true });
		expect((await call('exec', { method: 'POST', body: '{}' })).status).toBe(403);
		expect((await setup().call('inspect', {}, '', null)).status).toBe(401);
	});

	test('validates paths and audits downloads with a safe file name', async () => {
		const { call, seen, records } = setup({
			upstream: () =>
				new Response('bytes', {
					headers: { 'content-length': '5', 'x-skiff-file-name': encodeURIComponent('a"b.txt') }
				})
		});
		expect((await call('files', {}, '?path=relative')).status).toBe(400);
		const download = await call('files/download', {}, '?path=/data/a.txt');
		expect(download.headers.get('content-disposition')).toContain('filename="a_b.txt"');
		expect(await download.text()).toBe('bytes');
		expect(seen.at(-1)!.url).toBe('http://127.0.0.1:8082/v1/files/download?path=%2Fdata%2Fa.txt');
		expect(records).toEqual([
			{ op: 'files.download', path: '/data/a.txt', sizeBytes: 5, replica: null }
		]);
	});

	test('opens, streams and types into a shell', async () => {
		const { call, seen, records } = setup({
			upstream: (url) => {
				if (url.endsWith('/v1/exec')) return Response.json({ ok: true, exec: { execId: EXEC_ID } });
				if (url.includes('/stream'))
					return new Response('event: data\ndata: aGk=\n\n', {
						headers: { 'content-type': 'text/event-stream' }
					});
				return Response.json({ ok: true });
			}
		});
		const opened = await call('exec', {
			method: 'POST',
			body: JSON.stringify({ shell: '/bin/sh', cols: 100, rows: 30 })
		});
		expect(((await opened.json()) as { exec: { execId: string } }).exec.execId).toBe(EXEC_ID);
		expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
			shell: '/bin/sh',
			user: 'default',
			cols: 100,
			rows: 30
		});
		expect(records[0]).toMatchObject({ op: 'exec.open', shell: '/bin/sh' });

		const stream = await call(`exec/${EXEC_ID}/stream`, { headers: { 'last-event-id': '42' } });
		expect(stream.headers.get('content-type')).toBe('text/event-stream');
		expect(seen.at(-1)!.url).toBe(`http://127.0.0.1:8082/v1/exec/${EXEC_ID}/stream?after=42`);

		expect((await call(`exec/${EXEC_ID}/input`, { method: 'POST', body: 'ls\r' })).status).toBe(
			200
		);
		expect(
			(await call('exec', { method: 'POST', body: JSON.stringify({ shell: '/usr/bin/python3' }) }))
				.status
		).toBe(400);
		expect((await call('exec/not-an-id/input', { method: 'POST', body: 'x' })).status).toBe(400);
	});

	test('restart is a POST through desired state', async () => {
		const { call, seen } = setup();
		expect((await call('restart')).status).toBe(405);
		const response = await call('restart', { method: 'POST' });
		expect(((await response.json()) as { generation: number }).generation).toBe(3);
		expect(seen).toHaveLength(0);
	});

	test('relays node errors with their message', async () => {
		const { call } = setup({
			upstream: () => Response.json({ error: 'The container is not running.' }, { status: 409 })
		});
		const response = await call('files', {}, '?path=/');
		expect(response.status).toBe(409);
		expect(((await response.json()) as { message: string }).message).toBe(
			'The container is not running.'
		);
	});
});
