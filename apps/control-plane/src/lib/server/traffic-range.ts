import type { TelemetryInterval } from '@yoal/core';

/**
 * Dashboard traffic ranges. Minute buckets for the last day, hourly buckets for longer
 * windows (the ClickHouse store keeps 1-minute rows for 48 h and hourly rollups for 90 days).
 */
export const trafficRanges = [
	{
		key: '1h',
		label: '1 hour',
		shortLabel: '1h',
		hours: 1,
		interval: '1m' as TelemetryInterval
	},
	{
		key: '24h',
		label: '24 hours',
		shortLabel: '24h',
		hours: 24,
		interval: '1m' as TelemetryInterval
	},
	{
		key: '7d',
		label: '7 days',
		shortLabel: '7d',
		hours: 24 * 7,
		interval: '1h' as TelemetryInterval
	},
	{
		key: '30d',
		label: '30 days',
		shortLabel: '30d',
		hours: 24 * 30,
		interval: '1h' as TelemetryInterval
	}
] as const;

export type TrafficRangeKey = (typeof trafficRanges)[number]['key'];

export interface TrafficRange {
	key: TrafficRangeKey;
	label: string;
	interval: TelemetryInterval;
	/**
	 * ISO timestamps (plain strings so SvelteKit can serialise them). Both are bucket starts and
	 * inclusive: the data covers `[from, to + 1 minute)`.
	 */
	from: string;
	to: string;
	/** Wall-clock seconds the queried buckets cover; the denominator for per-second averages. */
	windowSeconds: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Agents ship a minute only after it closes, on a 60 s cadence (DESIGN §8), so the current minute
 * is never reported and the previous one is reported only part of the time. Ending the range
 * before them keeps the series from dropping to a false zero and the averages from counting
 * time that has no data yet.
 */
export const TRAFFIC_REPORTING_LAG_MINUTES = 2;

/**
 * Parse `?range=`, falling back to the last hour. Timestamps are bucket-aligned and the range
 * ends on the newest minute every agent has reported.
 */
export function parseTrafficRange(raw: string | null, now = Date.now()): TrafficRange {
	const preset =
		trafficRanges.find((item) => item.key === raw) ??
		trafficRanges.find((item) => item.key === '1h') ??
		trafficRanges[0]!;
	const step = preset.interval === '1h' ? HOUR_MS : MINUTE_MS;
	// `to` is the start of the last reported minute; the window ends when that minute does.
	const to = (Math.floor(now / MINUTE_MS) - TRAFFIC_REPORTING_LAG_MINUTES) * MINUTE_MS;
	const end = to + MINUTE_MS;
	// Align the start to a whole bucket so an hourly query never pulls in traffic from before
	// the window (an hourly range can therefore cover up to 59 extra minutes).
	const from = Math.floor((end - preset.hours * HOUR_MS) / step) * step;
	return {
		key: preset.key,
		label: preset.label,
		interval: preset.interval,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		windowSeconds: (end - from) / 1000
	};
}

/** A `?range=` link for the current page, preserving the other query parameters. */
export function trafficRangeHref(
	url: URL,
	key: TrafficRangeKey,
	overrides: Record<string, string> = {}
): string {
	const next = new URL(url);
	for (const [name, value] of Object.entries(overrides)) next.searchParams.set(name, value);
	next.searchParams.set('range', key);
	return `${next.pathname}${next.search}`;
}
