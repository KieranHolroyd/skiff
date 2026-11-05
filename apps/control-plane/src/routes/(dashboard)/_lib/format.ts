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

/** Compact duration such as `3d 4h` or `12m`, for uptimes. */
export function formatDuration(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${Math.floor(totalSeconds)}s`;
}

/**
 * "just now", "12m ago", "3h ago", "2d ago"; older than a week falls back to the date. Coarse on
 * purpose so the server render and the hydrated page rarely disagree.
 */
export function formatRelative(value: string | number | Date | null | undefined): string {
	const date = toDate(value);
	if (!date) return '—';
	const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
	if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
	return formatDate(date);
}

/** Strip the scheme so hostnames read cleanly in tables. */
export function displayUrl(url: string): string {
	return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
