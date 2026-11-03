<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { authClient } from '#lib/auth-client.js';
	import Logo from '#lib/components/skiff/Logo.svelte';
	import ThemeToggle from '#lib/components/skiff/ThemeToggle.svelte';
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
				{ label: 'Overview', href: '/(dashboard)/overview', path: '/overview', icon: LayoutDashboardIcon },
				{ label: 'Projects', href: '/(dashboard)/projects', path: '/projects', icon: FolderKanbanIcon },
				{ label: 'Deployments', href: '/(dashboard)/deployments', path: '/deployments', icon: RocketIcon }
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
	const nav: NavItem[] = groups.flatMap((group) => group.items);

	let signingOut = $state(false);

	function isActive(path: string): boolean {
		const current = page.url.pathname;
		return current === path || current.startsWith(`${path}/`);
	}

	/** Breadcrumbs from the URL: `/projects/foo` → Projects › foo. */
	const crumbs = $derived.by(() => {
		const segments = page.url.pathname.split('/').filter(Boolean);
		const top = nav.find((item) => item.path === `/${segments[0] ?? ''}`);
		const out: { label: string; href?: string; mono?: boolean }[] = [];
		if (top) out.push({ label: top.label, href: segments.length > 1 ? resolve(top.href) : undefined });
		// Project slugs read best verbatim in mono; other sub-pages are title-cased words.
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

<div class="min-h-svh bg-background">
	<!-- Desktop sidebar: the "hull" -->
	<aside
		class="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-sidebar text-sidebar-foreground md:flex"
	>
		<div class="flex h-14 items-center px-4">
			<a
				href={resolve('/(dashboard)/overview')}
				class="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
			>
				<Logo />
			</a>
		</div>

		<div class="px-3 pb-2">
			<div
				class="flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-white/[0.03] px-2.5 py-2"
			>
				<span
					class="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent font-mono text-[10px] font-semibold text-sidebar-accent-foreground uppercase"
				>
					{data.org.name.slice(0, 2)}
				</span>
				<div class="min-w-0 flex-1 leading-tight">
					<p class="truncate text-[13px] font-medium">{data.org.name}</p>
					<p class="truncate text-[11px] text-sidebar-muted capitalize">{data.role}</p>
				</div>
			</div>
		</div>

		<nav class="flex-1 space-y-5 overflow-y-auto px-3 py-3" aria-label="Primary">
			{#each groups as group (group.label)}
				<div class="space-y-0.5">
					<p class="px-2.5 pb-1.5 font-mono text-[10px] tracking-[0.12em] text-sidebar-muted/80 uppercase">
						{group.label}
					</p>
					{#each group.items as item (item.href)}
						{@const Icon = item.icon}
						{@const active = isActive(item.path)}
						<a
							href={resolve(item.href)}
							aria-current={active ? 'page' : undefined}
							class="group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {active
								? 'bg-sidebar-accent text-sidebar-accent-foreground'
								: 'text-sidebar-muted hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'}"
						>
							{#if active}
								<span
									class="absolute top-1.5 bottom-1.5 -left-3 w-[3px] rounded-r-full bg-sidebar-primary"
									aria-hidden="true"
								></span>
							{/if}
							<Icon
								class="size-4 shrink-0 {active ? 'text-sidebar-primary' : ''}"
								aria-hidden="true"
							/>
							{item.label}
						</a>
					{/each}
				</div>
			{/each}
		</nav>

		<div class="space-y-3 border-t border-sidebar-border p-3">
			<div class="flex items-center gap-2.5 px-1">
				<span
					class="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-[oklch(0.55_0.17_25)] text-[11px] font-semibold text-brand-foreground"
				>
					{initials}
				</span>
				<div class="min-w-0 flex-1 leading-tight">
					<p class="truncate text-[13px] font-medium">{data.user.name}</p>
					<p class="truncate text-[11px] text-sidebar-muted">{data.user.email ?? data.org.name}</p>
				</div>
				<button
					type="button"
					class="grid size-7 shrink-0 place-items-center rounded-md text-sidebar-muted transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
					disabled={signingOut}
					onclick={signOut}
					aria-label="Sign out"
					title="Sign out"
				>
					<LogOutIcon class="size-3.5" aria-hidden="true" />
				</button>
			</div>
			<div class="flex items-center justify-between gap-2 px-1">
				<span class="truncate font-mono text-[10.5px] text-sidebar-muted" title={data.platform.origin}
					>{data.platform.hostname}</span
				>
				<ThemeToggle />
			</div>
		</div>
	</aside>

	<div class="flex min-h-svh flex-col md:pl-60">
		<!-- Mobile top bar -->
		<header class="sticky top-0 z-20 bg-sidebar text-sidebar-foreground md:hidden">
			<div class="flex h-14 items-center justify-between gap-3 px-4">
				<a href={resolve('/(dashboard)/overview')}><Logo /></a>
				<div class="flex items-center gap-2">
					<ThemeToggle />
					<button
						type="button"
						class="grid size-8 place-items-center rounded-md text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50"
						disabled={signingOut}
						onclick={signOut}
						aria-label="Sign out"
					>
						<LogOutIcon class="size-4" aria-hidden="true" />
					</button>
				</div>
			</div>
			<nav
				class="flex [scrollbar-width:none] gap-1 overflow-x-auto px-3 pb-2.5 [&::-webkit-scrollbar]:hidden"
				aria-label="Primary"
			>
				{#each nav as item (item.href)}
					{@const Icon = item.icon}
					{@const active = isActive(item.path)}
					<a
						href={resolve(item.href)}
						aria-current={active ? 'page' : undefined}
						class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap {active
							? 'bg-sidebar-accent text-sidebar-accent-foreground'
							: 'text-sidebar-muted hover:text-sidebar-foreground'}"
					>
						<Icon class="size-3.5 {active ? 'text-sidebar-primary' : ''}" aria-hidden="true" />
						{item.label}
					</a>
				{/each}
			</nav>
		</header>

		<!-- Desktop context bar -->
		<div
			class="sticky top-0 z-20 hidden h-12 items-center justify-between gap-4 border-b bg-background/85 px-8 backdrop-blur-md md:flex"
		>
			<nav aria-label="Breadcrumb">
				<ol class="flex items-center gap-1.5 text-[13px]">
					<li class="text-muted-foreground">{data.org.name}</li>
					{#each crumbs as crumb, i (i)}
						<li aria-hidden="true"><ChevronRightIcon class="size-3.5 text-muted-foreground/60" /></li>
						<li>
							{#if crumb.href}
								<a
									href={crumb.href}
									class="text-muted-foreground transition-colors hover:text-foreground">{crumb.label}</a
								>
							{:else}
								<span
									class="font-medium {crumb.mono ? 'font-mono text-[12.5px]' : ''}"
									aria-current="page">{crumb.label}</span
								>
							{/if}
						</li>
					{/each}
				</ol>
			</nav>
			<span
				class="flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
				title="Content domain for deployed sites"
			>
				<GlobeIcon class="size-3" aria-hidden="true" />
				*.{data.contentDomain}
			</span>
		</div>

		{#if data.sharedDomain}
			<div
				class="flex items-start gap-3 border-b border-warning/40 bg-warning-soft px-4 py-2.5 text-warning-soft-foreground md:px-8"
				role="status"
			>
				<ShieldAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-xs leading-5 md:text-[13px]">
					<span class="font-semibold">Shared-domain mode.</span>
					Deployed sites are served from <code class="font-mono">{data.contentDomain}</code>, the
					same domain as this dashboard. Treat deployed content as same-site and move content to a
					separate domain before using this with untrusted sites (D19).
				</p>
			</div>
		{/if}

		<main class="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 md:px-8 md:py-8">
			{@render children()}
		</main>

		<footer class="px-4 py-5 text-[11px] text-muted-foreground md:px-8">
			<div class="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-2">
				<span>Skiff control plane</span>
				<span class="font-mono">{data.platform.origin}</span>
			</div>
		</footer>
	</div>
</div>
