<script lang="ts">
	import Meter from '#lib/components/skiff/Meter.svelte';
	import { formatBytes, formatDuration } from './format.js';

	/** Heartbeat stats are reported as an untyped JSON blob; read the known keys defensively. */
	let { stats }: { stats: unknown } = $props();

	const s = $derived(
		stats && typeof stats === 'object'
			? (stats as Record<string, unknown>)
			: ({} as Record<string, unknown>)
	);
	const num = (key: string): number | null => {
		const value = s[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	};

	const cpu = $derived(num('cpuPercent'));
	const memUsed = $derived(num('memoryBytes'));
	const memTotal = $derived(num('memoryTotalBytes'));
	const diskUsed = $derived(num('diskUsedBytes'));
	const diskTotal = $derived(num('diskTotalBytes'));
	const uptime = $derived(num('uptimeSeconds'));
	const load1 = $derived(num('load1'));
	const hasAny = $derived([cpu, memUsed, diskUsed, uptime, load1].some((value) => value !== null));
</script>

{#if hasAny}
	<div class="space-y-3">
		<div class="grid gap-3 sm:grid-cols-3">
			{#if cpu !== null}
				<Meter label="CPU" value={cpu} detail="{cpu.toFixed(0)}%" />
			{/if}
			{#if memUsed !== null && memTotal}
				<Meter
					label="Memory"
					value={memUsed}
					max={memTotal}
					detail="{formatBytes(memUsed)} / {formatBytes(memTotal)}"
				/>
			{/if}
			{#if diskUsed !== null && diskTotal}
				<Meter
					label="Disk"
					value={diskUsed}
					max={diskTotal}
					detail="{formatBytes(diskUsed)} / {formatBytes(diskTotal)}"
				/>
			{/if}
		</div>
		{#if uptime !== null || load1 !== null}
			<p class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
				{#if uptime !== null}<span>up {formatDuration(uptime)}</span>{/if}
				{#if load1 !== null}<span>load {load1.toFixed(2)}</span>{/if}
			</p>
		{/if}
	</div>
{/if}
