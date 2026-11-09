<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { NodeCapacityView } from '@yoal/contracts';
	import type { Component } from 'svelte';
	import StatusDot from '#lib/components/yoal/StatusDot.svelte';
	import { formatMb, predictAuto } from './template-form.js';

	/**
	 * Placement as cards. Platform admins see each node's workload slice with the new pool's
	 * reservation drawn on top, so "will it fit?" is answered before admission is.
	 */
	let {
		value = $bindable('auto'),
		capacity,
		requiredMb
	}: {
		value?: string;
		capacity: NodeCapacityView[];
		/** Memory the workload reserves, once the form is valid. */
		requiredMb: number | null;
	} = $props();

	interface Choice {
		value: string;
		title: string;
		description: string;
		icon: Component<{ class?: string }>;
		node?: NodeCapacityView;
	}

	const edgeNode = $derived(capacity.find((node) => node.mode === 'edge'));
	const workers = $derived(
		capacity.filter((node) => node.mode !== 'edge').sort((a, b) => b.freeMemoryMb - a.freeMemoryMb)
	);
	const predicted = $derived(requiredMb === null ? null : predictAuto(capacity, requiredMb));

	const choices = $derived<Choice[]>([
		{
			value: 'auto',
			title: 'Auto',
			description:
				capacity.length === 0 || requiredMb === null
					? 'The worker with the most free memory, then the edge. Chosen once, at deploy time.'
					: predicted
						? `Would pick ${predicted.name} now (${formatMb(predicted.freeMemoryMb)} free). Chosen once, at deploy time.`
						: `No online node has ${formatMb(requiredMb)} free right now.`,
			icon: SparklesIcon
		},
		{
			value: 'edge',
			title: 'Edge node',
			description: 'Runs beside the router. Keep heavy pools on workers.',
			icon: RadioTowerIcon,
			node: edgeNode
		},
		...workers.map((node) => ({
			value: node.nodeId,
			title: node.name,
			description: `${node.mode} · ${node.workloadCount} ${node.workloadCount === 1 ? 'workload' : 'workloads'}`,
			icon: ServerIcon,
			node
		}))
	]);

	function fits(node: NodeCapacityView | undefined): boolean | null {
		if (!node || requiredMb === null) return null;
		return node.freeMemoryMb >= requiredMb;
	}

	function pct(part: number, whole: number): number {
		if (whole <= 0) return 0;
		return Math.max(0, Math.min(100, (part / whole) * 100));
	}
</script>

<div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Placement">
	{#each choices as choice (choice.value)}
		{@const checked = value === choice.value}
		{@const node = choice.node}
		{@const fit =
			choice.value === 'auto'
				? requiredMb === null || capacity.length === 0
					? null
					: predicted !== null
				: fits(node)}
		<label
			class="group relative flex cursor-pointer flex-col gap-2.5 rounded-lg border bg-card p-3 text-sm transition-all hover:border-foreground/20 hover:bg-muted/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 {checked
				? 'border-foreground/40 bg-muted/40 shadow-xs ring-1 ring-foreground/10'
				: ''}"
		>
			<input
				type="radio"
				class="sr-only"
				name="placement"
				value={choice.value}
				bind:group={value}
			/>
			<span class="flex items-start gap-2.5">
				<span
					class="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors {checked
						? 'border-foreground/30 text-foreground'
						: ''}"
				>
					<choice.icon class="size-3.5" />
				</span>
				<span class="min-w-0 flex-1 space-y-0.5">
					<span class="flex items-center gap-1.5 leading-tight font-medium">
						<span
							class="truncate {node && choice.value !== 'edge' ? 'font-mono text-[0.8rem]' : ''}"
							>{choice.title}</span
						>
						{#if node && node.status !== 'online'}
							<span
								class="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"
							>
								<StatusDot status={node.status} />{node.status}
							</span>
						{/if}
					</span>
					<span class="block text-xs leading-snug text-pretty text-muted-foreground"
						>{choice.description}</span
					>
				</span>
				{#if checked}
					<span
						class="flex size-4 shrink-0 animate-in items-center justify-center rounded-full bg-foreground text-background zoom-in-50"
						aria-hidden="true"><CheckIcon class="size-2.5" strokeWidth={3.5} /></span
					>
				{/if}
			</span>

			{#if node}
				{@const reserved = pct(node.reservedMemoryMb, node.sliceMemoryMb)}
				{@const adding = requiredMb === null ? 0 : pct(requiredMb, node.sliceMemoryMb)}
				<span class="space-y-1">
					<span
						class="relative flex h-1.5 overflow-hidden rounded-full bg-muted"
						role="img"
						aria-label="{formatMb(node.reservedMemoryMb)} of {formatMb(
							node.sliceMemoryMb
						)} reserved"
					>
						<span class="h-full bg-foreground/25" style:width="{reserved}%"></span>
						{#if requiredMb !== null}
							<span
								class="h-full transition-[width] duration-500 ease-out {fit
									? 'bg-brand'
									: 'bg-destructive'}"
								style:width="{Math.min(adding, 100 - reserved)}%"
							></span>
						{/if}
					</span>
					<span
						class="flex items-center justify-between gap-2 font-mono text-[0.7rem] text-muted-foreground tabular-nums"
					>
						<span>{formatMb(node.freeMemoryMb)} free of {formatMb(node.sliceMemoryMb)}</span>
						{#if fit === false}
							<span class="inline-flex items-center gap-1 font-sans text-destructive"
								><TriangleAlertIcon class="size-3" />Won’t fit</span
							>
						{:else if fit}
							<span class="font-sans text-success">Fits</span>
						{/if}
					</span>
				</span>
			{:else if choice.value === 'auto' && fit === false}
				<span class="inline-flex items-center gap-1 text-xs text-destructive">
					<TriangleAlertIcon class="size-3" />Lower the runners or memory, or free up a node.
				</span>
			{/if}
		</label>
	{/each}
</div>
