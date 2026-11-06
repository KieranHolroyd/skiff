import { afterEach, describe, expect, test } from 'bun:test';
import {
	STUDIO_SESSION_HEADER,
	STUDIO_TOKEN_HEADER,
	type DatabaseStudioActivation,
} from '@skiff/contracts';
import { decodeEvents, StudioError, type StudioEvent } from '@skiff/studio/protocol';
import { controlPlaneActivationFetcher, StudioFront, type StudioFrontOptions } from './front.ts';
import { runStudioProcess, type StudioProcess } from './process.ts';
import { tempSocket, testActivation, trackedFake } from './test-support.ts';

const SESSION = 'dss_AAAAAAAAAAAAAAAA';
const TOKEN = 'good-token';
const quiet = () => undefined;

const processes: StudioProcess[] = [];
const fronts: StudioFront[] = [];

afterEach(async () => {
	for (const front of fronts.splice(0)) front.stop();
	await Promise.all(processes.splice(0).map((proc) => proc.stop()));
});

async function startProcess(socketPath: string, fake = trackedFake()) {
	const proc = await runStudioProcess({ socketPath, loaders: fake.loaders, exit: quiet, log: quiet });
	processes.push(proc);
	return proc;
}

async function setup(options: { process?: boolean; front?: Partial<StudioFrontOptions> } = {}) {
	const socketPath = tempSocket();
	const fake = trackedFake();
	let proc = options.process === false ? null : await startProcess(socketPath, fake);
	const activations: Array<{ sessionId: string; token: string }> = [];
	let starts = 0;
	let clock = Date.now();
	const front = new StudioFront({
		socketPath,
		now: () => clock,
		async fetchActivation(sessionId, token) {
			activations.push({ sessionId, token });
			if (token !== TOKEN) throw new StudioError('unauthorized', 'The studio token is not valid.');
			return testActivation(sessionId);
		},
		helper: {
			async studioStart() {
				starts += 1;
			},
		},
		...options.front,
	});
	fronts.push(front);
	await front.update({ port: 0, sessions: [SESSION] });

	const call = (op: string, body: unknown, init: { token?: string | null; signal?: AbortSignal } = {}) => {
		const headers: Record<string, string> = { 'content-type': 'application/json', [STUDIO_SESSION_HEADER]: SESSION };
		const token = init.token === undefined ? TOKEN : init.token;
		if (token !== null) headers[STUDIO_TOKEN_HEADER] = token;
		return fetch(`http://127.0.0.1:${front.port}/v1/${op}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			...(init.signal ? { signal: init.signal } : {}),
		});
	};
	const restart = async () => {
		await proc?.stop();
		proc = await startProcess(socketPath, fake);
		return proc;
	};
	const healthz = async () =>
		(await (await fetch('http://studio/healthz', { unix: socketPath })).json()) as { bootId: string; sessions: number };
	return {
		front,
		fake,
		socketPath,
		call,
		restart,
		healthz,
		activations,
		starts: () => starts,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

async function collect(response: Response): Promise<StudioEvent[]> {
	const events: StudioEvent[] = [];
	if (!response.body) return events;
	for await (const event of decodeEvents(response.body)) events.push(event);
	return events;
}

describe('studio front', () => {
	test('requires the session and token headers', async () => {
		const { call } = await setup();
		const response = await call('tree', { path: [] }, { token: null });
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
		const unknownOp = await fetch(`http://127.0.0.1:${(await setup()).front.port}/v1/drop`, {
			method: 'POST',
			headers: { [STUDIO_SESSION_HEADER]: SESSION, [STUDIO_TOKEN_HEADER]: TOKEN },
		});
		expect(unknownOp.status).toBe(404);
	});

	test('fetches the activation once and caches it', async () => {
		const { call, activations } = await setup();
		expect((await call('tree', { path: [] })).status).toBe(200);
		expect((await call('info', {})).status).toBe(200);
		expect(activations).toEqual([{ sessionId: SESSION, token: TOKEN }]);
	});

	test('a wrong token re-fetches and is refused', async () => {
		const { call, activations } = await setup();
		expect((await call('tree', { path: [] })).status).toBe(200);
		const refused = await call('tree', { path: [] }, { token: 'stolen' });
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ error: { code: 'unauthorized' } });
		expect(activations.map((entry) => entry.token)).toEqual([TOKEN, 'stolen']);
		// The real session keeps working from the cache.
		expect((await call('tree', { path: [] })).status).toBe(200);
		expect(activations).toHaveLength(2);
	});

	test('streams results through without buffering', async () => {
		const { call } = await setup();
		const started = Date.now();
		const response = await call('run', { input: 'select count\nsleep 600' });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/x-ndjson');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(Date.now() - started).toBeLessThan(450);
		expect(new TextDecoder().decode(first.value)).toContain('"t":"columns"');
		let rest = '';
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			rest += new TextDecoder().decode(chunk.value);
		}
		expect(rest).toContain('"t":"done"');
		expect(Date.now() - started).toBeGreaterThanOrEqual(550);
	});

	test('aborting the client request cancels the statement', async () => {
		const { call, fake } = await setup();
		const controller = new AbortController();
		const response = await call('run', { input: 'select count\nsleep 10000' }, { signal: controller.signal });
		const reader = response.body!.getReader();
		await reader.read();
		const abortedAt = Date.now();
		controller.abort();
		await reader.read().catch(() => undefined);
		for (let i = 0; i < 50 && fake.aborts.length === 0; i += 1) await Bun.sleep(20);
		expect(fake.aborts).toHaveLength(1);
		expect((fake.aborts[0] ?? Infinity) - abortedAt).toBeLessThan(1_000);
	});

	test('starts the studio through the helper when it is not running', async () => {
		const socketPath = tempSocket();
		let starts = 0;
		const front = new StudioFront({
			socketPath,
			fetchActivation: async (sessionId) => testActivation(sessionId),
			helper: {
				async studioStart() {
					starts += 1;
					// systemd starts the unit; the socket answers a little later.
					setTimeout(() => void startProcess(socketPath), 120);
				},
			},
		});
		fronts.push(front);
		await front.update({ port: 0, sessions: [SESSION] });
		const response = await fetch(`http://127.0.0.1:${front.port}/v1/tree`, {
			method: 'POST',
			headers: { [STUDIO_SESSION_HEADER]: SESSION, [STUDIO_TOKEN_HEADER]: TOKEN },
			body: JSON.stringify({ path: [] }),
		});
		expect(response.status).toBe(200);
		expect(starts).toBe(1);
	});

	test('reports studio_unavailable when the studio never answers', async () => {
		const { call, starts } = await setup({ process: false, front: { startTimeoutMs: 200 } });
		const response = await call('tree', { path: [] });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: 'studio_unavailable' } });
		expect(starts()).toBe(1);
	});

	test('after a studio restart, idempotent calls retry and run reports studio_restarted', async () => {
		const { call, restart, healthz, activations } = await setup();
		expect((await call('tree', { path: [] })).status).toBe(200);

		await restart();
		expect((await healthz()).sessions).toBe(0);
		const retried = await call('tree', { path: ['public'] });
		expect(retried.status).toBe(200);
		expect(((await retried.json()) as { nodes: unknown[] }).nodes).toHaveLength(2);
		expect((await healthz()).sessions).toBe(1);

		await restart();
		const run = await call('run', { input: 'select count' });
		expect(run.status).toBe(503);
		expect(await run.json()).toMatchObject({ error: { code: 'studio_restarted' } });
		// "Run again" works: the front re-sent the activation.
		const again = await call('run', { input: 'select count' });
		expect(again.status).toBe(200);
		expect((await collect(again)).at(-1)).toMatchObject({ t: 'done' });
		expect(activations).toHaveLength(1);
	});

	test('dropping a session from desired state deletes it in the studio', async () => {
		const { front, call, healthz, advance } = await setup();
		expect((await call('tree', { path: [] })).status).toBe(200);
		expect((await healthz()).sessions).toBe(1);
		// A session fetched moments ago survives a desired state that does not list it yet.
		await front.update({ port: 0, sessions: [] });
		expect((await healthz()).sessions).toBe(1);
		advance(60_000);
		await front.update({ port: 0, sessions: [] });
		expect((await healthz()).sessions).toBe(0);
	});

	test('update(null) stops the listener', async () => {
		const { front } = await setup();
		const port = front.port;
		expect(port).not.toBeNull();
		await front.update(null);
		expect(front.port).toBeNull();
		await expect(fetch(`http://127.0.0.1:${port}/v1/info`, { method: 'POST' })).rejects.toThrow();
	});
});

