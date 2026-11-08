<script lang="ts">
	import type { PipelineConclusion } from '@skiff/contracts';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import StateIcon from './StateIcon.svelte';
	import { pipelineState, STATE_BADGE, STATE_LABEL } from './status.js';

	let {
		status,
		conclusion = null,
		class: className = ''
	}: { status: string; conclusion?: PipelineConclusion | null; class?: string } = $props();

	const state = $derived(pipelineState(status, conclusion));
</script>

<Badge variant={STATE_BADGE[state]} class={className}>
	<StateIcon {status} {conclusion} plain class="size-3" />
	{STATE_LABEL[state]}
</Badge>
