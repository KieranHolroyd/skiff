/**
 * BSON ↔ studio cells, and Compass-style field inference, for the MongoDB plugin.
 *
 * Every value travels as canonical EJSON (`{ $t: 'ejson', v }`) so it round-trips exactly:
 * `{ $numberLong }` survives values above 2^53, `{ $numberDouble: "5.0" }` stays a double, and an
 * `_id` keeps its BSON type. Only strings, booleans, null and Int32 stay plain, because those
 * decode back to the same BSON type without a tag.
 *
 * Always `BSON.EJSON`, never the named `EJSON` export: it is `undefined` inside a
 * `bun build --compile` binary (plan 22, spike S1).
 */
import { BSON } from 'mongodb';
import { CELL_PREVIEW_BYTES, ejsonCell, isTagged, textCell } from '../../cells.ts';
import { StudioError, type Cell, type CellKind, type Column } from '../../protocol.ts';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/**
 * Read options for every data path: keep Int32/Long/Double as BSON wrappers (a promoted
 * `number` would lose whether `5` was an int, a long or `5.0`) and regexes as `BSONRegExp`
 * (a JS `RegExp` cannot carry every PCRE flag).
 */
export const LOSSLESS_READ = { promoteValues: false, promoteBuffers: false, bsonRegExp: true } as const;

/** The BSON type alias (as `$type` spells it) of one value. */
export function bsonType(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	switch (typeof value) {
		case 'string':
			return 'string';
		case 'boolean':
			return 'bool';
		case 'number':
			return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? 'int' : 'double';
		case 'bigint':
			return 'long';
		default:
			break;
	}
	if (value instanceof Date) return 'date';
	if (Array.isArray(value)) return 'array';
	if (value instanceof RegExp) return 'regex';
	const tag = (value as { _bsontype?: string })._bsontype;
	switch (tag) {
		case 'ObjectId':
			return 'objectId';
		case 'Int32':
			return 'int';
		case 'Double':
			return 'double';
		case 'Long':
			return 'long';
		case 'Decimal128':
			return 'decimal';
		case 'Binary':
			return 'binData';
		case 'Timestamp':
			return 'timestamp';
		case 'BSONRegExp':
			return 'regex';
		case 'Code':
			return 'javascript';
		case 'BSONSymbol':
			return 'symbol';
		case 'MinKey':
			return 'minKey';
		case 'MaxKey':
			return 'maxKey';
		case 'DBRef':
			return 'dbPointer';
		default:
			return 'object';
	}
}

const KINDS: Record<string, CellKind> = {
	objectId: 'objectid',
	string: 'text',
	symbol: 'text',
	int: 'number',
	double: 'number',
	long: 'bigint',
	decimal: 'decimal',
	bool: 'boolean',
	date: 'datetime',
	binData: 'bytes',
	object: 'document',
	array: 'document',
	dbPointer: 'document',
};

export function kindOf(type: string): CellKind {
	return KINDS[type] ?? 'unknown';
}

/** One BSON value → a lossless cell. `limit` bounds the preview; `value` passes Infinity. */
export function toCell(value: unknown, limit = CELL_PREVIEW_BYTES): Cell {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return textCell(value, limit);
	if (typeof value === 'boolean') return value;
	const type = bsonType(value);
	if (type === 'int') return typeof value === 'number' ? value : (value as BSON.Int32).value;
	return ejsonCell(BSON.EJSON.serialize(value, { relaxed: false }), limit);
}

/**
 * A cell from the UI → the BSON value to bind. EJSON cells decode canonically, so a
 * `{ $numberLong }` comes back as a `Long` and a `{ $numberDouble }` as a `Double`.
 */
