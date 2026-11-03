import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MetricBucket } from '@skiff/contracts';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStore } from './object-store.ts';
import { TelemetryStore } from './telemetry.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.parse('2026-11-03T10:00:00Z');
const NOW = Date.parse('2026-11-03T12:34:00Z');

function makeBucket(host: string, at: number, overrides: Partial<MetricBucket> = {}): MetricBucket {
	const base: MetricBucket = {
		host,
		projectId: 'proj_1',
		bucket: new Date(at).toISOString(),
		requests: 10,
		status2xx: 9,
		status3xx: 0,
		status4xx: 1,
		status5xx: 0,
		bytes: 1_000,
		durationP50Ms: 10,
		durationP95Ms: 20,
		topPaths: [{ path: '/', count: 10 }],
		topReferrers: [{ referrer: 'https://example.com', count: 10 }],
	};
	return Object.assign(base, overrides);
}

function pointsAt(points: { host: string; bucket: string }[], host: string, at: number): number {
	return points.findIndex((p) => p.host === host && Date.parse(p.bucket) === at);
}

describe('TelemetryStore', () => {
	let store: TelemetryStore;

	beforeEach(() => {
		store = new TelemetryStore({ path: ':memory:' });
	});

	afterEach(async () => {
		await store.close();
	});

	test('ingests 1-minute buckets and queries them back', async () => {
		await store.open();
		expect(store.available).toBe(true);
		expect(store.error).toBeNull();

		const inserted = await store.ingest([
			makeBucket('a.test', START, { requests: 10, status5xx: 2, bytes: 1_500 }),
			makeBucket('a.test', START + MINUTE, { requests: 4, status4xx: 0 }),
			makeBucket('b.test', START, { projectId: 'proj_2', requests: 7 }),
		]);
		expect(inserted).toEqual({ inserted: 3 });

		const points = await store.query({
			from: START,
			to: START + 2 * MINUTE,
			interval: '1m',
		});
		expect(points).toHaveLength(3);

		const first = points[pointsAt(points, 'a.test', START)]!;
		expect(first.projectId).toBe('proj_1');
		expect(first.requests).toBe(10);
		expect(first.status2xx).toBe(9);
		expect(first.status4xx).toBe(1);
		expect(first.status5xx).toBe(2);
		expect(first.bytes).toBe(1_500);
		expect(first.durationP50Ms).toBe(10);
		expect(first.durationP95Ms).toBe(20);

		const second = points[pointsAt(points, 'a.test', START + MINUTE)]!;
		expect(second.requests).toBe(4);

		const other = points[pointsAt(points, 'b.test', START)]!;
		expect(other.projectId).toBe('proj_2');
		expect(other.requests).toBe(7);

		const filtered = await store.query({
			host: 'b.test',
			projectId: 'proj_2',
			from: START,
			to: START + 2 * MINUTE,
			interval: '1m',
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]!.host).toBe('b.test');
	});

	test('ingest is idempotent per host and minute', async () => {
		await store.open();
		await store.ingest([makeBucket('a.test', START, { requests: 5 })]);
		await store.ingest([
			makeBucket('a.test', START, { requests: 9, status5xx: 3, bytes: 2_000 }),
		]);

		const points = await store.query({
			from: START,
			to: START + MINUTE,
			interval: '1m',
		});
		expect(points).toHaveLength(1);
		expect(points[0]!.requests).toBe(9);
		expect(points[0]!.status5xx).toBe(3);
		expect(points[0]!.bytes).toBe(2_000);
	});

	test('aggregates 1-minute rows into hourly buckets with request-weighted latencies', async () => {
		await store.open();
		await store.ingest([
			makeBucket('a.test', START, {
				requests: 5,
				status2xx: 5,
				status4xx: 0,
				bytes: 500,
				durationP50Ms: 10,
				durationP95Ms: 20,
			}),
			makeBucket('a.test', START + MINUTE, {
				requests: 7,
				status2xx: 6,
				status4xx: 0,
				status5xx: 1,
				bytes: 700,
				durationP50Ms: 30,
				durationP95Ms: 40,
			}),
		]);

		const points = await store.query({
			from: START,
			to: START + HOUR,
			interval: '1h',
		});
		expect(points).toHaveLength(1);
		const point = points[0]!;
		expect(point.requests).toBe(12);
		expect(point.status2xx).toBe(11);
		expect(point.status5xx).toBe(1);
		expect(point.bytes).toBe(1_200);
		expect(point.durationP50Ms).toBeCloseTo((5 * 10 + 7 * 30) / 12, 5);
		expect(point.durationP95Ms).toBeCloseTo((5 * 20 + 7 * 40) / 12, 5);
		expect(Date.parse(point.bucket)).toBe(Date.parse('2026-11-03T10:00:00Z'));
	});

	test('rollupHourly is idempotent and powers long-range queries', async () => {
		store = new TelemetryStore({ path: ':memory:', now: () => NOW });
		await store.open();
		await store.ingest([
			makeBucket('a.test', START - 7 * HOUR, { requests: 5, bytes: 500 }),
			makeBucket('a.test', START - 7 * HOUR + MINUTE, {
				requests: 7,
				status5xx: 1,
				bytes: 700,
			}),
			makeBucket('b.test', START - 7 * HOUR, { requests: 3, bytes: 300 }),
		]);

		const first = await store.rollupHourly(START - 8 * HOUR, NOW);
		expect(first).toBe(2);
		const second = await store.rollupHourly(START - 8 * HOUR, NOW);
		expect(second).toBe(2);

		// Drop the raw rows so the next assertion can only be satisfied by metrics_1h.
		expect(await store.prune({ rawHours: 1, hourlyDays: 90 })).toEqual({ raw: 3, hourly: 0 });

		// A range over 7 days switches to metrics_1h automatically.
		const points = await store.query({
			from: START - 8 * DAY,
			to: NOW,
			interval: '1h',
		});
		expect(points).toHaveLength(2);
		const a = points[pointsAt(points, 'a.test', START - 7 * HOUR)]!;
		expect(a.requests).toBe(12);
		expect(a.status5xx).toBe(1);
		expect(a.bytes).toBe(1_200);
		expect(a.durationP50Ms).toBeCloseTo((5 * 10 + 7 * 10) / 12, 5);
	});

	test('prune drops raw and hourly data past their retention windows', async () => {
		store = new TelemetryStore({ path: ':memory:', now: () => NOW });
		await store.open();
		const old = NOW - 100 * HOUR;
		const recent = NOW - 2 * HOUR;
		await store.ingest([
			makeBucket('a.test', old, { requests: 5 }),
			makeBucket('a.test', recent, { requests: 7 }),
		]);

		expect(await store.rollupHourly(old - HOUR, NOW)).toBe(2);
		const pruned = await store.prune({ rawHours: 48, hourlyDays: 1 });
		expect(pruned).toEqual({ raw: 1, hourly: 1 });

		const raw = await store.query({ from: old - HOUR, to: NOW, interval: '1m' });
		expect(raw).toHaveLength(1);
		expect(raw[0]!.requests).toBe(7);
		expect(Date.parse(raw[0]!.bucket)).toBe(recent);

		// The old hour was archived first, then pruned; the recent one survives.
		const hourly = await store.query({ from: old - 8 * DAY, to: NOW, interval: '1h' });
		expect(hourly).toHaveLength(1);
		expect(hourly[0]!.requests).toBe(7);
	});

	test('exports day-partitioned Parquet and uploads it to the object store', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skiff-telemetry-'));
		const uploaded = new Map<string, Uint8Array>();
		const objectStore: ObjectStore = {
			kind: 'local',
			put: async (key, data) => {
				uploaded.set(key, data);
			},
			get: async () => new Uint8Array(),
			delete: async () => undefined,
			exists: async () => false,
			presignPut: async () => '',
			presignGet: async () => '',
		};
		try {
			await store.open();
			await store.ingest([makeBucket('a.test', START)]);

			const exported = await store.exportParquet({
				from: START - MINUTE,
				to: START + MINUTE,
				dir,
				objectStore,
			});
			expect(exported.files).toHaveLength(1);
			expect(exported.bytes).toBeGreaterThan(0);
			expect([...uploaded.keys()]).toContain('telemetry/2026-11-03/data_0.parquet');

			const remaining = existsSync(dir) ? await readdir(dir, { recursive: true }) : [];
			expect(remaining.filter((entry) => String(entry).endsWith('.parquet'))).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('getPrometheusMetrics renders the last hour', async () => {
		store = new TelemetryStore({ path: ':memory:', now: () => START + 30 * MINUTE });
		await store.open();
		await store.ingest([
			makeBucket('a.test', START, { requests: 10, status5xx: 2, bytes: 1_500 }),
			makeBucket('b.test', START + MINUTE, { requests: 3, status5xx: 0, bytes: 300 }),
		]);

		const text = await store.getPrometheusMetrics('a.test');
		expect(text).toContain('# TYPE skiff_http_requests_total gauge');
		expect(text).toContain('skiff_http_requests_total{host="a.test"} 10');
		expect(text).toContain('skiff_http_errors_total{class="5xx"} 2');
		expect(text).toContain('skiff_bytes_total 1500');
		expect(text).not.toContain('host="b.test"');
	});

	test('falls back to a no-op store when DuckDB cannot load', async () => {
		const errors: Error[] = [];
		store = new TelemetryStore({
			path: ':memory:',
			loadDuckDb: async () => {
				throw new Error('native bindings missing');
			},
			onError: (error) => errors.push(error),
		});

		await store.open();
		expect(store.available).toBe(false);
		expect(store.error?.message).toContain('DuckDB');
		expect(store.error?.message).toContain('native bindings missing');
		expect(errors).toHaveLength(1);

		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(await store.query({ from: START, to: START + HOUR, interval: '1m' })).toEqual([]);
		expect(await store.rollupHourly()).toBe(0);
		expect(await store.prune()).toEqual({ raw: 0, hourly: 0 });
		expect(await store.exportParquet({ from: START, to: START + HOUR, dir: '/nonexistent' })).toEqual({
			files: [],
			bytes: 0,
		});
		expect(await store.getPrometheusMetrics()).toBe('');
	});
});
