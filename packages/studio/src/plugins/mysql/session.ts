/**
 * One studio session against MySQL or MariaDB, on mysql2. A one-connection pool serves
 * tree/describe/browse/apply/value/explain; `run` has its own dedicated connection, so a long
 * query never blocks browsing and can be cancelled by killing exactly that connection.
 *
 * Cancel (abort, timeout, or a result cut at maxRows that would not finish quickly) is
 * `KILL CONNECTION <run thread id>` from a short-lived side connection, then the run
 * connection is discarded and recreated on the next run. `KILL QUERY` is never used: it races
 * with the next statement on the same connection.
 */
import { EventEmitter } from 'node:events';
import {
	createConnection,
	createPool,
	TypedParameter,
	type Connection,
	type ConnectionOptions,
	type FieldPacket,
	type Pool,
	type PoolConnection,
	type ResultSetHeader,
	type RowDataPacket,
} from 'mysql2/promise';
import type { Connection as CoreConnectionType } from 'mysql2';
import type { RunOptions, SessionOptions, StudioSession, StudioTarget } from '../../driver.ts';
import {
	StudioError,
	type ApplyResult,
	type BrowseQuery,
	type Cell,
	type Column,
	type ExplainResult,
	type ObjectDescription,
	type ObjectRef,
	type RowChange,
	type StudioErrorCode,
	type StudioEvent,
	type TreeNode,
	type TreePath,
} from '../../protocol.ts';
import {
	buildBrowse,
	buildDelete,
	buildInsert,
	buildUpdate,
	buildValue,
	isTypedParam,
	leadingKeyword,
	nextCursor,
	readOnlyRefusal,
	splitStatements,
	syntaxErrorPosition,
	withStatementTimeout,
	type ColumnMeta,
	type Dialect,
	type Param,
	type SqlFragment,
	type Statement,
	type TableMeta,
} from './sql.ts';
import { encodeCell, fieldMapping, jsonCheckColumn, schemaKind, type FieldInfo } from './types.ts';

/** Rows per `rows` event (protocol maximum). */
const BATCH_ROWS = 500;
/** Pause the socket when this many decoded rows wait for the consumer; resume below LOW. */
const HIGH_WATER = 2_000;
const LOW_WATER = 500;
/** After maxRows, keep reading (and discarding) this long for the result to end by itself. */
const DRAIN_MS = 250;
/** The server-side timeout is a backstop that fires this long after the client-side timer. */
const SERVER_TIMEOUT_GRACE_MS = 1_000;
const KILL_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** Browse re-describes the table; a short cache keeps paging to one catalog round trip. */
const DESCRIBE_TTL_MS = 5_000;
/** Longest a run waits for the run it replaced to finish its cleanup. */
const RUN_LOCK_WAIT_MS = 3_000;

/** The callback-style connection under a promise wrapper: it has the event API and pause/resume. */
type CoreConnection = CoreConnectionType;
const coreOf = (connection: Connection): CoreConnection =>
	(connection as unknown as { connection: CoreConnection }).connection;
type InterruptReason = 'abort' | 'timeout' | 'drain';
type PumpItem =
	| { t: 'fields'; fields: FieldPacket[] }
	| { t: 'row'; row: unknown[] }
	| { t: 'ok'; header: ResultSetHeader }
	| { t: 'error'; error: MysqlError }
	| { t: 'end' }
	| { t: 'interrupt'; reason: InterruptReason };

interface MysqlError extends Error {
	errno?: number;
	sqlState?: string;
	code?: string;
	sqlMessage?: string;
	fatal?: boolean;
}

/**
 * Bridges a mysql2 query's events to pull-style iteration with backpressure. The spike found
 * that rows already buffered on the socket keep arriving after `destroy()`, so once
 * interrupted the pump stops handing anything out and `detach()` drops later events.
 */
class Pump {
	private readonly items: PumpItem[] = [];
	private queuedRows = 0;
	private wake: (() => void) | null = null;
	private interruptedBy: InterruptReason | null = null;
	private paused = false;
	private detached = false;

	constructor(
		private readonly connection: CoreConnection,
		emitter: EventEmitter,
	) {
		emitter.on('fields', (fields?: FieldPacket[]) => {
			if (fields) this.push({ t: 'fields', fields });
		});
		emitter.on('result', (row: unknown) => {
			if (Array.isArray(row)) this.push({ t: 'row', row });
			else this.push({ t: 'ok', header: row as ResultSetHeader });
		});
		emitter.on('error', (error: MysqlError) => this.push({ t: 'error', error }));
		emitter.on('end', () => this.push({ t: 'end' }));
	}

	interrupt(reason: InterruptReason): void {
		this.interruptedBy ??= reason;
		this.notify();
	}

