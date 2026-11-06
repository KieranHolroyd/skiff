/**
 * Value formatting and colours for dashboard panels. Units match the contract's `FieldUnit`
 * names (and Grafana's): axis ticks, tooltips, legends, stats and table cells all go through
 * `formatValue`.
 */

export const UNITS = [
	{ value: 'none', label: 'Number' },
	{ value: 'short', label: 'Short (1.2K)' },
	{ value: 'bytes', label: 'Bytes (IEC)' },
	{ value: 'bytesps', label: 'Bytes/second' },
	{ value: 'ms', label: 'Milliseconds' },
	{ value: 's', label: 'Seconds' },
	{ value: 'percent', label: 'Percent (0–100)' },
	{ value: 'percentunit', label: 'Percent (0.0–1.0)' },
	{ value: 'reqps', label: 'Requests/second' }
] as const;

function autoDecimals(value: number): number {
	const abs = Math.abs(value);
	if (abs === 0 || abs >= 100) return 0;
	if (abs >= 10) return 1;
	if (abs >= 1) return 2;
	return 3;
}

function fixed(value: number, decimals: number | null): string {
	const digits = decimals ?? autoDecimals(value);
	const text = value.toFixed(digits);
	// Auto decimals drop trailing zeros: 1.50 → 1.5, 2.00 → 2.
	return decimals === null && text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function scaled(
	value: number,
	base: number,
	units: string[],
	decimals: number | null,
	sep = ''
): string {
	let index = 0;
	let current = value;
	while (Math.abs(current) >= base && index < units.length - 1) {
		current /= base;
		index++;
	}
	return `${fixed(current, decimals)}${sep}${units[index]}`;
}

const grouped = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });

function duration(ms: number, decimals: number | null): string {
	const abs = Math.abs(ms);
	if (abs === 0) return '0 ms';
	if (abs < 1) return `${fixed(ms * 1000, decimals)} µs`;
	if (abs < 1_000) return `${fixed(ms, decimals)} ms`;
	if (abs < 60_000) return `${fixed(ms / 1_000, decimals)} s`;
	if (abs < 3_600_000) return `${fixed(ms / 60_000, decimals)} min`;
	if (abs < 86_400_000) return `${fixed(ms / 3_600_000, decimals)} h`;
	return `${fixed(ms / 86_400_000, decimals)} d`;
}

/** A value in a unit, e.g. `1.2K`, `3.4 MiB`, `120 ms`, `12.5%`. Null/NaN show as a dash. */
export function formatValue(
	value: number | null | undefined,
	unit: string | undefined = 'short',
	decimals: number | null = null
): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	switch (unit) {
		case 'none':
			return decimals === null ? grouped.format(value) : value.toFixed(decimals);
		case 'bytes':
			return scaled(value, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], decimals, ' ');
		case 'bytesps':
			return `${scaled(value, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB'], decimals, ' ')}/s`;
		case 'ms':
			return duration(value, decimals);
		case 's':
			return duration(value * 1_000, decimals);
		case 'percent':
			return `${fixed(value, decimals)}%`;
		case 'percentunit':
			return `${fixed(value * 100, decimals)}%`;
		case 'reqps':
			return `${scaled(value, 1000, ['', 'K', 'M', 'B'], decimals)} req/s`;
		case 'short':
		default:
			return scaled(value, 1000, ['', 'K', 'M', 'B', 'T'], decimals);
	}
}

// --- colours --------------------------------------------------------------------------------

/** Named colours for thresholds and overrides (Grafana-style names), as CSS. */
export const NAMED_COLORS: Record<string, string> = {
	green: 'var(--color-success)',
	yellow: 'oklch(0.82 0.16 90)',
	orange: 'var(--color-warning)',
	red: 'var(--color-destructive)',
	blue: 'var(--color-info)',
	purple: 'oklch(0.62 0.2 300)',
	brand: 'var(--color-brand)',
	text: 'var(--color-foreground)',
	muted: 'var(--color-muted-foreground)'
};

export const THRESHOLD_SWATCHES = ['green', 'yellow', 'orange', 'red', 'blue', 'purple', 'text'];

/** A named colour, a `#hex`/`oklch()` value, or a fallback. */
export function cssColor(
	color: string | null | undefined,
	fallback = 'var(--color-chart-1)'
): string {
	if (!color) return fallback;
	const named = NAMED_COLORS[color];
	if (named) return named;
	return /^(#[0-9a-f]{3,8}|oklch\([^)]*\)|rgb\([^)]*\)|hsl\([^)]*\)|var\(--[a-z0-9-]+\))$/i.test(
		color
	)
		? color
		: fallback;
}

/** Series colours, in order: the theme's five chart tokens, then extra fixed hues. */
export const PALETTE = [
	'var(--color-chart-1)',
	'var(--color-chart-2)',
	'var(--color-chart-4)',
	'var(--color-chart-3)',
	'var(--color-chart-5)',
	'oklch(0.65 0.15 250)',
	'oklch(0.7 0.15 140)',
	'oklch(0.62 0.2 330)',
	'oklch(0.72 0.12 200)',
	'oklch(0.6 0.12 30)'
];

export function seriesColor(
	index: number,
	name?: string,
	overrides?: Record<string, string>
): string {
	const override = name ? overrides?.[name] : undefined;
	return override ? cssColor(override) : PALETTE[index % PALETTE.length]!;
}

export interface Threshold {
	value: number | null;
	color: string;
}

/** The colour of the highest threshold at or below the value (the base step has no value). */
export function thresholdColor(
	value: number | null | undefined,
	thresholds: Threshold[] | undefined
): string | null {
	if (!thresholds || thresholds.length === 0) return null;
	const sorted = sortThresholds(thresholds);
	let color = sorted[0]!.color;
	if (value === null || value === undefined || !Number.isFinite(value)) return cssColor(color);
	for (const step of sorted) {
		if (step.value === null || value >= step.value) color = step.color;
	}
	return cssColor(color);
}

/** Base step (null) first, then ascending values. */
export function sortThresholds(thresholds: Threshold[]): Threshold[] {
	return [...thresholds].sort((a, b) => {
		if (a.value === null) return -1;
		if (b.value === null) return 1;
		return a.value - b.value;
	});
}
