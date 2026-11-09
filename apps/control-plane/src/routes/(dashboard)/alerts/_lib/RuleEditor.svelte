<script lang="ts">
	/**
	 * The alert rule editor, for new rules (blank, from a template, from a dashboard panel, or a
	 * duplicate) and for editing a saved one. Validates with the contract's schema before sending,
	 * shows the server's 422 issues inline and a 409 as "reload to see their changes". "Preview"
	 * evaluates the unsaved rule once and lists each series with its value.
	 */
	import {
		alertOperatorSymbols,
		alertOperators,
		alertQueryProblem,
		alertRuleInputSchema,
		alertSeverities,
		type AlertOperator,
		type AlertPreview,
		type AlertRuleSpec,
		type AlertRuleView,
		type AlertsOverview,
		type BuilderSpec,
		type ObservabilitySchema
	} from '@yoal/contracts';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import XIcon from '@lucide/svelte/icons/x';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText } from '#lib/query.js';
	import CodeEditor from '../../dashboards/_lib/CodeEditor.svelte';
	import { formatValue } from '../../dashboards/_lib/units.js';
	import { AlertApiError, createRule, previewRule, updateRule } from './api.js';
	import AlertQueryBuilder from './AlertQueryBuilder.svelte';
	import DurationField from './DurationField.svelte';
	import Labels from './Labels.svelte';
	import {
		NO_DATA_MODES,
		durationText,
		fromDisplayThreshold,
		issueMap,
		querySummary,
		thresholdInput,
		toDisplayThreshold,
		valueUnit
	} from './rules.js';
	import StateBadge from './StateBadge.svelte';

	let {
		initial,
		ruleId,
		version,
		overview,
		schema,
		oncancel,
		onsaved
	}: {
		initial: AlertRuleSpec;
		/** Set when editing a saved rule. */
		ruleId?: string;
		version?: number;
		overview: AlertsOverview | undefined;
		schema: ObservabilitySchema | undefined;
		oncancel: () => void;
		onsaved: (rule: AlertRuleView) => void;
	} = $props();

	const start = untrack(() => JSON.parse(JSON.stringify(initial)) as AlertRuleSpec);
	let spec = $state<AlertRuleSpec>(start);
	let thresholdText = $state(
		String(
			toDisplayThreshold(
				start.condition.threshold,
				untrack(() => valueUnit(start.query, schema?.datasets))
			)
		)
	);
	let emailsText = $state(start.emails.join(', '));
	let sqlText = $state(start.query.mode === 'sql' ? start.query.sql : '');
	/** The builder query to return to after trying SQL. */
	let lastBuilder = $state<BuilderSpec | null>(
		start.query.mode === 'builder' ? start.query.builder : null
	);

	const canSql = $derived(overview?.canUseSql ?? false);
	const canEdit = $derived(overview?.canEdit ?? false);
	const sqlLocked = $derived(spec.query.mode === 'sql' && !canSql);
	const unit = $derived(valueUnit(spec.query, schema?.datasets));
	const scale = $derived(thresholdInput(unit));
	const variableNames = $derived(Object.keys(spec.variables));

	// --- building and validating -------------------------------------------------------------

	let errors = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);
	let conflict = $state(false);
	let saving = $state(false);

	function emails(): string[] {
		return emailsText
			.split(/[\s,;]+/)
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function build(): AlertRuleSpec {
		const snapshot = $state.snapshot(spec) as AlertRuleSpec;
		const typed = Number(thresholdText);
		return {
			...snapshot,
			name: snapshot.name.trim(),
			condition: {
				op: snapshot.condition.op,
				threshold:
					thresholdText.trim() !== '' && Number.isFinite(typed)
						? fromDisplayThreshold(typed, unit)
						: Number.NaN
			},
			emails: emails()
		};
	}

	function validate(next: AlertRuleSpec): Record<string, string> {
		const found: Record<string, string> = {};
		if (!Number.isFinite(next.condition.threshold))
			found['condition.threshold'] = 'Enter a number.';
		const parsed = alertRuleInputSchema.safeParse(next);
		if (!parsed.success) Object.assign(found, { ...issueMap(parsed.error.issues), ...found });
		const problem = alertQueryProblem(next.query);
		if (problem) found.query ??= problem;
		if (next.keepFiringSeconds > 0 && next.keepFiringSeconds < next.intervalSeconds)
			found.keepFiringSeconds ??=
				'Keep firing for at least one evaluation interval, or 0 to resolve straight away.';
		return found;
	}

	/** The first message at a path or below it (`emails` covers `emails.2`). */
	function errorFor(path: string): string | undefined {
		for (const [key, message] of Object.entries(errors)) {
			if (key === path || key.startsWith(`${path}.`)) return message;
		}
		return undefined;
	}

	const KNOWN = [
		'name',
		'description',
		'severity',
		'query',
		'condition',
		'windowSeconds',
		'intervalSeconds',
		'forSeconds',
		'keepFiringSeconds',
		'noData',
		'repeatMinutes',
		'channels',
		'emails',
		'runbook',
		'variables'
	];
	/** Issues no field shows, so they still reach the reader. */
	const stray = $derived(
		Object.entries(errors)
			.filter(([key]) => !KNOWN.some((path) => key === path || key.startsWith(`${path}.`)))
			.map(([key, message]) => (key === 'rule' ? message : `${key}: ${message}`))
	);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		formError = null;
		conflict = false;
		const next = build();
		errors = validate(next);
		if (Object.keys(errors).length > 0) {
			formError = 'Fix the highlighted fields and save again.';
			return;
		}
		saving = true;
		try {
			const rule =
				ruleId && version !== undefined
					? await updateRule(ruleId, { ...next, version })
					: await createRule(next);
			toast.success(ruleId ? 'Rule saved' : 'Rule created');
			onsaved(rule);
		} catch (error) {
			if (error instanceof AlertApiError && error.status === 409) {
				conflict = true;
			} else if (error instanceof AlertApiError && error.status === 422) {
				errors = issueMap(error.issues);
				formError = error.message;
				if (Object.keys(errors).length === 0 && /metric|query/i.test(error.message))
					errors = { query: error.message };
			} else {
				formError = errorText(error, 'Could not save the rule.');
			}
		} finally {
			saving = false;
		}
	}

	// --- preview -------------------------------------------------------------------------------

	let preview = $state<AlertPreview | null>(null);
	let previewError = $state<string | null>(null);
	let previewing = $state(false);

	async function runPreview() {
		const next = build();
		const found = validate(next);
		if (Object.keys(found).length > 0) {
			errors = found;
			previewError = 'Fix the highlighted fields to preview.';
			preview = null;
			return;
		}
		errors = {};
		previewing = true;
		previewError = null;
		try {
			preview = await previewRule({ rule: next, ruleId });
		} catch (error) {
			preview = null;
			previewError = errorText(error, 'Could not preview the rule.');
		} finally {
			previewing = false;
		}
	}

	const summary = $derived.by(() => {
		const typed = Number(thresholdText);
		return querySummary(
			{
				query: spec.query,
				condition: {
					op: spec.condition.op,
					threshold: Number.isFinite(typed) ? fromDisplayThreshold(typed, unit) : 0
				}
			},
			schema?.datasets
		);
	});

	const breaching = $derived(preview?.series.filter((series) => series.met).length ?? 0);

	// --- query mode ----------------------------------------------------------------------------

	function toSql() {
		if (spec.query.mode === 'sql') return;
		lastBuilder = spec.query.builder;
		const dataset = schema?.datasets.find((item) => item.name === lastBuilder?.dataset);
		const table = dataset?.tables.minute ?? schema?.tables[0]?.name ?? 'traffic_1m';
		const sql =
			sqlText ||
			`-- One series per row: string columns are labels, the last number is the value.\nSELECT host, sum(requests) AS value\nFROM ${table}\nWHERE $__timeFilter(bucket)\nGROUP BY host`;
		sqlText = sql;
		spec.query = { mode: 'sql', sql };
	}

	function toBuilder() {
		if (spec.query.mode === 'builder') return;
		spec.query = {
			mode: 'builder',
			builder: lastBuilder ?? {
				dataset: schema?.datasets[0]?.name ?? 'traffic',
				metrics: [],
				groupBy: [],
				filters: [],
				timeSeries: false,
				interval: 'auto'
			}
		};
	}

	function toggleChannel(name: string, on: boolean) {
		spec.channels = on
			? [...new Set([...spec.channels, name])]
			: spec.channels.filter((item) => item !== name);
	}

	const channelOptions = $derived([
		...(overview?.channels ?? []),
		...spec.channels
			.filter((name) => !overview?.channels.some((channel) => channel.name === name))
			.map((name) => ({ name, label: `${name} (not configured)` }))
	]);

	const SEVERITY_HELP: Record<string, string> = {
		info: 'For awareness',
		warning: 'Needs a look soon',
		critical: 'Wake someone up'
	};

	const OPERATOR_TEXT: Record<AlertOperator, string> = {
		gt: 'is above',
		gte: 'is at or above',
		lt: 'is below',
		lte: 'is at or below',
		eq: 'equals',
		neq: 'is not'
	};
