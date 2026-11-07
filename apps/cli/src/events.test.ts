import { describe, expect, test } from 'bun:test';
import { eventRuleTable, watching, type EventRuleView } from './events.ts';

function rule(overrides: Partial<EventRuleView> = {}): EventRuleView {
	return {
		id: 'evr_1',
		source: 'storage',
		events: ['object-create'],
		filter: { storage: 'media', bucket: 'uploads', prefix: 'incoming/', suffix: '.jpg' },
		broker: 'jobs',
		queue: 'images',
		description: null,
		enabled: true,
		createdAt: '2026-11-07T10:00:00.000Z',
		updatedAt: '2026-11-07T10:00:00.000Z',
		deliveries: { pending: 1, delivered: 4, failed: 0 },
		lastDeliveredAt: null,
		lastError: null,
		...overrides,
	};
}

describe('skif events formatting', () => {
	test('each source says what it watches', () => {
		expect(watching(rule())).toBe('media/uploads incoming/*.jpg');
		expect(watching(rule({ filter: { storage: 'media', bucket: 'uploads' } }))).toBe('media/uploads');
		expect(watching(rule({ source: 'deployments', filter: {} }))).toBe('every project');
		expect(watching(rule({ source: 'deployments', filter: { project: 'shop' } }))).toBe('project shop');
		expect(watching(rule({ source: 'alerts', filter: {} }))).toBe('every rule');
		expect(watching(rule({ source: 'database-backups', filter: { database: 'main' } }))).toBe('database main');
	});

	test('the table marks disabled rules and shows the target queue', () => {
		const table = eventRuleTable([rule(), rule({ id: 'evr_2', enabled: false, source: 'alerts', filter: {}, queue: 'pages' })]);
		expect(table).toContain('jobs/images');
		expect(table).toContain('alerts (off)');
		expect(table).toContain('4 ok, 1 pending, 0 failed');
	});
});
