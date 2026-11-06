import { describe, expect, test } from 'bun:test';
import { QueueBroker } from './queue.js';

const BASE = 'https://queue.internal';
const NOW = 1_700_000_000_000;
const LEASE_MS = 5 * 60_000;

/** Minimal Durable Object storage: one Map, prefix/limit list, sorted like workerd. */
class FakeStorage {
	map = new Map();
	alarm = null;

	async get(key) {
		return this.map.get(key);
	}

	async put(key, value) {
		this.map.set(key, value);
	}

	async delete(key) {
		if (Array.isArray(key)) {
			for (const item of key) this.map.delete(item);
			return;
		}
		this.map.delete(key);
	}

	async list(options = {}) {
		const prefix = options.prefix ?? '';
		const limit = options.limit ?? 1000;
		const keys = [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
		return new Map(keys.map((key) => [key, this.map.get(key)]));
	}

	async getAlarm() {
		return this.alarm;
	}

	async setAlarm(at) {
		this.alarm = at;
	}

	async deleteAlarm() {
		this.alarm = null;
	}
}

function makeBroker() {
	const storage = new FakeStorage();
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const responses: Array<Response> = [];
	const consumer = {
		async fetch(url, init) {
			calls.push({ url: String(url), init });
			const next = responses.shift();
			if (next instanceof Error) throw next;
			return next ?? new Response(null, { status: 204 });
		},
	};
	const env = { CONSUMER: consumer, QUEUE_NAME: 'jobs' };
	const object = new QueueBroker({ storage }, env);
	let now = NOW;
	object.now = () => now;
	return {
		object,
		storage,
		calls,
		responses,
		env,
		get now() {
			return now;
		},
		advance(milliseconds) {
			now += milliseconds;
		},
	};
}

function sendRequest(body = 'hello', headers = {}) {
	return new Request(`${BASE}/message`, { method: 'POST', headers, body });
}

function batchRequest(messages, headers = {}) {
	return new Request(`${BASE}/batch`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ messages }),
	});
}

function messageKeys(storage) {
	return [...storage.map.keys()].filter((key) => String(key).startsWith('msg:')).sort();
}

function deadKeys(storage) {
	return [...storage.map.keys()].filter((key) => String(key).startsWith('dead:')).sort();
}

function storedMessage(storage) {
	const [key] = messageKeys(storage);
	return { key, record: storage.map.get(key) };
}

function b64(value) {
	return btoa(value);
}

