<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import XIcon from '@lucide/svelte/icons/x';
	import type { EmailRecordCheck } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { recordState } from './email-ui.js';

	/**
	 * A sending domain's DNS records with copy buttons and each record's live check (EMAIL.md §4.2).
	 * The domain page and the overview's checklist show the same table.
	 */
	let { records }: { records: EmailRecordCheck[] } = $props();

	const PURPOSE: Record<string, string> = { dkim: 'DKIM', spf: 'SPF', dmarc: 'DMARC', mx: 'MX' };
	const valueOf = (record: EmailRecordCheck) =>
		record.type === 'MX' && record.priority !== undefined
			? `${record.priority} ${record.value}`
			: record.value;
</script>

<Table.Root>
	<Table.Header class="bg-muted/45">
		<Table.Row>
			<Table.Head class="pl-4">Record</Table.Head>
			<Table.Head>Name</Table.Head>
			<Table.Head>Value</Table.Head>
			<Table.Head class="hidden md:table-cell">Need</Table.Head>
			<Table.Head class="pr-4">Check</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each records as record (record.purpose + record.name)}
			{@const state = recordState(record)}
			<Table.Row class="align-top">
				<Table.Cell class="pl-4">
					<p class="text-sm font-medium">{PURPOSE[record.purpose] ?? record.purpose}</p>
					<p class="font-mono text-xs text-muted-foreground">{record.type}</p>
				</Table.Cell>
				<Table.Cell class="max-w-56">
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
				<Table.Cell class="max-w-80">
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
					{#if record.note}
						<p class="mt-1 text-xs whitespace-normal text-muted-foreground">{record.note}</p>
					{/if}
					{#if !record.ok && record.found.length > 0}
						<p class="mt-1 text-xs whitespace-normal text-muted-foreground">
							Found: <span class="font-mono break-all">{record.found.join(' · ')}</span>
						</p>
					{/if}
				</Table.Cell>
				<Table.Cell class="hidden md:table-cell">
					<Badge variant={record.required ? 'secondary' : 'outline'} class="font-normal">
						{record.required ? 'Required' : 'Recommended'}
					</Badge>
				</Table.Cell>
				<Table.Cell class="pr-4">
					<span class="flex items-center gap-1.5 text-xs">
						{#if state === 'ok'}
							<CheckIcon class="size-4 text-success" aria-hidden="true" />
							<span>Found</span>
						{:else}
							<XIcon
								class="size-4 {state === 'missing' ? 'text-destructive' : 'text-warning'}"
								aria-hidden="true"
							/>
							<span>{state === 'missing' ? 'Missing' : 'Not found'}</span>
						{/if}
						{#if record.managed}
							<CloudIcon
								class="size-3.5 text-muted-foreground"
								aria-label="Managed in Cloudflare"
							/>
						{/if}
					</span>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
