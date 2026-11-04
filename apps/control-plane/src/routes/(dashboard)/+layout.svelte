<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { authClient } from '#lib/auth-client.js';
	import Logo from '#lib/components/skiff/Logo.svelte';
	import ThemeToggle from '#lib/components/skiff/ThemeToggle.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	type NavItem = {
		label: string;
		href:
			| '/(dashboard)/overview'
			| '/(dashboard)/projects'
			| '/(dashboard)/deployments'
			| '/(dashboard)/nodes'
			| '/(dashboard)/audit'
			| '/(dashboard)/settings';
		path: string;
		icon: typeof LayoutDashboardIcon;
	};

	const groups: Array<{ label: string; items: NavItem[] }> = [
		{
			label: 'Operate',
			items: [
				{
					label: 'Overview',
					href: '/(dashboard)/overview',
					path: '/overview',
					icon: LayoutDashboardIcon
				},
				{
					label: 'Projects',
					href: '/(dashboard)/projects',
					path: '/projects',
					icon: FolderKanbanIcon
				},
				{
					label: 'Deployments',
					href: '/(dashboard)/deployments',
					path: '/deployments',
					icon: RocketIcon
				}
			]
		},
		{
			label: 'Platform',
			items: [
				{ label: 'Nodes', href: '/(dashboard)/nodes', path: '/nodes', icon: ServerIcon },
				{ label: 'Audit log', href: '/(dashboard)/audit', path: '/audit', icon: ScrollTextIcon },
				{ label: 'Settings', href: '/(dashboard)/settings', path: '/settings', icon: SettingsIcon }
			]
		}
	];
	const nav = groups.flatMap((group) => group.items);

	let signingOut = $state(false);

	function isActive(path: string): boolean {
		const current = page.url.pathname;
		return current === path || current.startsWith(`${path}/`);
	}

	/** Breadcrumbs from the URL: `/projects/foo` → Projects › foo. */
	const crumbs = $derived.by(() => {
		const segments = page.url.pathname.split('/').filter(Boolean);
		const top = nav.find((item) => item.path === `/${segments[0] ?? ''}`);
		const out: { label: string; route?: NavItem['href']; mono?: boolean }[] = [];
		if (top) out.push({ label: top.label, route: segments.length > 1 ? top.href : undefined });
		const isProject = top?.path === '/projects';
		for (const raw of segments.slice(1)) {
			const segment = decodeURIComponent(raw);
			out.push({
				label: isProject ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
				mono: isProject
			});
		}
		return out;
	});

	const initials = $derived(
		data.user.name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('') || 'SK'
	);

	async function signOut() {
		signingOut = true;
		try {
			await authClient.signOut();
		} finally {
			await goto(resolve('/login'));
		}
	}
</script>

<svelte:head>
	<title>Skiff · Operations</title>
	<meta
		name="description"
		content="Skiff operations dashboard: projects, deployments, nodes and audit."
	/>
</svelte:head>

