import { getContext, setContext } from 'svelte';

/**
 * What the page that owns the current sidebar pane adds on the client: the section it is showing
 * while it switches in place (before, or without, a navigation), counts it loads itself, and a
 * handler that takes a section click without a page load.
 */
export interface SubnavLocal {
	/** Must match the pane's `Subnav.key`; anything else is ignored. */
	key: string;
	active?: string;
	counts?: Record<string, number | undefined>;
	/** Return `true` when the page switched to `id` itself; the link then does not navigate. */
	select?: (id: string) => boolean;
}

class SubnavLocalHost {
	current = $state.raw<SubnavLocal | null>(null);
}

const KEY = Symbol('skiff.subnav-local');

/** Called once by the dashboard layout. */
export function provideSubnavLocal(): SubnavLocalHost {
	return setContext(KEY, new SubnavLocalHost());
}

export function subnavLocal(): SubnavLocalHost | undefined {
	return getContext<SubnavLocalHost | undefined>(KEY);
}

/** Register the page's in-place section state with the sidebar for as long as it is mounted. */
export function useSubnavLocal(get: () => SubnavLocal): void {
	const host = subnavLocal();
	if (!host) return;
	$effect(() => {
		const value = get();
		host.current = value;
		return () => {
			if (host.current === value) host.current = null;
		};
	});
}
