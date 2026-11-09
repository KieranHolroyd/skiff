/**
 * Structure editing (the studio's `alter` op): which edits a session offers, and the pure
 * builders that turn form drafts into `SchemaChangeInput`s. The plugin quotes every name and
 * re-validates types and defaults; the checks here only give the form an early, clear message.
 */
import {
	COLUMN_TYPE_PATTERN,
	DEFAULT_EXPRESSION_PATTERN,
	type Column,
	type ColumnDefault,
	type ObjectRef,
	type SchemaChangeInput,
	type SchemaChangeOp,
	type StudioInfo,
	type TreeNode
} from '@yoal/studio/protocol';

// ---------------------------------------------------------------- capabilities

/**
 * The structure edits this session offers: none on a read-only session, and none from a node
 * too old to send `capabilities.structure`.
 */
export function structureOps(info: Pick<StudioInfo, 'readOnly' | 'capabilities'>): ReadonlySet<SchemaChangeOp> {
	if (info.readOnly) return new Set();
	// Older nodes send no `structure` at all; the type says it is always there.
	return new Set((info.capabilities.structure as SchemaChangeOp[] | undefined) ?? []);
}

export function canAlter(info: Pick<StudioInfo, 'readOnly' | 'capabilities'>, op: SchemaChangeOp): boolean {
	return structureOps(info).has(op);
}

// ---------------------------------------------------------------- names

const MAX_NAME = 1_024;

/** An early check for any name: not empty, no NUL, not too long. Null when it is fine. */
export function nameError(name: string, what = 'name'): string | null {
	if (name.trim() === '') return `Enter a ${what}.`;
	if (name.includes('\0')) return `A ${what} cannot contain NUL.`;
	if (name.length > MAX_NAME) return `A ${what} is at most ${MAX_NAME} characters.`;
	return null;
}

/** What an object is called in a sentence: table, view, collection, key… */
export function kindLabel(kind: ObjectRef['kind']): string {
	switch (kind) {
		case 'materialized-view':
			return 'materialized view';
		case 'foreign-table':
			return 'foreign table';
		case 'key-group':
			return 'key group';
		default:
			return kind;
	}
}

/**
 * The object a `rename` leaves behind. Key-value keys resolve by their full name under the
 * keyspace, so a renamed key is `[db, name]` whatever group it was found in.
 */
export function renamedPath(path: readonly string[], kind: ObjectRef['kind'], name: string): string[] {
	if (kind === 'key') return [path[0] ?? '0', name];
	return [...path.slice(0, -1), name];
}

export function renamedNode(node: TreeNode, name: string): TreeNode {
	return { ...node, path: renamedPath(node.path, node.kind, name), name };
}

// ---------------------------------------------------------------- review

/** Edits that lose data: the review asks the user to type a name before they run. */
export const DESTRUCTIVE_OPS: ReadonlySet<SchemaChangeOp> = new Set(['drop', 'truncate', 'drop-column', 'drop-index']);

/** The text a destructive change must be confirmed with, or null when it needs none. */
export function confirmPhrase(change: SchemaChangeInput): string | null {
	switch (change.op) {
		case 'drop':
		case 'truncate':
			return change.object.path.at(-1) ?? null;
		case 'drop-column':
			return change.column;
		case 'drop-index':
			return change.name;
		default:
			return null;
	}
}

// ---------------------------------------------------------------- columns

export type DefaultMode = 'none' | 'literal' | 'expression';
/** Editing adds `keep` (leave the default alone); `none` there drops it. */
export type EditDefaultMode = DefaultMode | 'keep';

export interface ColumnDraft {
	name: string;
	type: string;
	nullable: boolean;
	defaultMode: DefaultMode;
	defaultText: string;
	identity: boolean;
}

export interface ColumnEditDraft {
	name: string;
	type: string;
	nullable: boolean;
	defaultMode: EditDefaultMode;
	defaultText: string;
}

