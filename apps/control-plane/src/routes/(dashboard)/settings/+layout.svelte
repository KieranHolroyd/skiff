<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import PageHeader from '../_lib/PageHeader.svelte';

	let { data, children } = $props();

	type Tab = {
		label: string;
		href:
			| '/(dashboard)/settings'
			| '/(dashboard)/settings/account'
			| '/(dashboard)/settings/backups'
			| '/(dashboard)/settings/notifications'
			| '/(dashboard)/settings/updates';
		path: string;
		icon: typeof Building2Icon;
		platformAdmin?: boolean;
		/** Platform admin who also owns the current org (canConfigurePlatform on the server). */
		ownerOnly?: boolean;
	};

	const allTabs: Tab[] = [
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
			label: 'Backups',
			href: '/(dashboard)/settings/backups',
			path: '/settings/backups',
			icon: DatabaseBackupIcon,
			ownerOnly: true
		},
		{
			label: 'Notifications',
			href: '/(dashboard)/settings/notifications',
			path: '/settings/notifications',
			icon: BellRingIcon,
			ownerOnly: true
		},
		{
			label: 'Updates',
			href: '/(dashboard)/settings/updates',
			path: '/settings/updates',
			icon: CircleArrowUpIcon,
			platformAdmin: true
		}
	];

	const isOwner = $derived(data.can.manageNodes && data.role === 'owner');
	const tabs = $derived(
		allTabs.filter(
			(tab) => (!tab.platformAdmin || data.can.manageNodes) && (!tab.ownerOnly || isOwner)
		)
	);
	const current = $derived(
		tabs.find((tab) => tab.path === page.url.pathname)?.href ?? allTabs[0].href
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
		<Tabs.Root value={current} onValueChange={(value) => goto(resolve(value as Tab['href']))}>
			<Tabs.List
				variant="line"
				class="w-full justify-start border-b"
				aria-label="Settings sections"
			>
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
