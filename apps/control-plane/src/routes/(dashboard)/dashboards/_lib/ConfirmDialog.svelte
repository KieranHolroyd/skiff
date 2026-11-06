<script lang="ts" module>
	/**
	 * Confirmation for client-side actions (REST calls). The app-wide `askConfirm` runs SvelteKit
	 * form actions, and the observability API is plain JSON over fetch, so the dashboards pages
	 * use this instead, with the same look.
	 */
	export interface ConfirmOptions {
		title: string;
		description?: string;
		confirmLabel?: string;
		tone?: 'danger' | 'default';
		run: () => Promise<void> | void;
	}

	class ConfirmQueue {
		request = $state<ConfirmOptions | null>(null);
	}
	export const confirmQueue = new ConfirmQueue();

	export function confirmAction(options: ConfirmOptions): void {
		confirmQueue.request = options;
	}
</script>

<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';

	let pending = $state(false);
	let failure = $state<string | null>(null);
	const request = $derived(confirmQueue.request);

	function close() {
		if (pending) return;
		confirmQueue.request = null;
		failure = null;
	}

	async function confirm() {
		if (!request) return;
		pending = true;
		failure = null;
		try {
			await request.run();
			confirmQueue.request = null;
		} catch (error) {
			failure = errorText(error);
		} finally {
			pending = false;
		}
	}
</script>

<AlertDialog.Root open={request !== null} onOpenChange={(open) => !open && close()}>
	<AlertDialog.Content>
		{#if request}
			<AlertDialog.Header>
				<AlertDialog.Title>{request.title}</AlertDialog.Title>
				{#if request.description}<AlertDialog.Description
						>{request.description}</AlertDialog.Description
					>{/if}
			</AlertDialog.Header>
			{#if failure}<p class="text-sm text-destructive" role="alert">{failure}</p>{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={pending}>Cancel</AlertDialog.Cancel>
				<Button
					variant={request.tone === 'danger' ? 'destructive' : 'default'}
					disabled={pending}
					onclick={confirm}
				>
					{#if pending}<Spinner />{/if}
					{request.confirmLabel ?? 'Confirm'}
				</Button>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
