import { afterEach, describe, expect, test } from 'bun:test';
import type { AnalyticsEvent, FunctionTailEvent } from '@yoal/contracts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessLogAggregator, TelemetryClient } from './telemetry.ts';

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

// --- Analytics Engine batching -----------------------------------------------------------------

interface CapturedPost {
	url: string;
	body: Record<string, unknown>;
}

const clients: TelemetryClient[] = [];
const directories: string[] = [];
const restores: Array<() => void> = [];

function makeClient(): TelemetryClient {
	const directory = mkdtempSync(join(tmpdir(), 'yoal-agent-telemetry-'));
	directories.push(directory);
	const accessLogPath = join(directory, 'access.log');
	writeFileSync(accessLogPath, '');
	const client = new TelemetryClient({
		controlUrl: 'https://control.test',
		nodeToken: 'node-token',
		nodeId: 'nod_1',
		accessLogPath,
		resolveProject: () => null,
	});
	clients.push(client);
	return client;
}

/** Replace `fetch` with a recorder and a scripted sequence of statuses. */
function stubControlPlane(statuses: number[] = [200]): CapturedPost[] {
	const posts: CapturedPost[] = [];
	const original = globalThis.fetch;
	let index = 0;
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		posts.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
		const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
		index += 1;
		return new Response(status === 200 ? '{"ok":true}' : 'nope', { status });
	}) as typeof fetch;
	restores.push(() => {
		globalThis.fetch = original;
	});
	return posts;
}

function analyticsEvent(ts: number): AnalyticsEvent {
	return {
		ts,
		projectId: 'prj_1',
		workloadId: 'wl_1',
		dataset: 'web_events',
		blobs: ['/pricing'],
		doubles: [1],
		indexes: [],
	};
}

function tailEvent(ts: number): FunctionTailEvent {
	return {
		ts,
		projectId: 'prj_1',
		workloadId: 'wl_1',
		scriptName: 'my-worker',
		outcome: 'ok',
		logs: [{ level: 'log', message: `event ${ts}` }],
		exceptions: [],
		request: { method: 'GET', url: 'https://example.com/', status: 200 },
	};
}

afterEach(async () => {
	// Stop clients first: shutdown flushes through the stub before it is restored.
	await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined)));
	for (const restore of restores.splice(0)) restore();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('TelemetryClient analytics batching', () => {
	test('rides the next telemetry POST as `analytics` and drains the buffer', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		client.recordAnalytics(analyticsEvent(1));
		client.recordAnalytics(analyticsEvent(2));
		await client.flush(true);

		expect(posts).toHaveLength(1);
		expect(posts[0]!.url).toBe('https://control.test/api/agent/telemetry');
		expect(posts[0]!.body.nodeId).toBe('nod_1');
		expect(posts[0]!.body.buckets).toEqual([]);
		expect(posts[0]!.body.analytics).toEqual([analyticsEvent(1), analyticsEvent(2)]);

		// Nothing buffered: the next flush sends no POST at all.
		await client.flush(true);
		expect(posts).toHaveLength(1);
	});

	test('caps the buffer at 5,000 events, dropping the oldest', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		for (let index = 0; index < 5_001; index += 1) client.recordAnalytics(analyticsEvent(index));
		await client.flush(true);

		const sent = posts[0]!.body.analytics as AnalyticsEvent[];
		expect(sent).toHaveLength(5_000);
		expect(sent[0]!.ts).toBe(1);
		expect(sent.at(-1)!.ts).toBe(5_000);
		expect(client.stats.analyticsDropped).toBe(1);
	});

	test('requeues analytics when the POST fails and sends them next time', async () => {
		const posts = stubControlPlane([500, 200]);
		const client = makeClient();
		await client.start();

		client.recordAnalytics(analyticsEvent(7));
		await expect(client.flush(true)).rejects.toThrow('Telemetry POST -> 500');
		expect(client.stats.flushFailures).toBe(1);

		await client.flush(true);
		expect(posts).toHaveLength(2);
		expect(posts[0]!.body.analytics).toEqual([analyticsEvent(7)]);
		expect(posts[1]!.body.analytics).toEqual([analyticsEvent(7)]);
	});

	test('never includes an empty analytics array', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		// One complete minute of access-log traffic, no analytics events.
		writeFileSync(join(directories[0]!, 'access.log'), `${line()}\n`);
		await client.poll();
		await client.flush(true);

		expect(posts).toHaveLength(1);
		expect(posts[0]!.body.buckets).toHaveLength(1);
		expect('analytics' in posts[0]!.body).toBe(false);
	});
});

// --- Tail-worker batching ----------------------------------------------------------------------

describe('TelemetryClient tail batching', () => {
	test('rides the next telemetry POST as `tails` and drains the buffer', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		client.recordTail(tailEvent(1));
		client.recordTail(tailEvent(2));
		await client.flush(true);

		expect(posts).toHaveLength(1);
		expect(posts[0]!.body.nodeId).toBe('nod_1');
		expect(posts[0]!.body.buckets).toEqual([]);
		expect(posts[0]!.body.tails).toEqual([tailEvent(1), tailEvent(2)]);
		expect('analytics' in posts[0]!.body).toBe(false);

		// Nothing buffered: the next flush sends no POST at all.
		await client.flush(true);
		expect(posts).toHaveLength(1);
	});

	test('sends analytics and tails together in one POST', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		client.recordAnalytics(analyticsEvent(1));
		client.recordTail(tailEvent(2));
		await client.flush(true);

		expect(posts).toHaveLength(1);
		expect(posts[0]!.body.analytics).toEqual([analyticsEvent(1)]);
		expect(posts[0]!.body.tails).toEqual([tailEvent(2)]);
	});

	test('caps the tail buffer at 2,000 items, dropping the oldest', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		for (let index = 0; index < 2_001; index += 1) client.recordTail(tailEvent(index));
		await client.flush(true);

		const sent = posts[0]!.body.tails as FunctionTailEvent[];
		expect(sent).toHaveLength(2_000);
		expect(sent[0]!.ts).toBe(1);
		expect(sent.at(-1)!.ts).toBe(2_000);
		expect(client.stats.tailsDropped).toBe(1);
	});

	test('requeues tails when the POST fails and sends them next time', async () => {
		const posts = stubControlPlane([500, 200]);
		const client = makeClient();
		await client.start();

		client.recordTail(tailEvent(7));
		await expect(client.flush(true)).rejects.toThrow('Telemetry POST -> 500');
		expect(client.stats.flushFailures).toBe(1);

		await client.flush(true);
		expect(posts).toHaveLength(2);
		expect(posts[0]!.body.tails).toEqual([tailEvent(7)]);
		expect(posts[1]!.body.tails).toEqual([tailEvent(7)]);
	});

	test('never includes an empty tails array', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();

		// One complete minute of access-log traffic, no tail events.
		writeFileSync(join(directories[0]!, 'access.log'), `${line()}\n`);
		await client.poll();
		await client.flush(true);

		expect(posts).toHaveLength(1);
		expect(posts[0]!.body.buckets).toHaveLength(1);
		expect('tails' in posts[0]!.body).toBe(false);
	});

	test('flushes buffered tails on stop, then goes quiet', async () => {
		const posts = stubControlPlane();
		const client = makeClient();
		await client.start();
		client.recordTail(tailEvent(1));
		await client.stop();

		expect(posts).toHaveLength(1);
		expect(posts[0]!.body.tails).toEqual([tailEvent(1)]);
		// A flush after stop is a no-op, not a second POST.
		await client.flush(true);
		expect(posts).toHaveLength(1);
	});
});
