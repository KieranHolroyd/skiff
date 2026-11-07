import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	NatsConnection,
	QUEUE_HEADERS,
	ackInfo,
	ackMessage,
	decodeHeaders,
	encodeHeaders,
	ensureQueueConsumer,
	jsApi,
	nakMessage,
	pullQueue,
	queueBacklog,
	queueStreamName,
	queueSubject,
} from './nats.js';
import { QueueProducer, messageHeaders } from './queue.js';

/**
 * Queues on the managed broker (D112). Protocol units always run; the broker tests need a NATS
 * server with JetStream at SKIFF_TEST_NATS (`host:port`, user `tester`, password
 * `tester-password-123`), for example:
 *
 *   docker run --rm -p 127.0.0.1:14999:4222 nats:2.12-alpine -js --user tester --pass tester-password-123
 *   SKIFF_TEST_NATS=127.0.0.1:14999 bun test
 */
const target = process.env.SKIFF_TEST_NATS ?? '';
const [testHost, testPort] = target.split(':');
const USER = 'tester';
const PASS = 'tester-password-123';

/** A Bun TCP socket as the Web-stream pair nats.js reads and writes. */
async function tcp(host: string, port: number) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
	const socket = await Bun.connect({
		hostname: host,
		port,
		socket: {
			data: (_s, data) => controller.enqueue(new Uint8Array(data)),
			close: () => {
				try {
					controller.close();
				} catch {}
			},
		},
	});
	const writable = new WritableStream<Uint8Array>({
		write: (chunk) => void socket.write(chunk),
		close: () => void socket.end(),
	});
	return { readable, writable, close: () => socket.end() };
}

