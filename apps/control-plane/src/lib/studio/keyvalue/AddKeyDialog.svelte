<script lang="ts">
	import type { RowChange } from '@yoal/studio/protocol';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { addStringKey } from './changes.js';
	import { parseTtl } from './ttl.js';

	/**
	 * "Add key": a new string key (`SET key value NX [PX ttl]`). The plugin only adds string keys
	 * from the key table; other types are created with the console. `onadd` returns an error to
	 * show, or null once the key exists.
	 */
	let {
		open = $bindable(false),
		prefix,
		onadd
	}: {
		open?: boolean;
		/** The key group's prefix; new keys must start with it. */
		prefix: string;
		onadd: (change: RowChange) => Promise<string | null>;
	} = $props();

	const uid = $props.id();

	let key = $state('');
	let value = $state('');
	let ttl = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	$effect(() => {
		if (!open) return;
		key = prefix;
		value = '';
		ttl = '';
		error = null;
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		if (!key) {
			error = 'Enter a key name.';
			return;
		}
		if (!key.startsWith(prefix)) {
			error = `Keys in this group start with "${prefix}".`;
			return;
		}
		const parsed = parseTtl(ttl);
		if (!parsed.ok) {
			error = parsed.error;
			return;
		}
		saving = true;
		error = null;
		try {
			error = await onadd(addStringKey({ key, value, ttlMs: parsed.ms }));
			if (!error) open = false;
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Add key</Dialog.Title>
				<Dialog.Description>
					Creates a string key. It is not overwritten if it already exists.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-1.5">
				<Label for="kv-add-key-{uid}">Key</Label>
				<Input id="kv-add-key-{uid}" bind:value={key} autocomplete="off" spellcheck="false" class="font-mono" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="kv-add-type-{uid}">Type</Label>
				<NativeSelect.Root id="kv-add-type-{uid}" value="string" disabled aria-describedby="kv-add-type-help-{uid}">
					<NativeSelect.Option value="string">string</NativeSelect.Option>
				</NativeSelect.Root>
				<p id="kv-add-type-help-{uid}" class="text-xs text-muted-foreground">
					Create hashes, lists, sets, sorted sets and streams from the console (HSET, RPUSH, SADD,
					ZADD, XADD).
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="kv-add-value-{uid}">Value</Label>
				<Textarea id="kv-add-value-{uid}" bind:value class="max-h-64 font-mono" spellcheck="false" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="kv-add-ttl-{uid}">TTL (optional)</Label>
				<Input
					id="kv-add-ttl-{uid}"
					bind:value={ttl}
					placeholder="e.g. 30s, 5m, 1h 30m, 2d"
					autocomplete="off"
					aria-describedby="kv-add-ttl-help-{uid}"
				/>
				<p id="kv-add-ttl-help-{uid}" class="text-xs text-muted-foreground">
					Empty means no expiry. A bare number is seconds.
				</p>
			</div>
			{#if error}<Notice tone="danger">{error}</Notice>{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={saving}
					>Cancel</Button
				>
				<Button type="submit" disabled={saving}>
					{#if saving}<Spinner />{/if}
					Add key
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
