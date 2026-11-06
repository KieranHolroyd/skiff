<script lang="ts">
	import Notice from '#lib/components/skiff/Notice.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { AlterReview } from './review.svelte.js';

	/** Shows what a structure edit will run, and runs it on confirm (see `AlterReview`). */
	let { review }: { review: AlterReview } = $props();

	const uid = $props.id();
	const current = $derived(review.state);
</script>

<AlertDialog.Root open={current !== null} onOpenChange={(open) => !open && review.cancel()}>
	<AlertDialog.Content class="sm:max-w-2xl">
		{#if current}
			<AlertDialog.Header>
				<AlertDialog.Title>{current.title}</AlertDialog.Title>
				{#if current.description}
					<AlertDialog.Description>{current.description}</AlertDialog.Description>
				{/if}
			</AlertDialog.Header>

			<div class="min-w-0 space-y-3">
				{#if current.loading}
					<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<Spinner class="size-4" />Preparing the statements…
					</p>
				{:else if current.statements.length > 0}
					<div class="space-y-1">
						<p class="text-xs font-medium" id="statements-{uid}">
							{current.statements.length === 1 ? 'This statement runs' : 'These statements run, in order'}:
						</p>
						<ol aria-labelledby="statements-{uid}" class="max-h-64 space-y-1 overflow-auto rounded-md border bg-muted/50 p-2">
							{#each current.statements as statement, index (index)}
								<li><pre class="font-mono text-xs break-all whitespace-pre-wrap">{statement}</pre></li>
							{/each}
						</ol>
					</div>
				{/if}

				{#if current.error}
					<Notice tone="danger" title="The change can't run">{current.error}</Notice>
				{:else if current.phrase !== null && !current.loading}
					<div class="space-y-1.5">
						<Label for="phrase-{uid}" class="text-xs">
							This can't be undone. Type <code class="font-mono font-semibold">{current.phrase}</code> to confirm.
						</Label>
						<Input
							id="phrase-{uid}"
							bind:value={review.typed}
							autocomplete="off"
							spellcheck={false}
							class="font-mono"
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									void review.confirm();
								}
							}}
						/>
					</div>
				{/if}
			</div>

			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={current.running}>{current.error && !current.loading ? 'Close' : 'Cancel'}</AlertDialog.Cancel>
				<Button
					variant={current.destructive ? 'destructive' : 'default'}
					disabled={!review.canConfirm}
					onclick={() => void review.confirm()}
				>
					{#if current.running}<Spinner />{/if}
					{current.confirmLabel}
				</Button>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
