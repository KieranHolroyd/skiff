/**
 * Lossless, JSON-safe cell encoding shared by every plugin. A cell is a plain JSON value when
 * that is lossless, otherwise a tagged `{ $t, v }`. Large values are cut to a preview and marked
 * `truncated`; the UI loads the full value through the `value` op.
 */
import type { Cell, TaggedCell } from './protocol.ts';

/** Strings and bytes above this are sent as a `truncated` preview. */
export const CELL_PREVIEW_BYTES = 64 * 1_024;

const encoder = new TextEncoder();

export function isTagged(cell: Cell): cell is TaggedCell {
	return typeof cell === 'object' && cell !== null && !Array.isArray(cell) && '$t' in cell;
}

export function textCell(value: string, limit = CELL_PREVIEW_BYTES): Cell {
	const bytes = encoder.encode(value).byteLength;
	if (bytes <= limit) return value;
	return { $t: 'truncated', v: cutUtf8(value, limit), bytes };
}

/** Integers outside the double-safe range travel as strings. */
export function bigintCell(value: bigint | number | string): Cell {
	if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
	const big = typeof value === 'bigint' ? value : BigInt(value);
	if (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(big);
	return { $t: 'bigint', v: big.toString() };
}

/** Arbitrary-precision decimals are always strings, never doubles. */
export function decimalCell(value: string | number): Cell {
	return { $t: 'decimal', v: String(value) };
}

export function bytesCell(value: Uint8Array, limit = CELL_PREVIEW_BYTES): Cell {
	if (value.byteLength <= limit) return { $t: 'bytes', v: Buffer.from(value).toString('base64') };
	return {
		$t: 'truncated',
		v: Buffer.from(value.subarray(0, Math.min(limit, 256))).toString('base64'),
		bytes: value.byteLength,
	};
}

/** `Date` → ISO 8601 with milliseconds. Invalid dates (e.g. MySQL zero dates) stay as text. */
export function datetimeCell(value: Date | string): Cell {
	if (typeof value === 'string') return { $t: 'datetime', v: value };
	if (Number.isNaN(value.getTime())) return null;
	return { $t: 'datetime', v: value.toISOString() };
}

export function dateCell(value: string): Cell {
	return { $t: 'date', v: value };
}

/** JSON documents keep their structure; large ones become a text preview. */
export function jsonCell(value: unknown, limit = CELL_PREVIEW_BYTES): Cell {
	const text = JSON.stringify(value) ?? 'null';
	const bytes = encoder.encode(text).byteLength;
	if (bytes <= limit) return { $t: 'json', v: value };
	return { $t: 'truncated', v: cutUtf8(text, limit), bytes };
}

/** Canonical EJSON (MongoDB): the plugin serialises, this only tags and bounds it. */
export function ejsonCell(canonical: unknown, limit = CELL_PREVIEW_BYTES): Cell {
	const text = JSON.stringify(canonical) ?? 'null';
	const bytes = encoder.encode(text).byteLength;
	if (bytes <= limit) return { $t: 'ejson', v: canonical };
	return { $t: 'truncated', v: cutUtf8(text, limit), bytes };
}

/** Best-effort generic encoding for values a plugin did not map explicitly. */
export function anyCell(value: unknown): Cell {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : { $t: 'decimal', v: String(value) };
		case 'bigint':
			return bigintCell(value);
		case 'string':
			return textCell(value);
		default:
			break;
	}
	if (value instanceof Date) return datetimeCell(value);
	if (value instanceof Uint8Array) return bytesCell(value);
	if (Array.isArray(value)) return value.map(anyCell);
	return jsonCell(value);
}

/** Decode a cell from the UI into the JS value a driver binds as a parameter. */
export function cellToParam(cell: Cell): unknown {
	if (cell === null || typeof cell !== 'object') return cell;
	if (Array.isArray(cell)) return cell.map(cellToParam);
	switch (cell.$t) {
		case 'bigint':
			return BigInt(String(cell.v));
		case 'decimal':
		case 'date':
		case 'datetime':
			return String(cell.v);
		case 'bytes':
			return Buffer.from(String(cell.v), 'base64');
		case 'json':
		case 'ejson':
			return cell.v;
		case 'truncated':
			throw new Error('A truncated preview cannot be written back; load the full value first.');
	}
}

/** Approximate encoded size of an event, used for `maxBytes`. */
export function encodedBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function cutUtf8(value: string, limit: number): string {
	// Cut on a UTF-8 code point boundary at or below `limit` bytes.
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= limit) return value;
	let end = limit;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(bytes.subarray(0, end));
}
