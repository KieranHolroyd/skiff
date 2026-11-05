<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import type { Step } from './update-ui.js';

	/**
	 * The updater's phases as a stepper. With `current` it tracks a live run; without, it previews
	 * what an update will do (same shape, so the progress view is recognisable once it starts).
	 */
	let {
		steps,
		current = null,
		rollingBack = false
	}: {
		steps: Step[];
		/** Index of the active step; null previews the plan. */
		current?: number | null;
		rollingBack?: boolean;
	} = $props();

	function state(index: number): 'done' | 'active' | 'todo' | 'plan' {
		if (current === null) return 'plan';
		if (index < current) return 'done';
		return index === current ? 'active' : 'todo';
	}
</script>

<ol
	class="grid gap-y-4 sm:gap-x-2"
	style:grid-template-columns="repeat({steps.length}, minmax(0, 1fr))"
	aria-label={current === null ? 'What the update does' : 'Update progress'}
>
	{#each steps as step, index (step.phase)}
		{@const s = state(index)}
		{@const last = index === steps.length - 1}
		<li
			class="relative col-span-full flex gap-3 sm:col-span-1 sm:flex-col sm:gap-2"
			aria-current={s === 'active' ? 'step' : undefined}
		>
			{#if !last}
				<span
					class="absolute top-7 -bottom-4 left-3 w-px sm:top-3 sm:right-0 sm:bottom-auto sm:left-8 sm:h-px sm:w-auto {s ===
					'done'
						? 'bg-success/50'
						: 'bg-border'}"
					aria-hidden="true"
				></span>
			{/if}
			<span
				class="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold tabular-nums transition-colors {s ===
				'done'
					? 'bg-success text-background'
					: s === 'active'
						? rollingBack
							? 'bg-warning/15 text-warning ring-2 ring-warning/40'
							: 'bg-info/15 text-info ring-2 ring-info/40'
						: 'border bg-background text-muted-foreground'}"
				aria-hidden="true"
			>
				{#if s === 'done'}
					<CheckIcon class="size-3.5" strokeWidth={3} />
				{:else if s === 'active'}
					{#if rollingBack}
						<RotateCcwIcon class="size-3.5 animate-spin [animation-direction:reverse]" />
					{:else}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
					{/if}
				{:else}
					{index + 1}
				{/if}
			</span>
			<span class="min-w-0 sm:pr-2">
				<span
					class="block text-sm leading-6 font-medium sm:leading-tight {s === 'todo'
						? 'text-muted-foreground'
						: s === 'active'
							? rollingBack
								? 'text-warning'
								: 'text-info'
							: ''}"
				>
					{s === 'active' && rollingBack ? 'Rolling back' : step.label}
					<span class="sr-only">
						{s === 'done' ? '(done)' : s === 'active' ? '(in progress)' : ''}
					</span>
				</span>
				{#if s === 'plan' || s === 'active'}
					<span class="mt-0.5 block text-xs leading-snug text-pretty text-muted-foreground"
						>{s === 'active' && rollingBack ? 'Restoring the previous version' : step.hint}</span
					>
				{/if}
			</span>
		</li>
	{/each}
</ol>
