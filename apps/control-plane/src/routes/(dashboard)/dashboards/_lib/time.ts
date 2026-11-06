/**
 * Grafana-style time expressions: `now`, `now-6h`, `now-7d/d`, `now/w`, or an absolute ISO
 * timestamp (or epoch milliseconds). Rounding (`/d`) is in UTC, like every timestamp the
 * dashboard shows. `to` expressions round up to the end of the unit, `from` rounds down.
 */

export interface TimeRange {
	from: string;
	to: string;
}

export interface ResolvedRange {
	from: number;
	to: number;
}

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000
};

const UNIT_WORDS: Record<string, [string, string]> = {
	s: ['second', 'seconds'],
	m: ['minute', 'minutes'],
	h: ['hour', 'hours'],
	d: ['day', 'days'],
	w: ['week', 'weeks'],
	M: ['month', 'months'],
	y: ['year', 'years']
};

export function isRelative(expr: string): boolean {
	return expr.trim().startsWith('now');
}

function addUnit(date: Date, amount: number, unit: string): void {
	if (unit === 'M') date.setUTCMonth(date.getUTCMonth() + amount);
	else if (unit === 'y') date.setUTCFullYear(date.getUTCFullYear() + amount);
	else date.setTime(date.getTime() + amount * UNIT_MS[unit]!);
}

function startOf(date: Date, unit: string): void {
	switch (unit) {
		case 'y':
			date.setUTCMonth(0, 1);
			date.setUTCHours(0, 0, 0, 0);
			return;
		case 'M':
			date.setUTCDate(1);
			date.setUTCHours(0, 0, 0, 0);
			return;
		case 'w': {
			// ISO weeks start on Monday.
			const day = (date.getUTCDay() + 6) % 7;
			date.setUTCDate(date.getUTCDate() - day);
			date.setUTCHours(0, 0, 0, 0);
			return;
		}
		case 'd':
			date.setUTCHours(0, 0, 0, 0);
			return;
		case 'h':
			date.setUTCMinutes(0, 0, 0);
			return;
		case 'm':
			date.setUTCSeconds(0, 0);
			return;
		case 's':
			date.setUTCMilliseconds(0);
	}
}

/**
 * Epoch ms for an expression, or null when it does not parse. `roundUp` makes `/d` mean the
 * last millisecond of the day (for the end of a range).
 */
export function parseTime(expr: string, now: number, roundUp = false): number | null {
	const text = expr.trim();
	if (!text) return null;
	if (text.startsWith('now')) {
		const date = new Date(now);
		let rest = text.slice(3);
		const pattern = /^([+-])(\d+)([smhdwMy])|^\/([smhdwMy])/;
		while (rest.length > 0) {
			const match = pattern.exec(rest);
			if (!match) return null;
			if (match[4]) {
				startOf(date, match[4]);
				if (roundUp) {
					addUnit(date, 1, match[4]);
					date.setTime(date.getTime() - 1);
				}
			} else {
				const amount = Number(match[2]) * (match[1] === '-' ? -1 : 1);
				addUnit(date, amount, match[3]!);
			}
			rest = rest.slice(match[0].length);
		}
		return date.getTime();
	}
	if (/^\d{10,}$/.test(text)) return Number(text);
	// `2026-11-06 12:00` style without a zone reads as UTC.
	const iso = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)
		? `${text.replace(' ', 'T')}${text.length > 10 ? 'Z' : 'T00:00:00Z'}`
		: text;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

/** Both ends in epoch ms, or null when either end does not parse or `from` is not before `to`. */
export function resolveRange(range: TimeRange, now: number): ResolvedRange | null {
	const from = parseTime(range.from, now, false);
	const to = parseTime(range.to, now, true);
	if (from === null || to === null || from >= to) return null;
	return { from, to };
}

export interface QuickRange extends TimeRange {
	label: string;
	/** Short form for the toolbar, e.g. `6h`. */
	short: string;
}

const quick = (amount: number, unit: string, short: string): QuickRange => ({
	from: `now-${amount}${unit}`,
	to: 'now',
	short,
	label: `Last ${amount} ${UNIT_WORDS[unit]![amount === 1 ? 0 : 1]}`
});

export const QUICK_RANGES: QuickRange[] = [
	quick(5, 'm', '5m'),
	quick(15, 'm', '15m'),
	quick(1, 'h', '1h'),
	quick(3, 'h', '3h'),
	quick(6, 'h', '6h'),
	quick(12, 'h', '12h'),
	quick(24, 'h', '24h'),
	quick(2, 'd', '2d'),
	quick(7, 'd', '7d'),
	quick(30, 'd', '30d'),
	quick(90, 'd', '90d')
];

