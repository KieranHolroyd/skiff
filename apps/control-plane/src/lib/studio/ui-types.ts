/**
 * Contracts between the studio UI pieces (plan 22 Phase 2 UI). Three tracks build against these
 * at the same time; change a prop here only together with every implementation.
 *
 *   grid/StudioGrid.svelte                 track E  virtual grid, inline edit, pending tray, inspector
 *   workspaces/RelationalWorkspace.svelte  track E  data (filter/sort/page/edit) and structure tabs
 *   shell/*  + the route +page.svelte      track E  session header, object tree, tab strip
 *   editor/StudioEditor.svelte             track F  Monaco, per-language completion and markers
 *   query/QueryTab.svelte                  track F  editor + run/stop + streamed result sets + history
 *   completion.ts, history.ts              track F
 *   workspaces/DocumentWorkspace.svelte    track G  MongoDB collections
 *   workspaces/KeyValueWorkspace.svelte    track G  Valkey/Redis key groups and keys
 */
import type { Snippet } from 'svelte';
import type {
	ApplyResult,
	BrowseQuery,
	Cell,
	Column,
	RowChange,
	StudioInfo,
	TreeNode,
} from '@skiff/studio/protocol';

export interface StudioGridProps {
	columns: Column[];
	rows: Cell[][];
	/** Accessible name of the grid. */
	label: string;
	/** Columns identifying a row (`describe().primaryKey`, `['_id']`, `['key']`); empty = read-only. */
	keyColumns?: string[];
	/** Whether edits are allowed (object editable and session read-write). */
	editable?: boolean;
	/**
	 * Apply the user's pending edits. The grid collects inserts/updates/deletes in a tray, builds
	 * `RowChange`s with `original` values, and calls this; conflicts are shown per row.
	 */
	onapply?: (changes: RowChange[]) => Promise<ApplyResult>;
	/** Load the full value of a `truncated` cell. */
	onloadvalue?: (row: Cell[], column: string) => Promise<Cell>;
	loading?: boolean;
	/** Rendered under the grid (pager, counts). */
	footer?: Snippet;
	/** Current sort; with `onsort`, headers become sort buttons (shift-click adds a column). */
	sort?: BrowseQuery['sort'];
	onsort?: (column: string, additive: boolean) => void;
	/** Clicking a row's number opens it (e.g. a key's detail). Not called for unsaved new rows. */
	onrowactivate?: (row: Cell[], index: number) => void;
}

/** Props every family workspace receives for one browsable object the user opened. */
export interface WorkspaceProps {
	/** Database name (route param), used for `studioCall(database, …)`. */
	database: string;
	info: StudioInfo;
	object: TreeNode;
	/** Ask the shell to open a query tab prefilled with `input` (e.g. "Query this table"). */
	onquery?: (input: string) => void;
}

export interface CompletionItem {
	label: string;
	kind: 'schema' | 'table' | 'view' | 'collection' | 'column' | 'field' | 'key' | 'keyword' | 'command' | 'snippet';
	detail?: string;
	insertText?: string;
}

/** Feeds Monaco completion from `tree`/`describe`, lazily and cached per session. */
export interface CompletionSource {
	items(context: { prefix: string; qualifier?: string }): Promise<CompletionItem[]>;
}

export interface StudioEditorProps {
	/** `$bindable`: the editor writes edits back. */
	value: string;
	language: StudioInfo['capabilities']['language'];
	dialect?: StudioInfo['capabilities']['dialect'];
	completion?: CompletionSource;
	/** Cmd/Ctrl+Enter: the selection if any, else the whole text. */
	onrun?: (text: string) => void;
	/** Error markers, `position` is a 1-based character offset into `value`. */
	markers?: Array<{ position: number; message: string }>;
	readOnly?: boolean;
	class?: string;
}

export interface QueryTabProps {
	database: string;
	info: StudioInfo;
	initialInput?: string;
}
