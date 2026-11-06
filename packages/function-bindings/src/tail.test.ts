import { describe, expect, test } from 'bun:test';
import tailWorker from './tail.js';

/**
 * Tests for the tail-worker service module. Like the Analytics wrapper it is plain JavaScript that
 * runs inside workerd, so it is exercised against a fake `SINK` service binding: no sockets, no
 * agent.
 */

interface Captured {
	url: string;
	init: { method?: string; headers?: Record<string, string>; body?: string };
	body: {
		workloadId: string;
		projectId: string;
		events: Array<Record<string, unknown>>;
	};
	bytes: number;
}

interface Env {
	WORKLOAD_ID?: string;
	PROJECT_ID?: string;
	SINK?: { fetch: (url: string, init: Record<string, unknown>) => unknown };
}

function makeEnv(sink?: Env['SINK']): { env: Env; calls: Captured[] } {
	const calls: Captured[] = [];
	const binding = sink ?? {
		fetch: (url: string, init: Record<string, unknown>) => {
			const body = String(init.body);
			calls.push({
				url,
				init: init as Captured['init'],
				body: JSON.parse(body) as Captured['body'],
				bytes: new TextEncoder().encode(body).byteLength,
			});
			return Promise.resolve(new Response(null, { status: 202 }));
		},
	};
	return {
		env: { WORKLOAD_ID: 'wl_1', PROJECT_ID: 'prj_1', SINK: binding },
		calls,
	};
}

function tailItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		scriptName: 'my-worker',
		outcome: 'ok',
		logs: [{ level: 'log', message: ['hello', { a: 1 }] }],
		exceptions: [{ name: 'Error', message: 'boom' }],
		event: {
			request: {
				method: 'GET',
				url: 'https://example.com/page?q=1',
				headers: { cookie: 'sid=secret', authorization: 'Bearer token' },
				body: '{"password":"hunter2"}',
			},
			response: { status: 200, headers: { 'set-cookie': 'sid=secret' } },
		},
		...overrides,
	};
}

function waits(): { ctx: { waitUntil: (promise: Promise<unknown>) => void }; pending: Promise<unknown>[] } {
	const pending: Promise<unknown>[] = [];
	return { ctx: { waitUntil: (promise) => pending.push(promise) }, pending };
}

function bodyBytes(call: Captured): number {
	return call.bytes;
}

