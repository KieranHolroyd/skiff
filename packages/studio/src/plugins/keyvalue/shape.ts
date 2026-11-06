/**
 * Turns a RESP3 reply (as Bun's RedisClient decodes it) into a result table, so `run` output
 * uses the same grid as every other engine:
 *
 * - a scalar or nil is one row in a `value` column;
 * - an array is `index`, `value`;
 * - a map (a null-prototype object from Bun) is `field`, `value`;
 * - nested arrays and maps become `json` cells;
 * - a SCAN-family reply `[cursor, items]` lists the items (pairs for HSCAN/ZSCAN) and reports
 *   the next cursor as a notice, the way redis-cli prints it, instead of a two-row table.
 */
import { bigintCell, bytesCell, jsonCell, textCell } from '../../cells.ts';
import type { Cell, CellKind, Column, StudioEvent } from '../../protocol.ts';

export interface ShapedReply {
	columns: Column[];
	rows: Cell[][];
	notice?: Extract<StudioEvent, { t: 'notice' }>;
}

export function shapeReply(argv: readonly string[], reply: unknown, previewBytes?: number): ShapedReply {
	const name = (argv[0] ?? '').toUpperCase();
	const bare = argv.some((a) => ['NOVALUES', 'NOSCORES'].includes(a.toUpperCase()));
	const scan = scanReply(name, bare, reply, previewBytes);
	if (scan) return scan;
	if (Array.isArray(reply)) {
		const rows = reply.map((item, index): Cell[] => [index, replyCell(item, previewBytes)]);
		return { columns: [column('index', 'integer', 'number'), valueColumn(rows, 1)], rows };
	}
	if (isMap(reply)) {
		const rows = Object.entries(reply).map(([field, value]): Cell[] => [field, replyCell(value, previewBytes)]);
		return { columns: [column('field', 'string', 'text'), valueColumn(rows, 1)], rows };
	}
	const rows = [[replyCell(reply, previewBytes)]];
	return { columns: [valueColumn(rows, 0)], rows };
}

function scanReply(name: string, bare: boolean, reply: unknown, previewBytes?: number): ShapedReply | null {
	if (!['SCAN', 'SSCAN', 'HSCAN', 'ZSCAN'].includes(name)) return null;
	if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) return null;
	const cursor = String(reply[0]);
	const items = reply[1] as unknown[];
	const notice: ShapedReply['notice'] = {
		t: 'notice',
		level: 'info',
		message: cursor === '0' ? 'The scan is complete (cursor 0).' : `Next cursor: ${cursor}`,
	};
	if ((name === 'HSCAN' || name === 'ZSCAN') && !bare) {
		const rows: Cell[][] = [];
		for (let i = 0; i + 1 < items.length; i += 2)
			rows.push([replyCell(items[i], previewBytes), replyCell(items[i + 1], previewBytes)]);
		const second = name === 'HSCAN' ? column('value', 'string', 'text') : column('score', 'double', 'number');
		const first = column(name === 'HSCAN' ? 'field' : 'member', 'string', 'text');
		return { columns: [first, second], rows, notice };
	}
	const rows = items.map((item, index): Cell[] => [index, replyCell(item, previewBytes)]);
	return {
		columns: [
			column('index', 'integer', 'number'),
			column(name === 'SCAN' ? 'key' : name === 'HSCAN' ? 'field' : 'member', 'string', 'text'),
		],
		rows,
		notice,
	};
}

/** One reply element as a cell. Scores and doubles stay numbers; big integers stay exact. */
export function replyCell(value: unknown, previewBytes?: number): Cell {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case 'string':
			return textCell(value, previewBytes);
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'bigint':
			return bigintCell(value);
		case 'boolean':
			return value;
		default:
			break;
	}
	if (value instanceof Uint8Array) return bytesCell(value, previewBytes);
	if (value instanceof Error) return jsonCell({ error: value.message });
	return jsonCell(jsonSafe(value), previewBytes);
}

/** A JSON-serialisable copy: bigints as strings, bytes as base64, maps as plain objects. */
export function jsonSafe(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
	if (typeof value !== 'object') return value;
	if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
	if (value instanceof Error) return { error: value.message };
	if (Array.isArray(value)) return value.map(jsonSafe);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
	return out;
}

/** Bun decodes a RESP3 map as an object with a null prototype; arrays and bytes are not maps. */
function isMap(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function column(name: string, nativeType: string, kind: CellKind): Column {
	return { name, nativeType, kind, nullable: true, editable: false };
}

/** The value column's kind is uniform when every cell agrees, otherwise `unknown`. */
function valueColumn(rows: Cell[][], index: number): Column {
	const kinds = new Set<CellKind>();
	for (const row of rows) {
		const cell = row[index] ?? null;
		if (cell === null) continue;
		kinds.add(cellKind(cell));
	}
	const kind = kinds.size === 1 ? ([...kinds][0] ?? 'unknown') : 'unknown';
	return column('value', 'reply', kind);
}

function cellKind(cell: Cell): CellKind {
	if (typeof cell === 'string') return 'text';
	if (typeof cell === 'number') return 'number';
	if (typeof cell === 'boolean') return 'boolean';
	if (Array.isArray(cell)) return 'array';
	if (cell === null) return 'unknown';
	switch (cell.$t) {
		case 'truncated':
			return 'text';
		case 'bigint':
			return 'bigint';
		case 'bytes':
			return 'bytes';
		case 'json':
			return 'json';
		default:
			return 'unknown';
	}
}
