import type { Cell, CellTag } from '@skiff/studio/protocol';

/** How the skeleton grid shows one cell (plan 22). Phase 2's `StudioGrid` replaces this. */
export type CellView =
	| { kind: 'null' }
	| { kind: 'plain'; text: string }
	| { kind: 'tagged'; tag: Exclude<CellTag, 'truncated'>; text: string }
	| { kind: 'truncated'; text: string; bytes: number | null };

const byteFormat = new Intl.NumberFormat('en-GB');

function asText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function cellView(cell: Cell): CellView {
	if (cell === null) return { kind: 'null' };
	if (typeof cell === 'boolean' || typeof cell === 'number')
		return { kind: 'plain', text: String(cell) };
	if (typeof cell === 'string') return { kind: 'plain', text: cell };
	if (Array.isArray(cell)) return { kind: 'plain', text: asText(cell) };
	if (cell.$t === 'truncated')
		return { kind: 'truncated', text: asText(cell.v), bytes: cell.bytes ?? null };
	return { kind: 'tagged', tag: cell.$t, text: asText(cell.v) };
}

/** "… (12,345 bytes)" after a truncated preview. */
export function truncatedSuffix(bytes: number | null): string {
	return bytes === null ? '…' : `… (${byteFormat.format(bytes)} bytes)`;
}
