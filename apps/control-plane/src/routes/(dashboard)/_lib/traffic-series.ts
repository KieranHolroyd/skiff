import type { TrafficSeriesPoint } from '@skiff/core';

/**
 * Downsampling for the traffic chart. A day of minute buckets is too many SVG points, so
 * consecutive buckets are merged into wider, clock-aligned chart buckets (10 min, 6 h, ...).
 * Each chart bucket is plotted as an average *rate* per base interval rather than a raw sum, so
 * a partial chunk at either end of the range does not show up as a false dip, and the peak is
 * read from the unmerged series so "peak N/min" really is the busiest minute.
 */

export type BaseInterval = '1m' | '1h';

export interface ChartBucket {
	/** ISO start of the chart bucket (inclusive). */
	start: string;
	/** ISO end of the covered data (exclusive). */
	end: string;
	requests: number;
	status5xx: number;
	/** Average requests per base interval inside this bucket. */
	requestRate: number;
	/** Average 5xx responses per base interval inside this bucket. */
	errorRate: number;
}

export interface ChartSeries {
	buckets: ChartBucket[];
	/** Base intervals merged into each chart bucket. */
	span: number;
	/** Width of one chart bucket, e.g. "1 min", "10 min", "6 h". */
	spanLabel: string;
	/** Rate unit: per minute or per hour. */
	unit: 'min' | 'h';
	/** Busiest single base interval in the unmerged series. */
	peak: number;
	total: number;
}

export const MAX_CHART_POINTS = 160;

/** Spans that keep chart buckets on round clock boundaries. */
const NICE_SPANS: Record<BaseInterval, number[]> = {
	'1m': [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
	'1h': [1, 2, 3, 6, 12, 24, 48, 168]
};

const BASE_MS: Record<BaseInterval, number> = { '1m': 60_000, '1h': 3_600_000 };

export function spanLabel(span: number, interval: BaseInterval): string {
	const minutes = interval === '1h' ? span * 60 : span;
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 1440 || minutes % 1440 !== 0) return `${minutes / 60} h`;
	return `${minutes / 1440} d`;
}

function chooseSpan(length: number, interval: BaseInterval, maxPoints: number): number {
	for (const span of NICE_SPANS[interval]) {
		// +1 allows for a range that straddles one extra clock-aligned chunk.
		if (Math.ceil(length / span) + 1 <= maxPoints) return span;
	}
	return Math.ceil(length / maxPoints) + 1;
}

export function downsampleSeries(
	series: TrafficSeriesPoint[],
	interval: BaseInterval,
	maxPoints = MAX_CHART_POINTS
): ChartSeries {
	const base = BASE_MS[interval];
	const unit = interval === '1h' ? 'h' : 'min';
	const span = chooseSpan(series.length, interval, maxPoints);
	const spanMs = span * base;

	let peak = 0;
	let total = 0;
	const buckets: ChartBucket[] = [];
	let current: {
		startMs: number;
		lastMs: number;
		count: number;
		requests: number;
		status5xx: number;
	} | null = null;

	const close = () => {
		if (!current) return;
		buckets.push({
			start: new Date(current.startMs).toISOString(),
			end: new Date(current.lastMs + base).toISOString(),
			requests: current.requests,
			status5xx: current.status5xx,
			requestRate: current.requests / current.count,
			errorRate: current.status5xx / current.count
		});
	};

	for (const point of series) {
		const ms = Date.parse(point.bucket);
		if (!Number.isFinite(ms)) continue;
		peak = Math.max(peak, point.requests);
		total += point.requests;
		const startMs = Math.floor(ms / spanMs) * spanMs;
		if (!current || current.startMs !== startMs) {
			close();
			current = { startMs, lastMs: ms, count: 0, requests: 0, status5xx: 0 };
		}
		current.lastMs = ms;
		current.count += 1;
		current.requests += point.requests;
		current.status5xx += point.status5xx;
	}
	close();

	return { buckets, span, spanLabel: spanLabel(span, interval), unit, peak, total };
}
