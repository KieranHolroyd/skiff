/**
 * Postgres studio plugin (plan 22, Phase 2 track A), on Bun.SQL. Needs Bun ≥ 1.4.4: older
 * releases return no `result.columns` and ignore `query.cancel()` (spike S4).
 *
 * Connections: a pool of at most two. `run` and `explain` share one reserved connection so a
 * user's statements see the same session (search_path, temp tables, prepared statements);
 * tree, describe, browse, apply and value use the other.
 *
 * Read-only sessions (a second layer under the read-only credential):
 * - Every connection starts with `default_transaction_read_only = on`.
 * - Every `run` statement gets its own `BEGIN READ ONLY` … `ROLLBACK`. The timeout is set with
 *   `SELECT set_config(…)`, which also takes the transaction's first snapshot, so the user's
 *   statement can no longer switch it to read-write (`SET transaction_read_only = off` fails
 *   with 25001). Nothing a statement does — COMMIT, SET SESSION CHARACTERISTICS, BEGIN READ
 *   WRITE — outlives it: the next statement opens a fresh read-only transaction.
 * - Each statement goes out on the extended protocol (with one unused parameter), which the
 *   server refuses for more than one command. A splitter mistake fails instead of running a
 *   second statement outside the wrapper.
 *
 * Write sessions honour the user's own BEGIN/COMMIT within one run and roll back whatever is
 * still open when the run ends, so transactions never span runs.
 */
import { SQL, type ReservedSQL } from 'bun';
import type { DatabaseEngine } from '@yoal/contracts';
import { bytesCell, CELL_PREVIEW_BYTES, textCell } from '../../cells.ts';
import type { RunOptions, SessionOptions, StudioPlugin, StudioSession, StudioTarget } from '../../driver.ts';
import {
	StudioError,
	type AlterResult,
	type ApplyResult,
	type BrowseQuery,
	type Cell,
	type Column,
	type ExplainResult,
	type ObjectDescription,
	type ObjectRef,
	type RowChange,
	type SchemaChange,
	type StudioCapabilities,
	type StudioErrorCode,
	type StudioEvent,
	type TreeNode,
	type TreePath,
} from '../../protocol.ts';
import {
	buildDdl,
	COLUMNS_SQL,
	CONSTRAINTS_SQL,
	INDEXES_SQL,
	RELATION_SQL,
	RELATIONS_SQL,
	SCHEMAS_SQL,
	treeKind,
	typesSql,
	type RawColumn,
	type RawConstraint,
	type RawIndex,
} from './catalog.ts';
import { renderAlter, type AlterContext } from './ddl.ts';
import { isStreamable, splitStatements, transactionEffect, type SqlStatement } from './split.ts';
import {
	buildBrowse,
	comparable,
	encodeCursor,
	Params,
	qualified,
	quoteIdent,
	textParam,
	type ColumnMeta,
	type TableMeta,
} from './sql.ts';
import { builtinType, decoderFor, kindForRow, type Decoder, type PgTypeInfo, type PgTypeRow } from './types.ts';

export { splitStatements } from './split.ts';
export { quoteIdent } from './sql.ts';

const CAPABILITIES: StudioCapabilities = {
	family: 'relational',
	language: 'sql',
	dialect: 'postgres',
	edit: 'primary-key',
	cancel: 'native',
	explain: true,
	schemas: true,
	structure: [
		'create-schema',
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
	],
};

/** The index `$3` on relation `$1.$2`, and the constraint that owns it (if any). */
const INDEX_OWNER_SQL = `SELECT i.relname::text AS name, con.conname::text AS constraint
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = i.oid AND con.conrelid = t.oid AND con.contype IN ('p', 'u', 'x')
WHERE n.nspname = $1::text AND t.relname = $2::text AND i.relname = $3::text`;