describe('QueueBroker producer protocol', () => {
	test('send stores a message, returns the producer metrics and arms the alarm', async () => {
		const harness = makeBroker();
		const response = await harness.object.fetch(
			sendRequest('hello', { 'X-Msg-Fmt': 'text' }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			metadata: {
				metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 },
			},
		});
		// Miniflare reports the backlog as it was when the call arrived, before this enqueue.
		expect(harness.calls).toHaveLength(0);

		const { key, record } = storedMessage(harness.storage);
		expect(record.id).toMatch(/^[0-9a-f]{32}$/);
		expect(key).toBe(`msg:${String(NOW).padStart(13, '0')}:${record.id}`);
		expect(record).toMatchObject({
			body: b64('hello'),
			contentType: 'text',
			attempts: 0,
			delaySeconds: 0,
			availableAt: NOW,
			bytes: 5,
		});
		expect(harness.storage.alarm).toBe(NOW);
	});

	test('send honours X-Msg-Delay-Secs and X-Msg-Fmt', async () => {
		const harness = makeBroker();
		await harness.object.fetch(
			sendRequest('[1,2]', { 'X-Msg-Fmt': 'json', 'X-Msg-Delay-Secs': '30' }),
		);

		const { record } = storedMessage(harness.storage);
		expect(record).toMatchObject({
			contentType: 'json',
			delaySeconds: 30,
			availableAt: NOW + 30_000,
			body: b64('[1,2]'),
		});
		expect(harness.storage.alarm).toBe(NOW + 30_000);
	});

	test('send defaults to the v8 content type when no format header is present', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('raw'));
		expect(storedMessage(harness.storage).record.contentType).toBe('v8');
	});

	test('sendBatch enqueues every message with per-message contentType and delay', async () => {
		const harness = makeBroker();
		const response = await harness.object.fetch(
			batchRequest([
				{ body: b64('{"n":1}'), contentType: 'json', delaySecs: 5 },
				{ body: b64('plain'), contentType: 'text' },
			]),
		);

		expect(response.status).toBe(200);
		const keys = messageKeys(harness.storage);
		expect(keys).toHaveLength(2);
		// Ordered by due time: the undelayed message is first.
		expect(harness.storage.map.get(keys[0])).toMatchObject({
			contentType: 'text',
			delaySeconds: 0,
			availableAt: NOW,
		});
		expect(harness.storage.map.get(keys[1])).toMatchObject({
			contentType: 'json',
			delaySeconds: 5,
			availableAt: NOW + 5_000,
		});
		expect(harness.storage.alarm).toBe(NOW);
	});

	test('sendBatch applies the batch header delay when a message has none', async () => {
		const harness = makeBroker();
		await harness.object.fetch(
			batchRequest([{ body: b64('a') }, { body: b64('b') }], { 'X-Msg-Delay-Secs': '7' }),
		);
		for (const record of harness.storage.map.values()) {
			if (!record || typeof record !== 'object' || !('availableAt' in record)) continue;
			expect(record.availableAt).toBe(NOW + 7_000);
		}
	});

	test('GET /metrics returns the flat object workerd parses', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('abc'));
		await harness.object.fetch(sendRequest('de'));

		const response = await harness.object.fetch(new Request(`${BASE}/metrics`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			backlogCount: 2,
			backlogBytes: 5,
			oldestMessageTimestamp: NOW,
		});
	});

	test('refuses unknown routes and methods', async () => {
		const harness = makeBroker();
		expect((await harness.object.fetch(new Request(`${BASE}/nope`))).status).toBe(404);
		expect(
			(await harness.object.fetch(new Request(`${BASE}/message`, { method: 'GET' }))).status,
		).toBe(404);
	});

	test('routes the default export to one Durable Object named "default"', async () => {
		const seen: Array<{ name: string; request: Request }> = [];
		const worker = (await import('./queue.js')).default;
		const env = {
			DO: {
				idFromName(name) {
					seen.push({ name, request: undefined as unknown as Request });
					return `id:${name}`;
				},
				get(id) {
					return {
						async fetch(request) {
							seen[seen.length - 1].request = request;
							return new Response(`stub:${id}`);
						},
					};
				},
			},
		};
		const response = await worker.fetch(sendRequest('x'), env);
		expect(await response.text()).toBe('stub:id:default');
		expect(seen[0].name).toBe('default');
	});
});

describe('QueueBroker consumer delivery', () => {
	test('the alarm POSTs one batch to the shim and acks it on 2xx', async () => {
		const harness = makeBroker();
		await harness.object.fetch(
			sendRequest('{"order":7}', { 'X-Msg-Fmt': 'json' }),
		);

		await harness.object.alarm();

		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0].url).toBe('http://main/__skiff/queue');
		const init = harness.calls[0].init;
		expect(init.method).toBe('POST');
		expect(new Headers(init.headers).get('x-skiff-internal')).toBe('1');
		expect(new Headers(init.headers).get('x-skiff-queue')).toBe('jobs');
		expect(new Headers(init.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(String(init.body))).toEqual([
			{
				id: expect.stringMatching(/^[0-9a-f]{32}$/),
				timestamp: NOW,
				attempts: 1,
				contentType: 'json',
				body: { order: 7 },
			},
		]);

		expect(messageKeys(harness.storage)).toHaveLength(0);
		expect(harness.storage.alarm).toBeNull();
		const metrics = await harness.object.metricsObject(harness.storage);
		expect(metrics).toEqual({ backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 });
	});

	test('delivers text bodies as strings and keeps bytes/v8 bodies base64', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('plain text', { 'X-Msg-Fmt': 'text' }));
		await harness.object.alarm();
		expect(JSON.parse(String(harness.calls[0].init.body))[0].body).toBe('plain text');

		const second = makeBroker();
		await second.object.fetch(sendRequest('blob'));
		await second.object.alarm();
		const message = JSON.parse(String(second.calls[0].init.body))[0];
		expect(message.contentType).toBe('v8');
		expect(message.body).toBe(b64('blob'));
	});

	test('does not deliver a delayed message before it is due, and reschedules it', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('later', { 'X-Msg-Delay-Secs': '60' }));

		await harness.object.alarm();
		expect(harness.calls).toHaveLength(0);
		expect(messageKeys(harness.storage)).toHaveLength(1);
		expect(harness.storage.alarm).toBe(NOW + 60_000);

		harness.advance(60_000);
		await harness.object.alarm();
		expect(harness.calls).toHaveLength(1);
		expect(messageKeys(harness.storage)).toHaveLength(0);
	});

	test('drains at most the configured batch size and keeps the rest', async () => {
		const harness = makeBroker();
		harness.object.batchSize = 2;
		await harness.object.fetch(
			batchRequest([{ body: b64('a') }, { body: b64('b') }, { body: b64('c') }]),
		);

		await harness.object.alarm();
		expect(JSON.parse(String(harness.calls[0].init.body))).toHaveLength(2);
		expect(messageKeys(harness.storage)).toHaveLength(1);
		expect(harness.storage.alarm).toBe(NOW);

		await harness.object.alarm();
		expect(JSON.parse(String(harness.calls[1].init.body))).toHaveLength(1);
		expect(messageKeys(harness.storage)).toHaveLength(0);
	});

	test('delivers a batch reserved by a crashed invocation once its lease expires', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('crashed'));
		const { key, record } = storedMessage(harness.storage);
		await harness.storage.put(key, {
			...record,
			inflight: true,
			inflightAt: NOW - LEASE_MS,
		});
		harness.storage.alarm = NOW;

		await harness.object.alarm();
		expect(harness.calls).toHaveLength(1);
		expect(messageKeys(harness.storage)).toHaveLength(0);
	});
});

