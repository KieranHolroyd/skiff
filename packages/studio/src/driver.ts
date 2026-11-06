/**
 * The contract every engine plugin implements (plan 22 "Plugin model"). A plugin is loaded
 * lazily inside the studio process, never in the agent or the control plane.
 *
 * Rules every plugin follows:
 * - Identifiers come from `describe`/`tree` and are quoted by the plugin's dialect. Values are
 *   always bound parameters. Only `run` accepts free text.
 * - `browse` and `run` stream; they never buffer a whole result. They stop at `limits.maxRows`
 *   and report `truncated`; the studio process also enforces `maxBytes` on the encoded stream.
 * - Aborting `signal` cancels the work on the server (see `capabilities.cancel`).
 * - A read-only session runs every statement read-only, as a second layer under the
 *   read-only credential.
 */
import type { DatabaseEngine, DatabaseStudioActivation, StudioLimits } from '@skiff/contracts';
import type {
	AlterResult,
	ApplyResult,
	BrowseQuery,
	Cell,
	ExplainResult,
	ObjectDescription,
	ObjectRef,
	RowChange,
	SchemaChange,
	StudioCapabilities,
	StudioEvent,
	TreeNode,
	TreePath,
} from './protocol.ts';

/** Connection target: the activation minus the session bookkeeping. */
export type StudioTarget = Pick<
	DatabaseStudioActivation,
	'engine' | 'version' | 'host' | 'port' | 'database' | 'user' | 'password' | 'tls'
>;

export interface SessionOptions {
	readOnly: boolean;
	limits: StudioLimits;
}

export interface RunOptions {
	/** Already clamped to the session limit. */
	maxRows: number;
	timeoutMs: number;
}

export interface StudioSession {
	/** One level of the object tree under `path` (`[]` is the root). */
	tree(path: TreePath, signal: AbortSignal): Promise<TreeNode[]>;
	describe(object: ObjectRef, signal: AbortSignal): Promise<ObjectDescription>;
	/**
	 * One page of rows/documents/keys: `columns`, `rows`… then `page` (next cursor), then `done`.
	 */
	browse(object: ObjectRef, query: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent>;
	/**
	 * Free-form input in the engine's language. Each statement yields `columns`/`rows`/`result`;
	 * the stream ends with `done` (or `error`).
	 */
	run(input: string, options: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent>;
	explain?(input: string, signal: AbortSignal): Promise<ExplainResult>;
	/** All changes in one transaction; any conflict rolls the whole batch back. */
	apply(object: ObjectRef, changes: RowChange[], signal: AbortSignal): Promise<ApplyResult>;
	/** The full value of one cell that `browse`/`run` returned as `truncated`. */
	value?(object: ObjectRef, key: Record<string, Cell>, column: string, signal: AbortSignal): Promise<Cell>;
	/**
	 * One structure edit (`capabilities.structure` lists the ops it accepts; anything else is
	 * `unsupported`). Read-only sessions refuse with `read_only`. With `dryRun`, return the
	 * statements without running them. A plugin runs the statements in one transaction where
	 * the engine allows DDL in one, and drops any cached description of the objects it touched.
	 */
	alter?(change: SchemaChange, options: { dryRun: boolean }, signal: AbortSignal): Promise<AlterResult>;
	close(): Promise<void>;
}

export interface StudioPlugin {
	/** Stable plugin id, e.g. `postgres`, `mysql`, `mongodb`, `keyvalue`, `fake`. */
	id: string;
	engines: readonly DatabaseEngine[];
	capabilities(engine: DatabaseEngine, version: string): StudioCapabilities;
	connect(target: StudioTarget, options: SessionOptions): Promise<StudioSession>;
}
