<script lang="ts">
	import type { Tone } from '#lib/status.js';
	import type { RateGauge } from './email-ui.js';

	/** A reputation meter with the warning and pause thresholds marked (docs/EMAIL.md §7.2). */
	let {
		label,
		gauge,
		warn,
		pause
	}: { label: string; gauge: RateGauge; warn: string; pause: string } = $props();

	const fills: Record<Tone, string> = {
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-destructive',
		info: 'bg-info',
		brand: 'bg-brand',
		neutral: 'bg-muted-foreground/40'
	};
	const verdict = $derived(
		{
			unknown: 'Not judged yet',
			ok: 'Healthy',
			warn: 'Above the warning level',
			pause: 'At the pause level'
		}[gauge.level]
	);
</script>

<div class="space-y-2">
	<div class="flex items-baseline justify-between gap-3">
		<p class="text-sm font-medium">{label}</p>
		<p class="font-mono text-lg font-semibold tabular-nums">{gauge.value}</p>
	</div>
	<div
		class="relative h-2 rounded-full bg-muted"
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(gauge.percent)}
		aria-valuetext="{gauge.value}, {verdict}"
	>
		<div class="h-full rounded-full {fills[gauge.tone]}" style="width: {gauge.percent}%"></div>
		<span
			class="absolute -top-1 h-4 w-px bg-warning"
			style="left: {gauge.warnAt}%"
			title="Warning at {warn}"
			aria-hidden="true"
		></span>
		<span
			class="absolute -top-1 h-4 w-px bg-destructive"
			style="left: {gauge.pauseAt}%"
			title="Pause at {pause}"
			aria-hidden="true"
		></span>
	</div>
	<p class="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
		<span>{verdict}</span>
		<span>Warn {warn} · pause {pause}</span>
	</p>
</div>
