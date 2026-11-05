<script lang="ts">
	import { Progress } from '#lib/components/ui/progress/index.js';
	import type { Stat } from './sections.js';

	/** A row of headline numbers in one bordered strip; hairline dividers survive any wrap. */
	let { stats, label }: { stats: Stat[]; label: string } = $props();

	// Static class names so Tailwind sees them; one row at full width whatever the count.
	const wide: Record<number, string> = {
		2: 'xl:grid-cols-2',
		3: 'xl:grid-cols-3',
		4: 'xl:grid-cols-4',
		5: 'xl:grid-cols-5',
		6: 'xl:grid-cols-6'
	};

	const meterTone = (pct: number) =>
		pct >= 85
			? '[&_[data-slot=progress-indicator]]:bg-destructive'
			: pct >= 70
				? '[&_[data-slot=progress-indicator]]:bg-warning'
				: '';
</script>

<section
	aria-label={label}
	class="grid gap-px overflow-hidden rounded-xl border bg-border shadow-xs sm:grid-cols-2 {wide[
		stats.length
	] ?? 'xl:grid-cols-4'}"
>
	{#each stats as stat (stat.label)}
		<div class="space-y-1.5 bg-card px-4 py-3.5">
			<p class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				{#if stat.icon}<stat.icon class="size-3.5" />{/if}
				{stat.label}
			</p>
			<p class="text-xl leading-none font-semibold tracking-tight tabular-nums">
				{stat.value}{#if stat.unit}<span class="text-sm font-normal text-muted-foreground">
						{stat.unit}</span
					>{/if}
			</p>
			{#if stat.meter !== undefined && stat.meter !== null}
				<Progress
					value={Math.min(100, Math.max(0, stat.meter))}
					class="h-1 {meterTone(stat.meter)}"
					aria-label="{stat.label}: {stat.meter.toFixed(0)}% of budget"
				/>
			{/if}
			{#if stat.caption}<p class="truncate text-xs text-muted-foreground">{stat.caption}</p>{/if}
		</div>
	{/each}
</section>
