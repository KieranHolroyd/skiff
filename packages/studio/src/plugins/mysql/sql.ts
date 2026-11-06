/**
 * Pure SQL helpers for the MySQL/MariaDB plugin: a lexer and statement splitter for `run`, the
 * read-only statement classifier, the per-dialect timeout wrapper, and SQL generation for
 * `browse`, `apply` and `value`. Nothing here touches a connection, so all of it is unit-tested.
 *
 * Identifiers are only ever names that `describe` returned, backtick-quoted. Values are always
 * `?` placeholders for server-side prepared statements (never client-side escaping, which
 * would be unsafe under `NO_BACKSLASH_ESCAPES`).
 */
import { cellToParam, isTagged } from '../../cells.ts';
import { StudioError, type BrowseQuery, type Cell, type CellKind, type FilterOp } from '../../protocol.ts';

export type Dialect = 'mysql' | 'mariadb';

// ---------------------------------------------------------------- quoting

export function quoteIdent(name: string): string {
	if (name.length === 0 || name.includes('\u0000'))
		throw new StudioError('bad_request', 'An identifier must be non-empty and contain no NUL character.');
	return `\`${name.replaceAll('`', '``')}\``;
}

// ---------------------------------------------------------------- lexer

export type TokenKind = 'word' | 'string' | 'ident' | 'comment' | 'hint' | 'exec-comment' | 'punct';

export interface Token {
	kind: TokenKind;
	start: number;
	end: number;
	text: string;
}

const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Tokenise MySQL/MariaDB SQL just enough to split statements and classify them. Strings honour
 * backslash escapes and doubled quotes; backtick identifiers honour doubled backticks.
 * `-- ` needs trailing whitespace (MySQL treats `--1` as minus minus one). `/*! … *\/` and
 * `/*M! … *\/` are executable comments: the server runs their body, so they are not comments.
 * Unterminated strings and comments run to the end of the input; the server reports them.
 */
export function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	const n = input.length;
	let i = 0;
	const push = (kind: TokenKind, start: number, end: number) =>
		tokens.push({ kind, start, end, text: input.slice(start, end) });
	while (i < n) {
		const c = input[i] as string;
		const next = input[i + 1];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
			i += 1;
			continue;
		}
		if (c === '#' || (c === '-' && next === '-' && (i + 2 >= n || (input.charCodeAt(i + 2) <= 32)))) {
			const start = i;
			while (i < n && input[i] !== '\n') i += 1;
			push('comment', start, i);
			continue;
		}
		if (c === '/' && next === '*') {
			const start = i;
			const body = input.slice(i + 2, i + 4);
			const kind: TokenKind =
				body.startsWith('!') || body === 'M!' ? 'exec-comment' : body.startsWith('+') ? 'hint' : 'comment';
			const close = input.indexOf('*/', i + 2);
			i = close < 0 ? n : close + 2;
			push(kind, start, i);
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const start = i;
			i += 1;
			while (i < n) {
				const ch = input[i];
				if (ch === '\\' && c !== '`') {
					i += 2;
					continue;
				}
				if (ch === c) {
					if (input[i + 1] === c) {
						i += 2;
						continue;
					}
					i += 1;
					break;
				}
				i += 1;
			}
			push(c === '`' ? 'ident' : 'string', start, Math.min(i, n));
			continue;
		}
		if (WORD.test(c)) {
			const start = i;
			while (i < n && WORD.test(input[i] as string)) i += 1;
			push('word', start, i);
			continue;
		}
		push('punct', i, i + 1);
		i += 1;
	}
	return tokens;
}

// ---------------------------------------------------------------- statements

export interface Statement {
	text: string;
	/** Offset of `text` in the original input (0-based). */
	offset: number;
	/** Tokens with offsets relative to `text`. */
	tokens: Token[];
}

const isTrivia = (token: Token) => token.kind === 'comment' || token.kind === 'hint';

/** Tokens the server executes: everything except plain comments and optimizer hints. */
export function codeTokens(statement: Statement): Token[] {
	return statement.tokens.filter((token) => !isTrivia(token));
}

/** Upper-cased leading keyword, or null when the statement does not start with a word. */
export function leadingKeyword(statement: Statement): string | null {
	const first = codeTokens(statement)[0];
	return first?.kind === 'word' ? first.text.toUpperCase() : null;
}

