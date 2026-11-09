import type { BrokerMetricPoint } from '@yoal/contracts';
import { MAX_CHART_POINTS, spanLabel, type BaseInterval } from '../../_lib/traffic-series.js';
import { chooseSpan } from '../../databases/_lib/database-series.js';

/**
 * Chart buckets for the broker metrics tab (D123). Same clock-aligned merging as the database and
 * storage charts. Gauges follow the ClickHouse rollup: `up` and connections average, store sizes,
 * backlog, age and memory take the max (a merged point shows the peak). Counters (published,
 * messages/bytes in and out, slow consumers) are per-minute deltas and sum.
 */

const AVG_GAUGES = ['up', 'connections'] as const;
const MAX_GAUGES = [
	'streams',
	'consumers',
	'storeBytes',
	'storeLimitBytes',
	'memoryStoreBytes',
	'messages',
	'pending',
	'ackPending',
	'redelivered',
	'oldestAgeSeconds',
	'memoryBytes'
] as const;
const COUNTERS = [
	'published',
	'messagesIn',
	'messagesOut',
	'bytesIn',
	'bytesOut',
	'slowConsumers'
] as const;

type Field = (typeof AVG_GAUGES)[number] | (typeof MAX_GAUGES)[number] | (typeof COUNTERS)[number];

export type BrokerChartBucket = { start: number; end: number } & Record<Field, number>;

export interface BrokerChart {
	buckets: BrokerChartBucket[];
	span: number;
	spanLabel: string;
	spanMs: number;
}

export interface BrokerTotals {
	latest: BrokerMetricPoint | null;
	/** Share of samples in the range where the broker answered. */
	uptime: number | null;
	/** Sums over the range. */
	published: number;
	messagesIn: number;
	messagesOut: number;
	slowConsumers: number;
	/** Highest backlog (pending + awaiting ack) seen in the range. */
	peakBacklog: number;
}

const BASE_MS: Record<BaseInterval, number> = { '1m': 60_000, '1h': 3_600_000 };

function sortedPoints(points: BrokerMetricPoint[]) {
	return points
		.map((point) => ({ point, ms: Date.parse(point.bucket) }))
		.filter((item) => Number.isFinite(item.ms))
		.sort((a, b) => a.ms - b.ms);
}

export function brokerChart(
	points: BrokerMetricPoint[],
	interval: BaseInterval,
	window: { from: number; to: number },
	maxPoints = MAX_CHART_POINTS
): BrokerChart {
	const base = BASE_MS[interval];
	const span = chooseSpan(Math.max(base, window.to - window.from), interval, maxPoints);
	const spanMs = span * base;

	type Acc = { start: number; last: number; count: number; values: Record<Field, number> };
	const empty = (): Record<Field, number> =>
		Object.fromEntries([...AVG_GAUGES, ...MAX_GAUGES, ...COUNTERS].map((field) => [field, 0])) as Record<
			Field,
			number
		>;
	const buckets: BrokerChartBucket[] = [];
	let acc: Acc | null = null;

	const close = () => {
		if (!acc) return;
		const values = { ...acc.values };
		for (const field of AVG_GAUGES) values[field] = acc.values[field] / acc.count;
		buckets.push({ start: acc.start, end: acc.last + base, ...values });
	};

	for (const { point, ms } of sortedPoints(points)) {
		const start = Math.floor(ms / spanMs) * spanMs;
		if (!acc || acc.start !== start) {
			close();
			acc = { start, last: ms, count: 0, values: empty() };
		}
		acc.last = ms;
		acc.count += 1;
		for (const field of AVG_GAUGES) acc.values[field] += point[field] ?? 0;
		for (const field of MAX_GAUGES) acc.values[field] = Math.max(acc.values[field], point[field] ?? 0);
		for (const field of COUNTERS) acc.values[field] += point[field] ?? 0;
	}
	close();

	return { buckets, span, spanLabel: spanLabel(span, interval), spanMs };
}

/** Newest point, uptime and range sums for the summary row above the charts. */
export function brokerTotals(points: BrokerMetricPoint[]): BrokerTotals {
	const sorted = sortedPoints(points);
	const totals: BrokerTotals = {
		latest: sorted.at(-1)?.point ?? null,
		uptime: null,
		published: 0,
		messagesIn: 0,
		messagesOut: 0,
		slowConsumers: 0,
		peakBacklog: 0
	};
	let up = 0;
	for (const { point } of sorted) {
		up += point.up;
		totals.published += point.published;
		totals.messagesIn += point.messagesIn;
		totals.messagesOut += point.messagesOut;
		totals.slowConsumers += point.slowConsumers;
		totals.peakBacklog = Math.max(totals.peakBacklog, point.pending + point.ackPending);
	}
	if (sorted.length > 0) totals.uptime = up / sorted.length;
	return totals;
}

/** Seconds since the stream's oldest message, as of the listing; null when it is empty. */
export function streamAgeSeconds(firstAt: string | null, at: string | null): number | null {
	if (!firstAt || !at) return null;
	const first = Date.parse(firstAt);
	const listed = Date.parse(at);
	if (!Number.isFinite(first) || !Number.isFinite(listed)) return null;
	return Math.max(0, (listed - first) / 1000);
}
