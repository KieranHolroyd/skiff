/**
 * SQL builders for browse, apply and value. Identifiers come from `describe` and are always
 * quoted; values are always bound parameters.
 *
 * Every value is bound as text and cast explicitly (`$1::text::<type>`). Bun picks a parameter's
 * wire type from the JS value (a number becomes int4, so `5` cannot bind to jsonb), so sending
 * text and letting the server's input function parse it is the one encoding that is exact for
 * every type: numeric, int8, timestamps with microseconds, bytea, json, arrays, enums, domains.
 */
import { CELL_PREVIEW_BYTES, isTagged } from '../../cells.ts';
import { StudioError, type BrowseQuery, type Cell, type CellKind, type FilterOp } from '../../protocol.ts';
import { previewMode } from './types.ts';

/** What the builders need to know about a column (from `describe`). */
export interface ColumnMeta {
	name: string;
	kind: CellKind;
	/** Element kind, for arrays. */
	elemKind?: CellKind;
	typeOid: number;
	/** `format_type(atttypid, NULL)`: the type without a typmod, so casts never truncate. */
	castType: string;
	nullable: boolean;
}

export interface TableMeta {
	schema: string;
	name: string;
	columns: ColumnMeta[];
	primaryKey: string[] | null;
	/** Plain tables and materialized views without a key page by `ctid` instead of OFFSET. */
	ctid: boolean;
}

/** Double-quote an identifier, doubling embedded quotes. Always quotes, so case is kept. */
export function quoteIdent(name: string): string {
	if (name.length === 0) throw new StudioError('bad_request', 'An identifier cannot be empty.');
	if (name.includes('\0')) throw new StudioError('bad_request', 'An identifier cannot contain NUL.');
	return `"${name.replaceAll('"', '""')}"`;
}

