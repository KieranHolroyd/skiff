<script lang="ts">
	import type { StorageChoices } from '@yoal/contracts';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';

	/**
	 * "Storage" picker on create forms (docs/STORAGE.md §2.2): the system disk, fast disks or bulk
	 * disks, preselected to the default from Settings → Storage. A tier without a ready disk is
	 * listed but disabled. Hidden while the system disk is the only choice.
	 */
	let {
		choices,
		id = 'storage-target',
		name = 'storage',
		value = ''
	}: {
		choices: StorageChoices | null | undefined;
		id?: string;
		name?: string;
		value?: string;
	} = $props();

	const offered = $derived(
		choices
			? choices.targets.some((target) => target.value !== 'system' && target.available) ||
					choices.defaultTarget !== 'system'
			: false
	);
	/** A value posted back after a failed submit wins; otherwise the default. */
	const selected = $derived(value || choices?.defaultTarget || 'system');
</script>

{#if choices && offered}
	<Field.Field>
		<Field.Label for={id}>Storage</Field.Label>
		<NativeSelect.Root {id} {name} class="w-full" value={selected}>
			{#each choices.targets as target (target.value)}
				<NativeSelect.Option
					value={target.value}
					disabled={!target.available && target.value !== selected}
				>
					{target.label}{target.value === choices.defaultTarget
						? ' (default)'
						: ''}{target.available ? '' : ' · none yet'}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
		<Field.Description
			>Where its data is stored. The default comes from Settings → Storage.</Field.Description
		>
	</Field.Field>
{/if}
