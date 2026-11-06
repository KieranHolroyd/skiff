import type { Cell, CellTag, Column, TaggedCell } from '@skiff/studio/protocol';

/**
 * How the studio grid shows, copies and compares cells (plan 22). Pure, so the grid's rules are
 * unit-tested without a DOM.
 */
export type CellView =
	| { kind: 'null' }
	| { kind: 'plain'; text: string }
	| { kind: 'tagged'; tag: Exclude<CellTag, 'truncated'>; text: string }
	| { kind: 'truncated'; text: string; bytes: number | null };

const byteFormat = new Intl.NumberFormat('en-GB');

export function isTagged(cell: Cell): cell is TaggedCell {
	return typeof cell === 'object' && cell !== null && !Array.isArray(cell) && '$t' in cell;
}

export function isTruncated(cell: Cell): boolean {
	return isTagged(cell) && cell.$t === 'truncated';
}

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
	if (Array.isArray(cell)) return { kind: 'plain', text: asText(cell.map(cellValue)) };
	if (cell.$t === 'truncated')
		return { kind: 'truncated', text: asText(cell.v), bytes: cell.bytes ?? null };
	return { kind: 'tagged', tag: cell.$t, text: asText(cell.v) };
}

/** "… 12,345 bytes" after a truncated preview. */
export function truncatedSuffix(bytes: number | null): string {
	return bytes === null ? '…' : `… ${byteFormat.format(bytes)} bytes`;
}

/** The value a cell stands for, as plain JSON (tags dropped), for "copy row as JSON". */
export function cellValue(cell: Cell): unknown {
	if (cell === null || typeof cell !== 'object') return cell;
	if (Array.isArray(cell)) return cell.map(cellValue);
	return cell.v;
}

/** Text put on the clipboard for one cell. NULL copies as an empty string. */
export function cellClipboardText(cell: Cell): string {
	if (cell === null) return '';
	if (typeof cell === 'string') return cell;
	if (typeof cell !== 'object') return String(cell);
	if (Array.isArray(cell)) return JSON.stringify(cell.map(cellValue));
	if (typeof cell.v === 'string') return cell.v;
	return asText(cell.v);
}

/** Whether a cell is best read as a JSON document (inspector pretty-print). */
export function isStructured(cell: Cell, column?: Column): boolean {
	if (Array.isArray(cell)) return true;
	if (isTagged(cell)) return cell.$t === 'json' || cell.$t === 'ejson';
	return column?.kind === 'json' || column?.kind === 'document';
}

/** The inspector's long form: JSON documents pretty-printed, everything else as text. */
export function cellPretty(cell: Cell, column?: Column): string {
	if (cell === null) return 'NULL';
	if (isStructured(cell, column)) {
		const value = cellValue(cell);
		if (typeof value === 'string') {
			try {
				return JSON.stringify(JSON.parse(value), null, 2);
			} catch {
				return value;
			}
		}
		return JSON.stringify(value, null, 2) ?? '';
	}
	return cellClipboardText(cell);
}

/** One row as a `{ column: value }` JSON document (tags dropped). */
export function rowJson(columns: Column[], row: Cell[]): string {
	const record: Record<string, unknown> = {};
	columns.forEach((column, index) => {
		record[column.name] = cellValue(row[index] ?? null);
	});
	return JSON.stringify(record, null, 2);
}

/** Structural equality of two cells (tags included), for "did this edit change anything". */
export function cellsEqual(a: Cell, b: Cell): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, inner]) => inner !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(',')}}`;
}

/** Whether `value` is a valid `Cell` (objects must be tagged). */
export function isCell(value: unknown): value is Cell {
	if (value === null) return true;
	switch (typeof value) {
		case 'boolean':
		case 'string':
			return true;
		case 'number':
			return Number.isFinite(value);
		case 'object':
			if (Array.isArray(value)) return value.every(isCell);
			return typeof (value as { $t?: unknown }).$t === 'string';
		default:
			return false;
	}
}

/** Default column width in pixels, by kind. */
export function defaultWidth(column: Column): number {
	switch (column.kind) {
		case 'boolean':
			return 96;
		case 'number':
		case 'bigint':
		case 'decimal':
		case 'date':
		case 'time':
			return 128;
		case 'uuid':
		case 'objectid':
		case 'datetime':
			return 232;
		case 'json':
		case 'document':
		case 'array':
			return 280;
		default:
			return 192;
	}
}

/** Numbers right-align in the grid. */
export function isNumeric(column: Column): boolean {
	return column.kind === 'number' || column.kind === 'bigint' || column.kind === 'decimal';
}