/**
 * Split `input` on top-level `;`. Comment-only fragments are dropped. `DELIMITER` is a mysql
 * command-line client directive, not SQL, so it is refused with an explanation.
 */
export function splitStatements(input: string): Statement[] {
	const tokens = tokenize(input);
	const statements: Statement[] = [];
	let group: Token[] = [];
	const flush = () => {
		const first = group[0];
		const last = group.at(-1);
		if (first && last && group.some((token) => !isTrivia(token))) {
			const offset = first.start;
			const statement: Statement = {
				text: input.slice(offset, last.end),
				offset,
				tokens: group.map((token) => ({ ...token, start: token.start - offset, end: token.end - offset })),
			};
			if (leadingKeyword(statement) === 'DELIMITER')
				throw new StudioError(
					'unsupported',
					'DELIMITER is a mysql client command, not SQL, and is not supported here. Separate statements with ";". ' +
						'Procedure, function and trigger bodies with BEGIN … END cannot be created from the studio editor.',
				);
			statements.push(statement);
		}
		group = [];
	};
	for (const token of tokens) {
		if (token.kind === 'punct' && token.text === ';') flush();
		else group.push(token);
	}
	flush();
	return statements;
}

// ---------------------------------------------------------------- read-only classification

const TRANSACTION_CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'XA']);
const PREPARED = new Set(['PREPARE', 'EXECUTE', 'DEALLOCATE']);
const COMPOUND = new Set(['IF', 'WHILE', 'LOOP', 'REPEAT', 'CASE', 'DECLARE', 'FOR']);
const TRANSACTION_SETTINGS = new Set(['TRANSACTION', 'TRANSACTION_READ_ONLY', 'TX_READ_ONLY', 'AUTOCOMMIT', 'PASSWORD']);

/**
 * Statement classes refused in a read-only session, on top of the per-statement read-only
 * transaction. Each closes an escape the e2e suite found or that defeats the wrapper:
 *
 * - `CALL`: a procedure can `SET SESSION transaction_read_only = OFF; COMMIT; DELETE …` inside
 *   one statement (verified on MySQL 8.4 and MariaDB 11.8).
 * - `PREPARE`/`EXECUTE` (and MariaDB `EXECUTE IMMEDIATE`): run any of the above indirectly.
 * - MariaDB `SET STATEMENT transaction_read_only=0 FOR CREATE …`: DDL commits the read-only
 *   transaction implicitly and then runs read-write (verified on MariaDB 11.8).
 * - Compound statements (MariaDB `BEGIN NOT ATOMIC`, `IF`, loops): several statements in one.
 * - Transaction control and changing the transaction mode: the wrapper owns both.
 * - Executable comments: their body is code that the classifier cannot see as keywords.
 * - `SELECT … INTO OUTFILE/DUMPFILE` writes server files; `ANALYZE TABLE` writes statistics.
 */
export function readOnlyRefusal(statement: Statement): string | null {
	const code = codeTokens(statement);
	if (code.some((token) => token.kind === 'exec-comment'))
		return 'Executable comments (/*! … */) are not allowed in a read-only session.';
	const words = code.map((token) => (token.kind === 'word' ? token.text.toUpperCase() : token.text));
	const first = words[0] ?? '';
	if (code[1]?.text === ':') return 'Labelled compound statements are not allowed in a read-only session.';
	if (TRANSACTION_CONTROL.has(first))
		return 'Transaction control is not available in a read-only session: every statement already runs in its own read-only transaction.';
	if (first === 'CALL')
		return 'CALL is not allowed in a read-only session: a stored procedure can commit and switch the session to read-write.';
	if (PREPARED.has(first)) return 'Prepared statements (PREPARE/EXECUTE) are not allowed in a read-only session.';
	if (COMPOUND.has(first)) return 'Compound statements are not allowed in a read-only session.';
	if (first === 'SET') {
		if (words[1] === 'STATEMENT') return 'SET STATEMENT … FOR is not allowed in a read-only session.';
		if (words.some((word) => TRANSACTION_SETTINGS.has(word)))
			return 'Changing the transaction mode, autocommit or a password is not allowed in a read-only session.';
	}
	if (first === 'ANALYZE' && ['TABLE', 'TABLES', 'NO_WRITE_TO_BINLOG', 'LOCAL'].includes(words[1] ?? ''))
		return 'ANALYZE TABLE writes statistics and is not allowed in a read-only session.';
	for (let i = 0; i < words.length - 1; i += 1)
		if (words[i] === 'INTO' && (words[i + 1] === 'OUTFILE' || words[i + 1] === 'DUMPFILE'))
			return 'SELECT … INTO OUTFILE/DUMPFILE writes server files and is not allowed in a read-only session.';
	return null;
}

