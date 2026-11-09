<script lang="ts">
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import * as Table from '#lib/components/ui/table/index.js';

	/**
	 * The DNS the mail node needs under the mail domain (EMAIL.md §3.3, check 6). Shown on Email →
	 * Mail server and in the checklist's reverse DNS step for platform admins.
	 */
	type PlatformRecord = { type: string; name: string; value: string; priority?: number };
	let { records }: { records: PlatformRecord[] } = $props();

	const valueOf = (record: PlatformRecord) =>
		record.priority !== undefined ? `${record.priority} ${record.value}` : record.value;
</script>

<Table.Root>
	<Table.Header class="bg-muted/45">
		<Table.Row>
			<Table.Head class="pl-4">Type</Table.Head>
			<Table.Head>Name</Table.Head>
			<Table.Head class="pr-4">Value</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each records as record (record.type + record.name + record.value)}
			<Table.Row>
				<Table.Cell class="pl-4 font-mono text-xs">{record.type}</Table.Cell>
				<Table.Cell class="max-w-64">
					<span class="flex min-w-0 items-center gap-0.5 font-mono text-xs">
						<span class="truncate" title={record.name}>{record.name}</span>
						<CopyButton
							value={record.name}
							label="Copy name"
							iconOnly
							variant="ghost"
							size="icon-xs"
						/>
					</span>
				</Table.Cell>
				<Table.Cell class="max-w-80 pr-4">
					<span class="flex min-w-0 items-center gap-0.5 font-mono text-xs">
						<span class="truncate" title={valueOf(record)}>{valueOf(record)}</span>
						<CopyButton
							value={valueOf(record)}
							label="Copy value"
							iconOnly
							variant="ghost"
							size="icon-xs"
						/>
					</span>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
