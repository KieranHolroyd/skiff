import { getContext, setContext } from 'svelte';
import type { TreeNode, TreeNodeKind } from '@yoal/studio/protocol';

/** A structure edit the shell reacts to: the tree refreshes and tabs follow the object. */
export type StructureEvent =
	/** A new object: refresh the tree, then open it. */
	| { kind: 'created'; path: readonly string[]; nodeKind: TreeNodeKind }
	| { kind: 'renamed'; from: readonly string[]; to: TreeNode }
	/** Its tab (and any tab inside it) closes. */
	| { kind: 'dropped'; path: readonly string[] }
	/** Columns, indexes or row counts changed: refresh the tree only. */
	| { kind: 'changed' };

/**
 * What the studio shell offers the workspaces inside it (plan 22), beyond `WorkspaceProps`:
 * opening another object's tab (foreign-key links) and reopening an expired session. Optional;
 * a workspace rendered outside the shell gets `undefined` and hides those affordances.
 */
export interface StudioShellContext {
	/** Open the object at `path` in a tab if it is in the tree; false when it isn't. */
	openPath(path: readonly string[]): Promise<boolean>;
	/** Open a new read-only session after `session_expired`/`unknown_session`. */
	reopen(): void;
	/** After an `alter`: refresh the tree and update the tabs it touched. */
	structureChanged(event: StructureEvent): void;
}

const KEY = Symbol('studio-shell');

export function setStudioShell(context: StudioShellContext): void {
	setContext(KEY, context);
}

export function getStudioShell(): StudioShellContext | undefined {
	return getContext<StudioShellContext | undefined>(KEY);
}
