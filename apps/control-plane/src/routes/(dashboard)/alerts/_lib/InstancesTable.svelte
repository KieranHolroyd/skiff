<script lang="ts">
	/**
	 * Alert series: state, severity, rule, labels, value and how long it has been active, with
	 * acknowledged and silenced markers. Acknowledge and Silence are on-call actions (owners,
	 * admins and deployers), shown inline rather than in a menu.
	 */
	import type { AlertInstanceView } from '@skiff/contracts';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import { assistant } from '#lib/assistant/assistant.svelte.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { errorText } from '#lib/query.js';
	import { formatDateTime } from '../../_lib/format.js';
	import { formatValue } from '../../dashboards/_lib/units.js';
	import { acknowledge, keys } from './api.js';
	import Labels from './Labels.svelte';
	import { activeFor, alertAskPrompt, labelLine, SEVERITY_RANK, STATE_RANK } from './rules.js';
	import SeverityBadge from './SeverityBadge.svelte';
	import StateBadge from './StateBadge.svelte';

	let {
		rows,
		now,
		canSilence,
		unitOf,
		onsilence,
		showRule = true,
		label = 'Alert series'
	}: {
		rows: AlertInstanceView[];
		/** A ticking clock, for "for 12 min". */
		now: number;
		canSilence: boolean;
		/** Display unit of a rule's value. */
		unitOf: (ruleId: string) => string;
		onsilence: (instance: AlertInstanceView) => void;
		/** Rule and severity columns (off on a rule's own page). */
		showRule?: boolean;
		label?: string;
	} = $props();

	const queryClient = useQueryClient();
	let busy = $state<string | null>(null);

	/** The assistant is optional (Settings → Assistant); the action only exists when it is on. */
	const assistantEnabled = $derived(page.data.assistant?.enabled === true);

	const alerting = (row: AlertInstanceView) => row.state === 'firing' || row.state === 'nodata';

	async function toggleAck(row: AlertInstanceView) {
		const acknowledged = !row.acknowledgedBy;
		busy = `${row.ruleId}:${row.fingerprint}`;
		try {
			const rule = await acknowledge(row.ruleId, row.fingerprint, acknowledged);
			queryClient.setQueryData(keys.rule(rule.id), rule);
			void queryClient.invalidateQueries({ queryKey: keys.all });
			toast.success(
				acknowledged
					? 'Acknowledged: repeat notifications stop until it resolves'
					: 'Acknowledgement removed'
			);
		} catch (error) {
			toast.error(errorText(error, 'Could not update the acknowledgement.'));
		} finally {
			busy = null;
		}
	}

	const columns = $derived<DataColumn<AlertInstanceView>[]>([
		{
			id: 'state',
			header: 'State',
			value: (row) => STATE_RANK[row.state],
			descFirst: true,
			cell: stateCell,
			class: 'pl-4 w-0'
		},
		...(showRule
			? [
					{
						id: 'severity',
						header: 'Severity',
						value: (row: AlertInstanceView) => SEVERITY_RANK[row.severity],
						descFirst: true,
						searchable: false,
						cell: severityCell,
						class: 'hidden md:table-cell w-0'
					},
					{
						id: 'rule',
						header: 'Rule',
						value: (row: AlertInstanceView) => row.ruleName,
						cell: ruleCell
					}
				]
			: []),
		{
			id: 'labels',
			header: 'Series',
			value: (row) => labelLine(row.labels, row.labelNames),
			cell: labelsCell,
			class: showRule ? 'hidden sm:table-cell' : ''
		},
		{
			id: 'value',
			header: 'Value',
			value: (row) => row.value ?? undefined,
			searchable: false,
			descFirst: true,
			cell: valueCell,
			class: 'font-mono text-xs tabular-nums'
		},
		{
			id: 'since',
			header: 'For',
			value: (row) => row.activeSince ?? row.since,
			searchable: false,
			cell: sinceCell,
			class: 'hidden text-xs text-muted-foreground lg:table-cell'
		},
		...(canSilence || assistantEnabled
			? [{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }]
			: [])
	]);
