<script lang="ts">
	import type { Component } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import type { Tone } from '#lib/status.js';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { toneTile } from './update-ui.js';

	/**
	 * The page's headline: what this host runs, what it could run, and the one-sentence state of
	 * the updater. Everything below it on the page is detail for this card.
	 */
	let {
		tone,
		icon: Icon,
		spin = false,
		eyebrow,
		title,
		description,
		current,
		target,
		bump,
		latest,
		checkedAt,
		source
	}: {
		tone: Tone;
		icon: Component<{ class?: string }>;
		spin?: boolean;
		eyebrow: string;
		title: string;
		description: string;
		current: string;
		/** Shown as `current → target` when set (an available or running update). */
		target: string | null;
		bump: string | null;
		/** The newest version GitHub reported; null when the check failed. */
		latest: string | null;
		checkedAt: string | null;
		source: { repo: string; ref: string };
	} = $props();

	const glow: Record<Tone, string> = {
		success: 'from-success/[0.07]',
		warning: 'from-warning/[0.08]',
		danger: 'from-destructive/[0.07]',
		info: 'from-info/[0.07]',
		brand: 'from-brand/[0.07]',
		neutral: 'from-muted/60'
	};
	const eyebrowTone: Record<Tone, string> = {
		success: 'text-success',
		warning: 'text-warning',
		danger: 'text-destructive',
		info: 'text-info',
		brand: 'text-brand',
		neutral: 'text-muted-foreground'
	};

	const githubUrl = $derived(`https://github.com/${source.repo}/tree/${source.ref}`);
</script>

<section
	class="relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
	aria-labelledby="update-hero-title"
>
	<div
		class="pointer-events-none absolute inset-0 bg-linear-to-br via-transparent to-transparent {glow[
			tone
		]}"
		aria-hidden="true"
	></div>

	<div class="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
		<div class="flex min-w-0 flex-1 items-start gap-4">
			<span
				class="flex size-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset {toneTile[
					tone
				]}"
				aria-hidden="true"
			>
				<Icon class="size-5 {spin ? 'animate-spin' : ''}" />
			</span>
			<div class="min-w-0 space-y-1">
				<p class="text-xs font-medium tracking-wide uppercase {eyebrowTone[tone]}">{eyebrow}</p>
				<h3 id="update-hero-title" class="text-xl leading-tight font-semibold tracking-tight">
					{title}
				</h3>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground" aria-live="polite">
					{description}
				</p>
			</div>
		</div>

		<div
			class="flex shrink-0 items-center gap-2.5 self-start font-mono sm:self-center"
			aria-label={target ? `Version ${current} to ${target}` : `Version ${current}`}
		>
			{#if target}
				<span
					class="rounded-lg border bg-background/80 px-2.5 py-1.5 text-sm text-muted-foreground tabular-nums"
					>v{current}</span
				>
				<ArrowRightIcon
					class="size-4 text-muted-foreground {spin ? 'animate-pulse' : ''}"
					aria-hidden="true"
				/>
				<span
					class="rounded-lg bg-foreground px-2.5 py-1.5 text-sm font-semibold text-background tabular-nums shadow-sm"
					>v{target}</span
				>
			{:else}
				<span class="text-3xl font-semibold tracking-tight tabular-nums">v{current}</span>
			{/if}
		</div>
	</div>

	<dl
		class="relative grid divide-y border-t bg-muted/30 text-sm sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:divide-x sm:divide-y-0"
	>
		<div
			class="flex items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5 sm:pr-8"
		>
			<dt class="text-xs text-muted-foreground">Running</dt>
			<dd class="font-mono font-medium tabular-nums">v{current}</dd>
		</div>
		<div
			class="flex items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5 sm:pr-8"
		>
			<dt class="text-xs text-muted-foreground">Latest</dt>
			<dd class="flex items-center gap-2">
				{#if latest}
					<span class="font-mono font-medium tabular-nums">v{latest}</span>
					{#if bump && target}
						<span
							class="rounded-full bg-info/10 px-1.5 py-px text-[0.65rem] font-medium tracking-wide text-info uppercase"
							>{bump}</span
						>
					{/if}
				{:else}
					<span class="text-muted-foreground">Unknown</span>
				{/if}
			</dd>
		</div>
		<div
			class="flex min-w-0 items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5"
		>
			<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
				Source
				{#if checkedAt}
					<span class="hidden sm:contents">
						<span aria-hidden="true">·</span>
						<span title={formatDateTime(checkedAt)}>checked {formatRelative(checkedAt)}</span>
					</span>
				{/if}
			</dt>
			<dd class="min-w-0">
				<a
					href={githubUrl}
					target="_blank"
					rel="external noreferrer"
					class="group inline-flex max-w-full items-center gap-1.5 font-mono text-sm underline-offset-4 hover:underline"
					title="{source.repo}@{source.ref}"
				>
					<GitBranchIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span class="truncate">{source.repo}@{source.ref}</span>
					<ExternalLinkIcon
						class="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
						aria-hidden="true"
					/>
				</a>
			</dd>
		</div>
	</dl>
</section>
