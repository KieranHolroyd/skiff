/**
 * MongoDB studio plugin (plan 22, Phase 2 track C).
 *
 * Yoal runs one standalone `mongod` per database, with the owner in the `admin` auth database.
 * `run` takes ONE EJSON command document (`{"find":"c","filter":{}}`); nothing is ever evaluated
 * as JavaScript on the client. `find`/`aggregate` stream through a real cursor; any other
 * command goes to `db.command` and comes back as one document.
 *
 * Every server operation carries `maxTimeMS` and a unique `comment`, so an abort finds it in
 * `$currentOp` and `killOp`s it (spike S1: about 430 ms).
 *
 * A standalone server has no transactions, so `apply` validates every change first and only
 * then writes, each write guarded by its originals. See `apply` for what that does not cover.
 */
import { randomBytes } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { BSON, MongoClient, type AbstractCursor, type Collection, type Db, type MongoClientOptions } from 'mongodb';
import type { DatabaseEngine } from '@yoal/contracts';
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
	type StudioEvent,
	type TreeNode,
	type TreePath,
} from '../../protocol.ts';
import { LOSSLESS_READ, assertFieldName, bsonType, fromCell, inferColumns, toCell, toRow, fieldTypes } from './cells.ts';
import {
	assertReadOnlyAllowed,
	browsePlan,
	buildFilter,
	commandCollection,
	decodeCursor,
	encodeCursor,
	isPlainDocument,
	keysetFilter,
	parseCommand,
	type ParsedCommand,
} from './commands.ts';
import { MONGO_STRUCTURE, commandStatement, planMongoAlter } from './structure.ts';

type Document = BSON.Document;

const CAPABILITIES: StudioCapabilities = {
	family: 'document',
	language: 'mongo',
	edit: 'document-id',
	cancel: 'kill-op',
	explain: true,
	schemas: false,
	structure: [...MONGO_STRUCTURE],
};

/** Documents per `rows` event and per cursor batch. */
const BATCH = 500;
/** `$sample` size for field inference (Compass uses 1,000 too). */
const SAMPLE_SIZE = 1_000;
/** Collections whose count the tree fetches; beyond this the tree shows names only. */
const TREE_COUNT_LIMIT = 100;
/** How long cancel keeps looking for the operation in `$currentOp`. */
const KILL_SEARCH_MS = 1_500;
/** Client-side backstop past `maxTimeMS`, for a server that never answers. */
const CLIENT_GRACE_MS = 2_000;
/** Commands whose `n`/`nModified` count written documents. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

export const mongodbPlugin: StudioPlugin = {
	id: 'mongodb',
	engines: ['mongodb'] as const satisfies readonly DatabaseEngine[],
	capabilities: () => CAPABILITIES,
	async connect(target, options) {
		const client = new MongoClient(connectionUrl(target), clientOptions(target));
		try {
			await client.connect();
		} catch (error) {
			await client.close().catch(() => undefined);
			throw new StudioError('engine_error', `Could not connect to MongoDB: ${messageOf(error)}`);
		}
		return new MongoSession(client, client.db(target.database), options, target.database);
	},
};

export function connectionUrl(target: Pick<StudioTarget, 'host' | 'port' | 'database' | 'user' | 'password'>): string {
	const auth = `${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}`;
	const host = target.host.includes(':') ? `[${target.host}]` : target.host;
	return `mongodb://${auth}@${host}:${target.port}/${encodeURIComponent(target.database)}?authSource=admin`;
}

export function clientOptions(target: Pick<StudioTarget, 'tls'>): MongoClientOptions {
	const options: MongoClientOptions = {
		maxPoolSize: 3,
		appName: 'yoal-studio',
		serverSelectionTimeoutMS: 5_000,
		connectTimeoutMS: 5_000,
		// A standalone on loopback: never follow advertised hosts (they are container names).
		directConnection: true,
		// A killed or timed-out operation must surface, not be silently retried.
		retryReads: false,
		retryWrites: false,
	};
	if (target.tls) {
		options.tls = true;
		// The helper CA pins the server; `caPem: null` means "encrypt, but do not verify".
		if (target.tls.caPem) options.secureContext = createSecureContext({ ca: target.tls.caPem });
		else options.tlsAllowInvalidCertificates = true;
	}
	return options;
}

interface CollectionInfo {
	name: string;
	type: string;
	options: Document;
}

/** A deadline and a comment shared by every server call of one studio operation. */
interface OpContext {
	comment: string;
	deadline: number;
	signal: AbortSignal;
}

class MongoSession implements StudioSession {
	/** `$currentOp` with `allUsers` needs `inprog`; a `read`-role user falls back to its own ops. */
	private allUsers = true;

