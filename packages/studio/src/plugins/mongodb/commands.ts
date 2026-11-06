/**
 * Pure helpers for the MongoDB plugin: command parsing, the read-only allowlist, browse filters,
 * sort and the page cursor. No I/O, so they are unit-tested without a server.
 */
import { BSON } from 'mongodb';
import { StudioError, type BrowseQuery } from '../../protocol.ts';
import { assertFieldName, canonical, fromCell } from './cells.ts';

// ---------------------------------------------------------------- commands

export interface ParsedCommand {
	/** The command name: the first key, as the server reads it. */
	name: string;
	doc: BSON.Document;
}

/**
 * Parse one EJSON command document. Canonical parsing keeps numeric types (`5` is an Int32,
 * `1.5` a Double) and never evaluates anything: there is no JavaScript path.
 */
export function parseCommand(input: string): ParsedCommand {
	const doc = parseDocument(input, 'command');
	const name = Object.keys(doc)[0];
	if (!name) throw new StudioError('bad_request', 'The command document is empty.');
	return { name, doc };
}

/** Parse EJSON text that must be a document (not an array, scalar or null). */
export function parseDocument(input: string, what: string): BSON.Document {
	let value: unknown;
	try {
		value = BSON.EJSON.parse(input, { relaxed: false });
	} catch (error) {
		throw new StudioError('bad_request', `The ${what} is not valid EJSON: ${(error as Error).message}`);
	}
	if (!isPlainDocument(value)) throw new StudioError('bad_request', `The ${what} must be a JSON object.`);
	return value;
}

export function isPlainDocument(value: unknown): value is BSON.Document {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	if ('_bsontype' in value) return false;
	return !(value instanceof Date) && !(value instanceof RegExp) && !(value instanceof Uint8Array);
}

/**
 * Commands a read-only session may run. An explicit allowlist, not a denylist: anything new or
 * unknown is refused. This is the second layer; the `read`-role credential is the first.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	'find',
	'aggregate',
	'count',
	'countDocuments',
	'distinct',
	'listCollections',
	'listIndexes',
	'collStats',
	'dbStats',
	'explain',
	'ping',
	'buildInfo',
	'serverStatus',
	'hello',
	'isMaster',
	'ismaster',
]);

/** Commands `explain` may wrap in a read-only session. */
const EXPLAINABLE_READS: ReadonlySet<string> = new Set(['find', 'aggregate', 'count', 'distinct']);

/** Stages that write; refused anywhere in a read-only pipeline, including sub-pipelines. */
const WRITE_STAGES: ReadonlySet<string> = new Set(['$out', '$merge']);

/**
 * True when `$out` or `$merge` appears as a key at any depth. Walking every nested document
 * and array (rather than only known sub-pipeline fields) also covers `$facet`, `$lookup`,
 * `$unionWith` and any stage added later.
 */
export function containsWriteStage(value: unknown, depth = 0): boolean {
	if (depth > 200) return true; // Refuse absurd nesting rather than recurse without bound.
	if (Array.isArray(value)) return value.some((item) => containsWriteStage(item, depth + 1));
	if (!isPlainDocument(value)) return false;
	for (const [key, item] of Object.entries(value)) {
		if (WRITE_STAGES.has(key)) return true;
		if (containsWriteStage(item, depth + 1)) return true;
	}
	return false;
}

/** Throws `read_only` unless a read-only session may run this command. */
export function assertReadOnlyAllowed(command: ParsedCommand): void {
	const { name, doc } = command;
	if (!READ_ONLY_COMMANDS.has(name))
		throw new StudioError('read_only', `"${name}" is not allowed in a read-only session.`);
	if (name === 'aggregate' && containsWriteStage(doc))
		throw new StudioError('read_only', '$out and $merge are not allowed in a read-only session.');
	if (name === 'explain') {
		const inner = doc.explain;
		if (!isPlainDocument(inner))
			throw new StudioError('bad_request', '`explain` takes a command document.');
		const innerName = Object.keys(inner)[0] ?? '';
		if (!EXPLAINABLE_READS.has(innerName))
			throw new StudioError('read_only', `Explaining "${innerName}" is not allowed in a read-only session.`);
		if (containsWriteStage(inner))
			throw new StudioError('read_only', '$out and $merge are not allowed in a read-only session.');
	}
}

/** A command's collection argument: a non-empty string, or 1 for database-level aggregate. */
export function commandCollection(command: ParsedCommand): string | null {
	const value = command.doc[command.name];
	if (typeof value === 'string' && value.length > 0) return value;
	return null;
}

// ---------------------------------------------------------------- browse filters and sort

const LIKE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** SQL `LIKE` → an anchored regex: `%` is `.*`, `_` is `.`, everything else literal. */
export function likeToRegex(pattern: string): string {
	let out = '';
	for (const char of pattern) {
		if (char === '%') out += '.*';
		else if (char === '_') out += '.';
		else out += char.replace(LIKE_SPECIAL, '\\$&');
	}
	return `^${out}$`;
}

/**
 * The browse filter: the native EJSON query AND every structured filter on a top-level field.
 * Values decode from cells, so `{ $oid }`, `{ $numberLong }` etc. compare with the right type.
 */
