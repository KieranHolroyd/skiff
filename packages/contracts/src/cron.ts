/**
 * Minimal five-field cron parser, shared by backup schedules, the job scheduler and Functions
 * triggers (docs/FUNCTIONS.md §4.10). Supports wildcard, fixed values, ranges, step values and
 * comma lists. Times are UTC, matching every other timestamp Skiff stores.
 *
 * We deliberately do not accept names (`MON`), seconds or macros: the contract already restricts
 * the characters, and a small parser is easier to reason about than a library. The module has no
 * imports at all, so it can run on the agent, in the control plane and in a test alike.
 *
 * Contracts has no `ValidationError`, so the public functions throw a plain `Error` carrying the
 * user-facing message. `@skiff/core` wraps the parser with `parseCronWith` to keep raising its own
 * `ValidationError` with exactly those messages.
 */
export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
}

const LIMITS: ReadonlyArray<{ name: string; min: number; max: number }> = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12 },
	{ name: 'weekday', min: 0, max: 6 },
];

const cache = new Map<string, CronFields>();

/** Parse a five-field expression. Throws a plain `Error` with a user-facing message. */
export function parseCron(expression: string): CronFields {
	return parseCronWith(expression, (message) => new Error(message));
}

/**
 * Parse with a caller-supplied error factory, so a package with its own validation error type can
 * raise that type without duplicating the parser (or its messages).
 */
export function parseCronWith(
	expression: string,
	error: (message: string) => Error,
): CronFields {
	const cached = cache.get(expression);
	if (cached) return cached;
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5)
		throw error('Use a five-field cron expression (minute hour day month weekday).');
	const fields: CronFields = {
		minutes: parseField(parts[0]!, LIMITS[0]!, error),
		hours: parseField(parts[1]!, LIMITS[1]!, error),
		days: parseField(parts[2]!, LIMITS[2]!, error),
		months: parseField(parts[3]!, LIMITS[3]!, error),
		weekdays: parseField(parts[4]!, LIMITS[4]!, error),
	};
	cache.set(expression, fields);
	return fields;
}

function parseField(
	raw: string,
	limit: { name: string; min: number; max: number },
	error: (message: string) => Error,
): Set<number> {
	if (!raw) throw invalid(limit, error);
	const values = new Set<number>();
	for (const part of raw.split(',')) {
		if (!part) throw invalid(limit, error);
		const [range, stepRaw] = part.split('/');
		if (stepRaw !== undefined && (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1))
			throw invalid(limit, error);
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		let start: number;
		let end: number;
		if (range === '*') {
			start = limit.min;
			end = limit.max;
		} else if (range?.includes('-')) {
			const [a, b] = range.split('-');
			if (!isNumber(a) || !isNumber(b)) throw invalid(limit, error);
			start = Number(a);
			end = Number(b);
		} else {
			if (!isNumber(range)) throw invalid(limit, error);
			start = Number(range);
			end = stepRaw === undefined ? start : limit.max;
		}
		if (start < limit.min || end > limit.max || start > end) throw invalid(limit, error);
		for (let value = start; value <= end; value += step) values.add(value);
	}
	if (values.size === 0) throw invalid(limit, error);
	return values;
}

function isNumber(value: string | undefined): boolean {
	return value !== undefined && /^\d+$/.test(value);
}

function invalid(
	limit: { name: string; min: number; max: number },
	error: (message: string) => Error,
): Error {
	return error(`Cron ${limit.name} must be between ${limit.min} and ${limit.max}.`);
}

/** True when `date` (UTC) matches the expression. */
export function cronMatches(date: Date, expression: string): boolean {
	const fields = parseCron(expression);
	const weekday = date.getUTCDay();
	return (
		fields.minutes.has(date.getUTCMinutes()) &&
		fields.hours.has(date.getUTCHours()) &&
		fields.days.has(date.getUTCDate()) &&
		fields.months.has(date.getUTCMonth() + 1) &&
		fields.weekdays.has(weekday)
	);
}

/**
 * Next matching minute strictly after `from` (epoch ms), or null when the expression cannot match
 * within a year (for example 31 February). A year is enough for every practical schedule; a
 * schedule that never fires is rejected by the caller rather than silently never running.
 */
export function nextCronTime(expression: string, from: number): number | null {
	parseCron(expression);
	const start = Math.floor(from / 60_000) * 60_000 + 60_000;
	const limit = start + 366 * 86_400_000;
	for (let time = start; time <= limit; time += 60_000) {
		if (cronMatches(new Date(time), expression)) return time;
	}
	return null;
}
