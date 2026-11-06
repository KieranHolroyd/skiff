<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import type { ObjectRef, SchemaChangeInput } from '@skiff/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { indexChange, suggestedIndexName, type IndexDraft } from './changes.js';

	/**
	 * Create an index: columns (or document fields) in order, each ascending or descending, and
	 * whether it is unique. Fields are free text with suggestions, since a document collection
	 * has no fixed list.
	 */
	let {
		open = $bindable(false),
		object,
		fields,
		onsubmit
	}: {
		open?: boolean;
		object: ObjectRef;
		/** Known column or field names, offered as choices. */
		fields: string[];
		onsubmit: (change: SchemaChangeInput) => void;
	} = $props();

	const uid = $props.id();
	let draft = $state<IndexDraft>({ name: '', columns: [], unique: false });
	let error = $state<string | null>(null);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			draft = { name: '', columns: [{ name: '', dir: 'asc' }], unique: false };
			error = null;
		}
		wasOpen = open;
	});

	const table = $derived(object.path.at(-1) ?? '');
	const suggestion = $derived(
		suggestedIndexName(
			table,
			draft.columns.map((column) => column.name.trim()),
			draft.unique
		)
	);

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const result = indexChange(object, $state.snapshot(draft) as IndexDraft);
		if (!result.ok) return void (error = result.error);
		open = false;
		onsubmit(result.value);
	}
</script>

<datalist id="fields-{uid}">
	{#each fields as field (field)}<option value={field}></option>{/each}
</datalist>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Create an index on {table}</Dialog.Title>
				<Dialog.Description>Building an index on a large table can take a while and holds a lock.</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-1.5">
				<Label for="idx-name-{uid}">Name <span class="font-normal text-muted-foreground">(optional)</span></Label>
				<Input id="idx-name-{uid}" bind:value={draft.name} autocomplete="off" spellcheck={false} class="font-mono" placeholder={suggestion} />
			</div>

			<fieldset class="space-y-2">
				<legend class="mb-1.5 text-sm font-medium">Columns, in order</legend>
				{#each draft.columns as column, index (index)}
					<div class="flex items-center gap-2">
						<Input
							bind:value={column.name}
							list="fields-{uid}"
							aria-label="Column {index + 1}"
							autocomplete="off"
							spellcheck={false}
							class="h-8 min-w-0 flex-1 font-mono"
						/>
						<NativeSelect.Root size="sm" aria-label="Direction of column {index + 1}" bind:value={column.dir}>
							<NativeSelect.Option value="asc">Ascending</NativeSelect.Option>
							<NativeSelect.Option value="desc">Descending</NativeSelect.Option>
						</NativeSelect.Root>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							aria-label="Remove column {index + 1}"
							disabled={draft.columns.length === 1}
							onclick={() => (draft.columns = draft.columns.filter((_, at) => at !== index))}><XIcon /></Button
						>
					</div>
				{/each}
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={draft.columns.length >= 32}
					onclick={() => (draft.columns = [...draft.columns, { name: '', dir: 'asc' }])}><PlusIcon />Add column</Button
				>
			</fieldset>

			<div class="flex items-center gap-2">
				<Checkbox id="idx-unique-{uid}" bind:checked={draft.unique} />
				<Label for="idx-unique-{uid}" class="font-normal">Unique</Label>
			</div>

			{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit">Review</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
