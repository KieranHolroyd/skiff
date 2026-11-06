<script lang="ts">
	import { page } from '$app/state';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SquarePenIcon from '@lucide/svelte/icons/square-pen';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { assistant, type AssistantMessage } from '#lib/assistant/assistant.svelte.js';
	import ChatMessage from '#lib/assistant/ChatMessage.svelte';
	import Composer, { type SlashCommand } from '#lib/assistant/Composer.svelte';
	import ConversationList from '#lib/assistant/ConversationList.svelte';
	import { formatRelative } from '#lib/assistant/format.js';
	import { collectPageContext } from '#lib/assistant/page-context.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import type { AssistantPageContext, AssistantStatus } from '@skiff/contracts';

	let { status }: { status: AssistantStatus } = $props();

	let composer = $state<ReturnType<typeof Composer> | null>(null);
	let draft = $state<HTMLTextAreaElement | null>(null);
	let scroller = $state<HTMLDivElement | null>(null);
	let content = $state<HTMLDivElement | null>(null);
	let stick = $state(true);
	let unseen = $state(false);
	let showHelp = $state(false);
	let desktop = $state(false);

	const path = $derived(page.url.pathname);
	const pageLabel = $derived(
		assistant.prefs.includePage
			? path === '/'
				? 'This page: overview'
				: `This page: ${path.slice(1)}`
			: 'Page hidden'
	);

	const suggestions = $derived.by(() => {
		if (/^\/projects\/[^/]+/.test(path)) {
			return [
				'What is deployed right now, and is anything failing?',
				'Show me the latest errors in the logs for this project.',
				'Walk me through rolling back production.',
				'Is this project attached to a database or storage?'
			];
		}
		if (path.startsWith('/databases')) {
			return [
				'Which databases are close to their storage budget?',
				'How do I attach a database to an app?'
			];
		}
		if (path.startsWith('/storage')) {
			return ['Which buckets are public?', 'How do I give an app a scoped bucket key?'];
		}
		if (path.startsWith('/nodes')) {
			return ['Is the fleet healthy?', 'How much workload budget is free on each node?'];
		}
		if (path.startsWith('/audit')) {
			return ['Summarise what changed in the last 24 hours.', 'Who deployed most recently?'];
		}
		return [
			'What needs my attention right now?',
			'Which projects failed their last deploy?',
			'Where do I deploy a new site?',
			'Point me at the audit log.'
		];
	});

	const recent = $derived(
		assistant.conversations
			.filter((c) => c.messages.length > 0 && c.id !== assistant.activeId)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 3)
	);

	const latestTurn = $derived(assistant.messages.findLast((m) => m.role === 'user')?.turnId);

	function context(): AssistantPageContext {
		return assistant.prefs.includePage ? collectPageContext() : { path: '', targets: [] };
	}

	function endOfTurn(message: AssistantMessage, index: number): boolean {
		const next = assistant.messages[index + 1];
		return message.role === 'assistant' && (!next || next.turnId !== message.turnId);
	}

	async function send(text: string) {
		stick = true;
		void assistant.send(text, context());
		await tick();
		scrollToBottom('smooth');
	}

	function retry(turnId: string) {
		stick = true;
		assistant.retry(turnId, context());
	}

	function edit(message: AssistantMessage) {
		assistant.editingTurn = message.turnId;
		composer?.load(message.content);
	}

	function download() {
		const markdown = assistant.exportMarkdown();
		if (!markdown) return;
		const blob = new Blob([markdown], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${(assistant.active?.title ?? 'conversation').replace(/[^\w-]+/g, '-').slice(0, 60)}.md`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}

	function command(cmd: SlashCommand) {
		if (cmd.prompt) return void send(cmd.prompt);
		switch (cmd.id) {
			case 'new':
				assistant.newConversation();
				break;
			case 'history':
				assistant.view = 'history';
				break;
			case 'retry': {
				const turn = latestTurn;
				if (turn) retry(turn);
				break;
			}
			case 'clear':
				assistant.clearActive();
				break;
			case 'export':
				download();
				break;
			case 'help':
				showHelp = true;
				break;
		}
	}

	function onnavigate() {
		// On a phone the panel covers the page the link opened.
		if (!desktop) assistant.close();
	}

	// --- scrolling: follow the stream only while the reader is at the bottom ----------------------

	function scrollToBottom(behavior: ScrollBehavior = 'auto') {
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
		unseen = false;
	}

	function onscroll() {
		if (!scroller) return;
		stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		if (stick) unseen = false;
	}

	$effect(() => {
		if (!content) return;
		const observer = new ResizeObserver(() => {
			if (stick) scrollToBottom();
			else unseen = true;
		});
		observer.observe(content);
		return () => observer.disconnect();
	});

	$effect(() => {
		// Opening, switching conversation or returning from history lands at the latest message.
		void assistant.activeId;
		if (assistant.open && assistant.view === 'chat') {
			stick = true;
			tick().then(() => {
				scrollToBottom();
				draft?.focus();
			});
		}
	});

	// --- layout: width and docking -------------------------------------------------------------

	$effect(() => {
		const query = window.matchMedia('(min-width: 1024px)');
		const update = () => (desktop = query.matches);
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	const width = $derived(assistant.prefs.wide ? 640 : 440);
	const docked = $derived(assistant.open && assistant.prefs.docked && desktop);

	$effect(() => {
		const root = document.documentElement;
		root.classList.toggle('skiff-assistant-docked', docked);
		root.style.setProperty('--skiff-assistant-width', `${width}px`);
		return () => root.classList.remove('skiff-assistant-docked');
	});

	function panelKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !event.defaultPrevented) {
			if (showHelp) showHelp = false;
			else if (assistant.view === 'history') assistant.view = 'chat';
			else if (assistant.sending) assistant.stop();
			else assistant.close();
		}
	}
</script>

{#if assistant.open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside
		class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-popover text-popover-foreground shadow-2xl sm:w-(--panel-width) {docked
			? 'shadow-none'
			: ''}"
		style:--panel-width="{width}px"
		aria-label="Skiff assistant"
		onkeydown={panelKeydown}
		transition:fly={{ x: 40, duration: 180 }}
	>
		<header class="flex items-center gap-2 border-b px-3 py-2.5">
			{#if assistant.view === 'history'}
				<Button
					variant="ghost"
					size="icon-sm"
					title="Back to chat"
					aria-label="Back to chat"
					onclick={() => (assistant.view = 'chat')}
				>
					<ArrowLeftIcon />
				</Button>
				<p class="flex-1 text-sm font-semibold">Conversations</p>
			{:else}
				<div
					class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
				>
					<SparklesIcon class="size-4" />
				</div>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold">
						{assistant.active?.title ?? 'Skiff assistant'}
					</p>
					<p class="truncate font-mono text-[11px] text-muted-foreground">
						{status.model ?? 'not configured'}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					title="Conversations"
					aria-label="Conversations"
					onclick={() => (assistant.view = 'history')}
				>
					<HistoryIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					title="New conversation (/new)"
					aria-label="New conversation"
					disabled={assistant.messages.length === 0 && !assistant.sending}
					onclick={() => assistant.newConversation()}
				>
					<SquarePenIcon />
				</Button>
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon-sm"
							title="More"
							aria-label="More options"
							{...props}
						>
							<EllipsisIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-56">
					<DropdownMenu.CheckboxItem
						checked={assistant.prefs.wide}
						onCheckedChange={(value) => assistant.setPref('wide', value)}
					>
						Wide panel
					</DropdownMenu.CheckboxItem>
					<DropdownMenu.CheckboxItem
						checked={assistant.prefs.docked}
						disabled={!desktop}
						onCheckedChange={(value) => assistant.setPref('docked', value)}
					>
						Dock beside the page
					</DropdownMenu.CheckboxItem>
					<DropdownMenu.CheckboxItem
						checked={assistant.prefs.includePage}
						onCheckedChange={(value) => assistant.setPref('includePage', value)}
					>
						Share current page
					</DropdownMenu.CheckboxItem>
					<DropdownMenu.Separator />
					<DropdownMenu.Item disabled={assistant.messages.length === 0} onSelect={download}>
						Export as Markdown
					</DropdownMenu.Item>
					<DropdownMenu.Item
						disabled={assistant.messages.length === 0}
						onSelect={() => assistant.clearActive()}
					>
						Clear conversation
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => (showHelp = true)}>
						<KeyboardIcon /> Shortcuts
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button
				variant="ghost"
				size="icon-sm"
				title="Close (Esc)"
				aria-label="Close"
				onclick={() => assistant.close()}
			>
				<XIcon />
			</Button>
		</header>

		{#if assistant.view === 'history'}
			<div class="min-h-0 flex-1">
				<ConversationList />
			</div>
		{:else}
			<div class="relative min-h-0 flex-1">
				<div bind:this={scroller} class="h-full overflow-y-auto px-4 py-4" {onscroll}>
					<div bind:this={content}>
						{#if assistant.messages.length === 0}
							<div class="space-y-5 py-4">
								<div class="space-y-1">
									<p class="text-sm font-medium">Ask about this page or your platform.</p>
									<p class="text-sm text-muted-foreground">
										I use the same tools as your MCP agents, can point at things on screen, and
										always ask before changing anything destructive.
									</p>
								</div>
								<div class="space-y-1.5">
									{#each suggestions as suggestion (suggestion)}
										<button
											type="button"
											class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
											onclick={() => send(suggestion)}
										>
											<ChevronRightIcon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
											<span>{suggestion}</span>
										</button>
									{/each}
								</div>
								{#if recent.length > 0}
									<div class="space-y-1.5">
										<p class="text-xs font-medium text-muted-foreground">Recent</p>
										{#each recent as conversation (conversation.id)}
											<button
												type="button"
												class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
												onclick={() => assistant.select(conversation.id)}
											>
												<MessageSquareIcon class="size-3.5 shrink-0 text-muted-foreground" />
												<span class="truncate">{conversation.title}</span>
												<span class="ml-auto shrink-0 text-[10px] text-muted-foreground"
													>{formatRelative(conversation.updatedAt)}</span
												>
											</button>
										{/each}
										<button
											type="button"
											class="px-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
											onclick={() => (assistant.view = 'history')}>All conversations</button
										>
									</div>
								{/if}
							</div>
						{/if}

						<div class="space-y-5">
							{#each assistant.messages as message, index (message.id)}
								<ChatMessage
									{message}
									endOfTurn={endOfTurn(message, index)}
									latestTurn={message.turnId === latestTurn}
									onedit={edit}
									onretry={retry}
									oncontinue={send}
									{onnavigate}
								/>
							{/each}
						</div>
					</div>
				</div>

				{#if unseen && !stick}
					<button
						type="button"
						class="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-md hover:bg-muted"
						onclick={() => {
							stick = true;
							scrollToBottom('smooth');
						}}
					>
						<ArrowDownIcon class="size-3" />
						{assistant.sending ? 'Following reply' : 'New messages'}
					</button>
				{/if}
			</div>

			<div class="border-t p-3">
				<Composer
					bind:this={composer}
					bind:ref={draft}
					{pageLabel}
					onsend={send}
					oncommand={command}
					onescape={() => assistant.close()}
				/>
			</div>
		{/if}

		{#if showHelp}
			<div
				class="absolute inset-0 z-20 flex items-end bg-background/60 backdrop-blur-sm sm:items-center sm:justify-center"
				role="presentation"
				onclick={(event) => event.target === event.currentTarget && (showHelp = false)}
			>
				<div
					class="m-3 w-full max-w-sm rounded-xl border bg-popover p-4 shadow-xl"
					role="dialog"
					aria-label="Shortcuts"
				>
					<div class="mb-3 flex items-center justify-between">
						<p class="text-sm font-semibold">Shortcuts and tips</p>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Close"
							onclick={() => (showHelp = false)}><XIcon /></Button
						>
					</div>
					<dl class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs">
						<dt><Kbd>⌘</Kbd> <Kbd>I</Kbd></dt>
						<dd>Open or close the assistant</dd>
						<dt><Kbd>Enter</Kbd></dt>
						<dd>Send · <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for a new line</dd>
						<dt><Kbd>Esc</Kbd></dt>
						<dd>Stop a reply, cancel an edit, or close</dd>
						<dt><Kbd>↑</Kbd></dt>
						<dd>Edit your last message (empty composer)</dd>
						<dt><Kbd>/</Kbd></dt>
						<dd>Commands: new, history, retry, clear, export, status, tour</dd>
						<dt><Kbd>@</Kbd></dt>
						<dd>Mention a project, database or storage instance</dd>
						<dt><Kbd>⌘</Kbd> <Kbd>Enter</Kbd></dt>
						<dd>Confirm a focused action card</dd>
					</dl>
					<p class="mt-3 text-[11px] text-muted-foreground">
						Conversations are stored in this browser only. Links to dashboard pages open in place.
						Turn off “Share current page” to stop sending the page outline.
					</p>
				</div>
			</div>
		{/if}
	</aside>
{/if}
