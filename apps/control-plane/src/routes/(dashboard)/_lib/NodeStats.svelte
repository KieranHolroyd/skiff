<script lang="ts">
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { formatBytes, formatDuration } from './format.js';

	/** Heartbeat stats are an untyped JSON blob; read the known keys defensively. */
	let { stats }: { stats: unknown } = $props();

	const s = $derived(
		stats && typeof stats === 'object'
			? (stats as Record<string, unknown>)
			: ({} as Record<string, unknown>)
	);
	function num(key: string): number | null {
		const value = s[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}

	const meters = $derived(
		[
			num('cpuPercent') !== null
				? { label: 'CPU', pct: num('cpuPercent')!, detail: `${num('cpuPercent')!.toFixed(0)}%` }
				: null,
			num('memoryBytes') !== null && num('memoryTotalBytes')
				? {
						label: 'Memory',
						pct: (num('memoryBytes')! / num('memoryTotalBytes')!) * 100,
						detail: `${formatBytes(num('memoryBytes'))} / ${formatBytes(num('memoryTotalBytes'))}`
					}
				: null,
			num('diskUsedBytes') !== null && num('diskTotalBytes')
				? {
						label: 'Disk',
						pct: (num('diskUsedBytes')! / num('diskTotalBytes')!) * 100,
						detail: `${formatBytes(num('diskUsedBytes'))} / ${formatBytes(num('diskTotalBytes'))}`
					}
				: null
		].filter((meter) => meter !== null)
	);
	const uptime = $derived(num('uptimeSeconds'));
	const load1 = $derived(num('load1'));
</script>

{#if meters.length > 0 || uptime !== null || load1 !== null}
	<div class="@container space-y-3">
		<div class="grid gap-3 @md:grid-cols-3">
			{#each meters as meter (meter.label)}
				<div class="space-y-1.5">
					<div class="flex items-baseline justify-between gap-2 text-xs">
						<span class="text-muted-foreground">{meter.label}</span>
						<span class="font-mono text-[11px] tabular-nums">{meter.detail}</span>
					</div>
					<Progress
						value={Math.min(100, Math.max(0, meter.pct))}
						aria-label={meter.label}
						class="h-1.5 {meter.pct >= 90
							? '*:data-[slot=progress-indicator]:bg-danger'
							: meter.pct >= 75
								? '*:data-[slot=progress-indicator]:bg-warning'
								: '*:data-[slot=progress-indicator]:bg-info'}"
					/>
				</div>
			{/each}
		</div>
		{#if uptime !== null || load1 !== null}
			<p class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
				{#if uptime !== null}<span>up {formatDuration(uptime)}</span>{/if}
				{#if load1 !== null}<span>load {load1.toFixed(2)}</span>{/if}
			</p>
		{/if}
	</div>
{/if}