</script>

{#snippet stateCell(row: AlertInstanceView)}
	<span class="flex flex-wrap items-center gap-1">
		<StateBadge state={row.state} />
		{#if row.acknowledgedBy}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Badge {...props} variant="info" tabindex={0}><CheckCheckIcon />Ack</Badge>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content
					>Acknowledged by {row.acknowledgedByName ?? 'someone'}{row.acknowledgedAt
						? ` · ${formatDateTime(row.acknowledgedAt)}`
						: ''}</Tooltip.Content
				>
			</Tooltip.Root>
		{/if}
		{#if row.silencedBy}
			<Badge variant="neutral" title="A silence mutes its notifications"
				><BellOffIcon />Silenced</Badge
			>
		{/if}
	</span>
{/snippet}
{#snippet severityCell(row: AlertInstanceView)}<SeverityBadge severity={row.severity} />{/snippet}
{#snippet ruleCell(row: AlertInstanceView)}
	<a
		href={resolve('/(dashboard)/alerts/rules/[id]', { id: row.ruleId })}
		class="font-medium hover:underline">{row.ruleName}</a
	>
	<Labels labels={row.labels} labelNames={row.labelNames} class="mt-1 sm:hidden" />
{/snippet}
{#snippet labelsCell(row: AlertInstanceView)}<Labels
		labels={row.labels}
		labelNames={row.labelNames}
	/>{/snippet}
{#snippet valueCell(row: AlertInstanceView)}
	<span title={row.value === null ? 'No data in the window' : String(row.value)}
		>{row.value === null ? 'no data' : formatValue(row.value, unitOf(row.ruleId))}</span
	>
{/snippet}
{#snippet sinceCell(row: AlertInstanceView)}
	{#if row.state === 'normal'}
		<span title={row.lastEvaluatedAt}>checked {activeFor(row.lastEvaluatedAt, now)} ago</span>
	{:else}
		<span title={formatDateTime(row.activeSince ?? row.since)}
			>for {activeFor(row.activeSince ?? row.since, now)}</span
		>
	{/if}
{/snippet}
{#snippet actionsCell(row: AlertInstanceView)}
	{@const pending = busy === `${row.ruleId}:${row.fingerprint}`}
	<span class="flex justify-end gap-1">
		{#if assistantEnabled && alerting(row)}
			<Button
				variant="ghost"
				size="sm"
				title="Ask the assistant to explain this alert"
				onclick={() => assistant.ask(alertAskPrompt(row, now, unitOf(row.ruleId)))}
				aria-label="Ask AI about {row.ruleName}: {labelLine(row.labels, row.labelNames)}"
			>
				<SparklesIcon /><span class="hidden xl:inline">Ask AI</span>
			</Button>
		{/if}
		{#if alerting(row) || row.acknowledgedBy}
			<Button
				variant="ghost"
				size="sm"
				disabled={pending}
				onclick={() => toggleAck(row)}
				aria-label="{row.acknowledgedBy
					? 'Remove acknowledgement'
					: 'Acknowledge'} {row.ruleName}: {labelLine(row.labels, row.labelNames)}"
			>
				{#if pending}<Spinner />{:else if row.acknowledgedBy}<UndoIcon />{:else}<CheckCheckIcon
					/>{/if}
				<span class="hidden xl:inline">{row.acknowledgedBy ? 'Unack' : 'Ack'}</span>
			</Button>
		{/if}
		{#if row.state !== 'normal' && !row.silencedBy}
			<Button
				variant="ghost"
				size="sm"
				onclick={() => onsilence(row)}
				aria-label="Silence {row.ruleName}: {labelLine(row.labels, row.labelNames)}"
			>
				<BellOffIcon /><span class="hidden xl:inline">Silence</span>
			</Button>
		{/if}
	</span>
{/snippet}

<DataTable {rows} {columns} rowId={(row) => `${row.ruleId}:${row.fingerprint}`} {label} />