</script>

<form class="space-y-6" onsubmit={save} novalidate>
	{#if conflict}
		<Notice tone="warning" title="Someone else saved this rule">
			Your changes are not saved: the rule changed since you opened it. Reload to see their changes,
			then make yours again.
			<span class="mt-2 block">
				<Button size="sm" variant="outline" onclick={() => location.reload()}
					><RefreshCwIcon />Reload</Button
				>
			</span>
		</Notice>
	{/if}
	{#if !canEdit && overview}
		<Notice tone="info" title="Read only"
			>Only organisation owners and admins can change alert rules.</Notice
		>
	{/if}

	<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
		<div class="min-w-0 space-y-6">
			<Card.Root>
				<Card.Header>
					<Card.Title>Rule</Card.Title>
					{#if spec.source}
						<Card.Description>
							<a
								href={resolve('/(dashboard)/dashboards/[id]', { id: spec.source.dashboardId })}
								class="inline-flex items-center gap-1 hover:underline"
								><LayoutDashboardIcon class="size-3.5" />Made from a dashboard panel</a
							>
						</Card.Description>
					{/if}
				</Card.Header>
				<Card.Content class="grid gap-4">
					<label class="block space-y-1">
						<span class="text-sm font-medium">Name</span>
						<Input
							bind:value={spec.name}
							maxlength={120}
							placeholder="Site down"
							required
							aria-invalid={errorFor('name') ? true : undefined}
						/>
						{#if errorFor('name')}<span class="text-xs text-destructive">{errorFor('name')}</span
							>{/if}
					</label>
					<label class="block space-y-1">
						<span class="text-sm font-medium"
							>Description <span class="font-normal text-muted-foreground">(optional)</span></span
						>
						<Textarea
							bind:value={spec.description}
							maxlength={2000}
							rows={2}
							placeholder="What this alert means"
						/>
					</label>
					<div class="flex flex-wrap items-end gap-x-6 gap-y-3">
						<fieldset>
							<legend class="mb-1 text-sm font-medium">Severity</legend>
							<div class="inline-flex rounded-lg bg-muted p-0.5" role="radiogroup">
								{#each alertSeverities as severity (severity)}
									<button
										type="button"
										role="radio"
										aria-checked={spec.severity === severity}
										title={SEVERITY_HELP[severity]}
										class="rounded-md px-3 py-1 text-xs font-medium capitalize {spec.severity ===
										severity
											? 'bg-background shadow-xs'
											: 'text-muted-foreground hover:text-foreground'}"
										onclick={() => (spec.severity = severity)}>{severity}</button
									>
								{/each}
							</div>
						</fieldset>
						<label class="flex h-8 items-center gap-2 text-sm">
							<Switch bind:checked={spec.enabled} aria-label="Enabled" />
							{spec.enabled ? 'Enabled' : 'Paused'}
						</label>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Query and condition</Card.Title>
					<Card.Description
						>One number per series, read over a trailing window and compared with a threshold.</Card.Description
					>
				</Card.Header>
				<Card.Content class="grid gap-5">
					{#if canSql || spec.query.mode === 'sql'}
						<div
							class="inline-flex w-fit rounded-lg bg-muted p-0.5"
							role="tablist"
							aria-label="Query mode"
						>
							<button
								type="button"
								role="tab"
								aria-selected={spec.query.mode === 'builder'}
								disabled={sqlLocked}
								class="rounded-md px-3 py-1 text-xs font-medium {spec.query.mode === 'builder'
									? 'bg-background shadow-xs'
									: 'text-muted-foreground hover:text-foreground'}"
								onclick={toBuilder}>Builder</button
							>
							<button
								type="button"
								role="tab"
								aria-selected={spec.query.mode === 'sql'}
								disabled={!canSql}
								class="inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium {spec
									.query.mode === 'sql'
									? 'bg-background shadow-xs'
									: 'text-muted-foreground hover:text-foreground'}"
								onclick={toSql}><CodeXmlIcon class="size-3" />SQL</button
							>
						</div>
					{/if}

					{#if spec.query.mode === 'builder'}
						<AlertQueryBuilder
							builder={spec.query.builder}
							{schema}
							{variableNames}
							error={errorFor('query')}
							onchange={(builder) => {
								spec.query = { mode: 'builder', builder };
								lastBuilder = builder;
							}}
						/>
					{:else if sqlLocked}
						<div class="space-y-1.5">
							<pre
								class="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap">{spec
									.query.sql}</pre>
							<p class="text-xs text-muted-foreground">
								SQL rules read every organisation’s telemetry, so only platform admins can change
								the query. Everything else can still be edited.
							</p>
						</div>
					{:else}
						<div class="space-y-1.5">
							<CodeEditor
								bind:value={
									() => sqlText,
									(next) => {
										sqlText = next;
										spec.query = { mode: 'sql', sql: next };
									}
								}
								{schema}
								variables={variableNames}
								onrun={runPreview}
								class="h-48"
							/>
							<p class="text-xs text-muted-foreground">
								One series per row: string columns are labels, the last numeric column is the value.
								Use <code class="font-mono">$__timeFilter(bucket)</code> for the rule’s window.
							</p>
							{#if errorFor('query')}<p class="text-xs text-destructive">
									{errorFor('query')}
								</p>{/if}
						</div>
					{/if}

					{#if variableNames.length > 0}
						<div class="space-y-1">
							<p class="text-xs font-medium text-muted-foreground">Dashboard variables</p>
							<div class="flex flex-wrap gap-1.5">
								{#each Object.entries(spec.variables) as [name, value] (name)}
									<span
										class="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-1.5 font-mono text-[11px]"
									>
										${name} = {Array.isArray(value)
											? value.includes('$__all')
												? 'All'
												: value.join(', ')
											: value}
										<button
											type="button"
											class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
											aria-label="Remove variable {name}"
											onclick={() => {
												spec.variables = Object.fromEntries(
													Object.entries(spec.variables).filter(([key]) => key !== name)
												);
											}}><XIcon class="size-3" /></button
										>
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<fieldset class="space-y-2 border-t pt-4">
						<legend class="sr-only">Condition</legend>
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<span>Alert when the value</span>
							<NativeSelect.Root bind:value={spec.condition.op} aria-label="Operator">
								{#each alertOperators as op (op)}
									<NativeSelect.Option value={op}
										>{OPERATOR_TEXT[op]} ({alertOperatorSymbols[op]})</NativeSelect.Option
									>
								{/each}
							</NativeSelect.Root>
							<span class="inline-flex items-center gap-1.5">
								<Input
									type="number"
									step="any"
									inputmode="decimal"
									class="h-8 w-28 tabular-nums"
									aria-label="Threshold{scale.suffix ? ` in ${scale.suffix}` : ''}"
									aria-invalid={errorFor('condition') ? true : undefined}
									bind:value={() => thresholdText, (next) => (thresholdText = String(next ?? ''))}
								/>
								{#if scale.suffix}<span class="text-sm text-muted-foreground">{scale.suffix}</span
									>{/if}
							</span>
						</div>
						{#if errorFor('condition')}
							<p class="text-xs text-destructive">{errorFor('condition')}</p>
						{:else if unit === 'percentunit'}
							<p class="text-xs text-muted-foreground">
								Enter a percentage: 5 means 5% of requests.
							</p>
						{/if}
					</fieldset>

					<DurationField
						id="rule-window"
						label="Over the last"
						bind:value={spec.windowSeconds}
						units={['min', 'hours']}
						help="The window the query reads each time, e.g. “error rate over the last 5 minutes”."
						error={errorFor('windowSeconds')}
					/>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Timing</Card.Title>
					<Card.Description
						>How often to check, and how long before an alert fires or clears.</Card.Description
					>
				</Card.Header>
				<Card.Content class="grid gap-5">
					<div class="grid gap-5 sm:grid-cols-3">
						<DurationField
							id="rule-interval"
							label="Evaluate every"
							bind:value={spec.intervalSeconds}
							units={['min', 'hours']}
							error={errorFor('intervalSeconds')}
						/>
						<DurationField
							id="rule-for"
							label="Pending for"
							bind:value={spec.forSeconds}
							units={['sec', 'min', 'hours']}
							help="The condition must hold this long before it fires. 0 fires on the first breach."
							error={errorFor('forSeconds')}
						/>
						<DurationField
							id="rule-keep"
							label="Keep firing for"
							bind:value={spec.keepFiringSeconds}
							units={['sec', 'min', 'hours']}
							help="Stays firing until clear this long, so a flapping value does not spam. 0 resolves at once."
							error={errorFor('keepFiringSeconds')}
						/>
					</div>
					<fieldset class="space-y-2">
						<legend class="mb-1 text-sm font-medium">When a series has no data</legend>
						<div class="grid gap-2 sm:grid-cols-2">
							{#each NO_DATA_MODES as mode (mode.value)}
								<label
									class="flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors hover:bg-muted/40 has-checked:border-brand/50 has-checked:bg-brand/5"
								>
									<input
										type="radio"
										name="noData"
										value={mode.value}
										bind:group={spec.noData}
										class="mt-0.5 accent-[var(--color-brand)]"
									/>
									<span class="space-y-0.5">
										<span class="block text-sm font-medium">{mode.label}</span>
										<span class="block text-xs text-muted-foreground">{mode.help}</span>
									</span>
								</label>
							{/each}
						</div>
					</fieldset>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Notifications</Card.Title>
				</Card.Header>
				<Card.Content class="grid gap-5">
					<fieldset class="space-y-2">
						<legend class="text-sm font-medium">Channels</legend>
						{#if channelOptions.length === 0}
							<p class="text-xs text-muted-foreground">
								No notification channels are configured on this platform yet.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								{spec.channels.length === 0
									? 'None ticked: sends to every configured channel.'
									: 'Sends only to the ticked channels.'}
							</p>
							<div class="flex flex-wrap gap-x-5 gap-y-2">
								{#each channelOptions as channel (channel.name)}
									<label class="flex items-center gap-2 text-sm">
										<Checkbox
											checked={spec.channels.includes(channel.name)}
											onCheckedChange={(checked) => toggleChannel(channel.name, checked === true)}
										/>
										{channel.label}
									</label>
								{/each}
							</div>
						{/if}
						{#if errorFor('channels')}<p class="text-xs text-destructive">
								{errorFor('channels')}
							</p>{/if}
					</fieldset>

					<label class="block space-y-1">
						<span class="text-sm font-medium"
							>Extra email recipients <span class="font-normal text-muted-foreground"
								>(optional, up to 10)</span
							></span
						>
						<Input
							bind:value={emailsText}
							placeholder="oncall@example.com, lead@example.com"
							aria-invalid={errorFor('emails') ? true : undefined}
						/>
						{#if errorFor('emails')}
							<span class="text-xs text-destructive">{errorFor('emails')}</span>
						{:else if overview && !overview.emailAvailable}
							<span class="text-xs text-warning"
								>Email is not configured on this platform, so these addresses are not sent to.</span
							>
						{/if}
					</label>

					<div class="flex flex-wrap items-start gap-x-8 gap-y-4">
						<DurationField
							id="rule-repeat"
							label="Remind every"
							bind:value={
								() => spec.repeatMinutes * 60,
								(seconds) => (spec.repeatMinutes = Math.round(seconds / 60))
							}
							units={['min', 'hours', 'days']}
							help="Re-notify while still firing and unacknowledged. 0 notifies once."
							error={errorFor('repeatMinutes')}
						/>
						<label class="flex items-center gap-2 pt-7 text-sm">
							<Switch bind:checked={spec.notifyOnResolve} aria-label="Notify when resolved" />
							Notify when resolved
						</label>
					</div>

					<label class="block space-y-1">
						<span class="text-sm font-medium"
							>Runbook <span class="font-normal text-muted-foreground">(optional)</span></span
						>
						<Textarea
							bind:value={spec.runbook}
							maxlength={2000}
							rows={3}
							placeholder="A link, or what to do first when this fires"
						/>
						<span class="text-xs text-muted-foreground">Included in every notification.</span>
					</label>
				</Card.Content>
			</Card.Root>
		</div>

		<aside class="space-y-4 lg:sticky lg:top-20">
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm">Summary</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-3 text-sm">
					<p>
						<span class="font-medium">{spec.name || 'This rule'}</span> checks
						<span class="font-mono text-xs">{summary}</span>
						over the last {durationText(spec.windowSeconds)}, every {durationText(
							spec.intervalSeconds
						)}. It fires after {spec.forSeconds
							? durationText(spec.forSeconds)
							: 'the first breach'}.
					</p>
					<Button variant="outline" class="w-full" onclick={runPreview} disabled={previewing}>
						{#if previewing}<Spinner />{:else}<PlayIcon />{/if}Preview now
					</Button>
					{#if overview && !overview.telemetryAvailable}
						<p class="text-xs text-muted-foreground">
							Telemetry is not available, so a preview cannot run yet.
						</p>
					{/if}
					{#if previewError}
						<p class="text-xs break-words text-destructive" role="alert">{previewError}</p>
					{/if}
					{#if preview}
						<div class="space-y-2" aria-live="polite">
							<p class="text-xs text-muted-foreground">
								{preview.series.length}
								{preview.series.length === 1 ? 'series' : 'series'} ·
								<span class={breaching ? 'font-medium text-destructive' : ''}
									>{breaching} would alert</span
								>
							</p>
							{#if preview.notice}<p class="text-xs text-warning">{preview.notice}</p>{/if}
							<ul class="max-h-80 space-y-1.5 overflow-y-auto">
								{#each preview.series as series (series.fingerprint)}
									<li
										class="flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 {series.met
											? 'border-destructive/40 bg-destructive/5'
											: ''}"
									>
										<Labels labels={series.labels} labelNames={series.labelNames} class="min-w-0" />
										<span class="flex shrink-0 flex-col items-end gap-1">
											<span class="font-mono text-xs tabular-nums"
												>{series.value === null ? 'no data' : formatValue(series.value, unit)}</span
											>
											{#if series.met}
												<Badge variant="danger">Would alert</Badge>
											{:else}
												<Badge variant="success">OK</Badge>
											{/if}
											{#if series.state}<StateBadge state={series.state} />{/if}
										</span>
									</li>
								{:else}
									<li class="text-xs text-muted-foreground">
										No series in the window.{spec.noData === 'ok'
											? ' With “Treat as OK” that is all clear.'
											: ''}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</aside>
	</div>

	{#if formError || stray.length}
		<Notice tone="danger" title={formError ?? 'The rule was not saved'}>
			{#if stray.length}
				<ul class="list-disc pl-4">
					{#each stray as message (message)}<li>{message}</li>{/each}
				</ul>
			{/if}
		</Notice>
	{/if}

	<div
		class="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur md:-mx-8 md:px-8"
	>
		<Button variant="outline" onclick={oncancel}>Cancel</Button>
		<Button type="submit" disabled={saving || !canEdit}>
			{#if saving}<Spinner />{/if}{ruleId ? 'Save rule' : 'Create rule'}
		</Button>
	</div>
</form>
