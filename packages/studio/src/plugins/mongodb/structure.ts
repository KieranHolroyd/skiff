/**
 * Structure edits for MongoDB (`alter`). Each schema change becomes ONE server command document,
 * built and validated here without a connection so a bad name fails before anything is sent.
 * The session runs the command (with `maxTimeMS` and its cancel `comment`) and the dashboard
 * shows the same document, as relaxed EJSON, for review.
 */
import { BSON } from 'mongodb';
import { StudioError, type ObjectRef, type SchemaChange, type SchemaChangeOp } from '../../protocol.ts';

type Document = BSON.Document;

export const MONGO_STRUCTURE = [
	'create-collection',
	'rename',
	'drop',
	'truncate',
	'drop-column',
	'rename-column',
	'create-index',
	'drop-index',
] as const satisfies readonly SchemaChangeOp[];

/** Mongo's namespace (`<db>.<collection>`) limit, in bytes. */
const MAX_NAMESPACE_BYTES = 255;

export interface MongoAlterPlan {
	/** The database the command runs against: the session's, or `admin` for `renameCollection`. */
	on: 'db' | 'admin';
	command: Document;
	/** The collection the change acts on, when it must already exist (checked by the session). */
	existing: string | null;
	/** Whether the existing object must be a collection (not a view). */
	collectionOnly: boolean;
	/** How the command's reply reports touched documents. */
	affected: 'n' | 'nModified' | null;
}

/** A collection name this studio may create or rename to. */
export function assertCollectionName(name: string, database: string): void {
	if (!name) throw new StudioError('bad_request', 'A collection name cannot be empty.');
	if (name.includes('\0')) throw new StudioError('bad_request', 'A collection name cannot contain NUL.');
	if (name.includes('$')) throw new StudioError('bad_request', `"${name}" cannot contain $.`);
	if (name.startsWith('system.')) throw new StudioError('bad_request', `"${name}" is reserved: names starting with system. belong to MongoDB.`);
	if (name.startsWith('.') || name.endsWith('.'))
		throw new StudioError('bad_request', `"${name}" cannot start or end with a dot.`);
	if (Buffer.byteLength(`${database}.${name}`) > MAX_NAMESPACE_BYTES)
		throw new StudioError('bad_request', `"${name}" is too long: ${database}.${name} must be at most ${MAX_NAMESPACE_BYTES} bytes.`);
}

/** A dotted field path for field and index edits: no `$` segments, no empty segments. */
export function assertFieldPath(path: string, what = 'field'): void {
	if (!path || path.includes('\0')) throw new StudioError('bad_request', `A ${what} path cannot be empty or contain NUL.`);
	for (const segment of path.split('.'))
		if (!segment || segment.includes('$'))
			throw new StudioError('bad_request', `"${path}" is not a valid ${what} path (no $ and no empty segments).`);
}

function assertNotId(path: string): void {
	if (path === '_id' || path.startsWith('_id.'))
		throw new StudioError('bad_request', 'The _id field cannot be renamed or removed.');
}

/** The collection an existing-object change refers to. */
function collectionOf(object: ObjectRef): string {
	const [name] = object.path;
	if (object.path.length !== 1 || !name || (object.kind !== 'collection' && object.kind !== 'view'))
		throw new StudioError('not_found', `No collection ${object.path.join('.')}.`);
	return name;
}

/** Mongo's default index name: `field_1_other_-1`. */
export function defaultIndexName(columns: ReadonlyArray<{ name: string; dir: 'asc' | 'desc' }>): string {
	return columns.map((column) => `${column.name}_${column.dir === 'desc' ? -1 : 1}`).join('_');
}

export function planMongoAlter(change: SchemaChange, database: string): MongoAlterPlan {
	switch (change.op) {
		case 'create-collection': {
			if (change.parent.length > 0)
				throw new StudioError('bad_request', 'MongoDB collections live at the top of the tree.');
			assertCollectionName(change.name, database);
			return { on: 'db', command: { create: change.name }, existing: null, collectionOnly: false, affected: null };
		}
		case 'rename': {
			const from = collectionOf(change.object);
			assertCollectionName(change.name, database);
			if (from === change.name) throw new StudioError('bad_request', 'The new name is the same as the old one.');
			return {
				on: 'admin',
				command: { renameCollection: `${database}.${from}`, to: `${database}.${change.name}`, dropTarget: false },
				existing: from,
				collectionOnly: false,
				affected: null,
			};
		}
		case 'drop': {
			const name = collectionOf(change.object);
			return { on: 'db', command: { drop: name }, existing: name, collectionOnly: false, affected: null };
		}
		case 'truncate': {
			const name = collectionOf(change.object);
			return {
				on: 'db',
				command: { delete: name, deletes: [{ q: {}, limit: 0 }] },
				existing: name,
				collectionOnly: true,
				affected: 'n',
			};
		}
		case 'drop-column': {
			const name = collectionOf(change.object);
			assertFieldPath(change.column);
			assertNotId(change.column);
			return {
				on: 'db',
				command: {
					update: name,
					updates: [{ q: { [change.column]: { $exists: true } }, u: { $unset: { [change.column]: '' } }, multi: true }],
				},
				existing: name,
				collectionOnly: true,
				affected: 'nModified',
			};
		}
		case 'rename-column': {
			const name = collectionOf(change.object);
			assertFieldPath(change.column);
			assertFieldPath(change.name);
			assertNotId(change.column);
			assertNotId(change.name);
			const [a, b] = [change.column, change.name];
			if (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
				throw new StudioError('bad_request', `"${a}" cannot be renamed to "${b}": one path contains the other.`);
			return {
				on: 'db',
				command: {
					update: name,
					updates: [{ q: { [a]: { $exists: true } }, u: { $rename: { [a]: b } }, multi: true }],
				},
				existing: name,
				collectionOnly: true,
				affected: 'nModified',
			};
		}
		case 'create-index': {
			const name = collectionOf(change.object);
			const key: Document = {};
			for (const column of change.columns) {
				assertFieldPath(column.name, 'index field');
				if (column.name in key) throw new StudioError('bad_request', `"${column.name}" is listed twice.`);
				key[column.name] = column.dir === 'desc' ? -1 : 1;
			}
			const indexName = change.name ?? defaultIndexName(change.columns);
			if (indexName.includes('\0')) throw new StudioError('bad_request', 'An index name cannot contain NUL.');
			return {
				on: 'db',
				command: {
					createIndexes: name,
					indexes: [{ key, name: indexName, ...(change.unique ? { unique: true } : {}) }],
				},
				existing: name,
				collectionOnly: true,
				affected: null,
			};
		}
		case 'drop-index': {
			const name = collectionOf(change.object);
			if (change.name === '_id_') throw new StudioError('bad_request', 'The _id index cannot be dropped.');
			if (change.name === '*') throw new StudioError('bad_request', 'Drop indexes one at a time, by name.');
			return { on: 'db', command: { dropIndexes: name, index: change.name }, existing: name, collectionOnly: true, affected: null };
		}
		default:
			throw new StudioError('unsupported', `MongoDB has no ${change.op} here.`);
	}
}

/** The command as the dashboard shows it. */
export function commandStatement(command: Document): string {
	return BSON.EJSON.stringify(command, { relaxed: true });
}
