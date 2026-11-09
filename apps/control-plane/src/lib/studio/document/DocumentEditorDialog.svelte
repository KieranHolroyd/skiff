<script lang="ts">
	import type { Snippet } from 'svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import StudioEditor from '../editor/StudioEditor.svelte';

	/**
	 * A modal JSON editor for one document (edit or insert). `onsave` returns an error to show
	 * (and keeps the dialog open), or null when the save went through.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		initial,
		saveLabel = 'Save',
		onsave,
		notes
	}: {
		open?: boolean;
		title: string;
		description?: string;
		initial: string;
		saveLabel?: string;
		onsave: (text: string) => Promise<{ error: string; position?: number } | null>;
		notes?: Snippet;
	} = $props();

	let text = $state('');
	let error = $state<string | null>(null);
	let position = $state<number | undefined>(undefined);
	let saving = $state(false);

	// Each opening starts from the document as loaded.
	let openedWith: string | null = null;
	$effect(() => {
		if (!open) {
			openedWith = null;
			return;
		}
		if (openedWith === initial) return;
		openedWith = initial;
		text = initial;
		error = null;
		position = undefined;
	});

	const markers = $derived(
		error && position !== undefined ? [{ position, message: error }] : []
	);

	async function save() {
		if (saving) return;
		saving = true;
		error = null;
		position = undefined;
		try {
			const result = await onsave(text);
			if (result) {
				error = result.error;
				position = result.position;
			} else open = false;
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90vh] flex-col sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-3">
			<StudioEditor
				bind:value={text}
				language="mongo"
				{markers}
				onrun={() => void save()}
				class="h-[50vh] min-h-48 w-full rounded-md border p-2"
			/>
			{#if notes}<div class="text-xs text-muted-foreground">{@render notes()}</div>{/if}
			{#if error}<Notice tone="danger">{error}</Notice>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
			<Button onclick={save} disabled={saving}>
				{#if saving}<Spinner />{/if}
				{saveLabel}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
