<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { runAction } from '#lib/actions.js';
	import { confirmState } from '#lib/confirm.svelte.js';

	let pending = $state(false);
	let typed = $state('');

	const request = $derived(confirmState.request);
	const blocked = $derived(Boolean(request?.typeToConfirm) && typed !== request?.typeToConfirm);

	function close() {
		if (pending) return;
		confirmState.request = null;
		typed = '';
	}

	async function confirm() {
		if (!request || blocked) return;
		pending = true;
		const result = await runAction(request.action, request.fields, { apply: request.apply });
		pending = false;
		await request.onResult?.(result);
		if (result.type !== 'failure') {
			confirmState.request = null;
			typed = '';
		}
	}
</script>

<AlertDialog.Root open={request !== null} onOpenChange={(open) => !open && close()}>
	<AlertDialog.Content>
		{#if request}
			<AlertDialog.Header>
				<AlertDialog.Title>{request.title}</AlertDialog.Title>
				{#if request.description}
					<AlertDialog.Description>{request.description}</AlertDialog.Description>
				{/if}
			</AlertDialog.Header>
			{#if request.typeToConfirm}
				<Field.Field>
					<Field.Label for="confirm-text">
						Type <code class="rounded bg-muted px-1 font-mono text-xs">{request.typeToConfirm}</code
						> to confirm
					</Field.Label>
					<Input id="confirm-text" bind:value={typed} autocomplete="off" spellcheck="false" />
				</Field.Field>
			{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={pending}>Cancel</AlertDialog.Cancel>
				<Button
					variant={request.tone === 'danger' ? 'destructive' : 'default'}
					disabled={pending || blocked}
					onclick={confirm}
				>
					{#if pending}<Spinner />{/if}
					{request.confirmLabel ?? 'Confirm'}
				</Button>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
