<script lang="ts">
	import type { DiskProfileView } from '@skiff/contracts';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * One disk's latest benchmark (docs/STORAGE.md §5.1): sequential MB/s, random 4 KiB IOPS and the
	 * fdatasync round trip a database commit pays.
	 */
	let { profile }: { profile: DiskProfileView | null | undefined } = $props();

	const iops = (value: number | null) =>
		value === null ? '—' : value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString();
	const mbps = (value: number | null) => (value === null ? '—' : `${Math.round(value).toLocaleString()} MB/s`);
	const latency = (us: number | null) => (us === null ? '—' : us >= 1000 ? `${(us / 1000).toFixed(1)} ms` : `${us} µs`);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
</script>

{#if profile}
	{#if profile.status === 'queued' || profile.status === 'running'}
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<Spinner class="size-3" />{profile.status === 'queued' ? 'Waiting for the node…' : 'Profiling… (about a minute)'}
		</div>
	{:else if profile.status === 'failed'}
		<div class="text-xs text-destructive">Profile failed: {profile.error ?? 'unknown error'}</div>
	{:else}
		<dl class="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-5" title="Profiled {when(profile.finishedAt)} with {profile.method}">
			<div><dt class="text-muted-foreground">Seq read</dt><dd class="font-mono tabular-nums">{mbps(profile.seqReadMBps)}</dd></div>
			<div><dt class="text-muted-foreground">Seq write</dt><dd class="font-mono tabular-nums">{mbps(profile.seqWriteMBps)}</dd></div>
			<div><dt class="text-muted-foreground">4K read IOPS</dt><dd class="font-mono tabular-nums">{iops(profile.randReadIops)}</dd></div>
			<div><dt class="text-muted-foreground">4K write IOPS</dt><dd class="font-mono tabular-nums">{iops(profile.randWriteIops)}</dd></div>
			<div><dt class="text-muted-foreground">Sync write</dt><dd class="font-mono tabular-nums">{latency(profile.syncWriteLatencyUs)}</dd></div>
		</dl>
		{#if profile.notes.length}
			<div class="text-[11px] text-muted-foreground">{profile.notes.join(' ')}</div>
		{/if}
	{/if}
{/if}
