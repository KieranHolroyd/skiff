import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import CableIcon from '@lucide/svelte/icons/cable';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
import GlobeIcon from '@lucide/svelte/icons/globe';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import RocketIcon from '@lucide/svelte/icons/rocket';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import Settings2Icon from '@lucide/svelte/icons/settings-2';
import ZapIcon from '@lucide/svelte/icons/zap';
import type { Subnav, SubnavIcon, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../_lib/service/sections.js';
import { FUNCTION_DEFAULT_TAB, FUNCTION_TABS, type FunctionTab } from './function-tabs.js';

export const functionSubnavKey = (slug: string) => `function:${slug}`;

const SECTIONS: Array<{ id: FunctionTab; label: string; icon: SubnavIcon }> = [
	{ id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
	{ id: 'invocations', label: 'Invocations', icon: ActivityIcon },
	{ id: 'deployments', label: 'Deployments', icon: RocketIcon },
	{ id: 'bindings', label: 'Bindings & triggers', icon: CableIcon },
	{ id: 'data', label: 'Data', icon: DatabaseIcon },
	{ id: 'variables', label: 'Variables & secrets', icon: KeyRoundIcon },
	{ id: 'logs', label: 'Logs', icon: ScrollTextIcon },
	{ id: 'domains', label: 'Domains', icon: GlobeIcon },
	{ id: 'settings', label: 'Settings', icon: Settings2Icon }
];

/** A function's console sections. */
export function functionSubnav(
	data: {
		project: { slug: string };
		deployments: unknown[];
		domains: unknown[];
		view: { bindings: unknown[] } | null;
	},
	url: RouteUrl
): Subnav {
	const slug = data.project.slug;
	const base = resolve('/(dashboard)/functions/[slug]', { slug });
	const counts: Partial<Record<FunctionTab, number>> = {
		deployments: data.deployments.length,
		bindings: data.view?.bindings.length,
		domains: data.domains.length
	};
	return {
		key: functionSubnavKey(slug),
		depth: 1,
		title: slug,
		mono: true,
		icon: ZapIcon,
		back: { href: resolve('/(dashboard)/functions'), label: 'Functions' },
		active: readTab(url.searchParams.get('tab'), FUNCTION_TABS, FUNCTION_DEFAULT_TAB),
		target: 'service.tab',
		groups: [
			{
				id: 'sections',
				items: SECTIONS.map((section) => ({
					...section,
					count: counts[section.id],
					href: tabHref(base, section.id, FUNCTION_DEFAULT_TAB)
				}))
			}
		]
	};
}

export const FUNCTION_DEPLOYMENT_TABS = ['overview', 'logs', 'source'] as const;
export type FunctionDeploymentTab = (typeof FUNCTION_DEPLOYMENT_TABS)[number];

export const functionDeploymentSubnavKey = (id: string) => `function-deployment:${id}`;

/** One deployment of a function: a level below the function's sections. */
export function functionDeploymentSubnav(
	data: { project: { slug: string }; deployment: { id: string; shortId: string } },
	url: RouteUrl
): Subnav {
	const { project, deployment } = data;
	const base = resolve('/(dashboard)/functions/[slug]/deployments/[id]', {
		slug: project.slug,
		id: deployment.id
	});
	return {
		key: functionDeploymentSubnavKey(deployment.id),
		depth: 2,
		title: deployment.shortId,
		mono: true,
		icon: RocketIcon,
		back: {
			href: tabHref(
				resolve('/(dashboard)/functions/[slug]', { slug: project.slug }),
				'deployments',
				FUNCTION_DEFAULT_TAB
			),
			label: project.slug
		},
		active: readTab(url.searchParams.get('tab'), FUNCTION_DEPLOYMENT_TABS, 'overview'),
		target: 'function.deployment.tab',
		groups: [
			{
				id: 'sections',
				label: 'Deployment',
				items: [
					{ id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
					{ id: 'logs', label: 'Logs', icon: ScrollTextIcon },
					{ id: 'source', label: 'Bundle', icon: FolderTreeIcon }
				].map((section) => ({ ...section, href: tabHref(base, section.id, 'overview') }))
			}
		]
	};
}
