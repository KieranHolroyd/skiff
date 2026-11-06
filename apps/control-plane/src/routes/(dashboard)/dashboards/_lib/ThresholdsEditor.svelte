<script lang="ts">
	/** Threshold steps: a base colour, then values (ascending) where the colour changes. */
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Popover from './Popover.svelte';
	import { THRESHOLD_SWATCHES, cssColor, sortThresholds, type Threshold } from './units.js';

	let { value, onchange }: { value: Threshold[]; onchange: (value: Threshold[]) => void } =
		$props();

	const steps = $derived(
		value.length > 0 ? sortThresholds(value) : [{ value: null, color: 'green' }]
	);

	function set(index: number, patch: Partial<Threshold>) {
		onchange(
			sortThresholds(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)))
		);
	}

	function add() {
		const last = steps.at(-1)?.value ?? 0;
		const color =
			THRESHOLD_SWATCHES[Math.min(steps.length, THRESHOLD_SWATCHES.length - 1)] ?? 'red';
		onchange([...steps, { value: last > 0 ? last * 2 : 80, color }]);
	}
</script>

<div class="space-y-1.5">
	{#each [...steps].reverse() as step, reversed (reversed)}
		{@const index = steps.length - 1 - reversed}
		<div class="flex items-center gap-1.5">
			<Popover align="start" class="w-auto p-2">
				{#snippet trigger({ props })}
					<button
						{...props}
						type="button"
						class="size-6 shrink-0 rounded-md border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						style:background={cssColor(step.color)}
						aria-label="Colour: {step.color}"
					></button>
				{/snippet}
				<div class="flex gap-1.5">
					{#each THRESHOLD_SWATCHES as swatch (swatch)}
						<button
							type="button"
							class="size-6 rounded-md border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {swatch ===
							step.color
								? 'ring-2 ring-ring'
								: ''}"
							style:background={cssColor(swatch)}
							aria-label={swatch}
							title={swatch}
							onclick={() => set(index, { color: swatch })}
						></button>
					{/each}
				</div>
				<Input
					class="mt-2 h-7 font-mono text-xs"
					value={step.color}
					aria-label="Custom colour"
					placeholder="#hex or name"
					onchange={(event) => set(index, { color: event.currentTarget.value.trim() || 'green' })}
				/>
			</Popover>
			{#if step.value === null}
				<span
					class="flex h-7 flex-1 items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground"
					>Base</span
				>
			{:else}
				<Input
					type="number"
					step="any"
					class="h-7 flex-1 text-xs"
					value={step.value}
					aria-label="Threshold value"
					onchange={(event) => {
						const number = Number(event.currentTarget.value);
						if (Number.isFinite(number)) set(index, { value: number });
					}}
				/>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Remove threshold"
					onclick={() => onchange(steps.filter((_, at) => at !== index))}
				>
					<XIcon />
				</Button>
			{/if}
		</div>
	{/each}
	<Button variant="outline" size="sm" onclick={add} disabled={steps.length >= 10}
		><PlusIcon />Threshold</Button
	>
</div>
