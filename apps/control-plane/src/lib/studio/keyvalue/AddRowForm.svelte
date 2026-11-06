<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { RowChange } from '@skiff/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import {
		addHashField,
		addSetMember,
		addZsetMember,
		appendListItem,
		parseScore,
		type KeyType
	} from './changes.js';

	/**
	 * Add one row inside a key: a hash field, a list item (appended with RPUSH), a set member or a
	 * sorted-set member with its score. Editing and deleting rows happen in the grid.
	 */
	let {
		type,
		onadd
	}: {
		type: Extract<KeyType, 'hash' | 'list' | 'set' | 'zset'>;
		/** Returns an error to show, or null when the row was added. */
		onadd: (change: RowChange) => Promise<string | null>;
	} = $props();

	const uid = $props.id();

	let first = $state('');
	let second = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	const labels = $derived(
		{
			hash: { first: 'Field', second: 'Value', action: 'Add field' },
			list: { first: 'Value', second: '', action: 'Append item' },
			set: { first: 'Member', second: '', action: 'Add member' },
			zset: { first: 'Member', second: 'Score', action: 'Add member' }
		}[type]
	);

	function build(): RowChange | string {
		switch (type) {
			case 'hash':
				return first ? addHashField(first, second) : 'Enter a field name.';
			case 'list':
				return appendListItem(first);
			case 'set':
				return first ? addSetMember(first) : 'Enter a member.';
			case 'zset': {
				if (!first) return 'Enter a member.';
				const score = parseScore(second);
				return score.ok ? addZsetMember(first, score.score) : score.error;
			}
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		const change = build();
		if (typeof change === 'string') {
			error = change;
			return;
		}
		saving = true;
		error = null;
		try {
			error = await onadd(change);
			if (!error) {
				first = '';
				second = '';
			}
		} finally {
			saving = false;
		}
	}
</script>

<form class="flex flex-wrap items-end gap-2" onsubmit={submit} aria-label={labels.action}>
	<div class="flex min-w-40 flex-1 flex-col gap-1">
		<Label for="kv-row-first-{uid}" class="text-xs">{labels.first}</Label>
		<Input id="kv-row-first-{uid}" bind:value={first} class="h-7 font-mono text-xs" autocomplete="off" spellcheck="false" />
	</div>
	{#if labels.second}
		<div class="flex min-w-32 flex-1 flex-col gap-1">
			<Label for="kv-row-second-{uid}" class="text-xs">{labels.second}</Label>
			<Input
				id="kv-row-second-{uid}"
				bind:value={second}
				class="h-7 font-mono text-xs"
				autocomplete="off"
				spellcheck="false"
				inputmode={type === 'zset' ? 'decimal' : undefined}
			/>
		</div>
	{/if}
	<Button type="submit" size="sm" variant="outline" disabled={saving}>
		{#if saving}<Spinner />{:else}<PlusIcon />{/if}
		{labels.action}
	</Button>
	{#if error}<p class="w-full text-xs text-destructive" role="alert">{error}</p>{/if}
</form>
