import { getContext, setContext } from 'svelte';

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
}

const KEY = Symbol('studio-shell');

export function setStudioShell(context: StudioShellContext): void {
	setContext(KEY, context);
}

export function getStudioShell(): StudioShellContext | undefined {
	return getContext<StudioShellContext | undefined>(KEY);
}
