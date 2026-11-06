/**
 * Postgres type → `CellKind`, and value → `Cell` decoders. Bun.SQL already parses the common
 * types (int8/numeric as strings, bytea as Buffer, timestamps as Date, json as objects); a
 * decoder accepts both that and the text form, because browse casts timestamps to text to keep
 * their microseconds and the server sends unknown types as text.
 */
import {
	anyCell,
	bigintCell,
	bytesCell,
	CELL_PREVIEW_BYTES,
	dateCell,
	datetimeCell,
	decimalCell,
	jsonCell,
	textCell,
} from '../../cells.ts';
import type { Cell, CellKind } from '../../protocol.ts';

export interface PgTypeInfo {
	oid: number;
	/** `format_type(oid, NULL)`, e.g. `timestamp with time zone`, `integer[]`. */
	name: string;
	kind: CellKind;
	/** Element type for arrays. */
	elem?: number;
	/** timestamp without time zone (or a domain over it): cells carry no `Z`. */
	local?: boolean;
}

/** Built-in types by OID: [name, kind, element OID for arrays]. */
const BUILTIN: Record<number, [string, CellKind, number?]> = {
	16: ['boolean', 'boolean'],
	17: ['bytea', 'bytes'],
	18: ['"char"', 'text'],
	19: ['name', 'text'],
	20: ['bigint', 'bigint'],
	21: ['smallint', 'number'],
	23: ['integer', 'number'],
	24: ['regproc', 'text'],
	25: ['text', 'text'],
	26: ['oid', 'number'],
	27: ['tid', 'text'],
	28: ['xid', 'text'],
	114: ['json', 'json'],
	142: ['xml', 'text'],
	600: ['point', 'unknown'],
	650: ['cidr', 'text'],
	700: ['real', 'number'],
	701: ['double precision', 'number'],
	790: ['money', 'text'],
	829: ['macaddr', 'text'],
	869: ['inet', 'text'],
	1042: ['character', 'text'],
	1043: ['character varying', 'text'],
	1082: ['date', 'date'],
	1083: ['time without time zone', 'time'],
	1114: ['timestamp without time zone', 'datetime'],
	1184: ['timestamp with time zone', 'datetime'],
	1186: ['interval', 'interval'],
	1266: ['time with time zone', 'time'],
	1560: ['bit', 'text'],
	1562: ['bit varying', 'text'],
	1700: ['numeric', 'decimal'],
	2205: ['regclass', 'text'],
	2950: ['uuid', 'uuid'],
	3220: ['pg_lsn', 'text'],
	3614: ['tsvector', 'text'],
	3802: ['jsonb', 'json'],
	4072: ['jsonpath', 'text'],
	5069: ['xid8', 'bigint'],
	// Arrays.
	1000: ['boolean[]', 'array', 16],
	1001: ['bytea[]', 'array', 17],
	1002: ['"char"[]', 'array', 18],
	1003: ['name[]', 'array', 19],
	1005: ['smallint[]', 'array', 21],
	1007: ['integer[]', 'array', 23],
	1009: ['text[]', 'array', 25],
	1014: ['character[]', 'array', 1042],
	1015: ['character varying[]', 'array', 1043],
	1016: ['bigint[]', 'array', 20],
	1021: ['real[]', 'array', 700],
	1022: ['double precision[]', 'array', 701],
	1028: ['oid[]', 'array', 26],
	1041: ['inet[]', 'array', 869],
	1115: ['timestamp without time zone[]', 'array', 1114],
	1182: ['date[]', 'array', 1082],
	1183: ['time without time zone[]', 'array', 1083],
	1185: ['timestamp with time zone[]', 'array', 1184],
	1187: ['interval[]', 'array', 1186],
	1231: ['numeric[]', 'array', 1700],
	1270: ['time with time zone[]', 'array', 1266],
	199: ['json[]', 'array', 114],
	2951: ['uuid[]', 'array', 2950],
	3807: ['jsonb[]', 'array', 3802],
};

export function builtinType(oid: number): PgTypeInfo | undefined {
	const entry = BUILTIN[oid];
	if (!entry) return undefined;
	const [name, kind, elem] = entry;
	return { oid, name, kind, ...(elem !== undefined ? { elem } : {}), ...(oid === 1114 ? { local: true } : {}) };
}

/** A `pg_type` row, as the catalog lookup returns it. */
export interface PgTypeRow {
	oid: number;
	name: string;
	typtype: string;
	typcategory: string;
	typelem: number;
	typbasetype: number;
}

/**
 * Kind for a type that is not built in. `base` resolves a domain's base type (already looked
 * up); enums, arrays and the string category have their own kinds.
 */
export function kindForRow(row: PgTypeRow, base?: PgTypeInfo): CellKind {
	if (row.typtype === 'd' && base) return base.kind;
	if (row.typtype === 'e') return 'enum';
	if (row.typcategory === 'A' && row.typelem !== 0) return 'array';
	if (row.typcategory === 'S') return 'text';
	if (row.typcategory === 'B') return 'boolean';
	return 'unknown';
}

