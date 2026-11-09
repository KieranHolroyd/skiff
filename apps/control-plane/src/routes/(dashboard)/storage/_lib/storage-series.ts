import type { StorageMetricPoint } from '@yoal/contracts';
import { MAX_CHART_POINTS, spanLabel, type BaseInterval } from '../../_lib/traffic-series.js';
import { chooseSpan } from '../../databases/_lib/database-series.js';

/**
 * Chart buckets for the storage metrics card (S7). Same clock-aligned merging as the database
 * charts: stored bytes, objects and bucket count take the max of a merged bucket (they only move
 * in steps), memory is averaged.
 */

export interface StorageChartBucket {
	/** Epoch ms of the chart bucket start (inclusive). */
	start: number;
	/** Epoch ms where the covered data ends (exclusive). */
	end: number;
	usedBytes: number;
	objects: number;
	bucketCount: number;
	memoryBytes: number;
	/** Share of samples where the instance answered. */
	up: number;
}

export interface StorageChart {
	buckets: StorageChartBucket[];
	span: number;
	spanLabel: string;
	spanMs: number;
}

export interface StorageTotals {
	latestUsedBytes: number | null;
	latestObjects: number | null;
	latestBucketCount: number | null;
	latestMemoryBytes: number | null;
	/** Share of samples in the range where the instance answered. */
	uptime: number | null;
}

const BASE_MS: Record<BaseInterval, number> = { '1m': 60_000, '1h': 3_600_000 };

export function storageChart(
	points: StorageMetricPoint[],
	interval: BaseInterval,
	window: { from: number; to: number },
	maxPoints = MAX_CHART_POINTS
): StorageChart {
	const base = BASE_MS[interval];
	const span = chooseSpan(Math.max(base, window.to - window.from), interval, maxPoints);
	const spanMs = span * base;

	type Acc = {
		start: number;
		last: number;
		count: number;
		used: number;
		objects: number;
		bucketCount: number;
		memory: number;
		up: number;
	};
	const buckets: StorageChartBucket[] = [];
	let acc: Acc | null = null;

	const close = () => {
		if (!acc) return;
		buckets.push({
			start: acc.start,
			end: acc.last + base,
			usedBytes: acc.used,
			objects: acc.objects,
			bucketCount: acc.bucketCount,
			memoryBytes: acc.memory / acc.count,
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
			acc = { start, last: ms, count: 0, used: 0, objects: 0, bucketCount: 0, memory: 0, up: 0 };
		}
		acc.last = ms;
		acc.count += 1;
		acc.used = Math.max(acc.used, point.usedBytes);
		acc.objects = Math.max(acc.objects, point.objects);
		acc.bucketCount = Math.max(acc.bucketCount, point.bucketCount);
		acc.memory += point.memoryBytes;
		acc.up += point.up;
	}
	close();

	return { buckets, span, spanLabel: spanLabel(span, interval), spanMs };
}

/** Newest gauges and uptime over the range, for the summary row above the charts. */
export function storageTotals(points: StorageMetricPoint[]): StorageTotals {
	let latest: StorageMetricPoint | null = null;
	let latestMs = -Infinity;
	let up = 0;
	for (const point of points) {
		const ms = Date.parse(point.bucket);
		if (Number.isFinite(ms) && ms > latestMs) {
			latestMs = ms;
			latest = point;
		}
		up += point.up;
	}
	return {
		latestUsedBytes: latest ? latest.usedBytes : null,
		latestObjects: latest ? latest.objects : null,
		latestBucketCount: latest ? latest.bucketCount : null,
		latestMemoryBytes: latest ? latest.memoryBytes : null,
		uptime: points.length > 0 ? up / points.length : null
	};
}
