<script lang="ts">
	/**
	 * Metric alerts (docs/ALERTS.md, D108): what is firing now, the org's rules, silences and the
	 * history timeline. Platform admins also get the built-in platform alerts and the notification
	 * channels. The tab lives in `?tab=` so links (and notifications) can open one directly.
	 */
	import {
		alertRuleTemplates,
		type AlertInstanceView,
		type AlertRuleSummary
	} from '@skiff/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BellIcon from '@lucide/svelte/icons/bell';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { errorText } from '#lib/query.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDateTime, formatRelative } from '../_lib/format.js';
	import ConfirmDialog from '../dashboards/_lib/ConfirmDialog.svelte';
	import { createSchemaQuery } from '../dashboards/_lib/panel-query.svelte.js';
	import AlertsNotices from './_lib/AlertsNotices.svelte';
	import { getOverview, keys, listRules } from './_lib/api.js';
	import Channels from './_lib/Channels.svelte';
	import HistoryTimeline from './_lib/HistoryTimeline.svelte';
	import InstancesTable from './_lib/InstancesTable.svelte';
	import { ruleActions } from './_lib/rule-actions.js';
	import RuleMenuItems from './_lib/RuleMenuItems.svelte';
	import {
		matchersFor,
		labelLine,
		querySummary,
		STATE_RANK,
		SEVERITY_RANK,
		valueUnit
	} from './_lib/rules.js';
	import SeverityBadge from './_lib/SeverityBadge.svelte';
	import SilenceDialog, { type SilencePreset } from './_lib/SilenceDialog.svelte';
	import SilencesPanel from './_lib/SilencesPanel.svelte';
	import StateBadge from './_lib/StateBadge.svelte';
	import SystemAlerts from './_lib/SystemAlerts.svelte';
	import {
		ADMIN_ALERT_TABS,
		ALERT_TABS,
		ALERTS_SUBNAV_KEY,
		readAlertTab,
		type AlertTab
	} from './_lib/subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';

	const queryClient = useQueryClient();
	const actions = ruleActions(queryClient);
	const platformAdmin = $derived(page.data.can?.manageNodes === true);

	const overviewQuery = createQuery(() => ({
		queryKey: keys.overview,
		queryFn: ({ signal }) => getOverview(signal),
		refetchInterval: 30_000
	}));
	const rulesQuery = createQuery(() => ({
		queryKey: keys.rules,
		queryFn: ({ signal }) => listRules(signal),
		refetchInterval: 60_000
	}));
	const schemaQuery = createSchemaQuery();

	const overview = $derived(overviewQuery.data);
	const rules = $derived(rulesQuery.data ?? []);
	const schema = $derived(schemaQuery.data);
	const canEdit = $derived(overview?.canEdit ?? false);
	const canSilence = $derived(overview?.canSilence ?? false);

	// --- tabs ------------------------------------------------------------------------------------

	type Tab = AlertTab;
	let tab = $state<Tab>(readAlertTab(page.url.searchParams.get('tab'), true));
	const shown = $derived(ADMIN_ALERT_TABS.has(tab) && !platformAdmin ? 'active' : tab);

	function setTab(next: string) {
		tab = next as Tab;
		const url = new URL(page.url.href);
		if (tab === 'active') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query string changes
		replaceState(`${url.pathname}${url.search}`, {});
	}

	/** The sidebar lists the sections and the counts this page polls for. */
	useSubnavLocal(() => ({
		key: ALERTS_SUBNAV_KEY,
		active: shown,
		counts: {
			active: overview?.active.length,
			rules: rulesQuery.data ? rules.length : undefined,
			silences: overview?.counts.silences
		},
		select: (id) => {
			if (!ALERT_TABS.includes(id as Tab)) return false;
			setTab(id);
			return true;
		}
	}));

	const stats = $derived.by(() => {
		if (!overview) return [];
		const { counts } = overview;
		return [
			{
				label: 'Firing',
				value: counts.firing,
				tone: counts.firing ? 'text-destructive' : '',
				note: ''
			},
			{
				label: 'Pending',
				value: counts.pending,
				tone: counts.pending ? 'text-warning' : '',
				note: ''
			},
			{ label: 'No data', value: counts.nodata, tone: '', note: '' },
			{
				label: 'Rules',
				value: counts.rules,
				tone: '',
				note: [
					counts.paused ? `${counts.paused} paused` : '',
					counts.erroring ? `${counts.erroring} failing` : ''
				]
					.filter(Boolean)
					.join(' · ')
			}
		];
	});

	// A ticking clock for "for 12 min".
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	const unitByRule = $derived(
		new Map(rules.map((rule) => [rule.id, valueUnit(rule.query, schema?.datasets)]))
	);
	const unitOf = (ruleId: string) => unitByRule.get(ruleId) ?? 'short';

	// --- silences ------------------------------------------------------------------------------

	let silenceOpen = $state(false);
	let silencePreset = $state<SilencePreset | null>(null);

	function silence(instance: AlertInstanceView | null) {
		silencePreset = instance
			? {
					ruleId: instance.ruleId,
					matchers: matchersFor(instance.labels),
					subject: `${instance.ruleName}: ${labelLine(instance.labels, instance.labelNames)}`
				}
			: null;
		silenceOpen = true;
	}

	// --- rules table -----------------------------------------------------------------------------

	let search = $state('');

	function newRule(template?: string) {
		const base = resolve('/(dashboard)/alerts/rules/new');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?template`
		void goto(template ? `${base}?template=${encodeURIComponent(template)}` : base);
	}

	function edit(rule: AlertRuleSummary) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?edit`
		void goto(`${resolve('/(dashboard)/alerts/rules/[id]', { id: rule.id })}?edit=1`);
	}

	const columns: DataColumn<AlertRuleSummary>[] = [
		{
			id: 'state',
			header: 'State',
			value: (row) => (row.enabled ? STATE_RANK[row.state] : -1),
			descFirst: true,
			searchable: false,
			cell: stateCell,
			class: 'pl-4 w-0'
		},
		{
			id: 'name',
			header: 'Rule',
			value: (row) => `${row.name} ${row.description}`,
			cell: nameCell
		},
		{
			id: 'severity',
			header: 'Severity',
			value: (row) => SEVERITY_RANK[row.severity],
			descFirst: true,
			searchable: false,
			cell: severityCell,
			class: 'hidden sm:table-cell w-0'
		},
		{
			id: 'query',
			header: 'Query',
			value: (row) => querySummary(row, schema?.datasets),
			sortable: false,
			cell: queryCell,
			class: 'hidden lg:table-cell'
		},
		{
			id: 'health',
			header: 'Health',
			value: (row) => row.health,
			searchable: false,
			cell: healthCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'evaluated',
			header: 'Last evaluated',
			value: (row) => row.lastEvaluatedAt ?? '',
			searchable: false,
			descFirst: true,
			cell: evaluatedCell,
			class: 'hidden text-xs text-muted-foreground xl:table-cell'
		},
		{
			id: 'channels',
			header: 'Channels',
			value: (row) => row.channels.join(' '),
			sortable: false,
			cell: channelsCell,
			class: 'hidden xl:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];
</script>

<svelte:head><title>Alerts · Skiff</title></svelte:head>

{#snippet stateCell(row: AlertRuleSummary)}
	<StateBadge state={row.state} paused={!row.enabled} />
{/snippet}
{#snippet nameCell(row: AlertRuleSummary)}
	<a
		href={resolve('/(dashboard)/alerts/rules/[id]', { id: row.id })}
		class="group/link block min-w-0"
	>
		<span class="font-medium group-hover/link:underline">{row.name}</span>
		{#if row.usesSql}<Badge variant="neutral" class="ml-1.5 align-middle">SQL</Badge>{/if}
		{#if row.counts.firing + row.counts.nodata > 0}
			<span class="ml-1.5 text-xs text-destructive"
				>{row.counts.firing + row.counts.nodata} alerting</span
			>
		{/if}
		{#if row.description}<span class="block max-w-xl truncate text-xs text-muted-foreground"
				>{row.description}</span
			>{/if}
		<span class="block truncate font-mono text-[11px] text-muted-foreground lg:hidden"
			>{querySummary(row, schema?.datasets)}</span
		>
	</a>
{/snippet}
{#snippet severityCell(row: AlertRuleSummary)}<SeverityBadge severity={row.severity} />{/snippet}
{#snippet queryCell(row: AlertRuleSummary)}
	<span class="font-mono text-xs">{querySummary(row, schema?.datasets)}</span>
{/snippet}
{#snippet healthCell(row: AlertRuleSummary)}
	{#if row.health === 'error'}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Badge {...props} variant="danger" tabindex={0}>Error</Badge>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content class="max-w-sm break-words"
				>{row.lastError ?? 'The query failed.'}</Tooltip.Content
			>
		</Tooltip.Root>
	{:else if row.health === 'ok'}
		<Badge variant="success">OK</Badge>
	{:else}
		<Badge variant="neutral" title="Not evaluated yet">Unknown</Badge>
	{/if}
{/snippet}
{#snippet evaluatedCell(row: AlertRuleSummary)}
	<span title={row.lastEvaluatedAt ? formatDateTime(row.lastEvaluatedAt) : 'Never'}
		>{row.lastEvaluatedAt ? formatRelative(row.lastEvaluatedAt) : 'never'}</span
	>
{/snippet}
{#snippet channelsCell(row: AlertRuleSummary)}
	<span class="flex flex-wrap gap-1">
		{#if row.channels.length === 0}
			<Badge variant="outline" class="font-normal text-muted-foreground">All</Badge>
		{:else}
			{#each row.channels as channel (channel)}<Badge variant="secondary">{channel}</Badge>{/each}
		{/if}
		{#if row.emails.length}<Badge variant="outline" class="font-normal"
				>+{row.emails.length} email</Badge
			>{/if}
	</span>
{/snippet}
{#snippet actionsCell(row: AlertRuleSummary)}
	{#if row.canEdit}
		<RowMenu label="Actions for {row.name}">
			<RuleMenuItems rule={row} {actions} onedit={() => edit(row)} />
		</RowMenu>
	{/if}
{/snippet}

{#snippet templateMenu(label: string, variant: 'outline' | 'default')}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} {variant}><LayoutTemplateIcon />{label}<ChevronDownIcon /></Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-80">
			<DropdownMenu.Label>Outage presets</DropdownMenu.Label>
			{#each alertRuleTemplates as template (template.id)}
				<DropdownMenu.Item
					onSelect={() => newRule(template.id)}
					class="flex-col items-start gap-0.5"
				>
					<span class="text-sm">{template.title}</span>
					<span class="text-xs text-muted-foreground">{template.description}</span>
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

<div class="space-y-6">
	<PageHeader
		title="Alerts"
		description="Threshold and outage alerts over your telemetry: a rule checks a metric on a schedule and notifies your channels when it breaches."
		bordered={false}
	>
		{#if canEdit}
			{@render templateMenu('From template', 'outline')}
			<Button onclick={() => newRule()}><PlusIcon />New rule</Button>
		{/if}
	</PageHeader>

	<AlertsNotices
		overview={shown === 'channels' ? undefined : overview}
		{schema}
		onchannels={platformAdmin ? () => setTab('channels') : undefined}
	/>

	{#if overview}
		<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Alert counts">
			{#each stats as stat (stat.label)}
				<div class="rounded-xl border bg-card px-4 py-3">
					<dt class="text-xs text-muted-foreground">{stat.label}</dt>
					<dd class="text-2xl font-semibold tabular-nums {stat.tone}">{stat.value}</dd>
					{#if stat.note}<dd class="text-xs text-muted-foreground">{stat.note}</dd>{/if}
				</div>
			{/each}
		</dl>
	{:else if overviewQuery.isPending}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<Skeleton class="h-[74px]" /><Skeleton class="h-[74px]" /><Skeleton
				class="h-[74px]"
			/><Skeleton class="h-[74px]" />
		</div>
	{/if}

	{#if shown === 'active'}<div class="contents">
			{#if overviewQuery.isPending}
				<div class="space-y-2"><Skeleton class="h-12" /><Skeleton class="h-12" /></div>
			{:else if overviewQuery.error}
				<Notice tone="danger" title="Could not load alerts">{errorText(overviewQuery.error)}</Notice
				>
			{:else if overview && overview.active.length === 0}
				{#if overview.counts.rules === 0}
					<EmptyState
						title="No alert rules yet"
						description="Start from an outage preset (site down, database down, slow responses) or write your own rule. You can also create one from any dashboard panel."
						icon={BellIcon}
					>
						{#if canEdit}
							<Button onclick={() => newRule('site_down')}><LayoutTemplateIcon />Site down</Button>
							<Button variant="outline" onclick={() => newRule('database_down')}
								><LayoutTemplateIcon />Database down</Button
							>
							<Button variant="outline" onclick={() => newRule()}><PlusIcon />Blank rule</Button>
						{/if}
					</EmptyState>
				{:else}
					<EmptyState
						title="All clear"
						description="Nothing is firing, pending or missing data across {overview.counts
							.rules} {overview.counts.rules === 1 ? 'rule' : 'rules'}."
						icon={CircleCheckIcon}
					/>
				{/if}
			{:else if overview}
				<Card.Root class="py-0">
					<InstancesTable
						rows={overview.active}
						{now}
						{canSilence}
						{unitOf}
						onsilence={silence}
						label="Active alerts"
					/>
				</Card.Root>
			{/if}
		</div>{/if}

	{#if shown === 'rules'}<div class="space-y-3">
			<div class="flex flex-wrap items-center gap-2">
				<InputGroup.Root class="w-full sm:w-64">
					<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
					<InputGroup.Input
						bind:value={search}
						placeholder="Search rules"
						aria-label="Search rules"
					/>
				</InputGroup.Root>
			</div>
			{#if rulesQuery.isPending}
				<div class="space-y-2">
					<Skeleton class="h-12" /><Skeleton class="h-12" /><Skeleton class="h-12" />
				</div>
			{:else if rulesQuery.error}
				<Notice tone="danger" title="Could not load alert rules"
					>{errorText(rulesQuery.error)}</Notice
				>
			{:else if rules.length === 0}
				<EmptyState
					title="No alert rules yet"
					description={canEdit
						? 'Pick an outage preset or start from a blank rule.'
						: 'An organisation owner or admin can create alert rules.'}
					icon={BellIcon}
				>
					{#if canEdit}
						{@render templateMenu('From template', 'default')}
						<Button variant="outline" onclick={() => newRule()}><PlusIcon />Blank rule</Button>
					{/if}
				</EmptyState>
			{:else}
				<Card.Root class="py-0">
					<DataTable
						rows={rules}
						{columns}
						rowId={(row) => row.id}
						{search}
						sort={{ id: 'state', desc: true }}
						label="Alert rules"
						rowClass={(row) => (row.enabled ? '' : 'opacity-70')}
					/>
				</Card.Root>
			{/if}
		</div>{/if}

	{#if shown === 'silences'}<div class="contents">
			<SilencesPanel {canSilence} oncreate={() => silence(null)} />
		</div>{/if}

	{#if shown === 'history'}<div class="contents">
			<HistoryTimeline {platformAdmin} />
		</div>{/if}

	{#if platformAdmin}
		{#if shown === 'system'}<div class="contents">
				<SystemAlerts />
			</div>{/if}
		{#if shown === 'channels'}<div class="contents">
				<Channels />
			</div>{/if}
	{/if}
</div>

<SilenceDialog bind:open={silenceOpen} {rules} preset={silencePreset} />
<ConfirmDialog />
