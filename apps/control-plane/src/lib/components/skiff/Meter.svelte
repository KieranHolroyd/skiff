<script lang="ts">
	let {
		label,
		value,
		max = 100,
		detail
	}: { label: string; value: number; max?: number; detail?: string } = $props();

	const pct = $derived(max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0);
	const color = $derived(pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-info');
</script>

<div class="space-y-1.5">
	<div class="flex items-baseline justify-between gap-2 text-xs">
		<span class="text-muted-foreground">{label}</span>
		<span class="font-mono text-[11px] tabular-nums">{detail ?? `${pct.toFixed(0)}%`}</span>
	</div>
	<div
		class="h-1.5 overflow-hidden rounded-full bg-muted"
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(pct)}
	>
		<div class="h-full rounded-full transition-[width] {color}" style="width: {pct}%"></div>
	</div>
</div>
