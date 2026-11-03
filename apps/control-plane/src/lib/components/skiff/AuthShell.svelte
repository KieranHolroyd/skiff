<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from './Logo.svelte';

	let {
		eyebrow,
		title,
		description,
		children,
		footer
	}: {
		eyebrow?: string;
		title: string;
		description?: Snippet | string;
		children: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<div class="grid min-h-svh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
	<!-- Brand panel -->
	<aside
		class="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-10"
	>
		<div class="chart-grid pointer-events-none absolute inset-0 text-sidebar-foreground"></div>
		<svg
			class="pointer-events-none absolute -right-24 -bottom-24 size-[560px] text-sidebar-foreground/[0.07]"
			viewBox="0 0 400 400"
			fill="none"
			stroke="currentColor"
			aria-hidden="true"
		>
			{#each [40, 80, 120, 160, 200, 240] as r (r)}
				<circle cx="260" cy="260" {r} stroke-width="1" />
			{/each}
			<path d="M260 20v480M20 260h480" stroke-width="1" stroke-dasharray="3 6" />
		</svg>
		<div
			class="pointer-events-none absolute -top-40 -left-40 size-[420px] rounded-full bg-brand/20 blur-[120px]"
		></div>

		<Logo size="lg" class="relative" />

		<div class="relative max-w-md space-y-6">
			<p class="font-mono text-[11px] tracking-[0.14em] text-brand uppercase">
				Self-hosted private cloud
			</p>
			<p class="text-3xl leading-tight font-semibold tracking-[-0.025em] text-balance">
				Ask your agent to deploy a website — and it does.
			</p>
			<ul class="space-y-2.5 text-sm text-sidebar-muted">
				<li class="flex gap-3">
					<span class="mt-2 size-1 shrink-0 rounded-full bg-brand"></span>Instant subdomains, immutable
					preview URLs.
				</li>
				<li class="flex gap-3">
					<span class="mt-2 size-1 shrink-0 rounded-full bg-brand"></span>Zero-cost promote and rollback.
				</li>
				<li class="flex gap-3">
					<span class="mt-2 size-1 shrink-0 rounded-full bg-brand"></span>One control plane for the CLI,
					REST and MCP.
				</li>
			</ul>
		</div>

		<p class="relative font-mono text-[11px] text-sidebar-muted">Skiff control plane</p>
	</aside>

	<!-- Form side -->
	<main class="relative flex flex-col items-center justify-center px-5 py-12 sm:px-8">
		<div class="w-full max-w-[400px]">
			<Logo class="mb-10 lg:hidden" />
			<div class="mb-7 space-y-2">
				{#if eyebrow}<p class="eyebrow text-brand-soft-foreground">{eyebrow}</p>{/if}
				<h1 class="text-2xl font-semibold tracking-[-0.025em] text-balance">{title}</h1>
				{#if typeof description === 'string'}
					<p class="text-sm leading-relaxed text-muted-foreground">{description}</p>
				{:else if description}
					<div class="text-sm leading-relaxed text-muted-foreground">{@render description()}</div>
				{/if}
			</div>
			{@render children()}
			{#if footer}
				<div class="mt-8 border-t pt-5 text-xs text-muted-foreground">{@render footer()}</div>
			{/if}
		</div>
	</main>
</div>
