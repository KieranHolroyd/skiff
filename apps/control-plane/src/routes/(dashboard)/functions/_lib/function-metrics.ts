/**
 * Per-function request summary for the Functions list: a 24-hour hourly trend plus the totals a
 * console row shows. Pure, so the server and its tests agree on the arithmetic.
 */

export interface FunctionMetrics {
	/** Requests per hour, oldest first; empty when telemetry has no data. */
	series: number[];
	requests: number;
	/** 5xx share of all requests, 0–1; null when there were no requests. */
	errorRate: number | null;
	/** Request-weighted p95 latency in ms; null when there were no requests. */
	p95Ms: number | null;
}

interface ReportLike {
	totals: { requests: number; status5xx: number; durationP95Ms: number };
	series: Array<{ bucket: string; requests: number }>;
}

/** Collapse a traffic report into one row's numbers, padding missing hours with zero. */
export function summariseTraffic(
	report: ReportLike,
	window: { from: number; hours: number }
): FunctionMetrics {
	const buckets = new Array<number>(window.hours).fill(0);
	for (const point of report.series) {
		const at = Date.parse(point.bucket);
		if (Number.isNaN(at)) continue;
		const index = Math.floor((at - window.from) / 3_600_000);
		if (index >= 0 && index < window.hours) buckets[index]! += point.requests;
	}
	const requests = report.totals.requests;
	return {
		series: report.series.length > 0 ? buckets : [],
		requests,
		errorRate: requests > 0 ? report.totals.status5xx / requests : null,
		p95Ms: requests > 0 ? report.totals.durationP95Ms : null
	};
}

/** "0", "842", "12.4k", "3.1M". */
export function compactCount(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** "0%", "0.2%", "12%", or an em dash when there is nothing to divide. */
export function formatRate(rate: number | null): string {
	if (rate === null) return '—';
	const pct = rate * 100;
	if (pct === 0) return '0%';
	if (pct < 0.1) return '<0.1%';
	return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}