// ---------------------------------------------------------------- timeouts

const MARIADB_TIMED = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES', 'TABLE', 'CALL']);

/**
 * Add the server-side statement timeout for `dialect`. It is a backstop: the plugin's
 * client-side timer fires first and kills the connection, because MySQL's
 * `MAX_EXECUTION_TIME` interrupts `SLEEP()` with a result of `1` rather than an error.
 *
 * - MySQL: a `/*+ MAX_EXECUTION_TIME(ms) *\/` hint right after a top-level `SELECT` (the only
 *   place MySQL honours it), merged into an existing hint comment if there is one.
 * - MariaDB: `SET STATEMENT max_statement_time = <s> FOR <statement>` for queries and DML.
 *   Statements that already start with `SET` are left alone (SET STATEMENT does not nest).
 */
export function withStatementTimeout(statement: Statement, dialect: Dialect, timeoutMs: number): string {
	const ms = Math.max(1, Math.round(timeoutMs));
	const code = codeTokens(statement);
	const first = code[0];
	if (!first) return statement.text;
	const keyword = first.kind === 'word' ? first.text.toUpperCase() : first.text;
	const { text } = statement;
	if (dialect === 'mysql') {
		if (keyword !== 'SELECT') return text;
		const after = statement.tokens[statement.tokens.indexOf(first) + 1];
		if (after?.kind === 'hint')
			return `${text.slice(0, after.start + 3)} MAX_EXECUTION_TIME(${ms})${text.slice(after.start + 3)}`;
		return `${text.slice(0, first.end)} /*+ MAX_EXECUTION_TIME(${ms}) */${text.slice(first.end)}`;
	}
	if (!MARIADB_TIMED.has(keyword) && keyword !== '(') return text;
	return `SET STATEMENT max_statement_time=${(ms / 1_000).toFixed(3)} FOR ${text}`;
}

// ---------------------------------------------------------------- tables and parameters

export interface ColumnMeta {
	name: string;
	kind: CellKind;
	nativeType: string;
	nullable: boolean;
	unsigned: boolean;
	generated: boolean;
	autoIncrement: boolean;
}

export interface TableMeta {
	name: string;
	view: boolean;
	columns: ColumnMeta[];
	primaryKey: string[] | null;
}

/** A bind parameter. `typed` values go out as an explicit MySQL type so comparisons stay exact. */
export type Param = null | string | number | Buffer | TypedParam;
export interface TypedParam {
	typed: 'BIGINT' | 'BIGINT UNSIGNED' | 'DECIMAL';
	value: string;
}

export function isTypedParam(param: Param): param is TypedParam {
	return typeof param === 'object' && param !== null && !Buffer.isBuffer(param);
}

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A UI cell → a bind parameter for `column`. BIGINT and DECIMAL are sent typed: a string
 * parameter compared with a numeric column is compared as a double, which is not exact past
 * 2^53. JSON is sent as its text, which both servers parse on assignment.
 */
export function cellParam(cell: Cell, column: ColumnMeta): Param {
	if (cell === null) return null;
	if (isTagged(cell) && cell.$t === 'truncated')
		throw new StudioError('bad_request', `The value for ${column.name} is a truncated preview; load the full value first.`);
	let value: unknown;
	try {
		value = cellToParam(cell);
	} catch (error) {
		throw new StudioError('bad_request', error instanceof Error ? error.message : String(error));
	}
	if (column.kind === 'json') return JSON.stringify(value);
	if (column.kind === 'bigint') {
		const text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value).trim();
		if (!INTEGER.test(text)) throw new StudioError('bad_request', `${column.name} needs an integer, not ${JSON.stringify(text)}.`);
		return { typed: column.unsigned ? 'BIGINT UNSIGNED' : 'BIGINT', value: text.replace(/^\+/, '') };
	}
	if (column.kind === 'decimal') {
		const text = String(value).trim();
		if (!DECIMAL.test(text)) throw new StudioError('bad_request', `${column.name} needs a decimal number, not ${JSON.stringify(text)}.`);
		return { typed: 'DECIMAL', value: text };
	}
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number' || typeof value === 'string' || Buffer.isBuffer(value)) return value;
	throw new StudioError('bad_request', `${column.name} cannot hold a ${Array.isArray(value) ? 'list' : 'structured'} value.`);
}

