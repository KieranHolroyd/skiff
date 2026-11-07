import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import CylinderIcon from '@lucide/svelte/icons/cylinder';
import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import Settings2Icon from '@lucide/svelte/icons/settings-2';
import type { StorageView } from '@skiff/contracts';
import type { Subnav, SubnavItem, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../_lib/service/sections.js';
import { STORAGE_DEFAULT_TAB, STORAGE_TABS, type StorageTab } from './storage-tabs.js';

export const storageSubnavKey = (name: string) => `storage:${name}`;

/** A storage instance's sections; Objects and Logs are their own routes. */
export function storageSubnav(
	data: { storage: StorageView },
	url: RouteUrl,
	route: 'objects' | 'logs' | null
): Subnav {
	const st = data.storage;
	const base = resolve('/(dashboard)/storage/[name]', { name: st.name });
	const local = (id: StorageTab, label: string, icon: SubnavItem['icon'], count?: number) => ({
		id,
		label,
		icon,
		count,
		href: tabHref(base, id, STORAGE_DEFAULT_TAB)
	});
	const items: SubnavItem[] = [
		local('overview', 'Overview', LayoutDashboardIcon),
		local(
			'buckets',
			'Buckets',
			ArchiveIcon,
			st.buckets.filter((bucket) => bucket.state === 'ready').length
		),
		...(st.deletedAt !== null
			? []
			: [
					{
						id: 'objects',
						label: 'Objects',
						icon: FolderOpenIcon,
						href: resolve('/(dashboard)/storage/[name]/objects', { name: st.name })
					}
				]),
		local('metrics', 'Metrics', ActivityIcon),
		{
			id: 'logs',
			label: 'Logs',
			icon: ScrollTextIcon,
			href: resolve('/(dashboard)/storage/[name]/logs', { name: st.name })
		},
		local('settings', 'Settings', Settings2Icon)
	];
	return {
		key: storageSubnavKey(st.name),
		depth: 1,
		title: st.name,
		mono: true,
		icon: CylinderIcon,
		back: { href: resolve('/(dashboard)/storage'), label: 'Storage' },
		active: route ?? readTab(url.searchParams.get('tab'), STORAGE_TABS, STORAGE_DEFAULT_TAB),
		target: 'service.tab',
		groups: [{ id: 'sections', items }]
	};
}
