import { afterEach, describe, expect, test } from 'bun:test';
import type { AnalyticsEvent, FunctionTailEvent } from '@yoal/contracts';
import {
	ANALYTICS_SINK_MAX_BODY_BYTES,
	TAIL_SINK_MAX_BODY_BYTES,
	handleAnalyticsRequest,
	handleTailRequest,
	parseAnalyticsEvent,
	parseTailBatch,
	startAnalyticsSink,
	type AnalyticsSink,
} from './analytics-sink.ts';

const URL_BASE = 'http://127.0.0.1:8085';

function post(body: unknown, init: RequestInit = {}): Request {
	return new Request(`${URL_BASE}/event`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
	});
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dataset: 'web_events',
		projectId: 'prj_0123456789',
		workloadId: 'wl_1',
		blobs: ['/pricing', 'GET'],
		doubles: [200, 12.5],
		indexes: ['prj_0123456789'],
		...overrides,
	};
}

function recorder(): { events: AnalyticsEvent[]; record: (value: AnalyticsEvent) => void } {
	const events: AnalyticsEvent[] = [];
	return { events, record: (value) => events.push(value) };
}

describe('handleAnalyticsRequest', () => {
	test('accepts a valid event and records it with a node timestamp', async () => {
		const { events, record } = recorder();
		const before = Date.now();
		const response = await handleAnalyticsRequest(post(event()), record);
		const after = Date.now();

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ ok: true });
		expect(events).toHaveLength(1);
		const [recorded] = events;
		expect(recorded).toMatchObject({
			dataset: 'web_events',
			projectId: 'prj_0123456789',
			workloadId: 'wl_1',
			blobs: ['/pricing', 'GET'],
			doubles: [200, 12.5],
			indexes: ['prj_0123456789'],
		});
		expect(recorded!.ts).toBeGreaterThanOrEqual(before);
		expect(recorded!.ts).toBeLessThanOrEqual(after);
	});

	test('defaults absent arrays to empty lists', async () => {
		const { events, record } = recorder();
		const response = await handleAnalyticsRequest(
			post({ dataset: 'ds', projectId: 'prj_1', workloadId: 'wl_1' }),
			record,
		);
		expect(response.status).toBe(202);
		expect(events[0]).toMatchObject({ blobs: [], doubles: [], indexes: [] });
	});

	test('ignores other paths', async () => {
		const { events, record } = recorder();
		const response = await handleAnalyticsRequest(
			new Request(`${URL_BASE}/other`, { method: 'POST', body: JSON.stringify(event()) }),
			record,
		);
		expect(response.status).toBe(404);
		expect(events).toHaveLength(0);
	});

	test('answers 405 with an Allow header for a non-POST', async () => {
		const { events, record } = recorder();
		const response = await handleAnalyticsRequest(new Request(`${URL_BASE}/event`), record);
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
		expect(events).toHaveLength(0);
	});

	test('rejects malformed JSON', async () => {
		const { record } = recorder();
		const response = await handleAnalyticsRequest(post('{not json'), record);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_json' });
	});

	test('rejects an event missing dataset, project or workload', async () => {
		const { events, record } = recorder();
		for (const bad of [
			event({ dataset: undefined }),
			event({ projectId: undefined }),
			event({ workloadId: undefined }),
			event({ dataset: '' }),
			event({ projectId: 'x'.repeat(101) }),
		]) {
			const response = await handleAnalyticsRequest(post(bad), record);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'invalid_event' });
		}
		expect(events).toHaveLength(0);
	});

	test('rejects arrays that are too long or the wrong shape', async () => {
		const { record } = recorder();
		const cases = [
			event({ blobs: Array.from({ length: 21 }, () => 'x') }),
			event({ blobs: ['x'.repeat(16_385)] }),
			event({ blobs: [1] }),
			event({ doubles: [Number.NaN] }),
			event({ doubles: [Number.POSITIVE_INFINITY] }),
			event({ doubles: ['1'] }),
			event({ doubles: Array.from({ length: 21 }, () => 1) }),
			event({ indexes: ['x'.repeat(1_025)] }),
			event({ indexes: Array.from({ length: 21 }, () => 'x') }),
			event({ indexes: [{}] }),
			event({ blobs: 'not-an-array' }),
		];
		for (const bad of cases) {
			const response = await handleAnalyticsRequest(post(bad), record);
			expect(response.status).toBe(400);
		}
	});

	test('rejects a body over the cap by declared length and by actual bytes', async () => {
		const { record } = recorder();
		const declared = await handleAnalyticsRequest(
			post('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
			record,
		);
		expect(declared.status).toBe(413);
		expect(await declared.json()).toEqual({ error: 'body_too_large' });

		const huge = 'x'.repeat(ANALYTICS_SINK_MAX_BODY_BYTES + 1);
		const actual = await handleAnalyticsRequest(post(huge), record);
		expect(actual.status).toBe(413);
	});

	test('still answers 202 when the recorder throws', async () => {
		const response = await handleAnalyticsRequest(post(event()), () => {
			throw new Error('buffer broken');
		});
		expect(response.status).toBe(202);
	});
});

