<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	/**
	 * The shared top of every managed-service page (database, storage, queue, function,
	 * deployment): identity, one line of facts and actions. Sections live in the sidebar, which
	 * swaps to the resource's own navigation (see `#lib/nav/subnav`).
	 */
	let {
		icon: Icon,
		title,
		target,
		meta,
		children
	}: {
		icon: Component<{ class?: string }>;
		title: string;
		target?: string;
		meta?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<header data-skiff-target={target}>
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