describe('tail worker module', () => {
	test('exports a default object with an async tail handler', () => {
		expect(typeof tailWorker.tail).toBe('function');
	});

	test('POSTs the workload, project and one mapped item to the sink', async () => {
		const { env, calls } = makeEnv();
		const { ctx, pending } = waits();
		await tailWorker.tail([tailItem()], env, ctx);
		expect(pending).toHaveLength(1);
		await Promise.all(pending);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call!.url).toBe('http://analytics/tail');
		expect(call!.init.method).toBe('POST');
		expect(call!.init.headers).toEqual({ 'content-type': 'application/json' });
		expect(call!.body.workloadId).toBe('wl_1');
		expect(call!.body.projectId).toBe('prj_1');
		expect(call!.body.events).toEqual([
			{
				scriptName: 'my-worker',
				outcome: 'ok',
				logs: [{ level: 'log', message: 'hello {"a":1}' }],
				exceptions: [{ name: 'Error', message: 'boom' }],
				request: { method: 'GET', url: 'https://example.com/page?q=1', status: 200 },
			},
		]);
	});

	test('never forwards request headers, cookies, bodies or response headers', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail([tailItem()], env, {});
		const [item] = calls[0]!.body.events;
		const request = item!.request as Record<string, unknown>;
		// Exactly three fields, nothing else: the raw TailItem's headers/body are unreachable.
		expect(Object.keys(request).sort()).toEqual(['method', 'status', 'url']);
		const wire = JSON.stringify(calls[0]!.body);
		for (const secret of ['sid=secret', 'Bearer token', 'hunter2', 'set-cookie', 'cookie', 'authorization']) {
			expect(wire).not.toContain(secret);
		}
	});

	test('strips URL userinfo, which is a credential rather than an address', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail(
			[tailItem({ event: { request: { method: 'GET', url: 'https://user:pass@example.com/x' } } })],
			env,
			{},
		);
		expect(calls[0]!.body.events[0]!.request).toEqual({
			method: 'GET',
			url: 'https://example.com/x',
		});
	});

	test('maps a missing request or response to null/absent fields', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail(
			[
				tailItem({ event: {} }),
				tailItem({ event: { request: { method: 'POST', url: 'https://example.com/y' } } }),
			],
			env,
			{},
		);
		expect(calls[0]!.body.events[0]!.request).toBeNull();
		expect(calls[0]!.body.events[1]!.request).toEqual({
			method: 'POST',
			url: 'https://example.com/y',
		});
	});

	test('stringifies arbitrary log values: JSON for objects, String otherwise', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail(
			[
				tailItem({
					logs: [
						{ level: 'info', message: ['text', 42, true, null, { nested: [1, 2] }, ['x']] },
					],
				}),
			],
			env,
			{},
		);
		expect(calls[0]!.body.events[0]!.logs).toEqual([
			{ level: 'info', message: 'text 42 true null {"nested":[1,2]} ["x"]' },
		]);
	});

	test('survives values JSON cannot serialise', async () => {
		const { env, calls } = makeEnv();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await tailWorker.tail([tailItem({ logs: [{ level: 'warn', message: [circular] }] })], env, {});
		expect(calls[0]!.body.events[0]!.logs).toEqual([{ level: 'warn', message: '[object Object]' }]);
	});

	test('caps logs at 80 and each message at 4 KiB', async () => {
		const { env, calls } = makeEnv();
		const logs = Array.from({ length: 100 }, (_, index) => ({
			level: 'log',
			// Only the first is oversized: 80 messages at the 4 KiB cap would not fit the body budget.
			message: index === 0 ? [`entry-${index}`, 'x'.repeat(5_000)] : [`entry-${index}`],
		}));
		await tailWorker.tail([tailItem({ logs })], env, {});
		const mapped = calls[0]!.body.events[0]!.logs as Array<{ level: string; message: string }>;
		expect(mapped).toHaveLength(80);
		expect(mapped[0]!.message.startsWith('entry-0 ')).toBe(true);
		expect(mapped[0]!.message).toHaveLength(4 * 1024);

		const longLevel = await (async () => {
			const second = makeEnv();
			await tailWorker.tail(
				[tailItem({ logs: [{ level: 'x'.repeat(30), message: ['y'] }] })],
				second.env,
				{},
			);
			return (second.calls[0]!.body.events[0]!.logs as Array<{ level: string }>)[0]!.level;
		})();
		expect(longLevel).toHaveLength(16);
	});

	test('caps exceptions at 20 and clips name and message', async () => {
		const { env, calls } = makeEnv();
		const exceptions = Array.from({ length: 25 }, (_, index) => ({
			name: `E${index}`.padEnd(300, 'n'),
			message: 'm'.repeat(5_000),
		}));
		await tailWorker.tail([tailItem({ exceptions })], env, {});
		const mapped = calls[0]!.body.events[0]!.exceptions as Array<{ name: string; message: string }>;
		expect(mapped).toHaveLength(20);
		expect(mapped[0]!.name).toHaveLength(200);
		expect(mapped[0]!.message).toHaveLength(4 * 1024);
	});

	test('defaults missing fields instead of throwing', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail([{}], env, {});
		expect(calls[0]!.body.events[0]).toEqual({
			scriptName: '',
			outcome: 'unknown',
			logs: [],
			exceptions: [],
			request: null,
		});
	});

	test('sends nothing for an empty event list', async () => {
		const { env, calls } = makeEnv();
		await tailWorker.tail([], env, {});
		expect(calls).toHaveLength(0);
	});

	test('swallows a rejecting sink and still resolves', async () => {
		const { env } = makeEnv({ fetch: () => Promise.reject(new Error('sink down')) });
		const { ctx, pending } = waits();
		await expect(tailWorker.tail([tailItem()], env, ctx)).resolves.toBeUndefined();
		await expect(Promise.all(pending)).resolves.toEqual([undefined]);
	});

	test('swallows a sink that throws synchronously', async () => {
		const { env } = makeEnv({
			fetch: () => {
				throw new Error('no such service');
			},
		});
		await expect(tailWorker.tail([tailItem()], env, {})).resolves.toBeUndefined();
	});

	test('is a no-op when the SINK binding is missing', async () => {
		await expect(
			tailWorker.tail([tailItem()], { WORKLOAD_ID: 'wl_1', PROJECT_ID: 'prj_1' }, {}),
		).resolves.toBeUndefined();
	});

	test('falls back to an awaited POST when ctx.waitUntil is unavailable', async () => {
		let delivered = false;
		const { env } = makeEnv({
			fetch: () => {
				delivered = true;
				return Promise.resolve(new Response(null, { status: 202 }));
			},
		});
		await tailWorker.tail([tailItem()], env);
		expect(delivered).toBe(true);
	});

	test('keeps the whole POST body under the sink 256 KiB cap', async () => {
		const { env, calls } = makeEnv();
		const events = Array.from({ length: 20 }, () =>
			tailItem({
				logs: Array.from({ length: 5 }, () => ({ level: 'log', message: ['z'.repeat(4 * 1024)] })),
			}),
		);
		await tailWorker.tail(events, env, {});
		expect(calls).toHaveLength(1);
		expect(bodyBytes(calls[0]!)).toBeLessThanOrEqual(256 * 1024);
		expect(calls[0]!.body.events.length).toBeGreaterThan(0);
		expect(calls[0]!.body.events.length).toBeLessThan(events.length);
	});

	test('drops a single event that cannot fit the body cap at all', async () => {
		const { env, calls } = makeEnv();
		const huge = tailItem({
			logs: Array.from({ length: 80 }, () => ({ level: 'log', message: ['q'.repeat(4 * 1024)] })),
		});
		await tailWorker.tail([huge], env, {});
		expect(calls).toHaveLength(0);
	});
});
