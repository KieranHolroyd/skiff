import type { Component } from 'svelte';

/** One tab in a managed service's section bar (database, storage). */
export interface ServiceSection {
	id: string;
	label: string;
	icon: Component<{ class?: string }>;
	href: string;
	count?: number;
	/** Switches in place on the detail page instead of navigating. */
	local?: boolean;
}

/** Narrow an untrusted `?tab=` to one of the page's in-place sections. */
export function readTab<T extends string>(
	value: string | null,
	tabs: readonly T[],
	fallback: T
): T {
	return tabs.includes(value as T) ? (value as T) : fallback;
}

/** `href` with `?tab=` set (or cleared for the default section). */
export function tabHref(href: string, tab: string, fallback: string): string {
	const url = new URL(href, 'http://skiff.local');
	if (tab === fallback) url.searchParams.delete('tab');
	else url.searchParams.set('tab', tab);
	return `${url.pathname}${url.search}`;
}

/** One headline number in a `StatStrip`. */
export interface Stat {
	label: string;
	value: string;
	/** Quiet unit after the value ("/ 10 GB"). */
	unit?: string;
	caption?: string;
	icon?: Component<{ class?: string }>;
	/** 0–100; draws a budget bar under the value (warns at 70, alerts at 85). */
	meter?: number | null;
}
