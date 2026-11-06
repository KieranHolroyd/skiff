import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnalyticsEvent, FunctionTailEvent, MetricBucket } from '@skiff/contracts';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStore } from './object-store.ts';
import { TelemetryStore, type TelemetryOptions } from './telemetry.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';

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

describe.skipIf(!hasClickHouse)('TelemetryStore', () => {
	let store: TelemetryStore;

	/** Replace the suite's store with one built from `options` (fresh database). */
	async function swap(options: Partial<TelemetryOptions>): Promise<TelemetryStore> {
		await disposeTelemetryStore(store);
		store = testTelemetryStore(options);
		return store;
	}

	beforeEach(() => {
		store = testTelemetryStore();
	});

	afterEach(async () => {
		await disposeTelemetryStore(store);
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
		await swap({ now: () => NOW });
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

		// Drop the raw rows so the next assertion can only be satisfied by traffic_1h.
		expect(await store.prune({ rawHours: 1, hourlyDays: 90 })).toEqual({ raw: 3, hourly: 0 });

		// A range over 7 days switches to traffic_1h automatically.
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
		await swap({ now: () => now });
		await store.open();
		// A full hour of traffic, 47 h ago: 60 minutes × 10 requests.
		const hour = now - 47 * HOUR;
		await store.ingest(Array.from({ length: 60 }, (_, i) => makeBucket('a.test', hour + i * MINUTE)));
		expect(await store.rollupHourly()).toBe(1);

		// 90 minutes later the first half of that hour has been pruned from traffic_1m.
		now += 90 * MINUTE;
		await store.prune();
		await store.rollupHourly();
		await store.prune();

		const points = await store.query({ from: hour, to: hour + HOUR - 1, interval: '1h' });
		expect(points).toHaveLength(1);
		expect(points[0]!.requests).toBe(600);
	});

	test('hourly queries read rolled-up hours beyond 48 h and live minutes for the open hour', async () => {
		await swap({ now: () => NOW });
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
		await swap({ now: () => NOW });
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
		await swap({ now: () => START + 30 * MINUTE });
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

	test('scrapeSamples sums the last hour per project, filtered to the ids asked for', async () => {
		await swap({ now: () => START + 30 * MINUTE });
		await store.open();
		await store.ingest([
			makeBucket('a.test', START, { projectId: 'proj_a', requests: 10, status2xx: 8, status5xx: 2, bytes: 1_500, durationP95Ms: 40 }),
			makeBucket('a2.test', START + MINUTE, { projectId: 'proj_a', requests: 30, status2xx: 30, status5xx: 0, bytes: 500, durationP95Ms: 20 }),
			makeBucket('b.test', START + MINUTE, { projectId: 'proj_b', requests: 3 }),
		]);

		const samples = await store.scrapeSamples({ projectIds: ['proj_a'], databaseIds: [], storageIds: [] });
		expect(samples.traffic).toHaveLength(1);
		expect(samples.traffic[0]).toMatchObject({ projectId: 'proj_a', requests: 40, status2xx: 38, status5xx: 2, bytes: 2_000 });
		// Request-weighted: (40 * 10 + 20 * 30) / 40.
		expect(samples.traffic[0]?.durationP95Ms).toBe(25);
		expect(await store.scrapeSamples({ projectIds: [], databaseIds: [], storageIds: [] })).toEqual({
			traffic: [],
			databases: [],
			databaseCounters: [],
			storage: [],
		});
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

	test('hourly SQL views cover rolled-up hours and the open hour', async () => {
		await swap({ now: () => NOW });
		await store.open();
		const old = NOW - 5 * HOUR;
		await store.ingest([makeBucket('a.test', old, { requests: 5 }), makeBucket('a.test', NOW - MINUTE, { requests: 3 })]);
		await store.rollupHourly(old - HOUR, NOW);
		const result = await store.runQuery('SELECT sum(requests) AS n, count() AS hours FROM traffic_hourly', { asReader: true });
		expect(result.data[0]).toEqual([8, 2]);
		const tables = await store.tables();
		expect(tables.map((table) => table.name)).toContain('traffic_hourly');
		expect(tables.find((table) => table.name === 'traffic_1m')?.columns.map((column) => column.name)).not.toContain('version');
	});

	test('ad-hoc reader queries cannot write', async () => {
		await store.open();
		await expect(store.runQuery(`INSERT INTO traffic_1m (host, bucket) VALUES ('x', now())`, { asReader: true })).rejects.toThrow();
	});

	test('ingests Analytics Engine datapoints with millisecond timestamps', async () => {
		await store.open();
		// The table is a plain MergeTree: every datapoint is a row, so a re-sent batch appends.
		await store.ingestAnalytics([
			{
				ts: START + 123,
				projectId: 'proj_1',
				workloadId: 'wl_1',
				dataset: 'web_events',
				blobs: ['/pricing', 'GET'],
				doubles: [-1.5, 2],
				indexes: ['proj_1'],
			},
		]);
		const result = await store.runQuery(
			`SELECT toUnixTimestamp64Milli(ts) AS ts_ms, project_id, workload_id, dataset, blobs, doubles, indexes
			FROM ${store.database}.function_analytics`,
			{ asReader: false },
		);
		expect(result.data).toEqual([
			[START + 123, 'proj_1', 'wl_1', 'web_events', ['/pricing', 'GET'], [-1.5, 2], ['proj_1']],
		]);
	});
});

/** A fetch that fails the way an unreachable server does. */
const refused: typeof fetch = Object.assign(async () => {
	throw new TypeError('Unable to connect. Is the computer able to access the url?');
}, { preconnect: () => undefined });

describe('TelemetryStore without a server', () => {
	test('falls back to a no-op store when ClickHouse is unreachable', async () => {
		const errors: Error[] = [];
		const store = new TelemetryStore({
			clickhouse: { url: 'http://127.0.0.1:1', user: 'skiff', password: '', fetch: refused },
			onError: (error) => errors.push(error),
		});

		await store.open();
		expect(store.available).toBe(false);
		expect(store.error?.message).toContain('ClickHouse');
		expect(store.error?.message).toContain('unreachable');
		expect(errors).toHaveLength(1);

		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(await store.query({ from: START, to: START + HOUR, interval: '1m' })).toEqual([]);
		expect(await store.rollupHourly()).toBe(0);
		expect(await store.prune()).toEqual({ raw: 0, hourly: 0 });
		expect(await store.exportParquet({ from: START, to: START + HOUR, dir: '/nonexistent' })).toEqual({ files: [], bytes: 0 });
		expect(await store.getPrometheusMetrics()).toBe('');
		await expect(store.runQuery('SELECT 1', { asReader: true })).rejects.toThrow('unreachable');
	});

	test('retries a failed open once the retry window passes', async () => {
		let now = START;
		let attempts = 0;
		const flaky: typeof fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				attempts += 1;
				if (attempts === 1) throw new TypeError('Connection refused');
				return new Response('', { status: 200 });
			},
			{ preconnect: () => undefined },
		);
		const store = new TelemetryStore({
			clickhouse: { url: 'http://127.0.0.1:1', user: 'skiff', password: '', fetch: flaky },
			now: () => now,
			openRetryMs: 30_000,
		});

		await store.open();
		expect(store.available).toBe(false);
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(attempts).toBe(1);

		now += 30_000;
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 1 });
		expect(store.available).toBe(true);
		expect(store.error).toBeNull();
	});

	test('a store whose server goes away reconnects after the window', async () => {
		let now = START;
		let down = false;
		const fetcher: typeof fetch = Object.assign(
			async () => {
				if (down) throw new TypeError('Connection refused');
				return new Response('', { status: 200 });
			},
			{ preconnect: () => undefined },
		);
		const store = new TelemetryStore({
			clickhouse: { url: 'http://127.0.0.1:1', user: 'skiff', password: '', fetch: fetcher },
			now: () => now,
			openRetryMs: 30_000,
		});
		expect(await store.ready()).toBe(true);
		down = true;
		expect(await store.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(store.available).toBe(false);
		down = false;
		expect(await store.ready()).toBe(false);
		now += 30_000;
		expect(await store.ready()).toBe(true);
	});

	test('a cancelled or slow query never marks the store unavailable', async () => {
		// Answers DDL at once; holds ad-hoc queries until their signal aborts (like a slow ClickHouse).
		const fetcher: typeof fetch = Object.assign(
			async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				if (String(init?.body).includes('CREATE')) return new Response('', { status: 200 });
				return new Promise<Response>((_, reject) => {
					const fail = () => reject(init?.signal?.reason ?? new DOMException('aborted', 'AbortError'));
					if (init?.signal?.aborted) fail();
					else init?.signal?.addEventListener('abort', fail);
				});
			},
			{ preconnect: () => undefined },
		);
		const store = new TelemetryStore({
			clickhouse: { url: 'http://127.0.0.1:1', user: 'skiff', password: '', fetch: fetcher, timeoutMs: 50 },
		});
		expect(await store.ready()).toBe(true);

		const controller = new AbortController();
		const pending = store.runQuery('SELECT 1', { asReader: true, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(store.available).toBe(true);

		await expect(store.runQuery('SELECT sleep(3)', { asReader: true })).rejects.toThrow('was stopped');
		expect(store.available).toBe(true);
	});

	test('a disabled or unconfigured store never connects', async () => {
		let called = false;
		const spy: typeof fetch = Object.assign(
			async () => {
				called = true;
				return new Response('', { status: 200 });
			},
			{ preconnect: () => undefined },
		);
		const disabled = new TelemetryStore({
			clickhouse: { url: 'http://127.0.0.1:1', user: 'skiff', password: '', fetch: spy },
			disabledReason: 'standby',
		});
		await disabled.open();
		expect(await disabled.ingest([makeBucket('a.test', START)])).toEqual({ inserted: 0 });
		expect(called).toBe(false);
		expect(disabled.available).toBe(false);
		expect(disabled.error?.message).toContain('standby');

		const unconfigured = new TelemetryStore({});
		expect(await unconfigured.ready()).toBe(false);
		expect(unconfigured.installed).toBe(false);
		expect(unconfigured.error?.message).toContain('not installed');
	});
});

// --- Analytics Engine ingestion ----------------------------------------------------------------

interface ClickHouseCall {
	/** The statement: `query` for an INSERT body, else the POSTed SQL. */
	statement: string;
	/** `?query=` when the call carries rows in the body. */
	query: string | null;
	body: string;
}

/** A fake ClickHouse HTTP endpoint injected through `ClickHouseConfig.fetch`. */
function fakeClickHouse() {
	const calls: ClickHouseCall[] = [];
	let mode: 'ok' | 'down' | 'error' = 'ok';
	const handler = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const query = url.searchParams.get('query');
		const body = String(init.body ?? '');
		calls.push({ statement: query ?? body, query, body });
		if (mode === 'down') throw new TypeError('fetch failed');
		if (mode === 'error') return new Response('Code: 62. DB::Exception: Syntax error', { status: 400 });
		return new Response('', { status: 200 });
	}) as typeof fetch;
	return {
		calls,
		fetch: handler,
		setMode: (next: 'ok' | 'down' | 'error') => {
			mode = next;
		},
	};
}

