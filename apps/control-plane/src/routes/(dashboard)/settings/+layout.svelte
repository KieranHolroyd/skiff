<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PageHeader from '../_lib/PageHeader.svelte';

	let { children } = $props();

	const tabs = [
		{
			label: 'Organisation',
			href: '/(dashboard)/settings',
			path: '/settings',
			icon: Building2Icon
		},
		{
			label: 'Account',
			href: '/(dashboard)/settings/account',
			path: '/settings/account',
			icon: UserRoundIcon
		}
	] as const;

	function isActive(path: string): boolean {
		return page.url.pathname === path;
	}
</script>

<div class="space-y-6">
	<PageHeader
		title="Settings"
		description="Your account, the organisation you are signed in to, and the keys that act on your behalf."
	/>

	<nav
		class="inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1"
		aria-label="Settings sections"
	>
		{#each tabs as tab (tab.href)}
			{@const Icon = tab.icon}
			<a
				href={resolve(tab.href)}
				aria-current={isActive(tab.path) ? 'page' : undefined}
				class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 {isActive(
					tab.path
				)
					? 'bg-background text-foreground shadow-xs'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				<Icon class="size-4" aria-hidden="true" />
				{tab.label}
			</a>
		{/each}
	</nav>

	{@render children()}
</div>
