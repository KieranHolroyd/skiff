/**
 * Studio wire protocol (plan 22). The same request bodies and events travel on every hop:
 * browser → control plane → agent front → studio process. Only the studio process decodes
 * result events; the hops in between forward bytes and add authentication.
 *
 * Calls are `POST /v1/<op>` with a JSON body. `browse` and `run` answer with NDJSON
 * (`application/x-ndjson`), one `StudioEvent` per line; the rest answer with JSON. Errors are
 * `{ error: { code, message } }` with a 4xx/5xx status, or an `error` event once streaming began.
 */
import * as z from 'zod';
import { STUDIO_PROTOCOL_VERSION } from '@yoal/contracts';

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
export { STUDIO_PROTOCOL_VERSION };

// ---------------------------------------------------------------- cells and columns

/** How the grid renders and edits a value. Plugins map native types onto these. */
export const cellKinds = [
	'text',
	'number',
	'bigint',
	'decimal',
	'boolean',
	'date',
	'time',
	'datetime',
	'interval',
	'uuid',
	'json',
	'bytes',
	'array',
	'enum',
	'objectid',
	'document',
	'unknown',
] as const;
export type CellKind = (typeof cellKinds)[number];

/** Tags for values that plain JSON cannot carry losslessly. */
export const cellTags = ['bigint', 'decimal', 'bytes', 'date', 'datetime', 'json', 'ejson', 'truncated'] as const;
export type CellTag = (typeof cellTags)[number];

export const taggedCellSchema = z.object({
	$t: z.enum(cellTags),
	/** String form for scalars, base64 for bytes, a JSON value for json/ejson, a preview for truncated. */
	v: z.unknown(),
	/** Full size in bytes, for `truncated`. */
	bytes: z.number().int().nonnegative().optional(),
});
export type TaggedCell = z.infer<typeof taggedCellSchema>;

/** A plain JSON value when that is lossless, otherwise a tagged cell. */
export const cellSchema: z.ZodType<Cell> = z.union([
	z.null(),
	z.boolean(),
	z.number(),
	z.string(),
	taggedCellSchema,
	z.array(z.lazy(() => cellSchema)),
]);
export type Cell = null | boolean | number | string | TaggedCell | Cell[];

export const columnSchema = z.object({
	name: z.string(),
	/** The engine's own type name, e.g. `timestamp with time zone`, `varchar(32)`, `hash`. */
	nativeType: z.string(),
	kind: z.enum(cellKinds),
	nullable: z.boolean().optional(),
	key: z.enum(['primary', 'unique']).nullable().optional(),
	/** False for generated, identity-always or computed columns. */
	editable: z.boolean().optional(),
	/** `describe` only: the column default as the engine prints it (display text, never re-sent). */
	default: z.string().nullable().optional(),
});
export type Column = z.infer<typeof columnSchema>;

// ---------------------------------------------------------------- tree and objects

export const treeNodeKinds = [
	'database',
	'schema',
	'table',
	'view',
	'materialized-view',
	'foreign-table',
	'collection',
	'keyspace',
	'key-group',
	'key',
	'folder',
] as const;
export type TreeNodeKind = (typeof treeNodeKinds)[number];

/** A path from the root of the session's tree, e.g. `['public', 'users']` or `['user:']`. */
export const treePathSchema = z.array(z.string().max(1_024)).max(16);
export type TreePath = z.infer<typeof treePathSchema>;

export const objectRefSchema = z.object({
	path: treePathSchema.min(1),
	kind: z.enum(treeNodeKinds),
});
export type ObjectRef = z.infer<typeof objectRefSchema>;

export const treeNodeSchema = z.object({
	path: treePathSchema,
	name: z.string(),
	kind: z.enum(treeNodeKinds),
	hasChildren: z.boolean(),
	/** Browsable through `browse` (tables, views, collections, keys, key groups). */
	browsable: z.boolean(),
	detail: z
		.object({
			rows: z.number().nonnegative().optional(),
			bytes: z.number().nonnegative().optional(),
			/** Redis key type, Mongo collection type, etc. */
			type: z.string().optional(),
			ttlMs: z.number().optional(),
		})
		.optional(),
});
export type TreeNode = z.infer<typeof treeNodeSchema>;