describe('parseAnalyticsEvent', () => {
	test('accepts exactly the caps and rejects one past them', () => {
		expect(
			parseAnalyticsEvent(
				{
					dataset: 'd'.repeat(100),
					projectId: 'p'.repeat(100),
					workloadId: 'w'.repeat(100),
					blobs: Array.from({ length: 20 }, () => 'b'.repeat(16_384)),
					doubles: Array.from({ length: 20 }, () => 1),
					indexes: Array.from({ length: 20 }, () => 'i'.repeat(1_024)),
				},
				1,
			),
		).not.toBeNull();
		expect(
			parseAnalyticsEvent({ dataset: 'x'.repeat(101), projectId: 'p', workloadId: 'w' }, 1),
		).toBeNull();
	});

	test('rejects non-objects', () => {
		for (const value of [null, 'event', 42, [], [event()]]) {
			expect(parseAnalyticsEvent(value, 1)).toBeNull();
		}
	});
});

// --- Tail-worker sink --------------------------------------------------------------------------

function tailPost(body: unknown, init: RequestInit = {}): Request {
	return new Request(`${URL_BASE}/tail`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
	});
}

function tailItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		scriptName: 'my-worker',
		outcome: 'ok',
		logs: [{ level: 'log', message: 'hello' }],
		exceptions: [{ name: 'Error', message: 'boom' }],
		request: { method: 'GET', url: 'https://example.com/page', status: 200 },
		...overrides,
	};
}

function tailBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { workloadId: 'wl_1', projectId: 'prj_0123456789', events: [tailItem()], ...overrides };
}

function tailRecorder(): { events: FunctionTailEvent[]; recordTail: (value: FunctionTailEvent) => void } {
	const events: FunctionTailEvent[] = [];
	return { events, recordTail: (value) => events.push(value) };
}