	constructor(
		private readonly client: MongoClient,
		private readonly db: Db,
		private readonly options: SessionOptions,
		private readonly databaseName: string,
	) {}

	// ------------------------------------------------------------ tree and describe

	async tree(path: TreePath, signal: AbortSignal): Promise<TreeNode[]> {
		if (path.length > 0) return [];
		const op = this.op(signal);
		const infos = await this.guard(op, () =>
			this.db
				.listCollections({}, { nameOnly: false, authorizedCollections: true, maxTimeMS: this.left(op), comment: op.comment })
				.toArray(),
		);
		const visible = infos
			.filter((info) => !info.name.startsWith('system.'))
			.sort((a, b) => a.name.localeCompare(b.name));
		let counted = 0;
		return Promise.all(
			visible.map(async (info): Promise<TreeNode> => {
				const view = info.type === 'view';
				let rows: number | undefined;
				if (!view && counted++ < TREE_COUNT_LIMIT)
					rows = await this.guard(op, () =>
						this.db.collection(info.name).estimatedDocumentCount({ maxTimeMS: this.left(op), comment: op.comment }),
					).catch(() => undefined);
				return {
					path: [info.name],
					name: info.name,
					kind: view ? 'view' : 'collection',
					hasChildren: false,
					browsable: true,
					detail: { type: info.type ?? 'collection', ...(rows === undefined ? {} : { rows }) },
				};
			}),
		);
	}

	async describe(object: ObjectRef, signal: AbortSignal): Promise<ObjectDescription> {
		const op = this.op(signal);
		const info = await this.collectionInfo(object, op);
		const view = info.type === 'view';
		const collection = this.db.collection(info.name);
		const [sample, indexes, rows] = await this.guard(op, () =>
			Promise.all([
				this.sampleFieldTypes(collection, op),
				view
					? Promise.resolve([] as Document[])
					: collection.listIndexes({ maxTimeMS: this.left(op), comment: op.comment }).toArray(),
				view ? Promise.resolve(undefined) : collection.estimatedDocumentCount({ maxTimeMS: this.left(op), comment: op.comment }),
			]),
		);
		const editable = !view && !this.options.readOnly;
		const ddlSource = view ? { viewOn: info.options.viewOn, pipeline: info.options.pipeline } : info.options;
		return {
			object,
			columns: inferColumns(sample, { editable }),
			primaryKey: view ? null : ['_id'],
			indexes: indexes.map((index) => ({
				name: String(index.name),
				columns: Object.keys(index.key ?? {}),
				unique: Boolean(index.unique) || index.name === '_id_',
				definition: relaxed(withoutKeys(index, ['v', 'name'])),
			})),
			foreignKeys: [],
			...(Object.keys(ddlSource).length > 0 ? { ddl: relaxed(ddlSource, 2) } : {}),
			...(rows === undefined ? {} : { estimate: { rows } }),
			editable,
			...(view
				? { reason: 'Views are read-only.' }
				: this.options.readOnly
					? { reason: 'The session is read-only.' }
					: {}),
		};
	}

	/**
	 * Field names and BSON types of up to 1,000 random documents. The server computes the
	 * types (`$objectToArray` + `$type`), so large documents never cross the wire just to be
	 * looked at.
	 */
	private async sampleFieldTypes(collection: Collection, op: OpContext): Promise<Array<Array<[string, string]>>> {
		const docs = await collection
			.aggregate(
				[
					{ $sample: { size: SAMPLE_SIZE } },
					{
						$project: {
							_id: 0,
							f: { $map: { input: { $objectToArray: '$$ROOT' }, in: ['$$this.k', { $type: '$$this.v' }] } },
						},
					},
				],
				{ maxTimeMS: this.left(op), comment: op.comment },
			)
			.toArray();
		return docs.map((doc) => (Array.isArray(doc.f) ? (doc.f as Array<[string, string]>) : []));
	}

	// ------------------------------------------------------------ browse

	/**
	 * One page. With no sort, or a sort on `_id` alone, pages are keyset on `_id` (stable under
	 * concurrent inserts and deletes, and index-backed). Any other sort, and every view (whose
	 * documents may lack a unique `_id`), falls back to `skip`: `_id` breaks ties so the order is
	 * total, but rows inserted or deleted between pages can shift a page by that many rows.
	 */
	async *browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent> {
		const started = performance.now();
		const op = this.op(signal);
		const info = await this.collectionInfo(object, op);
		const view = info.type === 'view';
		const plan = browsePlan(query.sort ?? [], view);
		const base = buildFilter(query);
		const position = query.cursor ? decodeCursor(query.cursor) : null;
		if (position && position.mode !== plan.mode)
			throw new StudioError('bad_request', 'The page cursor does not match the sort; reload the first page.');
		const clauses: Document[] = Object.keys(base).length > 0 ? [base] : [];
		if (position?.mode === 'keyset') clauses.push(keysetFilter(position.after, plan.dir, bsonType));
		const filter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0]! : { $and: clauses };
		const skip = position?.mode === 'skip' ? position.skip : 0;
		const collection = this.db.collection(info.name);
		const unfiltered = Object.keys(base).length === 0;

