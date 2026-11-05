import { ValidationError } from '@skiff/core';

/**
 * Query parameters for `GET /api/v1/databases/:name/metrics` (docs/DATABASES.md §5).
 *
 * Defaults to the last hour at 1-minute buckets. Without an explicit `interval`, ranges longer
 * than 48 hours use hourly rollups, which is what the DuckDB store keeps past two days. An
 * explicit `1m` over more than 48 hours is rejected rather than silently returning a partial
 * series.
 */

export type DatabaseMetricsInterval = '1m' | '1h';

export interface DatabaseMetricsRange {
	from: Date;
	to: Date;
	interval: DatabaseMetricsInterval;
}

const HOUR_MS = 3_600_000;
/** 1-minute rows are retained for 48 h. */
export const MINUTE_BUCKET_MAX_MS = 48 * HOUR_MS;
/** Hourly rollups are retained for 90 days; allow a little slack for alignment. */
export const RANGE_MAX_MS = 92 * 24 * HOUR_MS;

function parseTime(raw: string, name: string): Date {
	const trimmed = raw.trim();
	const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
	if (!Number.isFinite(ms))
		throw new ValidationError(`\`${name}\` must be an ISO timestamp or epoch milliseconds.`);
	return new Date(ms);
}

export function parseDatabaseMetricsRange(
	params: URLSearchParams,
	now = Date.now()
): DatabaseMetricsRange {
	const rawFrom = params.get('from');
	const rawTo = params.get('to');
	const rawInterval = params.get('interval');
	if (rawInterval !== null && rawInterval !== '1m' && rawInterval !== '1h')
		throw new ValidationError('`interval` must be 1m or 1h.');

	const to = rawTo ? parseTime(rawTo, 'to') : new Date(now);
	const from = rawFrom ? parseTime(rawFrom, 'from') : new Date(to.getTime() - HOUR_MS);
	const span = to.getTime() - from.getTime();
	if (span <= 0) throw new ValidationError('`from` must be before `to`.');
	if (span > RANGE_MAX_MS) throw new ValidationError('The range can cover at most 92 days.');

	const interval: DatabaseMetricsInterval =
		rawInterval ?? (span > MINUTE_BUCKET_MAX_MS ? '1h' : '1m');
	if (interval === '1m' && span > MINUTE_BUCKET_MAX_MS)
		throw new ValidationError(
			'1-minute buckets cover at most 48 hours; use interval=1h or a shorter range.'
		);
	return { from, to, interval };
}