export const emptyColumn = (): ColumnDraft => ({
	name: '',
	type: '',
	nullable: true,
	defaultMode: 'none',
	defaultText: '',
	identity: false
});

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function typeError(type: string): string | null {
	const trimmed = type.trim();
	if (trimmed === '') return 'Enter a type.';
	if (trimmed.length > 200 || !COLUMN_TYPE_PATTERN.test(trimmed))
		return 'Use a plain type name such as varchar(255), numeric(10,2) or integer[].';
	return null;
}

/** The default a draft asks for; `undefined` means none. */
export function draftDefault(mode: DefaultMode, text: string): Result<ColumnDefault | undefined> {
	if (mode === 'none') return { ok: true, value: undefined };
	if (mode === 'literal') return { ok: true, value: { literal: text } };
	const expression = text.trim();
	if (!DEFAULT_EXPRESSION_PATTERN.test(expression) || expression.length > 100)
		return { ok: false, error: 'A default expression is a keyword or a call such as now() or CURRENT_TIMESTAMP.' };
	return { ok: true, value: { expression } };
}

/** A new column's spec, or the first problem with the draft. */
export function columnSpec(draft: ColumnDraft): Result<Extract<SchemaChangeInput, { op: 'add-column' }>['column']> {
	const name = draft.name.trim();
	const problem = nameError(name, 'column name') ?? typeError(draft.type);
	if (problem) return { ok: false, error: problem };
	const fallback = draftDefault(draft.defaultMode, draft.defaultText);
	if (!fallback.ok) return fallback;
	if (draft.identity && fallback.value !== undefined)
		return { ok: false, error: `${name} is an identity column, so it cannot also have a default.` };
	return {
		ok: true,
		value: {
			name,
			type: draft.type.trim(),
			nullable: draft.identity ? false : draft.nullable,
			identity: draft.identity,
			...(fallback.value === undefined ? {} : { default: fallback.value })
		}
	};
}

/** The edit form, prefilled from a described column. The default starts as "keep". */
export function editDraft(column: Column): ColumnEditDraft {
	return {
		name: column.name,
		type: column.nativeType,
		nullable: column.nullable !== false,
		defaultMode: 'keep',
		defaultText: ''
	};
}

const normalType = (type: string) => type.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The changes an edit makes, in the order they must run: `alter-column` first, on the old name
 * (so its dry run sees the column as it is), then `rename-column`. Empty when nothing changed.
 */
export function columnEditChanges(
	object: ObjectRef,
	column: Column,
	draft: ColumnEditDraft
): Result<SchemaChangeInput[]> {
	const name = draft.name.trim();
	const problem = nameError(name, 'column name');
	if (problem) return { ok: false, error: problem };
	const alter: Extract<SchemaChangeInput, { op: 'alter-column' }> = {
		op: 'alter-column',
		object,
		column: column.name
	};
	let altered = false;
	if (normalType(draft.type) !== normalType(column.nativeType)) {
		const bad = typeError(draft.type);
		if (bad) return { ok: false, error: bad };
		alter.type = draft.type.trim();
		altered = true;
	}
	if (draft.nullable !== (column.nullable !== false)) {
		alter.nullable = draft.nullable;
		altered = true;
	}
	if (draft.defaultMode === 'none') {
		// Dropping a default the column doesn't have changes nothing.
		if (column.default != null) {
			alter.default = null;
			altered = true;
		}
	} else if (draft.defaultMode !== 'keep') {
		const fallback = draftDefault(draft.defaultMode, draft.defaultText);
		if (!fallback.ok) return fallback;
		alter.default = fallback.value ?? null;
		altered = true;
	}
	const changes: SchemaChangeInput[] = altered ? [alter] : [];
	if (name !== column.name) changes.push({ op: 'rename-column', object, column: column.name, name });
	return { ok: true, value: changes };
}

// ---------------------------------------------------------------- tables

export interface TableDraft {
	/** The tree path the table goes under: `[schema]`, or `[]`. */
	parent: string[];
	name: string;
	columns: ColumnDraft[];
	/** Names of the columns in the primary key, in column order. */
	primaryKey: string[];
}

