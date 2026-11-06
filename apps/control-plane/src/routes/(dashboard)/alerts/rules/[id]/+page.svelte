<script lang="ts">
	/**
	 * One alert rule: state and actions, its metric over the last 6 hours with the threshold, its
	 * series (with acknowledge and silence), the rule's settings and its history. `?edit=1` swaps
	 * the body for the rule editor.
	 */
	import type { AlertInstanceView, AlertRuleSpec, AlertRuleView } from '@skiff/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { HttpError, errorText } from '#lib/query.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import PageHeader from '../../../_lib/PageHeader.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatDateTime, formatRelative } from '../../../_lib/format.js';
	import ConfirmDialog from '../../../dashboards/_lib/ConfirmDialog.svelte';
	import { createSchemaQuery } from '../../../dashboards/_lib/panel-query.svelte.js';
	import AlertsNotices from '../../_lib/AlertsNotices.svelte';
	import { getOverview, getRule, keys } from '../../_lib/api.js';
	import HistoryTimeline from '../../_lib/HistoryTimeline.svelte';
	import InstancesTable from '../../_lib/InstancesTable.svelte';
	import { ruleActions } from '../../_lib/rule-actions.js';
	import RuleChart from '../../_lib/RuleChart.svelte';
	import RuleEditor from '../../_lib/RuleEditor.svelte';
	import RuleMenuItems from '../../_lib/RuleMenuItems.svelte';
	import {
		NO_DATA_MODES,
		durationText,
		labelLine,
		matchersFor,
		querySummary,
		specOf,
		STATE_RANK,
		valueUnit
	} from '../../_lib/rules.js';
	import SeverityBadge from '../../_lib/SeverityBadge.svelte';
	import SilenceDialog, { type SilencePreset } from '../../_lib/SilenceDialog.svelte';
	import StateBadge from '../../_lib/StateBadge.svelte';

	const queryClient = useQueryClient();
	const actions = ruleActions(queryClient);
	const id = $derived(page.params.id ?? '');
	const editMode = $derived(page.url.searchParams.get('edit') === '1');
	const platformAdmin = $derived(page.data.can?.manageNodes === true);

	const ruleQuery = createQuery(() => ({
		queryKey: keys.rule(id),
		queryFn: ({ signal }) => getRule(id, signal),
		// No background refreshes while editing: the editor saves against the version it opened.
		refetchInterval: editMode ? false : 30_000,
		refetchOnWindowFocus: !editMode
	}));
	const overviewQuery = createQuery(() => ({
		queryKey: keys.overview,
		queryFn: ({ signal }) => getOverview(signal),
		refetchInterval: 60_000
	}));
	const schemaQuery = createSchemaQuery();

	const rule = $derived(ruleQuery.data);
	const overview = $derived(overviewQuery.data);
	const schema = $derived(schemaQuery.data);
	const notFound = $derived(ruleQuery.error instanceof HttpError && ruleQuery.error.status === 404);

	/** The spec and version the editor opened with (not live: a refetch must not move them). */
	let editing = $state<{ spec: AlertRuleSpec; version: number } | null>(null);
	$effect(() => {
		if (!editMode) editing = null;
		else if (!editing && rule) editing = { spec: specOf(rule), version: rule.version };
	});

	const instances = $derived(
		[...(rule?.instances ?? [])].sort(
			(a, b) =>
				STATE_RANK[b.state] - STATE_RANK[a.state] || a.fingerprint.localeCompare(b.fingerprint)
		)
	);
	const unit = $derived(rule ? valueUnit(rule.query, schema?.datasets) : 'short');

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	let silenceOpen = $state(false);
	let silencePreset = $state<SilencePreset | null>(null);

	function silence(instance: AlertInstanceView | null) {
		if (!rule) return;
		silencePreset = instance
			? {
					ruleId: rule.id,
					matchers: matchersFor(instance.labels),
					subject: `${rule.name}: ${labelLine(instance.labels, instance.labelNames)}`
				}
			: { ruleId: rule.id, matchers: [], subject: `every series of ${rule.name}` };
		silenceOpen = true;
	}

	function startEdit() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?edit`
		void goto(`${resolve('/(dashboard)/alerts/rules/[id]', { id })}?edit=1`);
	}

	function stopEdit() {
		editing = null;
		void goto(resolve('/(dashboard)/alerts/rules/[id]', { id }), { replaceState: true });
	}

	function saved(next: AlertRuleView) {
		queryClient.setQueryData(keys.rule(next.id), next);
		void queryClient.invalidateQueries({ queryKey: keys.all });
		stopEdit();
	}

	function deleted() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?tab`
		void goto(`${resolve('/(dashboard)/alerts')}?tab=rules`, { replaceState: true });
	}

	const noData = $derived(NO_DATA_MODES.find((mode) => mode.value === rule?.noData));
	const channelText = $derived.by(() => {
		if (!rule) return '';
		const names = rule.channels.length
			? rule.channels
					.map((name) => overview?.channels.find((item) => item.name === name)?.label ?? name)
					.join(', ')
			: 'All configured channels';
		return rule.emails.length ? `${names}, plus ${rule.emails.join(', ')}` : names;
	});
	const isUrl = (text: string) => /^https?:\/\/\S+$/.test(text.trim());
