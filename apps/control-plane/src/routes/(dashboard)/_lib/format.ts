/**
 * Small presentation helpers shared by the dashboard routes.
 *
 * Timestamps are formatted in UTC so the server-rendered markup and the hydrated client
 * always agree (Intl defaults to the machine's local zone, which can differ).
 */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
	dateStyle: 'medium',
	timeStyle: 'short',
	timeZone: 'UTC'
});

const shortDateFormatter = new Intl.DateTimeFormat('en-GB', {
	day: '2-digit',
	month: 'short',
	year: 'numeric',
	timeZone: 'UTC'
});

export function formatDateTime(value: string | number | Date | null | undefined): string {
	const date = toDate(value);
	if (!date) return '—';
	return `${dateFormatter.format(date)} UTC`;
}

export function formatDate(value: string | number | Date | null | undefined): string {
	const date = toDate(value);
	if (!date) return '—';
	return shortDateFormatter.format(date);
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
	if (bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	const precision = value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(precision)} ${units[exponent]}`;
}

export function shortId(value: string | null | undefined, length = 8): string {
	if (!value) return '—';
	return value.length > length ? value.slice(0, length) : value;
}

export function shortSha(value: string | null | undefined, length = 10): string {
	if (!value) return '—';
	return value.slice(0, length);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === '') return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
