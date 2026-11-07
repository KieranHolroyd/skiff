import type { Component } from 'svelte';

/**
 * A section navigation that takes over the dashboard sidebar while the viewer is inside one area
 * (Settings, a project, a database, a deployment…). Each area describes its sections with a pure
 * builder over page data, so the server renders the right sidebar on first paint; the dashboard
 * layout picks the builder for the current route and animates between panes.
 */

export type SubnavIcon = Component<{ class?: string }>;

/** A component rendered at the end of an item, or below the sections. */
export interface SubnavSlot {
	component: Component<Record<string, unknown>>;
	props: Record<string, unknown>;
}

/** Wrap a component and its props as a `SubnavSlot`, keeping the props type-checked. */
export function slot<P extends Record<string, unknown>>(
	component: Component<P>,
	props: P
): SubnavSlot {
	return { component: component as unknown as SubnavSlot['component'], props };
}

export interface SubnavItem {
	id: string;
	label: string;
	icon: SubnavIcon;
	href: string;
	/** Section size, shown as a quiet counter. */
	count?: number;
	/** Work in flight (a running build): a pulsing dot instead of the count. */
	live?: string;
	/** Anything richer than a count (a status dot, a version pill). */
	hint?: SubnavSlot;
	/** `data-skiff-target` for the assistant tour. */
	target?: string;
}

export interface SubnavGroup {
	id: string;
	label?: string;
	/** Quiet text after the label (the organisation name). */
	note?: string;
	items: SubnavItem[];
}

export interface Subnav {
	/** Identity of the pane: changing it swaps the sidebar (another project, another database). */
	key: string;
	/**
	 * How deep the area sits below the main navigation: 1 for an area (Settings, a project), 2 for
	 * something inside one (a project's deployment). Going deeper slides forward, shallower back.
	 */
	depth: number;
	title: string;
	/** Resource names (slugs, ids) read better in mono. */
	mono?: boolean;
	icon?: SubnavIcon;
	back: {
		href: string;
		label: string;
		/** Return to wherever the viewer came from instead of `href` (Settings). */
		remember?: boolean;
	};
	groups: SubnavGroup[];
	/** The section the current URL shows; a page can override it while it switches in place. */
	active: string | null;
	/** `data-skiff-target` prefix for items without their own target. */
	target?: string;
	footer?: SubnavSlot;
}

/** The part of `page.url` builders read (SvelteKit's is read-only). */
export interface RouteUrl {
	readonly pathname: string;
	readonly searchParams: { get(name: string): string | null };
}
