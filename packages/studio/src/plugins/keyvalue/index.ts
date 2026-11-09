/**
 * Key-value studio plugin for Valkey and Redis (plan 22, Phase 2 track D), on Bun's built-in
 * RedisClient (RESP3, `send()` for every command, no extra dependency).
 *
 * Shape of the tree: one `keyspace` node for the session's logical database, then `key-group`
 * nodes split on `:` from a bounded SCAN sample, then `key` nodes. A keyspace or group browses
 * as a table of keys (`key`, `type`, `ttl`, `size`, `value`); a key browses as its contents
 * (hash fields, list items, set members, zset members with scores, stream entries).
 *
 * Connections: one client for tree/describe/browse/apply/value and one for `run`, so a slow
 * command cannot stall browsing. Redis cannot cancel a running command, so `run` races the
 * statement timeout and, when it loses (or the request is aborted), closes and replaces the run
 * client so a late reply can never be read as the answer to the next command.
 *
 * Edits use optimistic concurrency with `WATCH` → compare → `MULTI … EXEC` on the primary
 * client. Bun pipelines every concurrent `send` on one socket, so a browse running at the same
 * time would land inside the transaction; a small shared/exclusive gate keeps the primary client
 * to itself for the few milliseconds an apply takes. That keeps the session at two connections
 * and needs no scripting (which a server may not allow).
 */
import { RedisClient, type RedisOptions } from 'bun';
import { bytesCell, cellToParam, jsonCell, textCell } from '../../cells.ts';
import type { RunOptions, SessionOptions, StudioPlugin, StudioSession, StudioTarget } from '../../driver.ts';
import {
	StudioError,
	type AlterResult,
	type ApplyResult,
	type BrowseQuery,
	type Cell,
	type Column,
	type ObjectDescription,
	type ObjectRef,
	type RowChange,
	type SchemaChange,
	type StudioCapabilities,
	type StudioEvent,
	type TreeNode,
	type TreePath,
} from '../../protocol.ts';
import { decodeCursor, encodeCursor, MAX_CURSOR_CHARS, type BrowseCursor } from './cursor.ts';
import { flagsFor, gateCommand, parseCommandInfo, type CommandSpec } from './gate.ts';
import { KEYVALUE_STRUCTURE, commandLine } from './structure.ts';
import { jsonSafe, shapeReply } from './shape.ts';
import { argText, tokenize, TokenizeError, type CommandArg } from './tokenize.ts';

export { tokenize, TokenizeError } from './tokenize.ts';
export { gateCommand, parseCommandInfo, flagsFor, STATIC_READ_COMMANDS } from './gate.ts';
export { shapeReply } from './shape.ts';
export { encodeCursor, decodeCursor } from './cursor.ts';

const CAPABILITIES: StudioCapabilities = {
	family: 'keyvalue',
	language: 'redis',
	edit: 'key',
	cancel: 'none',
	explain: false,
	schemas: true,
	structure: [...KEYVALUE_STRUCTURE],
};

const DELIMITER = ':';
/** The tree stops sampling after about this many keys or this long, and says it is approximate. */
const TREE_SAMPLE_KEYS = 2_000;
const TREE_SAMPLE_MS = 200;
const SCAN_COUNT = 500;
/** A browse page stops scanning after this long or this many SCAN calls, even with few rows. */
const PAGE_BUDGET_MS = 250;
const PAGE_MAX_SCANS = 200;
/** Browse previews are small: a page of 1,000 64 KB strings would blow the 16 MB budget. */
const BROWSE_PREVIEW_BYTES = 4_096;
/** `value` of a non-string key returns at most this many elements. */
const VALUE_MAX_ITEMS = 10_000;
/** PTTL only falls while nobody touches a key; allow a little for rounding. */
const TTL_SLACK_MS = 50;
const ROW_BATCH = 500;
const PATH_SEGMENT_MAX = 1_024;
const PATH_DEPTH_MAX = 16;

export const keyvaluePlugin: StudioPlugin = {
	id: 'keyvalue',
	engines: ['valkey', 'redis'],
	capabilities: () => CAPABILITIES,
	connect: (target, options) => KeyValueSession.open(target, options),
};

// ---------------------------------------------------------------- columns

const col = (name: string, nativeType: string, kind: Column['kind'], extra: Partial<Column> = {}): Column => ({
	name,
	nativeType,
	kind,
	nullable: true,
	editable: false,
	...extra,
});

const KEYSPACE_COLUMNS: Column[] = [
	col('key', 'key', 'text', { nullable: false, key: 'primary' }),
	col('type', 'type', 'text', { nullable: false }),
	col('ttl', 'pttl (ms)', 'number', { editable: true }),
	col('size', 'memory usage (bytes)', 'number'),
	col('value', 'string', 'text', { editable: true }),
];

function keyColumns(type: string): Column[] {
	switch (type) {
		case 'hash':
			return [col('field', 'hash field', 'text', { nullable: false, key: 'primary' }), col('value', 'string', 'text', { editable: true })];
		case 'list':
			return [col('index', 'list index', 'number', { nullable: false, key: 'primary' }), col('value', 'string', 'text', { editable: true })];
		case 'set':
			return [col('member', 'set member', 'text', { nullable: false, key: 'primary', editable: true })];
		case 'zset':
			return [col('member', 'zset member', 'text', { nullable: false, key: 'primary' }), col('score', 'double', 'number', { editable: true })];
		case 'stream':
			return [col('id', 'stream id', 'text', { nullable: false, key: 'primary' }), col('fields', 'stream entry', 'json')];
		case 'string':
			return [col('value', 'string', 'text', { editable: true })];
		default:
			return [col('value', type, 'unknown')];
	}
}

/** The column that identifies a row inside a key of this type. */
const ROW_KEY: Record<string, string | undefined> = { hash: 'field', list: 'index', set: 'member', zset: 'member', stream: 'id' };

// ---------------------------------------------------------------- connection