const connect = async () => NatsConnection.connect(await tcp(testHost!, Number(testPort)), { user: USER, pass: PASS });
/** Unique queue per test run so leftovers never interfere. */
const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}`;

describe('NATS protocol pieces', () => {
	test('headers round-trip and refuse injection', () => {
		const bytes = encodeHeaders({ 'Nats-Msg-Id': 'abc', 'Skiff-Content-Type': 'json' });
		expect(new TextDecoder().decode(bytes)).toBe('NATS/1.0\r\nNats-Msg-Id: abc\r\nSkiff-Content-Type: json\r\n\r\n');
		const parsed = decodeHeaders(bytes);
		expect(parsed.get('nats-msg-id')).toBe('abc');
		expect(decodeHeaders(new TextEncoder().encode('NATS/1.0 404 No Messages\r\n\r\n'))).toMatchObject({
			status: 404,
			description: 'No Messages',
		});
		expect(() => encodeHeaders({ Bad: 'a\r\nInjected: 1' })).toThrow(/line break/);
		expect(() => encodeHeaders({ 'Bad Name': 'x' })).toThrow(/not valid/);
	});

	test('ack subjects of both forms parse', () => {
		expect(ackInfo('$JS.ACK.SKIFF_Q_jobs.skiff-consumer.3.17.20.1700000000123456789.4')).toMatchObject({
			stream: 'SKIFF_Q_jobs',
			delivered: 3,
			streamSequence: 17,
			timestampMs: 1_700_000_000_123,
		});
		expect(ackInfo('$JS.ACK.hub.ACCHASH.SKIFF_Q_jobs.skiff-consumer.2.5.6.1700000000999000000.0.abc')).toMatchObject({
			stream: 'SKIFF_Q_jobs',
			delivered: 2,
			streamSequence: 5,
		});
		expect(ackInfo('_INBOX.x')).toBeNull();
	});

	test('queue names map to safe streams and subjects', () => {
		expect(queueStreamName('email-jobs')).toBe('SKIFF_Q_email-jobs');
		expect(queueSubject('email-jobs')).toBe('skiff.q.email-jobs');
		expect(() => queueSubject('a.b')).toThrow(/not valid/);
		expect(() => queueSubject('>')).toThrow(/not valid/);
	});

	test('delayed messages carry a not-before header', () => {
		const headers = messageHeaders({ contentType: 'json', delaySeconds: 30 }, 1_000);
		expect(headers[QUEUE_HEADERS.notBefore]).toBe('31000');
		expect(headers[QUEUE_HEADERS.id]).toMatch(/^[0-9a-f]{32}$/);
		expect(messageHeaders({ contentType: 'text', delaySeconds: 0 }, 1_000)[QUEUE_HEADERS.notBefore]).toBeUndefined();
	});

	test('the producer refuses bad input before touching the broker', async () => {
		let connected = false;
		const producer = new QueueProducer(
			{ QUEUE_NAME: 'jobs', BROKER: { connect() {} }, BROKER_USER: 'u', BROKER_PASSWORD: 'p' },
			{
				connect: async () => {
					connected = true;
					throw new Error('unused');
				},
			},
		);
		const big = await producer.fetch(new Request('https://q/message', { method: 'POST', body: new Uint8Array(200_000) }));
		expect(big.status).toBe(413);
		const delay = await producer.fetch(
			new Request('https://q/message', { method: 'POST', body: 'x', headers: { 'X-Msg-Delay-Secs': '-1' } }),
		);
		expect(delay.status).toBe(400);
		const format = await producer.fetch(
			new Request('https://q/message', { method: 'POST', body: 'x', headers: { 'X-Msg-Fmt': 'yaml' } }),
		);
		expect(format.status).toBe(400);
		expect(connected).toBe(false);
		const missing = new QueueProducer({ QUEUE_NAME: 'jobs', BROKER: { connect() {} } });
		const refused = await missing.fetch(new Request('https://q/message', { method: 'POST', body: 'x' }));
		expect(refused.status).toBe(500);
		expect(await refused.text()).toContain('credentials are missing');
	});

	test('a broker that cannot be reached is a 503, not a crash', async () => {
		const producer = new QueueProducer(
			{ QUEUE_NAME: 'jobs', BROKER: { connect() {} }, BROKER_USER: 'u', BROKER_PASSWORD: 'p' },
			{ connect: async () => Promise.reject(new Error('connection refused')) },
		);
		const response = await producer.fetch(new Request('https://q/message', { method: 'POST', body: 'x' }));
		expect(response.status).toBe(503);
		expect(response.headers.get('cf-queues-error-cause')).toContain('connection refused');
	});
});

describe.skipIf(!target)('queues on a real broker', () => {
	let connection: NatsConnection;
	beforeAll(async () => {
		connection = await connect();
	});
	afterAll(async () => {
		await connection?.close();
	});

	test('a wrong password fails the connect', async () => {
		await expect(NatsConnection.connect(await tcp(testHost!, Number(testPort)), { user: USER, pass: 'wrong' })).rejects.toThrow(
			/Authorization|refused/i,
		);
	});

	test('the producer stores sends and batches, and metrics report the backlog', async () => {
		const queue = unique('jobs');
		const producer = new QueueProducer(
			{ QUEUE_NAME: queue, BROKER: { connect() {} }, BROKER_USER: USER, BROKER_PASSWORD: PASS },
			{ connect: () => connect(), now: () => 1_700_000_000_000 },
		);
		const sent = await producer.fetch(
			new Request('https://q/message', { method: 'POST', body: '{"n":1}', headers: { 'X-Msg-Fmt': 'json' } }),
		);
		expect(sent.status).toBe(200);
		expect(((await sent.json()) as { metadata: { metrics: { backlogCount: number } } }).metadata.metrics.backlogCount).toBe(1);

		const batch = await producer.fetch(
			new Request('https://q/batch', {
				method: 'POST',
				body: JSON.stringify({
					messages: [
						{ body: btoa('two'), contentType: 'text' },
						{ body: btoa('three'), contentType: 'text', delaySecs: 60 },
					],
				}),
			}),
		);
		expect(batch.status).toBe(200);
		const metrics = (await (await producer.fetch(new Request('https://q/metrics'))).json()) as {
			backlogCount: number;
			oldestMessageTimestamp: number;
		};
		expect(metrics.backlogCount).toBe(3);
		expect(metrics.oldestMessageTimestamp).toBeGreaterThan(0);
		expect((await jsApi(connection, `STREAM.INFO.${queueStreamName(queue)}`)).config.retention).toBe('workqueue');
	});

	test('a pull consumer gets batches with delivery counts; ack removes, nak redelivers', async () => {
		const queue = unique('work');
		await ensureQueueConsumer(connection, queue, 30_000);
		const producer = new QueueProducer(
			{ QUEUE_NAME: queue, BROKER: { connect() {} }, BROKER_USER: USER, BROKER_PASSWORD: PASS },
			{ connect: () => connect() },
		);
		for (const n of [1, 2, 3])
			await producer.fetch(new Request('https://q/message', { method: 'POST', body: String(n), headers: { 'X-Msg-Fmt': 'text' } }));

		const first = await pullQueue(connection, queue, { batch: 2, expiresMs: 1_000 });
		expect(first.map((m) => new TextDecoder().decode(m.data))).toEqual(['1', '2']);
		expect(first[0]!.info?.delivered).toBe(1);
		expect(first[0]!.headers?.get(QUEUE_HEADERS.contentType)).toBe('text');
		await ackMessage(connection, first[0]);
		await nakMessage(connection, first[1]);

		// The partial batch arrives when the pull expires: the nak'd message and the third.
		const second = await pullQueue(connection, queue, { batch: 10, expiresMs: 1_000 });
		const bodies = second.map((m) => new TextDecoder().decode(m.data)).sort();
		expect(bodies).toEqual(['2', '3']);
		expect(second.find((m) => new TextDecoder().decode(m.data) === '2')!.info?.delivered).toBe(2);
		for (const message of second) await ackMessage(connection, message);

		expect(await pullQueue(connection, queue, { batch: 10, expiresMs: 300 })).toEqual([]);
		expect((await queueBacklog(connection, queue)).backlogCount).toBe(0);
	});
});
