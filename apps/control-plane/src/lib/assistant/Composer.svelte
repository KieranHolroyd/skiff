<script lang="ts" module>
	export interface SlashCommand {
		id: string;
		label: string;
		description: string;
		/** Sent as a message instead of running a panel action. */
		prompt?: string;
	}

	export const SLASH_COMMANDS: SlashCommand[] = [
		{ id: 'new', label: '/new', description: 'Start a new conversation' },
		{ id: 'history', label: '/history', description: 'Browse past conversations' },
		{ id: 'retry', label: '/retry', description: 'Regenerate the last answer' },
		{ id: 'clear', label: '/clear', description: 'Clear this conversation' },
		{ id: 'export', label: '/export', description: 'Download this conversation as Markdown' },
		{
			id: 'status',
			label: '/status',
			description: 'What needs my attention right now?',
			prompt:
				'What needs my attention right now? Check the fleet, failing deploys and anything close to a limit.'
		},
		{
			id: 'tour',
			label: '/tour',
			description: 'Show me around this page',
			prompt: 'Give me a short guided tour of this page.'
		},
		{ id: 'help', label: '/help', description: 'Keyboard shortcuts and tips' }
	];
</script>

<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import BoxIcon from '@lucide/svelte/icons/box';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import { assistant, MAX_MESSAGE_CHARS } from '#lib/assistant/assistant.svelte.js';
	import { filterMentions, loadMentions, type MentionItem } from '#lib/assistant/mentions.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		pageLabel,
		onsend,
		oncommand,
		onescape,
		ref = $bindable(null)
	}: {
		pageLabel: string;
		onsend: (text: string) => void;
		oncommand: (command: SlashCommand) => void;
		/** Escape with nothing left to dismiss in the composer. */
		onescape: () => void;
		ref?: HTMLTextAreaElement | null;
	} = $props();

	let value = $state('');
	let caret = $state(0);
	let menuIndex = $state(0);
	let menuDismissed = $state(false);
	let mentionItems = $state<MentionItem[]>([]);
	let mentionsLoading = $state(false);

	// Keep the draft with the conversation it belongs to.
	let loadedFor: string | null | undefined = undefined;
	$effect(() => {
		const id = assistant.activeId;
		if (id === loadedFor) return;
		loadedFor = id;
		value = assistant.active?.draft ?? '';
	});
	$effect(() => {
		const text = value;
		const timer = setTimeout(() => assistant.setDraft(text), 300);
		return () => clearTimeout(timer);
	});

	const slashQuery = $derived(/^\/(\w*)$/.exec(value)?.[1]);
	const slashMatches = $derived(
		slashQuery === undefined
			? []
			: SLASH_COMMANDS.filter((command) => command.id.startsWith(slashQuery.toLowerCase()))
	);
	const mentionMatch = $derived(/(^|\s)@([\w.-]*)$/.exec(value.slice(0, caret)));
	const mentionMatches = $derived(
		mentionMatch ? filterMentions(mentionItems, mentionMatch[2] ?? '') : []
	);

	const menu = $derived<'slash' | 'mention' | null>(
		menuDismissed ? null : slashMatches.length > 0 ? 'slash' : mentionMatch ? 'mention' : null
	);
	const menuLength = $derived(
		menu === 'slash' ? slashMatches.length : menu === 'mention' ? mentionMatches.length : 0
	);

	$effect(() => {
		if (menu === 'mention' && mentionItems.length === 0 && !mentionsLoading) {
			mentionsLoading = true;
			loadMentions()
				.then((items) => (mentionItems = items))
				.finally(() => (mentionsLoading = false));
		}
	});

	$effect(() => {
		void menu;
		void menuLength;
		if (menuIndex >= menuLength) menuIndex = 0;
	});

	// Grow with the text up to max-h-48, then scroll.
	$effect(() => {
		void value;
		if (!ref) return;
		ref.style.height = 'auto';
		ref.style.height = `${ref.scrollHeight}px`;
	});

	const over = $derived(value.length > MAX_MESSAGE_CHARS);
	const nearLimit = $derived(value.length > MAX_MESSAGE_CHARS * 0.8);

	function submit() {
		const text = value.trim();
		if (!text || over || assistant.sending) return;
		value = '';
		assistant.setDraft('');
		onsend(text);
	}

	function runCommand(command: SlashCommand) {
		value = '';
		menuDismissed = false;
		oncommand(command);
	}

	async function insertMention(item: MentionItem) {
		if (!mentionMatch) return;
		const start = caret - (mentionMatch[2]?.length ?? 0) - 1;
		const before = value.slice(0, start);
		const after = value.slice(caret);
		const insert = `@${item.name} `;
		value = `${before}${insert}${after}`;
		await tick();
		const position = before.length + insert.length;
		ref?.setSelectionRange(position, position);
		caret = position;
		ref?.focus();
	}

	export function load(text: string) {
		value = text;
		tick().then(() => {
			ref?.focus();
			ref?.setSelectionRange(text.length, text.length);
			caret = text.length;
		});
	}

	function cancelEdit() {
		assistant.editingTurn = null;
		value = '';
	}

	function keydown(event: KeyboardEvent) {
		if (event.isComposing || event.keyCode === 229) return;

		if (menu && menuLength > 0) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : menuLength - 1)) % menuLength;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				if (menu === 'slash') runCommand(slashMatches[menuIndex]!);
				else void insertMention(mentionMatches[menuIndex]!);
				return;
			}
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (assistant.sending) assistant.stop();
			else if (menu) menuDismissed = true;
			else if (assistant.editingTurn) cancelEdit();
			else onescape();
			return;
		}

		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}

		// Up on an empty composer edits the last message, like a terminal.
		if (event.key === 'ArrowUp' && !value && !assistant.sending) {
			const last = assistant.lastPrompt();
			if (last) {
				event.preventDefault();
				assistant.editingTurn = last.turnId;
				load(last.content);
			}
		}
	}

	function input() {
		menuDismissed = false;
		caret = ref?.selectionStart ?? value.length;
	}

	const mentionIcon = { project: BoxIcon, database: DatabaseIcon, storage: HardDriveIcon };
