<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import type { SchemaChangeInput, StudioInfo } from '@skiff/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { commonTypes, emptyColumn, starterColumns, tableChange, type ColumnDraft } from './changes.js';

	/**
	 * A new table: its schema (engines with a schema level), name, columns and primary key. Each
	 * column row has a name, type (with suggestions), NULL, identity and an optional default.
	 */
	let {
		open = $bindable(false),
		dialect,
		schemas,
		schema = null,
		onsubmit
	}: {
		open?: boolean;
		dialect: StudioInfo['capabilities']['dialect'];
		/** Schemas to choose from; empty when the engine has no schema level. */
		schemas: string[];
		/** The schema to start in. */
		schema?: string | null;
		onsubmit: (change: SchemaChangeInput) => void;
	} = $props();

	const uid = $props.id();
	type Row = ColumnDraft & { key: boolean };
	let parent = $state('');
	let name = $state('');
	let rows = $state<Row[]>([]);
	let error = $state<string | null>(null);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			parent = schema && schemas.includes(schema) ? schema : (schemas.includes('public') ? 'public' : (schemas[0] ?? ''));
			name = '';
			rows = starterColumns(dialect).map((column) => ({ ...column, key: true }));
			error = null;
		}
		wasOpen = open;
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (schemas.length > 0 && !parent) return void (error = 'Choose a schema.');
		const snapshot = $state.snapshot(rows) as Row[];
		const result = tableChange({
			parent: schemas.length > 0 ? [parent] : [],
			name,
			columns: snapshot.map(({ key: _key, ...column }) => column),
			primaryKey: snapshot.filter((row) => row.key).map((row) => row.name.trim())
		});
		if (!result.ok) return void (error = result.error);
		open = false;
		onsubmit(result.value);
	}
</script>

<datalist id="table-types-{uid}">
	{#each commonTypes(dialect) as type (type)}<option value={type}></option>{/each}
</datalist>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>New table</Dialog.Title>
				<Dialog.Description>
					Indexes and foreign keys can be added afterwards from the table's Structure tab, or with SQL.
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-wrap gap-3">
				{#if schemas.length > 0}
					<div class="space-y-1.5">
						<Label for="table-schema-{uid}">Schema</Label>
						<NativeSelect.Root id="table-schema-{uid}" bind:value={parent}>
							{#each schemas as option (option)}
								<NativeSelect.Option value={option}>{option}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
				{/if}
				<div class="min-w-48 flex-1 space-y-1.5">
					<Label for="table-name-{uid}">Name</Label>
					<Input id="table-name-{uid}" bind:value={name} autocomplete="off" spellcheck={false} class="font-mono" />
				</div>
			</div>

			<div class="overflow-x-auto rounded-md border">
				<table class="w-full text-xs">
					<caption class="sr-only">Columns of the new table</caption>
					<thead class="bg-muted text-left">
						<tr>
							<th scope="col" class="px-2 py-1.5 font-medium">Name</th>
							<th scope="col" class="px-2 py-1.5 font-medium">Type</th>
							<th scope="col" class="px-2 py-1.5 font-medium">NULL</th>
							<th scope="col" class="px-2 py-1.5 font-medium">Key</th>
							<th scope="col" class="px-2 py-1.5 font-medium">{dialect === 'postgres' ? 'Identity' : 'Auto inc.'}</th>
							<th scope="col" class="px-2 py-1.5 font-medium">Default</th>
							<th scope="col"><span class="sr-only">Remove</span></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row, index (index)}
							{@const n = index + 1}
							<tr class="border-t">
								<td class="p-1.5">
									<Input bind:value={row.name} aria-label="Column {n} name" autocomplete="off" spellcheck={false} class="h-8 min-w-28 font-mono" />
								</td>
								<td class="p-1.5">
									<Input
										bind:value={row.type}
										list="table-types-{uid}"
										aria-label="Column {n} type"
										autocomplete="off"
										spellcheck={false}
										class="h-8 min-w-36 font-mono"
									/>
								</td>
								<td class="p-1.5 text-center">
									<Checkbox bind:checked={row.nullable} aria-label="Column {n} allows NULL" disabled={row.key || row.identity} />
								</td>
								<td class="p-1.5 text-center">
									<Checkbox bind:checked={row.key} aria-label="Column {n} is in the primary key" />
								</td>
								<td class="p-1.5 text-center">
									<Checkbox bind:checked={row.identity} aria-label="Column {n} is generated" />
								</td>
								<td class="p-1.5">
									<div class="flex gap-1">
										<NativeSelect.Root size="sm" aria-label="Column {n} default" bind:value={row.defaultMode} disabled={row.identity}>
											<NativeSelect.Option value="none">None</NativeSelect.Option>
											<NativeSelect.Option value="literal">Value</NativeSelect.Option>
											<NativeSelect.Option value="expression">Expression</NativeSelect.Option>
										</NativeSelect.Root>
										{#if row.defaultMode !== 'none' && !row.identity}
											<Input
												bind:value={row.defaultText}
												aria-label="Column {n} default {row.defaultMode === 'literal' ? 'value' : 'expression'}"
												autocomplete="off"
												spellcheck={false}
												class="h-8 min-w-28 font-mono"
												placeholder={row.defaultMode === 'literal' ? 'value' : 'now()'}
											/>
										{/if}
									</div>
								</td>
								<td class="p-1.5">
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Remove column {n}"
										disabled={rows.length === 1}
										onclick={() => (rows = rows.filter((_, at) => at !== index))}><XIcon /></Button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={rows.length >= 500}
					onclick={() => (rows = [...rows, { ...emptyColumn(), key: false }])}><PlusIcon />Add column</Button
				>
			</div>

			{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit">Review</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
