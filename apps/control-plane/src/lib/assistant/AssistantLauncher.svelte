<script lang="ts">
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { assistant } from '#lib/assistant/assistant.svelte.js';
	import AssistantPanel from '#lib/assistant/AssistantPanel.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { AssistantStatus } from '@skiff/contracts';

	let { status }: { status: AssistantStatus } = $props();

	function keydown(event: KeyboardEvent) {
		if (assistant.tour) return;
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
			event.preventDefault();
			assistant.toggle();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<div id="skiff-assistant">
	{#if !assistant.open}
		<div class="fixed right-4 bottom-4 z-40 md:right-6 md:bottom-6">
			<Button
				size="lg"
				class="h-11 gap-2 rounded-full px-4 shadow-lg shadow-brand/20"
				onclick={() => assistant.toggle()}
				aria-label="Open Skiff assistant"
				title="Skiff assistant (⌘I)"
			>
				<SparklesIcon class="size-4" />
				<span class="hidden sm:inline">Ask Skiff</span>
			</Button>
		</div>
	{/if}
	<AssistantPanel {status} />
</div>
