<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import InboxIcon from '@lucide/svelte/icons/inbox';

	let {
		title,
		description,
		icon: Icon = InboxIcon,
		compact = false,
		children
	}: {
		title: string;
		description?: string;
		icon?: Component<{ class?: string }>;
		compact?: boolean;
		children?: Snippet;
	} = $props();
</script>

<div
	class="relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed bg-muted/20 px-6 text-center {compact
		? 'py-7'
		: 'py-12'}"
>
	<div
		class="chart-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)] text-foreground"
	></div>
	<span
		class="relative grid size-10 place-items-center rounded-xl border bg-card text-muted-foreground shadow-card"
	>
		<span aria-hidden="true"><Icon class="size-[18px]" /></span>
	</span>
	<div class="relative space-y-1">
		<p class="text-sm font-semibold">{title}</p>
		{#if description}
			<p class="mx-auto max-w-sm text-[13px] leading-relaxed text-pretty text-muted-foreground">
				{description}
			</p>
		{/if}
	</div>
	{#if children}
		<div class="relative mt-1 flex flex-wrap items-center justify-center gap-2">
			{@render children()}
		</div>
	{/if}
</div>
