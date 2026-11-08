<script lang="ts">
	import type { PipelineJobView } from '@skiff/contracts';
	import StateIcon from './StateIcon.svelte';
	import { elapsed } from './status.js';

	/** Jobs in columns by `needs` depth: a DAG view without a graph library. */
	let {
		jobs,
		selected,
		onselect
	}: { jobs: PipelineJobView[]; selected: string | null; onselect: (id: string) => void } = $props();

	const columns = $derived.by(() => {
		const needsByKey = new Map<string, string[]>();
		for (const job of jobs) if (!needsByKey.has(job.key)) needsByKey.set(job.key, job.needs);
		const depth = new Map<string, number>();
		const visit = (key: string, trail: Set<string>): number => {
			const known = depth.get(key);
			if (known !== undefined) return known;
			if (trail.has(key)) return 0;
			trail.add(key);
			const needs = (needsByKey.get(key) ?? []).filter((need) => needsByKey.has(need));
			const value = needs.length ? Math.max(...needs.map((need) => visit(need, trail))) + 1 : 0;
			depth.set(key, value);
			return value;
		};
		const out: PipelineJobView[][] = [];
		for (const job of jobs) {
			const d = visit(job.key, new Set());
			(out[d] ??= []).push(job);
		}
		return out.filter(Boolean);
	});

	function matrixLabel(matrix: Record<string, unknown> | null): string {
		if (!matrix) return '';
		return Object.values(matrix)
			.map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)))
			.join(', ');
	}
</script>

<div class="overflow-x-auto rounded-xl border bg-muted/30 p-4">
	<div class="flex min-w-max items-start gap-8">
		{#each columns as column, index (index)}
			<div class="flex w-56 flex-col gap-2">
				{#each column as job (job.id)}
					<button
						type="button"
						onclick={() => onselect(job.id)}
						class="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left shadow-xs transition-colors hover:bg-muted {selected ===
						job.id
							? 'border-primary ring-2 ring-primary/20'
							: ''}"
						aria-pressed={selected === job.id}
					>
						<StateIcon status={job.status} conclusion={job.conclusion} />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium">{job.name}</span>
							{#if job.matrix}
								<span class="block truncate font-mono text-[11px] text-muted-foreground"
									>{matrixLabel(job.matrix)}</span
								>
							{/if}
						</span>
						<span class="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
							{job.startedAt ? elapsed(job.startedAt, job.finishedAt) : ''}
						</span>
					</button>
				{/each}
			</div>
		{/each}
	</div>
</div>
