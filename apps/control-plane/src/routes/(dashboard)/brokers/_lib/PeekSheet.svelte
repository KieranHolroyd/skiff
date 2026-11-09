<script lang="ts">
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { BrokerStreamPeekResult, PeekedMessage } from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { runNodeTask } from '#lib/node-tasks.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatBytes, formatDateTime } from '../../_lib/format.js';

	/**
	 * Read a stream's messages without consuming them (D124). The broker's node fetches them by
	 * sequence, so nothing a consumer is waiting for is taken; deleting one is a separate action.
	 */
	let {
		stream = $bindable(null),
		label,
		canDelete
	}: {
		/** The stream to show; null closes the sheet. */
		stream: string | null;
		label?: string | null;
		canDelete: boolean;
	} = $props();

	const PAGE = 20;
	let messages = $state<PeekedMessage[]>([]);
	let total = $state(0);
	let nextSeq = $state<number | null>(null);
	let loading = $state(false);
	let loaded = $state<string | null>(null);

	async function load(target: string, fromSeq?: number) {
		loading = true;
		const task = await runNodeTask<'broker.stream.peek'>('?/peek', {
			stream: target,
			limit: String(PAGE),
			...(fromSeq ? { fromSeq: String(fromSeq) } : {})
		});
		loading = false;
		if (stream !== target) return;
		const result: BrokerStreamPeekResult | null = task?.result ?? null;
		if (!result) return;
		messages = fromSeq ? [...messages, ...result.messages] : result.messages;
		total = result.total;
		nextSeq = result.nextSeq;
		loaded = target;
	}

	$effect(() => {
		const target = stream;
		if (target && loaded !== target) {
			messages = [];
			total = 0;
			nextSeq = null;
			void load(target);
		}
		if (!target) loaded = null;
	});

	function pretty(message: PeekedMessage): string {
		if (message.encoding !== 'utf8' || message.truncated) return message.body;
		try {
			return JSON.stringify(JSON.parse(message.body), null, 2);
		} catch {
			return message.body;
		}
	}

	const YOAL_HEADERS: Record<string, string> = {
		'nats-msg-id': 'id',
		'yoal-content-type': 'type',
		'yoal-attempts': 'attempts'
	};

	function remove(message: PeekedMessage) {
		const target = stream;
		if (!target) return;
		askConfirm({
			title: `Delete message ${message.seq}?`,
			description: 'It is removed from the stream for good; no consumer will see it.',
			confirmLabel: 'Delete message',
			tone: 'danger',
			action: '?/deleteMessage',
			fields: { stream: target, seq: String(message.seq) },
			onResult: (result) => {
				if (result.type !== 'success') return;
				messages = messages.filter((item) => item.seq !== message.seq);
				total = Math.max(0, total - 1);
			}
		});
	}
</script>

<Sheet.Root open={stream !== null} onOpenChange={(open) => !open && (stream = null)}>
	<Sheet.Content class="w-full gap-0 sm:max-w-xl">
		{#if stream}
			<Sheet.Header class="border-b">
				<Sheet.Title class="font-mono text-base">{label ?? stream}</Sheet.Title>
				<Sheet.Description>
					{#if loaded === stream}
						{total} message{total === 1 ? '' : 's'} held{label ? ` · ${stream}` : ''}. Peeking does not consume
						them.
					{:else}
						Reading messages on the broker's node…
					{/if}
				</Sheet.Description>
				<div>
					<Button variant="outline" size="sm" disabled={loading} onclick={() => stream && load(stream)}>
						{#if loading}<Spinner />{:else}<RefreshCwIcon />{/if}
						Refresh
					</Button>
				</div>
			</Sheet.Header>
			<ScrollArea class="min-h-0 flex-1">
				<div class="space-y-3 p-4">
					{#if loaded === stream && messages.length === 0}
						<EmptyState icon={InboxIcon} title="Empty" description="No messages are waiting in this stream." />
					{/if}
					{#each messages as message (message.seq)}
						{@const body = pretty(message)}
						<article class="rounded-lg border">
							<header class="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
								<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
									<span class="font-mono font-medium">#{message.seq}</span>
									{#if message.time}
										<time class="text-muted-foreground" datetime={message.time}>{formatDateTime(message.time)}</time>
									{/if}
									<span class="text-muted-foreground">{formatBytes(message.size)}</span>
									{#each Object.entries(message.headers) as [name, value] (name)}
										{#if YOAL_HEADERS[name]}
											<Badge variant="outline" class="font-mono font-normal">{YOAL_HEADERS[name]}: {value}</Badge>
										{/if}
									{/each}
									{#if message.encoding === 'base64'}<Badge variant="secondary">binary (base64)</Badge>{/if}
								</div>
								<div class="flex items-center gap-1">
									<CopyButton value={message.body} label="body" iconOnly variant="ghost" />
									{#if canDelete}
										<Button variant="ghost" size="icon" class="size-7" aria-label="Delete message {message.seq}" onclick={() => remove(message)}>
											<TrashIcon class="size-3.5" />
										</Button>
									{/if}
								</div>
							</header>
							<pre class="max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">{body}</pre>
							{#if message.truncated}
								<p class="border-t px-3 py-1.5 text-xs text-muted-foreground">
									Showing the first {formatBytes(new TextEncoder().encode(message.body).length)} of {formatBytes(message.size)}.
								</p>
							{/if}
							{#if Object.keys(message.headers).some((name) => !YOAL_HEADERS[name] && name !== 'yoal-timestamp')}
								<details class="border-t px-3 py-1.5 text-xs">
									<summary class="cursor-pointer text-muted-foreground">Headers</summary>
									<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
										{#each Object.entries(message.headers) as [name, value] (name)}
											<dt class="text-muted-foreground">{name}</dt>
											<dd class="break-all">{value}</dd>
										{/each}
									</dl>
								</details>
							{/if}
						</article>
					{/each}
					{#if nextSeq !== null}
						<Button variant="outline" size="sm" class="w-full" disabled={loading} onclick={() => stream && load(stream, nextSeq ?? undefined)}>
							{#if loading}<Spinner />{/if}
							Load more
						</Button>
					{/if}
				</div>
			</ScrollArea>
		{/if}
	</Sheet.Content>
</Sheet.Root>
