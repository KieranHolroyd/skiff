import type { TelemetryInterval } from '@skiff/core';

/**
 * Dashboard traffic ranges. Minute buckets for the last day, hourly buckets for longer
 * windows (the DuckDB store keeps 1-minute rows for 48 h and hourly rollups for 90 days).
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
	/** ISO timestamps (plain strings so SvelteKit can serialise them). */
	from: string;
	to: string;
}

/** Parse `?range=`, falling back to the last 24 hours. Timestamps are bucket-aligned. */
export function parseTrafficRange(raw: string | null, now = Date.now()): TrafficRange {
	const preset =
		trafficRanges.find((item) => item.key === raw) ??
		trafficRanges.find((item) => item.key === '24h') ??
		trafficRanges[0]!;
	const step = preset.interval === '1h' ? 3_600_000 : 60_000;
	// End on the current minute so the open hour/minute is included; align the start to a
	// whole bucket so an hourly query never pulls in traffic from before the window.
	const to = Math.floor(now / 60_000) * 60_000;
	const from = Math.floor((to - preset.hours * 3_600_000) / step) * step;
	return {
		key: preset.key,
		label: preset.label,
		interval: preset.interval,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString()
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
