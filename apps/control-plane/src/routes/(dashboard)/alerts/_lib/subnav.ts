import { resolve } from '$app/paths';
import BellIcon from '@lucide/svelte/icons/bell';
import BellOffIcon from '@lucide/svelte/icons/bell-off';
import BellRingIcon from '@lucide/svelte/icons/bell-ring';
import HistoryIcon from '@lucide/svelte/icons/history';
import ListChecksIcon from '@lucide/svelte/icons/list-checks';
import SendIcon from '@lucide/svelte/icons/send';
import ServerCogIcon from '@lucide/svelte/icons/server-cog';
import type { Subnav, RouteUrl } from '#lib/nav/subnav.js';

export const ALERT_TABS = ['active', 'rules', 'silences', 'history', 'system', 'channels'] as const;
export type AlertTab = (typeof ALERT_TABS)[number];
export const ADMIN_ALERT_TABS = new Set<AlertTab>(['system', 'channels']);

export const ALERTS_SUBNAV_KEY = 'alerts';

/** `?tab=` narrowed to a section this viewer can open. */
export function readAlertTab(value: string | null, platformAdmin: boolean): AlertTab {
	const tab = ALERT_TABS.includes(value as AlertTab) ? (value as AlertTab) : 'active';
	return ADMIN_ALERT_TABS.has(tab) && !platformAdmin ? 'active' : tab;
}

/**
 * Alerts' sections. Rule pages (`/alerts/rules/…`) keep Rules lit. Counts come from the page's
 * own queries, through `useSubnavLocal`.
 */
export function alertsSubnav(platformAdmin: boolean, url: RouteUrl, onRule: boolean): Subnav {
	const base = resolve('/(dashboard)/alerts');
	const href = (tab: AlertTab) => (tab === 'active' ? base : `${base}?tab=${tab}`);
	return {
		key: ALERTS_SUBNAV_KEY,
		depth: 1,
		title: 'Alerts',
		icon: BellIcon,
		back: { href: resolve('/(dashboard)/overview'), label: 'Overview' },
		active: onRule ? 'rules' : readAlertTab(url.searchParams.get('tab'), platformAdmin),
		target: 'alerts.tab',
		groups: [
			{
				id: 'alerts',
				items: [
					{ id: 'active', label: 'Active', icon: BellRingIcon, href: href('active') },
					{ id: 'rules', label: 'Rules', icon: ListChecksIcon, href: href('rules') },
					{ id: 'silences', label: 'Silences', icon: BellOffIcon, href: href('silences') },
					{ id: 'history', label: 'History', icon: HistoryIcon, href: href('history') }
				]
			},
			...(platformAdmin
				? [
						{
							id: 'platform',
							label: 'Platform',
							items: [
								{ id: 'system', label: 'System alerts', icon: ServerCogIcon, href: href('system') },
								{ id: 'channels', label: 'Channels', icon: SendIcon, href: href('channels') }
							]
						}
					]
				: [])
		]
	};
}
