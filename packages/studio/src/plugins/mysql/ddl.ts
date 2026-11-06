/**
 * Structure edits (`alter`) for MySQL/MariaDB, rendered as DDL. Pure: the session reads the
 * current column from `information_schema` and passes it in, so all of this is unit-tested.
 *
 * DDL cannot take bound parameters, so this is the one place the plugin writes values into SQL
 * text. Identifiers are backtick-quoted, column types and default expressions are re-checked
 * against the protocol's patterns, and string literals escape both `\` and `'` (the server's
 * default `sql_mode` honours backslash escapes; doubling `'` is safe either way).
 */
import {
	COLUMN_TYPE_PATTERN,
	DEFAULT_EXPRESSION_PATTERN,
	StudioError,
	type ColumnDefault,
	type ColumnSpec,
	type ObjectRef,
	type SchemaChange,
	type SchemaChangeOp,
} from '../../protocol.ts';
import { quoteIdent, type Dialect } from './sql.ts';

/** What the plugin accepts. No `create-schema`: the owner only has its own database. */
export const MYSQL_STRUCTURE: SchemaChangeOp[] = [
	'create-table',
	'rename',
	'drop',
	'truncate',
	'add-column',
	'drop-column',
	'rename-column',
	'alter-column',
	'create-index',
	'drop-index',
];

/** MySQL/MariaDB identifier limit, in characters. */
const MAX_IDENTIFIER = 64;

/** A column as `information_schema.COLUMNS` (plus the MariaDB JSON check) describes it. */
export interface CurrentColumn {
	name: string;
	dataType: string;
	columnType: string;
	nullable: boolean;
	/** `COLUMN_DEFAULT` exactly as the server returned it. */
	default: string | null;
	extra: string;
	comment: string;
	collation: string | null;
	generation: string | null;
	/** MariaDB: a `json_valid()` CHECK marks the LONGTEXT as JSON. */
	json: boolean;
}

function bad(message: string): StudioError {
	return new StudioError('bad_request', message);
}