export function fromCell(cell: Cell): unknown {
	if (cell === null || typeof cell !== 'object') return cell;
	if (Array.isArray(cell)) return cell.map(fromCell);
	if (!isTagged(cell)) return cell;
	try {
		switch (cell.$t) {
			case 'ejson':
				return BSON.EJSON.deserialize(cell.v as BSON.Document, { relaxed: false });
			case 'json':
				// Plain JSON from a generic editor: numbers decode to the narrowest BSON number.
				return BSON.EJSON.deserialize(cell.v as BSON.Document, { relaxed: true });
			case 'bigint':
				return BSON.Long.fromString(String(cell.v));
			case 'decimal':
				return BSON.Decimal128.fromString(String(cell.v));
			case 'bytes':
				return new BSON.Binary(Buffer.from(String(cell.v), 'base64'));
			case 'date':
			case 'datetime': {
				const date = new Date(String(cell.v));
				if (Number.isNaN(date.getTime())) throw new Error(`"${String(cell.v)}" is not a date.`);
				return date;
			}
			case 'truncated':
				break;
		}
	} catch (error) {
		throw new StudioError('bad_request', `Invalid ${cell.$t} value: ${(error as Error).message}`);
	}
	throw new StudioError('bad_request', 'A truncated preview cannot be written back; load the full value first.');
}

/** Field names a structured filter, sort or edit may name: top-level, no operators. */
export function assertFieldName(name: string): void {
	if (!name || name.startsWith('$') || name.includes('.') || name.includes('\0'))
		throw new StudioError('bad_request', `"${name}" is not a top-level field name.`);
}

/** A document's top-level fields with their BSON types, the input `inferColumns` takes. */
export function fieldTypes(doc: BSON.Document): Array<[string, string]> {
	return Object.entries(doc).map(([name, value]) => [name, bsonType(value)]);
}

/**
 * Infer columns the way Compass does, from `[field, bsonType]` lists (one per document): the
 * union of top-level fields, `_id` first, then by how many documents carry the field (ties keep
 * first-seen order). One BSON type maps to that type's kind; several types make a `mixed(...)`
 * column, its types listed most common first, with the generic `unknown` kind.
 */
export function inferColumns(
	docs: Iterable<Iterable<readonly [string, string]>>,
	options: { editable: boolean },
): Column[] {
	const fields = new Map<string, { seen: number; nulls: number; order: number; types: Map<string, number> }>();
	let total = 0;
	for (const doc of docs) {
		total += 1;
		for (const [name, type] of doc) {
			let field = fields.get(name);
			if (!field) {
				field = { seen: 0, nulls: 0, order: fields.size, types: new Map() };
				fields.set(name, field);
			}
			field.seen += 1;
			if (type === 'null' || type === 'undefined' || type === 'missing') field.nulls += 1;
			else field.types.set(type, (field.types.get(type) ?? 0) + 1);
		}
	}
	if (!fields.has('_id')) fields.set('_id', { seen: total, nulls: 0, order: -1, types: new Map() });
	const ordered = [...fields.entries()].sort(([a, x], [b, y]) => {
		if (a === '_id') return -1;
		if (b === '_id') return 1;
		return y.seen - x.seen || x.order - y.order;
	});
	return ordered.map(([name, field]) => {
		const types = [...field.types.entries()].sort((x, y) => y[1] - x[1]).map(([type]) => type);
		const isId = name === '_id';
		// An empty collection still has an `_id`; ObjectId is what the server would assign.
		const only = types.length === 1 ? types[0]! : types.length === 0 && isId ? 'objectId' : null;
		const column: Column = {
			name,
			nativeType: only ?? (types.length === 0 ? 'null' : `mixed(${types.join(', ')})`),
			kind: only ? kindOf(only) : 'unknown',
			nullable: !isId && (field.nulls > 0 || field.seen < total),
			editable: !isId && options.editable,
		};
		if (isId) column.key = 'primary';
		return column;
	});
}

/** One document as a row in `columns` order; missing fields are null. */
export function toRow(doc: BSON.Document, columns: Column[]): Cell[] {
	return columns.map((column) => toCell(doc[column.name]));
}

/** Canonical EJSON text of a value, for cursors and display. */
export function canonical(value: unknown): string {
	return BSON.EJSON.stringify(value, { relaxed: false });
}