	get interrupted(): InterruptReason | null {
		return this.interruptedBy;
	}

	/** Stop the socket and ignore everything that still arrives. */
	detach(): void {
		this.detached = true;
		this.items.length = 0;
		this.queuedRows = 0;
		try {
			this.connection.pause();
		} catch {
			// Already destroyed.
		}
	}

	async next(): Promise<PumpItem> {
		while (true) {
			if (this.interruptedBy) return { t: 'interrupt', reason: this.interruptedBy };
			const item = this.items.shift();
			if (item) {
				if (item.t === 'row') this.rowTaken();
				return item;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	/** The next queued row without waiting, for filling a batch. */
	takeRow(): unknown[] | null {
		if (this.interruptedBy) return null;
		const item = this.items[0];
		if (item?.t !== 'row') return null;
		this.items.shift();
		this.rowTaken();
		return item.row;
	}

	private push(item: PumpItem): void {
		if (this.detached) return;
		this.items.push(item);
		if (item.t === 'row') {
			this.queuedRows += 1;
			if (!this.paused && this.queuedRows >= HIGH_WATER) {
				this.paused = true;
				this.connection.pause();
			}
		}
		this.notify();
	}

	private rowTaken(): void {
		this.queuedRows -= 1;
		if (this.paused && this.queuedRows <= LOW_WATER) {
			this.paused = false;
			// mysql2 replays every buffered packet synchronously inside resume(). Calling it from
			// here would re-enter push() in a tight loop that starves timers (abort, timeout,
			// drain) for the whole result, so give the event loop a turn first.
			setImmediate(() => {
				if (!this.detached && !this.paused) this.connection.resume();
			});
		}
	}

	private notify(): void {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}
}

/** mysql2 typed bind parameters for the plugin's `Param`s. */
function bind(params: Param[]): unknown[] {
	return params.map((param) => {
		if (!isTypedParam(param)) return param;
		switch (param.typed) {
			case 'BIGINT':
				return TypedParameter.BIGINT(param.value);
			case 'BIGINT UNSIGNED':
				return TypedParameter.BIGINT.unsigned(param.value);
			case 'DECIMAL':
				return TypedParameter.DECIMAL(param.value);
		}
	});
}

function errorCode(error: MysqlError, readOnly: boolean): StudioErrorCode {
	switch (error.errno) {
		case 1792: // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
		case 1290: // ER_OPTION_PREVENTS_STATEMENT (--read-only)
			return 'read_only';
		case 1044: // ER_DBACCESS_DENIED_ERROR
		case 1142: // ER_TABLEACCESS_DENIED_ERROR
		case 1143: // ER_COLUMNACCESS_DENIED_ERROR
		case 1227: // ER_SPECIFIC_ACCESS_DENIED_ERROR
		case 1370: // ER_PROCACCESS_DENIED_ERROR
			// The read-only principal (Phase 3) is refused by privileges rather than the transaction.
			return readOnly ? 'read_only' : 'forbidden';
		case 3024: // ER_QUERY_TIMEOUT (MySQL MAX_EXECUTION_TIME)
		case 1969: // ER_STATEMENT_TIMEOUT (MariaDB max_statement_time)
			return 'timeout';
		case 1317: // ER_QUERY_INTERRUPTED
			return 'cancelled';
		case 1146: // ER_NO_SUCH_TABLE
			return 'not_found';
		default:
			return 'engine_error';
	}
}

/** The server's message plus its errno/SQLSTATE, the way the mysql client prints them. */
function errorMessage(error: MysqlError): string {
	const message = error.sqlMessage ?? error.message;
	if (error.errno === undefined) return message;
	return `ERROR ${error.errno} (${error.sqlState ?? 'HY000'}): ${message}`;
}

function toStudio(error: unknown, readOnly: boolean): StudioError {
	if (error instanceof StudioError) return error;
	const mysql = error as MysqlError;
	return new StudioError(errorCode(mysql, readOnly), errorMessage(mysql));
}

interface CachedTable {
	at: number;
	table: TableMeta;
	description: ObjectDescription;
}

export class MysqlSession implements StudioSession {
	private readonly dialect: Dialect;
	private readonly readOnly: boolean;
	private readonly pool: Pool;
	private run$: Connection | null;
	private closed = false;
	private readonly tables = new Map<string, CachedTable>();
	private runLock: Promise<void> = Promise.resolve();
	private readonly kills = new WeakMap<Connection, Promise<void>>();

	private constructor(
		private readonly target: StudioTarget,
		options: SessionOptions,
		private readonly connectionOptions: ConnectionOptions,
		runConnection: Connection,
	) {
		this.dialect = target.engine === 'mariadb' ? 'mariadb' : 'mysql';
		this.readOnly = options.readOnly;
		this.run$ = runConnection;
		this.pool = createPool({ ...connectionOptions, connectionLimit: 1, maxIdle: 1, idleTimeout: 60_000, enableKeepAlive: true });
		this.pool.on('connection', (connection) => {
			const core = connection as unknown as CoreConnection;
			// Fresh table statistics for the tree (MySQL caches them for a day by default).
			if (this.dialect === 'mysql') core.query('SET SESSION information_schema_stats_expiry = 0', () => undefined);
			// A read-only session never writes through the pool either.
			if (this.readOnly) core.query('SET SESSION transaction_read_only = ON', () => undefined);
		});
	}

	static async open(target: StudioTarget, options: SessionOptions): Promise<MysqlSession> {
		const connectionOptions = connectionOptionsFor(target);
		// Connect the run connection eagerly so bad credentials fail the activation, not the first click.
		const run = await openConnection(connectionOptions);
		return new MysqlSession(target, options, connectionOptions, run);
	}

	// ------------------------------------------------------------ tree and describe

	async tree(path: TreePath, signal: AbortSignal): Promise<TreeNode[]> {
		this.assertOpen(signal);
		if (path.length > 0) return [];
		const rows = await this.select<{ name: string; type: string; tableRows: number | string | null; bytes: number | string | null }>(
			`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS tableRows,
				DATA_LENGTH + INDEX_LENGTH AS bytes
			FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
			[this.target.database],
		);
		return rows.map((row) => {
			const view = /VIEW/i.test(row.type);
			const detail: NonNullable<TreeNode['detail']> = {};
			if (!view && row.tableRows !== null) detail.rows = Number(row.tableRows);
			if (!view && row.bytes !== null) detail.bytes = Number(row.bytes);
			return {
				path: [row.name],
				name: row.name,
				kind: view ? 'view' : 'table',
				hasChildren: false,
				browsable: true,
				...(Object.keys(detail).length > 0 ? { detail } : {}),
			} satisfies TreeNode;
		});
	}

	async describe(object: ObjectRef, signal: AbortSignal): Promise<ObjectDescription> {
		this.assertOpen(signal);
		return (await this.table(object, true)).description;
	}

	private async table(object: ObjectRef, fresh = false): Promise<CachedTable> {
		if (object.path.length !== 1 || (object.kind !== 'table' && object.kind !== 'view'))
			throw new StudioError('not_found', `No table or view ${object.path.join('.')}.`);
		const name = object.path[0] as string;
		const cached = this.tables.get(name);
		if (!fresh && cached && performance.now() - cached.at < DESCRIBE_TTL_MS) return cached;
		const loaded = await this.load(object, name);
		this.tables.set(name, loaded);
		return loaded;
	}

	private async load(object: ObjectRef, name: string): Promise<CachedTable> {
		const db = this.target.database;
		const [info] = await this.select<{ type: string; tableRows: number | string | null; bytes: number | string | null }>(
			`SELECT TABLE_TYPE AS type, TABLE_ROWS AS tableRows, DATA_LENGTH + INDEX_LENGTH AS bytes
			FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
			[db, name],
		);
		if (!info) throw new StudioError('not_found', `No table or view ${name}.`);
		const view = /VIEW/i.test(info.type);
		const [columns, statistics, foreign, checks] = await Promise.all([
			this.select<{
				name: string;
				dataType: string;
				columnType: string;
				nullable: string;
				extra: string | null;
			}>(
				`SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
					IS_NULLABLE AS nullable, EXTRA AS extra
				FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
				[db, name],
			),
			this.select<{ index: string; nonUnique: number | string; column: string | null; type: string | null }>(
				`SELECT INDEX_NAME AS \`index\`, NON_UNIQUE AS nonUnique, COLUMN_NAME AS \`column\`, INDEX_TYPE AS type
				FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
				ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
				[db, name],
			),
			this.select<{ name: string; column: string; refSchema: string; refTable: string; refColumn: string }>(
				`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS \`column\`, k.REFERENCED_TABLE_SCHEMA AS refSchema,
					k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refColumn
				FROM information_schema.KEY_COLUMN_USAGE k
				JOIN information_schema.REFERENTIAL_CONSTRAINTS r
					ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
					AND r.TABLE_NAME = k.TABLE_NAME
				WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
				ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
				[db, name],
			),
			// MariaDB stores JSON as LONGTEXT with a json_valid() CHECK; that is the only marker.
			this.dialect === 'mariadb'
				? this.select<{ clause: string }>(
						`SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
						WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
						[db, name],
					)
				: Promise.resolve([]),
		]);
		const jsonColumns = new Set(checks.map((row) => jsonCheckColumn(row.clause)).filter((c): c is string => c !== null));
		const primaryKey = statistics.filter((row) => row.index === 'PRIMARY' && row.column).map((row) => row.column as string);
		const keyed = primaryKey.length > 0 ? primaryKey : null;
		const uniqueColumns = new Set(
			statistics.filter((row) => Number(row.nonUnique) === 0 && row.index !== 'PRIMARY' && row.column).map((row) => row.column),
		);
		const metas: ColumnMeta[] = columns.map((row) => {
			const extra = (row.extra ?? '').toLowerCase();
			const json = row.dataType.toLowerCase() === 'json' || jsonColumns.has(row.name);
			return {
				name: row.name,
				kind: schemaKind(row.dataType, row.columnType, json),
				nativeType: json && row.dataType.toLowerCase() !== 'json' ? 'json' : row.columnType,
				nullable: row.nullable === 'YES',
				unsigned: /unsigned/i.test(row.columnType),
				generated: extra.includes('generated') && !extra.includes('default_generated'),
				autoIncrement: extra.includes('auto_increment'),
			};
		});
		const table: TableMeta = { name, view, columns: metas, primaryKey: view ? null : keyed };
		const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; definition?: string }>();
		for (const row of statistics) {
			const entry = indexes.get(row.index) ?? {
				name: row.index,
				columns: [],
				unique: Number(row.nonUnique) === 0,
				...(row.type ? { definition: row.type } : {}),
			};
			// Functional key parts (MySQL 8) have no column name.
			entry.columns.push(row.column ?? '(expression)');
			indexes.set(row.index, entry);
		}
		const foreignKeys = new Map<string, ObjectDescription['foreignKeys'][number]>();
		for (const row of foreign) {
			const entry = foreignKeys.get(row.name) ?? {
				name: row.name,
				columns: [],
				references: { path: row.refSchema === db ? [row.refTable] : [row.refSchema, row.refTable], columns: [] },
			};
			entry.columns.push(row.column);
			entry.references.columns.push(row.refColumn);
			foreignKeys.set(row.name, entry);
		}
		let ddl: string | undefined;
		try {
			const [rows] = await this.pool.query<RowDataPacket[]>({ sql: `SHOW CREATE TABLE ${quote(name)}`, rowsAsArray: true });
			const first = rows[0] as unknown as unknown[] | undefined;
			if (first && typeof first[1] === 'string') ddl = first[1];
		} catch {
			// SHOW CREATE needs privileges a narrow credential may lack; the DDL is optional.
		}
		const reason = view
			? 'Views are not editable.'
			: !keyed
				? 'The table has no primary key, so rows cannot be identified for editing.'
				: this.readOnly
					? 'The session is read-only.'
					: undefined;
		const description: ObjectDescription = {
			object,
			columns: metas.map(
				(meta): Column => ({
					name: meta.name,
					nativeType: meta.nativeType,
					kind: meta.kind,
					nullable: meta.nullable,
					key: keyed?.includes(meta.name) ? 'primary' : uniqueColumns.has(meta.name) ? 'unique' : null,
					editable: !meta.generated && !meta.autoIncrement,
				}),
			),
			primaryKey: table.primaryKey,
			indexes: [...indexes.values()],
			foreignKeys: [...foreignKeys.values()],
			...(ddl ? { ddl } : {}),
			estimate: {
				...(info.tableRows !== null ? { rows: Number(info.tableRows) } : {}),
				...(info.bytes !== null ? { bytes: Number(info.bytes) } : {}),
			},
			editable: reason === undefined,
			...(reason ? { reason } : {}),
		};
		return { at: performance.now(), table, description };
	}

	// ------------------------------------------------------------ browse

	async *browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen(signal);
		const started = performance.now();
		if (query.native !== undefined || query.type !== undefined)
			throw new StudioError('unsupported', 'MySQL and MariaDB browse with column filters, not a native filter.');
		const { table, description } = await this.table(object);
		const plan = buildBrowse(table, query, this.dialect);
		const keyIndexes = (table.primaryKey ?? []).map((name) => table.columns.findIndex((c) => c.name === name));
		yield { t: 'columns', columns: description.columns };
		const pooled = await this.pool.getConnection();
		const core = pooled.connection as unknown as CoreConnection;
		const command = core.execute({ sql: plan.sql, values: bind(plan.params), rowsAsArray: true } as never) as unknown as EventEmitter;
		const pump = new Pump(core, command);
		const onAbort = () => pump.interrupt('abort');
		signal.addEventListener('abort', onAbort, { once: true });
		let finished = false;
		let emitted = 0;
		let lastKey: Cell[] | null = null;
		let more = false;
		try {
			while (true) {
				const item = await pump.next();
				if (item.t === 'interrupt') throw new StudioError('cancelled', 'Browse was cancelled.');
				if (item.t === 'error') throw toStudio(item.error, this.readOnly);
				if (item.t === 'end') {
					finished = true;
					break;
				}
				if (item.t !== 'row') continue;
				const batch: Cell[][] = [];
				let row: unknown[] | null = item.row;
				while (row) {
					if (emitted >= plan.limit) more = true;
					else {
						const cells = table.columns.map((column, i) => encodeCell(column.kind, row?.[i]));
						batch.push(cells);
						emitted += 1;
						if (keyIndexes.length > 0) lastKey = keyIndexes.map((i) => cells[i] ?? null);
					}
					row = batch.length < BATCH_ROWS ? pump.takeRow() : null;
				}
				if (batch.length > 0) yield { t: 'rows', rows: batch };
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			if (finished) pooled.release();
			else {
				// The page is bounded by LIMIT, but a consumer that stopped early leaves the
				// protocol mid-result; drop that connection rather than return it to the pool.
				pump.detach();
				pooled.connection.destroy();
			}
		}
		const estimate = description.estimate?.rows;
		yield {
			t: 'page',
			next: more ? nextCursor(plan, lastKey) : null,
			...(estimate !== undefined ? { estimate } : {}),
		};
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated: false };
	}

	// ------------------------------------------------------------ run

	async *run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen(signal);
		const started = performance.now();
		const done = (truncated: boolean): StudioEvent => ({ t: 'done', ms: Math.round(performance.now() - started), truncated });
		let statements: Statement[];
		try {
			statements = splitStatements(input);
			if (this.readOnly)
				for (const statement of statements) {
					const refusal = readOnlyRefusal(statement);
					if (refusal) throw new StudioError('read_only', refusal);
				}
		} catch (error) {
			const failure = toStudio(error, this.readOnly);
			yield { t: 'error', code: failure.code, message: failure.message };
			yield done(false);
			return;
		}
		// One run at a time on the run connection. A replaced run was aborted, which already
		// killed its connection, so waiting is bounded; the cap only guards a stalled consumer.
		const previous = this.runLock;
		let release = () => {};
		this.runLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await Promise.race([previous, Bun.sleep(RUN_LOCK_WAIT_MS)]);
		// DDL in a run may change any table; describe again afterwards.
		this.tables.clear();
		let truncated = false;
		let openTransaction = false;
		let last: Connection | null = null;
		try {
			for (const [index, statement] of statements.entries()) {
				if (signal.aborted) throw new StudioError('cancelled', 'The query was cancelled.');
				last = await this.runConnection();
				const outcome = yield* this.runStatement(last, statement, options, signal);
				truncated ||= outcome.truncated;
				if (outcome.inTransaction !== null) openTransaction = outcome.inTransaction;
				if (outcome.stop) {
					const remaining = statements.length - index - 1;
					if (outcome.stop === 'cut' && remaining > 0)
						yield {
							t: 'notice',
							level: 'warn',
							message: `The result was cut at ${options.maxRows} rows and the query was stopped, so the remaining ${remaining} statement(s) did not run.`,
						};
					yield done(truncated);
					return;
				}
			}
			if (!this.readOnly && openTransaction)
				yield {
					t: 'notice',
					level: 'warn',
					message: 'The run ended inside a transaction, which was rolled back. Add COMMIT to keep the changes.',
				};
			yield done(truncated);
		} finally {
			if (last) await this.endRun(last);
			release();
		}
	}

