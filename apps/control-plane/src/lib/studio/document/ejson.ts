/**
 * EJSON helpers for the MongoDB document workspace (plan 22 Phase 2 UI, track G).
 *
 * The plugin sends every value as canonical EJSON (`{ $t: 'ejson', v }`), except strings,
 * booleans, null and Int32, which stay plain. Canonical EJSON is exact but noisy
 * (`{"$numberInt":"5"}`, `{"$date":{"$numberLong":"…"}}`), so the JSON view and the document
 * editor show a *display* form that is still lossless when the plugin parses it back
 * canonically:
 *
 * - `{"$numberInt":"5"}` → `5` (a canonical parse of an integer is an Int32 again);
 * - `{"$numberDouble":"1.5"}` → `1.5` (a non-integer parses as a Double), but `5.0` stays wrapped;
 * - `{"$date":{"$numberLong":"…"}}` → `{"$date":"2026-11-06T…Z"}` for years 1970–9999;
 * - everything else (`$oid`, `$numberLong`, `$numberDecimal`, `$binary`, …) stays canonical.
 *
 * Edits go back as `{ $t: 'ejson', v }` cells, so the plugin's `fromCell` decodes them with
 * `relaxed: false` and keeps the types the user sees.
 */
import type { Cell, Column, RowChange, TaggedCell } from '@skiff/studio/protocol';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
/** The largest date relaxed EJSON writes as ISO text (9999-12-31T23:59:59.999Z). */
const MAX_ISO_MS = 253_402_300_799_999;

export function isTagged(cell: Cell): cell is TaggedCell {
	return typeof cell === 'object' && cell !== null && !Array.isArray(cell) && '$t' in cell;
}

export function isTruncated(cell: Cell): boolean {
	return isTagged(cell) && cell.$t === 'truncated';
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical EJSON value of a Mongo cell; `undefined` for a truncated preview. */
export function cellToCanonical(cell: Cell): Json | undefined {
	if (cell === null || typeof cell === 'string' || typeof cell === 'boolean') return cell;
	if (typeof cell === 'number')
		return Number.isInteger(cell) && cell >= INT32_MIN && cell <= INT32_MAX
			? { $numberInt: String(cell) }
			: { $numberDouble: String(cell) };
	if (Array.isArray(cell)) {
		const items = cell.map(cellToCanonical);
		return items.some((item) => item === undefined) ? undefined : (items as Json[]);
	}
	switch (cell.$t) {
		case 'ejson':
		case 'json':
			return cell.v as Json;
		case 'bigint':
			return { $numberLong: String(cell.v) };
		case 'decimal':
			return { $numberDecimal: String(cell.v) };
		case 'date':
		case 'datetime':
			return { $date: String(cell.v) };
		case 'bytes':
			return { $binary: { base64: String(cell.v), subType: '00' } };
		case 'truncated':
			return undefined;
	}
}

/** Canonical EJSON → the shorter display form described above. */
export function simplify(value: Json): Json {
	if (Array.isArray(value)) return value.map(simplify);
	if (!isObject(value)) return value;
	const keys = Object.keys(value);
	if (keys.length === 1) {
		const key = keys[0]!;
		const inner = value[key];
		if (key === '$numberInt' && typeof inner === 'string') {
			const n = Number(inner);
			if (Number.isSafeInteger(n)) return n;
		}
		if (key === '$numberDouble' && typeof inner === 'string') {
			const n = Number(inner);
			// An integral double would come back as an Int32, so it keeps its wrapper.
			if (Number.isFinite(n) && !Number.isInteger(n)) return n;
		}
		if (key === '$date' && isObject(inner) && typeof inner.$numberLong === 'string') {
			const ms = Number(inner.$numberLong);
			if (Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_ISO_MS) return { $date: new Date(ms).toISOString() };
		}
	}
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) out[key] = simplify(item);
	return out;
}

