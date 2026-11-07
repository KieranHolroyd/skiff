import { describe, expect, test } from 'bun:test';
import {
	brokerMetricsSummary,
	brokerMetricsTable,
	brokerQueuesTable,
	checkMessageBody,
	formatAge,
	formatPeekedBody,
	formatSeqs,
	parseCount,
	parseDelaySeconds,
	peekReport,
	peekedHeaderLines,
	queueOfStream,
	queueStreamName,
	resolveStream,
	sendSummary,
	trimFinalNewline,
	type BrokerMetricPoint,
	type BrokerQueuesView,
} from './brokers.ts';
import type { PeekedMessage } from './node-tasks.ts';

function point(bucket: string, overrides: Partial<BrokerMetricPoint> = {}): BrokerMetricPoint {
	return {
		bucket,
		up: 1,
		connections: 3,
		streams: 2,
		consumers: 2,
		storeBytes: 512 * 1024 * 1024,
		storeLimitBytes: 2048 * 1024 * 1024,
		memoryStoreBytes: 0,
		messages: 40,
		pending: 30,
		ackPending: 5,
		redelivered: 1,
		oldestAgeSeconds: 125,
		published: 10,
		messagesIn: 12,
		messagesOut: 11,
		bytesIn: 100,
		bytesOut: 200,
		slowConsumers: 0,
		memoryBytes: 64 * 1024 * 1024,
		...overrides,
	};
}

describe('formatAge', () => {
	test('compact units', () => {
		expect(formatAge(0)).toBe('0s');
		expect(formatAge(45)).toBe('45s');
		expect(formatAge(125)).toBe('2m');
		expect(formatAge(3_900)).toBe('1h 5m');
		expect(formatAge(2 * 86_400 + 4 * 3_600)).toBe('2d 4h');
	});
});

describe('brokerMetricsSummary', () => {
	test('latest sample plus range totals', () => {
		const text = brokerMetricsSummary(
			[
				point('2026-11-07T10:01:00.000Z', { up: 0, pending: 50, ackPending: 10, published: 4 }),
				point('2026-11-07T10:00:00.000Z', { published: 6 }),
			],
			2048,
		);
		expect(text).toContain('Latest        2026-11-07 10:01:00Z (down)');
		expect(text).toContain('512 MiB of 2.0 GiB (25%)');
		expect(text).toContain('50 pending, 10 awaiting ack, 1 redelivered');
		expect(text).toContain('Oldest        2m');
		expect(text).toContain('10 stored, 24 in, 22 out');
		expect(text).toContain('Peak backlog  60');
		expect(text).toContain('Uptime        50.0%');
		expect(text).not.toContain('slow consumers');
	});

	test('empty input renders nothing', () => {
		expect(brokerMetricsSummary([], 2048)).toBe('');
	});
});

describe('brokerMetricsTable', () => {
	test('one row per sample, oldest first', () => {
		const lines = brokerMetricsTable([point('2026-11-07T10:01:00.000Z', { oldestAgeSeconds: 0 }), point('2026-11-07T10:00:00.000Z')]).split('\n');
		expect(lines[0]).toContain('PENDING');
		expect(lines[2]).toContain('10:00:00');
		expect(lines[2]).toContain('2m');
		expect(lines[3]).toContain('10:01:00');
	});
});

