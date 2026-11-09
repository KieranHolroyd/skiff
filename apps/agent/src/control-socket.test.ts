import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlSocketFetch } from './control-socket.ts';

let dir: string;
let socket: string;
let server: ReturnType<typeof Bun.serve>;
const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'yoal-control-socket-'));
	socket = join(dir, 'control.sock');
	server = Bun.serve({
		unix: socket,
		async fetch(request) {
			seen.push({
				url: request.url,
				method: request.method,
				headers: Object.fromEntries(request.headers),
				body: await request.text(),
			});
			return Response.json({ via: 'socket' });
		},
	});
});

afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

/** Real fetch for socket requests; anything else stands in for the public network path. */
const network = ((input: Parameters<typeof fetch>[0], init?: RequestInit & { unix?: string }) =>
	init?.unix ? fetch(input, init) : Promise.resolve(Response.json({ via: 'network' }))) as unknown as typeof fetch;

describe('controlSocketFetch', () => {
	test('sends control-plane requests to the socket with the public host and protocol', async () => {
		const routed = controlSocketFetch(network, 'https://control.example.com', socket);
		const response = await routed('https://control.example.com/api/agent/heartbeat?x=1', {
			method: 'POST',
			headers: { authorization: 'Bearer node-token', 'content-type': 'application/json' },
			body: JSON.stringify({ ok: true }),
		});
		expect(await response.json()).toEqual({ via: 'socket' });
		const request = seen.at(-1)!;
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/api/agent/heartbeat');
		expect(new URL(request.url).search).toBe('?x=1');
		expect(request.headers.host).toBe('control.example.com');
		expect(request.headers['x-forwarded-proto']).toBe('https');
		expect(request.headers['x-forwarded-host']).toBe('control.example.com');
		expect(request.headers.authorization).toBe('Bearer node-token');
		expect(request.body).toBe('{"ok":true}');
	});

	test('accepts Request objects', async () => {
		const routed = controlSocketFetch(network, 'http://203.0.113.7', socket);
		const response = await routed(new Request('http://203.0.113.7/api/objects/abc?sig=1'));
		expect(await response.json()).toEqual({ via: 'socket' });
		expect(seen.at(-1)!.headers['x-forwarded-proto']).toBe('http');
	});

	test('leaves every other origin on the network', async () => {
		const routed = controlSocketFetch(network, 'https://control.example.com', socket);
		const response = await routed('https://github.com/yoal/releases');
		expect(await response.json()).toEqual({ via: 'network' });
		const otherPort = await routed('https://control.example.com:8443/api/agent/heartbeat');
		expect(await otherPort.json()).toEqual({ via: 'network' });
	});

	test('falls back to the network when the socket is missing', async () => {
		const routed = controlSocketFetch(network, 'https://control.example.com', join(dir, 'missing.sock'));
		const response = await routed('https://control.example.com/api/agent/desired-state');
		expect(await response.json()).toEqual({ via: 'network' });
	});
});
