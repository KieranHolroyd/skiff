<script lang="ts">
	import { onMount } from 'svelte';
	import type { Column } from '@yoal/studio/protocol';
	import type { EditorKind } from './edit.js';

	/**
	 * The inline editor of one grid cell (plan 22). Enter commits (⌘/Ctrl+Enter for JSON, where
	 * Enter is a newline), Tab commits and moves, Escape cancels.
	 */
	let {
		column,
		editor,
		value = $bindable(),
		error,
		oncommit,
		oncancel
	}: {
		column: Column;
		editor: Exclude<EditorKind, 'boolean'>;
		value: string;
		error: string | null;
		/** `move` is where the selection goes after a Tab commit. */
		oncommit: (move?: 'next' | 'previous') => void;
		oncancel: () => void;
	} = $props();

	let input = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

	onMount(() => {
		input?.focus();
		input?.select();
	});

	function keydown(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			oncancel();
		} else if (event.key === 'Tab') {
			event.preventDefault();
			oncommit(event.shiftKey ? 'previous' : 'next');
		} else if (event.key === 'Enter') {
			if (editor === 'json' && !(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			oncommit();
		}
	}

	const placeholder = $derived(
		editor === 'datetime'
			? column.kind === 'date'
				? 'YYYY-MM-DD'
				: column.kind === 'time' || column.kind === 'interval'
					? column.nativeType
					: '2026-11-06T09:30:00Z'
			: editor === 'number'
				? '0'
				: ''
	);
	const errorId = $props.id();
</script>

<div class="absolute top-0 left-0 z-30 {editor === 'json' ? 'w-[max(100%,22rem)]' : 'w-full'}">
	{#if editor === 'json'}
		<textarea
			bind:this={input}
			bind:value
			onkeydown={keydown}
			aria-label="Edit {column.name} (JSON, ⌘/Ctrl+Enter to save)"
			aria-invalid={error ? true : undefined}
			aria-describedby={error ? errorId : undefined}
			spellcheck={false}
			rows={8}
			class="block w-full resize rounded-sm border border-ring bg-background p-1.5 font-mono text-xs shadow-lg outline-none"
		></textarea>
	{:else}
		<input
			bind:this={input}
			bind:value
			onkeydown={keydown}
			aria-label="Edit {column.name}"
			aria-invalid={error ? true : undefined}
			aria-describedby={error ? errorId : undefined}
			inputmode={editor === 'number' ? 'decimal' : undefined}
			{placeholder}
			spellcheck={false}
			autocomplete="off"
			class="block h-7 w-full rounded-sm border border-ring bg-background px-1.5 text-xs outline-none {editor ===
			'text'
				? ''
				: 'font-mono'}"
		/>
	{/if}
	{#if error}
		<p
			id={errorId}
			role="alert"
			class="mt-0.5 rounded-sm bg-destructive px-1.5 py-0.5 text-[0.6875rem] text-white shadow"
		>
			{error}
		</p>
	{:else if editor === 'json'}
		<p class="mt-0.5 rounded-sm bg-popover px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground shadow">
			⌘/Ctrl+Enter to save · Esc to cancel
		</p>
	{/if}
</div>