		// One more than the page tells whether there is a next page without a count.
		const cursor = collection.find(filter, {
			sort: plan.sort,
			skip,
			limit: query.limit + 1,
			batchSize: query.limit + 1,
			maxTimeMS: this.left(op),
			comment: op.comment,
			...LOSSLESS_READ,
		});
		let docs: Document[];
		let estimate: number | undefined;
		try {
			[docs, estimate] = await this.guard(op, () =>
				Promise.all([
					cursor.toArray(),
					!view && unfiltered && !position
						? collection.estimatedDocumentCount({ maxTimeMS: this.left(op), comment: op.comment }).catch(() => undefined)
						: Promise.resolve(undefined),
				]),
			);
		} finally {
			void cursor.close().catch(() => undefined);
		}
		const more = docs.length > query.limit;
		const page = docs.slice(0, query.limit);
		const columns = inferColumns(page.map(fieldTypes), { editable: !view && !this.options.readOnly });
		yield { t: 'columns', columns };
		for (let i = 0; i < page.length; i += BATCH)
			yield { t: 'rows', rows: page.slice(i, i + BATCH).map((doc) => toRow(doc, columns)) };
		const last = page.at(-1);
		const next =
			more && last
				? encodeCursor(plan.mode === 'keyset' ? { mode: 'keyset', after: last._id } : { mode: 'skip', skip: skip + page.length })
				: null;
		yield { t: 'page', next, ...(estimate === undefined ? {} : { estimate }) };
		yield { t: 'done', ms: elapsed(started), truncated: false };
	}

	// ------------------------------------------------------------ run

	async *run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent> {
		const started = performance.now();
		const command = parseCommand(input);
		if (this.options.readOnly) assertReadOnlyAllowed(command);
		const op = this.op(signal, options.timeoutMs);
		let truncated = false;
		if (command.name === 'find' || command.name === 'aggregate') {
			const cursor = this.openCursor(command, options.maxRows, op);
			const ignored = cursor.ignored;
			if (ignored.length > 0)
				yield { t: 'notice', level: 'info', message: `Ignored command fields: ${ignored.join(', ')}.` };
			truncated = yield* this.streamCursor(cursor.cursor, command.name, options.maxRows, op);
		} else if (command.name === 'countDocuments') {
			yield* this.countDocuments(command, op);
		} else {
			yield* this.runCommand(command, op);
		}
		yield { t: 'done', ms: elapsed(started), truncated };
	}

	/** Build a driver cursor from a `find` or `aggregate` command document. */
	private openCursor(
		command: ParsedCommand,
		maxRows: number,
		op: OpContext,
	): { cursor: AbstractCursor<Document>; ignored: string[] } {
		const { name, doc } = command;
		const target = commandCollection(command);
		const batchSize = Math.min(BATCH, maxRows + 1);
		const maxTimeMS = Math.min(this.left(op), positive(doc.maxTimeMS) ?? Number.POSITIVE_INFINITY);
		const common = { batchSize, maxTimeMS, comment: op.comment, ...LOSSLESS_READ };
		const ignored: string[] = [];
		const pick = (fields: readonly string[]): Document => {
			const out: Document = {};
			for (const [key, value] of Object.entries(doc)) {
				if (key === name) continue;
				if (fields.includes(key)) out[key] = value;
				else if (!['batchSize', 'maxTimeMS', 'comment', 'cursor', '$db'].includes(key)) ignored.push(key);
			}
			return out;
		};
		if (name === 'find') {
			if (!target) throw new StudioError('bad_request', '`find` takes a collection name.');
			const fields = pick([
				'filter',
				'sort',
				'projection',
				'hint',
				'skip',
				'limit',
				'collation',
				'let',
				'min',
				'max',
				'returnKey',
				'showRecordId',
				'allowDiskUse',
			]);
			if (fields.filter !== undefined && !isPlainDocument(fields.filter))
				throw new StudioError('bad_request', '`filter` must be a document.');
			const userLimit = positive(fields.limit);
			const cursor = this.db.collection(target).find((fields.filter as Document) ?? {}, {
				...common,
				...(fields.sort ? { sort: fields.sort as Document } : {}),
				...(fields.projection ? { projection: fields.projection as Document } : {}),
				...(fields.hint ? { hint: fields.hint as Document } : {}),
				...(fields.collation ? { collation: fields.collation as never } : {}),
				...(fields.let ? { let: fields.let as Document } : {}),
				...(fields.min ? { min: fields.min as Document } : {}),
				...(fields.max ? { max: fields.max as Document } : {}),
				...(fields.returnKey !== undefined ? { returnKey: Boolean(fields.returnKey) } : {}),
				...(fields.showRecordId !== undefined ? { showRecordId: Boolean(fields.showRecordId) } : {}),
				...(fields.allowDiskUse !== undefined ? { allowDiskUse: Boolean(fields.allowDiskUse) } : {}),
				...(positive(fields.skip) ? { skip: positive(fields.skip) } : {}),
				// One past the cap shows whether the result was cut.
				limit: Math.min(userLimit ?? Number.POSITIVE_INFINITY, maxRows + 1),
			});
			return { cursor, ignored };
		}
		const fields = pick(['pipeline', 'allowDiskUse', 'collation', 'hint', 'let', 'bypassDocumentValidation', 'explain']);
		if (!Array.isArray(fields.pipeline)) throw new StudioError('bad_request', '`aggregate` takes a `pipeline` array.');
		if (fields.explain) throw new StudioError('bad_request', 'Use Explain instead of `explain: true`.');
		const options = {
			...common,
			...(fields.allowDiskUse !== undefined ? { allowDiskUse: Boolean(fields.allowDiskUse) } : {}),
			...(fields.collation ? { collation: fields.collation as never } : {}),
			...(fields.hint ? { hint: fields.hint as Document } : {}),
			...(fields.let ? { let: fields.let as Document } : {}),
			...(fields.bypassDocumentValidation !== undefined && !this.options.readOnly
				? { bypassDocumentValidation: Boolean(fields.bypassDocumentValidation) }
				: {}),
		};
		const pipeline = fields.pipeline as Document[];
		// `{"aggregate": 1}` is a database-level pipeline (`$currentOp`, `$documents`, …).
		const cursor = target ? this.db.collection(target).aggregate(pipeline, options) : this.db.aggregate(pipeline, options);
		return { cursor, ignored };
	}

	/**
	 * Stream a cursor in batches of up to 500 documents, stopping at `maxRows`. Columns come
	 * from the first batch (the union of its top-level fields); fields that first appear later
	 * are reported in a notice, because a result's columns cannot change mid-stream.
	 */
	private async *streamCursor(
		cursor: AbstractCursor<Document>,
		command: string,
		maxRows: number,
		op: OpContext,
	): AsyncGenerator<StudioEvent, boolean> {
		let columns: Column[] | null = null;
		let known = new Set<string>();
		const unseen = new Set<string>();
		let sent = 0;
		let truncated = false;
		try {
			while (sent < maxRows) {
				const hasNext = await this.guard(op, () => cursor.hasNext());
				if (!hasNext) break;
				const batch = cursor.readBufferedDocuments(Math.min(cursor.bufferedCount(), maxRows - sent, BATCH));
				if (!columns) {
					columns = inferColumns(batch.map(fieldTypes), { editable: false });
					known = new Set(columns.map((c) => c.name));
					yield { t: 'columns', columns };
				}
				for (const doc of batch) for (const key of Object.keys(doc)) if (!known.has(key)) unseen.add(key);
				sent += batch.length;
				yield { t: 'rows', rows: batch.map((doc) => toRow(doc, columns!)) };
			}
			if (!columns) yield { t: 'columns', columns: [] };
			if (sent >= maxRows) {
				const id = cursor.id;
				truncated = cursor.bufferedCount() > 0 || (id !== undefined && !id.isZero());
			}
		} finally {
			void cursor.close().catch(() => undefined);
		}
		if (unseen.size > 0) {
			const names = [...unseen].slice(0, 10).join(', ');
			yield {
				t: 'notice',
				level: 'warn',
				message: `Some documents have fields that are not shown as columns (${names}${unseen.size > 10 ? ', …' : ''}). Add a projection to see them.`,
			};
		}
		yield { t: 'result', command };
		return truncated;
	}

	/** `countDocuments` is a driver helper, not a server command; run it as one. */
	private async *countDocuments(command: ParsedCommand, op: OpContext): AsyncGenerator<StudioEvent> {
		const target = commandCollection(command);
		if (!target) throw new StudioError('bad_request', '`countDocuments` takes a collection name.');
		const filter = command.doc.filter ?? command.doc.query ?? {};
		if (!isPlainDocument(filter)) throw new StudioError('bad_request', '`filter` must be a document.');
		const count = await this.guard(op, () =>
			this.db.collection(target).countDocuments(filter, {
				maxTimeMS: this.left(op),
				comment: op.comment,
				...(positive(command.doc.skip) ? { skip: positive(command.doc.skip) } : {}),
				...(positive(command.doc.limit) ? { limit: positive(command.doc.limit) } : {}),
			}),
		);
		yield { t: 'columns', columns: [{ name: 'count', nativeType: 'long', kind: 'number' }] };
		yield { t: 'rows', rows: [[count]] };
		yield { t: 'result', command: 'countDocuments' };
	}

	/** Any other command: `db.command`, answered as one document. */
	private async *runCommand(command: ParsedCommand, op: OpContext): AsyncGenerator<StudioEvent> {
		const doc: Document = { ...command.doc };
		// Generic arguments every command accepts: the timeout and the comment cancel matches.
		doc.maxTimeMS = Math.min(this.left(op), positive(doc.maxTimeMS) ?? Number.POSITIVE_INFINITY);
		doc.comment = op.comment;
		const response = await this.guard(op, () => this.db.command(doc, { ...LOSSLESS_READ }));
		const shown = withoutKeys(response, ['$clusterTime', 'operationTime']);
		yield { t: 'columns', columns: [{ name: 'result', nativeType: 'object', kind: 'document' }] };
		yield { t: 'rows', rows: [[toCell(shown)]] };
		const writeErrors = Array.isArray(response.writeErrors) ? (response.writeErrors as Document[]) : [];
		if (writeErrors.length > 0)
			yield {
				t: 'notice',
				level: 'warn',
				message: `${writeErrors.length} write error(s); the first: ${String(writeErrors[0]?.errmsg ?? 'unknown')}`,
			};
		await this.closeCommandCursor(response);
		// `n` means "documents written" only for the write commands; for `count` it is the answer.
		const affected = WRITE_COMMANDS.has(command.name) ? (toNumber(response.nModified) ?? toNumber(response.n)) : undefined;
		yield { t: 'result', command: command.name, ...(affected === undefined ? {} : { affected }) };
	}

	/** A cursor-returning command (`listCollections`, …) leaves a server cursor open past its first batch. */
	private async closeCommandCursor(response: Document): Promise<void> {
		const cursor = response.cursor as Document | undefined;
		const id = cursor?.id as BSON.Long | undefined;
		if (!cursor || !id || typeof id.isZero !== 'function' || id.isZero() || typeof cursor.ns !== 'string') return;
		const collection = cursor.ns.slice(cursor.ns.indexOf('.') + 1);
		await this.db.command({ killCursors: collection, cursors: [id] }).catch(() => undefined);
	}

	// ------------------------------------------------------------ explain

	async explain(input: string, signal: AbortSignal): Promise<ExplainResult> {
		const command = parseCommand(input);
		if (!['find', 'aggregate', 'count', 'distinct'].includes(command.name))
			throw new StudioError('unsupported', 'Explain takes a find, aggregate, count or distinct command.');
		if (this.options.readOnly) assertReadOnlyAllowed({ name: 'explain', doc: { explain: command.doc } });
		const op = this.op(signal);
		// `executionStats` runs the query, so only write sessions (the owner) get it.
		const verbosity = this.options.readOnly ? 'queryPlanner' : 'executionStats';
		const plan = await this.guard(op, () =>
			this.db.command(
				{ explain: command.doc, verbosity, maxTimeMS: this.left(op), comment: op.comment },
				{ ...LOSSLESS_READ },
			),
		);
		return {
			format: 'json',
			plan: BSON.EJSON.serialize(withoutKeys(plan, ['$clusterTime', 'operationTime']), { relaxed: true }),
		};
	}

	// ------------------------------------------------------------ apply

	/**
	 * Apply edits without transactions (a standalone `mongod` has none):
	 *
	 * 1. Validate: every update/delete must still match `{ _id, ...originals }`, and an insert
	 *    with an explicit `_id` must not collide. Any conflict → nothing is written.
	 * 2. Write each change in order, guarded by the same filter (`updateOne`/`deleteOne`), so a
	 *    write never lands on a document that changed after it was loaded.
	 *
	 * The gap: a concurrent writer can change a document between (1) and (2). The guarded write
	 * then matches nothing; we stop there and report that change as a conflict, but the changes
	 * before it stay applied (`applied > 0` with a conflict — the one case that differs from the
	 * "all or nothing" contract of transactional engines).
	 */
	async apply(object: ObjectRef, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult> {
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		const op = this.op(signal);
		const info = await this.collectionInfo(object, op);
		if (info.type === 'view') throw new StudioError('unsupported', 'Views cannot be edited.');
		const collection = this.db.collection(info.name);
		const prepared = changes.map(prepareChange);

		const conflicts: ApplyResult['conflicts'] = [];
		await this.guard(op, async () => {
			for (const [index, change] of prepared.entries()) {
				const options = { projection: { _id: 1 }, maxTimeMS: this.left(op), comment: op.comment };
				if (change.op === 'insert') {
					if (!('_id' in change.doc)) continue;
					if (await collection.findOne({ _id: change.doc._id }, options))
						conflicts.push({ index, reason: `A document with _id ${display(change.doc._id)} already exists.` });
					continue;
				}
				if (await collection.findOne(change.filter, options)) continue;
				const exists = await collection.findOne({ _id: change.id as never }, options);
				conflicts.push({
					index,
					reason: exists
						? `Document ${display(change.id)} changed since it was loaded.`
						: `Document ${display(change.id)} no longer exists.`,
				});
			}
		});
		if (conflicts.length > 0) return { applied: 0, conflicts };
		if (signal.aborted) throw new StudioError('cancelled', 'Apply was cancelled before writing.');

		let applied = 0;
		const partial = (index: number, why: string): ApplyResult => ({
			applied,
			conflicts: [
				{
					index,
					reason: `${why} Partially applied: ${applied} of ${prepared.length} change(s) were written before it, and MongoDB without a replica set cannot roll them back.`,
				},
			],
		});
		for (const [index, change] of prepared.entries()) {
			const options = { maxTimeMS: this.options.limits.statementTimeoutMs, comment: op.comment };
			try {
				if (change.op === 'insert') {
					await collection.insertOne(change.doc, options);
				} else if (change.op === 'update') {
					const result = await collection.updateOne(change.filter, { $set: change.set }, options);
					if (result.matchedCount === 0) return partial(index, `Document ${display(change.id)} changed while saving.`);
				} else {
					const result = await collection.deleteOne(change.filter, options);
					if (result.deletedCount === 0) return partial(index, `Document ${display(change.id)} changed while saving.`);
				}
			} catch (error) {
				return partial(index, `${this.toError(error, signal).message}.`);
			}
			applied += 1;
		}
		return { applied, conflicts: [] };
	}

	// ------------------------------------------------------------ structure

	/**
	 * One structure edit as one server command (see `structure.ts`). The object it acts on is
	 * looked up first, so a missing collection is `not_found` and a view refuses field, index
	 * and truncate edits, dry runs included.
	 */
	async alter(change: SchemaChange, options: { dryRun: boolean }, signal: AbortSignal): Promise<AlterResult> {
		if (this.options.readOnly) throw new StudioError('read_only', 'The session is read-only.');
		if (!(CAPABILITIES.structure as readonly string[]).includes(change.op))
			throw new StudioError('unsupported', `MongoDB cannot ${change.op}.`);
		const plan = planMongoAlter(change, this.databaseName);
		const statements = [commandStatement(plan.command)];
		const op = this.op(signal);
		if (plan.existing !== null) {
			const info = await this.collectionInfo({ path: [plan.existing], kind: 'collection' }, op);
			if (plan.collectionOnly && info.type === 'view')
				throw new StudioError('unsupported', `${plan.existing} is a view; only collections can be changed this way.`);
		}
		// `create` succeeds silently when an identical collection exists (MongoDB 7+), so a
		// name clash is checked here; `renameCollection` refuses one itself (dropTarget false).
		if (change.op === 'create-collection') {
			const [clash] = await this.guard(op, () =>
				this.db
					.listCollections({ name: change.name }, { nameOnly: true, authorizedCollections: true, maxTimeMS: this.left(op), comment: op.comment })
					.toArray(),
			);
			if (clash) throw new StudioError('conflict', `A collection named ${change.name} already exists.`);
		}
		if (options.dryRun) return { statements, applied: false };
		const target = plan.on === 'admin' ? this.client.db('admin') : this.db;
		// Known failures become specific codes inside the race; the rest (timeouts, kills)
		// go through `guard`'s own mapping.
		const reply = await this.guard(op, () =>
			target
				.command({ ...plan.command, maxTimeMS: this.left(op), comment: op.comment })
				.catch((error: unknown) => {
					throw alterError(error, change) ?? error;
				}),
		);
		const writeErrors = Array.isArray(reply.writeErrors) ? (reply.writeErrors as Document[]) : [];
		if (writeErrors.length > 0) {
			const first = writeErrors[0]!;
			throw new StudioError('engine_error', `${String(first.errmsg ?? 'The write failed')} (after ${toNumber(reply.nModified) ?? 0} document(s) were changed).`);
		}
		const affected = plan.affected === null ? undefined : toNumber(reply[plan.affected]);
		return { statements, applied: true, ...(affected === undefined ? {} : { affected }) };
	}

	// ------------------------------------------------------------ value and close

	async value(object: ObjectRef, key: Record<string, Cell>, column: string, signal: AbortSignal): Promise<Cell> {
		if (column !== '_id') assertFieldName(column);
		if (!('_id' in key)) throw new StudioError('bad_request', 'The key must include _id.');
		const op = this.op(signal);
		const info = await this.collectionInfo(object, op);
		const id = fromCell(key._id ?? null);
		const doc = await this.guard(op, () =>
			this.db.collection(info.name).findOne(
				{ _id: id as never },
				{ projection: { [column]: 1 }, maxTimeMS: this.left(op), comment: op.comment, ...LOSSLESS_READ },
			),
		);
		if (!doc) throw new StudioError('not_found', 'The document no longer exists.');
		return toCell(doc[column], Number.POSITIVE_INFINITY);
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	// ------------------------------------------------------------ plumbing

	private op(signal: AbortSignal, timeoutMs = this.options.limits.statementTimeoutMs): OpContext {
		return { comment: `yoal-studio:${randomBytes(8).toString('hex')}`, deadline: Date.now() + timeoutMs, signal };
	}

	/** Milliseconds left for `maxTimeMS` (at least 1: 0 would mean "no limit"). */
	private left(op: OpContext): number {
		return Math.max(1, op.deadline - Date.now());
	}

	private async collectionInfo(object: ObjectRef, op: OpContext): Promise<CollectionInfo> {
		const [name] = object.path;
		if (object.path.length !== 1 || !name || (object.kind !== 'collection' && object.kind !== 'view'))
			throw new StudioError('not_found', `No collection ${object.path.join('.')}.`);
		const [info] = await this.guard(op, () =>
			this.db
				.listCollections({ name }, { nameOnly: false, authorizedCollections: true, maxTimeMS: this.left(op), comment: op.comment })
				.toArray(),
		);
		if (!info) throw new StudioError('not_found', `No collection ${name}.`);
		return { name, type: info.type ?? 'collection', options: (info as Document).options ?? {} };
	}

	/**
	 * Run `work`, but answer an abort (or a deadline the server missed) at once: the operation
	 * is killed on the server in the background by its comment, and the caller gets
	 * `cancelled`/`timeout` without waiting for the interrupted reply.
	 */
	private async guard<T>(op: OpContext, work: () => Promise<T>): Promise<T> {
		const { signal } = op;
		if (signal.aborted) throw new StudioError('cancelled', 'The operation was cancelled.');
		let cleanup = (): void => undefined;
		const interrupted = new Promise<never>((_, reject) => {
			const onAbort = () => {
				void this.kill(op.comment);
				reject(new StudioError('cancelled', 'The operation was cancelled.'));
			};
			const timer = setTimeout(
				() => {
					void this.kill(op.comment);
					reject(new StudioError('timeout', 'The operation did not finish within the statement timeout.'));
				},
				Math.max(0, op.deadline - Date.now()) + CLIENT_GRACE_MS,
			);
			signal.addEventListener('abort', onAbort, { once: true });
			cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
			};
		});
		const running = work();
		// The losing side of the race must not become an unhandled rejection.
		running.catch(() => undefined);
		try {
			return await Promise.race([running, interrupted]);
		} catch (error) {
			throw this.toError(error, signal);
		} finally {
			cleanup();
		}
	}

	/** Find our operation by its comment in `$currentOp` and `killOp` it. */
	private async kill(comment: string): Promise<void> {
		const admin = this.client.db('admin');
		const deadline = Date.now() + KILL_SEARCH_MS;
		while (Date.now() < deadline) {
			let ops: Document[];
			try {
				ops = await admin
					.aggregate([
						{ $currentOp: { allUsers: this.allUsers, idleConnections: false } },
						{
							$match: {
								$or: [
									{ 'command.comment': comment },
									{ comment },
									{ 'cursor.originatingCommand.comment': comment },
									{ 'originatingCommand.comment': comment },
								],
							},
						},
						{ $project: { opid: 1 } },
					])
					.toArray();
			} catch (error) {
				if (this.allUsers && errorCode(error) === 13) {
					this.allUsers = false;
					continue;
				}
				return;
			}
			for (const found of ops) await admin.command({ killOp: 1, op: found.opid }).catch(() => undefined);
			if (ops.length > 0) return;
			await Bun.sleep(50);
		}
	}

	private toError(error: unknown, signal: AbortSignal): StudioError {
		if (error instanceof StudioError) return error;
		const code = errorCode(error);
		const name = (error as { codeName?: unknown })?.codeName;
		if (code === 50 || name === 'MaxTimeMSExpired')
			return new StudioError('timeout', 'The operation exceeded the statement timeout (maxTimeMS).');
		if (signal.aborted || code === 11601 || name === 'Interrupted')
			return new StudioError('cancelled', 'The operation was cancelled.');
		if (code === 13 || name === 'Unauthorized')
			return new StudioError(this.options.readOnly ? 'read_only' : 'forbidden', messageOf(error));
		if ((error as { name?: string })?.name === 'BSONError') return new StudioError('bad_request', messageOf(error));
		return new StudioError('engine_error', messageOf(error));
	}
}

