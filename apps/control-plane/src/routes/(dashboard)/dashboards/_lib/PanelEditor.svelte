<script lang="ts">
	/**
	 * Full-screen panel editor, laid out like Grafana's: live preview top left, the query editor
	 * under it, options on the right. Edits stay local until Apply (Esc also applies); the
	 * dashboard is only saved by its own Save button.
	 */
	import type {
		DashboardPanel,
		ObservabilitySchema,
		PanelQuery,
		QueryResult,
		QueryVariables,
		VizType
	} from '@yoal/contracts';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText } from '#lib/query.js';
	import {
		clone,
		defaultBuilder,
		resolveOptions,
		suggestedUnit,
		VIZ,
		columnUnits
	} from './panel.js';
	import { createPanelQuery } from './panel-query.svelte.js';
	import QueryEditor from './QueryEditor.svelte';
	import { REDUCERS } from './series.js';
	import ThresholdsEditor from './ThresholdsEditor.svelte';
	import { formatInterval, type ResolvedRange } from './time.js';
	import { UNITS } from './units.js';
	import { interpolate } from './variables.js';
	import PanelViz from './viz/PanelViz.svelte';

	let {
		open = $bindable(false),
		panel,
		schema,
		range,
		variables,
		variableNames,
		onapply
	}: {
		open?: boolean;
		panel: DashboardPanel;
		schema: ObservabilitySchema | undefined;
		range: ResolvedRange | null;
		variables: QueryVariables;
		variableNames: string[];
		onapply: (panel: DashboardPanel) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let draft = $state<DashboardPanel>(clone(panel));
	// svelte-ignore state_referenced_locally
	let ran = $state<PanelQuery | undefined>(panel.query ? clone(panel.query) : undefined);
	let previewWidth = $state(0);

	const dataset = $derived(
		draft.query?.mode === 'builder'
			? schema?.datasets.find(
					(item) => draft.query?.mode === 'builder' && item.name === draft.query.builder.dataset
				)
			: undefined
	);
	/** Unit to show when the panel has none of its own: the first metric's. */
	const autoUnit = $derived(
		draft.viz !== 'table' && draft.query?.mode === 'builder' && draft.options?.unit === undefined
			? suggestedUnit(dataset, draft.query.builder)
			: null
	);
	const effective = $derived<DashboardPanel>(
		autoUnit ? { ...draft, options: { ...draft.options, unit: autoUnit } } : draft
	);
	const options = $derived(resolveOptions(effective.options));

	const data = createPanelQuery(() => ({
		query: ran,
		range,
		width: previewWidth,
		variables,
		enabled: draft.viz !== 'text'
	}));
	const result = $derived(data.data as QueryResult | undefined);
	const error = $derived(data.error ? errorText(data.error, 'The query failed.') : null);

	// Builder edits run on their own after a pause; SQL waits for Run (or Ctrl/Cmd+Enter).
	let timer: ReturnType<typeof setTimeout> | undefined;
	function changeQuery(query: PanelQuery) {
		draft.query = query;
		clearTimeout(timer);
		if (query.mode === 'builder') timer = setTimeout(() => (ran = clone(query)), 450);
	}

	function run() {
		clearTimeout(timer);
		if (!draft.query) return;
		const next = clone(draft.query);
		if (JSON.stringify(next) === JSON.stringify(ran)) void data.refetch();
		else ran = next;
	}

	function setViz(viz: VizType) {
		draft.viz = viz;
		if (viz !== 'text' && !draft.query) {
			draft.query = { mode: 'builder', builder: defaultBuilder(schema?.datasets[0]) };
			ran = clone(draft.query);
		}
	}

	function setOption<K extends string>(key: K, value: unknown) {
		draft.options = { ...(draft.options ?? {}), [key]: value };
	}

	function numberOrNull(text: string): number | null {
		if (text.trim() === '') return null;
		const number = Number(text);
		return Number.isFinite(number) ? number : null;
	}

	function apply() {
		const out = clone(effective);
		if (out.viz === 'text') delete out.query;
		onapply(out);
		open = false;
	}

	const showsDraw = $derived(draft.viz === 'timeseries' || draft.viz === 'bar');
	const showsReduce = $derived(['stat', 'gauge', 'bargauge', 'pie'].includes(draft.viz));
	const showsThresholds = $derived(
		['stat', 'gauge', 'bargauge', 'table', 'timeseries'].includes(draft.viz)
	);
	const showsLegend = $derived(['timeseries', 'bar', 'pie'].includes(draft.viz));
	const showsMinMax = $derived(
		draft.viz !== 'table' && draft.viz !== 'pie' && draft.viz !== 'text'
	);
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) apply();
	}}