export interface SqlFragment {
	sql: string;
	params: Param[];
}

/**
 * Null-safe equality of `column` with `cell`. JSON compares as JSON: MySQL casts the parameter,
 * MariaDB (JSON stored as text) uses `JSON_EQUALS`, so formatting differences are not conflicts.
 */
export function equalsSql(column: ColumnMeta, cell: Cell, dialect: Dialect): SqlFragment {
	const name = quoteIdent(column.name);
	const param = cellParam(cell, column);
	if (param === null) return { sql: `${name} IS NULL`, params: [] };
	if (column.kind === 'json')
		return dialect === 'mysql'
			? { sql: `${name} <=> CAST(? AS JSON)`, params: [param] }
			: { sql: `JSON_EQUALS(${name}, ?) <=> 1`, params: [param] };
	return { sql: `${name} <=> ?`, params: [param] };
}

export function findColumn(table: TableMeta, name: string): ColumnMeta {
	const column = table.columns.find((c) => c.name === name);
	if (!column) throw new StudioError('bad_request', `${table.name} has no column ${JSON.stringify(name)}.`);
	return column;
}

const COMPARISONS: Partial<Record<FilterOp, string>> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function filterSql(
	table: TableMeta,
	filter: { column: string; op: FilterOp; value?: Cell },
	dialect: Dialect,
): SqlFragment {
	const column = findColumn(table, filter.column);
	const name = quoteIdent(column.name);
	const needValue = (): Cell => {
		if (filter.value === undefined || filter.value === null)
			throw new StudioError('bad_request', `The ${filter.op} filter on ${column.name} needs a value.`);
		return filter.value;
	};
	switch (filter.op) {
		case 'eq':
			return equalsSql(column, filter.value ?? null, dialect);
		case 'ne': {
			const equal = equalsSql(column, filter.value ?? null, dialect);
			return { sql: `NOT (${equal.sql})`, params: equal.params };
		}
		case 'lt':
		case 'lte':
		case 'gt':
		case 'gte':
			return { sql: `${name} ${COMPARISONS[filter.op]} ?`, params: [cellParam(needValue(), column)] };
		case 'like':
			return { sql: `${name} LIKE ?`, params: [String(cellToParam(needValue()))] };
		case 'ilike':
			// LIKE is already case-insensitive under *_ci collations, not under binary or *_cs ones.
			return { sql: `LOWER(${name}) LIKE LOWER(?)`, params: [String(cellToParam(needValue()))] };
		case 'in': {
			const value = needValue();
			if (!Array.isArray(value)) throw new StudioError('bad_request', `The in filter on ${column.name} needs a list.`);
			if (value.length === 0) return { sql: '0 = 1', params: [] };
			return {
				sql: `${name} IN (${value.map(() => '?').join(', ')})`,
				params: value.map((item) => cellParam(item, column)),
			};
		}
		case 'is-null':
			return { sql: `${name} IS NULL`, params: [] };
		case 'not-null':
			return { sql: `${name} IS NOT NULL`, params: [] };
	}
}

// ---------------------------------------------------------------- browse

export type BrowseCursor = { m: 'k'; a: Cell[] } | { m: 'o'; o: number };

export function encodeCursor(cursor: BrowseCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(text: string): BrowseCursor {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
		if (typeof parsed === 'object' && parsed !== null) {
			const cursor = parsed as Record<string, unknown>;
			if (cursor.m === 'k' && Array.isArray(cursor.a)) return { m: 'k', a: cursor.a as Cell[] };
			if (cursor.m === 'o' && Number.isSafeInteger(cursor.o) && (cursor.o as number) >= 0)
				return { m: 'o', o: cursor.o as number };
		}
	} catch {
		// Fall through to the error below.
	}
	throw new StudioError('bad_request', 'The browse cursor is not valid.');
}

export interface BrowsePlan extends SqlFragment {
	/** `keyset` pages on the primary key; `offset` is the fallback for other sorts. */
	mode: 'keyset' | 'offset';
	/** Rows fetched: one more than the page, to know whether there is a next page. */
	fetch: number;
	limit: number;
	offset: number;
}

/** Columns that give a stable order when a table has no primary key. */
function orderableWithoutKey(column: ColumnMeta): boolean {
	return column.kind !== 'json' && column.kind !== 'bytes';
}

