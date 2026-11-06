/**
 * In-memory relational plugin used by the agent/studio-process tests, the conformance kit's
 * self-test and dashboard development. It implements the whole `StudioSession` contract against
 * one schema (`public`) with a table (`items`, 250 rows) and a view (`item_names`).
 *
 * `run` understands a tiny language, one statement per line or `;`:
 *   select * from items        all rows (streams in batches of 100)
 *   select count               one row with the row count
 *   sleep <ms>                 waits, honouring abort (for cancel tests)
 *   delete from items          a write (refused in read-only sessions)
 *   fail                       an engine error
 */
import { databaseEngines, type DatabaseEngine } from '@skiff/contracts';
import { bigintCell, cellToParam, datetimeCell, decimalCell, jsonCell } from './cells.ts';
import type { RunOptions, SessionOptions, StudioPlugin, StudioSession, StudioTarget } from './driver.ts';
import {
	StudioError,
	type ApplyResult,
	type BrowseQuery,
	type Cell,
	type Column,
	type ObjectDescription,
	type ObjectRef,
	type RowChange,
	type StudioCapabilities,
	type StudioEvent,
	type TreeNode,
	type TreePath,
} from './protocol.ts';

export const FAKE_ROW_COUNT = 250;

const COLUMNS: Column[] = [
	{ name: 'id', nativeType: 'integer', kind: 'number', nullable: false, key: 'primary', editable: false },
	{ name: 'name', nativeType: 'text', kind: 'text', nullable: false, editable: true },
	{ name: 'amount', nativeType: 'numeric(12,2)', kind: 'decimal', nullable: true, editable: true },
	{ name: 'big', nativeType: 'bigint', kind: 'bigint', nullable: true, editable: true },
	{ name: 'meta', nativeType: 'jsonb', kind: 'json', nullable: true, editable: true },
	{ name: 'created', nativeType: 'timestamptz', kind: 'datetime', nullable: false, editable: true },
];

type Row = Record<string, Cell>;

function seed(): Map<number, Row> {
	const rows = new Map<number, Row>();
	for (let id = 1; id <= FAKE_ROW_COUNT; id += 1) {
		rows.set(id, {
			id,
			name: `item ${String(id).padStart(3, '0')}`,
			amount: decimalCell((id * 1.25).toFixed(2)),
			big: bigintCell(BigInt(id) * 100_000_000_000_000n),
			meta: jsonCell({ even: id % 2 === 0 }),
			created: datetimeCell(new Date(Date.UTC(2026, 0, 1, 0, 0, id))),
		});
	}
	return rows;
}

const CAPABILITIES: StudioCapabilities = {
	family: 'relational',
	language: 'sql',
	dialect: 'postgres',
	edit: 'primary-key',
	cancel: 'native',
	explain: true,
	schemas: true,
};

export interface FakePluginOptions {
	/** Engines the fake claims; defaults to every engine so any activation can use it. */
	engines?: readonly DatabaseEngine[];
	/** Called on connect; throw to simulate a refused connection. */
	onConnect?: (target: StudioTarget, options: SessionOptions) => void;
}

export function createFakePlugin(options: FakePluginOptions = {}): StudioPlugin {
	return {
		id: 'fake',
		engines: options.engines ?? databaseEngines,
		capabilities: () => CAPABILITIES,
		async connect(target, sessionOptions) {
			options.onConnect?.(target, sessionOptions);
			return new FakeSession(sessionOptions);
		},
	};
}

export const fakePlugin: StudioPlugin = createFakePlugin();

class FakeSession implements StudioSession {
	private readonly rows = seed();
	private closed = false;

	constructor(private readonly options: SessionOptions) {}

	async tree(path: TreePath): Promise<TreeNode[]> {
		this.assertOpen();
		if (path.length === 0)
			return [{ path: ['public'], name: 'public', kind: 'schema', hasChildren: true, browsable: false }];
		if (path.length === 1 && path[0] === 'public')
			return [
				{
					path: ['public', 'item_names'],
					name: 'item_names',
					kind: 'view',
					hasChildren: false,
					browsable: true,
				},
				{
					path: ['public', 'items'],
					name: 'items',
					kind: 'table',
					hasChildren: false,
					browsable: true,
					detail: { rows: this.rows.size },
				},
			];
		return [];
	}