	/**
	 * One statement on the run connection. Read-only sessions wrap it in a fresh read-only
	 * transaction (re-asserting the session flag first, so a previous statement cannot have
	 * turned it off) and roll back afterwards.
	 */
	private async *runStatement(
		connection: Connection,
		statement: Statement,
		options: RunOptions,
		signal: AbortSignal,
	): AsyncGenerator<StudioEvent, { stop: false | 'error' | 'cut'; truncated: boolean; inTransaction: boolean | null }> {
		const core = coreOf(connection);
		if (this.readOnly) {
			await connection.query('SET SESSION transaction_read_only = ON');
			await connection.query('START TRANSACTION READ ONLY');
		}
		const sql = withStatementTimeout(statement, this.dialect, options.timeoutMs + SERVER_TIMEOUT_GRACE_MS);
		const command = core.query({ sql, rowsAsArray: true }) as unknown as EventEmitter;
		const pump = new Pump(core, command);
		// Abort and timeout kill the connection straight away, even while this generator is
		// suspended at a `yield` waiting for a slow consumer; the loop then reports it.
		const stop = (reason: InterruptReason) => {
			pump.interrupt(reason);
			void this.kill(connection);
		};
		const onAbort = () => stop('abort');
		if (signal.aborted) stop('abort');
		signal.addEventListener('abort', onAbort, { once: true });
		// Timers can lag behind a fast stream, so the row loop also checks both deadlines itself.
		const deadline = performance.now() + options.timeoutMs;
		const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let drainDeadline = Number.POSITIVE_INFINITY;
		const keyword = leadingKeyword(statement) ?? 'SQL';
		let columns: ReturnType<typeof fieldMapping>[] | null = null;
		let rowsInResult = 0;
		let truncated = false;
		/** From the last OK packet; null when the statement only returned result sets. */
		let inTransaction: boolean | null = null;
		let settled = false;
		const closeResult = (): StudioEvent | null => {
			if (!columns) return null;
			columns = null;
			return { t: 'result', command: keyword, affected: rowsInResult };
		};
		try {
			while (true) {
				const item = await pump.next();
				switch (item.t) {
					case 'interrupt': {
						pump.detach();
						await this.kill(connection);
						settled = true;
						if (item.reason === 'abort') throw new StudioError('cancelled', 'The query was cancelled.');
						if (item.reason === 'timeout') {
							yield {
								t: 'error',
								code: 'timeout',
								message: `The statement ran longer than ${formatSeconds(options.timeoutMs)} and was stopped.`,
							};
							return { stop: 'error', truncated, inTransaction: false };
						}
						const closing = closeResult();
						if (closing) yield closing;
						return { stop: 'cut', truncated: true, inTransaction: false };
					}
					case 'fields': {
						const closing = closeResult();
						if (closing) yield closing;
						columns = item.fields.map((field) => fieldMapping(field as unknown as FieldInfo));
						rowsInResult = 0;
						yield {
							t: 'columns',
							columns: item.fields.map((field, i) => ({
								name: field.name,
								nativeType: columns?.[i]?.nativeType ?? 'unknown',
								kind: columns?.[i]?.kind ?? 'unknown',
							})),
						};
						break;
					}
					case 'row': {
						const mapping = columns ?? [];
						const batch: Cell[][] = [];
						let row: unknown[] | null = item.row;
						while (row) {
							if (rowsInResult + batch.length < options.maxRows) {
								const values = row;
								batch.push(mapping.map((column, i) => encodeCell(column.kind, values[i])));
							} else if (!truncated) {
								// Stop counting at maxRows. Give a small result time to end by itself (the
								// connection stays usable); a big one is killed once the drain deadline passes.
								truncated = true;
								drainDeadline = performance.now() + DRAIN_MS;
								drainTimer = setTimeout(() => pump.interrupt('drain'), DRAIN_MS);
							}
							row = batch.length < BATCH_ROWS ? pump.takeRow() : null;
						}
						const now = performance.now();
						if (now > drainDeadline) pump.interrupt('drain');
						if (now > deadline) pump.interrupt('timeout');
						rowsInResult += batch.length;
						if (batch.length > 0) yield { t: 'rows', rows: batch };
						break;
					}
					case 'ok': {
						const closing = closeResult();
						if (closing) yield closing;
						const header = item.header;
						inTransaction = Boolean(header.serverStatus & 1); // SERVER_STATUS_IN_TRANS
						yield { t: 'result', command: keyword, affected: header.affectedRows };
						if (header.warningStatus > 0) for (const notice of await this.warnings(connection)) yield notice;
						break;
					}
					case 'error': {
						settled = true;
						const closing = closeResult();
						if (closing) yield closing;
						const failure = toStudio(item.error, this.readOnly);
						const position = item.error.errno === 1064 ? syntaxErrorPosition(statement, failure.message) : undefined;
						yield { t: 'error', code: failure.code, message: failure.message, ...(position ? { position } : {}) };
						if (item.error.fatal) this.discard(connection);
						else await this.rollbackStatement(connection);
						return { stop: 'error', truncated, inTransaction: false };
					}
					case 'end': {
						settled = true;
						const closing = closeResult();
						if (closing) yield closing;
						await this.rollbackStatement(connection);
						return { stop: false, truncated, inTransaction };
					}
				}
			}
		} finally {
			clearTimeout(timer);
			clearTimeout(drainTimer);
			signal.removeEventListener('abort', onAbort);
			// The consumer stopped early (closed tab, byte limit): the statement may still be running.
			if (!settled) {
				pump.detach();
				await this.kill(connection);
			}
		}
	}