describe('brokerQueuesTable', () => {
	test('queues by name, app streams by retention, consumers indented', () => {
		const view: BrokerQueuesView = {
			brokerId: 'mq_1',
			name: 'jobs',
			at: '2026-11-07T10:05:00.000Z',
			truncated: false,
			streams: [
				{
					stream: 'SKIFF_Q_jobs',
					queue: 'jobs',
					subjects: ['skiff.q.jobs'],
					storage: 'file',
					retention: 'workqueue',
					messages: 25,
					bytes: 1_200,
					maxBytes: null,
					firstAt: '2026-11-07T10:00:00.000Z',
					lastAt: '2026-11-07T10:04:00.000Z',
					consumerCount: 1,
					pending: 25,
					ackPending: 0,
					redelivered: 0,
					consumers: [
						{ name: 'skiff-consumer', pending: 25, ackPending: 0, redelivered: 0, waiting: 1, lastDeliveredAt: null },
					],
				},
				{
					stream: 'EVENTS',
					queue: null,
					subjects: ['events.>'],
					storage: 'file',
					retention: 'limits',
					messages: 0,
					bytes: 0,
					maxBytes: null,
					firstAt: null,
					lastAt: null,
					consumerCount: 0,
					pending: 0,
					ackPending: 0,
					redelivered: 0,
					consumers: [],
				},
			],
		};
		const lines = brokerQueuesTable(view).split('\n');
		expect(lines[0]).toContain('REDELIVERED');
		expect(lines[2]).toMatch(/^jobs\s+queue\s+25\s/);
		expect(lines[2]).toContain('5m');
		expect(lines[3]).toContain('└ skiff-consumer');
		expect(lines[4]).toMatch(/^EVENTS\s+limits\s+0\s/);
	});
});

