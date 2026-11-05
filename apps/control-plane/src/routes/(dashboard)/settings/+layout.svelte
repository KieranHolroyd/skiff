<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import UsersIcon from '@lucide/svelte/icons/users';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { Permission } from '@skiff/contracts';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import PageHeader from '../_lib/PageHeader.svelte';

	let { data, children } = $props();

	type Tab = {
		label: string;
		href:
			| '/(dashboard)/settings'
			| '/(dashboard)/settings/account'
			| '/(dashboard)/settings/members'
			| '/(dashboard)/settings/backups'
			| '/(dashboard)/settings/backup-targets'
			| '/(dashboard)/settings/usage'
			| '/(dashboard)/settings/notifications'
			| '/(dashboard)/settings/assistant'
			| '/(dashboard)/settings/maintenance'
			| '/(dashboard)/settings/updates';
		path: string;
		icon: typeof Building2Icon;
		platformAdmin?: boolean;
		/** Needs this org permission. */
		permission?: Permission;
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
			label: 'Members',
			href: '/(dashboard)/settings/members',
			path: '/settings/members',
			icon: UsersIcon
		},
		{
			label: 'Backups',
			href: '/(dashboard)/settings/backups',
			path: '/settings/backups',
			icon: DatabaseBackupIcon,
			ownerOnly: true
		},
		{
			label: 'Backup targets',
			href: '/(dashboard)/settings/backup-targets',
			path: '/settings/backup-targets',
			icon: DatabaseBackupIcon,
			permission: 'database:read'
		},
		{
			label: 'Usage',
			href: '/(dashboard)/settings/usage',
			path: '/settings/usage',
			icon: ChartColumnIcon,
			permission: 'project:read'
		},
		{
			label: 'Notifications',
			href: '/(dashboard)/settings/notifications',
			path: '/settings/notifications',
			icon: BellRingIcon,
			ownerOnly: true
		},
		{
			label: 'Assistant',
			href: '/(dashboard)/settings/assistant',
			path: '/settings/assistant',
			icon: SparklesIcon,
			ownerOnly: true
		},
		{
			label: 'Maintenance',
			href: '/(dashboard)/settings/maintenance',
			path: '/settings/maintenance',
			icon: WrenchIcon,
			permission: 'project:read'
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
			(tab) =>
				(!tab.platformAdmin || data.can.manageNodes) &&
				(!tab.ownerOnly || isOwner) &&
				(!tab.permission || data.permissions.includes(tab.permission))
		)
	);
	// Nested pages (an operation under Maintenance) keep their section's tab selected.
	const current = $derived(
		tabs.find(
			(tab) =>
				tab.path === page.url.pathname ||
				(tab.path !== '/settings' && page.url.pathname.startsWith(`${tab.path}/`))
		)?.href ?? allTabs[0].href
	);
</script>

<div class="space-y-6">
	<div class="space-y-4">
		<PageHeader
			target="page.settings"
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
					<Tabs.Trigger
						value={tab.href}
						class="flex-none"
						data-skiff-target={`settings.tab.${tab.path.split('/').pop() || 'organisation'}`}
					>
						<tab.icon />
						{tab.label}
						{#if tab.path === '/settings/updates'}
							{#await data.updateAvailable then update}
								{#if update}
									<span
										class="size-1.5 rounded-full bg-brand"
										title={`Skiff ${update.latest} is available`}
									></span>
									<span class="sr-only">(update available)</span>
								{/if}
							{/await}
						{/if}
					</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>
	</div>

	{@render children()}
</div>