function hostPart(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** The logical database index; Yoal always uses `0`, anything else must be a small integer. */
function databaseIndex(target: StudioTarget): string {
	return /^\d{1,5}$/.test(target.database) ? String(Number(target.database)) : '0';
}

export function clientUrl(target: StudioTarget): string {
	const scheme = target.tls ? 'rediss' : 'redis';
	const auth = `${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@`;
	return `${scheme}://${auth}${hostPart(target.host)}:${target.port}/${databaseIndex(target)}`;
}

function clientOptions(target: StudioTarget): RedisOptions {
	return {
		connectionTimeout: 10_000,
		// Bun's default (20 retries with backoff) keeps `connect()` pending for a long time when
		// nothing listens or the password is wrong; a few retries still ride out a blip.
		maxRetries: 3,
		// Bun verifies the server certificate against `ca` (or the system store) and the URL host.
		...(target.tls ? { tls: target.tls.caPem ? { ca: target.tls.caPem } : true } : {}),
	};
}

async function openClient(target: StudioTarget): Promise<RedisClient> {
	const client = new RedisClient(clientUrl(target), clientOptions(target));
	try {
		await client.connect();
	} catch (error) {
		client.close();
		throw new StudioError(
			'engine_error',
			`Could not connect to ${target.engine} on ${target.host}:${target.port} (${message(error)}). Check the credential and that the database is running.`,
		);
	}
	// Best effort: the read-only principal (`+@read` only) may not run CLIENT SETNAME.
	await client.send('CLIENT', ['SETNAME', 'yoal-studio']).catch(() => undefined);
	return client;
}

/** Bun's `send` is typed `string[]` but writes buffers verbatim, which binary values need. */
function send(client: RedisClient, command: string, args: readonly CommandArg[]): Promise<unknown> {
	return client.send(command, args as unknown as string[]);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cancelled(): StudioError {
	return new StudioError('cancelled', 'The request was cancelled.');
}

/**
 * Shared/exclusive access to the primary client: browse, tree, describe and value share it,
 * apply takes it alone so nothing is pipelined into its WATCH/MULTI/EXEC.
 */
class ClientGate {
	private readonly shared = new Set<Promise<unknown>>();
	private exclusive: Promise<unknown> | null = null;

	async read<T>(fn: () => Promise<T>): Promise<T> {
		while (this.exclusive) await this.exclusive.catch(() => undefined);
		const work = fn();
		this.shared.add(work);
		try {
			return await work;
		} finally {
			this.shared.delete(work);
		}
	}

	async write<T>(fn: () => Promise<T>): Promise<T> {
		while (this.exclusive) await this.exclusive.catch(() => undefined);
		// Set synchronously after the loop, so a second writer or new readers wait for this one.
		const work = (async () => {
			await Promise.allSettled([...this.shared]);
			return fn();
		})();
		this.exclusive = work;
		try {
			return await work;
		} finally {
			if (this.exclusive === work) this.exclusive = null;
		}
	}
}

// ---------------------------------------------------------------- helpers

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Bytes that are valid UTF-8 are text; anything else is a `bytes` cell. */
function bytesToCell(bytes: Uint8Array, limit: number): Cell {
	try {
		return textCell(strictUtf8.decode(bytes), limit);
	} catch {
		return bytesCell(bytes, limit);
	}
}

/** Escape a literal for a SCAN MATCH glob. */
export function globEscape(literal: string): string {
	return literal.replace(/[*?[\]\\]/g, '\\$&');
}

/** Key-value builds trees from `:`-delimited key names: `user:1:name` → `user:` → `user:1:`. */
export function groupKeys(prefix: string, keys: Iterable<string>): { groups: Map<string, number>; leaves: string[] } {
	const groups = new Map<string, number>();
	const leaves: string[] = [];
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		const rest = key.slice(prefix.length);
		const at = rest.indexOf(DELIMITER);
		if (at >= 0) {
			const group = prefix + rest.slice(0, at + 1);
			groups.set(group, (groups.get(group) ?? 0) + 1);
		} else {
			leaves.push(key);
		}
	}
	return { groups, leaves: leaves.sort() };
}

/**
 * Skip levels with nothing to choose: while a group holds exactly one subgroup and no keys of
 * its own, show the subgroup instead (`studio:` holding only `studio:item:*` becomes
 * `studio:item:`), as one click less in the tree.
 */
export function collapseGroup(group: string, keys: readonly string[]): string {
	let current = group;
	let members = keys.filter((key) => key.startsWith(group));
	while (true) {
		const { groups, leaves } = groupKeys(current, members);
		const only = groups.size === 1 && leaves.length === 0 ? [...groups.keys()][0] : undefined;
		if (only === undefined) return current;
		current = only;
		members = members.filter((key) => key.startsWith(only));
	}
}

/** A command argument from a cell the UI sent. */
function argFromCell(cell: Cell | undefined, what: string): CommandArg {
	if (cell === undefined || cell === null) throw new StudioError('bad_request', `${what} is required.`);
	let value: unknown;
	try {
		value = cellToParam(cell);
	} catch (error) {
		throw new StudioError('bad_request', `${what}: ${message(error)}`);
	}
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return value;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

function textFromCell(cell: Cell | undefined, what: string): string {
	const arg = argFromCell(cell, what);
	if (typeof arg !== 'string') throw new StudioError('bad_request', `${what} must be text.`);
	return arg;
}

function argBytes(arg: CommandArg): Uint8Array {
	return typeof arg === 'string' ? encoder.encode(arg) : arg;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

function ttlFromCell(cell: Cell | undefined): number | null {
	if (cell === null || cell === undefined) return null;
	const value = typeof cell === 'object' ? Number(cellToParam(cell)) : Number(cell);
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new StudioError('bad_request', 'A TTL is a whole number of milliseconds above 0, or empty for no expiry.');
	return value;
}

/** PTTL only decreases unless someone else changed the expiry. */
function ttlMatches(original: Cell, pttl: number): boolean {
	if (original === null) return pttl === -1;
	const expected = Number(typeof original === 'object' ? cellToParam(original) : original);
	return Number.isFinite(expected) && pttl >= 0 && pttl <= expected + TTL_SLACK_MS;
}

function plainCell(cell: Cell): unknown {
	try {
		const value = cellToParam(cell);
		return typeof value === 'bigint' ? Number(value) : value;
	} catch {
		return null;
	}
}

function compareCells(a: Cell, b: Cell): number {
	const x = plainCell(a);
	const y = plainCell(b);
	if (x === y) return 0;
	if (x === null || x === undefined) return -1;
	if (y === null || y === undefined) return 1;
	const nx = Number(x);
	const ny = Number(y);
	if (!Number.isNaN(nx) && !Number.isNaN(ny) && typeof x !== 'object' && typeof y !== 'object') return nx - ny;
	return String(x).localeCompare(String(y));
}

/** Client-side filters: SCAN is unordered and only filters by glob and type. */
export function matchesFilters(row: Record<string, Cell>, filters: BrowseQuery['filter']): boolean {
	return filters.every(({ column, op, value }) => {
		const cell = row[column] ?? null;
		const target = value ?? null;
		switch (op) {
			case 'is-null':
				return cell === null;
			case 'not-null':
				return cell !== null;
			case 'in':
				return Array.isArray(target) && target.some((v) => compareCells(cell, v) === 0);
			case 'like':
			case 'ilike': {
				if (cell === null) return false;
				const pattern = String(plainCell(target))
					.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
					.replace(/%/g, '.*')
					.replace(/_/g, '.');
				return new RegExp(`^${pattern}$`, op === 'ilike' ? 'is' : 's').test(String(plainCell(cell)));
			}
			default: {
				if (cell === null) return op === 'ne' ? target !== null : false;
				const c = compareCells(cell, target);
				if (op === 'eq') return c === 0;
				if (op === 'ne') return c !== 0;
				if (op === 'lt') return c < 0;
				if (op === 'lte') return c <= 0;
				if (op === 'gt') return c > 0;
				return c >= 0;
			}
		}
	});
}

function checkFilterColumns(filters: BrowseQuery['filter'], columns: Column[]): void {
	const names = new Set(columns.map((c) => c.name));
	for (const filter of filters)
		if (!names.has(filter.column)) throw new StudioError('bad_request', `Unknown column ${filter.column}.`);
}

function sortNotice(query: BrowseQuery, ordered: string | null): StudioEvent[] {
	if (query.sort.length === 0) return [];
	return [
		{
			t: 'notice',
			level: 'info',
			message: ordered
				? `Rows come in ${ordered} order; sorting is not supported here.`
				: 'SCAN returns keys in no particular order, so sorting is not supported here.',
		},
	];
}

function* rowEvents(rows: Cell[][]): Generator<StudioEvent> {
	for (let i = 0; i < rows.length; i += ROW_BATCH) yield { t: 'rows', rows: rows.slice(i, i + ROW_BATCH) };
}

/** Pairs `[k, v, k, v]` (stream entry fields) as an object. */
function pairsToObject(pairs: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (Array.isArray(pairs)) for (let i = 0; i + 1 < pairs.length; i += 2) out[String(pairs[i])] = jsonSafe(pairs[i + 1]);
	else if (pairs && typeof pairs === 'object') for (const [k, v] of Object.entries(pairs)) out[k] = jsonSafe(v);
	return out;
}

type Scope = { kind: 'keyspace' | 'key-group'; prefix: string } | { kind: 'key'; key: string };
type Conflict = ApplyResult['conflicts'][number];
type Command = [string, CommandArg[]];

// ---------------------------------------------------------------- session

class KeyValueSession implements StudioSession {
	private runClient: RedisClient | null = null;
	private readonly gate = new ClientGate();
	private readonly commandSpecs = new Map<string, CommandSpec | null>();
	private commandInfoUnavailable = false;
	private closed = false;
	private readonly db: string;

	private constructor(
		private readonly target: StudioTarget,
		private readonly options: SessionOptions,
		private readonly primary: RedisClient,
	) {
		this.db = databaseIndex(target);
	}

	static async open(target: StudioTarget, options: SessionOptions): Promise<KeyValueSession> {
		return new KeyValueSession(target, options, await openClient(target));
	}

	// ------------------------------------------------------------ tree

	async tree(path: TreePath, signal: AbortSignal): Promise<TreeNode[]> {
		this.assertOpen();
		if (path.length === 0) {
			const rows = Number(await this.read(() => this.p('DBSIZE', [])));
			return [
				{ path: [this.db], name: `db${this.db}`, kind: 'keyspace', hasChildren: rows > 0, browsable: true, detail: { rows } },
			];
		}
		if (path[0] !== this.db) throw new StudioError('not_found', `No keyspace ${path[0]}.`);
		const prefix = path.length > 1 ? (path.at(-1) ?? '') : '';
		const sample = await this.sampleKeys(prefix, signal);
		const { groups, leaves } = groupKeys(prefix, sample.keys);
		const canNest = path.length + 1 < PATH_DEPTH_MAX;
		const groupNodes: TreeNode[] = [...groups.entries()]
			// Only a complete sample proves a group has a single child; otherwise a key outside the
			// sample could hide behind the collapsed node.
			.map(([group, rows]): [string, number] => [sample.complete ? collapseGroup(group, sample.keys) : group, rows])
			.filter(([group]) => group.length <= PATH_SEGMENT_MAX)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([group, rows]) => {
				const node: KeyValueTreeNode = {
					path: [...path, group],
					name: group.slice(prefix.length),
					kind: 'key-group',
					hasChildren: canNest,
					browsable: true,
					// `approximate` is extra to the protocol's detail: the counts come from a sample.
					detail: { rows, ...(sample.complete ? {} : { approximate: true }) },
				};
				return node;
			});
		const keys = leaves.filter((key) => key.length <= PATH_SEGMENT_MAX);
		const [types, ttls] = keys.length
			? await this.read(() =>
					Promise.all([
						Promise.all(keys.map((key) => this.p('TYPE', [key]))),
						Promise.all(keys.map((key) => this.p('PTTL', [key]))),
					]),
				)
			: [[], []];
		const keyNodes: TreeNode[] = [];
		keys.forEach((key, i) => {
			const type = String(types[i]);
			if (type === 'none') return;
			const ttl = Number(ttls[i]);
			keyNodes.push({
				path: [...path, key],
				name: key.slice(prefix.length),
				kind: 'key',
				hasChildren: false,
				browsable: true,
				detail: { type, ...(ttl >= 0 ? { ttlMs: ttl } : {}) },
			});
		});
		return [...groupNodes, ...keyNodes];
	}

	/** A bounded SCAN of `prefix*`: about 2,000 keys or 200 ms, whichever comes first. */
	private async sampleKeys(prefix: string, signal: AbortSignal): Promise<{ keys: string[]; complete: boolean }> {
		const pattern = `${globEscape(prefix)}*`;
		const seen = new Set<string>();
		const started = performance.now();
		let cursor = '0';
		do {
			if (signal.aborted) throw cancelled();
			const [next, batch] = (await this.read(() =>
				this.p('SCAN', [cursor, 'MATCH', pattern, 'COUNT', String(SCAN_COUNT)]),
			)) as [string, string[]];
			for (const key of batch) seen.add(String(key));
			cursor = String(next);
		} while (cursor !== '0' && seen.size < TREE_SAMPLE_KEYS && performance.now() - started < TREE_SAMPLE_MS);
		return { keys: [...seen], complete: cursor === '0' };
	}

	// ------------------------------------------------------------ describe

	async describe(object: ObjectRef, signal: AbortSignal): Promise<ObjectDescription> {
		this.assertOpen();
		const scope = this.resolve(object);
		const readOnly = this.options.readOnly;
		const base = { object, indexes: [], foreignKeys: [] };
		if (signal.aborted) throw cancelled();
		if (scope.kind !== 'key') {
			const rows = scope.kind === 'keyspace' ? Number(await this.read(() => this.p('DBSIZE', []))) : undefined;
			return {
				...base,
				columns: KEYSPACE_COLUMNS,
				primaryKey: ['key'],
				...(rows === undefined ? {} : { estimate: { rows } }),
				editable: !readOnly,
				...(readOnly ? { reason: 'The session is read-only.' } : {}),
			};
		}
		const type = await this.keyType(scope.key);
		const [length, bytes] = await this.read(() =>
			Promise.all([this.lengthOf(scope.key, type), this.p('MEMORY', ['USAGE', scope.key, 'SAMPLES', '0']).catch(() => null)]),
		);
		const known = type in ROW_KEY || type === 'string';
		const rowKey = ROW_KEY[type];
		return {
			...base,
			columns: keyColumns(type),
			primaryKey: rowKey ? [rowKey] : null,
			estimate: {
				...(length === null ? {} : { rows: length }),
				...(typeof bytes === 'number' ? { bytes } : {}),
			},
			editable: !readOnly && known,
			...(readOnly
				? { reason: 'The session is read-only.' }
				: known
					? {}
					: { reason: `The studio cannot edit ${type} keys; use the command editor.` }),
		};
	}

	private async keyType(key: string): Promise<string> {
		const type = String(await this.read(() => this.p('TYPE', [key])));
		if (type === 'none') throw new StudioError('not_found', `The key ${key} no longer exists.`);
		return type;
	}

	private async lengthOf(key: string, type: string): Promise<number | null> {
		const command = { hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }[type];
		if (type === 'string') return 1;
		if (!command) return null;
		return Number(await this.p(command, [key]));
	}

	// ------------------------------------------------------------ browse

	async *browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const scope = this.resolve(object);
		if (scope.kind === 'key') yield* this.browseKey(scope.key, query, signal);
		else yield* this.browseKeys(scope, query, signal);
	}

	private async *browseKeys(
		scope: { kind: 'keyspace' | 'key-group'; prefix: string },
		query: BrowseQuery,
		signal: AbortSignal,
	): AsyncGenerator<StudioEvent> {
		const started = performance.now();
		checkFilterColumns(query.filter, KEYSPACE_COLUMNS);
		const type = query.type ?? pushedType(query.filter);
		if (type !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(type)) throw new StudioError('bad_request', 'Invalid key type.');
		const prefix = globEscape(scope.prefix);
		const pattern = query.native
			? scope.prefix && !query.native.startsWith(prefix)
				? `${prefix}${query.native}`
				: query.native
			: `${prefix}*`;
		const state = query.cursor ? decodeCursor(query.cursor, 'scan') : { k: 'scan' as const, c: '0', o: [] };

		yield { t: 'columns', columns: KEYSPACE_COLUMNS };
		yield* sortNotice(query, null);
		const page = await this.scanPage({
			state,
			limit: query.limit,
			signal,
			scan: async (cursor) => {
				const args = [cursor, 'MATCH', pattern, 'COUNT', String(SCAN_COUNT), ...(type ? ['TYPE', type] : [])];
				const [next, keys] = (await this.read(() => this.p('SCAN', args))) as [string, unknown[]];
				// Keys outside the group can only come from a custom pattern; keep the group a scope.
				return [String(next), keys.map(String).filter((key) => key.startsWith(scope.prefix))];
			},
			load: (keys) => this.keyRows(keys),
			keep: (row) => matchesFilters(Object.fromEntries(KEYSPACE_COLUMNS.map((c, i) => [c.name, row[i] ?? null])), query.filter),
		});
		yield* rowEvents(page.rows);
		const estimate = scope.kind === 'keyspace' && !query.cursor ? Number(await this.read(() => this.p('DBSIZE', []))) : undefined;
		yield { t: 'page', next: page.next, ...(estimate === undefined ? {} : { estimate }) };
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated: false };
	}

	/** One row per live key: `key`, `type`, `ttl` (null = no expiry), `size`, `value` (strings). */
	private async keyRows(keys: string[]): Promise<Cell[][]> {
		if (keys.length === 0) return [];
		const [types, ttls, sizes, lengths] = await this.read(() =>
			Promise.all([
				Promise.all(keys.map((key) => this.p('TYPE', [key]))),
				Promise.all(keys.map((key) => this.p('PTTL', [key]))),
				Promise.all(keys.map((key) => this.p('MEMORY', ['USAGE', key, 'SAMPLES', '0']).catch(() => null))),
				// STRLEN fails with WRONGTYPE on other types; that is cheaper than a second round.
				Promise.all(keys.map((key) => this.p('STRLEN', [key]).catch(() => null))),
			]),
		);
		const values = await this.read(() =>
			Promise.all(
				keys.map((key, i) =>
					types[i] === 'string' ? this.stringCell(key, Number(lengths[i] ?? 0), BROWSE_PREVIEW_BYTES) : Promise.resolve(null),
				),
			),
		);
		const rows: Cell[][] = [];
		keys.forEach((key, i) => {
			const type = String(types[i]);
			const ttl = Number(ttls[i]);
			// Expired or deleted since the scan.
			if (type === 'none' || ttl === -2) return;
			const size = sizes[i];
			rows.push([key, type, ttl >= 0 ? ttl : null, typeof size === 'number' ? size : null, values[i] ?? null]);
		});
		return rows;
	}

	/** A string value as text, bytes, or a truncated preview past `limit`. */
	private async stringCell(key: string, length: number, limit: number): Promise<Cell> {
		if (length <= limit) {
			const bytes = await this.primary.getBuffer(key);
			return bytes === null ? null : bytesToCell(bytes, limit);
		}
		const preview = String(await this.p('GETRANGE', [key, '0', String(limit - 1)]));
		return { $t: 'truncated', v: preview.replace(/�$/, ''), bytes: length };
	}

	/**
	 * Fill one page from a SCAN-family cursor: drain carried-over items first, then scan, then
	 * load rows for at most the room left. Items left over travel in the cursor; when that would
	 * make the cursor too long, they are shown now instead (a longer page beats a lost key).
	 */
	private async scanPage(options: {
		state: Extract<BrowseCursor, { k: 'scan' }>;
		limit: number;
		signal: AbortSignal;
		scan: (cursor: string) => Promise<[string, string[]]>;
		load: (items: string[]) => Promise<Cell[][]>;
		keep: (row: Cell[]) => boolean;
	}): Promise<{ rows: Cell[][]; next: string | null }> {
		const { limit, signal, scan, load, keep } = options;
		let cursor = options.state.c;
		const queue = [...options.state.o];
		// SCAN may return an item twice (and overshoots COUNT); never show one twice on a page.
		const seen = new Set(queue);
		const rows: Cell[][] = [];
		const started = performance.now();
		let scans = 0;
		while (rows.length < limit) {
			if (signal.aborted) throw cancelled();
			if (queue.length === 0) {
				if (cursor === null) break;
				if (scans > 0 && (scans >= PAGE_MAX_SCANS || performance.now() - started > PAGE_BUDGET_MS)) break;
				const [next, items] = await scan(cursor);
				scans += 1;
				cursor = next === '0' ? null : next;
				for (const item of items) {
					if (seen.has(item)) continue;
					seen.add(item);
					queue.push(item);
				}
				continue;
			}
			for (const row of await load(queue.splice(0, limit - rows.length))) if (keep(row)) rows.push(row);
		}
		let next = queue.length === 0 && cursor === null ? null : encodeCursor({ k: 'scan', c: cursor, o: queue });
		if (next !== null && next.length > MAX_CURSOR_CHARS) {
			for (const row of await load(queue.splice(0))) if (keep(row)) rows.push(row);
			next = cursor === null ? null : encodeCursor({ k: 'scan', c: cursor, o: [] });
		}
		return { rows, next };
	}

	private async *browseKey(key: string, query: BrowseQuery, signal: AbortSignal): AsyncGenerator<StudioEvent> {
		const started = performance.now();
		const type = await this.keyType(key);
		const columns = keyColumns(type);
		checkFilterColumns(query.filter, columns);
		const keep = (row: Cell[]) =>
			matchesFilters(Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null])), query.filter);
		const done = (): StudioEvent => ({ t: 'done', ms: Math.round(performance.now() - started), truncated: false });
		yield { t: 'columns', columns };
		let rows: Cell[][] = [];
		let next: string | null = null;
		const native = query.native ? ['MATCH', query.native] : [];
		switch (type) {
			case 'string': {
				const length = Number(await this.read(() => this.p('STRLEN', [key])));
				rows = [[await this.read(() => this.stringCell(key, length, BROWSE_PREVIEW_BYTES))]].filter(keep);
				break;
			}
			case 'list': {
				yield* sortNotice(query, 'list index');
				const start = query.cursor ? decodeCursor(query.cursor, 'list').i : 0;
				// One extra item tells whether there is another page.
				const items = (await this.read(() =>
					this.p('LRANGE', [key, String(start), String(start + query.limit)]),
				)) as unknown[];
				rows = items.slice(0, query.limit).map((item, i): Cell[] => [start + i, textCell(String(item), BROWSE_PREVIEW_BYTES)]);
				rows = rows.filter(keep);
				next = items.length > query.limit ? encodeCursor({ k: 'list', i: start + query.limit }) : null;
				break;
			}
			case 'stream': {
				yield* sortNotice(query, 'stream id');
				const from = query.cursor ? `(${decodeCursor(query.cursor, 'stream').x}` : '-';
				const entries = (await this.read(() =>
					this.p('XRANGE', [key, from, '+', 'COUNT', String(query.limit + 1)]),
				)) as Array<[string, unknown]>;
				const shown = entries.slice(0, query.limit);
				rows = shown.map(([id, fields]): Cell[] => [String(id), jsonCell(pairsToObject(fields), BROWSE_PREVIEW_BYTES)]).filter(keep);
				const last = shown.at(-1);
				next = entries.length > query.limit && last ? encodeCursor({ k: 'stream', x: String(last[0]) }) : null;
				break;
			}
			case 'hash':
			case 'set':
			case 'zset': {
				yield* sortNotice(query, null);
				const state = query.cursor ? decodeCursor(query.cursor, 'scan') : { k: 'scan' as const, c: '0', o: [] };
				const page = await this.scanPage({
					state,
					limit: query.limit,
					signal,
					scan: (cursor) => this.read(() => this.scanMembers(key, type, cursor, native)),
					load: (items) => this.read(() => this.memberRows(key, type, items)),
					keep,
				});
				rows = page.rows;
				next = page.next;
				break;
			}
			default:
				yield { t: 'notice', level: 'info', message: `The studio cannot browse ${type} keys; use the command editor.` };
		}
		yield* rowEvents(rows);
		yield { t: 'page', next };
		yield done();
	}

	/** Field/member names only; values are loaded per page, so the cursor never carries values. */
	private async scanMembers(key: string, type: string, cursor: string, native: string[]): Promise<[string, string[]]> {
		const count = ['COUNT', String(SCAN_COUNT)];
		if (type === 'hash') {
			// NOVALUES needs Valkey 8 / Redis 7.4; Yoal ships Valkey 8.1+ and Redis 8.x.
			const [next, fields] = (await this.p('HSCAN', [key, cursor, ...native, ...count, 'NOVALUES'])) as [string, unknown[]];
			return [String(next), fields.map(String)];
		}
		if (type === 'set') {
			const [next, members] = (await this.p('SSCAN', [key, cursor, ...native, ...count])) as [string, unknown[]];
			return [String(next), members.map(String)];
		}
		const [next, pairs] = (await this.p('ZSCAN', [key, cursor, ...native, ...count])) as [string, unknown[]];
		return [String(next), pairs.filter((_, i) => i % 2 === 0).map(String)];
	}

	private async memberRows(key: string, type: string, items: string[]): Promise<Cell[][]> {
		if (items.length === 0) return [];
		if (type === 'set') return items.map((member) => [textCell(member, BROWSE_PREVIEW_BYTES)]);
		if (type === 'hash') {
			const values = (await this.p('HMGET', [key, ...items])) as unknown[];
			return items.flatMap((field, i) => {
				const value = values[i];
				// A field deleted since the scan has no value.
				return value === null || value === undefined ? [] : [[field, textCell(String(value), BROWSE_PREVIEW_BYTES)]];
			});
		}
		const scores = (await this.p('ZMSCORE', [key, ...items])) as unknown[];
		return items.flatMap((member, i) => {
			const score = scores[i];
			return score === null || score === undefined ? [] : [[member, Number(score)]];
		});
	}

	// ------------------------------------------------------------ run

	async *run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent> {
		this.assertOpen();
		const started = performance.now();
		let argv: CommandArg[];
		try {
			argv = tokenize(input);
		} catch (error) {
			if (error instanceof TokenizeError) throw new StudioError('bad_request', error.message);
			throw error;
		}
		if (argv.length === 0) throw new StudioError('bad_request', 'Enter a command.');
		const words = argv.map(argText);
		const name = (words[0] ?? '').toUpperCase();
		const spec = await this.commandSpec(name);
		const decision = gateCommand(words, spec === undefined ? undefined : flagsFor(spec, words), this.options.readOnly);
		if (!decision.allow) throw new StudioError(decision.code, decision.message);
		if (decision.warning) yield { t: 'notice', level: 'warn', message: decision.warning };

		let reply: unknown;
		try {
			reply = await this.sendRun(name, argv.slice(1), options.timeoutMs, signal);
		} catch (error) {
			if (error instanceof StudioError) throw error;
			yield { t: 'error', code: 'engine_error', message: message(error) };
			yield { t: 'done', ms: Math.round(performance.now() - started), truncated: false };
			return;
		}
		const shaped = shapeReply(words, reply);
		const truncated = shaped.rows.length > options.maxRows;
		yield { t: 'columns', columns: shaped.columns };
		yield* rowEvents(truncated ? shaped.rows.slice(0, options.maxRows) : shaped.rows);
		if (shaped.notice) yield shaped.notice;
		yield { t: 'result', command: name };
		yield { t: 'done', ms: Math.round(performance.now() - started), truncated };
	}

	/**
	 * Send on the run client, racing the timeout and the abort signal. Losing either race closes
	 * the client (the server still finishes the command; nothing can stop it) and drops it, so
	 * the next run opens a fresh connection and cannot receive this command's late reply.
	 */
	private async sendRun(name: string, args: CommandArg[], timeoutMs: number, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw cancelled();
		const client = await this.ensureRunClient();
		const reply = send(client, name, args);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<unknown>((resolve, reject) => {
				timer = setTimeout(
					() => reject(new StudioError('timeout', `The command did not finish within ${timeoutMs} ms. Redis cannot cancel it; it may still complete on the server.`)),
					timeoutMs,
				);
				onAbort = () => reject(cancelled());
				signal.addEventListener('abort', onAbort, { once: true });
				reply.then(resolve, reject);
			});
		} catch (error) {
			if (error instanceof StudioError || !client.connected) this.dropRunClient(client);
			throw error;
		} finally {
			clearTimeout(timer);
			if (onAbort) signal.removeEventListener('abort', onAbort);
			// The late outcome of an abandoned command must not become an unhandled rejection.
			reply.catch(() => undefined);
		}
	}

	private async ensureRunClient(): Promise<RedisClient> {
		if (this.runClient?.connected) return this.runClient;
		if (this.runClient) this.dropRunClient(this.runClient);
		const client = await openClient(this.target);
		if (this.closed) {
			client.close();
			throw new StudioError('unknown_session', 'The session is closed.');
		}
		this.runClient = client;
		return client;
	}

	private dropRunClient(client: RedisClient): void {
		if (this.runClient === client) this.runClient = null;
		client.close();
	}

	/**
	 * `COMMAND INFO` for one command, cached for the session. `undefined` when the credential may
	 * not run `COMMAND INFO` (the Phase 3 `+@read` principal), so the gate uses its static list.
	 */
	private async commandSpec(name: string): Promise<CommandSpec | null | undefined> {
		const lower = name.toLowerCase();
		if (this.commandSpecs.has(lower)) return this.commandSpecs.get(lower);
		if (this.commandInfoUnavailable) return undefined;
		let reply: unknown;
		try {
			reply = await this.read(() => this.p('COMMAND', ['INFO', lower]));
		} catch (error) {
			if (/NOPERM/i.test(message(error))) {
				this.commandInfoUnavailable = true;
				return undefined;
			}
			throw error;
		}
		const spec = [...parseCommandInfo([lower], reply).values()][0] ?? null;
		this.commandSpecs.set(lower, spec);
		return spec;
	}

	// ------------------------------------------------------------ apply

	async apply(object: ObjectRef, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		this.assertOpen();
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		const scope = this.resolve(object);
		return this.gate.write(() =>
			scope.kind === 'key' ? this.applyInKey(scope.key, changes, signal) : this.applyKeys(scope.prefix, changes, signal),
		);
	}

	/**
	 * WATCH the keys, run `plan` (reads and checks every change first), and only when nothing
	 * conflicts queue its commands in MULTI/EXEC. A nil EXEC means a watched key changed between
	 * the check and the write: the whole batch is a conflict and nothing was written.
	 */
	private async guarded(
		keys: string[],
		count: number,
		signal: AbortSignal,
		plan: () => Promise<{ conflicts: Conflict[]; commands: Command[] }>,
	): Promise<ApplyResult> {
		const client = this.primary;
		await send(client, 'WATCH', keys);
		let inMulti = false;
		try {
			const { conflicts, commands } = await plan();
			if (conflicts.length > 0) return { applied: 0, conflicts };
			if (signal.aborted) throw cancelled();
			await send(client, 'MULTI', []);
			inMulti = true;
			const queued = await Promise.allSettled(commands.map(([command, args]) => send(client, command, args)));
			const refused = queued.find((q): q is PromiseRejectedResult => q.status === 'rejected');
			if (refused) throw new StudioError('engine_error', `The server refused the edit: ${message(refused.reason)}`);
			const result = await send(client, 'EXEC', []);
			inMulti = false;
			if (result === null)
				return {
					applied: 0,
					conflicts: Array.from({ length: count }, (_, index) => ({ index, reason: 'A key changed while the edit was applied.' })),
				};
			const failed = Array.isArray(result) ? result.find((r): r is Error => r instanceof Error) : undefined;
			// Checks run first, so this needs a server-side failure (e.g. OOM mid-transaction).
			if (failed) throw new StudioError('engine_error', `Part of the edit failed after it was committed: ${failed.message}`);
			return { applied: count, conflicts: [] };
		} catch (error) {
			if (inMulti) await send(client, 'DISCARD', []).catch(() => undefined);
			throw error;
		} finally {
			await send(client, 'UNWATCH', []).catch(() => undefined);
		}
	}

	/** Edits to the key table of a keyspace or group: string values, TTLs, new strings, deletes. */
	private applyKeys(prefix: string, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		const targets = changes.map((change, index) => {
			const key = textFromCell(change.op === 'insert' ? change.values.key : change.key.key, `Change ${index + 1}: key`);
			if (!key.startsWith(prefix)) throw new StudioError('bad_request', `The key ${key} is outside the group ${prefix}.`);
			const allowed = change.op === 'insert' ? ['key', 'value', 'ttl', 'type', 'size'] : ['value', 'ttl'];
			if (change.op !== 'delete')
				for (const column of Object.keys(change.values))
					if (!allowed.includes(column)) throw new StudioError('bad_request', `The ${column} column cannot be edited.`);
			if (change.op === 'insert' && change.values.type !== undefined && change.values.type !== null && change.values.type !== 'string')
				throw new StudioError('bad_request', 'Only string keys can be added from the grid; use the command editor for other types.');
			return key;
		});
		if (new Set(targets).size !== targets.length) throw new StudioError('bad_request', 'Each key may appear once per edit.');

		return this.guarded(targets, changes.length, signal, async () => {
			const [types, ttls, values] = await Promise.all([
				Promise.all(targets.map((key) => this.p('TYPE', [key]))),
				Promise.all(targets.map((key) => this.p('PTTL', [key]))),
				Promise.all(targets.map((key) => this.primary.getBuffer(key).catch(() => null))),
			]);
			const conflicts: Conflict[] = [];
			const commands: Command[] = [];
			changes.forEach((change, index) => {
				const key = targets[index] ?? '';
				const type = String(types[index]);
				const pttl = Number(ttls[index]);
				const current = type === 'string' ? (values[index] ?? null) : null;
				const conflict = (reason: string) => conflicts.push({ index, reason });
				if (change.op === 'insert') {
					if (type !== 'none') return conflict(`The key ${key} already exists.`);
					const value = argFromCell(change.values.value, 'value');
					const ttl = ttlFromCell(change.values.ttl);
					commands.push(['SET', [key, value, 'NX', ...(ttl === null ? [] : ['PX', String(ttl)])]]);
					return;
				}
				if (type === 'none') return conflict(`The key ${key} no longer exists.`);
				const original = change.original ?? {};
				if ('type' in original && original.type !== type) return conflict(`The key ${key} is now a ${type}.`);
				if ('value' in original && !this.valueMatches(original.value ?? null, current))
					return conflict(`The value of ${key} changed since it was loaded.`);
				if ('ttl' in original && !ttlMatches(original.ttl ?? null, pttl))
					return conflict(`The TTL of ${key} changed since it was loaded.`);
				if (change.op === 'delete') {
					commands.push(['UNLINK', [key]]);
					return;
				}
				if ('value' in change.values) {
					if (type !== 'string') return conflict(`The key ${key} is a ${type}, not a string.`);
					// KEEPTTL: editing the value must not silently drop the expiry.
					commands.push(['SET', [key, argFromCell(change.values.value, 'value'), 'KEEPTTL']]);
				}
				if ('ttl' in change.values) {
					const ttl = ttlFromCell(change.values.ttl);
					commands.push(ttl === null ? ['PERSIST', [key]] : ['PEXPIRE', [key, String(ttl)]]);
				}
			});
			return { conflicts, commands };
		});
	}

	// ------------------------------------------------------------ structure

	/**
	 * Rename (`RENAMENX`, never overwriting) or delete (`UNLINK`) one key. Both check the key
	 * exists first, dry runs included, and run alone on the primary client like `apply`.
	 */
	async alter(change: SchemaChange, options: { dryRun: boolean }, signal: AbortSignal): Promise<AlterResult> {
		this.assertOpen();
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		if (change.op !== 'rename' && change.op !== 'drop')
			throw new StudioError('unsupported', `Valkey and Redis keys cannot ${change.op}.`);
		const scope = this.resolve(change.object);
		if (scope.kind !== 'key')
			throw new StudioError('unsupported', 'Only single keys can be renamed or deleted; groups are just name prefixes.');
		const key = scope.key;
		if (change.op === 'rename') {
			if (change.name === key) throw new StudioError('bad_request', 'The new name is the same as the old one.');
			if (change.name.length > PATH_SEGMENT_MAX)
				throw new StudioError('bad_request', `A key name the studio can open is at most ${PATH_SEGMENT_MAX} characters.`);
		}
		const [command, args] = change.op === 'rename' ? ['RENAMENX', [key, change.name]] : ['UNLINK', [key]];
		const statements = [commandLine(command, args)];
		return this.gate.write(async () => {
			if (signal.aborted) throw cancelled();
			if (String(await this.p('TYPE', [key])) === 'none')
				throw new StudioError('not_found', `The key ${key} no longer exists.`);
			if (options.dryRun) return { statements, applied: false };
			let reply: unknown;
			try {
				reply = await this.p(command, args);
			} catch (error) {
				if (/no such key/i.test(message(error))) throw new StudioError('not_found', `The key ${key} no longer exists.`);
				throw new StudioError('engine_error', message(error));
			}
			if (change.op === 'rename' && Number(reply) === 0)
				throw new StudioError('conflict', `A key named ${change.name} already exists.`);
			if (change.op === 'drop' && Number(reply) === 0)
				throw new StudioError('not_found', `The key ${key} no longer exists.`);
			return { statements, applied: true };
		});
	}

	/** `null` stands for "not a string" (browse shows no value for other types). */
	private valueMatches(original: Cell, current: Uint8Array | null): boolean {
		if (original === null) return current === null;
		if (current === null) return false;
		return sameBytes(argBytes(argFromCell(original, 'original value')), current);
	}

	/** Edits inside one key: hash fields, list items, set and zset members, stream entries. */
	private applyInKey(key: string, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		return this.guarded([key], changes.length, signal, async () => {
			const type = String(await this.p('TYPE', [key]));
			const conflicts: Conflict[] = [];
			const commands: Command[] = [];
			if (type === 'none') {
				changes.forEach((_, index) => conflicts.push({ index, reason: `The key ${key} no longer exists.` }));
				return { conflicts, commands };
			}
			const rowKey = ROW_KEY[type];
			if (!rowKey && type !== 'string') throw new StudioError('unsupported', `The studio cannot edit ${type} keys.`);
			// Rows of another type (the key was replaced since it was loaded) are conflicts, not writes.
			const ids = changes.map((change) => (change.op === 'insert' ? undefined : change.key[rowKey ?? '']));
			const seen = new Set<string>();
			for (const id of ids) {
				if (id === undefined) continue;
				const text = JSON.stringify(id);
				if (seen.has(text)) throw new StudioError('bad_request', 'Each row may appear once per edit.');
				seen.add(text);
			}
			const reads = await Promise.all(
				changes.map((change, index) => {
					if (change.op === 'insert' && type !== 'hash' && type !== 'set' && type !== 'zset') return Promise.resolve(null);
					const id = change.op === 'insert' ? this.insertId(type, change.values) : ids[index];
					if (change.op === 'insert' && (id === undefined || id === null))
						throw new StudioError('bad_request', `A new ${type} row needs its ${type === 'hash' ? 'field' : 'member'}.`);
					if (rowKey && (id === undefined || id === null)) return Promise.resolve(undefined);
					return this.readRow(key, type, id ?? null);
				}),
			);
			const sentinel = `yoal-studio:deleted:${crypto.randomUUID()}`;
			const lsets: Command[] = [];
			let listDeletes = 0;
			const tail: Command[] = [];
			changes.forEach((change, index) => {
				const conflict = (reason: string) => conflicts.push({ index, reason });
				const current = reads[index];
				if (current === undefined) return conflict(`The row no longer matches a ${type} key; reload it.`);
				const original: Record<string, Cell> = change.op === 'insert' ? {} : (change.original ?? {});
				const originalMatches = (column: string) =>
					!(column in original) || this.sameCell(original[column] ?? null, current, type === 'zset' && column === 'score');
				switch (type) {
					case 'string': {
						if (change.op !== 'update' || !('value' in change.values))
							throw new StudioError('bad_request', 'A string key has one value; edit it, or delete the key from its group.');
						if (!originalMatches('value')) return conflict(`The value of ${key} changed since it was loaded.`);
						commands.push(['SET', [key, argFromCell(change.values.value, 'value'), 'KEEPTTL']]);
						return;
					}
					case 'hash': {
						const field = change.op === 'insert' ? argFromCell(change.values.field, 'field') : argFromCell(ids[index], 'field');
						if (change.op === 'insert') {
							if (current !== null) return conflict(`The field ${argText(field)} already exists.`);
							commands.push(['HSET', [key, field, argFromCell(change.values.value, 'value')]]);
							return;
						}
						if (current === null) return conflict(`The field ${argText(field)} no longer exists.`);
						if (!originalMatches('value')) return conflict(`The field ${argText(field)} changed since it was loaded.`);
						if (change.op === 'delete') commands.push(['HDEL', [key, field]]);
						else {
							if ('field' in change.values) throw new StudioError('bad_request', 'Hash fields cannot be renamed here.');
							commands.push(['HSET', [key, field, argFromCell(change.values.value, 'value')]]);
						}
						return;
					}
					case 'set': {
						if (change.op === 'insert') {
							if (current !== null) return conflict('The member already exists.');
							commands.push(['SADD', [key, argFromCell(change.values.member, 'member')]]);
							return;
						}
						const member = argFromCell(ids[index], 'member');
						if (current === null) return conflict(`The member ${argText(member)} no longer exists.`);
						if (change.op === 'delete') commands.push(['SREM', [key, member]]);
						else {
							const renamed = argFromCell(change.values.member, 'member');
							commands.push(['SREM', [key, member]], ['SADD', [key, renamed]]);
						}
						return;
					}
					case 'zset': {
						if (change.op === 'insert') {
							if (current !== null) return conflict('The member already exists.');
							const score = scoreArg(change.values.score);
							commands.push(['ZADD', [key, 'NX', score, argFromCell(change.values.member, 'member')]]);
							return;
						}
						const member = argFromCell(ids[index], 'member');
						if (current === null) return conflict(`The member ${argText(member)} no longer exists.`);
						if (!originalMatches('score')) return conflict(`The score of ${argText(member)} changed since it was loaded.`);
						if (change.op === 'delete') commands.push(['ZREM', [key, member]]);
						else {
							if ('member' in change.values) throw new StudioError('bad_request', 'Zset members cannot be renamed here.');
							commands.push(['ZADD', [key, 'XX', scoreArg(change.values.score), member]]);
						}
						return;
					}
					case 'list': {
						if (change.op === 'insert') {
							tail.push(['RPUSH', [key, argFromCell(change.values.value, 'value')]]);
							return;
						}
						const at = String(plainCell(ids[index] ?? null));
						if (current === null) return conflict(`The list has no item ${at} any more.`);
						if (!originalMatches('value')) return conflict(`Item ${at} changed since it was loaded.`);
						// Indexes refer to the list as loaded: set every item first, then remove the deleted
						// ones by a unique sentinel, so earlier deletes cannot shift later indexes.
						if (change.op === 'delete') {
							lsets.push(['LSET', [key, at, sentinel]]);
							listDeletes += 1;
						} else lsets.push(['LSET', [key, at, argFromCell(change.values.value, 'value')]]);
						return;
					}
					case 'stream': {
						if (change.op === 'insert') {
							const fields = streamFields(change.values.fields);
							tail.push(['XADD', [key, '*', ...fields]]);
							return;
						}
						if (change.op === 'update') throw new StudioError('bad_request', 'Stream entries cannot be changed, only added or deleted.');
						const id = textFromCell(ids[index], 'id');
						if (current === null) return conflict(`The entry ${id} no longer exists.`);
						commands.push(['XDEL', [key, id]]);
						return;
					}
				}
			});
			commands.push(...lsets);
			if (listDeletes > 0) commands.push(['LREM', [key, '0', sentinel]]);
			commands.push(...tail);
			return { conflicts, commands };
		});
	}

	private insertId(type: string, values: Record<string, Cell>): Cell | undefined {
		if (type === 'hash') return values.field;
		return values.member;
	}

	/** The current cell for one row inside a key, or null when the row is gone. */
	private async readRow(key: string, type: string, id: Cell): Promise<Cell> {
		switch (type) {
			case 'string': {
				const bytes = await this.primary.getBuffer(key);
				return bytes === null ? null : bytesToCell(bytes, Number.MAX_SAFE_INTEGER);
			}
			case 'hash': {
				const value = await this.p('HGET', [key, argFromCell(id, 'field')]);
				return value === null ? null : String(value);
			}
			case 'set':
				return Number(await this.p('SISMEMBER', [key, argFromCell(id, 'member')])) === 1 ? true : null;
			case 'zset': {
				const score = await this.p('ZSCORE', [key, argFromCell(id, 'member')]);
				return score === null ? null : Number(score);
			}
			case 'list': {
				const index = Number(plainCell(id));
				if (!Number.isSafeInteger(index)) throw new StudioError('bad_request', 'A list index is a whole number.');
				const value = await this.p('LINDEX', [key, String(index)]);
				return value === null ? null : String(value);
			}
			case 'stream': {
				const id_ = textFromCell(id, 'id');
				const entries = (await this.p('XRANGE', [key, id_, id_])) as unknown[];
				return entries.length > 0 ? true : null;
			}
			default:
				return null;
		}
	}

	private sameCell(original: Cell, current: Cell, numeric: boolean): boolean {
		if (numeric) return Number(plainCell(original)) === Number(current);
		if (original === null || current === null) return original === current;
		const a = argBytes(argFromCell(original, 'original'));
		const b = argBytes(argFromCell(current, 'current'));
		return sameBytes(a, b);
	}

	// ------------------------------------------------------------ value

	async value(object: ObjectRef, key: Record<string, Cell>, column: string, signal: AbortSignal): Promise<Cell> {
		this.assertOpen();
		if (signal.aborted) throw cancelled();
		const scope = this.resolve(object);
		const limit = this.options.limits.maxBytes;
		if (scope.kind !== 'key') {
			const name = textFromCell(key.key, 'key');
			const type = await this.keyType(name);
			if (column === 'value') return this.read(() => this.fullValue(name, type, limit));
			const rows = await this.keyRows([name]);
			const row = rows[0];
			const index = KEYSPACE_COLUMNS.findIndex((c) => c.name === column);
			if (!row || index < 0) throw new StudioError('not_found', `No ${column} for ${name}.`);
			return row[index] ?? null;
		}
		const type = await this.keyType(scope.key);
		if (type === 'string') return this.read(() => this.fullValue(scope.key, type, limit));
		const rowKey = ROW_KEY[type];
		const id = rowKey ? key[rowKey] : undefined;
		if (id === undefined) throw new StudioError('bad_request', `The ${rowKey ?? 'row'} is required.`);
		const cell = await this.read(async () => {
			switch (type) {
				case 'hash': {
					const value = await this.p('HGET', [scope.key, argFromCell(id, 'field')]);
					return value === null ? undefined : textCell(String(value), limit);
				}
				case 'list': {
					const value = await this.p('LINDEX', [scope.key, String(plainCell(id))]);
					return value === null ? undefined : textCell(String(value), limit);
				}
				case 'zset': {
					const score = await this.p('ZSCORE', [scope.key, argFromCell(id, 'member')]);
					return score === null ? undefined : column === 'score' ? Number(score) : id;
				}
				case 'set':
					return Number(await this.p('SISMEMBER', [scope.key, argFromCell(id, 'member')])) === 1 ? id : undefined;
				case 'stream': {
					const entry = (await this.p('XRANGE', [scope.key, textFromCell(id, 'id'), textFromCell(id, 'id')])) as Array<[string, unknown]>;
					return entry[0] ? jsonCell(pairsToObject(entry[0][1]), limit) : undefined;
				}
				default:
					return undefined;
			}
		});
		if (cell === undefined) throw new StudioError('not_found', 'The row no longer exists.');
		return cell;
	}

	/** A whole string, or a non-string key's contents up to `VALUE_MAX_ITEMS`, as one cell. */
	private async fullValue(key: string, type: string, limit: number): Promise<Cell> {
		const cap = String(VALUE_MAX_ITEMS - 1);
		switch (type) {
			case 'string':
				return this.stringCell(key, Number(await this.p('STRLEN', [key])), limit);
			case 'hash': {
				const length = Number(await this.p('HLEN', [key]));
				if (length <= VALUE_MAX_ITEMS) return jsonCell(jsonSafe(await this.p('HGETALL', [key])), limit);
				const fields = await this.collectScan((cursor) => this.p('HSCAN', [key, cursor, 'COUNT', String(SCAN_COUNT)]), 2);
				return jsonCell(pairsToObject(fields), limit);
			}
			case 'list':
				return jsonCell(jsonSafe(await this.p('LRANGE', [key, '0', cap])), limit);
			case 'set':
				return jsonCell(await this.collectScan((cursor) => this.p('SSCAN', [key, cursor, 'COUNT', String(SCAN_COUNT)]), 1), limit);
			case 'zset':
				return jsonCell(jsonSafe(await this.p('ZRANGE', [key, '0', cap, 'WITHSCORES'])), limit);
			case 'stream': {
				const entries = (await this.p('XRANGE', [key, '-', '+', 'COUNT', String(VALUE_MAX_ITEMS)])) as Array<[string, unknown]>;
				return jsonCell(entries.map(([id, fields]) => ({ id, fields: pairsToObject(fields) })), limit);
			}
			default:
				throw new StudioError('unsupported', `The studio cannot load ${type} values; use the command editor.`);
		}
	}

	/** Items of a SCAN-family command up to the value cap (`width` 2 for field/value pairs). */
	private async collectScan(scan: (cursor: string) => Promise<unknown>, width: number): Promise<unknown[]> {
		const out: unknown[] = [];
		let cursor = '0';
		do {
			const [next, items] = (await scan(cursor)) as [string, unknown[]];
			out.push(...items.map(jsonSafe));
			cursor = String(next);
		} while (cursor !== '0' && out.length < VALUE_MAX_ITEMS * width);
		return out.slice(0, VALUE_MAX_ITEMS * width);
	}

	// ------------------------------------------------------------ plumbing

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.primary.close();
		this.runClient?.close();
		this.runClient = null;
	}

	private p(command: string, args: readonly CommandArg[]): Promise<unknown> {
		return send(this.primary, command, args);
	}

	private read<T>(fn: () => Promise<T>): Promise<T> {
		this.assertOpen();
		return this.gate.read(fn);
	}

	private resolve(object: ObjectRef): Scope {
		const [db, ...rest] = object.path;
		if (db !== this.db) throw new StudioError('not_found', `No keyspace ${db ?? ''}; this session uses db ${this.db}.`);
		const last = rest.at(-1);
		if (object.kind === 'keyspace' && rest.length === 0) return { kind: 'keyspace', prefix: '' };
		if (object.kind === 'key-group' && last) return { kind: 'key-group', prefix: last };
		if (object.kind === 'key' && last !== undefined) return { kind: 'key', key: last };
		throw new StudioError('not_found', `No ${object.kind} at ${object.path.join(' / ')}.`);
	}

	private assertOpen(): void {
		if (this.closed) throw new StudioError('unknown_session', 'The session is closed.');
	}
}

