/**
 * Type mapping for the MySQL/MariaDB plugin. Result sets are typed from the mysql2 field
 * packet (`columnType`, charset, flags); `describe` is typed from `information_schema`. Both land
 * on the same `CellKind`, and one encoder turns a decoded mysql2 value into a lossless cell.
 *
 * The connection decodes with `supportBigNumbers` + `bigNumberStrings` (BIGINT/DECIMAL arrive
 * as strings), `dateStrings` (temporal values arrive as the server's own text, so zero dates
 * survive) and `jsonStrings` (JSON arrives as text, identical on MySQL and MariaDB).
 */
import { bigintCell, bytesCell, CELL_PREVIEW_BYTES, dateCell, datetimeCell, decimalCell, jsonCell, textCell, anyCell } from '../../cells.ts';
import type { Cell, CellKind } from '../../protocol.ts';

/** mysql2 / protocol column type codes (`mysql2/lib/constants/types`). */
export const FieldType = {
	DECIMAL: 0,
	TINY: 1,
	SHORT: 2,
	LONG: 3,
	FLOAT: 4,
	DOUBLE: 5,
	NULL: 6,
	TIMESTAMP: 7,
	LONGLONG: 8,
	INT24: 9,
	DATE: 10,
	TIME: 11,
	DATETIME: 12,
	YEAR: 13,
	NEWDATE: 14,
	VARCHAR: 15,
	BIT: 16,
	TIMESTAMP2: 17,
	DATETIME2: 18,
	TIME2: 19,
	VECTOR: 242,
	JSON: 245,
	NEWDECIMAL: 246,
	ENUM: 247,
	SET: 248,
	TINY_BLOB: 249,
	MEDIUM_BLOB: 250,
	LONG_BLOB: 251,
	BLOB: 252,
	VAR_STRING: 253,
	STRING: 254,
	GEOMETRY: 255,
} as const;

/** Charset id 63 (`binary`) is what separates BLOB/VARBINARY/BINARY from TEXT/VARCHAR/CHAR. */
export const BINARY_CHARSET = 63;
const FLAG_UNSIGNED = 32;
const FLAG_ENUM = 256;
const FLAG_SET = 2_048;

/** BIT values up to 48 bits fit a double exactly; wider ones travel as bytes. */
const BIT_NUMBER_MAX_WIDTH = 48;

/** The subset of a mysql2 `FieldPacket` the mapping reads. */
export interface FieldInfo {
	name: string;
	columnType?: number;
	characterSet?: number;
	flags?: number;
	columnLength?: number;
	decimals?: number;
	/** MariaDB extended metadata: `json` for JSON columns and JSON expressions. */
	extendedFormat?: string;
	/** MariaDB extended metadata: `uuid`, `inet4`, `inet6`, `point`… */
	extendedTypeName?: string;
}

export interface TypeMapping {
	kind: CellKind;
	nativeType: string;
}

export function fieldMapping(field: FieldInfo): TypeMapping {
	const type = field.columnType ?? FieldType.VAR_STRING;
	const flags = field.flags ?? 0;
	const unsigned = flags & FLAG_UNSIGNED ? ' unsigned' : '';
	const binary = field.characterSet === BINARY_CHARSET;
	if (field.extendedFormat === 'json') return { kind: 'json', nativeType: 'json' };
	if (field.extendedTypeName === 'uuid') return { kind: 'uuid', nativeType: 'uuid' };
	if (field.extendedTypeName) return { kind: binary ? 'bytes' : 'text', nativeType: field.extendedTypeName };
	switch (type) {
		case FieldType.DECIMAL:
		case FieldType.NEWDECIMAL:
			return { kind: 'decimal', nativeType: `decimal${unsigned}` };
		case FieldType.TINY:
			return { kind: 'number', nativeType: `tinyint${unsigned}` };
		case FieldType.SHORT:
			return { kind: 'number', nativeType: `smallint${unsigned}` };
		case FieldType.INT24:
			return { kind: 'number', nativeType: `mediumint${unsigned}` };
		case FieldType.LONG:
			return { kind: 'number', nativeType: `int${unsigned}` };
		case FieldType.YEAR:
			return { kind: 'number', nativeType: 'year' };
		case FieldType.FLOAT:
			return { kind: 'number', nativeType: 'float' };
		case FieldType.DOUBLE:
			return { kind: 'number', nativeType: 'double' };
		case FieldType.LONGLONG:
			return { kind: 'bigint', nativeType: `bigint${unsigned}` };
		case FieldType.DATE:
		case FieldType.NEWDATE:
			return { kind: 'date', nativeType: 'date' };
		case FieldType.TIME:
		case FieldType.TIME2:
			return { kind: 'time', nativeType: 'time' };
		case FieldType.DATETIME:
		case FieldType.DATETIME2:
			return { kind: 'datetime', nativeType: 'datetime' };
		case FieldType.TIMESTAMP:
		case FieldType.TIMESTAMP2:
			return { kind: 'datetime', nativeType: 'timestamp' };
		case FieldType.BIT: {
			const width = field.columnLength ?? 1;
			return { kind: width <= BIT_NUMBER_MAX_WIDTH ? 'number' : 'bytes', nativeType: `bit(${width})` };
		}
		case FieldType.JSON:
			return { kind: 'json', nativeType: 'json' };
		case FieldType.NULL:
			return { kind: 'unknown', nativeType: 'null' };
		case FieldType.GEOMETRY:
			return { kind: 'bytes', nativeType: 'geometry' };
		case FieldType.VECTOR:
			return { kind: 'bytes', nativeType: 'vector' };
		default:
			break;
	}
	// ENUM and SET arrive as STRING with a flag.
	if (type === FieldType.ENUM || flags & FLAG_ENUM) return { kind: 'enum', nativeType: 'enum' };
	if (type === FieldType.SET || flags & FLAG_SET) return { kind: 'text', nativeType: 'set' };
	switch (type) {
		case FieldType.TINY_BLOB:
		case FieldType.MEDIUM_BLOB:
		case FieldType.LONG_BLOB:
		case FieldType.BLOB:
			return binary ? { kind: 'bytes', nativeType: 'blob' } : { kind: 'text', nativeType: 'text' };
		case FieldType.VAR_STRING:
		case FieldType.VARCHAR:
			return binary ? { kind: 'bytes', nativeType: 'varbinary' } : { kind: 'text', nativeType: 'varchar' };
		case FieldType.STRING:
			return binary ? { kind: 'bytes', nativeType: 'binary' } : { kind: 'text', nativeType: 'char' };
		default:
			return { kind: 'unknown', nativeType: `type ${type}` };
	}
}