// ---------------------------------------------------------------- apply preparation

type PreparedChange =
	| { op: 'insert'; doc: Document }
	| { op: 'update'; id: unknown; filter: Document; set: Document }
	| { op: 'delete'; id: unknown; filter: Document };

/** Decode a change's cells up front, so a bad value fails before anything is written. */
export function prepareChange(change: RowChange): PreparedChange {
	if (change.op === 'insert') {
		const doc: Document = {};
		for (const [name, cell] of Object.entries(change.values)) {
			if (name !== '_id') assertFieldName(name);
			doc[name] = fromCell(cell);
		}
		return { op: 'insert', doc };
	}
	if (!('_id' in change.key) || change.key._id === null)
		throw new StudioError('bad_request', 'Updates and deletes need the document _id.');
	const id = fromCell(change.key._id!);
	const filter: Document = { _id: id };
	for (const [name, cell] of Object.entries(change.original ?? {})) {
		if (name === '_id') continue;
		assertFieldName(name);
		// `$eq` so an original document or array matches exactly, never as an operator.
		filter[name] = { $eq: fromCell(cell) };
	}
	if (change.op === 'delete') return { op: 'delete', id, filter };
	const set: Document = {};
	for (const [name, cell] of Object.entries(change.values)) {
		if (name === '_id') throw new StudioError('bad_request', '_id cannot be changed.');
		assertFieldName(name);
		set[name] = fromCell(cell);
	}
	if (Object.keys(set).length === 0) throw new StudioError('bad_request', 'The update changes no fields.');
	return { op: 'update', id, filter, set };
}