describe('controlPlaneActivationFetcher', () => {
	const activation: DatabaseStudioActivation = testActivation(SESSION);

	test('sends the node bearer and session token, and parses the activation', async () => {
		let url = '';
		let headers = new Headers();
		const fetchActivation = controlPlaneActivationFetcher({
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			fetch: (async (input: string, init: RequestInit) => {
				url = input;
				headers = new Headers(init.headers);
				return Response.json(activation);
			}) as unknown as typeof fetch,
		});
		expect(await fetchActivation(SESSION, TOKEN)).toEqual(activation);
		expect(url).toBe(`https://control.test/api/agent/database-studio/${SESSION}`);
		expect(headers.get('authorization')).toBe('Bearer node-token');
		expect(headers.get(STUDIO_TOKEN_HEADER)).toBe(TOKEN);
	});

	test('maps refusals onto studio errors', async () => {
		const cases: Array<[number, string]> = [
			[401, 'unauthorized'],
			[403, 'forbidden'],
			[404, 'unknown_session'],
			[409, 'session_expired'],
			[410, 'session_expired'],
		];
		for (const [status, code] of cases) {
			const fetchActivation = controlPlaneActivationFetcher({
				controlUrl: 'https://control.test',
				nodeToken: 'node-token',
				fetch: (async () => new Response('{}', { status })) as unknown as typeof fetch,
			});
			const error = await fetchActivation(SESSION, TOKEN).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(StudioError);
			expect((error as StudioError).code).toBe(code as StudioError['code']);
		}
	});
});