describe('handleTailRequest', () => {
	test('accepts a batch, stamps the node time and records every event', async () => {
		const { events, recordTail } = tailRecorder();
		const before = Date.now();
		const response = await handleTailRequest(
			tailPost(tailBatch({ events: [tailItem(), tailItem({ scriptName: 'second' })] })),
			recordTail,
		);
		const after = Date.now();

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ ok: true });
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			projectId: 'prj_0123456789',
			workloadId: 'wl_1',
			scriptName: 'my-worker',
			outcome: 'ok',
			logs: [{ level: 'log', message: 'hello' }],
			exceptions: [{ name: 'Error', message: 'boom' }],
			request: { method: 'GET', url: 'https://example.com/page', status: 200 },
		});
		expect(events[0]!.ts).toBeGreaterThanOrEqual(before);
		expect(events[0]!.ts).toBeLessThanOrEqual(after);
		expect(events[1]!.scriptName).toBe('second');
	});

	test('defaults missing script name, outcome, log and exception lists', async () => {
		const { events, recordTail } = tailRecorder();
		const response = await handleTailRequest(
			tailPost({ workloadId: 'wl_1', projectId: 'prj_1', events: [{}] }),
			recordTail,
		);
		expect(response.status).toBe(202);
		expect(events[0]).toMatchObject({
			scriptName: '',
			outcome: 'unknown',
			logs: [],
			exceptions: [],
			request: null,
		});
	});

	test('clips logs to the contract 50, messages to 4 KiB and exceptions to 20', async () => {
		const { events, recordTail } = tailRecorder();
		const logs = Array.from({ length: 60 }, (_, index) => ({
			level: 'log',
			// One oversized message proves the clip without making the whole body exceed 256 KiB.
			message: index === 0 ? 'x'.repeat(5_000) : `entry-${index}`,
		}));
		const exceptions = Array.from({ length: 25 }, () => ({ name: 'E'.repeat(300), message: 'm'.repeat(5_000) }));
		const response = await handleTailRequest(
			tailPost(tailBatch({ events: [tailItem({ logs, exceptions })] })),
			recordTail,
		);
		expect(response.status).toBe(202);
		expect(events[0]!.logs).toHaveLength(50);
		expect(events[0]!.logs[0]!.message).toHaveLength(4_096);
		expect(events[0]!.exceptions).toHaveLength(20);
		expect(events[0]!.exceptions[0]!.name).toHaveLength(200);
		expect(events[0]!.exceptions[0]!.message).toHaveLength(4_096);
	});

	test('keeps only method, URL and status from a request', async () => {
		const { events, recordTail } = tailRecorder();
		await handleTailRequest(
			tailPost(
				tailBatch({
					events: [
						tailItem({
							request: {
								method: 'POST',
								url: 'https://example.com/x',
								status: 201,
								headers: { cookie: 'sid=secret' },
								body: '{"password":"hunter2"}',
							},
						}),
					],
				}),
			),
			recordTail,
		);
		expect(events[0]!.request).toEqual({ method: 'POST', url: 'https://example.com/x', status: 201 });
		expect(JSON.stringify(events[0])).not.toContain('hunter2');
	});

	test('ignores an invalid response status rather than failing the event', async () => {
		const { events, recordTail } = tailRecorder();
		await handleTailRequest(
			tailPost(tailBatch({ events: [tailItem({ request: { method: 'GET', url: 'https://x.test', status: '200' } })] })),
			recordTail,
		);
		expect(events[0]!.request).toEqual({ method: 'GET', url: 'https://x.test' });
	});

	test('answers 405 with an Allow header for a non-POST', async () => {
		const { events, recordTail } = tailRecorder();
		const response = await handleTailRequest(new Request(`${URL_BASE}/tail`), recordTail);
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
		expect(events).toHaveLength(0);
	});

	test('rejects malformed JSON and structurally invalid batches', async () => {
		const { recordTail } = tailRecorder();
		expect((await handleTailRequest(tailPost('{not json'), recordTail)).status).toBe(400);

		const bad: unknown[] = [
			null,
			42,
			[],
			tailBatch({ workloadId: undefined }),
			tailBatch({ projectId: '' }),
			tailBatch({ workloadId: 'x'.repeat(101) }),
			tailBatch({ events: 'not-an-array' }),
			tailBatch({ events: [null] }),
			tailBatch({ events: [tailItem({ logs: 'nope' })] }),
			tailBatch({ events: [tailItem({ logs: [{ level: 'log', message: 42 }] })] }),
			tailBatch({ events: [tailItem({ exceptions: [{}] })] }),
			tailBatch({ events: [tailItem({ request: 'GET' })] }),
			tailBatch({ events: [tailItem({ request: { method: 1, url: 'https://x.test' } })] }),
		];
		for (const body of bad) {
			const response = await handleTailRequest(tailPost(body), recordTail);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'invalid_event' });
		}
	});

	test('rejects a body over the cap by declared length and by actual bytes', async () => {
		const { recordTail } = tailRecorder();
		const declared = await handleTailRequest(
			tailPost('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
			recordTail,
		);
		expect(declared.status).toBe(413);
		expect(await declared.json()).toEqual({ error: 'body_too_large' });

		const huge = 'x'.repeat(TAIL_SINK_MAX_BODY_BYTES + 1);
		expect((await handleTailRequest(tailPost(huge), recordTail)).status).toBe(413);
	});

	test('still answers 202 and keeps recording when the recorder throws', async () => {
		const seen: string[] = [];
		let calls = 0;
		const response = await handleTailRequest(
			tailPost(tailBatch({ events: [tailItem({ scriptName: 'first' }), tailItem({ scriptName: 'second' })] })),
			(value) => {
				calls += 1;
				if (calls === 1) throw new Error('buffer broken');
				seen.push(value.scriptName);
			},
		);
		expect(response.status).toBe(202);
		expect(seen).toEqual(['second']);
	});

	test('is 404 through the shared handler when no tail recorder is configured', async () => {
		const { events, record } = recorder();
		const response = await handleAnalyticsRequest(tailPost(tailBatch()), record);
		expect(response.status).toBe(404);
		expect(events).toHaveLength(0);
	});

	test('routes `/tail` through the shared handler when a tail recorder is configured', async () => {
		const { events, record } = recorder();
		const { events: tails, recordTail } = tailRecorder();
		const response = await handleAnalyticsRequest(tailPost(tailBatch()), record, recordTail);
		expect(response.status).toBe(202);
		expect(events).toHaveLength(0);
		expect(tails).toHaveLength(1);
	});
});

