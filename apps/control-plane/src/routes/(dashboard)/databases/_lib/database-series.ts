import type { DatabaseMetricPoint } from '@skiff/contracts';
import { MAX_CHART_POINTS, spanLabel, type BaseInterval } from '../../_lib/traffic-series.js';

/**
 * Chart buckets for the database metrics card (D57). Like the traffic chart, long series are
 * merged into clock-aligned chart buckets so a day of minute samples stays a light SVG. Gauges
 * are averaged (size and `max_connections` take the max), counters become an average rate per
 * minute, so hourly rollups and merged buckets read on the same scale as raw minutes.
 */

export interface DatabaseChartBucket {
	/** Epoch ms of the chart bucket start (inclusive). */
	start: number;
	/** Epoch ms where the covered data ends (exclusive). */
	end: number;
	sizeBytes: number;
	connectionsActive: number;
	connectionsIdle: number;
	maxConnections: number;
	commitPerMinute: number;
	rollbackPerMinute: number;
	/** Rows inserted + updated + deleted, per minute. */
	rowsWrittenPerMinute: number;
	/** blksHit / (blksHit + blksRead); null when no block was touched. */
	cacheHitRatio: number | null;
	/** Share of samples where the database answered. */
	up: number;
}

export interface DatabaseChart {
	buckets: DatabaseChartBucket[];
	/** Base intervals merged into each chart bucket. */
	span: number;
	spanLabel: string;
	/** Width of one chart bucket in ms. */
	spanMs: number;
}

export interface DatabaseTotals {
	/** Newest sample's size (bytes), or null without data. */
	latestSizeBytes: number | null;
	latestConnections: number | null;
	maxConnections: number | null;
	commits: number;
	rollbacks: number;
	rowsWritten: number;
	cacheHitRatio: number | null;
	deadlocks: number;
}

const NICE_SPANS: Record<BaseInterval, number[]> = {
	'1m': [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
	'1h': [1, 2, 3, 6, 12, 24, 48, 168]
};
const BASE_MS: Record<BaseInterval, number> = { '1m': 60_000, '1h': 3_600_000 };

/** Pick the smallest clock-friendly span that keeps the whole window under `maxPoints`. */
export function chooseSpan(windowMs: number, interval: BaseInterval, maxPoints = MAX_CHART_POINTS) {
	const slots = Math.max(1, Math.ceil(windowMs / BASE_MS[interval]));
	for (const span of NICE_SPANS[interval])
		if (Math.ceil(slots / span) + 1 <= maxPoints) return span;
	return Math.ceil(slots / maxPoints) + 1;
}

/**
 * Merge database samples into chart buckets. The span is chosen from the window (not the number
 * of samples) so a sparse series still lines up with the time axis.
 */
export function databaseChart(
	points: DatabaseMetricPoint[],
	interval: BaseInterval,
	window: { from: number; to: number },
	maxPoints = MAX_CHART_POINTS
): DatabaseChart {
	const base = BASE_MS[interval];
	const minutesPerBase = base / 60_000;
	const span = chooseSpan(Math.max(base, window.to - window.from), interval, maxPoints);
	const spanMs = span * base;

	type Acc = {
		start: number;
		last: number;
		count: number;
		size: number;
		active: number;
		idle: number;
		maxConn: number;
		commit: number;
		rollback: number;
		written: number;
		hit: number;
		read: number;
		up: number;
	};
	const buckets: DatabaseChartBucket[] = [];
	let acc: Acc | null = null;

	const close = () => {
		if (!acc) return;
		const minutes = acc.count * minutesPerBase;
		const blocks = acc.hit + acc.read;
		buckets.push({
			start: acc.start,
			end: acc.last + base,
			sizeBytes: acc.size,
			connectionsActive: acc.active / acc.count,
			connectionsIdle: acc.idle / acc.count,
			maxConnections: acc.maxConn,
			commitPerMinute: acc.commit / minutes,
			rollbackPerMinute: acc.rollback / minutes,
			rowsWrittenPerMinute: acc.written / minutes,
			cacheHitRatio: blocks > 0 ? acc.hit / blocks : null,
			up: acc.up / acc.count
		});
	};

	const sorted = points
		.map((point) => ({ point, ms: Date.parse(point.bucket) }))
		.filter((item) => Number.isFinite(item.ms))
		.sort((a, b) => a.ms - b.ms);

	for (const { point, ms } of sorted) {
		const start = Math.floor(ms / spanMs) * spanMs;
		if (!acc || acc.start !== start) {
			close();
			acc = {
				start,
				last: ms,
				count: 0,
				size: 0,
				active: 0,
				idle: 0,
				maxConn: 0,
				commit: 0,
				rollback: 0,
				written: 0,
				hit: 0,
				read: 0,
				up: 0
			};
		}
		acc.last = ms;
		acc.count += 1;
		acc.size = Math.max(acc.size, point.sizeBytes);
		acc.active += point.connectionsActive;
		acc.idle += point.connectionsIdle;
		acc.maxConn = Math.max(acc.maxConn, point.maxConnections);
		acc.commit += point.xactCommit;
		acc.rollback += point.xactRollback;
		acc.written += point.tupInserted + point.tupUpdated + point.tupDeleted;
		acc.hit += point.blksHit;
		acc.read += point.blksRead;
		acc.up += point.up;
	}
	close();

	return { buckets, span, spanLabel: spanLabel(span, interval), spanMs };
}

/** Range totals and the newest gauges, for the summary row above the charts. */
export function databaseTotals(points: DatabaseMetricPoint[]): DatabaseTotals {
	let latest: DatabaseMetricPoint | null = null;
	let latestMs = -Infinity;
	let commits = 0;
	let rollbacks = 0;
	let rowsWritten = 0;
	let hit = 0;
	let read = 0;
	let deadlocks = 0;
	for (const point of points) {
		const ms = Date.parse(point.bucket);
		if (Number.isFinite(ms) && ms > latestMs) {
			latestMs = ms;
			latest = point;
		}
		commits += point.xactCommit;
		rollbacks += point.xactRollback;
		rowsWritten += point.tupInserted + point.tupUpdated + point.tupDeleted;
		hit += point.blksHit;
		read += point.blksRead;
		deadlocks += point.deadlocks;
	}
	return {
		latestSizeBytes: latest ? latest.sizeBytes : null,
		latestConnections: latest ? latest.connectionsActive + latest.connectionsIdle : null,
		maxConnections: latest ? latest.maxConnections : null,
		commits,
		rollbacks,
		rowsWritten,
		cacheHitRatio: hit + read > 0 ? hit / (hit + read) : null,
		deadlocks
	};
}

/** Size against the storage budget, as a 0–100 percentage (null without a sample). */
export function storagePercent(sizeBytes: number | null, storageMb: number): number | null {
	if (sizeBytes === null || storageMb <= 0) return null;
	return Math.min(100, Math.max(0, (sizeBytes / (storageMb * 1024 * 1024)) * 100));
}
