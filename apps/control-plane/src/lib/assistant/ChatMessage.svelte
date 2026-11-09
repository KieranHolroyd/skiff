<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { assistant, type AssistantMessage } from '#lib/assistant/assistant.svelte.js';
	import { copyText } from '#lib/assistant/clipboard.js';
	import ConfirmCard from '#lib/assistant/ConfirmCard.svelte';
	import { formatClock, formatDuration } from '#lib/assistant/format.js';
	import Markdown from '#lib/assistant/Markdown.svelte';
	import ToolSteps from '#lib/assistant/ToolSteps.svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	let {
		message,
		/** Last reply of its turn: carries the regenerate/retry action and the duration. */
		endOfTurn = false,
		/** The newest turn in the conversation (regenerate is only offered there). */
		latestTurn = false,
		onedit,
		onretry,
		oncontinue,
		onnavigate
	}: {
		message: AssistantMessage;
		endOfTurn?: boolean;
		latestTurn?: boolean;
		onedit?: (message: AssistantMessage) => void;
		onretry?: (turnId: string) => void;
		oncontinue?: (text: string) => void;
		onnavigate?: (href: string) => void;
	} = $props();

	let copied = $state(false);
	const streaming = $derived(message.state === 'streaming');
	const editing = $derived(assistant.editingTurn === message.turnId && message.role === 'user');

	async function copy() {
		if (await copyText(message.content)) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		}
	}

	const fullTime = $derived(new Date(message.createdAt).toLocaleString());
</script>

{#snippet action(title: string, onclick: () => void, icon: typeof CopyIcon)}
	{@const Icon = icon}
	<button
		type="button"
		{title}
		aria-label={title}
		class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
		{onclick}
	>
		<Icon class="size-3.5" />
	</button>
{/snippet}

{#if message.role === 'user'}
	<div class="group flex flex-col items-end gap-1">
		<div
			class="max-w-[88%] rounded-2xl rounded-br-sm px-3 py-2 text-sm break-words whitespace-pre-wrap {editing
				? 'bg-primary/40 text-primary-foreground ring-2 ring-brand'
				: 'bg-primary text-primary-foreground'}"
			title={fullTime}
		>
			{message.content}
		</div>
		<div
			class="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
		>
			<span class="mr-1 text-[10px] text-muted-foreground" title={fullTime}
				>{formatClock(message.createdAt)}</span
			>
			{@render action(copied ? 'Copied' : 'Copy', copy, copied ? CheckIcon : CopyIcon)}
			{#if onedit && !assistant.sending}
				{@render action('Edit and resend', () => onedit(message), PencilIcon)}
			{/if}
		</div>
	</div>
{:else}
	<div class="group flex gap-2.5">
		<div
			class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border {message.state ===
			'error'
				? 'border-destructive/40 bg-destructive/10 text-destructive'
				: 'bg-muted text-muted-foreground'}"
		>
			{#if message.state === 'error'}
				<TriangleAlertIcon class="size-3.5" />
			{:else}
				<SparklesIcon class="size-3.5" />
			{/if}
		</div>
		<div class="min-w-0 flex-1 space-y-2">
			<p class="flex items-baseline gap-2 text-xs">
				<span class="font-medium text-muted-foreground">Yoal</span>
				<span class="text-[10px] text-muted-foreground/70" title={fullTime}
					>{formatClock(message.createdAt)}</span
				>
			</p>

			{#if message.steps?.length}
				<ToolSteps steps={message.steps} live={streaming} />
			{/if}

			{#if message.state === 'error'}
				<div
					class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					{message.content || 'The assistant failed.'}
					{#if onretry}
						<button
							type="button"
							class="mt-1.5 flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
							onclick={() => onretry(message.turnId)}
						>
							<RefreshCwIcon class="size-3" /> Try again
						</button>
					{/if}
				</div>
			{:else if message.content}
				<Markdown source={message.content} {streaming} {onnavigate} />
			{:else if streaming && !message.steps?.length}
				<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
					><Spinner /> Thinking…</span
				>
			{/if}

			{#each message.confirmations ?? [] as card (card.token)}
				<ConfirmCard {card} {oncontinue} />
			{/each}

			{#if !streaming && message.state !== 'error'}
				<div
					class="flex items-center gap-0.5 {endOfTurn
						? ''
						: 'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'}"
				>
					{#if message.content}
						{@render action(copied ? 'Copied' : 'Copy reply', copy, copied ? CheckIcon : CopyIcon)}
					{/if}
					{#if endOfTurn && latestTurn && onretry && !assistant.sending}
						{@render action('Regenerate', () => onretry(message.turnId), RefreshCwIcon)}
					{/if}
					{#if message.state === 'stopped'}
						<span class="ml-1 text-[10px] text-muted-foreground">Stopped</span>
					{/if}
					{#if endOfTurn && message.durationMs !== undefined}
						<span class="ml-1 font-mono text-[10px] text-muted-foreground/70"
							>{formatDuration(message.durationMs)}</span
						>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
