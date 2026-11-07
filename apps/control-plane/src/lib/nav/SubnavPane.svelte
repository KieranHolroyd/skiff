<script lang="ts">
	/* Hrefs come from subnav builders, which resolve every route they link to. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { mergeProps } from 'bits-ui';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { useSidebar } from '#lib/components/ui/sidebar/context.svelte.js';
	import type { Subnav } from './subnav.js';

	/** One area's sections, drawn in the dashboard sidebar in place of the main navigation. */
	let {
		nav,
		active,
		counts,
		backHref,
		select
	}: {
		nav: Subnav;
		active: string | null;
		/** Counts the page loads itself, over the builder's. */
		counts?: Record<string, number | undefined>;
		backHref: string;
		/** Returns `true` when the page switched in place, so the link should not navigate. */
		select?: (id: string) => boolean;
	} = $props();

	const sidebar = useSidebar();

	function onclick(event: MouseEvent, id: string) {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		if (sidebar.isMobile) sidebar.setOpenMobile(false);
		if (select?.(id)) event.preventDefault();
	}
</script>

<Sidebar.Group class="pb-1">
	<Sidebar.Menu>
		<Sidebar.MenuItem>
			<Sidebar.MenuButton tooltipContent={nav.back.label} class="text-muted-foreground">
				{#snippet child({ props })}
					<a href={backHref} data-skiff-target="subnav.back" {...props}>
						<ArrowLeftIcon />
						<span>{nav.back.label}</span>
					</a>
				{/snippet}
			</Sidebar.MenuButton>
		</Sidebar.MenuItem>
	</Sidebar.Menu>
	<div class="flex min-w-0 items-center gap-2 px-2 pt-3 pb-1 group-data-[collapsible=icon]:hidden">
		{#if nav.icon}
			<span
				class="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
				aria-hidden="true"
			>
				<nav.icon class="size-3.5" />
			</span>
		{/if}
		<p
			class="min-w-0 truncate text-base font-semibold tracking-tight {nav.mono
				? 'font-mono text-sm'
				: ''}"
			title={nav.title}
		>
			{nav.title}
		</p>
	</div>
</Sidebar.Group>

{#each nav.groups as group (group.id)}
	<Sidebar.Group>
		{#if group.label}
			<Sidebar.GroupLabel class="gap-1.5">
				{group.label}
				{#if group.note}
					<span class="truncate font-normal opacity-70">· {group.note}</span>
				{/if}
			</Sidebar.GroupLabel>
		{/if}
		<Sidebar.Menu>
			{#each group.items as item (item.id)}
				{@const current = active === item.id}
				{@const count = counts?.[item.id] ?? item.count}
				<Sidebar.MenuItem>
					<Sidebar.MenuButton
						isActive={current}
						tooltipContent={item.label}
						class="data-active:[&_svg]:text-brand"
					>
						{#snippet child({ props })}
							<a
								href={item.href}
								aria-current={current ? 'page' : undefined}
								data-skiff-target={item.target ??
									(nav.target ? `${nav.target}.${item.id}` : undefined)}
								{...mergeProps(props, {
									// Merged, not overridden: the tooltip trigger has its own click handler.
									onclick: (event: MouseEvent) => onclick(event, item.id)
								})}
							>
								<item.icon />
								<span class="truncate">{item.label}</span>
								{#if item.live || item.hint || count}
									<span
										class="ml-auto flex shrink-0 items-center overflow-visible! pl-1 group-data-[collapsible=icon]:hidden"
									>
										{#if item.live}
											<span class="relative flex size-1.5" title={item.live}>
												<span
													class="absolute size-full animate-ping rounded-full bg-warning opacity-60"
												></span>
												<span class="relative size-1.5 rounded-full bg-warning"></span>
												<span class="sr-only">{item.live}</span>
											</span>
										{:else if item.hint}
											<item.hint.component {...item.hint.props} />
										{:else}
											<span class="text-xs font-normal text-muted-foreground tabular-nums"
												>{count}</span
											>
										{/if}
									</span>
								{/if}
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			{/each}
		</Sidebar.Menu>
	</Sidebar.Group>
{/each}

{#if nav.footer}
	<Sidebar.Group class="mt-auto group-data-[collapsible=icon]:hidden">
		<nav.footer.component {...nav.footer.props} />
	</Sidebar.Group>
{/if}
