import { describe, expect, test } from 'bun:test';
import { CONTAINER_CONSOLE_TOKEN_HEADER, type ContainerConsoleActivation } from '@yoal/contracts';
import { ConsoleFront, ConsoleRefusal, controlPlaneConsoleActivationFetcher } from './console-front.ts';

const EXEC_ID = 'cx_abcdefghijklmnopqrstuvwx';

function activation(overrides: Partial<ContainerConsoleActivation> = {}): ContainerConsoleActivation {
	return {
		v: 1,
		workloadId: 'wld_app1',
		projectId: 'prj_1',
		userId: 'usr_alice',
		scopes: ['inspect', 'files', 'exec'],
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

function setup(tokens: Record<string, ContainerConsoleActivation>) {
	const calls: Array<{ path: string; method: string; body?: unknown; lastEventId?: string }> = [];
	let fetches = 0;
	const front = new ConsoleFront({
		fetchActivation: async (token) => {
			fetches += 1;
			const found = tokens[token];
			if (!found) throw new ConsoleRefusal(403, 'forbidden', 'The console token was refused.');
			return found;
		},
		helper: {
			async containerConsole(path, init = {}) {
				calls.push({ path, method: init.method ?? 'GET', body: init.body, lastEventId: init.lastEventId });
				if (path.endsWith('/exec') && init.method === 'POST')
					return Response.json({ ok: true, exec: { execId: EXEC_ID, shell: 'auto', user: 'default', startedAt: 'x' } });
				if (path.includes('/stream'))
					return new Response('event: data\ndata: aGk=\n\n', { headers: { 'content-type': 'text/event-stream' } });
				if (path.includes('/files/download'))
					return new Response('file-bytes', { headers: { 'content-type': 'application/octet-stream', 'content-length': '10', 'x-yoal-file-name': 'a.txt' } });
				return Response.json({ ok: true });
			},
		},
	});
	const call = (token: string | null, path: string, init: RequestInit = {}) =>
		front.handle(
			new Request(`http://n-x.console.internal${path}`, {
				...init,
				headers: { ...(token ? { [CONTAINER_CONSOLE_TOKEN_HEADER]: token } : {}), ...(init.headers as Record<string, string>) },
			}),
		);
	return { front, calls, call, fetches: () => fetches };
}

describe('ConsoleFront', () => {
	test('needs a token the control plane accepts', async () => {
		const { call } = setup({});
		expect((await call(null, '/v1/inspect')).status).toBe(401);
		expect((await call('wrong', '/v1/inspect')).status).toBe(403);
	});

	test('maps calls onto the token workload and caches the activation', async () => {
		const { call, calls, fetches } = setup({ good: activation() });
		expect((await call('good', '/v1/inspect')).status).toBe(200);
		expect((await call('good', '/v1/files?path=/etc/../app')).status).toBe(200);
		expect(calls.map((item) => item.path)).toEqual([
			'/v1/containers/wld_app1',
			'/v1/containers/wld_app1/files?path=%2Fetc%2F..%2Fapp',
		]);
		expect(fetches()).toBe(1);
	});

	test('passes downloads and streams through with their headers', async () => {
		const { call } = setup({ good: activation() });
		const download = await call('good', '/v1/files/download?path=/a.txt');
		expect(download.headers.get('content-length')).toBe('10');
		expect(download.headers.get('x-yoal-file-name')).toBe('a.txt');
		expect(await download.text()).toBe('file-bytes');
	});

	test('enforces the token scopes', async () => {
		const { call } = setup({ viewer: activation({ scopes: ['inspect'] }) });
		expect((await call('viewer', '/v1/inspect')).status).toBe(200);
		expect((await call('viewer', '/v1/files?path=/')).status).toBe(403);
		expect((await call('viewer', '/v1/exec', { method: 'POST', body: '{}' })).status).toBe(403);
	});

	test('binds a shell to the user who opened it', async () => {
		const { call, calls } = setup({
			alice: activation(),
			bob: activation({ userId: 'usr_bob' }),
			otherApp: activation({ workloadId: 'wld_app2' }),
		});
		const opened = await call('alice', '/v1/exec', { method: 'POST', body: '{"cols":80,"rows":24}' });
		expect(opened.status).toBe(200);
		expect((await call('bob', `/v1/exec/${EXEC_ID}/stream`)).status).toBe(404);
		expect((await call('otherApp', `/v1/exec/${EXEC_ID}/input`, { method: 'POST', body: 'x' })).status).toBe(404);

		const stream = await call('alice', `/v1/exec/${EXEC_ID}/stream`, { headers: { 'last-event-id': '42' } });
		expect(stream.headers.get('content-type')).toBe('text/event-stream');
		expect(await stream.text()).toContain('aGk=');
		expect(calls.at(-1)).toMatchObject({ path: `/v1/containers/wld_app1/exec/${EXEC_ID}/stream`, lastEventId: '42' });

		expect((await call('alice', `/v1/exec/${EXEC_ID}/input`, { method: 'POST', body: 'ls\r' })).status).toBe(200);
		expect((await call('alice', `/v1/exec/${EXEC_ID}`, { method: 'DELETE' })).status).toBe(200);
		// Forgotten after close.
		expect((await call('alice', `/v1/exec/${EXEC_ID}/input`, { method: 'POST', body: 'x' })).status).toBe(404);
	});

	test('refuses an expired activation and unknown paths', async () => {
		const { call } = setup({ old: activation({ expiresAt: new Date(Date.now() - 1).toISOString() }), good: activation() });
		expect((await call('old', '/v1/inspect')).status).toBe(401);
		expect((await call('good', '/v1/containers/wld_other')).status).toBe(404);
		expect((await call('good', '/v1/exec/not-an-id/stream')).status).toBe(400);
	});
});

describe('controlPlaneConsoleActivationFetcher', () => {
	test('sends the node bearer and the token, and validates the answer', async () => {
		let seen: Headers | null = null;
		const fetcher = controlPlaneConsoleActivationFetcher({
			controlUrl: 'https://cp',
			nodeToken: 'node-secret',
			fetch: (async (_url: string, init: RequestInit) => {
				seen = new Headers(init.headers);
				return Response.json(activation());
			}) as unknown as typeof fetch,
		});
		expect((await fetcher('tok')).workloadId).toBe('wld_app1');
		expect(seen!.get('authorization')).toBe('Bearer node-secret');
		expect(seen!.get(CONTAINER_CONSOLE_TOKEN_HEADER)).toBe('tok');
	});

	test('maps refusals', async () => {
		const fetcher = controlPlaneConsoleActivationFetcher({
			controlUrl: 'https://cp',
			nodeToken: 'n',
			fetch: (async () => Response.json({ message: 'expired' }, { status: 403 })) as unknown as typeof fetch,
		});
		await expect(fetcher('tok')).rejects.toBeInstanceOf(ConsoleRefusal);
	});
});