/**
 * One page of `table`.
 *
 * - **Keyset** when there is a primary key and the sort is empty or exactly the key in one
 *   direction: `WHERE (pk…) > (?…) ORDER BY pk… LIMIT n+1`. The cursor carries the last key.
 * - **Offset** otherwise (documented fallback): `ORDER BY <sort>, <pk or every orderable
 *   column> LIMIT n+1 OFFSET o`. The tie-breaker keeps pages from overlapping; concurrent
 *   inserts can still shift rows between pages, which keyset paging avoids.
 */
export function buildBrowse(table: TableMeta, query: BrowseQuery, dialect: Dialect): BrowsePlan {
	const limit = query.limit;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new StudioError('bad_request', 'The page size must be a positive integer.');
	const select = table.columns.map((column) => quoteIdent(column.name)).join(', ');
	const where: string[] = [];
	const params: Param[] = [];
	for (const filter of query.filter) {
		const fragment = filterSql(table, filter, dialect);
		where.push(fragment.sql);
		params.push(...fragment.params);
	}
	for (const sort of query.sort) findColumn(table, sort.column);
	const pk = table.primaryKey;
	const firstDir = query.sort[0]?.dir ?? 'asc';
	const keyset =
		pk !== null &&
		pk.length > 0 &&
		(query.sort.length === 0 ||
			(query.sort.length === pk.length && query.sort.every((sort, i) => sort.column === pk[i] && sort.dir === firstDir)));
	const cursor = query.cursor ? decodeCursor(query.cursor) : null;
	const fetch = limit + 1;
	const from = `SELECT ${select} FROM ${quoteIdent(table.name)}`;
	const whereSql = () => (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '');
	if (keyset && pk) {
		const dir = firstDir === 'desc' ? 'DESC' : 'ASC';
		if (cursor) {
			if (cursor.m !== 'k' || cursor.a.length !== pk.length)
				throw new StudioError('bad_request', 'The browse cursor does not match this sort.');
			const keyColumns = pk.map((name) => findColumn(table, name));
			const names = keyColumns.map((column) => quoteIdent(column.name));
			const op = dir === 'ASC' ? '>' : '<';
			where.push(
				names.length === 1
					? `${names[0]} ${op} ?`
					: `(${names.join(', ')}) ${op} (${names.map(() => '?').join(', ')})`,
			);
			params.push(...keyColumns.map((column, i) => cellParam(cursor.a[i] ?? null, column)));
		}
		const order = pk.map((name) => `${quoteIdent(name)} ${dir}`).join(', ');
		return { sql: `${from}${whereSql()} ORDER BY ${order} LIMIT ${fetch}`, params, mode: 'keyset', fetch, limit, offset: 0 };
	}
	if (cursor && cursor.m !== 'o') throw new StudioError('bad_request', 'The browse cursor does not match this sort.');
	const offset = cursor?.m === 'o' ? cursor.o : 0;
	const order = query.sort.map((sort) => `${quoteIdent(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`);
	const sorted = new Set(query.sort.map((sort) => sort.column));
	const tieBreak = pk ?? table.columns.filter(orderableWithoutKey).map((column) => column.name);
	for (const name of tieBreak) if (!sorted.has(name)) order.push(`${quoteIdent(name)} ASC`);
	const orderSql = order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '';
	return {
		sql: `${from}${whereSql()}${orderSql} LIMIT ${fetch} OFFSET ${offset}`,
		params,
		mode: 'offset',
		fetch,
		limit,
		offset,
	};
}

/** The cursor for the page after `plan`, given the last row's primary-key cells. */
export function nextCursor(plan: BrowsePlan, lastKey: Cell[] | null): string {
	if (plan.mode === 'keyset' && lastKey) return encodeCursor({ m: 'k', a: lastKey });
	return encodeCursor({ m: 'o', o: plan.offset + plan.limit });
}

// ---------------------------------------------------------------- apply and value

function requireKeyed(table: TableMeta): string[] {
	if (table.view) throw new StudioError('unsupported', `${table.name} is a view and cannot be edited.`);
	if (!table.primaryKey || table.primaryKey.length === 0)
		throw new StudioError('unsupported', `${table.name} has no primary key, so rows cannot be identified for editing.`);
	return table.primaryKey;
}

