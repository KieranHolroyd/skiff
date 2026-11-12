import { resolve } from '$app/paths';
import BugIcon from '@lucide/svelte/icons/bug';
import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
import CrosshairIcon from '@lucide/svelte/icons/crosshair';
import RocketIcon from '@lucide/svelte/icons/rocket';
import type { Subnav } from '#lib/nav/subnav.js';

export const ERROR_TABS = ['issues', 'targets', 'setup'] as const;
export type ErrorsTab = (typeof ERROR_TABS)[number];

/**
 * `?tab=` narrowed to a section. With no tab, an organization without targets lands on Setup and
 * everyone else on Issues.
 */
export function readErrorsTab(value: string | null, targetCount: number | null): ErrorsTab {
	if (ERROR_TABS.includes(value as ErrorsTab)) return value as ErrorsTab;
	return targetCount === 0 ? 'setup' : 'issues';
}

interface ErrorsNavData {
	tab: ErrorsTab;
	service: {
		targets: Array<{ lastSeenAt: number | null }>;
		summary: { unresolved: number };
	} | null;
}

/** Errors' sections, with the unresolved and target counts and a "listening" dot on Setup. */
export function errorsSubnav(data: ErrorsNavData): Subnav {
	const base = resolve('/(dashboard)/errors');
	const targets = data.service?.targets ?? [];
	const waiting = data.service !== null && !targets.some((target) => target.lastSeenAt !== null);
	return {
		key: 'errors',
		depth: 1,
		title: 'Errors',
		icon: CircleAlertIcon,
		back: { href: resolve('/(dashboard)/overview'), label: 'Overview' },
		active: data.tab,
		target: 'errors.tab',
		groups: [
			{
				id: 'errors',
				items: [
					{
						id: 'issues',
						label: 'Issues',
						icon: BugIcon,
						href: `${base}?tab=issues`,
						...(data.service && data.service.summary.unresolved > 0
							? { count: data.service.summary.unresolved }
							: {})
					},
					{
						id: 'targets',
						label: 'Targets',
						icon: CrosshairIcon,
						href: `${base}?tab=targets`,
						...(targets.length > 0 ? { count: targets.length } : {})
					},
					{
						id: 'setup',
						label: 'Setup',
						icon: RocketIcon,
						href: `${base}?tab=setup`,
						...(waiting ? { live: 'Waiting for the first event' } : {})
					}
				]
			}
		]
	};
}
