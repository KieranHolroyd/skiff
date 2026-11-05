<script lang="ts">
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { formatBytes } from '../../_lib/format.js';
	import { storagePercent } from './database-series.js';

	/** Latest sampled size against the storage budget (alerts fire at 85%, D57). */
	let {
		sizeBytes,
		storageMb,
		compact = false
	}: { sizeBytes: number | null; storageMb: number; compact?: boolean } = $props();

	const pct = $derived(storagePercent(sizeBytes, storageMb));
	const budget = $derived(formatBytes(storageMb * 1024 * 1024));
	const tone = $derived(
		pct === null
			? ''
			: pct >= 85
				? '[&_[data-slot=progress-indicator]]:bg-destructive'
				: pct >= 70
					? '[&_[data-slot=progress-indicator]]:bg-warning'
					: ''
	);
</script>

<div class="space-y-1 {compact ? 'min-w-32' : ''}">
	<div class="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
		<span>{sizeBytes === null ? 'No sample yet' : formatBytes(sizeBytes)}</span>
		<span class="text-muted-foreground">of {budget}</span>
	</div>
	<Progress
		value={pct ?? 0}
		class="h-1.5 {tone}"
		aria-label={pct === null
			? `Storage budget ${budget}, no size sample yet`
			: `${pct.toFixed(pct > 0 && pct < 1 ? 1 : 0)}% of the ${budget} storage budget used`}
	/>
</div>