	/** Read-only sessions end every statement's transaction; write sessions keep it until the run ends. */
	private async rollbackStatement(connection: Connection): Promise<void> {
		if (!this.readOnly || this.run$ !== connection) return;
		await connection.query('ROLLBACK').catch(() => this.discard(connection));
	}

	/** Transactions never span runs: roll back whatever the user left open, restore autocommit. */
	private async endRun(connection: Connection): Promise<void> {
		// A killed or replaced connection has nothing left to roll back.
		if (this.run$ !== connection || this.closed) return;
		try {
			await connection.query('ROLLBACK');
			if (!this.readOnly) await connection.query('SET autocommit = 1');
		} catch {
			this.discard(connection);
		}
	}

	private async warnings(connection: Connection): Promise<StudioEvent[]> {
		try {
			const [rows] = await connection.query<RowDataPacket[]>('SHOW WARNINGS LIMIT 5');
			return rows.map((row) => ({
				t: 'notice',
				level: 'warn',
				message: `${String(row.Level ?? 'Warning')} ${String(row.Code ?? '')}: ${String(row.Message ?? '')}`.trim(),
			}));
		} catch {
			return [];
		}
	}

	private async runConnection(): Promise<Connection> {
		if (this.closed) throw new StudioError('unknown_session', 'The session is closed.');
		this.run$ ??= await openConnection(this.connectionOptions);
		return this.run$;
	}

