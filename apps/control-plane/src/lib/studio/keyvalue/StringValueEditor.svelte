<script lang="ts">
	import { untrack } from 'svelte';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import type { Cell, ObjectRef } from '@yoal/studio/protocol';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { studioCall } from '../client.js';
	import StudioEditor from '../editor/StudioEditor.svelte';
	import { studioErrorMessage, summarizeApply } from '../document/apply.js';
	import { setStringValue } from './changes.js';
	import { reformatJson, stringValueView } from './keys.js';
	import { formatBytes } from './ttl.js';

	/**
	 * A string key's value. JSON values open in the JSON editor with a "Format JSON" toggle, other
	 * text in a plain text area. Saving is an in-key `update` (`SET … KEEPTTL`) guarded by the
	 * loaded value, so it needs the whole value: a truncated preview loads it through `value`.
	 */
	let {
		database,
		object,
		cell,
		editable,
		onsaved
	}: {
		database: string;
		/** The `key` object. */
		object: ObjectRef;
		/** The value cell from `browse` (a preview past 4 KB). */
		cell: Cell;
		editable: boolean;
		onsaved?: () => void;
	} = $props();

	let full = $state<Cell | undefined>(undefined);
	const current = $derived(full === undefined ? cell : full);
	const view = $derived(stringValueView(current));

	let text = $state('');
	let jsonMode = $state(false);
	let formatted = $state(false);
	let error = $state<string | null>(null);
	let saving = $state(false);
	let loadingFull = $state(false);

	// A newly loaded value replaces the editor's text.
	$effect(() => {
		const shown = view;
		untrack(() => {
			text = shown.kind === 'text' ? shown.text : '';
			jsonMode = shown.kind === 'text' && shown.json;
			formatted = false;
			error = null;
		});
	});
	// A reloaded browse cell supersedes a full value loaded earlier.
	$effect(() => {
		void cell;
		untrack(() => (full = undefined));
	});

	const dirty = $derived(view.kind === 'text' && text !== view.text);

	function toggleFormat() {
		formatted = !formatted;
		text = reformatJson(text, formatted);
	}

	async function loadFull() {
		loadingFull = true;
		error = null;
		try {
			const result = await studioCall(database, 'value', { object, key: {}, column: 'value' });
			full = result.cell;
		} catch (caught) {
			error = studioErrorMessage(caught);
		} finally {
			loadingFull = false;
		}
	}

	async function save() {
		if (saving || view.kind !== 'text' || !dirty) return;
		saving = true;
		error = null;
		try {
			const result = await studioCall(database, 'apply', {
				object,
				changes: [setStringValue(text, current)]
			});
			if (result.conflicts.length > 0) {
				const summary = summarizeApply(result, 1, () => 'Value');
				error = [summary.title, ...summary.details].join(' ');
			} else onsaved?.();
		} catch (caught) {
			error = studioErrorMessage(caught);
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2">
	{#if view.kind === 'missing'}
		<p class="text-sm text-muted-foreground">The key has no value.</p>
	{:else if view.kind === 'binary'}
		<Notice tone="info" title="Binary value">
			This value is not UTF-8 text, so it is shown as base64 and can't be edited here. Use the
			console to change it.
		</Notice>
		<pre class="max-h-96 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs break-all whitespace-pre-wrap">{view.base64}</pre>
	{:else if view.kind === 'truncated'}
		<Notice tone="info" title="Preview only">
			Showing the first part of a {formatBytes(view.bytes)} value.
			{#if full !== undefined}
				It is larger than this session's response limit; read it with GETRANGE in the console.
			{:else}
				Load the full value to read or edit it.
			{/if}
		</Notice>
		{#if full === undefined}
			<div>
				<Button size="sm" variant="outline" onclick={loadFull} disabled={loadingFull}>
					{#if loadingFull}<Spinner />{/if}
					Load full value
				</Button>
			</div>
		{/if}
		<pre class="max-h-96 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs break-all whitespace-pre-wrap">{view.preview}…</pre>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			{#if jsonMode}
				<Button
					size="sm"
					variant="outline"
					aria-pressed={formatted}
					onclick={toggleFormat}
					title="Pretty-print or compact the JSON"
				>
					<BracesIcon />
					Format JSON
				</Button>
				<span class="text-xs text-muted-foreground">JSON value · saving writes the text as shown</span>
			{:else}
				<span class="text-xs text-muted-foreground">Text value</span>
			{/if}
			{#if editable}
				<div class="ml-auto flex items-center gap-2">
					{#if dirty}
						<Button
							size="sm"
							variant="ghost"
							onclick={() => {
								text = view.kind === 'text' ? view.text : text;
								formatted = false;
							}}
							disabled={saving}>Revert</Button
						>
					{/if}
					<Button size="sm" onclick={save} disabled={saving || !dirty}>
						{#if saving}<Spinner />{/if}
						Save value
					</Button>
				</div>
			{/if}
		</div>
		{#if jsonMode}
			<StudioEditor
				bind:value={text}
				language="mongo"
				readOnly={!editable}
				onrun={() => void save()}
				class="min-h-64 w-full flex-1 rounded-md border p-2"
			/>
		{:else}
			<Textarea
				bind:value={text}
				readonly={!editable}
				aria-label="Value"
				spellcheck="false"
				class="min-h-64 flex-1 font-mono text-xs [field-sizing:fixed]"
			/>
		{/if}
	{/if}
	{#if error}<Notice tone="danger">{error}</Notice>{/if}
</div>