</script>

<div class="relative">
	{#if menu && (menuLength > 0 || menu === 'mention')}
		<div
			class="absolute right-0 bottom-full left-0 z-10 mb-2 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
			role="listbox"
			aria-label={menu === 'slash' ? 'Commands' : 'Mention a resource'}
		>
			{#if menu === 'slash'}
				{#each slashMatches as command, index (command.id)}
					<button
						type="button"
						role="option"
						aria-selected={index === menuIndex}
						class="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm {index ===
						menuIndex
							? 'bg-muted'
							: ''}"
						onmouseenter={() => (menuIndex = index)}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => runCommand(command)}
					>
						<span class="font-mono text-xs font-medium">{command.label}</span>
						<span class="truncate text-xs text-muted-foreground">{command.description}</span>
					</button>
				{/each}
			{:else if mentionsLoading && mentionItems.length === 0}
				<p class="px-2 py-1.5 text-xs text-muted-foreground">
					Loading projects, databases and storage…
				</p>
			{:else if mentionMatches.length === 0}
				<p class="px-2 py-1.5 text-xs text-muted-foreground">
					No matching project, database or storage.
				</p>
			{:else}
				{#each mentionMatches as item, index (`${item.kind}:${item.name}`)}
					{@const Icon = mentionIcon[item.kind]}
					<button
						type="button"
						role="option"
						aria-selected={index === menuIndex}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm {index ===
						menuIndex
							? 'bg-muted'
							: ''}"
						onmouseenter={() => (menuIndex = index)}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => insertMention(item)}
					>
						<Icon class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="truncate font-mono text-xs">{item.name}</span>
						<span class="ml-auto truncate text-[11px] text-muted-foreground"
							>{item.detail ?? item.kind}</span
						>
					</button>
				{/each}
			{/if}
		</div>
	{/if}

	{#if assistant.editingTurn}
		<div class="mb-2 flex items-center gap-2 rounded-md bg-brand/10 px-2 py-1 text-xs text-brand">
			<PencilIcon class="size-3" />
			<span class="flex-1">Editing. Sending replaces that message and everything after it.</span>
			<button
				type="button"
				class="rounded p-0.5 hover:bg-brand/10"
				aria-label="Cancel edit"
				onclick={cancelEdit}
			>
				<XIcon class="size-3" />
			</button>
		</div>
	{/if}

	<div
		class="rounded-xl border bg-background shadow-xs transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
	>
		<textarea
			bind:this={ref}
			bind:value
			rows="1"
			placeholder={assistant.sending
				? 'Type your next message…'
				: 'Ask anything · / for commands · @ to mention'}
			aria-label="Message the assistant"
			class="block max-h-48 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground"
			onkeydown={keydown}
			oninput={input}
			onclick={input}
			onkeyup={input}></textarea>
		<div class="flex items-center gap-1.5 px-2 pb-2">
			<button
				type="button"
				class="inline-flex max-w-[60%] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] {assistant
					.prefs.includePage
					? 'text-muted-foreground hover:text-foreground'
					: 'border-dashed text-muted-foreground/70 line-through'}"
				title={assistant.prefs.includePage
					? 'The assistant sees an outline of this page. Click to stop sharing it.'
					: 'Page context is off. Click to share this page with the assistant.'}
				onclick={() => assistant.setPref('includePage', !assistant.prefs.includePage)}
			>
				{#if assistant.prefs.includePage}
					<FileTextIcon class="size-3 shrink-0" />
				{:else}
					<EyeOffIcon class="size-3 shrink-0" />
				{/if}
				<span class="truncate">{pageLabel}</span>
			</button>
			{#if nearLimit}
				<span class="font-mono text-[10px] {over ? 'text-destructive' : 'text-muted-foreground'}"
					>{value.length.toLocaleString()}/{MAX_MESSAGE_CHARS.toLocaleString()}</span
				>
			{/if}
			<div class="ml-auto">
				{#if assistant.sending}
					<Button
						variant="outline"
						size="icon-sm"
						class="rounded-full"
						title="Stop (Esc)"
						aria-label="Stop generating"
						onclick={() => assistant.stop()}
					>
						<SquareIcon class="size-3 fill-current" />
					</Button>
				{:else}
					<Button
						size="icon-sm"
						class="rounded-full"
						title="Send (Enter)"
						aria-label="Send"
						disabled={!value.trim() || over}
						onclick={submit}
					>
						<ArrowUpIcon />
					</Button>
				{/if}
			</div>
		</div>
	</div>
</div>
