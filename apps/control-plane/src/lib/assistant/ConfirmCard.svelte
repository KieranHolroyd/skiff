<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { assistant, type ConfirmationCard } from '#lib/assistant/assistant.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * A destructive action the assistant prepared. Nothing runs until the user clicks Confirm; the
	 * signed token is bound to this user, tool and exact arguments (docs/ASSISTANT.md).
	 */
	let { card, oncontinue }: { card: ConfirmationCard; oncontinue?: (text: string) => void } =
		$props();

	let showResult = $state(false);

	const fields = $derived(
		Object.entries(card.args).map(([key, value]) => {
			let text: string;
			if (key === 'files' && Array.isArray(value)) text = `${value.length} file(s)`;
			else if (typeof value === 'string') text = value;
			else text = JSON.stringify(value) ?? String(value);
			return { key, text: text.length > 200 ? `${text.slice(0, 200)}…` : text };
		})
	);

	function keydown(event: KeyboardEvent) {
		if (card.status !== 'pending') return;
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void assistant.confirm(card);
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="rounded-lg border p-3 {card.status === 'pending'
		? 'border-warning/50 bg-warning/5'
		: 'bg-muted/30'}"
	role="group"
	aria-label="Confirm {card.title}"
	onkeydown={keydown}
>
	<div class="flex items-start gap-2">
		<ShieldAlertIcon
			class="mt-0.5 size-4 shrink-0 {card.status === 'pending'
				? 'text-warning'
				: 'text-muted-foreground'}"
		/>
		<div class="min-w-0 flex-1 space-y-2">
			<div>
				<p class="text-sm font-medium">{card.title}</p>
				<p class="font-mono text-[10px] text-muted-foreground">{card.tool} · needs your approval</p>
			</div>
			{#if fields.length > 0}
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-muted/60 p-2 text-xs">
					{#each fields as field (field.key)}
						<dt class="text-muted-foreground">{field.key}</dt>
						<dd class="min-w-0 font-mono break-all">{field.text}</dd>
					{/each}
				</dl>
			{/if}

			{#if card.status === 'pending'}
				<div class="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="destructive" onclick={() => assistant.confirm(card)}
						>Confirm</Button
					>
					<Button size="sm" variant="outline" onclick={() => assistant.deny(card)}>Cancel</Button>
					<span class="text-[11px] text-muted-foreground">Runs once, as you. Audited.</span>
				</div>
			{:else if card.status === 'running'}
				<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
					><Spinner /> Running…</span
				>
			{:else}
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					{#if card.status === 'done'}
						<span class="inline-flex items-center gap-1 text-success"
							><CircleCheckIcon class="size-3.5" /> Done</span
						>
						{#if card.result}
							<button
								type="button"
								class="text-muted-foreground underline-offset-2 hover:underline"
								onclick={() => (showResult = !showResult)}
								>{showResult ? 'Hide' : 'Show'} result</button
							>
						{/if}
					{:else if card.status === 'denied'}
						<span class="inline-flex items-center gap-1 text-muted-foreground"
							><CircleXIcon class="size-3.5" /> Cancelled. Nothing changed.</span
						>
					{:else if card.status === 'expired'}
						<span class="inline-flex items-center gap-1 text-muted-foreground"
							><ClockIcon class="size-3.5" /> Expired. Ask again to prepare it fresh.</span
						>
					{:else}
						<span class="inline-flex items-center gap-1 text-destructive"
							><CircleXIcon class="size-3.5" /> {card.error ?? 'The action failed.'}</span
						>
					{/if}
					{#if oncontinue && !assistant.sending && (card.status === 'done' || card.status === 'error')}
						<button
							type="button"
							class="font-medium text-brand underline-offset-2 hover:underline"
							onclick={() =>
								oncontinue(
									card.status === 'done'
										? `I confirmed "${card.title}". Check it worked and tell me what changed.`
										: `"${card.title}" failed. What went wrong and what should I do?`
								)}>Ask Skiff to follow up</button
						>
					{/if}
				</div>
				{#if showResult && card.result}
					<pre
						class="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{card.result}</pre>
				{/if}
			{/if}
		</div>
	</div>
</div>