export function qualified(schema: string, name: string): string {
	return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

// ---------------------------------------------------------------- parameters

export class Params {
	readonly values: (string | null)[] = [];

	/** Bind `value` as text and cast it to `cast` (a `format_type` name or a builtin). */
	add(value: string | null, cast: string): string {
		this.values.push(value);
		return cast === 'text' ? `$${this.values.length}::text` : `$${this.values.length}::text::${cast}`;
	}
}

/** A cell as the text the column type's input function parses. */
export function textParam(cell: Cell, kind: CellKind, elemKind?: CellKind): string | null {
	if (cell === null) return null;
	if (kind === 'json') {
		if (isTagged(cell)) {
			if (cell.$t === 'truncated') throw truncated();
			return JSON.stringify(cell.v);
		}
		// A plain string is JSON source typed by the user.
		if (typeof cell === 'string') return cell;
		return JSON.stringify(cell);
	}
	if (Array.isArray(cell)) return arrayLiteral(cell, elemKind ?? 'unknown');
	if (isTagged(cell)) {
		switch (cell.$t) {
			case 'bytes':
				return `\\x${Buffer.from(String(cell.v), 'base64').toString('hex')}`;
			case 'json':
			case 'ejson':
				return JSON.stringify(cell.v);
			case 'truncated':
				throw truncated();
			default:
				return String(cell.v);
		}
	}
	if (typeof cell === 'boolean') return cell ? 'true' : 'false';
	return String(cell);
}

function truncated(): StudioError {
	return new StudioError('bad_request', 'A truncated preview cannot be written back; load the full value first.');
}

/** A Postgres array literal: `{1,NULL,"a \"b\""}`, nested for multi-dimensional arrays. */
export function arrayLiteral(cells: Cell[], elemKind: CellKind): string {
	const items = cells.map((cell) => {
		if (cell === null) return 'NULL';
		if (Array.isArray(cell) && elemKind !== 'json') return arrayLiteral(cell, elemKind);
		const text = textParam(cell, elemKind) ?? '';
		return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
	});
	return `{${items.join(',')}}`;
}

/**
 * The expression and cast used to compare a column with a bound value. json has no equality
 * operator, so it compares as jsonb; types the plugin does not know compare as text (their
 * cells are the server's text output).
 */
export function comparable(column: ColumnMeta): { expr: string; cast: string } {
	const ident = quoteIdent(column.name);
	if (column.kind === 'json') return { expr: `${ident}::jsonb`, cast: 'jsonb' };
	if (column.kind === 'unknown') return { expr: `${ident}::text`, cast: 'text' };
	return { expr: ident, cast: column.castType };
}

// ---------------------------------------------------------------- filters

const comparisons: Partial<Record<FilterOp, string>> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
export const MAX_IN_VALUES = 1_000;

export function buildFilters(
	filters: BrowseQuery['filter'],
	columns: Map<string, ColumnMeta>,
	params: Params,
): string[] {
	return filters.map((filter) => {
		const column = columns.get(filter.column);
		if (!column) throw new StudioError('bad_request', `Unknown column "${filter.column}".`);
		const value = filter.value ?? null;
		const { expr, cast } = comparable(column);
		switch (filter.op) {
			case 'is-null':
				return `${quoteIdent(column.name)} IS NULL`;
			case 'not-null':
				return `${quoteIdent(column.name)} IS NOT NULL`;
			case 'like':
			case 'ilike': {
				if (value === null || Array.isArray(value))
					throw new StudioError('bad_request', `${filter.op} needs a text pattern.`);
				const pattern = params.add(textParam(value, 'text'), 'text');
				return `${quoteIdent(column.name)}::text ${filter.op === 'like' ? 'LIKE' : 'ILIKE'} ${pattern}`;
			}
			case 'in': {
				if (!Array.isArray(value)) throw new StudioError('bad_request', '"in" needs a list of values.');
				if (value.length > MAX_IN_VALUES)
					throw new StudioError('bad_request', `"in" accepts at most ${MAX_IN_VALUES} values.`);
				if (value.length === 0) return 'FALSE';
				const items = value.map((item) => params.add(textParam(item, column.kind, column.elemKind), cast));
				return `${expr} IN (${items.join(', ')})`;
			}
			default: {
				const operator = comparisons[filter.op];
				if (!operator) throw new StudioError('bad_request', `Unknown filter "${filter.op}".`);
				if (value === null) {
					if (filter.op === 'eq') return `${quoteIdent(column.name)} IS NULL`;
					if (filter.op === 'ne') return `${quoteIdent(column.name)} IS NOT NULL`;
					throw new StudioError('bad_request', `${filter.op} cannot compare with NULL.`);
				}
				return `${expr} ${operator} ${params.add(textParam(value, column.kind, column.elemKind), cast)}`;
			}
		}
	});
}

// ---------------------------------------------------------------- ordering and keyset

export interface OrderItem {
	/** A described column, or the `ctid` tiebreak for tables without a key. */
	column: ColumnMeta | 'ctid';
	dir: 'asc' | 'desc';
}

function orderExpr(item: OrderItem): { expr: string; cast: string; nullable: boolean; name: string } {
	if (item.column === 'ctid') return { expr: 'ctid', cast: 'tid', nullable: false, name: 'ctid' };
	const { expr, cast } = comparable(item.column);
	return { expr, cast, nullable: item.column.nullable, name: item.column.name };
}

/** Alias of the browsed relation; ORDER BY references are qualified with it. */
export const SOURCE_ALIAS = 'src';

/**
 * `ORDER BY` with Postgres's default null placement spelled out (ASC NULLS LAST, DESC NULLS
 * FIRST). References are qualified: a bare name in ORDER BY matches an *output* column first,
 * so `ORDER BY ctid` would sort by the selected `ctid::text` (and `"created"` by its text cast).
 */
export function orderBy(items: OrderItem[]): string {
	if (items.length === 0) return '';
	return ` ORDER BY ${items
		.map((item) => `${SOURCE_ALIAS}.${orderExpr(item).expr} ${item.dir === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST'}`)
		.join(', ')}`;
}

/**
 * The condition for "rows after `values`" in `items` order. When every column is NOT NULL and
 * sorts the same way, it is one row comparison (index-friendly); otherwise it expands to
 * `(a after) OR (a = and b after) OR …`, where "after" respects where NULLs sort.
 */
export function keysetCondition(items: OrderItem[], values: Cell[], params: Params): string {
	if (items.length !== values.length) throw new StudioError('bad_request', 'The cursor does not match the sort order.');
	const exprs = items.map(orderExpr);
	const sameDir = items.every((item) => item.dir === items[0]?.dir);
	const noNulls = exprs.every((e, i) => !e.nullable && values[i] !== null);
	const param = (i: number) => {
		const item = items[i] as OrderItem;
		const value = values[i] ?? null;
		const text =
			item.column === 'ctid' ? textParam(value, 'text') : textParam(value, item.column.kind, item.column.elemKind);
		return params.add(text, (exprs[i] as { cast: string }).cast);
	};
	if (sameDir && noNulls) {
		const op = items[0]?.dir === 'desc' ? '<' : '>';
		if (items.length === 1) return `${exprs[0]?.expr} ${op} ${param(0)}`;
		return `(${exprs.map((e) => e.expr).join(', ')}) ${op} (${items.map((_, i) => param(i)).join(', ')})`;
	}
	const branches: string[] = [];
	for (let i = 0; i < items.length; i += 1) {
		const parts: string[] = [];
		for (let j = 0; j < i; j += 1) {
			const e = exprs[j] as (typeof exprs)[number];
			parts.push(values[j] === null ? `${e.expr} IS NULL` : `${e.expr} = ${param(j)}`);
		}
		const e = exprs[i] as (typeof exprs)[number];
		const value = values[i] ?? null;
		const asc = items[i]?.dir === 'asc';
		let after: string | null;
		if (asc) {
			// NULLS LAST: nothing follows a NULL; NULLs follow every value.
			after = value === null ? null : e.nullable ? `(${e.expr} > ${param(i)} OR ${e.expr} IS NULL)` : `${e.expr} > ${param(i)}`;
		} else {
			// NULLS FIRST: every value follows a NULL; only smaller values follow a value.
			after = value === null ? `${e.expr} IS NOT NULL` : `${e.expr} < ${param(i)}`;
		}
		if (after === null) continue;
		parts.push(after);
		branches.push(parts.length === 1 ? (parts[0] as string) : `(${parts.join(' AND ')})`);
	}
	return branches.length === 0 ? 'FALSE' : `(${branches.join(' OR ')})`;
}

// ---------------------------------------------------------------- cursors

interface CursorBody {
	v: 1;
	/** Order signature, so a cursor from another sort is refused rather than misread. */
	s: string;
	k?: Cell[];
	o?: number;
}

export function encodeCursor(body: Omit<CursorBody, 'v'>): string {
	return Buffer.from(JSON.stringify({ v: 1, ...body })).toString('base64url');
}

export function decodeCursor(cursor: string, signature: string): { keys?: Cell[]; offset?: number } {
	let body: CursorBody;
	try {
		body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorBody;
	} catch {
		throw new StudioError('bad_request', 'The browse cursor is not valid.');
	}
	if (body?.v !== 1 || typeof body.s !== 'string') throw new StudioError('bad_request', 'The browse cursor is not valid.');
	if (body.s !== signature)
		throw new StudioError('bad_request', 'The cursor belongs to another sort order; start from the first page.');
	if (Array.isArray(body.k)) return { keys: body.k };
	if (typeof body.o === 'number' && Number.isSafeInteger(body.o) && body.o >= 0) return { offset: body.o };
	throw new StudioError('bad_request', 'The browse cursor is not valid.');
}

// ---------------------------------------------------------------- browse

/** How one browse result column is read back. */
export interface SelectedColumn {
	column: ColumnMeta;
	/** Index of the value in the result row. */
	index: number;
	/** Index of the full size (octet_length) when the value is a server-side preview. */
	sizeIndex?: number;
	preview: 'text' | 'bytes' | 'json' | null;
}

export interface BrowsePlan {
	text: string;
	params: (string | null)[];
	selected: SelectedColumn[];
	order: OrderItem[];
	mode: 'keyset' | 'offset';
	offset: number;
	signature: string;
	/** Index of the hidden `ctid::text` column, when it is the tiebreak. */
	ctidIndex?: number;
}

/**
 * One browse page. Keyset paging on (sort columns…, primary key) — or `ctid` for key-less
 * tables — so pages stay stable under concurrent inserts; views and other key-less objects
 * fall back to OFFSET. Fetches `limit + 1` rows to know whether there is a next page.
 */
export function buildBrowse(table: TableMeta, query: BrowseQuery, previewBytes = CELL_PREVIEW_BYTES): BrowsePlan {
	if (query.native !== undefined) throw new StudioError('unsupported', 'Postgres browse takes column filters, not a native filter.');
	const byName = new Map(table.columns.map((c) => [c.name, c]));
	const params = new Params();
	const selected: SelectedColumn[] = [];
	const selectList: string[] = [];
	for (const column of table.columns) {
		const ident = quoteIdent(column.name);
		const preview = previewMode(column.kind, column.typeOid);
		const entry: SelectedColumn = { column, index: selectList.length, preview };
		if (preview === 'bytes') {
			selectList.push(`substring(${ident} from 1 for ${previewBytes})`);
			entry.sizeIndex = selectList.length;
			selectList.push(`octet_length(${ident})`);
		} else if (preview) {
			selectList.push(`left(${ident}::text, ${previewBytes})`);
			entry.sizeIndex = selectList.length;
			selectList.push(`octet_length(${ident}::text)`);
		} else if (column.kind === 'datetime' || column.kind === 'date') {
			// Text keeps microseconds that a JS Date would drop.
			selectList.push(`${ident}::text`);
		} else if (column.kind === 'array' && (column.elemKind === 'datetime' || column.elemKind === 'date')) {
			selectList.push(`${ident}::text[]`);
		} else selectList.push(ident);
		selected.push(entry);
	}

	const order: OrderItem[] = [];
	const seen = new Set<string>();
	for (const sort of query.sort) {
		const column = byName.get(sort.column);
		if (!column) throw new StudioError('bad_request', `Unknown sort column "${sort.column}".`);
		if (seen.has(column.name)) continue;
		seen.add(column.name);
		order.push({ column, dir: sort.dir });
	}
	let mode: BrowsePlan['mode'] = 'keyset';
	let ctidIndex: number | undefined;
	if (table.primaryKey && table.primaryKey.length > 0) {
		for (const name of table.primaryKey) {
			const column = byName.get(name);
			if (!column) throw new StudioError('internal', `Primary key column "${name}" is missing.`);
			if (!seen.has(name)) order.push({ column, dir: 'asc' });
		}
	} else if (table.ctid) {
		order.push({ column: 'ctid', dir: 'asc' });
		ctidIndex = selectList.length;
		selectList.push('ctid::text');
	} else mode = 'offset';

	const signature = JSON.stringify(order.map((item) => [item.column === 'ctid' ? '' : item.column.name, item.dir]));
	const where = buildFilters(query.filter, byName, params);
	let offset = 0;
	if (query.cursor) {
		const cursor = decodeCursor(query.cursor, signature);
		if (mode === 'keyset') {
			if (!cursor.keys) throw new StudioError('bad_request', 'The browse cursor is not valid.');
			where.push(keysetCondition(order, cursor.keys, params));
		} else {
			if (cursor.offset === undefined) throw new StudioError('bad_request', 'The browse cursor is not valid.');
			offset = cursor.offset;
		}
	}
	const text =
		`SELECT ${selectList.join(', ')} FROM ${qualified(table.schema, table.name)} AS ${SOURCE_ALIAS}` +
		(where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
		orderBy(order) +
		` LIMIT ${query.limit + 1}` +
		(offset > 0 ? ` OFFSET ${offset}` : '');
	return { text, params: params.values, selected, order, mode, offset, signature, ...(ctidIndex !== undefined ? { ctidIndex } : {}) };
}