describe('queue tools (D124)', () => {
	const message = (overrides: Partial<PeekedMessage> = {}): PeekedMessage => ({
		seq: 7,
		subject: 'skiff.q.jobs',
		time: '2026-11-07T10:00:00.000Z',
		size: 13,
		headers: { 'Skiff-Content-Type': 'json', 'Skiff-Attempts': '2', 'Nats-Msg-Id': 'nt_1', 'X-Trace': 'abc' },
		encoding: 'utf8',
		body: '{"hello":"world"}',
		truncated: false,
		...overrides,
	});

	test('a queue maps to SKIFF_Q_<queue>; --stream is taken as is', () => {
		expect(queueStreamName('jobs')).toBe('SKIFF_Q_jobs');
		expect(queueOfStream('SKIFF_Q_jobs')).toBe('jobs');
		expect(queueOfStream('EVENTS')).toBeNull();
		expect(resolveStream('jobs', undefined)).toEqual({ stream: 'SKIFF_Q_jobs', label: 'queue jobs (SKIFF_Q_jobs)' });
		expect(resolveStream(undefined, 'EVENTS')).toEqual({ stream: 'EVENTS', label: 'stream EVENTS' });
	});

	test('resolveStream refuses both, neither, bad queue names and bad stream names', () => {
		expect(() => resolveStream('jobs', 'EVENTS')).toThrow('not both');
		expect(() => resolveStream(undefined, undefined)).toThrow('Name a queue');
		expect(() => resolveStream('Jobs', undefined)).toThrow('--stream');
		expect(() => resolveStream(undefined, 'a.b')).toThrow('dots');
		expect(() => resolveStream(undefined, 'a b')).toThrow('spaces');
	});

	test('formatSeqs folds runs', () => {
		expect(formatSeqs([17])).toBe('17');
		expect(formatSeqs([20, 19, 18, 17])).toBe('17–20');
		expect(formatSeqs([3, 5, 6, 7, 9, 10])).toBe('3, 5–7, 9, 10');
		expect(formatSeqs([])).toBe('');
	});

	test('parseDelaySeconds takes seconds or s/m/h, at most 12h', () => {
		expect(parseDelaySeconds('30')).toBe(30);
		expect(parseDelaySeconds('30s')).toBe(30);
		expect(parseDelaySeconds('5m')).toBe(300);
		expect(parseDelaySeconds('12h')).toBe(43_200);
		expect(() => parseDelaySeconds('13h')).toThrow('at most 12h');
		expect(() => parseDelaySeconds('soon')).toThrow('--delay');
	});

	test('parseCount checks the range', () => {
		expect(parseCount('5', '--count', 1, 100)).toBe(5);
		expect(() => parseCount('0', '--count', 1, 100)).toThrow('--count must be a whole number from 1 to 100.');
		expect(() => parseCount('2.5', '--count', 1, 100)).toThrow('--count');
		expect(() => parseCount('101', '--count', 1, 100)).toThrow('--count');
	});

	test('checkMessageBody wants JSON unless the body is text', () => {
		expect(() => checkMessageBody('{"a":1}', 'json')).not.toThrow();
		expect(() => checkMessageBody('"hi"', 'json')).not.toThrow();
		expect(() => checkMessageBody('hello', 'json')).toThrow('--text');
		expect(() => checkMessageBody('hello', 'text')).not.toThrow();
		expect(trimFinalNewline('hi\n')).toBe('hi');
		expect(trimFinalNewline('hi\n\n')).toBe('hi\n');
		expect(trimFinalNewline('hi\r\n')).toBe('hi');
	});

	test('sendSummary names the queue, sequences, time and delay', () => {
		const text = sendSummary(
			{ stream: 'SKIFF_Q_jobs', sent: 3, seqs: [4, 5, 6], durationMs: 3.4, state: { stream: 'SKIFF_Q_jobs', messages: 6, bytes: 2048, firstAt: null, lastAt: null } },
			30,
		);
		expect(text).toBe('Sent 3 messages to queue jobs (seq 4–6) in 3 ms.\nConsumers see them after 30s.\nSKIFF_Q_jobs now holds 6 messages (2.0 KiB).');
		expect(sendSummary({ stream: 'EVENTS', sent: 1, seqs: [9], durationMs: 1200, state: null })).toBe(
			'Sent 1 message to stream EVENTS (seq 9) in 1.20 s.',
		);
	});

	test('bodies: JSON pretty-printed, text and cut bodies as they are, binary noted', () => {
		expect(formatPeekedBody(message())).toBe('{\n  "hello": "world"\n}');
		expect(formatPeekedBody(message({ headers: { 'Skiff-Content-Type': 'text' }, body: '{"a":1}' }))).toBe('{"a":1}');
		expect(formatPeekedBody(message({ body: '{"hel', truncated: true, size: 40_000 }))).toBe('{"hel\n… (cut; 39 KiB in all)');
		expect(formatPeekedBody(message({ encoding: 'base64', body: 'AAEC', size: 3 }))).toBe('<binary, 3 B, base64> AAEC');
		expect(formatPeekedBody(message({ body: '' }))).toBe('<empty>');
	});

	test('peekedHeaderLines puts Skiff headers on one line and lists the rest', () => {
		expect(peekedHeaderLines(message())).toEqual(['json · attempts 2 · id nt_1', 'X-Trace: abc']);
		expect(peekedHeaderLines(message({ headers: {} }))).toEqual([]);
	});

	test('peekReport lists messages and the next page', () => {
		const text = peekReport(
			{ stream: 'SKIFF_Q_jobs', messages: [message()], total: 30, firstSeq: 7, lastSeq: 36, nextSeq: 8 },
			(seq) => `skif broker peek mq jobs --from ${seq}`,
		);
		const lines = text.split('\n');
		expect(lines[0]).toBe('jobs (SKIFF_Q_jobs): 30 messages held, seq 7–36. Showing 1.');
		expect(lines[2]).toBe('#7  2026-11-07 10:00:00Z  13 B');
		expect(lines[3]).toBe('    json · attempts 2 · id nt_1');
		expect(lines[5]).toBe('    {');
		expect(text).toContain('    "hello": "world"');
		expect(lines.at(-1)).toBe('More: skif broker peek mq jobs --from 8');
		expect(peekReport({ stream: 'EVENTS', messages: [], total: 0, firstSeq: 0, lastSeq: 0, nextSeq: null })).toBe('EVENTS is empty.');
	});

	test('peekReport shows the subject for app streams', () => {
		const text = peekReport({ stream: 'EVENTS', messages: [message({ subject: 'events.created', headers: {} })], total: 1, firstSeq: 7, lastSeq: 7, nextSeq: null });
		expect(text).toContain('EVENTS: 1 message held, seq 7. Showing 1.');
		expect(text).toContain('#7  2026-11-07 10:00:00Z  13 B  events.created');
		expect(text).not.toContain('More:');
	});
});
