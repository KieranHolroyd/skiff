import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import DatabaseIcon from '@lucide/svelte/icons/database';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import Settings2Icon from '@lucide/svelte/icons/settings-2';
import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
import TableIcon from '@lucide/svelte/icons/table';
import type { DatabaseView } from '@skiff/contracts';
import type { Subnav, SubnavItem, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../_lib/service/sections.js';
import { DATABASE_DEFAULT_TAB, DATABASE_TABS, type DatabaseTab } from './database-tabs.js';

export const databaseSubnavKey = (name: string) => `database:${name}`;

/** A section the engine lacks (a stale `?tab=` link) falls back to the overview. */
export function shownDatabaseTab(
	tab: DatabaseTab,
	caps: DatabaseView['capabilities']
): DatabaseTab {
	return ((tab === 'metrics' || tab === 'insights') && !caps.metrics) ||
		(tab === 'backups' && !caps.backups)
		? 'overview'
		: tab;
}

/**
 * A database's sections. The in-place ones switch on the detail page; Studio and Logs are their
 * own routes, which pass `route` so the right item lights up.
 */
export function databaseSubnav(
	data: {
		database: DatabaseView;
		dbCan: { console: boolean };
		studioEnabled?: boolean;
		backups?: unknown[];
	},
	url: RouteUrl,
	route: 'studio' | 'logs' | null
): Subnav {
	const db = data.database;
	const caps = db.capabilities;
	const base = resolve('/(dashboard)/databases/[name]', { name: db.name });
	const local = (id: DatabaseTab, label: string, icon: SubnavItem['icon'], count?: number) => ({
		id,
		label,
		icon,
		count,
		href: tabHref(base, id, DATABASE_DEFAULT_TAB)
	});
	const items: SubnavItem[] = [
		local('overview', 'Overview', LayoutDashboardIcon),
		...(caps.metrics ? [local('metrics', 'Metrics', ActivityIcon)] : []),
		...(caps.backups ? [local('backups', 'Backups', ArchiveIcon, data.backups?.length)] : []),
		...(caps.metrics
			? [local('insights', 'Tables & queries', TableIcon, db.tables.length || undefined)]
			: []),
		...(data.dbCan.console && caps.console && data.studioEnabled === true
			? [
					{
						id: 'studio',
						label: 'Studio',
						icon: SquareTerminalIcon,
						href: resolve('/(dashboard)/databases/[name]/studio', { name: db.name })
					}
				]
			: []),
		local('settings', 'Settings', Settings2Icon),
		{
			id: 'logs',
			label: 'Logs',
			icon: ScrollTextIcon,
			href: resolve('/(dashboard)/databases/[name]/logs', { name: db.name })
		}
	];
	return {
		key: databaseSubnavKey(db.name),
		depth: 1,
		title: db.name,
		mono: true,
		icon: DatabaseIcon,
		back: { href: resolve('/(dashboard)/databases'), label: 'Databases' },
		active:
			route ??
			shownDatabaseTab(
				readTab(url.searchParams.get('tab'), DATABASE_TABS, DATABASE_DEFAULT_TAB),
				caps
			),
		target: 'service.tab',
		groups: [{ id: 'sections', items }]
	};
}
