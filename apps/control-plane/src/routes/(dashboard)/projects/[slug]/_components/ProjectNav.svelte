<script lang="ts">
	/*
	 * Section links reuse the current resolved URL with a different `?tab=`; the resolver rule
	 * cannot evaluate that expression, so link checks are off for this navigation only.
	 */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import { page } from '$app/state';
	import ChartNoAxesCombinedIcon from '@lucide/svelte/icons/chart-no-axes-combined';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import LinkIcon from '@lucide/svelte/icons/link-2';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import type { ProjectTab } from './project-nav.js';

	type NavItem = {
		id: ProjectTab;
		label: string;
		icon: typeof ChartNoAxesCombinedIcon;
		/** Section size, shown as a quiet mono counter. */
		count?: number;
		/** Mark the section while work is in flight (active builds). */
		live?: boolean;
	};

	let {
		variant,
		tab,
		counts = {},
		runningBuilds = 0,
		onselect
	}: {
		/** `rail` is the sticky desktop column; `bar` is the narrow-screen pill row. */
		variant: 'rail' | 'bar';
		tab: ProjectTab;
		counts?: Partial<Record<ProjectTab, number>>;
		runningBuilds?: number;
		onselect: (tab: ProjectTab) => void;
	} = $props();

	const groups: Array<{ label: string; items: NavItem[] }> = $derived([
		{
			label: 'Monitor',
			items: [
				{ id: 'traffic', label: 'Traffic', icon: ChartNoAxesCombinedIcon },
				{ id: 'logs', label: 'Logs', icon: ScrollTextIcon, live: runningBuilds > 0 }
			]
		},
		{
			label: 'Ship',
			items: [
				{ id: 'deployments', label: 'Deployments', icon: RocketIcon, count: counts.deployments },
				{ id: 'environments', label: 'Environments', icon: LayersIcon, count: counts.environments },
				{
					id: 'builds',
					label: 'Builds',
					icon: GitBranchIcon,
					count: counts.builds,
					live: runningBuilds > 0
				},
				{ id: 'source', label: 'Source', icon: FolderTreeIcon }
			]
		},
		{
			label: 'Configure',
			items: [
				{ id: 'domains', label: 'Domains', icon: GlobeIcon, count: counts.domains },
				{ id: 'runtime', label: 'Runtime', icon: CpuIcon },
				{ id: 'shares', label: 'Share links', icon: LinkIcon, count: counts.shares },
				{ id: 'settings', label: 'Settings', icon: KeyRoundIcon }
			]
		}
	]);

	let strip = $state<HTMLElement | null>(null);

	/** Keep the active pill visible in the mobile scroller. */
	$effect(() => {
		const current = tab;
		if (!strip || !current) return;
		const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
		active?.scrollIntoView({ block: 'nearest', inline: 'center' });
	});

	function href(id: ProjectTab): string {
		const url = new URL(page.url.href);
		url.searchParams.set('tab', id);
		return `${url.pathname}${url.search}`;
	}

	/** Real links (copyable, middle-clickable) with client-side switching. */
	function select(event: MouseEvent, id: ProjectTab) {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		if (id !== tab) onselect(id);
	}
</script>

<!-- Desktop: a sticky section rail beside the section content. -->
{#if variant === 'rail'}
	<nav class="hidden xl:block" aria-label="Project sections">
		<div class="sticky top-[4.5rem] space-y-6">
			{#each groups as group (group.label)}
				<div>
					<p class="eyebrow mb-2 px-2.5">{group.label}</p>
					<ul class="space-y-0.5">
						{#each group.items as item (item.id)}
							{@const active = tab === item.id}
							<li>
								<a
									href={href(item.id)}
									onclick={(event) => select(event, item.id)}
									aria-current={active ? 'page' : undefined}
									class="group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors {active
										? 'bg-brand-soft/55 text-foreground'
										: 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}"
								>
									{#if active}
										<span
											class="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-brand"
											aria-hidden="true"
										></span>
									{/if}
									<item.icon
										class="size-4 shrink-0 {active
											? 'text-brand-soft-foreground'
											: 'text-muted-foreground/75 group-hover:text-foreground'}"
									/>
									<span class="truncate">{item.label}</span>
									{#if item.live}
										<span class="relative ml-auto flex size-1.5 shrink-0">
											<span
												class="absolute size-full animate-ping rounded-full bg-warning opacity-60"
											></span>
											<span class="relative size-1.5 rounded-full bg-warning"></span>
											<span class="sr-only">Build in progress</span>
										</span>
									{:else if item.count !== undefined}
										<span
											class="ml-auto font-mono text-[10px] tabular-nums {active
												? 'text-brand-soft-foreground'
												: 'text-muted-foreground/60'}">{item.count}</span
										>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	</nav>
{:else}
	<!-- Narrow screens: one scrollable row, groups divided by rules. -->
	<div
		class="sticky top-12 z-10 -mx-4 border-b bg-background/90 backdrop-blur-md md:-mx-8 xl:hidden"
	>
		<nav
			bind:this={strip}
			class="flex [scrollbar-width:none] items-center gap-1 overflow-x-auto px-4 py-2 md:px-8"
			aria-label="Project sections"
		>
			{#each groups as group, index (group.label)}
				{#if index > 0}
					<span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
				{/if}
				{#each group.items as item (item.id)}
					{@const active = tab === item.id}
					<a
						href={href(item.id)}
						onclick={(event) => select(event, item.id)}
						aria-current={active ? 'page' : undefined}
						class="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors {active
							? 'bg-brand-soft text-brand-soft-foreground'
							: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
					>
						<item.icon class="size-3.5 shrink-0" />
						{item.label}
						{#if item.live}
							<span class="size-1.5 rounded-full bg-warning">
								<span class="sr-only">Build in progress</span>
							</span>
						{:else if item.count !== undefined}
							<span class="font-mono text-[10px] tabular-nums opacity-70">{item.count}</span>
						{/if}
					</a>
				{/each}
			{/each}
		</nav>
	</div>
{/if}
