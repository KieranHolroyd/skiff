<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import CableIcon from '@lucide/svelte/icons/cable';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import Settings2Icon from '@lucide/svelte/icons/settings-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';
	import { tabHref, type ServiceSection } from '../../_lib/service/sections.js';
	import { FUNCTION_DEFAULT_TAB, type FunctionTab } from './function-tabs.js';

	/**
	 * The top of every function page: identity, one line of facts, actions and the section tabs.
	 * The deployment sub-route renders it too, so a deployment reads as part of its function.
	 */
	let {
		slug,
		active,
		counts = {},
		onselect,
		meta,
		children
	}: {
		slug: string;
		active: FunctionTab | 'deployment';
		counts?: Partial<Record<FunctionTab, number>>;
		onselect?: (tab: FunctionTab) => void;
		meta?: Snippet;
		children?: Snippet;
	} = $props();

	const base = $derived(resolve('/(dashboard)/functions/[slug]', { slug }));
	const sections = $derived<ServiceSection[]>(
		(
			[
				{ id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
				{ id: 'invocations', label: 'Invocations', icon: ActivityIcon },
				{ id: 'deployments', label: 'Deployments', icon: RocketIcon },
				{ id: 'bindings', label: 'Bindings & triggers', icon: CableIcon },
				{ id: 'data', label: 'Data', icon: DatabaseIcon },
				{ id: 'variables', label: 'Variables & secrets', icon: KeyRoundIcon },
				{ id: 'logs', label: 'Logs', icon: ScrollTextIcon },
				{ id: 'domains', label: 'Domains', icon: GlobeIcon },
				{ id: 'settings', label: 'Settings', icon: Settings2Icon }
			] as const
		).map((section) => ({
			...section,
			href: tabHref(base, section.id, FUNCTION_DEFAULT_TAB),
			count: counts[section.id],
			local: onselect !== undefined
		}))
	);
</script>

<ServiceHeader
	icon={ZapIcon}
	backHref={resolve('/(dashboard)/functions')}
	backLabel="Functions"
	title={slug}
	target="function.header"
	{sections}
	active={active === 'deployment' ? 'deployments' : active}
	onselect={onselect ? (id) => onselect(id as FunctionTab) : undefined}
	{meta}
	{children}
/>
