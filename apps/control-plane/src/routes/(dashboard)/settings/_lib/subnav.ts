import { resolve } from '$app/paths';
import SettingsIcon from '@lucide/svelte/icons/settings';
import { slot, type Subnav } from '#lib/nav/subnav.js';
import NavHint, { type Hints } from './NavHint.svelte';
import RoleAccessCard from './RoleAccessCard.svelte';
import { GROUP_LABELS, GROUP_ORDER, sectionForPath, visibleSections } from './sections.js';

/** The facts the settings sidebar reads: the dashboard layout's, plus the settings layout's hints. */
export interface SettingsSubnavData {
	role: string;
	permissions: readonly string[];
	can: { manageNodes: boolean };
	org: { name: string };
	hints: Hints;
	updateAvailable: Promise<{ latest: string } | null> | null;
}

export function settingsSubnav(data: SettingsSubnavData, pathname: string): Subnav {
	const sections = visibleSections({
		platformAdmin: data.can.manageNodes,
		role: data.role,
		permissions: data.permissions
	});
	return {
		key: 'settings',
		depth: 1,
		title: 'Settings',
		icon: SettingsIcon,
		back: { href: resolve('/(dashboard)/overview'), label: 'Overview' },
		active: sectionForPath(pathname, sections)?.id ?? null,
		target: 'settings.tab',
		groups: GROUP_ORDER.map((group) => ({
			id: group,
			label: GROUP_LABELS[group],
			note: group === 'organisation' ? data.org.name : undefined,
			items: sections
				.filter((entry) => entry.group === group)
				.map((entry) => ({
					id: entry.id,
					label: entry.label,
					icon: entry.icon,
					href: resolve(entry.href),
					hint: slot(NavHint, { id: entry.id, hints: data.hints, update: data.updateAvailable })
				}))
		})).filter((group) => group.items.length > 0),
		footer: slot(RoleAccessCard, { role: data.role })
	};
}
