import { describe, expect, it } from 'bun:test';
import type { EventRuleView } from '@skiff/contracts';
import { eventSourcesFor, parseQueueKey } from './event-sources.js';

const rule = (id: string, broker: string, queue: string): EventRuleView => ({
	id,
	source: 'alerts',
	events: ['firing'],
	filter: {},
	broker,
	queue,
	description: null,
	enabled: true,
	createdAt: '2026-11-07T00:00:00.000Z',
	updatedAt: '2026-11-07T00:00:00.000Z',
	deliveries: { pending: 0, delivered: 0, failed: 0 },
	lastDeliveredAt: null,
	lastError: null
});

describe('eventSourcesFor', () => {
	const rules = [
		rule('mine', 'jobs', 'images'),
		rule('pending', 'jobs', 'thumbs'),
		rule('theirs', 'jobs', 'emails'),
		rule('elsewhere', 'other', 'images')
	];

	it('keeps rules on consumed queues and unclaimed queues on attached brokers', () => {
		const sources = eventSourcesFor(rules, {
			consumers: [{ broker: 'jobs', queue: 'images' }],
			attachedBrokers: ['jobs'],
			consumedElsewhere: new Set(['jobs/emails'])
		});
		expect(sources.map((item) => [item.id, item.consumed])).toEqual([
			['mine', true],
			['pending', false]
		]);
	});

	it('shows nothing without consumers or attachments', () => {
		expect(
			eventSourcesFor(rules, { consumers: [], attachedBrokers: [], consumedElsewhere: new Set() })
		).toEqual([]);
	});
});

describe('parseQueueKey', () => {
	it('splits on the first slash', () => {
		expect(parseQueueKey('jobs/images')).toEqual({ broker: 'jobs', queue: 'images' });
		expect(parseQueueKey('jobs')).toBeNull();
		expect(parseQueueKey('/images')).toBeNull();
		expect(parseQueueKey('jobs/')).toBeNull();
	});
});
