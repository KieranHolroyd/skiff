import { describe, expect, test } from 'bun:test';
import { functionBindingTypes } from '@yoal/contracts';
import {
	BINDING_INFO,
	bindingAvailable,
	bindingMatrix,
	bindingNameFor,
	dataBindingSnippet,
	functionStatus,
	statefulBindings,
	compatibilityLagDays,
	describeCron,
	formatIdleStop,
	functionAttention,
	bindingsBySecret,
	groupBindings,
	secretBindings,
	secretIndex
} from './function-view.js';

describe('binding matrix', () => {
	test('covers every binding type the contracts know', () => {
		for (const type of functionBindingTypes) expect(BINDING_INFO[type]).toBeDefined();
		expect(bindingMatrix(null)).toHaveLength(functionBindingTypes.length);
	});

	test('availability follows the implemented map, not a phase number', () => {
		const rows = bindingMatrix(null, { secret: true, r2: false });
		expect(rows.find((row) => row.type === 'secret')?.available).toBe(true);
		expect(rows.find((row) => row.type === 'r2')?.available).toBe(false);
		expect(bindingAvailable('queue', { queue: true })).toBe(true);
		expect(bindingAvailable('not-a-type')).toBe(false);
	});

	test('a binding the server accepted counts as available whatever the build says', () => {
		const rows = bindingMatrix(
			{ bindings: [{ name: 'DB', type: 'hyperdrive', summary: '' }] },
			{ hyperdrive: false }
		);
		expect(rows.find((row) => row.type === 'hyperdrive')).toMatchObject({
			available: true,
			used: 1
		});
	});

	test('marks the stateful types that cap a function at one host', () => {
		const stateful = bindingMatrix(null)
			.filter((row) => row.stateful)
			.map((row) => row.type)
			.sort();
		expect(stateful).toEqual(['cache', 'd1', 'durable_object', 'kv']);
	});
});

describe('statefulBindings', () => {
	test('names the bindings that pin a function to one host', () => {
		expect(
			statefulBindings({
				bindings: [
					{ name: 'ROOMS', type: 'durable_object', summary: '' },
					{ name: 'DB', type: 'hyperdrive', summary: '' }
				]
			}).map((binding) => binding.name)
		).toEqual(['ROOMS']);
		expect(statefulBindings(null)).toEqual([]);
	});
});

describe('functionStatus', () => {
	test('an idle-stopped host reads as idle, not stopped', () => {
		expect(functionStatus({ status: 'stopped' }, { idleStopSeconds: 300 }).label).toBe('Idle');
		expect(functionStatus({ status: 'stopped' }, { idleStopSeconds: 0 }).label).toBe('stopped');
	});

	test('no workload means not deployed', () => {
		expect(functionStatus(null, null)).toMatchObject({ status: 'inactive', label: 'Not deployed' });
	});

	test('failed explains the watchdog', () => {
		expect(functionStatus({ status: 'failed' }, null).hint).toMatch(/watchdog/);
	});
});

describe('groupBindings', () => {
	test('groups in a fixed order and keeps manifest order inside a group', () => {
		const groups = groupBindings([
			{ name: 'B', type: 'r2' },
			{ name: 'A', type: 'text' },
			{ name: 'C', type: 'secret' },
			{ name: 'D', type: 'app' }
		]);
		expect(groups.map((group) => group.group)).toEqual(['config', 'services', 'data']);
		expect(groups[0]!.items.map((item) => item.name)).toEqual(['A', 'C']);
	});
});

describe('formatIdleStop', () => {
	test.each([
		[0, 'Always on'],
		[45, 'After 45 s idle'],
		[300, 'After 5 min idle'],
		[90, 'After 1 min 30 s idle'],
		[7200, 'After 2 h idle']
	])('%d s → %s', (seconds, expected) => {
		expect(formatIdleStop(seconds)).toBe(expected);
	});
});

describe('compatibilityLagDays', () => {
	test('counts days behind the pinned build', () => {
		expect(compatibilityLagDays('2026-11-01', '2026-11-06')).toBe(5);
		expect(compatibilityLagDays('2026-11-06', '2026-11-06')).toBe(0);
		expect(compatibilityLagDays('garbage', '2026-11-06')).toBe(0);
	});
});