/** Tree nodes may say their counts come from a sample; the field is extra to the protocol. */
type KeyValueTreeNode = TreeNode & { detail?: TreeNode['detail'] & { approximate?: boolean } };

/** A single `type = x` filter can be pushed down to `SCAN … TYPE`. */
function pushedType(filters: BrowseQuery['filter']): string | undefined {
	const types = filters.filter((f) => f.column === 'type' && f.op === 'eq' && typeof f.value === 'string');
	return types.length === 1 ? (types[0]?.value as string) : undefined;
}

function scoreArg(cell: Cell | undefined): string {
	const score = Number(cell === undefined || cell === null ? Number.NaN : typeof cell === 'object' ? cellToParam(cell) : cell);
	if (!Number.isFinite(score)) throw new StudioError('bad_request', 'A score is a number.');
	return String(score);
}

function streamFields(cell: Cell | undefined): string[] {
	const value = cell === undefined || cell === null ? null : typeof cell === 'object' && !Array.isArray(cell) ? cellToParam(cell) : cell;
	const object = typeof value === 'string' ? safeJson(value) : value;
	if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length === 0)
		throw new StudioError('bad_request', 'A stream entry needs fields as a JSON object, e.g. {"event":"signup"}.');
	return Object.entries(object).flatMap(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
