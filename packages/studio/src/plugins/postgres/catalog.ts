/**
 * Catalog queries for `tree` and `describe`. They read `pg_catalog` directly: it is fast, and
 * unlike `information_schema` it is not filtered by privilege, so the Phase 3 read-only role
 * (`pg_read_all_data`) sees the same tree as the owner.
 */
import type { TreeNodeKind } from '../../protocol.ts';
import { qualified, quoteIdent } from './sql.ts';

export const SCHEMAS_SQL = `SELECT n.nspname AS name
FROM pg_catalog.pg_namespace n
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname !~ '^pg_(toast_)?temp_'
ORDER BY n.nspname`;

/** Relations in one schema ($1). Sizes only for kinds that have storage. */
export const RELATIONS_SQL = `SELECT c.relname AS name, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples,
  c.relispartition AS partition,
  CASE WHEN c.relkind IN ('r', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) END::float8 AS bytes
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY c.relname`;

/** One relation by schema ($1) and name ($2). */
export const RELATION_SQL = `SELECT c.oid::int8 AS oid, c.relkind::text AS relkind, c.reltuples::float8 AS reltuples,
  CASE WHEN c.relkind IN ('r', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) END::float8 AS bytes,
  CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS viewdef,
  CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partkey
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1::text AND c.relname = $2::text AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;

/** Columns of relation $1 (oid). */
export const COLUMNS_SQL = `SELECT a.attname::text AS name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS native,
  pg_catalog.format_type(a.atttypid, NULL) AS cast_type,
  a.atttypid::int8 AS type_oid,
  a.attnotnull AS not_null,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
  a.attidentity::text AS identity,
  a.attgenerated::text AS generated
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = $1::text::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;

/** Constraints of relation $1: primary, unique, foreign, check and exclusion. */
export const CONSTRAINTS_SQL = `SELECT con.conname::text AS name, con.contype::text AS type,
  ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
  fn.nspname::text AS ref_schema, fc.relname::text AS ref_table,
  ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns,
  pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.conrelid = $1::text::oid AND con.contype IN ('p', 'u', 'f', 'c', 'x')
ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname`;

/** Indexes of relation $1; expression keys come from `pg_get_indexdef(oid, n)`. */
export const INDEXES_SQL = `SELECT ic.relname::text AS name, i.indisunique AS "unique", i.indisprimary AS "primary",
  i.indpred IS NULL AS total,
  ARRAY(SELECT CASE WHEN k.attnum = 0 THEN pg_catalog.pg_get_indexdef(i.indexrelid, k.ord::int, true) ELSE a.attname::text END
    FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
  pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p', 'u', 'x')) AS constraint_backed
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = $1::text::oid
ORDER BY ic.relname`;

/** `pg_type` rows for a validated list of OIDs (inlined: they are integers). */
export function typesSql(oids: number[]): string {
	const list = oids.filter((oid) => Number.isSafeInteger(oid) && oid > 0).join(', ');
	return `SELECT t.oid::int8 AS oid, pg_catalog.format_type(t.oid, NULL) AS name, t.typtype::text AS typtype,
  t.typcategory::text AS typcategory, t.typelem::int8 AS typelem, t.typbasetype::int8 AS typbasetype
FROM pg_catalog.pg_type t WHERE t.oid IN (${list || '0'})`;
}

export function treeKind(relkind: string): TreeNodeKind {
	switch (relkind) {
		case 'v':
			return 'view';
		case 'm':
			return 'materialized-view';
		case 'f':
			return 'foreign-table';
		default:
			return 'table';
	}
}

export interface RawColumn {
	name: string;
	native: string;
	cast_type: string;
	type_oid: string | number;
	not_null: boolean;
	default_expr: string | null;
	identity: string | null;
	generated: string | null;
}

export interface RawConstraint {
	name: string;
	type: string;
	columns: string[];
	ref_schema: string | null;
	ref_table: string | null;
	ref_columns: string[];
	definition: string;
}

export interface RawIndex {
	name: string;
	unique: boolean;
	primary: boolean;
	total: boolean;
	columns: string[];
	definition: string;
	constraint_backed: boolean;
}

/**
 * Approximate DDL, assembled from the catalog. It is for reading, not a faithful dump: no
 * ownership, grants, storage parameters, partition bounds or comments.
 */
export function buildDdl(input: {
	schema: string;
	name: string;
	relkind: string;
	columns: RawColumn[];
	constraints: RawConstraint[];
	indexes: RawIndex[];
	viewdef: string | null;
	partkey: string | null;
}): string {
	const target = qualified(input.schema, input.name);
	if (input.relkind === 'v' || input.relkind === 'm') {
		const kind = input.relkind === 'v' ? 'VIEW' : 'MATERIALIZED VIEW';
		return `CREATE ${kind} ${target} AS\n${(input.viewdef ?? '').trimEnd()}`;
	}
	const lines = input.columns.map((column) => {
		let line = `    ${quoteIdent(column.name)} ${column.native}`;
		if (column.generated === 's') line += ` GENERATED ALWAYS AS (${column.default_expr ?? ''}) STORED`;
		else if (column.generated === 'v') line += ` GENERATED ALWAYS AS (${column.default_expr ?? ''}) VIRTUAL`;
		else if (column.identity === 'a') line += ' GENERATED ALWAYS AS IDENTITY';
		else if (column.identity === 'd') line += ' GENERATED BY DEFAULT AS IDENTITY';
		else if (column.default_expr) line += ` DEFAULT ${column.default_expr}`;
		if (column.not_null) line += ' NOT NULL';
		return line;
	});
	for (const constraint of input.constraints)
		lines.push(`    CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`);
	const kind = input.relkind === 'f' ? 'FOREIGN TABLE' : 'TABLE';
	let ddl = `CREATE ${kind} ${target} (\n${lines.join(',\n')}\n)`;
	if (input.partkey) ddl += ` PARTITION BY ${input.partkey}`;
	ddl += ';';
	for (const index of input.indexes) if (!index.constraint_backed) ddl += `\n${index.definition};`;
	return ddl;
}
