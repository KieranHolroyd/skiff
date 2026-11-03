<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PageHeader from '../_lib/PageHeader.svelte';

	let { data, children } = $props();

	const allTabs = [
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
		},
		{
			label: 'Updates',
			href: '/(dashboard)/settings/updates',
			path: '/settings/updates',
			icon: CircleArrowUpIcon,
			platformAdmin: true
		}
	] as const;

	// Updating restarts the whole platform, so only platform admins see the tab.
	const tabs = $derived(allTabs.filter((tab) => !('platformAdmin' in tab) || data.can.manageNodes));

	function isActive(path: string): boolean {
		return page.url.pathname === path;
	}
</script>

<div class="space-y-6">
	<div>
		<PageHeader
			eyebrow="Platform"
			title="Settings"
			description="Your account, the organisation you are signed in to, and the keys that act on your behalf."
			bordered={false}
		/>
		<nav class="flex gap-5 border-b" aria-label="Settings sections">
			{#each tabs as tab (tab.href)}
				{@const Icon = tab.icon}
				{@const active = isActive(tab.path)}
				<a
					href={resolve(tab.href)}
					aria-current={active ? 'page' : undefined}
					class="-mb-px flex items-center gap-2 border-b-2 py-3 text-sm font-medium transition-colors outline-none focus-visible:text-foreground {active
						? 'border-brand text-foreground'
						: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
				>
					<Icon class="size-4" aria-hidden="true" />
					{tab.label}
				</a>
			{/each}
		</nav>
	</div>

	{@render children()}
</div>