describe('describeCron', () => {
	test.each([
		['* * * * *', 'Every minute'],
		['*/5 * * * *', 'Every 5 minutes'],
		['0 * * * *', 'Every hour, on the hour'],
		['15 * * * *', 'Every hour at :15'],
		['0 */6 * * *', 'Every 6 hours at :00'],
		['30 3 * * *', 'Daily at 03:30 UTC'],
		['0 9 * * 1-5', 'Weekdays at 09:00 UTC'],
		['0 9 * * 1', 'Mondays at 09:00 UTC'],
		['0 9 * * 7', 'Sundays at 09:00 UTC']
	])('%s → %s', (expression, expected) => {
		expect(describeCron(expression)).toBe(expected);
	});

	test('leaves unusual shapes to the raw expression', () => {
		expect(describeCron('0 0 1 * *')).toBeNull();
		expect(describeCron('1,2 3 * * *')).toBeNull();
		expect(describeCron('nope')).toBeNull();
	});
});

describe('secretBindings', () => {
	test('reads the store name back from the summary, falling back to the binding name', () => {
		expect(
			secretBindings([
				{ name: 'API_KEY', type: 'secret', summary: 'secret API_KEY' },
				{ name: 'token', type: 'secret', summary: 'secret STRIPE_TOKEN' },
				{ name: 'odd', type: 'secret', summary: '' },
				{ name: 'GREETING', type: 'text', summary: 'text' }
			])
		).toEqual([
			{ binding: 'API_KEY', secret: 'API_KEY' },
			{ binding: 'token', secret: 'STRIPE_TOKEN' },
			{ binding: 'odd', secret: 'odd' }
		]);
	});
});

describe('secretIndex', () => {
	test('a project secret shadows an org secret of the same name', () => {
		const index = secretIndex(
			[
				{ id: 'org', name: 'API_KEY', projectId: null },
				{ id: 'proj', name: 'API_KEY', projectId: 'p1' },
				{ id: 'other', name: 'TOKEN', projectId: null }
			],
			'p1'
		);
		expect(index.get('API_KEY')?.id).toBe('proj');
		expect(index.get('TOKEN')?.id).toBe('other');
	});

	test('groups bindings that read the same store secret', () => {
		const index = bindingsBySecret([
			{ binding: 'A', secret: 'KEY' },
			{ binding: 'B', secret: 'KEY' },
			{ binding: 'C', secret: 'OTHER' }
		]);
		expect(index.get('KEY')).toEqual(['A', 'B']);
		expect(index.get('OTHER')).toEqual(['C']);
	});
});

describe('functionAttention', () => {
	const pinned = { version: '1.20261106.1', maxDate: '2026-11-06' };
	const healthy = {
		view: { compatibilityDate: '2026-10-01', workerdVersion: '1.20261106.1' },
		workload: { status: 'running', message: null },
		missingSecrets: []
	};

	test('a healthy, current function needs nothing', () => {
		expect(functionAttention(healthy, pinned)).toEqual([]);
	});

	test('orders failures and missing secrets ahead of nudges', () => {
		const kinds = functionAttention(
			{
				view: { compatibilityDate: '2025-01-01', workerdVersion: '1.20260901.1' },
				workload: { status: 'failed', message: 'exit 1' },
				missingSecrets: ['API_KEY']
			},
			pinned
		).map((item) => item.kind);
		expect(kinds).toEqual(['failed', 'missing-secret', 'compat-behind', 'older-pin']);
	});

	test('an undeployed function says so and skips runtime checks', () => {
		expect(
			functionAttention({ view: null, workload: null, missingSecrets: [] }, pinned).map(
				(a) => a.kind
			)
		).toEqual(['not-deployed']);
	});
});

describe('dataBindingSnippet', () => {
	test('binds each attached database and granted bucket by a derived name', () => {
		const snippet = dataBindingSnippet(
			['app-db'],
			[{ name: 'media', buckets: ['uploads', 'thumbs'] }]
		);
		expect(snippet).toContain('"binding": "APP_DB"');
		expect(snippet).toContain('"APP_DB": "app-db"');
		expect(snippet).toContain('"bucket_name": "thumbs"');
		expect(snippet).toContain('"THUMBS": "media"');
		// The snippet is a JSON object body once wrapped in braces.
		expect(() => JSON.parse(`{${snippet}}`)).not.toThrow();
	});

	test('falls back to placeholders with nothing attached', () => {
		expect(dataBindingSnippet([], [])).toContain('"APP_DB": "app-db"');
	});

	test('derives identifier-safe names', () => {
		expect(bindingNameFor('app-db')).toBe('APP_DB');
		expect(bindingNameFor('2024-logs')).toBe('R_2024_LOGS');
	});
});
