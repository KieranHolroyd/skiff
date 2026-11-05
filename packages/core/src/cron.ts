import { ValidationError } from './errors.ts';

/**
 * Minimal five-field cron parser for backup schedules. Supports wildcard, fixed values, ranges,
 * step values and comma lists. Times are UTC, matching every other timestamp Skiff stores.
 * We deliberately do not accept names (`MON`), seconds or macros: the contract already restricts
 * the characters, and a small parser is easier to reason about than a library.
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

export function parseCron(expression: string): CronFields {
	const cached = cache.get(expression);
	if (cached) return cached;
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5)
		throw new ValidationError('Use a five-field cron expression (minute hour day month weekday).');
	const fields: CronFields = {
		minutes: parseField(parts[0]!, LIMITS[0]!),
		hours: parseField(parts[1]!, LIMITS[1]!),
		days: parseField(parts[2]!, LIMITS[2]!),
		months: parseField(parts[3]!, LIMITS[3]!),
		weekdays: parseField(parts[4]!, LIMITS[4]!),
	};
	cache.set(expression, fields);
	return fields;
}

function parseField(raw: string, limit: { name: string; min: number; max: number }): Set<number> {
	if (!raw) throw invalid(limit);
	const values = new Set<number>();
	for (const part of raw.split(',')) {
		if (!part) throw invalid(limit);
		const [range, stepRaw] = part.split('/');
		if (stepRaw !== undefined && (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1))
			throw invalid(limit);
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		let start: number;
		let end: number;
		if (range === '*') {
			start = limit.min;
			end = limit.max;
		} else if (range?.includes('-')) {
			const [a, b] = range.split('-');
			if (!isNumber(a) || !isNumber(b)) throw invalid(limit);
			start = Number(a);
			end = Number(b);
		} else {
			if (!isNumber(range)) throw invalid(limit);
			start = Number(range);
			end = stepRaw === undefined ? start : limit.max;
		}
		if (start < limit.min || end > limit.max || start > end) throw invalid(limit);
		for (let value = start; value <= end; value += step) values.add(value);
	}
	if (values.size === 0) throw invalid(limit);
	return values;
}

function isNumber(value: string | undefined): boolean {
	return value !== undefined && /^\d+$/.test(value);
}

function invalid(limit: { name: string; min: number; max: number }): ValidationError {
	return new ValidationError(`Cron ${limit.name} must be between ${limit.min} and ${limit.max}.`);
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