<Sidebar.Provider open={data.sidebarOpen}>
	<Sidebar.Root collapsible="icon" variant="inset">
		<Sidebar.Header>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton size="lg" tooltipContent="Overview">
						{#snippet child({ props })}
							<a href={resolve('/(dashboard)/overview')} {...props}>
								<Logo wordmark={false} class="shrink-0" />
								<span class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">Skiff</span>
									<span class="truncate text-xs text-muted-foreground">{data.org.name}</span>
								</span>
								<Badge variant="outline" class="capitalize">{data.role}</Badge>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Header>

		<Sidebar.Content>
			{#each groups as group (group.label)}
				<Sidebar.Group>
					<Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
					<Sidebar.Menu>
						{#each group.items as item (item.href)}
							{@const active = isActive(item.path)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									isActive={active}
									tooltipContent={item.label}
									class="data-active:[&_svg]:text-brand"
								>
									{#snippet child({ props })}
										<a
											href={resolve(item.href)}
											aria-current={active ? 'page' : undefined}
											{...props}
										>
											<item.icon />
											<span>{item.label}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.Group>
			{/each}
		</Sidebar.Content>

		<Sidebar.Footer>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Sidebar.MenuButton
									size="lg"
									class="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
									{...props}
								>
									<Avatar.Root class="size-8 rounded-lg after:rounded-lg">
										<Avatar.Fallback class="rounded-lg text-xs font-medium"
											>{initials}</Avatar.Fallback
										>
									</Avatar.Root>
									<span class="grid flex-1 text-left text-sm leading-tight">
										<span class="truncate font-medium">{data.user.name}</span>
										<span class="truncate text-xs text-muted-foreground"
											>{data.user.email ?? data.org.name}</span
										>
									</span>
									<ChevronsUpDownIcon class="ml-auto size-4" />
								</Sidebar.MenuButton>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content side="top" align="start" class="w-60">
							<DropdownMenu.Label class="font-normal">
								<p class="truncate text-sm font-medium text-foreground">{data.user.name}</p>
								<p class="truncate text-xs text-muted-foreground">{data.user.email ?? ''}</p>
							</DropdownMenu.Label>
							<DropdownMenu.Separator />
							<DropdownMenu.Item onSelect={() => goto(resolve('/(dashboard)/settings/account'))}>
								<UserRoundIcon />
								Account settings
							</DropdownMenu.Item>
							<DropdownMenu.Item onSelect={() => goto(resolve('/(dashboard)/settings'))}>
								<SettingsIcon />
								Organisation
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<div class="flex items-center justify-between gap-2 px-2 py-1">
								<span class="text-sm text-muted-foreground">Theme</span>
								<ThemeToggle />
							</div>
							<DropdownMenu.Separator />
							<DropdownMenu.Item disabled={signingOut} onSelect={signOut}>
								<LogOutIcon />
								{signingOut ? 'Signing out…' : 'Sign out'}
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Footer>
		<Sidebar.Rail />
	</Sidebar.Root>

	<Sidebar.Inset class="min-w-0">
		<header
			class="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:rounded-t-xl md:px-6"
		>
			<Sidebar.Trigger class="-ml-1" />
			<Separator orientation="vertical" class="mr-1 data-[orientation=vertical]:h-4" />
			<Breadcrumb.Root>
				<Breadcrumb.List>
					<Breadcrumb.Item class="hidden md:inline-flex">{data.org.name}</Breadcrumb.Item>
					{#each crumbs as crumb, i (i)}
						<Breadcrumb.Separator class={i === 0 ? 'hidden md:block' : ''} />
						<Breadcrumb.Item>
							{#if crumb.route}
								<Breadcrumb.Link href={resolve(crumb.route)}>{crumb.label}</Breadcrumb.Link>
							{:else}
								<Breadcrumb.Page class={crumb.mono ? 'font-mono' : ''}
									>{crumb.label}</Breadcrumb.Page
								>
							{/if}
						</Breadcrumb.Item>
					{/each}
				</Breadcrumb.List>
			</Breadcrumb.Root>
			<Badge
				variant="outline"
				class="ml-auto hidden font-mono font-normal text-muted-foreground sm:inline-flex"
				title="Content domain for deployed sites"
			>
				<GlobeIcon />*.{data.contentDomain}
			</Badge>
		</header>

		{#if data.sharedDomain}
			<div class="px-4 pt-6 md:px-8">
				<Alert.Root variant="warning" class="mx-auto max-w-[1320px]">
					<ShieldAlertIcon />
					<Alert.Title>Shared-domain mode</Alert.Title>
					<Alert.Description>
						Deployed sites are served from <code class="font-mono">{data.contentDomain}</code>, the
						same domain as this dashboard. Move content to a separate domain before using this with
						untrusted sites (D19).
					</Alert.Description>
				</Alert.Root>
			</div>
		{/if}

		<main class="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 md:px-8 md:py-8">
			{@render children()}
		</main>

		<footer class="px-4 py-5 text-xs text-muted-foreground md:px-8">
			<div class="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-2">
				<span>Skiff control plane</span>
				<span class="font-mono">{data.platform.origin}</span>
			</div>
		</footer>
	</Sidebar.Inset>
</Sidebar.Provider>