/** `pk1 = ? AND pk2 = ?` for a full, non-NULL primary key. */
export function keyWhere(table: TableMeta, key: Record<string, Cell>): SqlFragment {
	const pk = requireKeyed(table);
	for (const name of Object.keys(key))
		if (!pk.includes(name)) throw new StudioError('bad_request', `${name} is not part of the primary key of ${table.name}.`);
	const parts: string[] = [];
	const params: Param[] = [];
	for (const name of pk) {
		const cell = key[name];
		if (cell === undefined) throw new StudioError('bad_request', `The key must include the primary-key column ${name}.`);
		if (cell === null) throw new StudioError('bad_request', 'A NULL key cannot identify a row.');
		parts.push(`${quoteIdent(name)} = ?`);
		params.push(cellParam(cell, findColumn(table, name)));
	}
	return { sql: parts.join(' AND '), params };
}

function originalWhere(table: TableMeta, original: Record<string, Cell> | undefined, dialect: Dialect): SqlFragment {
	const parts: string[] = [];
	const params: Param[] = [];
	for (const [name, cell] of Object.entries(original ?? {})) {
		const fragment = equalsSql(findColumn(table, name), cell, dialect);
		parts.push(fragment.sql);
		params.push(...fragment.params);
	}
	return { sql: parts.map((part) => ` AND ${part}`).join(''), params };
}

/**
 * `UPDATE … SET … WHERE pk = ? AND <edited> <=> ?original`. The connection uses
 * `CLIENT_FOUND_ROWS`, so `affectedRows` counts matched rows and a no-op update still counts 1.
 */
export function buildUpdate(
	table: TableMeta,
	change: { key: Record<string, Cell>; values: Record<string, Cell>; original: Record<string, Cell> },
	dialect: Dialect,
): SqlFragment {
	const key = keyWhere(table, change.key);
	const entries = Object.entries(change.values);
	if (entries.length === 0) throw new StudioError('bad_request', 'An update must change at least one column.');
	const sets: string[] = [];
	const params: Param[] = [];
	for (const [name, cell] of entries) {
		const column = findColumn(table, name);
		if (column.generated || column.autoIncrement)
			throw new StudioError('bad_request', `${name} is ${column.generated ? 'generated' : 'auto_increment'} and cannot be edited.`);
		sets.push(`${quoteIdent(name)} = ?`);
		params.push(cellParam(cell, column));
	}
	const original = originalWhere(table, change.original, dialect);
	return {
		sql: `UPDATE ${quoteIdent(table.name)} SET ${sets.join(', ')} WHERE ${key.sql}${original.sql}`,
		params: [...params, ...key.params, ...original.params],
	};
}

export function buildInsert(table: TableMeta, values: Record<string, Cell>): SqlFragment {
	requireKeyed(table);
	const names: string[] = [];
	const params: Param[] = [];
	for (const [name, cell] of Object.entries(values)) {
		const column = findColumn(table, name);
		if (column.generated) throw new StudioError('bad_request', `${name} is generated and cannot be set.`);
		names.push(quoteIdent(name));
		params.push(cellParam(cell, column));
	}
	return {
		sql: `INSERT INTO ${quoteIdent(table.name)} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
		params,
	};
}

export function buildDelete(
	table: TableMeta,
	change: { key: Record<string, Cell>; original?: Record<string, Cell> },
	dialect: Dialect,
): SqlFragment {
	const key = keyWhere(table, change.key);
	const original = originalWhere(table, change.original, dialect);
	return {
		sql: `DELETE FROM ${quoteIdent(table.name)} WHERE ${key.sql}${original.sql}`,
		params: [...key.params, ...original.params],
	};
}

export function buildValue(table: TableMeta, key: Record<string, Cell>, column: string): SqlFragment {
	const target = findColumn(table, column);
	const where = keyWhere(table, key);
	return {
		sql: `SELECT ${quoteIdent(target.name)} FROM ${quoteIdent(table.name)} WHERE ${where.sql}`,
		params: where.params,
	};
}

// ---------------------------------------------------------------- errors

/** 1-based offset into the run input of a MySQL 1064 "near '…'" snippet, when it can be found. */
export function syntaxErrorPosition(statement: Statement, message: string): number | undefined {
	const near = /near '([\s\S]*)' at line \d+\s*$/.exec(message);
	if (!near) return undefined;
	const snippet = near[1] ?? '';
	if (snippet === '') return statement.offset + statement.text.length + 1;
	const index = statement.text.indexOf(snippet);
	return index < 0 ? undefined : statement.offset + index + 1;
}
