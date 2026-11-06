<script lang="ts" module>
	export interface DashboardMeta {
		title: string;
		description: string;
		tags: string[];
	}
</script>

<script lang="ts">
	/**
	 * Dashboard settings sheet: title, description and tags; the variables editor; and the JSON
	 * model (view, edit and apply). Changes go into the unsaved dashboard, like panel edits.
	 */
	import {
		dashboardSpecSchema,
		type DashboardSpec,
		type DashboardVariable,
		type ObservabilitySchema
	} from '@skiff/contracts';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import CodeEditor from './CodeEditor.svelte';
	import { clone, defaultBuilder, normalizeSpec } from './panel.js';
	import QueryEditor from './QueryEditor.svelte';
	import type { ResolvedRange } from './time.js';

	let {
		open = $bindable(false),
		meta,
		spec,
		schema,
		range,
		onmeta,
		onspec
	}: {
		open?: boolean;
		meta: DashboardMeta;
		spec: DashboardSpec;
		schema: ObservabilitySchema | undefined;
		range: ResolvedRange | null;
		onmeta: (meta: DashboardMeta) => void;
		onspec: (spec: DashboardSpec) => void;
	} = $props();

	let tab = $state('general');
	let tagText = $state('');
	let jsonText = $state('');
	let jsonError = $state<string | null>(null);
	let selected = $state(0);

	$effect(() => {
		if (!open) return;
		tagText = meta.tags.join(', ');
	});
	$effect(() => {
		if (tab === 'json') {
			jsonText = JSON.stringify(
				{ title: meta.title, description: meta.description, tags: meta.tags, spec },
				null,
				2
			);
			jsonError = null;
		}
	});

	const variables = $derived(spec.variables);
	const current = $derived(variables[selected]);

	function setVariables(next: DashboardVariable[]) {
		onspec({ ...spec, variables: next });
	}

	function patchVariable(patch: Partial<DashboardVariable>) {
		setVariables(
			variables.map((variable, index) =>
				index === selected ? { ...variable, ...patch } : variable
			)
		);
	}

	function addVariable() {
		const taken = new Set(variables.map((variable) => variable.name));
		let index = variables.length + 1;
		while (taken.has(`var${index}`)) index++;
		const dataset = schema?.datasets[0];
		const dimension = dataset?.dimensions[0]?.name;
		setVariables([
			...variables,
			{
				name: `var${index}`,
				label: '',
				kind: 'query',
				query: {
					mode: 'builder',
					builder: {
						...defaultBuilder(dataset),
						metrics: [],
						groupBy: dimension ? [dimension] : [],
						timeSeries: false,
						limit: 500
					}
				},
				custom: '',
				multi: false,
				includeAll: true,
				current: ['$__all']
			}
		]);
		selected = variables.length;
	}

	function move(index: number, delta: number) {
		const next = [...variables];
		const [item] = next.splice(index, 1);
		next.splice(index + delta, 0, item!);
		setVariables(next);
		selected = index + delta;
	}

	function applyJson() {
		try {
			const raw = JSON.parse(jsonText) as Record<string, unknown>;
			const specInput = raw.spec ?? raw;
			const parsed = dashboardSpecSchema.safeParse(specInput);
			if (!parsed.success) {
				jsonError = parsed.error.issues
					.slice(0, 4)
					.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
					.join('\n');
				return;
			}
			onspec(normalizeSpec(clone(parsed.data)));
			if (raw.spec) {
				onmeta({
					title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : meta.title,
					description: typeof raw.description === 'string' ? raw.description : meta.description,
					tags: Array.isArray(raw.tags)
						? raw.tags.filter((tag): tag is string => typeof tag === 'string')
						: meta.tags
				});
			}
			jsonError = null;
			open = false;
		} catch (error) {
			jsonError = error instanceof Error ? error.message : 'Not valid JSON.';
		}
	}

	const nameValid = (name: string) => /^[a-z][a-z0-9_]{0,63}$/.test(name);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 sm:max-w-2xl">
		<Sheet.Header class="border-b">
			<Sheet.Title>Dashboard settings</Sheet.Title>
			<Sheet.Description
				>Changes apply to the open dashboard; save it to keep them.</Sheet.Description
			>
		</Sheet.Header>
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col p-4">
			<Tabs.List>
				<Tabs.Trigger value="general">General</Tabs.Trigger>
				<Tabs.Trigger value="variables"
					>Variables <Badge variant="secondary" class="ml-1 tabular-nums">{variables.length}</Badge
					></Tabs.Trigger
				>
				<Tabs.Trigger value="json">JSON model</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="general" class="space-y-4 overflow-y-auto pt-2">
				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground">Title</span>
					<Input
						value={meta.title}
						maxlength={120}
						oninput={(event) => onmeta({ ...meta, title: event.currentTarget.value })}
					/>
				</label>
				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground">Description</span>
					<Textarea
						value={meta.description}
						maxlength={1000}
						rows={3}
						oninput={(event) => onmeta({ ...meta, description: event.currentTarget.value })}
					/>
				</label>
				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground"
						>Tags (comma separated, up to 10)</span
					>
					<Input
						bind:value={tagText}
						placeholder="traffic, production"
						onchange={() =>
							onmeta({
								...meta,
								tags: [
									...new Set(
										tagText
											.split(',')
											.map((tag) => tag.trim())
											.filter(Boolean)
									)
								].slice(0, 10)
							})}
					/>
				</label>
			</Tabs.Content>

			<Tabs.Content value="variables" class="min-h-0 overflow-y-auto pt-2">
				<div class="grid gap-4 sm:grid-cols-[11rem_1fr]">
					<div class="space-y-1">
						<ul class="space-y-0.5">
							{#each variables as variable, index (index)}
								<li class="group flex items-center gap-1">
									<button
										type="button"
										class="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left font-mono text-xs {index ===
										selected
											? 'bg-muted text-foreground'
											: 'text-muted-foreground hover:bg-muted/60'}"
										onclick={() => (selected = index)}
									>
										${variable.name}
									</button>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Move up"
										disabled={index === 0}
										onclick={() => move(index, -1)}><ArrowUpIcon /></Button
									>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="Move down"
										disabled={index === variables.length - 1}
										onclick={() => move(index, 1)}><ArrowDownIcon /></Button
									>
								</li>
							{/each}
						</ul>
						<Button
							variant="outline"
							size="sm"
							class="w-full"
							onclick={addVariable}
							disabled={variables.length >= 20}><PlusIcon />Variable</Button
						>
					</div>

					{#if current}
						<div class="space-y-3">
							<div class="grid grid-cols-2 gap-2">
								<label class="space-y-1">
									<span class="text-xs text-muted-foreground">Name</span>
									<Input
										value={current.name}
										class="font-mono text-xs"
										aria-invalid={!nameValid(current.name)}
										oninput={(event) =>
											patchVariable({ name: event.currentTarget.value.toLowerCase() })}
									/>
								</label>
								<label class="space-y-1">
									<span class="text-xs text-muted-foreground">Label</span>
									<Input
										value={current.label}
										oninput={(event) => patchVariable({ label: event.currentTarget.value })}
									/>
								</label>
							</div>
							{#if !nameValid(current.name)}<p class="text-xs text-destructive">
									Lower-case letters, digits and underscores, starting with a letter.
								</p>{/if}
							<label class="block space-y-1">
								<span class="text-xs text-muted-foreground">Type</span>
								<NativeSelect.Root
									class="w-full"
									value={current.kind}
									onchange={(event) => {
										const kind = event.currentTarget.value as DashboardVariable['kind'];
										patchVariable({
											kind,
											query:
												kind === 'query'
													? (current.query ?? {
															mode: 'builder',
															builder: {
																...defaultBuilder(schema?.datasets[0]),
																metrics: [],
																timeSeries: false
															}
														})
													: current.query,
											current: kind === 'textbox' ? [] : current.current
										});
									}}
								>
									<NativeSelect.Option value="query"
										>Query: values from the first column</NativeSelect.Option
									>
									<NativeSelect.Option value="custom">Custom: a fixed list</NativeSelect.Option>
									<NativeSelect.Option value="textbox">Textbox: free text</NativeSelect.Option>
								</NativeSelect.Root>
							</label>
							{#if current.kind === 'query' && current.query}
								<div class="rounded-lg border p-3">
									<QueryEditor
										query={current.query}
										{schema}
										{range}
										editorClass="h-36"
										onchange={(query) => patchVariable({ query })}
										onrun={() => {}}
									/>
									<p class="mt-2 text-xs text-muted-foreground">
										Group by one dimension with no metrics to list its values.
									</p>
								</div>
							{:else if current.kind === 'custom'}
								<label class="block space-y-1">
									<span class="text-xs text-muted-foreground">Values (comma separated)</span>
									<Input
										value={current.custom}
										oninput={(event) => patchVariable({ custom: event.currentTarget.value })}
									/>
								</label>
							{/if}
							{#if current.kind !== 'textbox'}
								<div class="flex flex-wrap gap-4">
									<label class="flex items-center gap-2 text-xs">
										<Switch
											checked={current.multi}
											onCheckedChange={(multi) => patchVariable({ multi })}
										/>Multi-value
									</label>
									<label class="flex items-center gap-2 text-xs">
										<Switch
											checked={current.includeAll}
											onCheckedChange={(includeAll) => patchVariable({ includeAll })}
										/>Include “All”
									</label>
								</div>
							{/if}
							<p class="text-xs text-muted-foreground">
								Use it as <code class="font-mono">${current.name}</code> in builder filter values, SQL
								and panel titles.
							</p>
							<Button
								variant="ghost-danger"
								size="sm"
								onclick={() => {
									setVariables(variables.filter((_, index) => index !== selected));
									selected = Math.max(0, selected - 1);
								}}
							>
								<Trash2Icon />Remove variable
							</Button>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">
							Variables become dropdowns above the panels, and their values flow into queries as <code
								class="font-mono">$name</code
							>.
						</p>
					{/if}
				</div>
			</Tabs.Content>

			<Tabs.Content value="json" class="flex min-h-0 flex-1 flex-col gap-2 pt-2">
				<CodeEditor
					bind:value={jsonText}
					language="json"
					label="Dashboard JSON"
					class="min-h-80 flex-1"
				/>
				{#if jsonError}<pre
						class="text-xs whitespace-pre-wrap text-destructive"
						role="alert">{jsonError}</pre>{/if}
				<div class="flex gap-2">
					<Button size="sm" onclick={applyJson}>Apply JSON</Button>
					<span class="self-center text-xs text-muted-foreground"
						>Replaces panels, variables and time settings.</span
					>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	</Sheet.Content>
</Sheet.Root>