	/** Drop `connection` without killing it (it already failed). Never touches a newer one. */
	private discard(connection: Connection): void {
		if (this.run$ === connection) this.run$ = null;
		coreOf(connection).destroy();
	}

	/**
	 * `KILL CONNECTION` the run connection from a side connection, then discard it. Killing the
	 * whole connection (not `KILL QUERY`) means no later statement can be hit by a late kill.
	 * Idempotent per connection, and it detaches the connection synchronously, so the next run
	 * opens a fresh one while the kill is still in flight.
	 */
	private kill(connection: Connection): Promise<void> {
		if (this.run$ === connection) this.run$ = null;
		let killing = this.kills.get(connection);
		if (killing) return killing;
		killing = this.killNow(connection);
		this.kills.set(connection, killing);
		return killing;
	}

	private async killNow(connection: Connection): Promise<void> {
		const core = coreOf(connection);
		const threadId = core.threadId;
		try {
			core.pause();
		} catch {
			// Already gone.
		}
		if (Number.isSafeInteger(threadId) && threadId > 0) {
			let side: Connection | null = null;
			try {
				side = await withTimeout(openConnection(this.connectionOptions), KILL_TIMEOUT_MS);
				await withTimeout(side.query(`KILL CONNECTION ${threadId}`), KILL_TIMEOUT_MS);
			} catch {
				// The thread may already be gone (1094 unknown thread); destroying the socket below is enough then.
			} finally {
				if (side) coreOf(side).destroy();
			}
		}
		core.destroy();
	}