describe('QueueBroker retries and dead letters', () => {
	test('a non-2xx redelivers with exponential backoff and never loses the message', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('flaky'));
		harness.responses.push(new Response('nope', { status: 500 }));

		await harness.object.alarm();
		expect(harness.calls).toHaveLength(1);
		expect(messageKeys(harness.storage)).toHaveLength(1);
		const { key, record } = storedMessage(harness.storage);
		expect(record).toMatchObject({ attempts: 1, inflight: false, availableAt: NOW + 1_000 });
		expect(key).toBe(`msg:${String(NOW + 1_000).padStart(13, '0')}:${record.id}`);
		expect(harness.storage.alarm).toBe(NOW + 1_000);
		expect((await harness.object.metricsObject(harness.storage)).backlogCount).toBe(1);

		harness.advance(1_000);
		await harness.object.alarm();
		expect(harness.calls).toHaveLength(2);
		expect(JSON.parse(String(harness.calls[1].init.body))[0].attempts).toBe(2);
		expect(messageKeys(harness.storage)).toHaveLength(0);
		expect(harness.storage.alarm).toBeNull();
	});

	test('a thrown consumer fetch is a failed delivery, not a lost message', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('boom'));
		harness.responses.push(new Error('connection refused'));

		await harness.object.alarm();
		expect(messageKeys(harness.storage)).toHaveLength(1);
		expect(storedMessage(harness.storage).record.attempts).toBe(1);
		expect(harness.storage.alarm).toBe(NOW + 1_000);
	});

	test('backs off 1s, 2s, 4s and 8s before the fifth failure dead-letters', async () => {
		const harness = makeBroker();
		await harness.object.fetch(sendRequest('doomed'));
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			harness.responses.push(new Response('fail', { status: 500 }));
			await harness.object.alarm();
			if (attempt < 5) {
				const expectedDelay = 2 ** (attempt - 1) * 1_000;
				expect(storedMessage(harness.storage).record.attempts).toBe(attempt);
				expect(harness.storage.alarm).toBe(harness.now + expectedDelay);
				harness.advance(expectedDelay);
			}
		}

		expect(messageKeys(harness.storage)).toHaveLength(0);
		const dead = deadKeys(harness.storage);
		expect(dead).toHaveLength(1);
		expect(harness.storage.map.get(dead[0])).toMatchObject({
			body: b64('doomed'),
			attempts: 5,
			queue: 'jobs',
		});
		expect(harness.storage.alarm).toBeNull();
		expect((await harness.object.metricsObject(harness.storage)).backlogCount).toBe(0);
	});

	test('keeps at most the dead-letter cap, dropping the oldest', async () => {
		const harness = makeBroker();
		harness.object.maxDeadLetters = 1;
		await harness.object.pushDeadLetter(
			{ id: 'first', body: b64('a'), contentType: 'v8', attempts: 5, timestamp: NOW },
			NOW,
		);
		await harness.object.pushDeadLetter(
			{ id: 'second', body: b64('b'), contentType: 'v8', attempts: 5, timestamp: NOW },
			NOW,
		);
		const dead = deadKeys(harness.storage);
		expect(dead).toHaveLength(1);
		expect(harness.storage.map.get(dead[0]).id).toBe('second');
	});
});

