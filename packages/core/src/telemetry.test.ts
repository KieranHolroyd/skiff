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

	test('the default rollup never rewrites an hour that pruning has started to eat', async () => {
		let now = Date.parse('2026-11-05T12:00:00Z');
		store = new TelemetryStore({ path: ':memory:', now: () => now });
		await store.open();
		// A full hour of traffic, 47 h ago: 60 minutes × 10 requests.
		const hour = now - 47 * HOUR;
		await store.ingest(Array.from({ length: 60 }, (_, i) => makeBucket('a.test', hour + i * MINUTE)));
		expect(await store.rollupHourly()).toBe(1);

		// 90 minutes later the first half of that hour has been pruned from metrics_1m.
		now += 90 * MINUTE;
		await store.prune();
		await store.rollupHourly();
		await store.prune();

		const points = await store.query({ from: hour, to: hour + HOUR - 1, interval: '1h' });
		expect(points).toHaveLength(1);
		expect(points[0]!.requests).toBe(600);
	});

	test('hourly queries read rolled-up hours beyond 48 h and live minutes for the open hour', async () => {
		store = new TelemetryStore({ path: ':memory:', now: () => NOW });
		await store.open();
		const old = NOW - 72 * HOUR;
		await store.ingest([makeBucket('a.test', old, { requests: 5 })]);
		await store.rollupHourly(old - HOUR, NOW);
		await store.prune();
		await store.ingest([makeBucket('a.test', NOW - MINUTE, { requests: 3 })]);

		// A 4-day range is under 7 days but must still see the 72 h-old hour.
		const points = await store.query({ from: NOW - 4 * DAY, to: NOW, interval: '1h' });
		expect(points.map((point) => point.requests)).toEqual([5, 3]);
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
			putStream: async (key, body) => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
				const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
				let offset = 0;
				for (const chunk of chunks) {
					merged.set(chunk, offset);
					offset += chunk.byteLength;
				}
				uploaded.set(key, merged);
			},
			get: async () => new Uint8Array(),
			getStream: async () => ({ body: new ReadableStream<Uint8Array>(), size: 0 }),
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

	test('report aggregates totals, series, breakdowns and top paths for a project', async () => {
		await store.open();
		await store.ingest([
			makeBucket('a.test', START, {
				requests: 10,
				status2xx: 8,
				status4xx: 1,
				status5xx: 1,
				bytes: 1_000,
				durationP95Ms: 100,
				topPaths: [
					{ path: '/', count: 7 },
					{ path: '/pricing', count: 3 },
				],
				topReferrers: [{ referrer: 'https://example.com', count: 6 }],
			}),
			makeBucket('a.test', START + MINUTE, {
				requests: 6,
				status2xx: 5,
				status4xx: 0,
				status5xx: 1,
				bytes: 600,
				durationP95Ms: 200,
				topPaths: [{ path: '/', count: 4 }],
				topReferrers: [],
			}),
			// A second host on the same project (e.g. a preview host).
			makeBucket('a--preview.test', START, {
				requests: 4,
				status2xx: 4,
				status4xx: 0,
				status5xx: 0,
				bytes: 400,
				topPaths: [{ path: '/pricing', count: 2 }],
				topReferrers: [],
			}),
			// Another project must not leak into a project-scoped report.
			makeBucket('b.test', START, {
				projectId: 'proj_2',
				requests: 50,
				topPaths: [{ path: '/other', count: 50 }],
			}),
		]);

		const report = await store.report({
			projectId: 'proj_1',
			from: START,
			to: START + 4 * MINUTE,
			interval: '1m',
		});

		expect(report.totals.requests).toBe(20);
		expect(report.totals.status4xx).toBe(1);
		expect(report.totals.status5xx).toBe(2);
		expect(report.totals.bytes).toBe(2_000);
		expect(report.totals.durationP95Ms).toBeCloseTo((10 * 100 + 6 * 200 + 4 * 20) / 20, 5);

		// Gaps are filled so every minute in the range has a chart point.
		expect(report.series).toHaveLength(5);
		expect(report.series[0]!.requests).toBe(14);
		expect(report.series[1]!.requests).toBe(6);
		expect(report.series[2]!.requests).toBe(0);

		expect(report.hosts.map((host) => host.key)).toEqual(['a.test', 'a--preview.test']);
		expect(report.projects).toHaveLength(1);
		expect(report.projects[0]!.key).toBe('proj_1');
		expect(report.topPaths[0]).toEqual({ key: '/', count: 11 });
		expect(report.topPaths[1]).toEqual({ key: '/pricing', count: 5 });
		expect(report.topReferrers[0]).toEqual({ key: 'https://example.com', count: 6 });
	});

	test('report scopes a fleet query to an explicit project list', async () => {
		await store.open();
		await store.ingest([
			makeBucket('a.test', START, { projectId: 'proj_1', requests: 3 }),
			makeBucket('b.test', START, { projectId: 'proj_2', requests: 7 }),
			makeBucket('c.test', START, { projectId: null, requests: 11 }),
		]);

		const report = await store.report({
			projectIds: ['proj_2'],
			from: START,
			to: START + MINUTE,
			interval: '1m',
		});
		expect(report.totals.requests).toBe(7);
		expect(report.projects.map((project) => project.key)).toEqual(['proj_2']);
		expect(report.topPaths).toHaveLength(1);

		const none = await store.report({
			projectIds: [],
			from: START,
			to: START + MINUTE,
			interval: '1m',
		});
		expect(none.totals.requests).toBe(0);
		expect(none.topPaths).toEqual([]);
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

	test('retries a failed open once the retry window passes', async () => {
		let now = START;
		let attempts = 0;
		store = new TelemetryStore({
			path: ':memory:',
			now: () => now,
			openRetryMs: 30_000,
			loadDuckDb: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('Could not set lock on file');
				return import('@duckdb/node-api');
			},
		});

		await store.open();
		expect(store.available).toBe(false);
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(attempts).toBe(1);

		now += 30_000;
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 1 });
		expect(store.available).toBe(true);
		expect(store.error).toBeNull();
		expect(attempts).toBe(2);
	});

	test('a disabled store never loads DuckDB', async () => {
		let loaded = false;
		store = new TelemetryStore({
			path: ':memory:',
			disabledReason: 'standby',
			loadDuckDb: async () => {
				loaded = true;
				return import('@duckdb/node-api');
			},
		});
		await store.open();
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(loaded).toBe(false);
		expect(store.available).toBe(false);
		expect(store.error?.message).toContain('standby');
	});
});