export function buildFilter(query: Pick<BrowseQuery, 'filter' | 'native'>): BSON.Document {
	const clauses: BSON.Document[] = [];
	const native = query.native?.trim();
	if (native) {
		const doc = parseDocument(native, 'filter');
		if (Object.keys(doc).length > 0) clauses.push(doc);
	}
	for (const filter of query.filter ?? []) {
		assertFieldName(filter.column);
		const value = filter.value === undefined ? null : fromCell(filter.value);
		clauses.push({ [filter.column]: filterOperator(filter.op, value) });
	}
	if (clauses.length === 0) return {};
	if (clauses.length === 1) return clauses[0]!;
	return { $and: clauses };
}

function filterOperator(op: BrowseQuery['filter'][number]['op'], value: unknown): BSON.Document {
	switch (op) {
		case 'eq':
			return { $eq: value };
		case 'ne':
			return { $ne: value };
		case 'lt':
			return { $lt: value };
		case 'lte':
			return { $lte: value };
		case 'gt':
			return { $gt: value };
		case 'gte':
			return { $gte: value };
		case 'like':
		case 'ilike':
			if (typeof value !== 'string') throw new StudioError('bad_request', `${op} takes a text pattern.`);
			return { $regex: likeToRegex(value), $options: op === 'ilike' ? 'is' : 's' };
		case 'in':
			if (!Array.isArray(value)) throw new StudioError('bad_request', '`in` takes a list of values.');
			return { $in: value };
		// A missing field reads as null in the grid, so both null and missing match `is-null`.
		case 'is-null':
			return { $eq: null };
		case 'not-null':
			return { $ne: null };
	}
}

export interface BrowsePlan {
	sort: BSON.Document;
	/**
	 * `keyset` when the order is `_id` alone (or none): the cursor holds the last `_id`.
	 * `skip` otherwise: the cursor holds an offset (see `browse` for why that is weaker).
	 */
	mode: 'keyset' | 'skip';
	dir: 1 | -1;
}

/** Sort spec for a browse: the requested fields, then `_id` as the tie-breaker. */
export function browsePlan(sort: BrowseQuery['sort'], forceSkip = false): BrowsePlan {
	const spec: BSON.Document = {};
	for (const entry of sort) {
		assertFieldName(entry.column);
		if (!(entry.column in spec)) spec[entry.column] = entry.dir === 'desc' ? -1 : 1;
	}
	const onlyId = sort.length === 0 || (Object.keys(spec).length === 1 && '_id' in spec);
	const dir: 1 | -1 = spec._id === -1 ? -1 : 1;
	if (!('_id' in spec)) spec._id = dir;
	return { sort: spec, mode: onlyId && !forceSkip ? 'keyset' : 'skip', dir };
}

// ---------------------------------------------------------------- page cursor

export type PageCursor = { mode: 'keyset'; after: unknown } | { mode: 'skip'; skip: number };

/** Opaque cursor: base64url of `{ k: <canonical EJSON _id> }` or `{ s: <offset> }`. */
export function encodeCursor(cursor: PageCursor): string {
	const body = cursor.mode === 'keyset' ? `{"k":${canonical(cursor.after)}}` : JSON.stringify({ s: cursor.skip });
	return Buffer.from(body, 'utf8').toString('base64url');
}

export function decodeCursor(text: string): PageCursor {
	try {
		const parsed = BSON.EJSON.parse(Buffer.from(text, 'base64url').toString('utf8'), { relaxed: false });
		if (isPlainDocument(parsed)) {
			if ('k' in parsed) return { mode: 'keyset', after: parsed.k };
			const skip = Number(parsed.s);
			if (Number.isSafeInteger(skip) && skip >= 0) return { mode: 'skip', skip };
		}
	} catch {
		// Fall through to the error below.
	}
	throw new StudioError('bad_request', 'The page cursor is invalid; reload the first page.');
}

/**
 * BSON comparison order of type brackets (as `$type` aliases). `$gt`/`$lt` only compare within
 * a bracket, so keyset paging over mixed `_id` types (ints, strings, ObjectIds…) also has to
 * take every later bracket wholesale.
 */
const TYPE_BRACKETS: readonly (readonly string[])[] = [
	['minKey'],
	['null', 'undefined'],
	['int', 'long', 'double', 'decimal'],
	['symbol', 'string'],
	['object'],
	['array'],
	['binData'],
	['objectId'],
	['bool'],
	['date'],
	['timestamp'],
	['regex'],
	['maxKey'],
];

/** `_id` beyond `after` in the page direction, across BSON type brackets. */
export function keysetFilter(after: unknown, dir: 1 | -1, typeOf: (value: unknown) => string): BSON.Document {
	const type = typeOf(after);
	const index = TYPE_BRACKETS.findIndex((bracket) => bracket.includes(type));
	const later = index < 0 ? [] : (dir === 1 ? TYPE_BRACKETS.slice(index + 1) : TYPE_BRACKETS.slice(0, index)).flat();
	const within = { _id: { [dir === 1 ? '$gt' : '$lt']: after } };
	if (later.length === 0) return within;
	return { $or: [within, { _id: { $type: later } }] };
}