	// ------------------------------------------------------------ explain

	async explain(input: string, signal: AbortSignal): Promise<ExplainResult> {
		this.assertOpen(signal);
		const statements = splitStatements(input);
		const statement = statements[0];
		if (!statement || statements.length !== 1) throw new StudioError('bad_request', 'EXPLAIN takes exactly one statement.');
		if (this.readOnly) {
			const refusal = readOnlyRefusal(statement);
			if (refusal) throw new StudioError('read_only', refusal);
		}
		// MariaDB's ANALYZE executes the statement, so only write sessions get it, and both run
		// inside a transaction that is always rolled back.
		const prefix = this.dialect === 'mariadb' && !this.readOnly ? 'ANALYZE FORMAT=JSON' : 'EXPLAIN FORMAT=JSON';
		const pooled = await this.pool.getConnection();
		let healthy = true;
		try {
			if (this.readOnly) {
				await pooled.query('SET SESSION transaction_read_only = ON');
				await pooled.query('START TRANSACTION READ ONLY');
			} else await pooled.query('START TRANSACTION');
			const [rows] = await pooled.query<RowDataPacket[]>({ sql: `${prefix} ${statement.text}`, rowsAsArray: true });
			const text = (rows[0] as unknown as unknown[] | undefined)?.[0];
			if (typeof text !== 'string') return { format: 'text', plan: String(text ?? '') };
			try {
				return { format: 'json', plan: JSON.parse(text) };
			} catch {
				return { format: 'text', plan: text };
			}
		} catch (error) {
			throw toStudio(error, this.readOnly);
		} finally {
			await pooled.query('ROLLBACK').catch(() => {
				healthy = false;
			});
			if (healthy) pooled.release();
			else pooled.connection.destroy();
		}
	}