export const CALENDAR_RANGES: QuickRange[] = [
	{ from: 'now/d', to: 'now/d', label: 'Today', short: 'today' },
	{ from: 'now-1d/d', to: 'now-1d/d', label: 'Yesterday', short: 'yesterday' },
	{ from: 'now/w', to: 'now/w', label: 'This week', short: 'this week' },
	{ from: 'now/M', to: 'now/M', label: 'This month', short: 'this month' }
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `01 Nov 14:30` (UTC). */
function shortAbsolute(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `2026-11-06 12:30:00` in UTC, for the custom range inputs. */
export function formatInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function describeRelative(expr: string): string | null {
	const match = /^now-(\d+)([smhdwMy])$/.exec(expr.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	return `Last ${amount} ${UNIT_WORDS[match[2]!]![amount === 1 ? 0 : 1]}`;
}

/** Human label for a range: a quick range's name, `Last 4 hours`, or two absolute times. */
export function rangeLabel(range: TimeRange, now: number): string {
	const known = [...QUICK_RANGES, ...CALENDAR_RANGES].find(
		(item) => item.from === range.from && item.to === range.to
	);
	if (known) return known.label;
	if (range.to === 'now') {
		const relative = describeRelative(range.from);
		if (relative) return relative;
	}
	const resolved = resolveRange(range, now);
	if (!resolved) return `${range.from} to ${range.to}`;
	const show = (expr: string, ms: number) => (isRelative(expr) ? expr : shortAbsolute(ms));
	return `${show(range.from, resolved.from)} to ${show(range.to, resolved.to)}`;
}

/** An absolute range as ISO strings. */
export function absolute(from: number, to: number): TimeRange {
	return {
		from: new Date(Math.round(from)).toISOString(),
		to: new Date(Math.round(to)).toISOString()
	};
}

/** Double the span around its centre (a relative `now-N` range stays relative). */
export function zoomOut(range: TimeRange, now: number): TimeRange {
	const match = /^now-(\d+)([smhdwMy])$/.exec(range.from.trim());
	if (match && range.to === 'now')
		return { from: `now-${Number(match[1]) * 2}${match[2]}`, to: 'now' };
	const resolved = resolveRange(range, now);
	if (!resolved) return range;
	const span = resolved.to - resolved.from;
	const to = Math.min(now, resolved.to + span / 2);
	return absolute(to - span * 2, to);
}

/** Move the range by half its span; never past now. */
export function shiftRange(range: TimeRange, direction: -1 | 1, now: number): TimeRange {
	const resolved = resolveRange(range, now);
	if (!resolved) return range;
	const span = resolved.to - resolved.from;
	let to = resolved.to + (direction * span) / 2;
	if (to > now) to = now;
	return absolute(to - span, to);
}

/** `10s`, `5m`, `1h`, `1d` → milliseconds; null for anything else (and for off). */
export function parseDuration(value: string | null | undefined): number | null {
	if (!value) return null;
	const match = /^(\d+)([smhd])$/.exec(value.trim());
	if (!match) return null;
	const ms = Number(match[1]) * UNIT_MS[match[2]!]!;
	return ms > 0 ? ms : null;
}

export const REFRESH_OPTIONS = ['10s', '30s', '1m', '5m', '15m', '1h'] as const;

/** Readable bucket width: `1m`, `5m`, `1h`, `1d`, or seconds. */
export function formatInterval(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '';
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/** Axis/tooltip time labels; long ranges also show the date. */
export function timeFormatter(spanMs: number): Intl.DateTimeFormat {
	const long = spanMs > 36 * 3_600_000;
	return new Intl.DateTimeFormat('en-GB', {
		hour: long && spanMs > 20 * 86_400_000 ? undefined : '2-digit',
		minute: long && spanMs > 20 * 86_400_000 ? undefined : '2-digit',
		day: long ? '2-digit' : undefined,
		month: long ? 'short' : undefined,
		timeZone: 'UTC'
	});
}

const tooltipFormat = new Intl.DateTimeFormat('en-GB', {
	day: '2-digit',
	month: 'short',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	timeZone: 'UTC'
});

export function formatTimestamp(ms: number): string {
	return `${tooltipFormat.format(ms)} UTC`;
}