/** A string literal; `\` and `'` are escaped, NUL is refused. */
export function stringLiteral(value: string): string {
	if (value.includes('\u0000')) throw bad('A default value cannot contain a NUL character.');
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function checkType(type: string): string {
	const trimmed = type.trim();
	if (!COLUMN_TYPE_PATTERN.test(trimmed)) throw bad(`"${type}" is not a column type the studio accepts.`);
	return trimmed;
}

/** Keywords MySQL accepts bare as a default (the TIMESTAMP/DATETIME exception) or as values. */
const BARE_DEFAULT = /^(?:current_timestamp|now|localtime|localtimestamp)(?:\(\s*\d{0,2}\s*\))?$|^(?:null|true|false)$/i;

/** A requested default as SQL. Expression defaults that are not bare keywords get parentheses. */
export function defaultSql(value: ColumnDefault): string {
	if ('literal' in value) {
		const literal = value.literal;
		if (typeof literal === 'boolean') return literal ? 'TRUE' : 'FALSE';
		if (typeof literal === 'number') {
			if (!Number.isFinite(literal)) throw bad('A numeric default must be finite.');
			return String(literal);
		}
		return stringLiteral(literal);
	}
	const expression = value.expression.trim();
	if (!DEFAULT_EXPRESSION_PATTERN.test(expression))
		throw bad(`"${value.expression}" is not a default expression the studio accepts.`);
	return BARE_DEFAULT.test(expression) ? expression : `(${expression})`;
}

/**
 * A default for `ALTER COLUMN … SET DEFAULT`. MySQL's grammar there takes a literal or a
 * parenthesised expression only, not the bare `CURRENT_TIMESTAMP` that column definitions allow.
 */
export function setDefaultSql(value: ColumnDefault, dialect: Dialect): string {
	const sql = defaultSql(value);
	if (dialect === 'mysql' && 'expression' in value && !sql.startsWith('(') && !/^(?:null|true|false)$/i.test(sql))
		return `(${sql})`;
	return sql;
}

/** Default already in the catalog? Then a bare `CURRENT_TIMESTAMP`-style keyword or `(expr)`. */
const STORED_KEYWORD = /^(?:current_timestamp|now|localtime|localtimestamp)(?:\(\d*\))?$/i;

/**
 * The column's current default as SQL, from `COLUMN_DEFAULT`, or null when it has none.
 *
 * - MariaDB stores SQL text: `'quoted'` literals, numbers, expressions, and `NULL` for an
 *   explicit `DEFAULT NULL`. It is used verbatim.
 * - MySQL stores literals raw (quoted here, except `b'…'` bit and `0x…` binary values, which
 *   it prints in that form) and expressions with `DEFAULT_GENERATED` in `EXTRA`, quotes
 *   backslash-escaped (`concat(_utf8mb4\'a\')`).
 */
export function currentDefaultSql(column: CurrentColumn, dialect: Dialect): string | null {
	const stored = column.default;
	if (stored === null) return null;
	if (dialect === 'mariadb') return stored.toUpperCase() === 'NULL' ? null : stored;
	if (/\bDEFAULT_GENERATED\b/i.test(column.extra)) {
		const expression = stored.replaceAll("\\'", "'");
		return STORED_KEYWORD.test(expression) ? expression : `(${expression})`;
	}
	const type = column.dataType.toLowerCase();
	if (type === 'bit' && /^b'[01]*'$/i.test(stored)) return stored;
	if (/binary|blob/.test(type) && /^0x[0-9a-f]*$/i.test(stored)) return stored;
	return stringLiteral(stored);
}

/** `ON UPDATE CURRENT_TIMESTAMP(n)` from `EXTRA`, if present. */
function onUpdate(extra: string): string | null {
	const match = /\bon update ([a-z_]+(?:\(\d*\))?)/i.exec(extra);
	return match?.[1] ? `ON UPDATE ${match[1]}` : null;
}

export function isGenerated(column: CurrentColumn): boolean {
	return Boolean(column.generation?.trim()) || /\b(?:virtual|stored|persistent) generated\b/i.test(column.extra);
}

function columnDefinition(spec: ColumnSpec): string {
	const parts = [quoteIdent(spec.name), checkType(spec.type), spec.nullable ? 'NULL' : 'NOT NULL'];
	if (spec.default !== undefined) parts.push(`DEFAULT ${defaultSql(spec.default)}`);
	if (spec.identity) parts.push('AUTO_INCREMENT');
	return parts.join(' ');
}

function tableName(object: ObjectRef, kinds: readonly string[], what: string): string {
	const [name] = object.path;
	if (object.path.length !== 1 || name === undefined || !kinds.includes(object.kind))
		throw bad(`${what} needs a ${kinds.join(' or ')} at the top of the tree, not ${object.kind} ${object.path.join('.')}.`);
	return name;
}

/** `<table>_<columns>_idx`, cut to the identifier limit. */
export function indexName(table: string, columns: readonly string[]): string {
	return [...`${table}_${columns.join('_')}`].slice(0, MAX_IDENTIFIER - 4).join('') + '_idx';
}

function createTable(change: Extract<SchemaChange, { op: 'create-table' }>): string {
	if (change.parent.length > 0)
		throw bad('Tables are created at the top of the tree: the session is scoped to one database.');
	const names = new Set<string>();
	for (const column of change.columns) {
		if (names.has(column.name)) throw bad(`Column ${column.name} is listed twice.`);
		names.add(column.name);
	}
	for (const key of change.primaryKey)
		if (!names.has(key)) throw bad(`Primary key column ${key} is not one of the table's columns.`);
	if (new Set(change.primaryKey).size !== change.primaryKey.length) throw bad('A primary key column is listed twice.');
	const identities = change.columns.filter((column) => column.identity);
	if (identities.length > 1) throw bad('A table can have only one AUTO_INCREMENT column.');
	const identity = identities[0];
	if (identity && !change.primaryKey.includes(identity.name))
		throw bad(`AUTO_INCREMENT column ${identity.name} must be part of the primary key.`);
	const lines = change.columns.map((column) => columnDefinition(column));
	if (change.primaryKey.length > 0) lines.push(`PRIMARY KEY (${change.primaryKey.map(quoteIdent).join(', ')})`);
	return `CREATE TABLE ${quoteIdent(change.name)} (\n  ${lines.join(',\n  ')}\n)`;
}

/**
 * `alter-column`. A default-only change is `ALTER COLUMN … SET/DROP DEFAULT` (unless the
 * column has `ON UPDATE`). Anything else is
 * `MODIFY COLUMN` with the whole definition, so the current default, `AUTO_INCREMENT`,
 * `ON UPDATE`, invisibility, comment and (for an unchanged type) collation are carried over.
 */
function alterColumn(
	change: Extract<SchemaChange, { op: 'alter-column' }>,
	current: CurrentColumn,
	dialect: Dialect,
): string {
	const table = quoteIdent(tableName(change.object, ['table'], 'Changing a column'));
	const column = quoteIdent(change.column);
	if (isGenerated(current)) throw bad(`${change.column} is a generated column; change it in the SQL editor.`);
	const sameType =
		change.type === undefined || checkType(change.type).toLowerCase() === current.columnType.toLowerCase();
	const sameNull = change.nullable === undefined || change.nullable === current.nullable;
	const update = onUpdate(current.extra);
	if (sameType && sameNull && change.default === undefined) throw bad('The change does not alter anything.');
	// MariaDB's ALTER COLUMN … DROP DEFAULT also drops ON UPDATE, so such columns always MODIFY.
	if (sameType && sameNull && change.default !== undefined && !update) {
		return change.default === null
			? `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`
			: `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${setDefaultSql(change.default, dialect)}`;
	}
	const nullable = change.nullable ?? current.nullable;
	// MariaDB's JSON is LONGTEXT plus a column CHECK; `json` re-creates the check.
	const type =
		change.type !== undefined && !sameType
			? checkType(change.type)
			: dialect === 'mariadb' && current.json
				? 'json'
				: current.columnType;
	const parts = [column, type];
	if (sameType && current.collation && /^[A-Za-z0-9_]+$/.test(current.collation) && !current.json)
		parts.push(`COLLATE ${current.collation}`);
	parts.push(nullable ? 'NULL' : 'NOT NULL');
	const def =
		change.default === undefined
			? currentDefaultSql(current, dialect)
			: change.default === null
				? null
				: defaultSql(change.default);
	if (def !== null) parts.push(`DEFAULT ${def}`);
	if (update) parts.push(update);
	if (/\bauto_increment\b/i.test(current.extra)) parts.push('AUTO_INCREMENT');
	if (/\binvisible\b/i.test(current.extra)) parts.push('INVISIBLE');
	if (current.comment) parts.push(`COMMENT ${stringLiteral(current.comment)}`);
	return `ALTER TABLE ${table} MODIFY COLUMN ${parts.join(' ')}`;
}

/**
 * DDL for one change. `current` is the column an `alter-column` acts on, as the catalog has it
 * (the session loads it from `information_schema.COLUMNS`).
 */
export function renderAlter(change: SchemaChange, dialect: Dialect, current?: CurrentColumn | null): string[] {
	switch (change.op) {
		case 'create-table':
			return [createTable(change)];
		case 'rename': {
			const from = tableName(change.object, ['table', 'view'], 'Renaming');
			return [`RENAME TABLE ${quoteIdent(from)} TO ${quoteIdent(change.name)}`];
		}
		case 'drop': {
			// MySQL accepts CASCADE but ignores it, so `cascade` changes nothing here.
			const name = tableName(change.object, ['table', 'view'], 'Dropping');
			return [`DROP ${change.object.kind === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdent(name)}`];
		}
		case 'truncate':
			return [`TRUNCATE TABLE ${quoteIdent(tableName(change.object, ['table'], 'Emptying'))}`];
		case 'add-column': {
			const table = tableName(change.object, ['table'], 'Adding a column');
			if (change.column.identity)
				throw bad('AUTO_INCREMENT needs a key: create it with the table, or use the SQL editor.');
			return [`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnDefinition(change.column)}`];
		}
		case 'drop-column': {
			const table = tableName(change.object, ['table'], 'Dropping a column');
			return [`ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(change.column)}`];
		}
		case 'rename-column': {
			const table = tableName(change.object, ['table'], 'Renaming a column');
			return [`ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(change.column)} TO ${quoteIdent(change.name)}`];
		}
		case 'alter-column': {
			if (!current) throw new StudioError('not_found', `No column ${change.column}.`);
			return [alterColumn(change, current, dialect)];
		}
		case 'create-index': {
			const table = tableName(change.object, ['table'], 'Creating an index');
			const name = change.name ?? indexName(table, change.columns.map((column) => column.name));
			const columns = change.columns.map((column) => `${quoteIdent(column.name)}${column.dir === 'desc' ? ' DESC' : ''}`);
			return [`CREATE ${change.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(name)} ON ${quoteIdent(table)} (${columns.join(', ')})`];
		}
		case 'drop-index': {
			const table = tableName(change.object, ['table'], 'Dropping an index');
			return [`DROP INDEX ${quoteIdent(change.name)} ON ${quoteIdent(table)}`];
		}
		case 'create-schema':
		case 'create-collection':
			throw new StudioError('unsupported', `MySQL and MariaDB sessions cannot ${change.op}.`);
	}
}
