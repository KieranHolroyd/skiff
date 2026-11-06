import { describe, expect, test } from 'bun:test';
import analyticsWriter from './analytics.js';

/**
 * Tests for the Analytics Engine wrapper module. The module is plain JavaScript that runs inside
 * workerd, so it is exercised here against a fake `sink` service binding: no sockets, no agent.
 */

interface Captured {
	url: string;
	init: { method?: string; headers?: Record<string, string>; body?: string };
	body: Record<string, unknown>;
}

function makeWriter(
	overrides: {
		dataset?: string;
		projectId?: string;
		workloadId?: string;
		sink?: { fetch: (url: string, init: Record<string, unknown>) => unknown };
	} = {},
) {
	const calls: Captured[] = [];
	const sink = overrides.sink ?? {
		fetch: (_url: string, init: Record<string, unknown>) => {
			calls.push({
				url: 'http://analytics/event',
				init: init as Captured['init'],
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			});
			return Promise.resolve(new Response(null, { status: 202 }));
		},
	};
	const writer = analyticsWriter({
		dataset: overrides.dataset ?? 'web_events',
		projectId: overrides.projectId ?? 'prj_0123456789',
		workloadId: overrides.workloadId ?? 'wl_1',
		sink,
	});
	return { writer, calls };
}

describe('analytics extension module', () => {
	test('wraps the env into a writeDataPoint object', () => {
		const { writer } = makeWriter();
		expect(typeof writer.writeDataPoint).toBe('function');
	});

	test('POSTs the dataset, ownership and event arrays to the sink', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint({
			blobs: ['/pricing', 'GET'],
			doubles: [200, 12.5],
			indexes: ['prj_0123456789'],
		});

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call!.url).toBe('http://analytics/event');
		expect(call!.init.method).toBe('POST');
		expect(call!.init.headers).toEqual({ 'content-type': 'application/json' });
		// The dataset and ownership come from the inner bindings, never from the event.
		expect(call!.body).toEqual({
			dataset: 'web_events',
			projectId: 'prj_0123456789',
			workloadId: 'wl_1',
			blobs: ['/pricing', 'GET'],
			doubles: [200, 12.5],
			indexes: ['prj_0123456789'],
		});
	});

	test('defaults an empty writeDataPoint call to empty arrays', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint();
		expect(calls[0]!.body).toEqual({
			dataset: 'web_events',
			projectId: 'prj_0123456789',
			workloadId: 'wl_1',
			blobs: [],
			doubles: [],
			indexes: [],
		});
	});

	test('ignores non-array and non-finite inputs instead of throwing', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint({
			blobs: 'not-an-array',
			doubles: [Number.NaN, Number.POSITIVE_INFINITY, 1],
			indexes: [42, 'ok'],
		});
		expect(calls[0]!.body).toMatchObject({ blobs: [], doubles: [1], indexes: ['ok'] });
	});

	test('is fire-and-forget when the sink rejects', async () => {
		const { writer } = makeWriter({
			sink: { fetch: () => Promise.reject(new Error('sink down')) },
		});
		expect(() => writer.writeDataPoint({ doubles: [1] })).not.toThrow();
		// Let the rejection settle; the module must swallow it (no unhandled rejection).
		await Promise.resolve();
	});

	test('is fire-and-forget when the sink throws synchronously', () => {
		const { writer } = makeWriter({
			sink: {
				fetch: () => {
					throw new Error('no such service');
				},
			},
		});
		expect(() => writer.writeDataPoint({ doubles: [1] })).not.toThrow();
	});

	test('is a no-op when the sink binding is missing', () => {
		const writer = analyticsWriter({ dataset: 'ds', projectId: 'prj', workloadId: 'wl' });
		expect(() => writer.writeDataPoint({ blobs: ['x'] })).not.toThrow();
	});

	test('caps blobs at 20, clips each to 16 KiB and keeps the body under the sink budget', () => {
		const { writer, calls } = makeWriter();
		const many = Array.from({ length: 25 }, (_, index) => `blob-${index}`);
		writer.writeDataPoint({ blobs: many });
		expect((calls[0]!.body.blobs as string[]).length).toBe(20);

		const long = 'x'.repeat(20_000);
		writer.writeDataPoint({ blobs: [long] });
		const clipped = (calls[1]!.body.blobs as string[])[0]!;
		expect(clipped.length).toBe(16 * 1024);

		// Twenty individually-maximal blobs would exceed the sink's 256 KiB body cap, so the total
		// budget stops the list early rather than letting the sink reject the whole event.
		writer.writeDataPoint({ blobs: Array.from({ length: 20 }, () => 'y'.repeat(16 * 1024)) });
		const budgeted = calls[2]!.body.blobs as string[];
		expect(budgeted.length).toBeLessThan(20);
		expect(budgeted.length).toBeGreaterThan(0);
		expect(JSON.stringify(calls[2]!.body).length).toBeLessThan(256 * 1024);
	});

	test('caps doubles at 20 and drops non-finite values', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint({
			doubles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, Number.NaN],
		});
		expect(calls[0]!.body.doubles).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
	});

	test('caps indexes at 20 and clips each to 1 KiB', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint({ indexes: Array.from({ length: 25 }, (_, index) => `idx-${index}`) });
		expect((calls[0]!.body.indexes as string[]).length).toBe(20);

		writer.writeDataPoint({ indexes: ['z'.repeat(2_000)] });
		expect((calls[1]!.body.indexes as string[])[0]!.length).toBe(1024);
	});

	test('decodes ArrayBuffer and typed-array blobs', () => {
		const { writer, calls } = makeWriter();
		writer.writeDataPoint({
			blobs: [new TextEncoder().encode('binary').buffer, new TextEncoder().encode('view')],
		});
		expect(calls[0]!.body.blobs).toEqual(['binary', 'view']);
	});
});