	// ------------------------------------------------------------ apply and value

	async apply(object: ObjectRef, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		this.assertOpen(signal);
		if (this.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		const { table } = await this.table(object, true);
		// Build every statement first, so a malformed change fails before anything runs.
		const planned: SqlFragment[] = changes.map((change) => {
			switch (change.op) {
				case 'insert':
					return buildInsert(table, change.values);
				case 'update':
					return buildUpdate(table, change, this.dialect);
				case 'delete':
					return buildDelete(table, change, this.dialect);
			}
		});
		const pooled = await this.pool.getConnection();
		let healthy = true;
		try {
			await pooled.query('START TRANSACTION');
			const conflicts: ApplyResult['conflicts'] = [];
			for (const [index, fragment] of planned.entries()) {
				if (signal.aborted) throw new StudioError('cancelled', 'The edit was cancelled.');
				try {
					const [result] = await pooled.execute<ResultSetHeader>(fragment.sql, bind(fragment.params) as never);
					if (result.affectedRows !== 1)
						conflicts.push({
							index,
							reason:
								changes[index]?.op === 'insert'
									? `The insert affected ${result.affectedRows} rows.`
									: 'The row changed since it was loaded, or no longer exists.',
						});
				} catch (error) {
					const mysql = error as MysqlError;
					// Row-level refusals (duplicate key, constraint, bad value) are conflicts for that change.
					if (mysql.errno === undefined || mysql.fatal) throw error;
					conflicts.push({ index, reason: errorMessage(mysql) });
				}
			}
			if (conflicts.length > 0) {
				await pooled.query('ROLLBACK');
				return { applied: 0, conflicts };
			}
			await pooled.query('COMMIT');
			this.tables.delete(table.name);
			return { applied: changes.length, conflicts: [] };
		} catch (error) {
			await pooled.query('ROLLBACK').catch(() => {
				healthy = false;
			});
			throw toStudio(error, this.readOnly);
		} finally {
			if (healthy) pooled.release();
			else pooled.connection.destroy();
		}
	}

	async value(object: ObjectRef, key: Record<string, Cell>, column: string, signal: AbortSignal): Promise<Cell> {
		this.assertOpen(signal);
		const { table } = await this.table(object);
		const meta = table.columns.find((c) => c.name === column);
		const fragment = buildValue(table, key, column);
		let rows: RowDataPacket[];
		try {
			[rows] = await this.pool.execute<RowDataPacket[]>({ sql: fragment.sql, rowsAsArray: true }, bind(fragment.params) as never);
		} catch (error) {
			throw toStudio(error, this.readOnly);
		}
		const row = rows[0] as unknown as unknown[] | undefined;
		if (!row) throw new StudioError('not_found', 'The row no longer exists.');
		return encodeCell(meta?.kind ?? 'unknown', row[0], Number.POSITIVE_INFINITY);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const run = this.run$;
		this.run$ = null;
		await Promise.allSettled([run ? withTimeout(run.end(), 2_000).catch(() => coreOf(run).destroy()) : undefined, this.pool.end()]);
	}

	// ------------------------------------------------------------ helpers

	private async select<T>(sql: string, params: unknown[]): Promise<T[]> {
		try {
			const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params as never);
			return rows as unknown as T[];
		} catch (error) {
			throw toStudio(error, this.readOnly);
		}
	}