	async describe(object: ObjectRef): Promise<ObjectDescription> {
		this.assertOpen();
		const table = this.resolve(object);
		const columns = table === 'items' ? COLUMNS : COLUMNS.filter((c) => c.name === 'id' || c.name === 'name');
		return {
			object,
			columns,
			primaryKey: table === 'items' ? ['id'] : null,
			indexes: table === 'items' ? [{ name: 'items_pkey', columns: ['id'], unique: true }] : [],
			foreignKeys: [],
			ddl: table === 'items' ? 'CREATE TABLE public.items (id integer PRIMARY KEY, ...)' : undefined,
			estimate: { rows: this.rows.size },
			editable: table === 'items' && !this.options.readOnly,
			...(table === 'items'
				? this.options.readOnly
					? { reason: 'The session is read-only.' }
					: {}
				: { reason: 'Views have no primary key.' }),
		};
	}

	async *browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const started = performance.now();
		const table = this.resolve(object);
		const description = await this.describe(object);
		yield { t: 'columns', columns: description.columns };
		let rows = [...this.rows.values()];
		for (const filter of query.filter) rows = rows.filter((row) => matches(row[filter.column] ?? null, filter.op, filter.value ?? null));
		const sort = query.sort[0];
		if (sort) rows.sort((a, b) => compare(a[sort.column] ?? null, b[sort.column] ?? null) * (sort.dir === 'asc' ? 1 : -1));
		const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
		const page = rows.slice(offset, offset + query.limit);
		if (signal.aborted) throw new StudioError('cancelled', 'Browse was cancelled.');
		yield { t: 'rows', rows: page.map((row) => description.columns.map((c) => row[c.name] ?? null)) };
		const next = offset + page.length < rows.length ? String(offset + page.length) : null;
		yield { t: 'page', next, estimate: rows.length };
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated: false };
		void table;
	}

	async *run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const started = performance.now();
		const statements = input
			.split(/[;\n]/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		let truncated = false;
		for (const statement of statements) {
			if (signal.aborted) throw new StudioError('cancelled', 'The query was cancelled.');
			if (statement === 'select * from items') {
				yield { t: 'columns', columns: COLUMNS };
				const all = [...this.rows.values()];
				const capped = all.slice(0, options.maxRows);
				truncated ||= capped.length < all.length;
				for (let i = 0; i < capped.length; i += 100) {
					if (signal.aborted) throw new StudioError('cancelled', 'The query was cancelled.');
					yield { t: 'rows', rows: capped.slice(i, i + 100).map((row) => COLUMNS.map((c) => row[c.name] ?? null)) };
				}
				yield { t: 'result', command: 'SELECT', affected: capped.length };
			} else if (statement === 'select count') {
				yield { t: 'columns', columns: [{ name: 'count', nativeType: 'bigint', kind: 'bigint' }] };
				yield { t: 'rows', rows: [[this.rows.size]] };
				yield { t: 'result', command: 'SELECT', affected: 1 };
			} else if (statement.startsWith('sleep ')) {
				const ms = Math.min(Number.parseInt(statement.slice(6), 10) || 0, options.timeoutMs);
				await abortableSleep(ms, signal);
				if (ms === options.timeoutMs) throw new StudioError('timeout', 'The statement timed out.');
				yield { t: 'result', command: 'SLEEP' };
			} else if (statement === 'delete from items') {
				if (this.options.readOnly)
					throw new StudioError('read_only', 'cannot execute DELETE in a read-only transaction');
				const affected = this.rows.size;
				this.rows.clear();
				yield { t: 'result', command: 'DELETE', affected };
			} else if (statement === 'fail') {
				yield { t: 'error', code: 'engine_error', message: 'syntax error at or near "fail"', position: 1 };
				yield { t: 'done', ms: Math.round(performance.now() - started), truncated };
				return;
			} else {
				yield { t: 'error', code: 'unsupported', message: `The fake engine does not understand "${statement}".` };
				yield { t: 'done', ms: Math.round(performance.now() - started), truncated };
				return;
			}
		}
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated };
	}

	async explain(input: string) {
		this.assertOpen();
		return { format: 'text' as const, plan: `Seq Scan on items  (fake plan for: ${input.slice(0, 80)})` };
	}

	async apply(object: ObjectRef, changes: RowChange[]): Promise<ApplyResult> {
		this.assertOpen();
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		if (this.resolve(object) !== 'items') throw new StudioError('unsupported', 'Views cannot be edited.');
		const draft = new Map([...this.rows].map(([id, row]) => [id, { ...row }]));
		const conflicts: ApplyResult['conflicts'] = [];
		changes.forEach((change, index) => {
			if (change.op === 'insert') {
				const id = Number(cellToParam(change.values.id ?? null) ?? Math.max(0, ...draft.keys()) + 1);
				if (draft.has(id)) return conflicts.push({ index, reason: `A row with id ${id} already exists.` });
				draft.set(id, { ...Object.fromEntries(COLUMNS.map((c) => [c.name, null])), ...change.values, id });
				return;
			}
			const id = Number(cellToParam(change.key.id ?? null));
			const row = draft.get(id);
			if (!row) return conflicts.push({ index, reason: `Row ${id} no longer exists.` });
			for (const [column, value] of Object.entries(change.original ?? {}))
				if (JSON.stringify(row[column] ?? null) !== JSON.stringify(value))
					return conflicts.push({ index, reason: `Row ${id} changed since it was loaded (${column}).` });
			if (change.op === 'delete') draft.delete(id);
			else Object.assign(row, change.values);
		});
		if (conflicts.length > 0) return { applied: 0, conflicts };
		this.rows.clear();
		for (const [id, row] of draft) this.rows.set(id, row);
		return { applied: changes.length, conflicts: [] };
	}

	async value(object: ObjectRef, key: Record<string, Cell>, column: string): Promise<Cell> {
		this.assertOpen();
		this.resolve(object);
		const row = this.rows.get(Number(cellToParam(key.id ?? null)));
		if (!row) throw new StudioError('not_found', 'The row no longer exists.');
		return row[column] ?? null;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private resolve(object: ObjectRef): 'items' | 'item_names' {
		const [schema, table] = object.path;
		if (schema === 'public' && (table === 'items' || table === 'item_names')) return table;
		throw new StudioError('not_found', `No object ${object.path.join('.')}.`);
	}

	private assertOpen(): void {
		if (this.closed) throw new StudioError('unknown_session', 'The session is closed.');
	}
}

