/**
 * TTL and size formatting for the key-value workspace. The plugin reports TTLs in milliseconds
 * (`PTTL`), with `null` for "no expiry" in browse rows; Redis itself answers -1 for that and -2
 * for a missing key, so both spellings are handled.
 */

const UNITS: Array<[string, number]> = [
	['d', 86_400_000],
	['h', 3_600_000],
	['m', 60_000],
	['s', 1_000],
];

/** "No expiry", "Expired", "850ms", "45s", "12m 5s", "3h 20m", "2d 4h". */
export function formatTtl(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || ms === -1) return 'No expiry';
	if (ms === -2) return 'Expired';
	if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const parts: string[] = [];
	let rest = Math.floor(ms / 1_000) * 1_000;
	for (const [unit, size] of UNITS) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${unit}`);
			rest %= size;
		}
		if (parts.length === 2) break;
	}
	// Two units are enough to read at a glance ("3h 20m", not "3h 20m 12s").
	return parts.join(' ');
}

/** A TTL cell from a browse row (`ttl` column: milliseconds, or null for no expiry). */
export function ttlFromCell(cell: unknown): number | null {
	if (typeof cell === 'number') return cell < 0 ? null : cell;
	if (typeof cell === 'string' && /^\d+$/.test(cell)) return Number(cell);
	if (cell && typeof cell === 'object' && '$t' in cell && 'v' in cell) {
		const n = Number((cell as { v: unknown }).v);
		return Number.isFinite(n) && n >= 0 ? n : null;
	}
	return null;
}

export type ParsedTtl = { ok: true; ms: number | null } | { ok: false; error: string };

const PART = /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)?/gy;
const SUFFIX_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a TTL the user typed: empty means no expiry; a bare number is seconds; units combine
 * ("1h 30m", "90s", "1500ms", "2d").
 */
export function parseTtl(text: string): ParsedTtl {
	const trimmed = text.trim().toLowerCase();
	if (!trimmed) return { ok: true, ms: null };
	let total = 0;
	let index = 0;
	let matched = false;
	while (index < trimmed.length) {
		while (trimmed[index] === ' ') index += 1;
		if (index >= trimmed.length) break;
		PART.lastIndex = index;
		const part = PART.exec(trimmed);
		if (!part) return { ok: false, error: 'Write a TTL like 30s, 5m, 1h 30m or 2d (a bare number is seconds).' };
		total += Number(part[1]) * SUFFIX_MS[part[2] ?? 's']!;
		index = PART.lastIndex;
		matched = true;
	}
	if (!matched) return { ok: false, error: 'Write a TTL like 30s, 5m, 1h 30m or 2d (a bare number is seconds).' };
	const ms = Math.round(total);
	if (!Number.isSafeInteger(ms) || ms <= 0) return { ok: false, error: 'A TTL must be above 0. Leave it empty for no expiry.' };
	return { ok: true, ms };
}

/** A TTL in the form `parseTtl` reads back, for prefilling an input ("1h 30m", "" for none). */
export function ttlInput(ms: number | null): string {
	if (ms === null || ms < 0) return '';
	if (ms < 1_000 || ms % 1_000 !== 0) return `${ms}ms`;
	const parts: string[] = [];
	let rest = ms;
	for (const [unit, size] of UNITS) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${unit}`);
			rest %= size;
		}
	}
	return parts.join(' ');
}

const bytesFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** "512 B", "4.2 KB", "1.5 MB". */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
	if (bytes < 1_024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1_024;
	let unit = 0;
	while (value >= 1_024 && unit < units.length - 1) {
		value /= 1_024;
		unit += 1;
	}
	return `${bytesFormat.format(value)} ${units[unit]}`;
}