function makeStore(fake: ReturnType<typeof fakeClickHouse>): TelemetryStore {
	return new TelemetryStore({
		clickhouse: { url: 'http://clickhouse.test', user: 'skiff', password: 'secret', database: 'skiff', fetch: fake.fetch },
		tableTtl: false,
	});
}

function makeAnalyticsEvent(ts: number, overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
	return {
		ts,
		projectId: 'prj_1',
		workloadId: 'wl_1',
		dataset: 'web_events',
		blobs: ['/pricing'],
		doubles: [1],
		indexes: [],
		...overrides,
	};
}

describe('TelemetryStore analytics ingestion (injected client)', () => {
	test('creates the function_analytics table alongside the existing tables', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();
		expect(store.available).toBe(true);

		const ddl = fake.calls.filter((call) => call.statement.trimStart().startsWith('CREATE TABLE'));
		expect(ddl).toHaveLength(8);

		const analytics = fake.calls.find((call) => call.statement.includes('.function_analytics'))!;
		expect(analytics.statement).toContain('ts DateTime64(3)');
		expect(analytics.statement).toContain('project_id LowCardinality(String)');
		expect(analytics.statement).toContain('workload_id String');
		expect(analytics.statement).toContain('dataset LowCardinality(String)');
		expect(analytics.statement).toContain('blobs Array(String)');
		expect(analytics.statement).toContain('doubles Array(Float64)');
		expect(analytics.statement).toContain('indexes Array(String)');
		expect(analytics.statement).toContain('ENGINE = MergeTree');
		expect(analytics.statement).toContain('ORDER BY (project_id, dataset, ts)');
		expect(analytics.statement).toContain('TTL toDateTime(ts) + INTERVAL 90 DAY');
	});

	test('inserts events as JSONEachRow with ClickHouse column names', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestAnalytics([
			makeAnalyticsEvent(Date.parse('2026-11-06T12:00:00.123Z'), {
				blobs: ['/pricing', 'GET'],
				doubles: [-1.5, 2],
				indexes: ['proj'],
			}),
		]);

		const insert = fake.calls.find(
			(call) => call.query === 'INSERT INTO skiff.function_analytics FORMAT JSONEachRow',
		);
		expect(insert).toBeDefined();
		const rows = insert!.body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(rows).toEqual([
			{
				ts: '2026-11-06 12:00:00.123',
				project_id: 'prj_1',
				workload_id: 'wl_1',
				dataset: 'web_events',
				blobs: ['/pricing', 'GET'],
				doubles: [-1.5, 2],
				indexes: ['proj'],
			},
		]);
	});

	test('chunks a large batch into 5,000-row inserts', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestAnalytics(Array.from({ length: 12_001 }, (_, index) => makeAnalyticsEvent(index)));
		const inserts = fake.calls.filter((call) => call.query?.startsWith('INSERT INTO skiff.function_analytics'));
		expect(inserts.map((call) => call.body.split('\n').length)).toEqual([5_000, 5_000, 2_001]);
	});

	test('does not insert anything when the event list is empty', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestAnalytics([]);
		expect(fake.calls.some((call) => call.query?.includes('function_analytics'))).toBe(false);
	});

	test('is fail-open when ClickHouse is unreachable', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();
		fake.setMode('down');

		await expect(store.ingestAnalytics([makeAnalyticsEvent(1)])).resolves.toBeUndefined();
		expect(store.available).toBe(false);
		expect(store.error?.message).toContain('unreachable');
	});

	test('is fail-open when the insert itself is rejected', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();
		fake.setMode('error');

		await expect(store.ingestAnalytics([makeAnalyticsEvent(1)])).resolves.toBeUndefined();
		// A query error is reported, not treated as the server going away.
		expect(store.available).toBe(true);
		expect(store.error?.message).toContain('Syntax error');
	});
});

