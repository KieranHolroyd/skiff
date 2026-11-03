import { describe, expect, test } from 'bun:test';
import { AccessLogAggregator } from './telemetry.ts';

function line(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		ts: 60.2,
		status: 200,
		size: 100,
		duration: 0.01,
		request: { host: 'site.example.com:443', uri: '/page?x=1', headers: { Referer: ['https://ref.example/'] } },
		...overrides,
	});
}

describe('access log aggregation', () => {
	test('builds bounded 1-minute buckets per host', () => {
		// Current time is minute 2, so minute 1 is complete and safe to flush.
		const aggregator = new AccessLogAggregator(() => 'prj_1', () => 120_000);
		aggregator.addLine(line());
		aggregator.addLine(line({ status: 404, size: 10, duration: 0.03, request: { host: 'site.example.com', uri: '/' } }));
		aggregator.addLine(line({ ts: 120, status: 500, request: { host: 'site.example.com', uri: '/now' } }));
		aggregator.addLine('not json');

		expect(aggregator.flushReady()).toBe(1);
		const [bucket] = aggregator.takePending();
		expect(bucket).toBeDefined();
		expect(bucket!.host).toBe('site.example.com');
		expect(bucket!.projectId).toBe('prj_1');
		expect(bucket!.requests).toBe(2);
		expect(bucket!.status2xx).toBe(1);
		expect(bucket!.status4xx).toBe(1);
		expect(bucket!.bytes).toBe(110);
		expect(bucket!.durationP50Ms).toBeGreaterThan(0);
		expect(bucket!.topPaths[0]).toEqual({ path: '/page', count: 1 });
		expect(bucket!.topReferrers[0]?.referrer).toBe('https://ref.example/');

		// The current minute only leaves on shutdown / the next flush.
		expect(aggregator.pendingCount).toBe(0);
		expect(aggregator.flushReady()).toBe(0);
		expect(aggregator.flushReady(true)).toBe(1);
	});
});
