<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { authClient } from '#lib/auth-client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const nav = [
		{
			label: 'Overview',
			href: '/(dashboard)/overview',
			path: '/overview',
			icon: LayoutDashboardIcon
		},
		{ label: 'Projects', href: '/(dashboard)/projects', path: '/projects', icon: FolderKanbanIcon },
		{
			label: 'Deployments',
			href: '/(dashboard)/deployments',
			path: '/deployments',
			icon: RocketIcon
		},
		{ label: 'Audit', href: '/(dashboard)/audit', path: '/audit', icon: ScrollTextIcon },
		{ label: 'Nodes', href: '/(dashboard)/nodes', path: '/nodes', icon: ServerIcon },
		{ label: 'Settings', href: '/(dashboard)/settings', path: '/settings', icon: SettingsIcon }
	] as const;

	let signingOut = $state(false);

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		return path === href || path.startsWith(`${href}/`);
	}

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
	<!-- Desktop sidebar -->
	<aside class="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-sidebar md:flex">
		<div class="flex h-14 items-center border-b px-4">
			<a
				href={resolve('/(dashboard)/overview')}
				class="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
			>
				<span
					class="grid size-7 place-items-center rounded-[7px] bg-primary text-primary-foreground shadow-xs"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.9"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="size-4"
						aria-hidden="true"
					>
						<path d="M12 3.5v8.5" />
						<path d="M12 4.5 6.5 12H12" />
						<path d="M3.5 15.5h17l-2.5 4h-12l-2.5-4Z" />
					</svg>
				</span>
				<span class="text-[15px] font-semibold tracking-[-0.02em]">Skiff</span>
				<span
					class="ml-auto rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
					>Ops</span
				>
			</a>
		</div>

		<nav class="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Primary">
			<p
				class="px-2.5 pt-1 pb-2 text-[10px] font-medium tracking-widest text-muted-foreground uppercase"
			>
				Operate
			</p>
			{#each nav as item (item.href)}
				{@const Icon = item.icon}
				<a
					href={resolve(item.href)}
					aria-current={isActive(item.path) ? 'page' : undefined}
					class="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40 {isActive(
						item.path
					)
						? 'bg-sidebar-accent text-sidebar-accent-foreground'
						: 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'}"
				>
					<Icon class="size-4 shrink-0" aria-hidden="true" />
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="border-t p-3">
			<div class="mb-3 flex items-center gap-2.5 rounded-lg px-1 py-1">
				<span
					class="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
				>
					{initials}
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{data.org.name}</p>
					<p class="truncate text-xs text-muted-foreground">{data.user.email ?? data.user.name}</p>
				</div>
				<Badge variant="outline" class="capitalize">{data.role}</Badge>
			</div>
			<div
				class="flex items-center justify-between gap-2 rounded-lg border bg-background/60 px-2.5 py-2"
			>
				<span class="text-xs text-muted-foreground">{data.platform.hostname}</span>
				<Button
					variant="ghost"
					size="xs"
					disabled={signingOut}
					onclick={signOut}
					aria-label="Sign out"
				>
					<LogOutIcon class="size-3.5" aria-hidden="true" />
					{signingOut ? 'Signing out…' : 'Sign out'}
				</Button>
			</div>
		</div>
	</aside>

	<div class="flex min-h-svh flex-col md:pl-64">
		<!-- Mobile top bar -->
		<header class="sticky top-0 z-20 border-b bg-background/90 backdrop-blur md:hidden">
			<div class="flex h-14 items-center justify-between gap-3 px-4">
				<a href={resolve('/(dashboard)/overview')} class="flex items-center gap-2">
					<span
						class="grid size-7 place-items-center rounded-[7px] bg-primary text-primary-foreground"
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.9"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="size-4"
							aria-hidden="true"
						>
							<path d="M12 3.5v8.5" />
							<path d="M12 4.5 6.5 12H12" />
							<path d="M3.5 15.5h17l-2.5 4h-12l-2.5-4Z" />
						</svg>
					</span>
					<span class="text-[15px] font-semibold tracking-[-0.02em]">Skiff</span>
				</a>
				<div class="flex items-center gap-2">
					<Badge variant="outline" class="capitalize">{data.role}</Badge>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={signingOut}
						onclick={signOut}
						aria-label="Sign out"
					>
						<LogOutIcon class="size-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
			<nav
				class="flex [scrollbar-width:none] gap-1 overflow-x-auto px-2 pb-2 [&::-webkit-scrollbar]:hidden"
				aria-label="Primary"
			>
				{#each nav as item (item.href)}
					{@const Icon = item.icon}
					<a
						href={resolve(item.href)}
						aria-current={isActive(item.path) ? 'page' : undefined}
						class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap {isActive(
							item.path
						)
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
					>
						<Icon class="size-3.5" aria-hidden="true" />
						{item.label}
					</a>
				{/each}
			</nav>
		</header>

		{#if data.sharedDomain}
			<div
				class="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-amber-950 md:px-8 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
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

		<main class="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
			{@render children()}
		</main>

		<footer class="border-t px-4 py-4 text-[11px] text-muted-foreground md:px-8">
			<div class="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
				<span>Skiff control plane · {data.org.name}</span>
				<span class="font-mono">{data.platform.origin}</span>
			</div>
		</footer>
	</div>
</div>