>
	<Dialog.Content
		showCloseButton={false}
		class="flex h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
		onEscapeKeydown={(event) => {
			event.preventDefault();
			apply();
		}}
	>
		<header class="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
			<Dialog.Title class="text-sm font-semibold">Edit panel</Dialog.Title>
			<Dialog.Description class="hidden text-xs text-muted-foreground sm:block">
				Changes apply to the dashboard; save the dashboard to keep them. Esc applies.
			</Dialog.Description>
			<span class="ml-auto flex items-center gap-2">
				<!-- Closing from here does not go through onOpenChange, so nothing is applied. -->
				<Button variant="ghost" size="sm" onclick={() => (open = false)}>Discard</Button>
				<Button size="sm" onclick={apply}>Apply</Button>
			</span>
		</header>

		<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div class="flex min-h-0 flex-col overflow-y-auto">
				<div class="shrink-0 border-b bg-muted/30 p-4">
					<div
						class="flex h-[min(42vh,26rem)] flex-col overflow-hidden rounded-xl border bg-card"
						bind:clientWidth={previewWidth}
					>
						<div class="flex h-8 shrink-0 items-center gap-1.5 px-2">
							<span class="truncate text-sm font-medium"
								>{interpolate(draft.title, variables) || 'Untitled panel'}</span
							>
							{#if result?.truncated || result?.notice}
								<TriangleAlertIcon
									class="size-3.5 text-warning"
									aria-label={result?.notice ?? 'Truncated'}
								/>
							{/if}
							{#if result}
								<span class="ml-auto font-mono text-[11px] text-muted-foreground">
									{result.rows.length} rows · {result.stats.elapsedMs} ms{#if result.intervalSeconds}
										· {formatInterval(result.intervalSeconds)}{/if}{#if result.resolution}
										· {result.resolution} table{/if}
								</span>
							{/if}
						</div>
						<div class="relative min-h-0 flex-1 px-2 pb-2">
							{#if draft.viz === 'text'}
								<PanelViz
									panel={effective}
									{range}
									text={interpolate(String(draft.options?.text ?? ''), variables)}
								/>
							{:else if schema?.installed === false}
								<p
									class="grid size-full place-items-center px-3 text-center text-xs text-muted-foreground"
								>
									Telemetry is not installed, so there is no data to show.
								</p>
							{:else if error}
								<div
									class="flex size-full flex-col items-center justify-center gap-1.5 overflow-auto px-4 text-center"
									role="alert"
								>
									<CircleAlertIcon class="size-4 text-destructive" />
									<p
										class="max-w-xl font-mono text-xs break-words whitespace-pre-wrap text-destructive"
									>
										{error}
									</p>
								</div>
							{:else if !result}
								<Skeleton class="size-full rounded-md" />
							{:else if result.rows.length === 0}
								<p class="grid size-full place-items-center text-sm text-muted-foreground">
									No data
								</p>
							{:else if range}
								<PanelViz
									panel={effective}
									{result}
									names={schema?.names}
									{range}
									columnUnits={columnUnits(ran, schema)}
								/>
							{/if}
						</div>
					</div>
				</div>
				<div class="p-4">
					{#if draft.viz === 'text'}
						<label class="block space-y-1.5">
							<span class="text-xs font-medium text-muted-foreground">Markdown</span>
							<Textarea
								class="min-h-64 font-mono text-xs"
								value={String(draft.options?.text ?? '')}
								oninput={(event) => setOption('text', event.currentTarget.value)}
							/>
						</label>
						<p class="mt-1.5 text-xs text-muted-foreground">
							Headings, bold, italic, links, lists, code and tables. $variables are substituted.
						</p>
					{:else if draft.query}
						<QueryEditor
							query={draft.query}
							{schema}
							{range}
							{variableNames}
							lastSql={result?.sql ?? null}
							running={data.isFetching}
							onchange={changeQuery}
							onrun={run}
						/>
					{/if}
				</div>
			</div>

			<aside
				class="min-h-0 overflow-y-auto border-t p-4 lg:border-t-0 lg:border-l"
				aria-label="Panel options"
			>
				<div class="space-y-5 text-sm">
					<section class="space-y-2">
						<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
							Panel
						</h3>
						<label class="block space-y-1">
							<span class="text-xs text-muted-foreground">Title</span>
							<Input bind:value={draft.title} placeholder="Untitled" />
						</label>
						<label class="block space-y-1">
							<span class="text-xs text-muted-foreground">Description</span>
							<Textarea bind:value={draft.description} rows={2} class="min-h-14 text-xs" />
						</label>
					</section>

					<section class="space-y-2">
						<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
							Visualisation
						</h3>
						<div class="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Visualisation">
							{#each VIZ as viz (viz.type)}
								{@const on = draft.viz === viz.type}
								<button
									type="button"
									role="radio"
									aria-checked={on}
									title={viz.description}
									class="flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px] leading-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {on
										? 'border-brand/60 bg-brand/10 text-foreground'
										: 'text-muted-foreground hover:bg-muted'}"
									onclick={() => setViz(viz.type)}
								>
									<viz.icon class="size-4" />
									{viz.label}
								</button>
							{/each}
						</div>
					</section>

					{#if draft.viz !== 'text'}
						<section class="space-y-2">
							<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								Values
							</h3>
							<label class="block space-y-1">
								<span class="text-xs text-muted-foreground"
									>Unit {#if autoUnit}<span class="text-[11px]">(from the metric)</span>{/if}</span
								>
								<NativeSelect.Root
									class="w-full"
									value={options.unit}
									onchange={(event) => setOption('unit', event.currentTarget.value)}
								>
									{#each UNITS as unit (unit.value)}
										<NativeSelect.Option value={unit.value}>{unit.label}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
							</label>
							<div class="grid grid-cols-3 gap-2">
								<label class="space-y-1">
									<span class="text-xs text-muted-foreground">Decimals</span>
									<Input
										type="number"
										min="0"
										max="10"
										placeholder="auto"
										value={options.decimals ?? ''}
										onchange={(event) =>
											setOption('decimals', numberOrNull(event.currentTarget.value))}
									/>
								</label>
								{#if showsMinMax}
									<label class="space-y-1">
										<span class="text-xs text-muted-foreground">Min</span>
										<Input
											type="number"
											step="any"
											placeholder="auto"
											value={options.min ?? ''}
											onchange={(event) =>
												setOption('min', numberOrNull(event.currentTarget.value))}
										/>
									</label>
									<label class="space-y-1">
										<span class="text-xs text-muted-foreground">Max</span>
										<Input
											type="number"
											step="any"
											placeholder="auto"
											value={options.max ?? ''}
											onchange={(event) =>
												setOption('max', numberOrNull(event.currentTarget.value))}
										/>
									</label>
								{/if}
							</div>
						</section>
					{/if}

					{#if showsDraw || showsLegend || showsReduce}
						<section class="space-y-2">
							<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								Display
							</h3>
							{#if showsDraw}
								<label class="block space-y-1">
									<span class="text-xs text-muted-foreground">Style</span>
									<NativeSelect.Root
										class="w-full"
										value={options.draw}
										onchange={(event) => setOption('draw', event.currentTarget.value)}
									>
										{#if draft.viz === 'bar'}
											<NativeSelect.Option value="line">Grouped</NativeSelect.Option>
											<NativeSelect.Option value="stacked">Stacked</NativeSelect.Option>
										{:else}
											<NativeSelect.Option value="line">Lines</NativeSelect.Option>
											<NativeSelect.Option value="area">Area</NativeSelect.Option>
											<NativeSelect.Option value="stacked">Stacked area</NativeSelect.Option>
											<NativeSelect.Option value="points">Points</NativeSelect.Option>
										{/if}
									</NativeSelect.Root>
								</label>
							{/if}
							{#if showsReduce}
								<label class="block space-y-1">
									<span class="text-xs text-muted-foreground">Calculation</span>
									<NativeSelect.Root
										class="w-full"
										value={options.reduce}
										onchange={(event) => setOption('reduce', event.currentTarget.value)}
									>
										{#each REDUCERS as reducer (reducer.value)}
											<NativeSelect.Option value={reducer.value}
												>{reducer.label}</NativeSelect.Option
											>
										{/each}
									</NativeSelect.Root>
								</label>
							{/if}
							{#if showsLegend}
								<label class="block space-y-1">
									<span class="text-xs text-muted-foreground">Legend</span>
									<NativeSelect.Root
										class="w-full"
										value={options.legend}
										onchange={(event) => setOption('legend', event.currentTarget.value)}
									>
										<NativeSelect.Option value="bottom">Bottom</NativeSelect.Option>
										<NativeSelect.Option value="right">Right (with values)</NativeSelect.Option>
										<NativeSelect.Option value="hidden">Hidden</NativeSelect.Option>
									</NativeSelect.Root>
								</label>
							{/if}
						</section>
					{/if}

					{#if showsThresholds}
						<section class="space-y-2">
							<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
								Thresholds
							</h3>
							<ThresholdsEditor
								value={options.thresholds}
								onchange={(next) => setOption('thresholds', next)}
							/>
							<p class="text-xs text-muted-foreground">
								{draft.viz === 'timeseries'
									? 'Drawn as dashed lines.'
									: draft.viz === 'table'
										? 'Colour number cells.'
										: 'Colour the value.'}
							</p>
						</section>
					{/if}
				</div>
			</aside>
		</div>
	</Dialog.Content>
</Dialog.Root>