// ---------------------------------------------------------------- small helpers

function relaxed(value: unknown, space?: number): string {
	return BSON.EJSON.stringify(value, { relaxed: true }, space);
}

function display(value: unknown): string {
	return BSON.EJSON.stringify(value, { relaxed: true });
}

function withoutKeys(doc: Document, keys: string[]): Document {
	return Object.fromEntries(Object.entries(doc).filter(([key]) => !keys.includes(key)));
}

/** A positive integer from a number or a BSON number wrapper, else undefined. */
function positive(value: unknown): number | undefined {
	const n = toNumber(value);
	return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Specific codes for the server errors a structure edit expects; null for anything else. */
function alterError(error: unknown, change: SchemaChange): StudioError | null {
	const code = errorCode(error);
	const name = (error as { codeName?: unknown })?.codeName;
	if (code === 48 || name === 'NamespaceExists') {
		const target = change.op === 'rename' || change.op === 'create-collection' ? change.name : 'that';
		return new StudioError('conflict', `A collection named ${target} already exists.`);
	}
	if (code === 26 || name === 'NamespaceNotFound' || code === 27 || name === 'IndexNotFound')
		return new StudioError('not_found', messageOf(error));
	if (code === 85 || code === 86 || name === 'IndexOptionsConflict' || name === 'IndexKeySpecsConflict')
		return new StudioError('conflict', messageOf(error));
	if (code === 11000) return new StudioError('conflict', `The unique index cannot be built: ${messageOf(error)}`);
	if (code === 73 || name === 'InvalidNamespace') return new StudioError('bad_request', messageOf(error));
	return null;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return value;
	if (value && typeof value === 'object' && '_bsontype' in value) {
		const n = Number((value as { toString(): string }).toString());
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

function errorCode(error: unknown): number | undefined {
	const code = (error as { code?: unknown })?.code;
	return typeof code === 'number' ? code : undefined;
}

function messageOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || 'MongoDB reported an error.';
}

function elapsed(started: number): number {
	return Math.round(performance.now() - started);
}
