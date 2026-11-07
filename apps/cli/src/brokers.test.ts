import { describe, expect, test } from 'bun:test';
import {
	brokerMetricsSummary,
	brokerMetricsTable,
	brokerQueuesTable,
	formatAge,
	type BrokerMetricPoint,
	type BrokerQueuesView,
} from './brokers.ts';

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