export const objectDescriptionSchema = z.object({
	object: objectRefSchema,
	columns: z.array(columnSchema),
	primaryKey: z.array(z.string()).nullable(),
	indexes: z.array(
		z.object({
			name: z.string(),
			columns: z.array(z.string()),
			unique: z.boolean(),
			definition: z.string().optional(),
		}),
	),
	foreignKeys: z.array(
		z.object({
			name: z.string(),
			columns: z.array(z.string()),
			references: z.object({ path: treePathSchema, columns: z.array(z.string()) }),
		}),
	),
	ddl: z.string().optional(),
	estimate: z.object({ rows: z.number().optional(), bytes: z.number().optional() }).optional(),
	/** Whether `apply` accepts changes for this object, and why not when it does not. */
	editable: z.boolean(),
	reason: z.string().optional(),
});
export type ObjectDescription = z.infer<typeof objectDescriptionSchema>;

// ---------------------------------------------------------------- browse

export const filterOps = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'in', 'is-null', 'not-null'] as const;
export type FilterOp = (typeof filterOps)[number];

export const browseQuerySchema = z.object({
	/** Page size. */
	limit: z.number().int().min(1).max(1_000).default(100),
	/** Opaque cursor from the previous page's `page` event. */
	cursor: z.string().max(8_192).optional(),
	sort: z.array(z.object({ column: z.string(), dir: z.enum(['asc', 'desc']) })).max(8).default([]),
	filter: z
		.array(z.object({ column: z.string(), op: z.enum(filterOps), value: cellSchema.optional() }))
		.max(32)
		.default([]),
	/**
	 * Engine-native filter for engines whose filters are not column predicates: a Mongo EJSON
	 * query document, or a Redis/Valkey `MATCH` pattern.
	 */
	native: z.string().max(65_536).optional(),
	/** Redis/Valkey `SCAN … TYPE`. */
	type: z.string().max(32).optional(),
});
export type BrowseQuery = z.infer<typeof browseQuerySchema>;

// ---------------------------------------------------------------- edits

const rowValues = z.record(z.string(), cellSchema);
export const rowChangeSchema = z.discriminatedUnion('op', [
	z.object({ op: z.literal('insert'), values: rowValues }),
	z.object({
		op: z.literal('update'),
		/** The full primary key, `_id`, or `{ key }` for key-value engines. */
		key: rowValues,
		values: rowValues,
		/** Original values of the edited columns, for optimistic concurrency. */
		original: rowValues,
	}),
	z.object({ op: z.literal('delete'), key: rowValues, original: rowValues.optional() }),
]);
export type RowChange = z.infer<typeof rowChangeSchema>;

export const applyResultSchema = z.object({
	applied: z.number().int().nonnegative(),
	/** When any change conflicts, the whole batch is rolled back and `applied` is 0. */
	conflicts: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string() })),
});
export type ApplyResult = z.infer<typeof applyResultSchema>;

// ---------------------------------------------------------------- structure (DDL)

/**
 * Structure edits are typed, never free text: `run` stays the only op that takes raw SQL or
 * commands, so it stays the only one audited by fingerprint. Names are quoted by the plugin;
 * column types and default expressions must match the patterns below, which admit the type
 * names and niladic defaults people use (`varchar(32)`, `numeric(10,2)`, `timestamp with time
 * zone`, `integer[]`, `enum('a','b')`, `now()`, `CURRENT_TIMESTAMP(6)`) and nothing that can
 * end a statement or open a comment.
 */