/**
 * `information_schema.COLUMNS` → kind. `json` is set for MariaDB LONGTEXT columns that carry a
 * `json_valid(col)` CHECK constraint, because MariaDB reports its JSON alias as LONGTEXT.
 */
export function schemaKind(dataType: string, columnType: string, json = false): CellKind {
	const type = dataType.toLowerCase();
	switch (type) {
		case 'tinyint':
		case 'smallint':
		case 'mediumint':
		case 'int':
		case 'integer':
		case 'year':
		case 'float':
		case 'double':
		case 'real':
			return 'number';
		case 'bigint':
			return 'bigint';
		case 'decimal':
		case 'numeric':
			return 'decimal';
		case 'bit': {
			const width = Number(/\((\d+)\)/.exec(columnType)?.[1] ?? '1');
			return width <= BIT_NUMBER_MAX_WIDTH ? 'number' : 'bytes';
		}
		case 'date':
			return 'date';
		case 'time':
			return 'time';
		case 'datetime':
		case 'timestamp':
			return 'datetime';
		case 'json':
			return 'json';
		case 'char':
		case 'varchar':
		case 'tinytext':
		case 'text':
		case 'mediumtext':
		case 'longtext':
			return json ? 'json' : 'text';
		case 'binary':
		case 'varbinary':
		case 'tinyblob':
		case 'blob':
		case 'mediumblob':
		case 'longblob':
		case 'geometry':
		case 'point':
		case 'linestring':
		case 'polygon':
		case 'multipoint':
		case 'multilinestring':
		case 'multipolygon':
		case 'geometrycollection':
		case 'geomcollection':
		case 'vector':
			return 'bytes';
		case 'enum':
			return 'enum';
		case 'set':
		case 'inet4':
		case 'inet6':
			return 'text';
		case 'uuid':
			return 'uuid';
		default:
			return 'unknown';
	}
}

/** `json_valid(`col`)` → `col`, for MariaDB's JSON alias. Anything else → null. */
export function jsonCheckColumn(clause: string): string | null {
	const match = /^\s*json_valid\s*\(\s*`((?:[^`]|``)+)`\s*\)\s*$/i.exec(clause);
	return match?.[1] ? match[1].replaceAll('``', '`') : null;
}

/**
 * Encode one decoded mysql2 value as a cell of `kind`. `limit` is the preview size; `value`
 * passes `Infinity` to load a full value.
 */
export function encodeCell(kind: CellKind, value: unknown, limit = CELL_PREVIEW_BYTES): Cell {
	if (value === null || value === undefined) return null;
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		if (kind === 'number' && bytes.byteLength <= 6) return bytes.byteLength === 0 ? 0 : bytes.readUIntBE(0, bytes.byteLength);
		if (kind === 'json' || kind === 'text' || kind === 'enum' || kind === 'uuid')
			return encodeCell(kind, bytes.toString('utf8'), limit);
		return bytesCell(bytes, limit);
	}
	switch (kind) {
		case 'bigint':
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return bigintCell(value);
			break;
		case 'decimal':
			return decimalCell(String(value));
		case 'number':
			if (typeof value === 'number') return Number.isFinite(value) ? value : decimalCell(String(value));
			if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
				// Keep integers beyond 2^53 exact rather than rounding them through a double.
				return /^-?\d+$/.test(value.trim()) ? bigintCell(value.trim()) : Number(value);
			}
			break;
		case 'date':
			return dateCell(String(value));
		case 'datetime':
			return value instanceof Date ? datetimeCell(value) : datetimeCell(String(value));
		case 'time':
			return textCell(String(value), limit);
		case 'json': {
			if (typeof value !== 'string') return jsonCell(value, limit);
			// Do not parse a document we would only send as a truncated text preview anyway.
			if (Buffer.byteLength(value, 'utf8') > limit) return textCell(value, limit);
			try {
				return jsonCell(JSON.parse(value), limit);
			} catch {
				return textCell(value, limit);
			}
		}
		case 'text':
		case 'enum':
		case 'uuid':
			return textCell(String(value), limit);
		default:
			break;
	}
	if (typeof value === 'string') return textCell(value, limit);
	return anyCell(value);
}
