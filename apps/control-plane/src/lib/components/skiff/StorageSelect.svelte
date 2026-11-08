<script lang="ts">
	import type { StorageChoices } from '@skiff/contracts';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';

	/**
	 * "Storage" picker on create forms (docs/STORAGE.md §3.3): where the service is stored, chosen
	 * now. It preselects the default from Settings → Storage. Without a saved default the first
	 * option keeps the legacy behaviour (node default volume, else system disk). Hidden when the
	 * system disk is the only choice.
	 */
	let {
		choices,
		id = 'storage-pool',
		name = 'pool',
		value = ''
	}: { choices: StorageChoices | null | undefined; id?: string; name?: string; value?: string } = $props();

	const offered = $derived(choices ? choices.pools.length > 1 : false);
	/** A value posted back after a failed submit wins; otherwise the default pool. */
	const selected = $derived(value || choices?.defaultPool || '');
</script>

{#if choices && offered}
	<Field.Field>
		<Field.Label for={id}>Storage</Field.Label>
		<NativeSelect.Root {id} {name} class="w-full" value={selected}>
			{#if !choices.defaultPool}<NativeSelect.Option value="">Node default volume</NativeSelect.Option>{/if}
			{#each choices.pools as pool (pool.name)}
				<NativeSelect.Option value={pool.name}>
					{pool.name === 'system' ? 'System disk' : pool.name}{pool.classes.length ? ` · ${pool.classes.join(', ')}` : ''}{pool.name === choices.defaultPool ? ' (default)' : ''}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
		<Field.Description>Where its data is stored. Only nodes with a volume in this pool are used; the default comes from Settings → Storage.</Field.Description>
	</Field.Field>
{/if}
