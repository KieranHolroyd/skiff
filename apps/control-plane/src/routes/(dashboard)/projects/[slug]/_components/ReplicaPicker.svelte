<script lang="ts">
	import type { ContainerTarget } from '@skiff/contracts';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';

	/** Pick one replica of a multi-copy container; hidden when there is only one. */
	let {
		targets,
		replica = $bindable<number | null>(null)
	}: { targets: ContainerTarget[]; replica?: number | null } = $props();

	const multiple = $derived(targets.length > 1);

	// A single-copy workload has no index; a spread one must name a real replica.
	$effect(() => {
		if (targets.length === 0) return;
		if (!multiple && replica !== null && targets[0]!.replica === null) replica = null;
		if (multiple && !targets.some((target) => target.replica === replica))
			replica = targets[0]!.replica;
	});
</script>

{#if multiple}
	<label class="flex items-center gap-2 text-sm">
		<span class="text-muted-foreground">Replica</span>
		<NativeSelect.Root
			value={String(replica ?? '')}
			onchange={(event) => {
				const value = (event.currentTarget as HTMLSelectElement).value;
				replica = value === '' ? null : Number(value);
			}}
			class="h-8"
		>
			{#each targets as target (target.desiredId)}
				<NativeSelect.Option value={String(target.replica ?? '')}>
					#{target.replica ?? 0} · {target.nodeName}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	</label>
{:else}
	<span></span>
{/if}
