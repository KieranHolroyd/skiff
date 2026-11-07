<script lang="ts">
	import { resolve } from '$app/paths';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import type { SelfUpdateChannel } from '@skiff/contracts';

	/**
	 * Canary or stable (docs/OPS.md §4.1, *Release channels*). Picking one only previews it (the
	 * `?channel=` query); the host switches when an update is requested with it.
	 */
	let {
		selected,
		hostChannel,
		latest
	}: {
		selected: SelfUpdateChannel;
		/** The channel the updater has recorded for this host. */
		hostChannel: SelfUpdateChannel;
		/** Newest version on each channel; null when unknown or none promoted yet. */
		latest: Record<SelfUpdateChannel, string | null>;
	} = $props();

	const options = [
		{
			value: 'canary',
			label: 'Canary',
			description: 'Every release, as soon as CI publishes it.',
			icon: FlaskConicalIcon
		},
		{
			value: 'stable',
			label: 'Stable',
			description: 'Only releases promoted after they have run on canary.',
			icon: ShieldCheckIcon
		}
	] as const;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved route plus a ?channel= query -->
<nav aria-label="Release channel" class="space-y-2.5">
	<p class="text-xs font-medium text-muted-foreground">Release channel</p>
	<div class="grid gap-2 sm:grid-cols-2">
		{#each options as option (option.value)}
			{@const active = option.value === selected}
			<a
				href={`${resolve('/(dashboard)/settings/updates')}?channel=${option.value}`}
				data-sveltekit-noscroll
				data-sveltekit-replacestate
				aria-current={active ? 'true' : undefined}
				class="group flex items-start gap-3 rounded-lg border bg-background p-3 transition-[border-color,box-shadow,background-color] hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {active
					? 'border-foreground/40 bg-muted/40 ring-1 ring-foreground/10'
					: ''}"
			>
				<span
					class="flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors {active
						? 'border-foreground/20 bg-foreground text-background'
						: 'bg-muted/50 text-muted-foreground'}"
					aria-hidden="true"
				>
					<option.icon class="size-3.5" />
				</span>
				<span class="min-w-0 flex-1">
					<span class="flex flex-wrap items-center gap-x-1.5 text-sm font-medium">
						{option.label}
						{#if option.value === hostChannel}
							<span class="text-[0.65rem] font-normal text-muted-foreground">· this host</span>
						{/if}
						<span class="ml-auto font-mono text-xs font-normal text-muted-foreground tabular-nums">
							{latest[option.value]
								? `v${latest[option.value]}`
								: option.value === 'stable'
									? 'none yet'
									: '—'}
						</span>
					</span>
					<span class="mt-0.5 block text-xs leading-relaxed text-pretty text-muted-foreground"
						>{option.description}</span
					>
				</span>
			</a>
		{/each}
	</div>
</nav>