/** OIDs whose values can be large enough that browse fetches a server-side preview. */
export function previewMode(kind: CellKind, oid: number): 'text' | 'bytes' | 'json' | null {
	if (kind === 'bytes') return 'bytes';
	if (kind === 'json') return 'json';
	// Fixed-width character types are bounded by their typmod, and `::text` would strip
	// bpchar's padding.
	if (kind === 'text' && oid !== 1042 && oid !== 18 && oid !== 19) return 'text';
	return null;
}

export type Decoder = (value: unknown) => Cell;

export interface DecoderOptions {
	/** Preview limit for text, bytes and json; the `value` op passes the response budget. */
	limit?: number;
	/** Element decoder for arrays. */
	elem?: Decoder;
	/** Timestamp without time zone: no `Z` suffix. */
	local?: boolean;
	/** json values arrive as JSON source text (browse previews), not parsed by the driver. */
	jsonText?: boolean;
}

export function decoderFor(kind: CellKind, options: DecoderOptions = {}): Decoder {
	const limit = options.limit ?? CELL_PREVIEW_BYTES;
	switch (kind) {
		case 'number':
			return numberCell;
		case 'bigint':
			return (v) => (v === null || v === undefined ? null : bigintCell(v as string | number | bigint));
		case 'decimal':
			return (v) => (v === null || v === undefined ? null : decimalCell(String(v)));
		case 'boolean':
			return (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? v : v === 't' || v === 'true');
		case 'date':
			return dateValue;
		case 'datetime':
			return options.local ? localDatetimeValue : datetimeValue;
		case 'json':
			return (v) => jsonValue(v, limit, options.jsonText ?? false);
		case 'bytes':
			return (v) => bytesValue(v, limit);
		case 'array': {
			const elem = options.elem ?? ((v: unknown) => anyCell(v));
			const decode = (v: unknown): Cell => {
				if (v === null || v === undefined) return null;
				if (Array.isArray(v)) return v.map((item) => (Array.isArray(item) ? decode(item) : elem(item)));
				// Bun returns int4[]/float[] as typed arrays.
				if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>, elem);
				return textCell(String(v), limit);
			};
			return decode;
		}
		case 'text':
		case 'time':
		case 'interval':
		case 'uuid':
		case 'enum':
			return (v) => (v === null || v === undefined ? null : textCell(String(v), limit));
		default:
			return (v) => (typeof v === 'string' ? textCell(v, limit) : anyCell(v));
	}
}

function numberCell(v: unknown): Cell {
	if (v === null || v === undefined) return null;
	const n = typeof v === 'number' ? v : Number(v);
	// NaN and ±Infinity are valid float values but not JSON numbers.
	if (Number.isFinite(n)) return n;
	return decimalCell(typeof v === 'number' ? String(v) : String(v));
}

function dateValue(v: unknown): Cell {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') return dateCell(v);
	if (typeof v === 'number') return dateCell(v > 0 ? 'infinity' : '-infinity');
	if (v instanceof Date && !Number.isNaN(v.getTime())) return dateCell(v.toISOString().slice(0, 10));
	return anyCell(v);
}

function datetimeValue(v: unknown): Cell {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') return datetimeCell(normaliseTimestamp(v));
	// Bun returns ±infinity timestamps as ±Infinity.
	if (typeof v === 'number') return datetimeCell(v > 0 ? 'infinity' : '-infinity');
	if (v instanceof Date) return datetimeCell(v);
	return anyCell(v);
}

function localDatetimeValue(v: unknown): Cell {
	const cell = datetimeValue(v);
	if (v instanceof Date && cell && typeof cell === 'object' && !Array.isArray(cell) && typeof cell.v === 'string')
		return { $t: 'datetime', v: cell.v.replace(/Z$/, '') };
	return cell;
}

/**
 * Postgres ISO output (`2026-01-01 10:00:00.123456+00`) → ISO 8601
 * (`2026-01-01T10:00:00.123456Z`). Anything else (`infinity`, BC dates) passes through.
 */
export function normaliseTimestamp(text: string): string {
	const match = /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)([+-]\d\d(?::\d\d){0,2})?$/.exec(text);
	if (!match) return text;
	const [, date, time, offset] = match;
	if (!offset) return `${date}T${time}`;
	if (/^[+-]00(?::00){0,2}$/.test(offset)) return `${date}T${time}Z`;
	return `${date}T${time}${offset.length === 3 ? `${offset}:00` : offset}`;
}

function jsonValue(v: unknown, limit: number, text: boolean): Cell {
	if (v === null || v === undefined) return null;
	// A string from the driver is a JSON string scalar; only browse sends source text.
	if (text && typeof v === 'string') {
		try {
			return jsonCell(JSON.parse(v), limit);
		} catch {
			return textCell(v, limit);
		}
	}
	return jsonCell(v, limit);
}

function bytesValue(v: unknown, limit: number): Cell {
	if (v === null || v === undefined) return null;
	if (v instanceof Uint8Array) return bytesCell(v, limit);
	if (typeof v === 'string' && /^\\x[0-9a-fA-F]*$/.test(v)) return bytesCell(Buffer.from(v.slice(2), 'hex'), limit);
	return anyCell(v);
}