/** A cell as display EJSON; `undefined` for a truncated preview. */
export function cellToDisplay(cell: Cell): Json | undefined {
	const canonical = cellToCanonical(cell);
	return canonical === undefined ? undefined : simplify(canonical);
}

/** A display value from the editor → the cell `apply` takes. */
export function displayToCell(value: Json): Cell {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	// Plain Int32s round-trip untagged (the plugin keeps them as plain numbers too).
	if (typeof value === 'number' && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) return value;
	return { $t: 'ejson', v: value };
}

// ---------------------------------------------------------------- documents

/** One browsed document: its `_id` cell and its non-null fields in column order. */
export interface MongoDocument {
	id: Cell;
	/** `[field, cell]`, `_id` first. Null cells are left out: browse rows can't tell null from missing. */
	fields: Array<[string, Cell]>;
}

export function rowToDocument(columns: Column[], row: Cell[]): MongoDocument {
	const fields: Array<[string, Cell]> = [];
	let id: Cell = null;
	columns.forEach((column, index) => {
		const cell = row[index] ?? null;
		if (column.name === '_id') id = cell;
		if (cell === null && column.name !== '_id') return;
		fields.push([column.name, cell]);
	});
	return { id, fields };
}

/** Fields whose value is only a preview; load them with the `value` op before editing. */
export function truncatedFields(doc: MongoDocument): string[] {
	return doc.fields.filter(([, cell]) => isTruncated(cell)).map(([name]) => name);
}

/** Replace some fields' cells (full values loaded through `value`). */
export function withFields(doc: MongoDocument, loaded: Record<string, Cell>): MongoDocument {
	return { ...doc, fields: doc.fields.map(([name, cell]): [string, Cell] => [name, name in loaded ? loaded[name]! : cell]) };
}

/** The document as a display object; truncated previews become a placeholder string. */
export function displayObject(doc: MongoDocument): JsonObject {
	const out: JsonObject = {};
	for (const [name, cell] of doc.fields) {
		const value = cellToDisplay(cell);
		out[name] =
			value === undefined
				? `… truncated preview (${isTagged(cell) && cell.bytes !== undefined ? `${cell.bytes} bytes` : 'large value'})`
				: value;
	}
	return out;
}

export function formatDocument(doc: MongoDocument): string {
	return JSON.stringify(displayObject(doc), null, 2);
}

/** A one-line summary of a document for the collapsed JSON view. */
export function documentPreview(doc: MongoDocument, max = 240): string {
	const text = JSON.stringify(displayObject(doc));
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------- parsing and diffing

export type ParsedDocument = { ok: true; value: JsonObject } | { ok: false; error: string; position?: number };

/** 1-based character offset of a `JSON.parse` error, when the engine reports one. */
export function jsonErrorPosition(message: string, text: string): number | undefined {
	const at = /position (\d+)/i.exec(message);
	if (at) return Number(at[1]) + 1;
	const lineColumn = /line (\d+) column (\d+)/i.exec(message);
	if (lineColumn) {
		const line = Number(lineColumn[1]);
		const column = Number(lineColumn[2]);
		const lines = text.split('\n');
		let offset = 0;
		for (let i = 0; i < line - 1 && i < lines.length; i += 1) offset += lines[i]!.length + 1;
		return offset + column;
	}
	return undefined;
}

/** Parse editor text that must be one JSON object (an EJSON filter or document). */
export function parseJsonDocument(text: string, what = 'document'): ParsedDocument {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const position = jsonErrorPosition(message, text);
		return {
			ok: false,
			error: `The ${what} is not valid JSON (${message}). Use Extended JSON, e.g. {"_id": {"$oid": "…"}}, not shell syntax like ObjectId("…").`,
			...(position === undefined ? {} : { position }),
		};
	}
	if (!isObject(value)) return { ok: false, error: `The ${what} must be a JSON object, like {"status": "active"}.` };
	return { ok: true, value };
}

