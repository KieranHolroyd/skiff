<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { browser } from '$app/env';
	import { QueryClientProvider, createQuery } from '@tanstack/svelte-query';
	import BellIcon from '@lucide/svelte/icons/bell';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import MailIcon from '@lucide/svelte/icons/mail';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import AssistantLauncher from '#lib/assistant/AssistantLauncher.svelte';
	import AssistantTour from '#lib/assistant/AssistantTour.svelte';
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
	import { createDashboardQueryClient } from '#lib/query.js';
	import type { LayoutProps } from './$types';
	import { getOverview, keys as alertKeys } from './alerts/_lib/api.js';
	import { pane as slidePane } from '#lib/nav/pane-transition.js';
	import { provideSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import SubnavPane from '#lib/nav/SubnavPane.svelte';
	import { subnavFor } from './_lib/subnav.js';

	let { data, children }: LayoutProps = $props();

	/** Client-side reads (tails, polled status, lazily loaded files); see `#lib/query`. */
	const queryClient = createDashboardQueryClient();

	/** Firing alerts for the sidebar badge; shares the Alerts page's cached overview. */
	const alertsOverview = createQuery(
		() => ({
			queryKey: alertKeys.overview,
			queryFn: ({ signal }) => getOverview(signal),
			enabled: browser && data.permissions.includes('metrics:read'),
			refetchInterval: 60_000,
			retry: false
		}),
		() => queryClient
	);
	const firing = $derived(alertsOverview.data?.counts.firing ?? 0);

	type NavItem = {
		label: string;
		href:
			| '/(dashboard)/overview'
			| '/(dashboard)/topology'
			| '/(dashboard)/dashboards'
			| '/(dashboard)/alerts'
			| '/(dashboard)/projects'
			| '/(dashboard)/functions'
			| '/(dashboard)/databases'
			| '/(dashboard)/storage'
			| '/(dashboard)/brokers'
			| '/(dashboard)/events'
			| '/(dashboard)/email'
			| '/(dashboard)/shares'
			| '/(dashboard)/deployments'
			| '/(dashboard)/nodes'
			| '/(dashboard)/audit'
			| '/(dashboard)/settings'
			| '/(dashboard)/docs';
		path: string;
		icon: typeof LayoutDashboardIcon;
		/** Hidden unless this layout feature is on. */
		feature?: keyof LayoutProps['data']['features'];
	};

	/** Sidebar groups; the first is unlabelled so Overview sits on its own at the top. */
	const groups: Array<{ label?: string; items: NavItem[] }> = [
		{
			items: [
				{
					label: 'Overview',
					href: '/(dashboard)/overview',
					path: '/overview',
					icon: LayoutDashboardIcon
				}
			]
		},
		{
			label: 'Workloads',
			items: [
				{
					label: 'Projects',
					href: '/(dashboard)/projects',
					path: '/projects',
					icon: FolderKanbanIcon
				},
				{
					label: 'Functions',
					href: '/(dashboard)/functions',
					path: '/functions',
					icon: ZapIcon,
					feature: 'functions'
				},
				{
					label: 'Databases',
					href: '/(dashboard)/databases',
					path: '/databases',
					icon: DatabaseIcon
				},
				{
					label: 'Storage',
					href: '/(dashboard)/storage',
					path: '/storage',
					icon: CylinderIcon
				},
				{
					label: 'Queues',
					href: '/(dashboard)/brokers',
					path: '/brokers',
					icon: InboxIcon,
					feature: 'brokers'
				},
				{
					label: 'Events',
					href: '/(dashboard)/events',
					path: '/events',
					icon: WebhookIcon,
					feature: 'brokers'
				},
				{
					label: 'Email',
					href: '/(dashboard)/email',
					path: '/email',
					icon: MailIcon,
					feature: 'email'
				},
				{
					// NFS/SMB mounts, not a project's share links (those live on each project).
					label: 'Network shares',
					href: '/(dashboard)/shares',
					path: '/shares',
					icon: HardDriveIcon
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
			label: 'Observe',
			items: [
				{
					label: 'Dashboards',
					href: '/(dashboard)/dashboards',
					path: '/dashboards',
					icon: ChartAreaIcon
				},
				{ label: 'Alerts', href: '/(dashboard)/alerts', path: '/alerts', icon: BellIcon }
			]
		},
		{
			label: 'Infrastructure',
			items: [
				{ label: 'Nodes', href: '/(dashboard)/nodes', path: '/nodes', icon: ServerIcon },
				{ label: 'Topology', href: '/(dashboard)/topology', path: '/topology', icon: NetworkIcon }
			]
		},
		{
			label: 'Admin',
			items: [
				{ label: 'Audit log', href: '/(dashboard)/audit', path: '/audit', icon: ScrollTextIcon },
				{ label: 'Settings', href: '/(dashboard)/settings', path: '/settings', icon: SettingsIcon }
			]
		},
		{
			label: 'Help',
			items: [{ label: 'Docs', href: '/(dashboard)/docs', path: '/docs', icon: BookOpenIcon }]
		}
	];
	const nav = groups.flatMap((group) => group.items);
	type CrumbRoute = NavItem['href'] | '/(dashboard)/new';

	let signingOut = $state(false);

	/**
	 * Inside an area (Settings, a project, a database…) the sidebar swaps the main navigation for
	 * that area's sections. Builders read route data only, so the server renders the same pane.
	 */
	const subnav = $derived(subnavFor(page.route.id, page.data, page.url));

	/** The owning page's in-place tab state and counts, while it is mounted. */
	const subnavLocal = provideSubnavLocal();
	const paneLocal = $derived(
		subnav && subnavLocal.current?.key === subnav.key ? subnavLocal.current : null
	);

	/**
	 * Which pane shows, and which way the swap slides: deeper areas push in from the right,
	 * shallower ones slide back. Read by the pane transitions as they start.
	 */
	const motion = { key: 'main', depth: 0, dir: 0 };
	const paneKey = $derived.by(() => {
		const key = subnav?.key ?? 'main';
		const depth = subnav?.depth ?? 0;
		if (key !== motion.key) {
			motion.dir = Math.sign(depth - motion.depth);
			motion.key = key;
			motion.depth = depth;
		}
		return key;
	});

	function isActive(item: NavItem): boolean {
		const current = page.url.pathname;
		if (item.path === '/projects' && (current === '/new' || current.startsWith('/new/')))
			return true;
		return current === item.path || current.startsWith(`${item.path}/`);
	}

	function visible(item: NavItem): boolean {
		return !item.feature || data.features[item.feature];
	}

	/** Path segments whose label is not just the capitalised segment. */
	const CRUMB_LABELS: Record<string, string> = {
		'api-keys': 'API keys',
		'connected-apps': 'Connected apps',
		usage: 'Usage & limits'
	};

	/** Breadcrumbs from the URL: `/projects/foo` → Projects › foo. */
	const crumbs = $derived.by(() => {
		const segments = page.url.pathname.split('/').filter(Boolean);
		// The "new" hub and its templates sit under Projects.
		if (segments[0] === 'new') {
			const projects = nav.find((item) => item.path === '/projects')!;
			const template = (page.data as { template?: { name?: string } }).template;
			return [
				{ label: projects.label, route: projects.href },
				...(segments.length > 1
					? [
							{ label: 'New', route: '/(dashboard)/new' as const },
							{ label: template?.name ?? decodeURIComponent(segments[1]!) }
						]
					: [{ label: 'New' }])
			] as { label: string; route?: CrumbRoute; mono?: boolean }[];
		}
		const top = nav.find((item) => item.path === `/${segments[0] ?? ''}`);
		const out: { label: string; route?: CrumbRoute; mono?: boolean }[] = [];
		if (top) out.push({ label: top.label, route: segments.length > 1 ? top.href : undefined });
		const isProject =
			top?.path === '/projects' ||
			top?.path === '/functions' ||
			top?.path === '/databases' ||
			top?.path === '/storage' ||
			top?.path === '/brokers';
		for (const [index, raw] of segments.slice(1).entries()) {
			const segment = decodeURIComponent(raw);
			// `/functions/new` is a page, not a function called "new".
			if (index === 0 && segment === 'new' && top?.path === '/functions') {
				out.push({ label: 'New' });
				continue;
			}
			out.push({
				label: isProject
					? segment
					: (CRUMB_LABELS[segment] ??
						segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ')),
				mono: isProject
			});
		}
		// A page whose URL carries an id (e.g. /dashboards/dsh_…) names its last crumb; `null`
		// (not found) shows the raw id instead of a capitalised one.
		const data = page.data as { crumbLabel?: string | null };
		if ('crumbLabel' in data && out.length > 1) {
			const raw = decodeURIComponent(segments.at(-1)!);
			out[out.length - 1] = data.crumbLabel
				? { label: data.crumbLabel }
				: { label: raw, mono: true };
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

		<Sidebar.Content class="relative overflow-hidden">
			{#key paneKey}
				<div
					class="absolute inset-0 no-scrollbar flex flex-col overflow-x-hidden overflow-y-auto bg-sidebar"
					in:slidePane={{ dir: motion.dir }}
					out:slidePane={{ dir: motion.dir }}
				>
					{#if subnav}
						<nav aria-label="{subnav.title} sections" class="contents">
							<SubnavPane
								nav={subnav}
								active={paneLocal?.active ?? subnav.active}
								counts={paneLocal?.counts}
								backHref={subnav.back.href}
								select={paneLocal?.select}
							/>
						</nav>
					{:else}
						{#each groups as group (group.label ?? '')}
							<Sidebar.Group>
								{#if group.label}
									<Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
								{/if}
								<Sidebar.Menu>
									{#each group.items.filter(visible) as item (item.label)}
										{@const active = isActive(item)}
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
														data-skiff-target={`nav.${item.path.slice(1)}`}
														{...props}
													>
														<item.icon />
														<span>{item.label}</span>
													</a>
												{/snippet}
											</Sidebar.MenuButton>
											{#if item.path === '/alerts' && firing > 0}
												<Sidebar.MenuBadge
													class="bg-destructive/10 text-destructive"
													title={`${firing} firing`}
												>
													{firing}<span class="sr-only"> firing alerts</span>
												</Sidebar.MenuBadge>
											{/if}
											{#if item.path === '/settings'}
												{#await data.updateAvailable then update}
													{#if update}
														<Sidebar.MenuBadge title={`Skiff ${update.latest} is available`}>
															<span class="size-2 rounded-full bg-brand"></span>
															<span class="sr-only">Update available</span>
														</Sidebar.MenuBadge>
													{/if}
												{/await}
											{/if}
										</Sidebar.MenuItem>
									{/each}
								</Sidebar.Menu>
							</Sidebar.Group>
						{/each}
					{/if}
				</div>
			{/key}
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
			<div class="ml-auto flex items-center gap-2">
				{#await data.updateAvailable then update}
					{#if update}
						<Badge
							href={resolve('/(dashboard)/settings/updates')}
							variant="brand"
							title={`Running ${update.current}. Open Settings › Updates to install ${update.latest}.`}
						>
							<CircleArrowUpIcon />
							<span>Update available</span>
							<span class="hidden font-mono sm:inline">{update.latest}</span>
						</Badge>
					{/if}
				{/await}
				<Badge
					variant="outline"
					class="hidden font-mono font-normal text-muted-foreground sm:inline-flex"
					title="Content domain for deployed sites"
				>
					<GlobeIcon />*.{data.contentDomain}
				</Badge>
			</div>
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
			<QueryClientProvider client={queryClient}>
				{@render children()}
			</QueryClientProvider>
		</main>

		<footer class="px-4 py-5 text-xs text-muted-foreground md:px-8">
			<div class="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-2">
				<span>Skiff control plane</span>
				<span class="font-mono">{data.platform.origin}</span>
			</div>
		</footer>
	</Sidebar.Inset>

	{#if data.assistant.enabled}
		<AssistantLauncher status={data.assistant} userId={data.user.id} />
		<AssistantTour />
	{/if}
</Sidebar.Provider>
