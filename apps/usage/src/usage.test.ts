import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	USAGE_ANALYTICS_VERSION,
	usageCapabilityKeys,
	usageFeatureNames,
	usageMetricKeys,
	type UsagePing
} from '@yoal/contracts';
import { RateLimiter, handleUsageRequest } from './http.ts';
import { UsageStore } from './store.ts';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
let db: Database;
let store: UsageStore;

beforeEach(() => {
	db = new Database(':memory:');
	store = new UsageStore(db, 400);
});

afterEach(() => db.close());

function ping(overrides: Partial<UsagePing> = {}): UsagePing {
	return {
		v: USAGE_ANALYTICS_VERSION,
		id: `ping_${Math.random().toString(36).slice(2).padEnd(16, '0')}`,
		installId: 'a'.repeat(32),
		sentAt: new Date(NOW).toISOString(),
		version: '0.4.2',
		os: 'linux',
		arch: 'x64',
		metrics: Object.fromEntries(usageMetricKeys.map((key) => [key, 0])) as UsagePing['metrics'],
		features: [usageFeatureNames[0]!],
		capabilities: [usageCapabilityKeys[0]!],
		...overrides
	};
}

describe('UsageStore', () => {
	test('stores one install and one ping', () => {
		expect(store.record(ping(), NOW)).toEqual({ stored: true });
		const stats = store.stats(NOW, 30);
		expect(stats.installs).toEqual({ total: 1, active7d: 1, active30d: 1 });
		expect(stats.pings.total).toBe(1);
		expect(stats.versions).toEqual([{ name: '0.4.2', installs: 1 }]);
	});

	test('a retried ping is counted once per install', () => {
		const same = ping();
		expect(store.record(same, NOW).stored).toBe(true);
		expect(store.record(same, NOW + 1_000).stored).toBe(false);
		const stats = store.stats(NOW + 1_000, 30);
		expect(stats.installs.total).toBe(1);
		expect(stats.pings.total).toBe(1);
	});

	test('the latest ping per install feeds the metrics, not the sum of every ping', () => {
		const install = 'b'.repeat(32);
		store.record(
			ping({
				id: 'first_ping_id_0000000',
				installId: install,
				metrics: { ...ping().metrics, projects: 2 }
			}),
			NOW - DAY_MS
		);
		store.record(
			ping({
				id: 'second_ping_id_000000',
				installId: install,
				metrics: { ...ping().metrics, projects: 5 }
			}),
			NOW
		);
		const stats = store.stats(NOW, 30);
		expect(stats.pings.total).toBe(2);
		expect(stats.metrics.projects).toEqual({ installs: 1, total: 5, average: 5 });
	});

	test('active counts use the last seen time, not the query window', () => {
		store.record(ping(), NOW - 10 * DAY_MS);
		const stats = store.stats(NOW, 30);
		expect(stats.installs.total).toBe(1);
		expect(stats.installs.active30d).toBe(1);
		expect(stats.installs.active7d).toBe(0);
		// A longer query window does not make an install more recently active.
		expect(store.stats(NOW, 90).installs.active7d).toBe(0);
	});

	test('prunes raw pings past retention but keeps the install', () => {
		store.record(ping(), NOW - 500 * DAY_MS);
		expect(store.prune(NOW)).toBe(1);
		expect(store.stats(NOW, 30).installs.total).toBe(1);
		expect(store.stats(NOW, 30).pings.total).toBe(0);
	});

	test('counts features and capabilities per install', () => {
		store.record(
			ping({ id: 'feature_ping_0000001', installId: 'c'.repeat(32), features: [usageFeatureNames[0]!] }),
			NOW
		);
		store.record(
			ping({ id: 'feature_ping_0000002', installId: 'd'.repeat(32), features: [], capabilities: [] }),
			NOW
		);
		const stats = store.stats(NOW, 30);
		expect(stats.features[0]).toEqual({ name: usageFeatureNames[0]!, installs: 1 });
		expect(stats.capabilities[0]).toEqual({ name: usageCapabilityKeys[0]!, installs: 1 });
	});
});

describe('the collector HTTP surface', () => {
	const options = () => ({
		store,
		version: 'test',
		adminToken: 'secret-token',
		trustProxy: true,
		now: () => NOW,
		limiter: new RateLimiter(100, 60_000)
	});

	function post(body: unknown, headers: Record<string, string> = {}) {
		return handleUsageRequest(
			new Request('http://localhost/api/v1/ping', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: typeof body === 'string' ? body : JSON.stringify(body)
			}),
			options()
		);
	}

	test('accepts a valid ping', async () => {
		const response = await post(ping());
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ ok: true, duplicate: false });
		expect(store.stats(NOW, 30).installs.total).toBe(1);
	});

	test('answers a duplicate without storing it twice', async () => {
		const body = ping();
		expect((await post(body)).status).toBe(202);
		const again = await post(body);
		expect(await again.json()).toEqual({ ok: true, duplicate: true });
		expect(store.stats(NOW, 30).pings.total).toBe(1);
	});

	test('refuses an unexpected field', async () => {
		const response = await post({ ...ping(), hostname: 'internal.example.com' });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_ping', issues: 1 });
	});

	test('refuses a bad install id and a body that is not JSON', async () => {
		expect((await post({ ...ping(), installId: 'not-an-id' })).status).toBe(400);
		expect((await post('{')).status).toBe(400);
	});

	test('refuses the wrong media type and method', async () => {
		expect((await post(ping(), { 'content-type': 'text/plain' })).status).toBe(415);
		const get = await handleUsageRequest(new Request('http://localhost/api/v1/ping'), options());
		expect(get.status).toBe(405);
		expect(get.headers.get('allow')).toBe('POST');
	});

	test('caps the body before parsing it', async () => {
		const response = await post('x'.repeat(40 * 1024));
		expect(response.status).toBe(413);
	});

	test('rate limits per client address', async () => {
		const limited = { ...options(), limiter: new RateLimiter(1, 60_000) };
		const send = () =>
			handleUsageRequest(
				new Request('http://localhost/api/v1/ping', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
					body: JSON.stringify(ping())
				}),
				limited
			);
		expect((await send()).status).toBe(202);
		expect((await send()).status).toBe(429);
		// Another address has its own bucket.
		const other = await handleUsageRequest(
			new Request('http://localhost/api/v1/ping', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4' },
				body: JSON.stringify(ping())
			}),
			limited
		);
		expect(other.status).toBe(202);
	});

	test('the operator view needs the token and is hidden without one', async () => {
		const unauth = await handleUsageRequest(
			new Request('http://localhost/api/v1/stats'),
			options()
		);
		expect(unauth.status).toBe(401);
		const ok = await handleUsageRequest(
			new Request('http://localhost/api/v1/stats?days=7', {
				headers: { authorization: 'Bearer secret-token' }
			}),
			options()
		);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { days: number }).days).toBe(7);

		const hidden = await handleUsageRequest(
			new Request('http://localhost/api/v1/stats'),
			{ ...options(), adminToken: null }
		);
		expect(hidden.status).toBe(404);
	});

	test('health and the front page carry no stored data', async () => {
		const health = await handleUsageRequest(new Request('http://localhost/healthz'), options());
		expect(await health.json()).toEqual({ ok: true, version: 'test' });
		const front = await handleUsageRequest(new Request('http://localhost/'), options());
		expect(((await front.json()) as { ingest: string }).ingest).toBe('/api/v1/ping');
	});

	test('an unknown path is a 404', async () => {
		const response = await handleUsageRequest(new Request('http://localhost/nope'), options());
		expect(response.status).toBe(404);
	});
});