/** Rows per FETCH and per `rows` event. */
const BATCH = 500;
const CURSOR = 'yoal_studio_cursor';
const DECLARE_PREFIX = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR `;
/** Describe results are reused this long by browse/apply/value (a write `run` clears them). */
const DESCRIBE_TTL_MS = 10_000;
/** The unused parameter that forces the extended protocol (one statement per message). */
const ONE_STATEMENT: [number] = [0];
const COUNTED_COMMANDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'FETCH', 'MOVE', 'COPY']);

export const postgresPlugin: StudioPlugin = {
	id: 'postgres',
	engines: ['postgres'] as const satisfies readonly DatabaseEngine[],
	capabilities: () => CAPABILITIES,
	async connect(target: StudioTarget, options: SessionOptions): Promise<StudioSession> {
		const sql = new SQL({
			adapter: 'postgres',
			hostname: target.host,
			port: target.port,
			username: target.user,
			password: target.password,
			database: target.database,
			tls: tlsOption(target.tls),
			max: 2,
			idleTimeout: 120,
			connectionTimeout: 10,
			// Unnamed statements: user SQL is rarely repeated, and named ones pin server memory.
			prepare: false,
			connection: {
				application_name: 'yoal-studio',
				// Cells are UTC ISO 8601, and the splitter assumes standard strings.
				TimeZone: 'UTC',
				DateStyle: 'ISO, MDY',
				IntervalStyle: 'postgres',
				standard_conforming_strings: 'on',
				statement_timeout: String(options.limits.statementTimeoutMs),
				idle_in_transaction_session_timeout: '10s',
				...(options.readOnly ? { default_transaction_read_only: 'on' } : {}),
			},
		});
		try {
			await sql.unsafe('SELECT 1');
		} catch (error) {
			await sql.close({ timeout: 0 }).catch(() => undefined);
			throw asStudioError(error);
		}
		return new PostgresSession(sql, options);
	},
};

/** TLS as `database-stats.ts` does it: a CA pins, a null CA encrypts without pinning. */
function tlsOption(tls: StudioTarget['tls']): { ca?: string; rejectUnauthorized: boolean } | false {
	if (!tls) return false;
	return tls.caPem ? { ca: tls.caPem, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

// ---------------------------------------------------------------- errors

interface PgErrorLike {
	code?: string;
	errno?: string;
	message?: string;
	detail?: string;
	position?: string;
}

interface DescribedError {
	code: StudioErrorCode;
	message: string;
	sqlstate?: string;
	/** 1-based position in the text that was sent. */
	position?: number;
}

function describeError(error: unknown, signal?: AbortSignal): DescribedError {
	if (error instanceof StudioError) return { code: error.code, message: error.message };
	const pg = (typeof error === 'object' && error !== null ? error : {}) as PgErrorLike;
	const message = (pg.message ?? String(error)).slice(0, 2_000);
	const sqlstate = typeof pg.errno === 'string' && /^[0-9A-Z]{5}$/.test(pg.errno) ? pg.errno : undefined;
	if (signal?.aborted || pg.code === 'ERR_POSTGRES_QUERY_CANCELLED')
		return { code: 'cancelled', message: 'The query was cancelled.', ...(sqlstate ? { sqlstate } : {}) };
	if (!sqlstate) return { code: 'engine_error', message: message || 'The database reported an error.' };
	const position = pg.position ? Number.parseInt(pg.position, 10) : Number.NaN;
	const detail = pg.detail ? ` ${pg.detail}` : '';
	let code: StudioErrorCode = 'engine_error';
	// 57014 is both a user cancel and statement_timeout; the abort signal tells them apart.
	if (sqlstate === '57014') code = /timeout/i.test(message) ? 'timeout' : 'cancelled';
	else if (sqlstate === '25006') code = 'read_only';
	return {
		code,
		message: `${message}${detail} (pg:${sqlstate})`,
		sqlstate,
		...(Number.isFinite(position) && position > 0 ? { position } : {}),
	};
}

function asStudioError(error: unknown, signal?: AbortSignal): StudioError {
	if (error instanceof StudioError) return error;
	const described = describeError(error, signal);
	return new StudioError(described.code, described.message);
}

/** A failure that leaves the connection unusable (closed, FATAL, admin shutdown). */
function isConnectionError(error: unknown): boolean {
	const pg = (typeof error === 'object' && error !== null ? error : {}) as PgErrorLike;
	if (pg.errno) return /^(08|57P)/.test(pg.errno) || pg.errno === '25P03';
	return typeof pg.code === 'string' && /CONNECTION|SOCKET|TLS/.test(pg.code);
}

function cancelled(): StudioError {
	return new StudioError('cancelled', 'The query was cancelled.');
}

type Query = ReturnType<SQL['unsafe']>;
type Result = unknown[] & { count: number; command: string | null; columns: { name: string; type: number }[] | null };

/** Await a query, cancelling it on the server when `signal` aborts. */
async function exec(query: Query, signal?: AbortSignal): Promise<Result> {
	if (signal?.aborted) throw cancelled();
	const onAbort = () => {
		query.cancel();
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return (await query) as unknown as Result;
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

/** Map a 1-based code-point position in `sent` back to a 1-based UTF-16 offset in the input. */
export function inputPosition(statement: SqlStatement, sent: string, prefix: number, position: number): number | undefined {
	let index = 0;
	for (let count = 1; count < position && index < sent.length; count += 1)
		index += (sent.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
	const inStatement = index - prefix;
	if (inStatement < 0) return undefined;
	return statement.start + inStatement + 1;
}

// ---------------------------------------------------------------- session

interface TableInfo {
	oid: number;
	relkind: string;
	meta: TableMeta;
	description: ObjectDescription;
	/** Generated and identity-always columns. */
	readOnlyColumns: Set<string>;
	at: number;
}

class PostgresSession implements StudioSession {
	private reserved: ReservedSQL | null = null;
	private queue: Promise<void> = Promise.resolve();
	private readonly types = new Map<number, PgTypeInfo>();
	private readonly tables = new Map<string, TableInfo>();
	private closed = false;

	constructor(
		private readonly sql: SQL,
		private readonly options: SessionOptions,
	) {}

	// ------------------------------------------------------------ tree and describe

	async tree(path: TreePath, signal: AbortSignal): Promise<TreeNode[]> {
		this.assertOpen();
		try {
			if (path.length === 0) {
				const rows = (await exec(this.sql.unsafe(SCHEMAS_SQL), signal)) as { name: string }[];
				return rows.map((row) => ({ path: [row.name], name: row.name, kind: 'schema', hasChildren: true, browsable: false }));
			}
			if (path.length !== 1) return [];
			const schema = path[0] as string;
			const rows = (await exec(this.sql.unsafe(RELATIONS_SQL, [schema]), signal)) as {
				name: string;
				relkind: string;
				reltuples: number;
				partition: boolean;
				bytes: number | null;
			}[];
			return rows.map((row) => {
				const detail: NonNullable<TreeNode['detail']> = {};
				// reltuples is -1 until the first VACUUM/ANALYZE: unknown, not empty.
				if (row.reltuples >= 0) detail.rows = Math.round(row.reltuples);
				if (row.bytes !== null && row.bytes >= 0) detail.bytes = Number(row.bytes);
				if (row.relkind === 'p') detail.type = 'partitioned';
				else if (row.partition) detail.type = 'partition';
				return {
					path: [schema, row.name],
					name: row.name,
					kind: treeKind(row.relkind),
					hasChildren: false,
					browsable: true,
					...(Object.keys(detail).length > 0 ? { detail } : {}),
				};
			});
		} catch (error) {
			throw asStudioError(error, signal);
		}
	}

	async describe(object: ObjectRef, signal: AbortSignal): Promise<ObjectDescription> {
		this.assertOpen();
		return { ...(await this.table(object, signal, true)).description, object };
	}

	private async table(object: ObjectRef, signal: AbortSignal, fresh = false): Promise<TableInfo> {
		const [schema] = object.path;
		const name = object.path.at(-1);
		if (object.path.length !== 2 || !schema || !name)
			throw new StudioError('not_found', `No object ${object.path.join('.')}.`);
		const cacheKey = JSON.stringify([schema, name]);
		const cached = this.tables.get(cacheKey);
		if (!fresh && cached && performance.now() - cached.at < DESCRIBE_TTL_MS) return cached;
		try {
			const info = await this.loadTable(schema, name, object, signal);
			this.tables.set(cacheKey, info);
			return info;
		} catch (error) {
			throw asStudioError(error, signal);
		}
	}

	private async loadTable(schema: string, name: string, object: ObjectRef, signal: AbortSignal): Promise<TableInfo> {
		const [relation] = (await exec(this.sql.unsafe(RELATION_SQL, [schema, name]), signal)) as {
			oid: string;
			relkind: string;
			reltuples: number;
			bytes: number | null;
			viewdef: string | null;
			partkey: string | null;
		}[];
		if (!relation) throw new StudioError('not_found', `No table or view ${schema}.${name}.`);
		const oid = String(relation.oid);
		const columns = (await exec(this.sql.unsafe(COLUMNS_SQL, [oid]), signal)) as unknown as RawColumn[];
		const constraints = (await exec(this.sql.unsafe(CONSTRAINTS_SQL, [oid]), signal)) as unknown as RawConstraint[];
		const indexes = (await exec(this.sql.unsafe(INDEXES_SQL, [oid]), signal)) as unknown as RawIndex[];
		await this.resolveTypes(columns.map((c) => Number(c.type_oid)));

		const primary = constraints.find((c) => c.type === 'p');
		const primaryKey = primary ? [...primary.columns] : null;
		const uniqueColumns = new Set(
			[
				...constraints.filter((c) => c.type === 'u').map((c) => c.columns),
				...indexes.filter((i) => i.unique && !i.primary && i.total).map((i) => i.columns),
			]
				.filter((cols) => cols.length === 1)
				.map((cols) => cols[0] as string),
		);
		const tableKind = relation.relkind === 'r' || relation.relkind === 'p';
		const readOnlyColumns = new Set<string>();
		const metas: ColumnMeta[] = [];
		const described: Column[] = columns.map((raw) => {
			const info = this.typeInfo(Number(raw.type_oid));
			const elem = info.kind === 'array' && info.elem ? this.typeInfo(info.elem) : undefined;
			const computed = Boolean(raw.generated) || raw.identity === 'a';
			if (computed) readOnlyColumns.add(raw.name);
			metas.push({
				name: raw.name,
				kind: info.kind,
				...(elem ? { elemKind: elem.kind } : {}),
				typeOid: info.oid,
				castType: raw.cast_type,
				nullable: !raw.not_null,
			});
			const key = primaryKey?.includes(raw.name) ? 'primary' : uniqueColumns.has(raw.name) ? 'unique' : null;
			return {
				name: raw.name,
				nativeType: raw.native,
				kind: info.kind,
				nullable: !raw.not_null,
				key,
				editable: tableKind && !computed,
				// A generated column's expression is not a default.
				default: raw.generated ? null : raw.default_expr,
			};
		});

		let reason: string | undefined;
		if (!tableKind)
			reason =
				relation.relkind === 'v'
					? 'Views are read-only here; edit the underlying table.'
					: relation.relkind === 'm'
						? 'Materialized views cannot be edited; refresh them instead.'
						: 'Foreign tables cannot be edited here.';
		else if (!primaryKey) reason = 'This table has no primary key, so rows cannot be addressed for editing.';
		else if (this.options.readOnly) reason = 'The session is read-only.';

		const estimate: NonNullable<ObjectDescription['estimate']> = {};
		if (relation.reltuples >= 0) estimate.rows = Math.round(relation.reltuples);
		if (relation.bytes !== null && relation.bytes >= 0) estimate.bytes = Number(relation.bytes);

		const description: ObjectDescription = {
			object,
			columns: described,
			primaryKey,
			indexes: indexes.map((index) => ({
				name: index.name,
				columns: [...index.columns],
				unique: index.unique,
				definition: index.definition,
			})),
			foreignKeys: constraints
				.filter((c) => c.type === 'f' && c.ref_schema && c.ref_table)
				.map((c) => ({
					name: c.name,
					columns: [...c.columns],
					references: { path: [c.ref_schema as string, c.ref_table as string], columns: [...c.ref_columns] },
				})),
			ddl: buildDdl({
				schema,
				name,
				relkind: relation.relkind,
				columns,
				constraints,
				indexes,
				viewdef: relation.viewdef,
				partkey: relation.partkey,
			}),
			...(Object.keys(estimate).length > 0 ? { estimate } : {}),
			editable: reason === undefined,
			...(reason ? { reason } : {}),
		};
		return {
			oid: Number(relation.oid),
			relkind: relation.relkind,
			meta: {
				schema,
				name,
				columns: metas,
				primaryKey,
				// ctid identifies a row version on one heap; partitioned parents have several.
				ctid: relation.relkind === 'r' || relation.relkind === 'm',
			},
			description,
			readOnlyColumns,
			at: performance.now(),
		};
	}

	// ------------------------------------------------------------ types

	private typeInfo(oid: number): PgTypeInfo {
		return builtinType(oid) ?? this.types.get(oid) ?? { oid, name: `oid ${oid}`, kind: 'unknown' };
	}

	/** Look up OIDs Bun does not know, once per session, following domains and arrays. */
	private async resolveTypes(oids: number[]): Promise<void> {
		const rows = new Map<number, PgTypeRow>();
		const unknown = (oid: number) => oid > 0 && !builtinType(oid) && !this.types.has(oid) && !rows.has(oid);
		let pending = [...new Set(oids.filter(unknown))];
		for (let depth = 0; depth < 4 && pending.length > 0; depth += 1) {
			const result = (await exec(this.sql.unsafe(typesSql(pending)))) as {
				oid: string;
				name: string;
				typtype: string;
				typcategory: string;
				typelem: string;
				typbasetype: string;
			}[];
			const next: number[] = [];
			for (const raw of result) {
				const row: PgTypeRow = {
					oid: Number(raw.oid),
					name: raw.name,
					typtype: raw.typtype,
					typcategory: raw.typcategory,
					typelem: Number(raw.typelem),
					typbasetype: Number(raw.typbasetype),
				};
				rows.set(row.oid, row);
				for (const dep of [row.typelem, row.typbasetype]) if (unknown(dep)) next.push(dep);
			}
			pending = [...new Set(next)];
		}
		const resolve = (oid: number, depth = 0): PgTypeInfo => {
			const known = builtinType(oid) ?? this.types.get(oid);
			if (known) return known;
			const row = rows.get(oid);
			if (!row || depth > 8) return { oid, name: row?.name ?? `oid ${oid}`, kind: 'unknown' };
			let info: PgTypeInfo;
			if (row.typtype === 'd') {
				const base = resolve(row.typbasetype, depth + 1);
				info = { ...base, oid, name: row.name };
			} else {
				const kind = kindForRow(row);
				info = { oid, name: row.name, kind, ...(kind === 'array' ? { elem: row.typelem } : {}) };
				if (kind === 'array') resolve(row.typelem, depth + 1);
			}
			this.types.set(oid, info);
			return info;
		};
		for (const oid of rows.keys()) resolve(oid);
	}

	private decoder(info: PgTypeInfo, limit?: number): Decoder {
		if (info.kind === 'array') {
			const elem = info.elem ? this.typeInfo(info.elem) : undefined;
			return decoderFor('array', {
				...(limit !== undefined ? { limit } : {}),
				...(elem ? { elem: this.decoder(elem, limit) } : {}),
			});
		}
		return decoderFor(info.kind, { ...(limit !== undefined ? { limit } : {}), local: info.local === true });
	}

	/** `columns` and decoders for a result, from its column OIDs. */
	private async resultShape(result: Result): Promise<{ columns: Column[]; decoders: Decoder[] }> {
		const raw = result.columns ?? [];
		await this.resolveTypes(raw.map((c) => c.type));
		const infos = raw.map((c) => this.typeInfo(c.type));
		return {
			columns: raw.map((c, i) => ({ name: c.name, nativeType: (infos[i] as PgTypeInfo).name, kind: (infos[i] as PgTypeInfo).kind })),
			decoders: infos.map((info) => this.decoder(info)),
		};
	}

	// ------------------------------------------------------------ browse and value

	async *browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const started = performance.now();
		const table = await this.table(object, signal);
		const plan = buildBrowse(table.meta, query);
		// json previews arrive as JSON text (`left(col::text, n)`), not parsed by the driver.
		const decoders = plan.selected.map((s) =>
			s.preview === 'json' ? decoderFor('json', { jsonText: true }) : this.decoder(this.typeInfo(s.column.typeOid)),
		);
		const rows = (await this.readOnlyTransaction(signal, (conn) =>
			exec(conn.unsafe(plan.text, plan.params).values(), signal),
		)) as unknown[][];

		yield { t: 'columns', columns: table.description.columns };
		const page = rows.slice(0, query.limit);
		const cells = page.map((row) =>
			plan.selected.map((selected, i) => {
				const value = row[selected.index];
				const size = selected.sizeIndex === undefined ? undefined : Number(row[selected.sizeIndex]);
				return previewCell(value, size, selected.preview, decoders[i] as Decoder);
			}),
		);
		for (let i = 0; i < cells.length; i += BATCH) yield { t: 'rows', rows: cells.slice(i, i + BATCH) };

		let next: string | null = null;
		if (rows.length > query.limit) {
			if (plan.mode === 'offset') next = encodeCursor({ s: plan.signature, o: plan.offset + query.limit });
			else {
				const last = page.length - 1;
				const keys = plan.order.map((item) => {
					if (item.column === 'ctid') return String((page[last] as unknown[])[plan.ctidIndex as number]);
					const index = plan.selected.findIndex((s) => s.column === item.column);
					return (cells[last] as Cell[])[index] ?? null;
				});
				next = encodeCursor({ s: plan.signature, k: keys });
			}
		}
		const estimate = query.filter.length === 0 ? table.description.estimate?.rows : undefined;
		yield { t: 'page', next, ...(estimate !== undefined ? { estimate } : {}) };
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated: false };
	}

	async value(object: ObjectRef, key: Record<string, Cell>, column: string, signal: AbortSignal): Promise<Cell> {
		this.assertOpen();
		const table = await this.table(object, signal);
		const meta = table.meta.columns.find((c) => c.name === column);
		if (!meta) throw new StudioError('bad_request', `Unknown column "${column}".`);
		if (!table.meta.primaryKey) throw new StudioError('unsupported', 'Full values need a primary key to find the row.');
		const params = new Params();
		const where = this.keyConditions(table, key, params);
		const ident = quoteIdent(meta.name);
		const expr =
			meta.kind === 'datetime' || meta.kind === 'date'
				? `${ident}::text`
				: meta.kind === 'array' && (meta.elemKind === 'datetime' || meta.elemKind === 'date')
					? `${ident}::text[]`
					: ident;
		const text = `SELECT ${expr} FROM ${qualified(table.meta.schema, table.meta.name)} WHERE ${where.join(' AND ')}`;
		const rows = (await this.readOnlyTransaction(signal, (conn) =>
			exec(conn.unsafe(text, params.values).values(), signal),
		)) as unknown[][];
		const row = rows[0];
		if (!row) throw new StudioError('not_found', 'The row no longer exists.');
		return this.decoder(this.typeInfo(meta.typeOid), this.options.limits.maxBytes)(row[0]);
	}

	/** Run `fn` in a read-only transaction on a pool connection, with the session timeout. */
	private async readOnlyTransaction<T>(signal: AbortSignal, fn: (conn: ReservedSQL) => Promise<T>): Promise<T> {
		let conn: ReservedSQL;
		try {
			conn = await this.sql.reserve({ signal });
		} catch (error) {
			throw asStudioError(error, signal);
		}
		try {
			await exec(conn.unsafe('BEGIN READ ONLY'), signal);
			await exec(conn.unsafe(`SET LOCAL statement_timeout = ${this.options.limits.statementTimeoutMs}`), signal);
			const result = await fn(conn);
			await exec(conn.unsafe('ROLLBACK'));
			return result;
		} catch (error) {
			await exec(conn.unsafe('ROLLBACK')).catch(() => undefined);
			throw asStudioError(error, signal);
		} finally {
			await conn.release();
		}
	}

	// ------------------------------------------------------------ run

	async *run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const started = performance.now();
		const statements = splitStatements(input);
		const done = (truncated: boolean): StudioEvent => ({ t: 'done', ms: Math.round(performance.now() - started), truncated });
		if (statements.length === 0) {
			yield done(false);
			return;
		}
		const unlock = await this.lock();
		const readOnly = this.options.readOnly;
		const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs));
		const maxRows = Math.max(1, Math.trunc(options.maxRows));
		// Whether a transaction may be open on the connection (ours or the user's).
		let open = false;
		// Write sessions: whether the user has an explicit transaction open.
		let userTransaction = false;
		let truncated = false;
		let conn: ReservedSQL | null = null;
		try {
			// A write run may change what describe returned.
			if (!readOnly) this.tables.clear();
			for (const [index, statement] of statements.entries()) {
				if (signal.aborted) throw cancelled();
				let sent = statement.text;
				let prefix = 0;
				try {
					if (index === 0) conn = await this.firstCommand(readOnly ? 'BEGIN READ ONLY' : `SET statement_timeout = ${timeoutMs}`, signal);
					const c = conn as ReservedSQL;
					if (readOnly) {
						if (index > 0) await exec(c.unsafe('BEGIN READ ONLY'), signal);
						open = true;
						// A SELECT, not SET LOCAL: it takes the first snapshot, which locks the
						// transaction read-only for the user's statement.
						await exec(c.unsafe(`SELECT pg_catalog.set_config('statement_timeout', $1::text, true)`, [String(timeoutMs)]), signal);
					} else if (index > 0) await exec(c.unsafe(`SET statement_timeout = ${timeoutMs}`), signal);

					if (isStreamable(statement)) {
						const ownTransaction = !readOnly && !userTransaction;
						if (ownTransaction) {
							await exec(c.unsafe('BEGIN'), signal);
							open = true;
						}
						sent = DECLARE_PREFIX + statement.text;
						prefix = DECLARE_PREFIX.length;
						await exec(c.unsafe(sent, ONE_STATEMENT), signal);
						sent = statement.text;
						prefix = 0;
						let emitted = 0;
						let shape: Awaited<ReturnType<PostgresSession['resultShape']>> | null = null;
						while (true) {
							const room = maxRows - emitted;
							const want = room > 0 ? Math.min(BATCH, room) : 1;
							const result = await exec(c.unsafe(`FETCH ${want} FROM ${CURSOR}`).values(), signal);
							if (!shape) {
								shape = await this.resultShape(result);
								yield { t: 'columns', columns: shape.columns };
							}
							if (room <= 0) {
								if (result.length > 0) truncated = true;
								break;
							}
							if (result.length > 0) yield { t: 'rows', rows: decodeRows(result as unknown[][], shape.decoders) };
							emitted += result.length;
							if (result.length < want) break;
						}
						if (ownTransaction) {
							await exec(c.unsafe('COMMIT'), signal);
							open = false;
						} else if (!readOnly) await exec(c.unsafe(`CLOSE ${CURSOR}`), signal);
						yield { t: 'result', command: 'SELECT', affected: emitted };
					} else {
						if (!readOnly) open = true;
						const result = await exec(c.unsafe(statement.text, ONE_STATEMENT).values(), signal);
						if (!readOnly) {
							const effect = transactionEffect(statement);
							if (effect === 'begin') userTransaction = true;
							else if (effect === 'end') userTransaction = false;
							open = userTransaction;
						}
						let affected: number | undefined;
						if (result.columns && result.columns.length > 0) {
							const shape = await this.resultShape(result);
							yield { t: 'columns', columns: shape.columns };
							const rows = result as unknown[][];
							if (rows.length > maxRows) truncated = true;
							const kept = rows.slice(0, maxRows);
							for (let i = 0; i < kept.length; i += BATCH)
								yield { t: 'rows', rows: decodeRows(kept.slice(i, i + BATCH), shape.decoders) };
							affected = result.count;
						} else if (result.command && COUNTED_COMMANDS.has(result.command.split(' ')[0] as string)) affected = result.count;
						yield {
							t: 'result',
							...(result.command ? { command: result.command } : {}),
							...(affected !== undefined ? { affected } : {}),
						};
					}
					if (readOnly) {
						await exec(c.unsafe('ROLLBACK'), signal);
						open = false;
					}
				} catch (error) {
					if (isConnectionError(error)) this.dropRunConnection();
					const described = describeError(error, signal);
					if (described.code === 'cancelled' && signal.aborted) throw cancelled();
					const position =
						described.position !== undefined ? inputPosition(statement, sent, prefix, described.position) : undefined;
					yield {
						t: 'error',
						code: described.code,
						message: described.message,
						...(position !== undefined ? { position } : {}),
					};
					yield done(truncated);
					return;
				}
			}
			if (userTransaction)
				yield { t: 'notice', level: 'warn', message: 'The transaction left open at the end of the run was rolled back.' };
			yield done(truncated);
		} finally {
			if (open && conn && this.reserved === conn)
				await exec(conn.unsafe('ROLLBACK')).catch((error) => {
					if (isConnectionError(error)) this.dropRunConnection();
				});
			unlock();
		}
	}

	async explain(input: string, signal: AbortSignal): Promise<ExplainResult> {
		this.assertOpen();
		const statements = splitStatements(input);
		if (statements.length !== 1) throw new StudioError('bad_request', 'EXPLAIN takes exactly one statement.');
		const parsed = parseExplain((statements[0] as SqlStatement).text);
		if (parsed.analyze && this.options.readOnly)
			throw new StudioError('read_only', 'EXPLAIN ANALYZE runs the statement, so it needs a write session.');
		const text = `EXPLAIN (${['FORMAT JSON', ...parsed.options].join(', ')}) ${parsed.body}`;
		const unlock = await this.lock();
		let conn: ReservedSQL | null = null;
		try {
			// ANALYZE executes the statement; the transaction is always rolled back.
			conn = await this.firstCommand(this.options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN', signal);
			await exec(conn.unsafe(`SELECT pg_catalog.set_config('statement_timeout', $1::text, true)`, [String(this.options.limits.statementTimeoutMs)]), signal);
			const result = await exec(conn.unsafe(text, ONE_STATEMENT).values(), signal);
			const plan = (result as unknown[][])[0]?.[0];
			return { format: 'json', plan: typeof plan === 'string' ? JSON.parse(plan) : plan };
		} catch (error) {
			if (isConnectionError(error)) this.dropRunConnection();
			throw asStudioError(error, signal);
		} finally {
			if (conn && this.reserved === conn) await exec(conn.unsafe('ROLLBACK')).catch(() => undefined);
			unlock();
		}
	}

	/** Serialise run/explain on the reserved connection. */
	private async lock(): Promise<() => void> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		return release;
	}

	/**
	 * Send the first command of a run on the reserved connection, reserving one if needed. An
	 * idle reserved connection can be closed under us (server restart, idle timeout); the first
	 * command is idempotent, so it is retried once on a fresh connection.
	 */
	private async firstCommand(text: string, signal: AbortSignal): Promise<ReservedSQL> {
		for (let attempt = 0; ; attempt += 1) {
			if (!this.reserved) this.reserved = await this.sql.reserve({ signal });
			const conn = this.reserved;
			try {
				await exec(conn.unsafe(text), signal);
				return conn;
			} catch (error) {
				if (attempt === 0 && !signal.aborted && isConnectionError(error)) {
					this.dropRunConnection();
					continue;
				}
				throw error;
			}
		}
	}

	private dropRunConnection(): void {
		const conn = this.reserved;
		this.reserved = null;
		conn?.close({ timeout: 0 }).catch(() => undefined);
	}

	// ------------------------------------------------------------ apply

	async apply(object: ObjectRef, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		this.assertOpen();
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		const table = await this.table(object, signal, true);
		if (!table.description.editable)
			throw new StudioError('unsupported', table.description.reason ?? 'This object cannot be edited.');
		// Build every statement first, so a malformed change fails before anything runs.
		const statements = changes.map((change) => this.changeStatement(table, change));
		let conn: ReservedSQL;
		try {
			conn = await this.sql.reserve({ signal });
		} catch (error) {
			throw asStudioError(error, signal);
		}
		try {
			await exec(conn.unsafe('BEGIN'), signal);
			await exec(conn.unsafe(`SET LOCAL statement_timeout = ${this.options.limits.statementTimeoutMs}`), signal);
			const conflicts: ApplyResult['conflicts'] = [];
			for (const [index, statement] of statements.entries()) {
				const change = changes[index] as RowChange;
				let result: Result;
				try {
					result = await exec(conn.unsafe(statement.text, statement.params), signal);
				} catch (error) {
					const described = describeError(error, signal);
					// Integrity violations (duplicate key, FK, NOT NULL, check) are conflicts with
					// the current data; anything else is a bad change or an engine failure.
					if (described.sqlstate?.startsWith('23')) {
						conflicts.push({ index, reason: described.message });
						break;
					}
					throw new StudioError(described.code, `Change ${index + 1}: ${described.message}`);
				}
				if (change.op !== 'insert' && result.count !== 1) {
					const exists = await this.rowExists(conn, table, change.key, signal);
					conflicts.push({
						index,
						reason: exists
							? 'The row changed since it was loaded.'
							: 'The row no longer exists.',
					});
				}
			}
			if (conflicts.length > 0) {
				await exec(conn.unsafe('ROLLBACK'));
				return { applied: 0, conflicts };
			}
			await exec(conn.unsafe('COMMIT'), signal);
			return { applied: changes.length, conflicts: [] };
		} catch (error) {
			await exec(conn.unsafe('ROLLBACK')).catch(() => undefined);
			throw asStudioError(error, signal);
		} finally {
			await conn.release();
		}
	}

	private changeStatement(table: TableInfo, change: RowChange): { text: string; params: (string | null)[] } {
		const target = qualified(table.meta.schema, table.meta.name);
		const params = new Params();
		const column = (name: string) => {
			const meta = table.meta.columns.find((c) => c.name === name);
			if (!meta) throw new StudioError('bad_request', `Unknown column "${name}".`);
			return meta;
		};
		const assignments = (values: Record<string, Cell>) =>
			Object.entries(values).map(([name, cell]) => {
				const meta = column(name);
				if (table.readOnlyColumns.has(name))
					throw new StudioError('bad_request', `Column "${name}" is generated and cannot be written.`);
				return { ident: quoteIdent(name), value: params.add(textParam(cell, meta.kind, meta.elemKind), meta.castType) };
			});
		const returning = (table.meta.primaryKey ?? []).map(quoteIdent).join(', ');
		if (change.op === 'insert') {
			const values = assignments(change.values);
			if (values.length === 0) return { text: `INSERT INTO ${target} DEFAULT VALUES RETURNING ${returning}`, params: [] };
			return {
				text: `INSERT INTO ${target} (${values.map((v) => v.ident).join(', ')}) VALUES (${values.map((v) => v.value).join(', ')}) RETURNING ${returning}`,
				params: params.values,
			};
		}
		if (change.op === 'update') {
			const values = assignments(change.values);
			if (values.length === 0) throw new StudioError('bad_request', 'An update needs at least one value.');
			const set = values.map((v) => `${v.ident} = ${v.value}`).join(', ');
			const where = [...this.keyConditions(table, change.key, params), ...this.originalConditions(table, change.original, params)];
			return { text: `UPDATE ${target} SET ${set} WHERE ${where.join(' AND ')}`, params: params.values };
		}
		const where = [...this.keyConditions(table, change.key, params), ...this.originalConditions(table, change.original ?? {}, params)];
		return { text: `DELETE FROM ${target} WHERE ${where.join(' AND ')}`, params: params.values };
	}

	/** `pk = $n` for exactly the primary key columns, none NULL. */
	private keyConditions(table: TableInfo, key: Record<string, Cell>, params: Params): string[] {
		const primaryKey = table.meta.primaryKey;
		if (!primaryKey) throw new StudioError('unsupported', 'This object has no primary key.');
		const names = Object.keys(key);
		if (names.length !== primaryKey.length || !primaryKey.every((name) => Object.hasOwn(key, name)))
			throw new StudioError('bad_request', `The key must be exactly the primary key (${primaryKey.join(', ')}).`);
		return primaryKey.map((name) => {
			const meta = table.meta.columns.find((c) => c.name === name) as ColumnMeta;
			const cell = key[name] ?? null;
			if (cell === null) throw new StudioError('bad_request', `Key column "${name}" cannot be NULL.`);
			const { expr, cast } = comparable(meta);
			return `${expr} = ${params.add(textParam(cell, meta.kind, meta.elemKind), cast)}`;
		});
	}

	/** Optimistic concurrency: each original value must still be there. */
	private originalConditions(table: TableInfo, original: Record<string, Cell>, params: Params): string[] {
		return Object.entries(original).map(([name, cell]) => {
			const meta = table.meta.columns.find((c) => c.name === name);
			if (!meta) throw new StudioError('bad_request', `Unknown column "${name}".`);
			const { expr, cast } = comparable(meta);
			return `${expr} IS NOT DISTINCT FROM ${params.add(textParam(cell, meta.kind, meta.elemKind), cast)}`;
		});
	}

	private async rowExists(conn: ReservedSQL, table: TableInfo, key: Record<string, Cell>, signal: AbortSignal): Promise<boolean> {
		const params = new Params();
		const where = this.keyConditions(table, key, params);
		const rows = await exec(
			conn.unsafe(`SELECT 1 FROM ${qualified(table.meta.schema, table.meta.name)} WHERE ${where.join(' AND ')}`, params.values),
			signal,
		);
		return rows.length > 0;
	}

	// ------------------------------------------------------------ alter

	async alter(change: SchemaChange, options: { dryRun: boolean }, signal: AbortSignal): Promise<AlterResult> {
		this.assertOpen();
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		let statements: string[];
		try {
			statements = renderAlter(change, await this.alterContext(change, signal));
		} catch (error) {
			throw asStudioError(error, signal);
		}
		if (options.dryRun) return { statements, applied: false };
		let conn: ReservedSQL;
		try {
			conn = await this.sql.reserve({ signal });
		} catch (error) {
			throw asStudioError(error, signal);
		}
		try {
			await exec(conn.unsafe('BEGIN'), signal);
			await exec(conn.unsafe(`SET LOCAL statement_timeout = ${this.options.limits.statementTimeoutMs}`), signal);
			for (const statement of statements) await exec(conn.unsafe(statement), signal);
			await exec(conn.unsafe('COMMIT'), signal);
			return { statements, applied: true };
		} catch (error) {
			await exec(conn.unsafe('ROLLBACK')).catch(() => undefined);
			throw asStudioError(error, signal);
		} finally {
			// Even a failed DDL may have committed nothing but changed what describe should show.
			this.tables.clear();
			await conn.release();
		}
	}

	/** What `renderAlter` needs from the catalog for this change. */
	private async alterContext(change: SchemaChange, signal: AbortSignal): Promise<AlterContext> {
		if (!('object' in change) || change.object.path.length !== 2) return { relkind: null };
		const [schema, name] = change.object.path as [string, string];
		const [relation] = (await exec(this.sql.unsafe(RELATION_SQL, [schema, name]), signal)) as { relkind: string }[];
		if (!relation) throw new StudioError('not_found', `No table or view ${schema}.${name}.`);
		if (change.op !== 'drop-index') return { relkind: relation.relkind };
		const [index] = (await exec(this.sql.unsafe(INDEX_OWNER_SQL, [schema, name, change.name]), signal)) as {
			constraint: string | null;
		}[];
		if (!index) throw new StudioError('not_found', `No index ${change.name} on ${schema}.${name}.`);
		return { relkind: relation.relkind, indexConstraint: index.constraint };
	}

	// ------------------------------------------------------------ lifecycle

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const conn = this.reserved;
		this.reserved = null;
		await conn?.close({ timeout: 0 }).catch(() => undefined);
		await this.sql.close({ timeout: 1 }).catch(() => undefined);
	}

	private assertOpen(): void {
		if (this.closed) throw new StudioError('unknown_session', 'The session is closed.');
	}
}

function decodeRows(rows: unknown[][], decoders: Decoder[]): Cell[][] {
	return rows.map((row) => row.map((value, i) => (decoders[i] as Decoder)(value)));
}

/** A browse cell, turning an over-size server-side preview into a `truncated` cell. */
function previewCell(value: unknown, size: number | undefined, preview: 'text' | 'bytes' | 'json' | null, decode: Decoder): Cell {
	if (value === null || value === undefined) return null;
	if (preview && size !== undefined && size > CELL_PREVIEW_BYTES) {
		if (preview === 'bytes') {
			const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
			const cell = bytesCell(bytes.subarray(0, 256));
			return { $t: 'truncated', v: typeof cell === 'object' && cell && !Array.isArray(cell) ? cell.v : '', bytes: size };
		}
		const cell = textCell(String(value), CELL_PREVIEW_BYTES);
		return { $t: 'truncated', v: typeof cell === 'string' ? cell : typeof cell === 'object' && cell && !Array.isArray(cell) ? cell.v : '', bytes: size };
	}
	return decode(value);
}

// ---------------------------------------------------------------- explain

const EXPLAIN_OPTION = /^[a-z_]+$/;
const EXPLAIN_VALUE = /^[A-Za-z0-9_]+$/;

/**
 * Split a user's `EXPLAIN [ANALYZE] [VERBOSE] …` or `EXPLAIN (opts) …` into options and the
 * statement, so the plugin can force `FORMAT JSON` and see whether ANALYZE was asked for.
 * Input without EXPLAIN is the statement itself.
 */
export function parseExplain(text: string): { body: string; analyze: boolean; options: string[] } {
	const lead = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/.exec(text)?.[0].length ?? 0;
	let rest = text.slice(lead);
	const head = /^explain\b/i.exec(rest);
	if (!head) return { body: text, analyze: false, options: [] };
	rest = rest.slice(head[0].length).trimStart();
	const options: string[] = [];
	let analyze = false;
	if (rest.startsWith('(')) {
		const close = rest.indexOf(')');
		if (close < 0) throw new StudioError('bad_request', 'EXPLAIN options are missing a closing parenthesis.');
		for (const part of rest.slice(1, close).split(',')) {
			const [rawName, rawValue, ...extra] = part.trim().split(/\s+/);
			const name = (rawName ?? '').toLowerCase();
			if (!name) continue;
			if (extra.length > 0 || !EXPLAIN_OPTION.test(name) || (rawValue !== undefined && !EXPLAIN_VALUE.test(rawValue)))
				throw new StudioError('bad_request', `Unsupported EXPLAIN option "${part.trim()}".`);
			if (name === 'format') continue;
			const on = rawValue === undefined || /^(true|on|1|yes)$/i.test(rawValue);
			if (name === 'analyze' || name === 'analyse') {
				analyze = on;
				if (on) options.push('ANALYZE');
				continue;
			}
			options.push(rawValue === undefined ? name.toUpperCase() : `${name.toUpperCase()} ${rawValue}`);
		}
		rest = rest.slice(close + 1).trimStart();
	} else {
		for (;;) {
			const word = /^(analyze|analyse|verbose)\b/i.exec(rest);
			if (!word) break;
			const name = (word[1] as string).toLowerCase();
			if (name === 'verbose') options.push('VERBOSE');
			else {
				analyze = true;
				options.push('ANALYZE');
			}
			rest = rest.slice(word[0].length).trimStart();
		}
	}
	if (!rest) throw new StudioError('bad_request', 'EXPLAIN needs a statement.');
	return { body: rest, analyze, options };
}