export function tableChange(draft: TableDraft): Result<Extract<SchemaChangeInput, { op: 'create-table' }>> {
	const name = draft.name.trim();
	const problem = nameError(name, 'table name');
	if (problem) return { ok: false, error: problem };
	if (draft.columns.length === 0) return { ok: false, error: 'Add at least one column.' };
	const columns: Extract<SchemaChangeInput, { op: 'create-table' }>['columns'] = [];
	const seen = new Set<string>();
	for (const [index, draftColumn] of draft.columns.entries()) {
		const spec = columnSpec(draftColumn);
		if (!spec.ok) return { ok: false, error: `Column ${index + 1}: ${spec.error}` };
		if (seen.has(spec.value.name)) return { ok: false, error: `There are two columns named ${spec.value.name}.` };
		seen.add(spec.value.name);
		columns.push(spec.value);
	}
	const primaryKey = draft.primaryKey.map((key) => key.trim()).filter((key) => seen.has(key));
	// A key column is never nullable; say so in the spec rather than leave it to the engine.
	for (const column of columns) if (primaryKey.includes(column.name)) column.nullable = false;
	return { ok: true, value: { op: 'create-table', parent: [...draft.parent], name, columns, primaryKey } };
}

/** What a new table starts with: an identity key column. */
export function starterColumns(dialect: StudioInfo['capabilities']['dialect']): ColumnDraft[] {
	return [{ ...emptyColumn(), name: 'id', type: dialect === 'postgres' ? 'bigint' : 'bigint unsigned', nullable: false, identity: true }];
}

const POSTGRES_TYPES = [
	'integer',
	'bigint',
	'smallint',
	'numeric(10,2)',
	'real',
	'double precision',
	'boolean',
	'text',
	'varchar(255)',
	'char(1)',
	'uuid',
	'date',
	'time',
	'timestamp',
	'timestamp with time zone',
	'interval',
	'jsonb',
	'json',
	'bytea',
	'text[]',
	'integer[]'
];

const MYSQL_TYPES = [
	'int',
	'bigint',
	'bigint unsigned',
	'smallint',
	'tinyint(1)',
	'decimal(10,2)',
	'double',
	'float',
	'boolean',
	'varchar(255)',
	'char(1)',
	'text',
	'mediumtext',
	'longtext',
	'json',
	'date',
	'time',
	'datetime',
	'datetime(6)',
	'timestamp',
	'blob',
	'varbinary(255)',
	"enum('a','b')"
];

/** Suggestions for the type field (any type the engine knows is accepted). */
export function commonTypes(dialect: StudioInfo['capabilities']['dialect']): string[] {
	if (dialect === 'postgres') return POSTGRES_TYPES;
	if (dialect === 'mariadb') return [...MYSQL_TYPES, 'uuid'];
	return MYSQL_TYPES;
}

// ---------------------------------------------------------------- indexes

export interface IndexDraft {
	name: string;
	columns: Array<{ name: string; dir: 'asc' | 'desc' }>;
	unique: boolean;
}

/** The name the engine is likely to be given when the field is left empty (shown as a hint). */
export function suggestedIndexName(table: string, columns: readonly string[], unique: boolean): string {
	const base = [table, ...columns.filter(Boolean)].join('_').replace(/[^A-Za-z0-9_]+/g, '_');
	return `${base}_${unique ? 'key' : 'idx'}`.slice(0, 63);
}

export function indexChange(object: ObjectRef, draft: IndexDraft): Result<Extract<SchemaChangeInput, { op: 'create-index' }>> {
	const columns = draft.columns
		.map((column) => ({ name: column.name.trim(), dir: column.dir }))
		.filter((column) => column.name !== '');
	if (columns.length === 0) return { ok: false, error: 'Choose at least one column.' };
	const names = new Set<string>();
	for (const column of columns) {
		if (names.has(column.name)) return { ok: false, error: `${column.name} is in the index twice.` };
		names.add(column.name);
	}
	const name = draft.name.trim();
	if (name !== '') {
		const problem = nameError(name, 'index name');
		if (problem) return { ok: false, error: problem };
	}
	return {
		ok: true,
		value: { op: 'create-index', object, columns, unique: draft.unique, ...(name === '' ? {} : { name }) }
	};
}