// --- Tail-worker ingestion ----------------------------------------------------------------------

function makeTailEvent(ts: number, overrides: Partial<FunctionTailEvent> = {}): FunctionTailEvent {
	return {
		ts,
		projectId: 'prj_1',
		workloadId: 'wl_1',
		scriptName: 'my-worker',
		outcome: 'ok',
		logs: [{ level: 'log', message: 'hello' }],
		exceptions: [{ name: 'Error', message: 'boom' }],
		request: { method: 'GET', url: 'https://example.com/page', status: 200 },
		...overrides,
	};
}

describe('TelemetryStore tail ingestion (injected client)', () => {
	test('creates the function_tail_events table with the documented schema', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		const ddl = fake.calls.find((call) => call.statement.includes('.function_tail_events'))!;
		expect(ddl).toBeDefined();
		expect(ddl.statement).toContain('ts DateTime64(3)');
		expect(ddl.statement).toContain('project_id LowCardinality(String)');
		expect(ddl.statement).toContain('workload_id String');
		expect(ddl.statement).toContain('script_name String');
		expect(ddl.statement).toContain('outcome LowCardinality(String)');
		expect(ddl.statement).toContain('logs_json String');
		expect(ddl.statement).toContain('exceptions_json String');
		expect(ddl.statement).toContain('request_json String');
		expect(ddl.statement).toContain('ENGINE = MergeTree');
		expect(ddl.statement).toContain('ORDER BY (project_id, ts)');
		expect(ddl.statement).toContain('TTL toDateTime(ts) + INTERVAL 30 DAY');
	});

	test('inserts tails as JSONEachRow with the structured parts as JSON strings', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestTails([
			makeTailEvent(Date.parse('2026-11-06T12:00:00.123Z'), {
				logs: [
					{ level: 'log', message: 'hello' },
					{ level: 'error', message: 'bad' },
				],
				exceptions: [{ name: 'TypeError', message: 'x is not a function' }],
				request: null,
			}),
		]);

		const insert = fake.calls.find(
			(call) => call.query === 'INSERT INTO skiff.function_tail_events FORMAT JSONEachRow',
		);
		expect(insert).toBeDefined();
		const rows = insert!.body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(rows).toEqual([
			{
				ts: '2026-11-06 12:00:00.123',
				project_id: 'prj_1',
				workload_id: 'wl_1',
				script_name: 'my-worker',
				outcome: 'ok',
				logs_json: JSON.stringify([
					{ level: 'log', message: 'hello' },
					{ level: 'error', message: 'bad' },
				]),
				exceptions_json: JSON.stringify([{ name: 'TypeError', message: 'x is not a function' }]),
				request_json: 'null',
			},
		]);
	});

	test('chunks a large batch into 2,000-row inserts', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestTails(Array.from({ length: 4_500 }, (_, index) => makeTailEvent(index)));
		const inserts = fake.calls.filter((call) => call.query?.startsWith('INSERT INTO skiff.function_tail_events'));
		expect(inserts.map((call) => call.body.split('\n').length)).toEqual([2_000, 2_000, 500]);
	});

	test('does not insert anything when the tail list is empty', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();

		await store.ingestTails([]);
		expect(fake.calls.some((call) => call.query?.includes('function_tail_events'))).toBe(false);
	});

	test('is fail-open when ClickHouse is unreachable', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();
		fake.setMode('down');

		await expect(store.ingestTails([makeTailEvent(1)])).resolves.toBeUndefined();
		expect(store.available).toBe(false);
		expect(store.error?.message).toContain('unreachable');
	});

	test('is fail-open when the insert itself is rejected', async () => {
		const fake = fakeClickHouse();
		const store = makeStore(fake);
		await store.open();
		fake.setMode('error');

		await expect(store.ingestTails([makeTailEvent(1)])).resolves.toBeUndefined();
		expect(store.available).toBe(true);
		expect(store.error?.message).toContain('Syntax error');
	});
});
