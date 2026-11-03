<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import PageHeader from '../_lib/PageHeader.svelte';

	let { children } = $props();

	const tabs = [
		{ label: 'Organisation', href: '/(dashboard)/settings', path: '/settings', icon: Building2Icon },
		{
			label: 'Account',
			href: '/(dashboard)/settings/account',
			path: '/settings/account',
			icon: UserRoundIcon
		}
	] as const;

	const current = $derived(
		tabs.find((tab) => tab.path === page.url.pathname)?.href ?? tabs[0].href
	);
</script>

<div class="space-y-6">
	<div class="space-y-4">
		<PageHeader
			eyebrow="Platform"
			title="Settings"
			description="Your account, the organisation you are signed in to, and the keys that act on your behalf."
			bordered={false}
		/>
		<Tabs.Root value={current} onValueChange={(value) => goto(resolve(value as (typeof tabs)[number]['href']))}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Settings sections">
				{#each tabs as tab (tab.href)}
					<Tabs.Trigger value={tab.href} class="flex-none">
						<tab.icon />
						{tab.label}
					</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>
	</div>

	{@render children()}
</div>
