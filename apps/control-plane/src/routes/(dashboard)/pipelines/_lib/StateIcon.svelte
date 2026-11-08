<script lang="ts">
	import type { PipelineConclusion } from '@skiff/contracts';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { pipelineState, STATE_LABEL, STATE_TEXT, type PipelineState } from './status.js';

	/** Status icon for a run, job or step: clock, spinner, check, cross, slash or dash. */
	let {
		status,
		conclusion = null,
		plain = false,
		class: className = 'size-4'
	}: {
		status: string;
		conclusion?: PipelineConclusion | null;
		/** Inherit the text colour (inside a tinted badge). */
		plain?: boolean;
		class?: string;
	} = $props();

	const state = $derived(pipelineState(status, conclusion));
	const icons: Record<PipelineState, typeof ClockIcon> = {
		pending: ClockIcon,
		queued: ClockIcon,
		waiting: HourglassIcon,
		in_progress: LoaderCircleIcon,
		success: CircleCheckIcon,
		failure: CircleXIcon,
		timed_out: CircleXIcon,
		cancelled: CircleSlashIcon,
		skipped: CircleMinusIcon,
		completed: CircleDashedIcon
	};
	const Icon = $derived(icons[state]);
</script>

<Icon
	class="shrink-0 {plain ? '' : STATE_TEXT[state]} {state === 'in_progress' ? 'animate-spin' : ''} {className}"
	aria-label={STATE_LABEL[state]}
/>