	private assertOpen(signal: AbortSignal): void {
		if (this.closed) throw new StudioError('unknown_session', 'The session is closed.');
		if (signal.aborted) throw new StudioError('cancelled', 'The request was cancelled.');
	}
}

function quote(name: string): string {
	return `\`${name.replaceAll('`', '``')}\``;
}

function formatSeconds(ms: number): string {
	return ms % 1_000 === 0 ? `${ms / 1_000} s` : `${(ms / 1_000).toFixed(1)} s`;
}

export function connectionOptionsFor(target: StudioTarget): ConnectionOptions {
	return {
		host: target.host,
		port: target.port,
		user: target.user,
		password: target.password,
		database: target.database,
		charset: 'utf8mb4',
		connectTimeout: CONNECT_TIMEOUT_MS,
		supportBigNumbers: true,
		bigNumberStrings: true,
		// Temporal values as the server's text: lossless, and MySQL zero dates survive.
		dateStrings: true,
		// JSON as text on both engines; the plugin parses it (MariaDB JSON is LONGTEXT anyway).
		jsonStrings: true,
		decimalNumbers: false,
		multipleStatements: false,
		// FOUND_ROWS: affectedRows counts matched rows, so an unchanged UPDATE still counts 1.
		// -LOCAL_FILES: a statement must never be able to make the studio read its own files.
		flags: ['FOUND_ROWS', '-LOCAL_FILES'],
		...(target.tls
			? { ssl: target.tls.caPem ? { ca: target.tls.caPem, rejectUnauthorized: true } : { rejectUnauthorized: false } }
			: {}),
	};
}

async function openConnection(options: ConnectionOptions): Promise<Connection> {
	const connection = await createConnection(options);
	// A killed or dropped connection emits 'error'; without a listener that would crash the process.
	coreOf(connection).on('error', () => undefined);
	return connection;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