function plain(cell: Cell): unknown {
	const value = cellToParam(cell);
	return typeof value === 'bigint' ? Number(value) : value;
}

function compare(a: Cell, b: Cell): number {
	const x = plain(a);
	const y = plain(b);
	if (x === y) return 0;
	if (x === null || x === undefined) return -1;
	if (y === null || y === undefined) return 1;
	const nx = Number(x);
	const ny = Number(y);
	if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
	return String(x).localeCompare(String(y));
}

function matches(cell: Cell, op: string, value: Cell): boolean {
	const c = compare(cell, value);
	switch (op) {
		case 'eq':
			return c === 0;
		case 'ne':
			return c !== 0;
		case 'lt':
			return c < 0;
		case 'lte':
			return c <= 0;
		case 'gt':
			return c > 0;
		case 'gte':
			return c >= 0;
		case 'like':
		case 'ilike': {
			const pattern = String(plain(value)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
			return new RegExp(`^${pattern}$`, op === 'ilike' ? 'i' : '').test(String(plain(cell)));
		}
		case 'in':
			return Array.isArray(value) && value.some((v) => compare(cell, v) === 0);
		case 'is-null':
			return cell === null;
		case 'not-null':
			return cell !== null;
		default:
			return false;
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new StudioError('cancelled', 'The query was cancelled.'));
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new StudioError('cancelled', 'The query was cancelled.'));
			},
			{ once: true },
		);
	});
}