const TYPE_WORDS = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?: [A-Za-z_][A-Za-z0-9_]*)*`;
const TYPE_ARGS = String.raw`\(\s*(?:\d+(?:\s*,\s*\d+)?|'(?:[^'\\\r\n;]|'')*'(?:\s*,\s*'(?:[^'\\\r\n;]|'')*')*)\s*\)`;
export const COLUMN_TYPE_PATTERN = new RegExp(`^${TYPE_WORDS}(?:\\s*${TYPE_ARGS})?(?: ${TYPE_WORDS})?(?:\\[\\])*$`);
export const DEFAULT_EXPRESSION_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?:\(\s*\d{0,2}\s*\))?$/;

/** Any engine identifier: a table, column, index, collection, field path or key name. */
const identifier = z
	.string()
	.min(1)
	.max(1_024)
	.refine((name) => !name.includes('\0'), 'A name cannot contain NUL.');

export const columnTypeSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(COLUMN_TYPE_PATTERN, 'Use a plain type name such as varchar(255), numeric(10,2) or integer[].');

export const columnDefaultSchema = z.union([
	/** A constant, quoted by the plugin. */
	z.object({ literal: z.union([z.string().max(65_536), z.number(), z.boolean()]) }),
	/** A keyword or zero/one-number-argument function call: `now()`, `CURRENT_TIMESTAMP`. */
	z.object({
		expression: z
			.string()
			.trim()
			.max(100)
			.regex(DEFAULT_EXPRESSION_PATTERN, 'Use a keyword or a function call such as now() or CURRENT_TIMESTAMP.'),
	}),
]);
export type ColumnDefault = z.infer<typeof columnDefaultSchema>;

export const columnSpecSchema = z.object({
	name: identifier,
	type: columnTypeSchema,
	nullable: z.boolean().default(true),
	default: columnDefaultSchema.optional(),
	/** Postgres `GENERATED BY DEFAULT AS IDENTITY`, MySQL/MariaDB `AUTO_INCREMENT`. */
	identity: z.boolean().default(false),
});
export type ColumnSpec = z.infer<typeof columnSpecSchema>;

export const schemaChangeOps = [
	'create-schema',
	'create-table',
	'create-collection',
	'rename',
	'drop',
	'truncate',
	'add-column',
	'drop-column',
	'rename-column',
	'alter-column',
	'create-index',
	'drop-index',
] as const;
export type SchemaChangeOp = (typeof schemaChangeOps)[number];

export const schemaChangeSchema = z.discriminatedUnion('op', [
	/** Postgres: a new schema. */
	z.object({ op: z.literal('create-schema'), name: identifier }),
	/** Relational: `parent` is the tree path the table goes under (`[schema]`, or `[]`). */
	z.object({
		op: z.literal('create-table'),
		parent: treePathSchema.max(4).default([]),
		name: identifier,
		columns: z.array(columnSpecSchema).min(1).max(500),
		primaryKey: z.array(identifier).max(32).default([]),
	}),
	/** MongoDB: an empty collection. */
	z.object({ op: z.literal('create-collection'), parent: treePathSchema.max(4).default([]), name: identifier }),
	/** A table, view, collection or key gets a new last path element. */
	z.object({ op: z.literal('rename'), object: objectRefSchema, name: identifier }),
	/** `cascade`: Postgres drops dependent objects too. */
	z.object({ op: z.literal('drop'), object: objectRefSchema, cascade: z.boolean().default(false) }),
	/** Remove every row or document, keep the object. */
	z.object({ op: z.literal('truncate'), object: objectRefSchema }),
	z.object({ op: z.literal('add-column'), object: objectRefSchema, column: columnSpecSchema }),
	/** MongoDB: `$unset` the field in every document. */
	z.object({ op: z.literal('drop-column'), object: objectRefSchema, column: identifier }),
	/** MongoDB: `$rename` the field in every document. */
	z.object({ op: z.literal('rename-column'), object: objectRefSchema, column: identifier, name: identifier }),
	/** Only the fields present change. `default: null` drops the default. */
	z.object({
		op: z.literal('alter-column'),
		object: objectRefSchema,
		column: identifier,
		type: columnTypeSchema.optional(),
		nullable: z.boolean().optional(),
		default: columnDefaultSchema.nullable().optional(),
	}),
	z.object({
		op: z.literal('create-index'),
		object: objectRefSchema,
		/** Generated from the table and columns when absent. */
		name: identifier.optional(),
		columns: z
			.array(z.object({ name: identifier, dir: z.enum(['asc', 'desc']).default('asc') }))
			.min(1)
			.max(32),
		unique: z.boolean().default(false),
	}),
	z.object({ op: z.literal('drop-index'), object: objectRefSchema, name: identifier }),
]);
export type SchemaChange = z.infer<typeof schemaChangeSchema>;
export type SchemaChangeInput = z.input<typeof schemaChangeSchema>;

export const alterResultSchema = z.object({
	/** What ran (or, for a dry run, would run): SQL statements or engine commands, for review. */
	statements: z.array(z.string()),
	applied: z.boolean(),
	/** Rows or documents touched, when the engine reports it (`truncate`, Mongo field edits). */
	affected: z.number().int().nonnegative().optional(),
});
export type AlterResult = z.infer<typeof alterResultSchema>;

/** The object a change acts on, or creates, as a dotted path for audit. */
export function schemaChangeTarget(change: SchemaChange): string[] {
	switch (change.op) {
		case 'create-schema':
			return [change.name];
		case 'create-table':
		case 'create-collection':
			return [...change.parent, change.name];
		default:
			return change.object.path;
	}
}

// ---------------------------------------------------------------- events

export const studioEventSchema = z.discriminatedUnion('t', [
	/** Starts a result set. */
	z.object({ t: z.literal('columns'), columns: z.array(columnSchema) }),
	/** A batch of at most 500 rows, cells in `columns` order. */
	z.object({ t: z.literal('rows'), rows: z.array(z.array(cellSchema)) }),
	z.object({ t: z.literal('notice'), level: z.enum(['info', 'warn']), message: z.string() }),
	/** Ends one statement's result (DML count, command tag). */
	z.object({ t: z.literal('result'), affected: z.number().optional(), command: z.string().optional() }),
	/** Browse only: the cursor for the next page, or null at the end. */
	z.object({ t: z.literal('page'), next: z.string().nullable(), estimate: z.number().optional() }),
	z.object({ t: z.literal('done'), ms: z.number(), truncated: z.boolean() }),
	z.object({
		t: z.literal('error'),
		code: z.string(),
		message: z.string(),
		/** 1-based character offset into the input, when the engine reports one. */
		position: z.number().optional(),
	}),
]);
export type StudioEvent = z.infer<typeof studioEventSchema>;

// ---------------------------------------------------------------- capabilities

export const studioFamilies = ['relational', 'document', 'keyvalue'] as const;
export type StudioFamily = (typeof studioFamilies)[number];

export const studioCapabilitiesSchema = z.object({
	family: z.enum(studioFamilies),
	/** Editor language for `run`. */
	language: z.enum(['sql', 'mongo', 'redis']),
	dialect: z.enum(['postgres', 'mysql', 'mariadb']).optional(),
	edit: z.enum(['primary-key', 'document-id', 'key']).or(z.literal(false)),
	cancel: z.enum(['native', 'kill-connection', 'kill-op', 'none']),
	explain: z.boolean(),
	/** Tree has a schema/database level above objects. */
	schemas: z.boolean(),
	/**
	 * Structure edits `alter` accepts on a write session. Empty (or absent, from an older node)
	 * hides structure editing.
	 */
	structure: z.array(z.enum(schemaChangeOps)).default([]),
});
export type StudioCapabilities = z.infer<typeof studioCapabilitiesSchema>;

// ---------------------------------------------------------------- requests and responses

export const studioOps = ['info', 'tree', 'describe', 'browse', 'run', 'explain', 'apply', 'value', 'alter'] as const;
export type StudioOp = (typeof studioOps)[number];
/** Ops whose response is NDJSON. */
export const streamingOps: ReadonlySet<StudioOp> = new Set(['browse', 'run']);
/** Ops the agent may retry once after the studio process restarted. */
export const idempotentOps: ReadonlySet<StudioOp> = new Set(['info', 'tree', 'describe', 'browse', 'value']);

export const studioRequestSchemas = {
	info: z.object({}),
	tree: z.object({ path: treePathSchema.default([]) }),
	describe: z.object({ object: objectRefSchema }),
	browse: z.object({ object: objectRefSchema, query: browseQuerySchema }),
	run: z.object({
		input: z.string().min(1).max(1_048_576),
		/** Lower than the session limit only; the studio clamps it. */
		maxRows: z.number().int().min(1).max(10_000).optional(),
	}),
	explain: z.object({ input: z.string().min(1).max(1_048_576) }),
	apply: z.object({ object: objectRefSchema, changes: z.array(rowChangeSchema).min(1).max(1_000) }),
	value: z.object({ object: objectRefSchema, key: rowValues, column: z.string() }),
	/** One structure edit. `dryRun` returns the statements without running them. */
	alter: z.object({ change: schemaChangeSchema, dryRun: z.boolean().default(false) }),
} satisfies Record<StudioOp, z.ZodType>;
export type StudioRequest<Op extends StudioOp> = z.infer<(typeof studioRequestSchemas)[Op]>;

export const studioInfoSchema = z.object({
	v: z.literal(STUDIO_PROTOCOL_VERSION),
	engine: z.string(),
	version: z.string(),
	readOnly: z.boolean(),
	capabilities: studioCapabilitiesSchema,
	limits: z.object({ maxRows: z.number(), maxBytes: z.number(), statementTimeoutMs: z.number() }),
	expiresAt: z.string(),
});
export type StudioInfo = z.infer<typeof studioInfoSchema>;

export const explainResultSchema = z.object({ format: z.enum(['text', 'json']), plan: z.unknown() });
export type ExplainResult = z.infer<typeof explainResultSchema>;

export interface StudioResponses {
	info: StudioInfo;
	tree: { nodes: TreeNode[] };
	describe: ObjectDescription;
	explain: ExplainResult;
	apply: ApplyResult;
	value: { cell: Cell };
	alter: AlterResult;
}

/** Stable error codes shared by every hop. */
export const studioErrorCodes = [
	'bad_request',
	'unauthorized',
	'forbidden',
	'not_found',
	'unknown_session',
	'session_expired',
	'read_only',
	'busy',
	'timeout',
	'cancelled',
	'unsupported',
	'conflict',
	'studio_unavailable',
	'studio_restarted',
	'engine_error',
	'internal',
] as const;
export type StudioErrorCode = (typeof studioErrorCodes)[number];

export const studioErrorBodySchema = z.object({
	error: z.object({ code: z.enum(studioErrorCodes), message: z.string() }),
});
export type StudioErrorBody = z.infer<typeof studioErrorBodySchema>;

export class StudioError extends Error {
	constructor(
		readonly code: StudioErrorCode,
		message: string,
		readonly status = statusForCode(code),
	) {
		super(message);
		this.name = 'StudioError';
	}
	toBody(): StudioErrorBody {
		return { error: { code: this.code, message: this.message } };
	}
}

export function statusForCode(code: StudioErrorCode): number {
	switch (code) {
		case 'bad_request':
			return 400;
		case 'unauthorized':
			return 401;
		case 'forbidden':
		case 'read_only':
			return 403;
		case 'not_found':
		case 'unknown_session':
			return 404;
		case 'conflict':
		case 'busy':
			return 409;
		case 'session_expired':
			return 410;
		case 'unsupported':
			return 422;
		case 'cancelled':
			return 499;
		case 'studio_unavailable':
		case 'studio_restarted':
			return 503;
		case 'timeout':
			return 504;
		default:
			return 500;
	}
}

/** Encode one event as an NDJSON line. */
export function encodeEvent(event: StudioEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** Decode an NDJSON byte stream into events; used by tests, the control plane and the UI. */
export async function* decodeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StudioEvent> {
	const decoder = new TextDecoder();
	let buffered = '';
	for await (const chunk of body) {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf('\n');
		while (newline >= 0) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) yield studioEventSchema.parse(JSON.parse(line));
			newline = buffered.indexOf('\n');
		}
	}
	const tail = (buffered + decoder.decode()).trim();
	if (tail) yield studioEventSchema.parse(JSON.parse(tail));
}