/** Validate the filter box: empty means "no filter". */
export function parseFilter(text: string): { ok: true; native: string | undefined } | { ok: false; error: string; position?: number } {
	const trimmed = text.trim();
	if (!trimmed || trimmed === '{}') return { ok: true, native: undefined };
	const parsed = parseJsonDocument(trimmed, 'filter');
	if (!parsed.ok) return parsed;
	return { ok: true, native: trimmed };
}

/** The plugin's rule for edited field names: top-level, no operators. */
export function fieldNameProblem(name: string): string | null {
	if (!name) return 'Field names cannot be empty.';
	if (name.startsWith('$')) return `"${name}" starts with $; operators can't be set here.`;
	if (name.includes('.')) return `"${name}" contains a dot; only top-level fields can be set here.`;
	if (name.includes('\0')) return `"${name}" contains a NUL character.`;
	return null;
}

const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a) === JSON.stringify(b);

export type DocumentEdit = { ok: true; change: RowChange | null } | { ok: false; error: string; position?: number };

/**
 * Diff the edited text against the loaded document into one `update` change: the plugin applies
 * it as `$set` of top-level fields, guarded by each changed field's original cell. Removing a
 * field would need `$unset`, which the update contract does not do, so it is refused with advice.
 */
export function documentUpdate(doc: MongoDocument, text: string): DocumentEdit {
	if (truncatedFields(doc).length > 0) return { ok: false, error: 'Load the full values before editing this document.' };
	const parsed = parseJsonDocument(text);
	if (!parsed.ok) return parsed;
	const edited = parsed.value;
	const before = displayObject(doc);
	if ('_id' in edited && !same(edited._id, before._id)) return { ok: false, error: '_id cannot be changed.' };
	const removed = Object.keys(before).filter((name) => name !== '_id' && !(name in edited));
	if (removed.length > 0)
		return {
			ok: false,
			error: `Removing fields isn't supported here (${removed.join(', ')}): edits are a top-level $set. Set the field to null instead, or run an update with $unset in a query tab.`,
		};
	const cells = new Map(doc.fields);
	const values: Record<string, Cell> = {};
	const original: Record<string, Cell> = {};
	for (const [name, value] of Object.entries(edited)) {
		if (name === '_id') continue;
		const problem = fieldNameProblem(name);
		if (problem) return { ok: false, error: problem };
		if (same(value, before[name])) continue;
		values[name] = displayToCell(value);
		// A field the view does not show is null or missing; `$eq: null` matches both.
		original[name] = cells.get(name) ?? null;
	}
	if (Object.keys(values).length === 0) return { ok: true, change: null };
	return { ok: true, change: { op: 'update', key: { _id: doc.id }, values, original } };
}

/** An `insert` change from editor text; `_id` is optional (the server assigns an ObjectId). */
export function documentInsert(text: string): DocumentEdit {
	const parsed = parseJsonDocument(text);
	if (!parsed.ok) return parsed;
	const values: Record<string, Cell> = {};
	for (const [name, value] of Object.entries(parsed.value)) {
		if (name !== '_id') {
			const problem = fieldNameProblem(name);
			if (problem) return { ok: false, error: problem };
		}
		values[name] = displayToCell(value);
	}
	return { ok: true, change: { op: 'insert', values } };
}

/** A `delete` guarded by every loaded field (truncated previews can't be compared, so they're left out). */
export function documentDelete(doc: MongoDocument): RowChange {
	const original: Record<string, Cell> = {};
	for (const [name, cell] of doc.fields) if (name !== '_id' && !isTruncated(cell)) original[name] = cell;
	return { op: 'delete', key: { _id: doc.id }, original };
}

/** A short label for a document's `_id` (`ObjectId('…')`-like, but plain text). */
export function idLabel(id: Cell): string {
	const value = cellToDisplay(id);
	if (isObject(value) && typeof value.$oid === 'string') return value.$oid;
	return typeof value === 'string' ? value : JSON.stringify(value);
}