</script>

<svelte:head><title>{rule?.name ?? 'Alert rule'} · Alerts · Skiff</title></svelte:head>

{#if ruleQuery.isPending}
	<div class="space-y-6">
		<Skeleton class="h-20" /><Skeleton class="h-80" /><Skeleton class="h-48" />
	</div>
{:else if notFound}
	<EmptyState
		title="Alert rule not found"
		description="It may have been deleted, or it belongs to another organisation."
		icon={BellOffIcon}
	>
		<Button href={resolve('/(dashboard)/alerts')} variant="outline">Back to alerts</Button>
	</EmptyState>
{:else if ruleQuery.error || !rule}
	<Notice tone="danger" title="Could not load the alert rule">{errorText(ruleQuery.error)}</Notice>
{:else if editMode}
	<div class="space-y-6">
		<PageHeader
			title="Edit “{rule.name}”"
			description="Changing the query or pausing the rule starts its series over."
		/>
		{#if editing}
			{#key editing.version}
				<RuleEditor
					initial={editing.spec}
					ruleId={rule.id}
					version={editing.version}
					{overview}
					{schema}
					oncancel={stopEdit}
					onsaved={saved}
				/>
			{/key}
		{/if}
	</div>
{:else}
	<div class="space-y-6">
		<PageHeader title={rule.name} description={rule.description || undefined}>
			{#snippet meta()}
				<div class="flex flex-wrap items-center gap-2">
					<StateBadge state={rule.state} paused={!rule.enabled} />
					<SeverityBadge severity={rule.severity} />
					{#if rule.health === 'error'}<Badge variant="danger">Query failing</Badge>{/if}
					<span class="font-mono text-xs text-muted-foreground"
						>{querySummary(rule, schema?.datasets)}</span
					>
				</div>
			{/snippet}
			{#if overview?.canSilence}
				<Button variant="outline" onclick={() => silence(null)}><BellOffIcon />Silence</Button>
			{/if}
			{#if rule.canEdit}
				<Button onclick={startEdit}><PencilIcon />Edit</Button>
				<RowMenu label="More actions for {rule.name}">
					<RuleMenuItems {rule} {actions} onedit={startEdit} ondeleted={deleted} showEdit={false} />
				</RowMenu>
			{/if}
		</PageHeader>

		<AlertsNotices {overview} {schema} />

		{#if rule.health === 'error' && rule.lastError}
			<Notice tone="danger" title="The rule’s query is failing">
				{rule.lastError} Series keep their last state until it works again.
			</Notice>
		{/if}
		{#if !rule.enabled}
			<Notice tone="info" title="Paused"
				>This rule is not evaluated and sends nothing until it is resumed.</Notice
			>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2 text-sm"
					><ActivityIcon class="size-4 text-brand" />Last 6 hours</Card.Title
				>
				<Card.Description
					>The dashed red line is the threshold. The rule reads a {durationText(rule.windowSeconds)} window
					each time, so the chart’s buckets can differ from what it compares.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				{#key `${rule.id}:${rule.version}`}
					<RuleChart {rule} {schema} />
				{/key}
			</Card.Content>
		</Card.Root>

		<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<section class="min-w-0 space-y-3" aria-labelledby="series-heading">
				<div class="flex flex-wrap items-baseline gap-2">
					<h2 id="series-heading" class="text-sm font-medium">Series</h2>
					<span class="text-xs text-muted-foreground"
						>{rule.lastEvaluatedAt
							? `Evaluated ${formatRelative(rule.lastEvaluatedAt)}`
							: 'Not evaluated yet'}</span
					>
				</div>
				{#if instances.length === 0}
					<EmptyState
						compact
						icon={ActivityIcon}
						title="No series yet"
						description={rule.enabled
							? 'Series appear after the next evaluation.'
							: 'Resume the rule to evaluate it.'}
					/>
				{:else}
					<Card.Root class="py-0">
						<InstancesTable
							rows={instances}
							{now}
							canSilence={overview?.canSilence ?? false}
							unitOf={() => unit}
							onsilence={silence}
							showRule={false}
							label="Series of {rule.name}"
						/>
					</Card.Root>
				{/if}
			</section>

			<Card.Root>
				<Card.Header><Card.Title class="text-sm">Settings</Card.Title></Card.Header>
				<Card.Content>
					<dl class="grid gap-3 text-sm">
						<div>
							<dt class="text-xs text-muted-foreground">Checks</dt>
							<dd>
								Every {durationText(rule.intervalSeconds)}, over the last {durationText(
									rule.windowSeconds
								)}
							</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Fires after</dt>
							<dd>{rule.forSeconds ? durationText(rule.forSeconds) : 'The first breach'}</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Resolves after</dt>
							<dd>
								{rule.keepFiringSeconds
									? `Clear for ${durationText(rule.keepFiringSeconds)}`
									: 'The first clear check'}
							</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">No data</dt>
							<dd>{noData?.label ?? rule.noData}</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Notifies</dt>
							<dd class="break-words">{channelText}</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Reminders</dt>
							<dd>
								{rule.repeatMinutes
									? `Every ${durationText(rule.repeatMinutes * 60)} while firing`
									: 'Once'}{rule.notifyOnResolve ? ', and when resolved' : ''}
							</dd>
						</div>
						{#if rule.runbook}
							<div>
								<dt class="text-xs text-muted-foreground">Runbook</dt>
								<dd class="break-words whitespace-pre-line">
									{#if isUrl(rule.runbook)}
										<!-- eslint-disable svelte/no-navigation-without-resolve -- external runbook link -->
										<a
											href={rule.runbook.trim()}
											target="_blank"
											rel="noopener noreferrer"
											class="text-brand hover:underline">{rule.runbook}</a
										>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{:else}{rule.runbook}{/if}
								</dd>
							</div>
						{/if}
						{#if Object.keys(rule.variables).length}
							<div>
								<dt class="text-xs text-muted-foreground">Variables</dt>
								<dd class="font-mono text-xs break-words">
									{Object.entries(rule.variables)
										.map(
											([name, value]) =>
												`$${name}=${Array.isArray(value) ? value.join('|') : value}`
										)
										.join(' ')}
								</dd>
							</div>
						{/if}
						{#if rule.source}
							<div>
								<dt class="text-xs text-muted-foreground">Made from</dt>
								<dd>
									<a
										href={resolve('/(dashboard)/dashboards/[id]', { id: rule.source.dashboardId })}
										class="inline-flex items-center gap-1 text-brand hover:underline"
										><LayoutDashboardIcon class="size-3.5" />Dashboard panel</a
									>
								</dd>
							</div>
						{/if}
						<div>
							<dt class="text-xs text-muted-foreground">Created</dt>
							<dd>
								{formatDateTime(rule.createdAt)}{rule.createdByName
									? ` by ${rule.createdByName}`
									: ''}
							</dd>
						</div>
					</dl>
				</Card.Content>
			</Card.Root>
		</div>

		<section class="space-y-3" aria-labelledby="history-heading">
			<h2 id="history-heading" class="text-sm font-medium">History</h2>
			<HistoryTimeline rule={rule.id} {platformAdmin} pageSize={30} />
		</section>
	</div>

	<SilenceDialog
		bind:open={silenceOpen}
		rules={[{ id: rule.id, name: rule.name }]}
		preset={silencePreset}
	/>
{/if}

<ConfirmDialog />
