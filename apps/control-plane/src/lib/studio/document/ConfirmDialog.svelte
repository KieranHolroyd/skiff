<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { Confirmer } from './confirm.svelte.js';

	let { confirmer }: { confirmer: Confirmer } = $props();

	const prompt = $derived(confirmer.prompt);
</script>

<AlertDialog.Root open={prompt !== null} onOpenChange={(open) => !open && confirmer.settle(false)}>
	<AlertDialog.Content>
		{#if prompt}
			<AlertDialog.Header>
				<AlertDialog.Title>{prompt.title}</AlertDialog.Title>
				{#if prompt.description}
					<AlertDialog.Description>{prompt.description}</AlertDialog.Description>
				{/if}
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
				<Button
					variant={prompt.tone === 'default' ? 'default' : 'destructive'}
					onclick={() => confirmer.settle(true)}
				>
					{prompt.confirmLabel ?? 'Confirm'}
				</Button>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
