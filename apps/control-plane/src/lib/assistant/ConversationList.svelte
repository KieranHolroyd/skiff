<script lang="ts">
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { assistant, type Conversation } from '#lib/assistant/assistant.svelte.js';
	import { formatRelative } from '#lib/assistant/format.js';
	import { Button } from '#lib/components/ui/button/index.js';

	/** Past conversations in this browser: search, pin, rename, delete. */

	let query = $state('');
	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let confirmClear = $state(false);

	const list = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return assistant.conversations
			.filter((c) => c.messages.length > 0)
			.filter(
				(c) =>
					!q ||
					c.title.toLowerCase().includes(q) ||
					c.messages.some((m) => m.content.toLowerCase().includes(q))
			)
			.sort(
				(a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt
			);
	});

	function preview(conversation: Conversation): string {
		const last = conversation.messages.findLast((m) => m.role === 'assistant' && m.content.trim());
		return (last?.content ?? '')
			.replace(/[*`#>[\]]/g, '')
			.replace(/\s+/g, ' ')
			.slice(0, 110);
	}

	function startRename(conversation: Conversation) {
		renaming = conversation.id;
		renameValue = conversation.title;
	}

	function commitRename() {
		if (renaming) assistant.rename(renaming, renameValue);
		renaming = null;
	}

	function focus(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<div class="flex h-full flex-col">
	<div class="border-b p-3">
		<div class="relative">
			<SearchIcon
				class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				bind:value={query}
				placeholder="Search conversations"
				aria-label="Search conversations"
				class="h-8 w-full rounded-md border bg-background pr-2 pl-8 text-sm outline-none focus:border-ring"
			/>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#if list.length === 0}
			<div class="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
				<MessageSquareIcon class="size-5" />
				{query ? 'No conversation matches.' : 'No conversations yet.'}
			</div>
		{:else}
			<ul class="space-y-0.5">
				{#each list as conversation (conversation.id)}
					<li
						class="group relative rounded-lg {conversation.id === assistant.activeId
							? 'bg-muted'
							: 'hover:bg-muted/60'}"
					>
						{#if renaming === conversation.id}
							<form
								class="p-2"
								onsubmit={(event) => {
									event.preventDefault();
									commitRename();
								}}
							>
								<input
									use:focus
									bind:value={renameValue}
									aria-label="Conversation title"
									class="h-7 w-full rounded border bg-background px-2 text-sm outline-none focus:border-ring"
									onblur={commitRename}
									onkeydown={(event) => {
										if (event.key === 'Escape') {
											event.stopPropagation();
											renaming = null;
										}
									}}
								/>
							</form>
						{:else}
							<button
								type="button"
								class="block w-full px-2.5 py-2 pr-20 text-left"
								onclick={() => assistant.select(conversation.id)}
							>
								<span class="flex items-center gap-1.5">
									{#if conversation.pinned}<PinIcon class="size-3 shrink-0 text-brand" />{/if}
									<span class="truncate text-sm font-medium">{conversation.title}</span>
								</span>
								<span class="mt-0.5 line-clamp-1 text-xs text-muted-foreground"
									>{preview(conversation)}</span
								>
								<span class="text-[10px] text-muted-foreground/70">
									{formatRelative(conversation.updatedAt)} · {conversation.messages.filter(
										(m) => m.role === 'user'
									).length} messages
								</span>
							</button>
							<div
								class="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
							>
								<Button
									variant="ghost"
									size="icon-sm"
									class="size-6"
									title={conversation.pinned ? 'Unpin' : 'Pin'}
									aria-label={conversation.pinned ? 'Unpin' : 'Pin'}
									onclick={() => assistant.togglePin(conversation.id)}
								>
									{#if conversation.pinned}<PinOffIcon class="size-3" />{:else}<PinIcon
											class="size-3"
										/>{/if}
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									class="size-6"
									title="Rename"
									aria-label="Rename"
									onclick={() => startRename(conversation)}
								>
									<PencilIcon class="size-3" />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									class="size-6 hover:text-destructive"
									title="Delete"
									aria-label="Delete conversation"
									onclick={() => assistant.remove(conversation.id)}
								>
									<Trash2Icon class="size-3" />
								</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if list.length > 0}
		<div
			class="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground"
		>
			<span>Stored in this browser only.</span>
			{#if confirmClear}
				<span class="flex items-center gap-2">
					Delete unpinned?
					<button
						type="button"
						class="font-medium text-destructive"
						onclick={() => {
							assistant.clearAll();
							confirmClear = false;
						}}>Delete</button
					>
					<button type="button" onclick={() => (confirmClear = false)}>Keep</button>
				</span>
			{:else}
				<button type="button" class="hover:text-destructive" onclick={() => (confirmClear = true)}
					>Clear history</button
				>
			{/if}
		</div>
	{/if}
</div>