describe('parseTailBatch', () => {
	test('accepts every event field at its cap and stamps ts, project and workload', () => {
		const batch = parseTailBatch(
			{
				workloadId: 'w'.repeat(100),
				projectId: 'p'.repeat(100),
				events: [
					{
						scriptName: 's'.repeat(200),
						outcome: 'o'.repeat(64),
						logs: Array.from({ length: 50 }, () => ({ level: 'l'.repeat(16), message: 'm'.repeat(4_096) })),
						exceptions: Array.from({ length: 20 }, () => ({ name: 'n'.repeat(200), message: 'e'.repeat(4_096) })),
						request: { method: 'M'.repeat(16), url: 'u'.repeat(2_048), status: 0 },
					},
				],
			},
			7,
		);
		expect(batch).not.toBeNull();
		expect(batch!.workloadId).toBe('w'.repeat(100));
		expect(batch!.projectId).toBe('p'.repeat(100));
		expect(batch!.events[0]!.ts).toBe(7);
		expect(batch!.events[0]!.projectId).toBe('p'.repeat(100));
		expect(batch!.events[0]!.workloadId).toBe('w'.repeat(100));
	});

	test('rejects non-objects and an event list that is not an array', () => {
		for (const value of [null, 'batch', 42, [], [{ events: [] }]]) {
			expect(parseTailBatch(value, 1)).toBeNull();
		}
		expect(parseTailBatch({ workloadId: 'w', projectId: 'p', events: 'no' }, 1)).toBeNull();
	});

	test('returns an empty event list for a valid empty batch', () => {
		expect(parseTailBatch({ workloadId: 'w', projectId: 'p', events: [] }, 1)).toEqual({
			workloadId: 'w',
			projectId: 'p',
			events: [],
		});
	});
});

describe('startAnalyticsSink', () => {
	let sink: AnalyticsSink | null = null;
	afterEach(() => {
		sink?.stop();
		sink = null;
	});

	test('serves the handler on a loopback port and stops cleanly', async () => {
		const { events, record } = recorder();
		const logs: string[] = [];
		sink = startAnalyticsSink({
			port: 0,
			record,
			log: (level, message) => logs.push(`${level}: ${message}`),
		});
		expect(sink.port).toBeGreaterThan(0);
		expect(sink.url).toBe(`http://127.0.0.1:${sink.port}`);
		expect(logs[0]).toContain('Analytics Engine sink listening on 127.0.0.1');

		const response = await fetch(`${sink.url}/event`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(event()),
		});
		expect(response.status).toBe(202);
		expect(events).toHaveLength(1);

		const url = sink.url;
		sink.stop();
		sink = null;
		await expect(fetch(`${url}/event`, { method: 'POST' })).rejects.toThrow();
	});

	test('serves `/tail` beside `/event` on the same loopback port', async () => {
		const { events, record } = recorder();
		const { events: tails, recordTail } = tailRecorder();
		sink = startAnalyticsSink({ port: 0, record, recordTail });

		const response = await fetch(`${sink.url}/tail`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(tailBatch()),
		});
		expect(response.status).toBe(202);
		expect(tails).toHaveLength(1);
		expect(events).toHaveLength(0);
	});
});
