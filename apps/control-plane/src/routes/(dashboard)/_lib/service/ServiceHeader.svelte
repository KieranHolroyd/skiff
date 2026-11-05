<script lang="ts">
	/*
	 * Section links are built by the caller from resolved routes plus a `?tab=`; the resolver rule
	 * cannot follow that, so link checks are off for this navigation only.
	 */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import type { Component, Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import type { ServiceSection } from './sections.js';

	/**
	 * The shared top of every managed-service page (database, storage): back link, identity,
	 * one line of facts, actions, and the section tabs. Sub-routes (logs, objects) render the same
	 * header so they read as sections of one resource rather than separate pages.
	 */
	let {
		icon: Icon,
		backHref,
		backLabel,
		title,
		target,
		sections,
		active,
		onselect,
		meta,
		children
	}: {
		icon: Component<{ class?: string }>;
		backHref: string;
		backLabel: string;
		title: string;
		target?: string;
		sections: ServiceSection[];
		active: string;
		/** In-page switch for `local` sections; omitted on sub-routes, where every tab navigates. */
		onselect?: (id: string) => void;
		meta?: Snippet;
		children?: Snippet;
	} = $props();

	function select(id: string) {
		const section = sections.find((item) => item.id === id);
		if (!section || id === active) return;
		if (section.local && onselect) onselect(id);
		else void goto(section.href);
	}
</script>

<div class="space-y-4">
	<header data-skiff-target={target} class="space-y-3">
		<a
			href={backHref}
			class="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronLeftIcon class="size-4" />
			{backLabel}
		</a>
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
			<div class="flex min-w-0 items-start gap-3">
				<span
					class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-muted-foreground"
					aria-hidden="true"
				>
					<Icon class="size-5" />
				</span>
				<div class="min-w-0 space-y-1">
					<h1 class="truncate font-mono text-2xl font-semibold tracking-tight">{title}</h1>
					{#if meta}
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
							{@render meta()}
						</div>
					{/if}
				</div>
			</div>
			{#if children}
				<div class="flex shrink-0 flex-wrap items-center gap-2">{@render children()}</div>
			{/if}
		</div>
	</header>

	<Tabs.Root value={active} onValueChange={select}>
		<Tabs.List
			variant="line"
			class="w-full [scrollbar-width:none] justify-start overflow-x-auto border-b"
			aria-label="{title} sections"
		>
			{#each sections as section (section.id)}
				<Tabs.Trigger
					value={section.id}
					class="flex-none"
					data-skiff-target="service.tab.{section.id}"
				>
					<section.icon />
					{section.label}
					{#if section.count !== undefined}
						<span class="font-mono text-xs text-muted-foreground tabular-nums">{section.count}</span
						>
					{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>
</div>
