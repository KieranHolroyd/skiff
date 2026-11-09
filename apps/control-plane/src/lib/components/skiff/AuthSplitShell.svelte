<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Logo from './Logo.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	let {
		eyebrow,
		title,
		description,
		children,
		footer
	}: {
		eyebrow?: string;
		title: string;
		description?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const highlights = [
		{
			icon: RocketIcon,
			title: 'Deploy in one command',
			body: 'Static sites, containers, functions and databases, from the CLI or the dashboard.'
		},
		{
			icon: SparklesIcon,
			title: 'Agent-native by default',
			body: 'Your AI client drives the same audited API you do, with scoped permissions.'
		},
		{
			icon: ShieldCheckIcon,
			title: 'Yours to keep',
			body: 'Self-hosted on your own domain, with passkeys, SSO and backups included.'
		}
	];
</script>

<div class="relative min-h-svh bg-background lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
	<aside
		class="relative isolate hidden overflow-hidden bg-[#111725] text-white lg:flex lg:flex-col lg:p-12 xl:p-16"
	>
		<div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10">
			<div
				class="absolute -top-32 -left-24 size-[32rem] rounded-full bg-brand/20 blur-[120px]"
			></div>
			<div
				class="absolute -right-32 -bottom-40 size-[30rem] rounded-full bg-[#3b82f6]/10 blur-[110px]"
			></div>
			<div
				class="absolute inset-0 opacity-[0.055]"
				style="background-image: linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px); background-size: 56px 56px;"
			></div>
			<div
				class="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#0b0f19]/80 to-transparent"
			></div>
		</div>

		<div class="flex items-center justify-between">
			<Logo class="text-white" />
			<span
				class="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/50"
			>
				<span class="size-1.5 rounded-full bg-emerald-400"></span>
				Self-hosted
			</span>
		</div>

		<div class="my-auto max-w-[34rem] py-10">
			<p
				class="mb-5 inline-flex items-center gap-2 text-[11px] font-semibold tracking-[0.22em] text-brand uppercase"
			>
				<span class="h-px w-6 bg-brand/60"></span>
				Your own private cloud
			</p>
			<h2
				class="text-4xl leading-[1.08] font-semibold tracking-[-0.03em] text-balance xl:text-[2.75rem]"
			>
				Ship things on <span class="text-brand">your own</span> terms.
			</h2>
			<p class="mt-5 max-w-md text-[0.95rem] leading-relaxed text-white/55">
				Skiff is a small, self-hosted control plane for sites, databases and agents. One box, your
				domain, no per-seat pricing.
			</p>

			<ul class="mt-9 grid gap-4">
				{#each highlights as highlight (highlight.title)}
					<li class="flex items-start gap-3">
						<span
							class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.05] text-brand"
						>
							<highlight.icon class="size-4" aria-hidden="true" />
						</span>
						<div>
							<p class="text-sm font-medium text-white/90">{highlight.title}</p>
							<p class="mt-0.5 max-w-sm text-[0.8rem] leading-relaxed text-white/45">
								{highlight.body}
							</p>
						</div>
					</li>
				{/each}
			</ul>
		</div>

		<div class="w-full max-w-[27rem]" aria-hidden="true">
			<div
				class="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f19]/70 shadow-2xl shadow-black/40 backdrop-blur"
			>
				<div class="flex items-center gap-1.5 border-b border-white/[0.07] px-4 py-3">
					<span class="size-2 rounded-full bg-white/15"></span>
					<span class="size-2 rounded-full bg-white/15"></span>
					<span class="size-2 rounded-full bg-white/15"></span>
					<span class="ml-2 font-mono text-[10px] tracking-[0.16em] text-white/30 uppercase"
						>deploy</span
					>
					<span class="ml-auto font-mono text-[10px] text-white/30">skif</span>
				</div>
				<div class="space-y-2 px-4 py-4 font-mono text-[11.5px] leading-relaxed">
					<p class="text-white/85"><span class="text-brand">$</span> skif deploy ./dist</p>
					<p class="text-white/35">uploaded 42 files · 1.2 MB</p>
					<p class="text-white/35">
						preview <span class="text-white/65">launch-page--a1b2c3.example.com</span>
					</p>
					<p class="text-emerald-400">✓ live in 1.8s</p>
				</div>
			</div>
			<p class="mt-4 flex items-center gap-1.5 text-[11px] text-white/30">
				<ArrowRightIcon class="size-3" aria-hidden="true" />
				The same API your agents use.
			</p>
		</div>
	</aside>

	<main
		class="relative flex min-h-svh flex-col px-5 py-6 sm:px-8 lg:min-h-0 lg:px-14 lg:py-12 xl:px-20 xl:py-16"
	>
		<div class="flex items-center justify-between">
			<Logo class="lg:hidden" />
			<div class="ml-auto">
				<ThemeToggle />
			</div>
		</div>

		<div class="flex flex-1 items-center justify-center py-10 lg:py-8">
			<div class="w-full max-w-[25.5rem]">
				{#if eyebrow}
					<p
						class="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground"
					>
						<span class="size-1.5 rounded-full bg-brand"></span>
						{eyebrow}
					</p>
				{/if}
				<h1 class="text-[2rem] leading-[1.12] font-semibold tracking-[-0.03em] text-balance">
					{title}
				</h1>
				{#if description}
					<p class="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
						{description}
					</p>
				{/if}

				<div class="mt-8">
					{@render children()}
				</div>
			</div>
		</div>

		{#if footer}
			<p
				class="mx-auto max-w-[25.5rem] text-center text-[11px] leading-relaxed text-balance text-muted-foreground"
			>
				{@render footer()}
			</p>
		{/if}
	</main>
</div>