describe('QueueBroker bounds and validation', () => {
	test('refuses a message over 128 KiB with the producer error', async () => {
		const harness = makeBroker();
		const response = await harness.object.fetch(
			sendRequest('x'.repeat(128 * 1024 + 1)),
		);
		expect(response.status).toBe(413);
		expect(response.headers.get('cf-queues-error-cause')).toContain('exceeds limit of 131072');
		expect(await response.text()).toContain('exceeds limit');
		expect(messageKeys(harness.storage)).toHaveLength(0);
		expect(harness.storage.alarm).toBeNull();
	});

	test('accepts a body exactly at the 128 KiB limit', async () => {
		const harness = makeBroker();
		const response = await harness.object.fetch(sendRequest('x'.repeat(128 * 1024)));
		expect(response.status).toBe(200);
		expect(messageKeys(harness.storage)).toHaveLength(1);
	});

	test('refuses an oversized batch and an oversized batch message', async () => {
		const harness = makeBroker();
		const tooMany = await harness.object.fetch(
			batchRequest(Array.from({ length: 101 }, () => ({ body: b64('x') }))),
		);
		expect(tooMany.status).toBe(413);
		expect(messageKeys(harness.storage)).toHaveLength(0);

		const tooLarge = await harness.object.fetch(
			batchRequest([{ body: b64('y'.repeat(128 * 1024 + 1)) }]),
		);
		expect(tooLarge.status).toBe(413);
		expect(messageKeys(harness.storage)).toHaveLength(0);

		const tooHeavy = await harness.object.fetch(
			batchRequest(Array.from({ length: 100 }, () => ({ body: b64('z'.repeat(3000)) }))),
		);
		expect(tooHeavy.status).toBe(413);
		expect(await tooHeavy.text()).toContain('batch size of 300000 bytes');
		expect(messageKeys(harness.storage)).toHaveLength(0);
	});

	test('refuses a full queue and leaves the queued messages intact', async () => {
		const harness = makeBroker();
		harness.object.maxQueuedMessages = 2;
		await harness.object.fetch(sendRequest('one'));
		await harness.object.fetch(sendRequest('two'));

		const response = await harness.object.fetch(sendRequest('three'));
		expect(response.status).toBe(429);
		expect(response.headers.get('cf-queues-error-cause')).toContain('queue is full');
		expect(messageKeys(harness.storage)).toHaveLength(2);
		expect((await harness.object.metricsObject(harness.storage)).backlogCount).toBe(2);
	});

	test('recounts storage before refusing a queue whose counters drifted', async () => {
		const harness = makeBroker();
		harness.object.maxQueuedMessages = 2;
		// Simulate a crash that over-counted: the counters say "full", storage is empty.
		await harness.storage.put('meta', { count: 9, bytes: 900 });

		const response = await harness.object.fetch(sendRequest('fresh'));
		expect(response.status).toBe(200);
		expect(await harness.storage.get('meta')).toEqual({ count: 1, bytes: 5 });
	});

	test('rejects invalid content types and delays without storing anything', async () => {
		const harness = makeBroker();
		for (const headers of [
			{ 'X-Msg-Fmt': 'yaml' },
			{ 'X-Msg-Delay-Secs': '-1' },
			{ 'X-Msg-Delay-Secs': '1.5' },
			{ 'X-Msg-Delay-Secs': '86401' },
		]) {
			const response = await harness.object.fetch(sendRequest('x', headers));
			expect(response.status).toBe(400);
			expect(messageKeys(harness.storage)).toHaveLength(0);
		}
	});

	test('rejects malformed batch bodies', async () => {
		const harness = makeBroker();
		const notJson = await harness.object.fetch(
			new Request(`${BASE}/batch`, { method: 'POST', body: 'not json' }),
		);
		expect(notJson.status).toBe(400);

		const noMessages = await harness.object.fetch(
			new Request(`${BASE}/batch`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messages: 'nope' }),
			}),
		);
		expect(noMessages.status).toBe(400);

		const badBase64 = await harness.object.fetch(batchRequest([{ body: '***' }]));
		expect(badBase64.status).toBe(400);
		expect(messageKeys(harness.storage)).toHaveLength(0);
	});
});
