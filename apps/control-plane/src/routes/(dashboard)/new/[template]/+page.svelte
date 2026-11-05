<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import CodeIcon from '@lucide/svelte/icons/code';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import type { TemplatePlan } from '@skiff/contracts';
	import { toast } from 'svelte-sonner';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import FieldControl from '../_lib/FieldControl.svelte';
	import FormStep from '../_lib/FormStep.svelte';
	import PlacementPicker from '../_lib/PlacementPicker.svelte';
	import PlanPreview from '../_lib/PlanPreview.svelte';
	import TemplateTile from '../_lib/TemplateTile.svelte';
	import { categoryLabels } from '../_lib/icons.js';
	import {
		apiSnippet,
		collectValues,
		effectiveSlug,
		formatMb,
		formGroups,
		initialState,
		isOffered,
		isVisible,
		reservedMb,
		validate,
		type FormGroup
	} from '../_lib/template-form.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const FORM_ID = 'template-form';
	const template = $derived(data.template);
	const groups = $derived(formGroups(template));
	const mainGroups = $derived(groups.filter((group) => !group.advanced));
	const advancedGroups = $derived(groups.filter((group) => group.advanced));

	let form = $state(initialState(untrack(() => data.template)));
	let touched = $state<Record<string, boolean>>({});
	let submitted = $state(false);
	let pending = $state(false);
	let advancedOpen = $state(false);
	let failure = $state<string | null>(null);
	let serverErrors = $state<Record<string, string>>({});
	/** The values a server error was about; an error clears once its field changes. */
	let serverValues = $state<Record<string, string>>({});
	let slugSuggestions = $state<string[]>([]);

	// Moving between templates starts a fresh form.
	let currentId = untrack(() => data.template.id);
	$effect(() => {
		if (template.id === currentId) return;
		currentId = template.id;
		form = initialState(template);
		touched = {};
		submitted = false;
		failure = null;
		serverErrors = {};
		slugSuggestions = [];
	});

	const slug = $derived(effectiveSlug(template, form));
	const values = $derived(collectValues(template, form));
	const checked = $derived(validate(template, form));

	/** An existing secret the plan needs but the organisation does not have. */
	const missingSecrets = $derived(
		checked.plan && data.secretNames
			? checked.plan.requiredSecrets.filter((name) => !data.secretNames!.includes(name))
			: []
	);
	const issues = $derived.by(() => {
		const out = { ...checked.issues };
		for (const name of missingSecrets) {
			const owner = template.fields.find(
				(field) => isVisible(template, field, form) && values[field.key] === name
			);
			if (owner && !out[owner.key])
				out[owner.key] = `There is no organisation secret named ${name}.`;
		}
		return out;
	});
	const plan = $derived(missingSecrets.length > 0 ? null : checked.plan);

	let lastPlan: TemplatePlan | null = null;
	const shownPlan = $derived.by(() => {
		if (checked.plan) lastPlan = checked.plan;
		return lastPlan;
	});

	function errorFor(key: string): string | undefined {
		const local = touched[key] || submitted ? issues[key] : undefined;
		if (local) return local;
		const server = serverErrors[key];
		if (server && (serverValues[key] ?? '') === (values[key] ?? '')) return server;
		return undefined;
	}

	function touch(key: string) {
		touched[key] = true;
	}

	function groupIssues(group: FormGroup, withSlug: boolean): number {
		let count = group.fields.filter(
			(field) => isVisible(template, field, form) && issues[field.key]
		).length;
		if (withSlug && issues.slug) count += 1;
		return count;
	}

	interface Section {
		id: string;
		title: string;
		issues: number;
	}
	const sections = $derived<Section[]>([
		...mainGroups.map((group, index) => ({
			id: group.id,
			title: group.title,
			issues: groupIssues(group, index === 0)
		})),
		{ id: 'placement', title: 'Placement', issues: issues.placement ? 1 : 0 },
		...advancedGroups.map((group) => ({
			id: group.id,
			title: group.title,
			issues: groupIssues(group, false)
		}))
	]);
	const issueCount = $derived(Object.keys(issues).length + checked.general.length);
	const ready = $derived(plan !== null);

	const fieldOrder = $derived([
		...groups.flatMap((group, index) => [
			...group.fields.map((field) => field.key),
			...(index === 0 ? ['slug'] : [])
		]),
		'placement'
	]);

	async function revealFirstIssue() {
		const key = fieldOrder.find((candidate) => issues[candidate] || serverErrors[candidate]);
		if (!key) return;
		if (advancedGroups.some((group) => group.fields.some((field) => field.key === key))) {
			advancedOpen = true;
			await tick();
		}
		const target =
			document.getElementById(`field-${key}`) ??
			document.querySelector<HTMLElement>(`[name="${CSS.escape(key)}"]`);
		target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		target?.focus({ preventScroll: true });
	}

	function jumpTo(id: string) {
		if (advancedGroups.some((group) => group.id === id)) advancedOpen = true;
		void tick().then(() =>
			document
				.getElementById(`section-${id}`)
				?.scrollIntoView({ behavior: 'smooth', block: 'start' })
		);
	}

	const submit: SubmitFunction = ({ cancel }) => {
		submitted = true;
		failure = null;
		if (!data.can.createProject) {
			cancel();
			return;
		}
		if (!plan) {
			cancel();
			void revealFirstIssue();
			return;
		}
		const name = plan.project.name;
		const snapshot = { ...values };
		pending = true;
		return async ({ result, update }) => {
			if (result.type === 'redirect') {
				toast.success(`${name} is deploying`, {
					description: 'The project, its secrets and its first deployment are in place.'
				});
				await update();
				return;
			}
			pending = false;
			if (result.type === 'failure') {
				const body = (result.data ?? {}) as {
					message?: string;
					fieldErrors?: Record<string, string>;
					suggestions?: string[];
				};
				serverErrors = body.fieldErrors ?? {};
				serverValues = snapshot;
				slugSuggestions = body.suggestions ?? [];
				failure = body.message ?? 'The template could not be created.';
				if (Object.keys(serverErrors).length > 0) void revealFirstIssue();
			} else {
				failure = 'Something went wrong. Nothing was created; please try again.';
			}
		};
	};

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			(document.getElementById(FORM_ID) as HTMLFormElement | null)?.requestSubmit();
		}
	}

	const api = $derived(apiSnippet(template, form, page.url.origin));
	const isMac = $derived(
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
	);
	const advancedChanged = $derived(
		advancedGroups.some((group) =>
			group.fields.some((field) => (form.values[field.key] ?? '') !== String(field.default ?? ''))
		)
	);
</script>

<svelte:head>
	<title>{template.name} · New project · Skiff</title>
</svelte:head>

<svelte:window {onkeydown} />

<div class="space-y-8 pb-24 lg:pb-0">
	<!-- Header -->
	<header class="space-y-5 border-b pb-6">
		<Button variant="ghost" size="sm" href={resolve('/(dashboard)/new')} class="-ml-2.5">
			<ArrowLeftIcon />All templates
		</Button>
		<div class="flex flex-wrap items-start gap-4">
			<TemplateTile id={template.id} icon={template.icon} size="lg" />
			<div class="min-w-0 flex-1 space-y-1.5">
				<div class="flex flex-wrap items-center gap-2">
					<h1 class="text-2xl font-semibold tracking-tight text-balance">{template.name}</h1>
					<Badge variant="neutral">{categoryLabels[template.category] ?? template.category}</Badge>
					<Badge variant="outline" class="font-mono">v{template.version}</Badge>
				</div>
				<p class="max-w-2xl text-sm text-pretty text-muted-foreground">{template.summary}</p>
				{#if template.docsUrl}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external documentation link -->
					<a
						href={template.docsUrl}
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-0.5 text-sm font-medium underline-offset-4 hover:underline"
						>Documentation<ArrowUpRightIcon class="size-3.5" /></a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
			</div>
		</div>
	</header>

	{#if !data.can.createProject}
		<Notice tone="warning" title="You can look, but not create">
			Your role cannot create projects in {data.org.name}. Ask an owner or admin to run this
			template, or to change your role.
		</Notice>
	{/if}

	<div
		class="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]"
	>
		<!-- Form -->
		<form
			id={FORM_ID}
			method="POST"
			use:enhance={submit}
			novalidate
			class="min-w-0 space-y-0"
			aria-label="Configure {template.name}"
		>
			{#if template.requirements?.length}
				<div class="mb-8 rounded-xl border border-dashed bg-muted/30 p-4">
					<p class="mb-2.5 flex items-center gap-2 text-sm font-medium">
						<ClipboardCheckIcon class="size-4 text-muted-foreground" />Before you start
					</p>
					<ul class="space-y-1.5 text-sm text-muted-foreground">
						{#each template.requirements as requirement (requirement)}
							<li class="flex gap-2">
								<span class="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60"></span>
								<span class="text-pretty">{requirement}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<ol class="space-y-0">
				{#each mainGroups as group, index (group.id)}
					<FormStep
						number={index + 1}
						id={group.id}
						title={group.title}
						description={group.description}
						done={(sections.find((section) => section.id === group.id)?.issues ?? 0) === 0}
					>
						<Field.Group>
							{@render fields(group)}
							{#if index === 0}{@render slugField()}{/if}
						</Field.Group>
					</FormStep>
				{/each}

				<FormStep
					number={mainGroups.length + 1}
					id="placement"
					title="Placement"
					description={data.capacity.length > 0
						? 'The whole pool runs on one node. Bars show each node’s workload slice, with this pool on top.'
						: 'The whole pool runs on one node, chosen once at deploy time.'}
					done={!issues.placement}
					last={advancedGroups.length === 0}
				>
					<PlacementPicker
						bind:value={form.placement}
						capacity={data.capacity}
						requiredMb={plan ? reservedMb(plan) : null}
					/>
					{#if errorFor('placement')}
						<p class="mt-2 text-sm text-destructive">{errorFor('placement')}</p>
					{/if}
				</FormStep>

				{#each advancedGroups as group (group.id)}
					<li id="section-{group.id}" class="relative scroll-mt-24 pl-11">
						<Collapsible.Root bind:open={advancedOpen}>
							<Collapsible.Trigger
								class="group flex w-full items-center gap-2 rounded-lg py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
							>
								<ChevronDownIcon
									class="size-4 transition-transform group-data-[state=closed]:-rotate-90"
								/>
								{group.title}
								{#if advancedChanged && !advancedOpen}
									<Badge variant="info">changed</Badge>
								{/if}
								{#if (sections.find((section) => section.id === group.id)?.issues ?? 0) > 0 && (submitted || Object.keys(touched).length > 0)}
									<Badge variant="danger">needs attention</Badge>
								{/if}
							</Collapsible.Trigger>
							<Collapsible.Content>
								<div class="mt-2 rounded-xl border bg-card p-5 shadow-xs">
									{#if group.description}
										<p class="mb-4 text-sm text-muted-foreground">{group.description}</p>
									{/if}
									<Field.Group>
										{@render fields(group)}
									</Field.Group>
								</div>
							</Collapsible.Content>
						</Collapsible.Root>
					</li>
				{/each}
			</ol>
		</form>

		<!-- Plan rail -->
		<aside class="min-w-0 lg:sticky lg:top-6" aria-label="Launch plan">
			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<div class="flex items-center justify-between gap-3 border-b px-4 py-3">
					<p class="flex items-center gap-2 text-sm font-semibold">
						<SparklesIcon class="size-4 text-brand" />Launch plan
					</p>
					{#if ready}
						<Badge variant="success" class="animate-in fade-in"><CheckIcon />Ready</Badge>
					{:else}
						<Badge variant="neutral" class="tabular-nums"
							>{issueCount} {issueCount === 1 ? 'thing' : 'things'} to do</Badge
						>
					{/if}
				</div>

				<!-- Section checklist -->
				<nav class="border-b px-2 py-2" aria-label="Form sections">
					<ul class="grid gap-0.5">
						{#each sections as section, index (section.id)}
							<li>
								<button
									type="button"
									class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
									onclick={() => jumpTo(section.id)}
								>
									<span
										class="flex size-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold tabular-nums transition-colors {section.issues ===
										0
											? 'bg-success/15 text-success'
											: 'border text-muted-foreground'}"
									>
										{#if section.issues === 0}<CheckIcon
												class="size-3"
												strokeWidth={3}
											/>{:else}{index + 1}{/if}
									</span>
									<span
										class="flex-1 truncate {section.issues === 0 ? 'text-muted-foreground' : ''}"
										>{section.title}</span
									>
									{#if section.issues > 0}
										<span class="font-mono text-xs text-muted-foreground tabular-nums"
											>{section.issues}</span
										>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				</nav>

				<div class="p-4">
					{#if shownPlan}
						{#if !plan}
							<p class="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
								<CircleAlertIcon class="size-3.5" />Showing the last complete plan.
							</p>
						{/if}
						<PlanPreview plan={shownPlan} stale={!plan} {slug} secretNames={data.secretNames} />
					{:else}
						<div class="space-y-3 py-2">
							{#each [0, 1, 2] as index (index)}
								<div class="flex gap-3" style:opacity={1 - index * 0.25}>
									<div class="size-7 shrink-0 rounded-md border border-dashed"></div>
									<div class="flex-1 space-y-1.5 pt-1">
										<div class="h-2 w-16 rounded-full bg-muted"></div>
										<div class="h-2.5 w-full max-w-40 rounded-full bg-muted/70"></div>
									</div>
								</div>
							{/each}
							<p class="pt-1 text-sm text-pretty text-muted-foreground">
								Fill in the form and the plan builds itself, from the same code the server runs.
							</p>
						</div>
					{/if}
				</div>

				<div class="space-y-3 border-t bg-muted/30 p-4">
					{#if failure}
						<Alert.Root variant="destructive">
							<CircleAlertIcon />
							<Alert.Title>Nothing was created</Alert.Title>
							<Alert.Description>{failure}</Alert.Description>
						</Alert.Root>
					{/if}
					{@render submitButton('w-full')}
					<p class="text-center text-xs text-pretty text-muted-foreground">
						Creates the project, stores credentials and deploys in one step. If any part fails, it
						is all undone.
					</p>
				</div>
			</div>

			<Collapsible.Root class="mt-3">
				<Collapsible.Trigger
					class="group flex w-full items-center gap-2 rounded-lg px-1 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					<CodeIcon class="size-3.5" />Same thing over the API
					<ChevronDownIcon
						class="ml-auto size-3.5 transition-transform group-data-[state=closed]:-rotate-90"
					/>
				</Collapsible.Trigger>
				<Collapsible.Content>
					<CodeBlock code={api} label="shell" />
					<p class="mt-2 px-1 text-xs text-pretty text-muted-foreground">
						Credentials are left out. Name an existing secret instead so the value never lands in
						shell history.
					</p>
				</Collapsible.Content>
			</Collapsible.Root>
		</aside>
	</div>
</div>

<!-- Narrow screens: the rail is below the form, so keep the action in reach. -->
<div
	class="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/75 lg:hidden"
>
	<div class="mx-auto flex max-w-2xl items-center gap-3">
		<p class="min-w-0 flex-1 truncate text-sm">
			{#if ready}
				<span class="font-medium">{plan?.project.name}</span>
				<span class="text-muted-foreground">· reserves {formatMb(reservedMb(plan!))}</span>
			{:else}
				<span class="text-muted-foreground"
					>{issueCount} {issueCount === 1 ? 'thing' : 'things'} to do</span
				>
			{/if}
		</p>
		{@render submitButton('')}
	</div>
</div>

{#snippet submitButton(className: string)}
	<Button
		type="submit"
		form={FORM_ID}
		size="lg"
		class="{className} relative overflow-hidden"
		disabled={pending || !data.can.createProject}
	>
		{#if pending}
			<Spinner />Creating and deploying…
		{:else}
			<RocketIcon />Create and deploy
			<span class="ml-1 hidden items-center gap-0.5 opacity-60 sm:inline-flex">
				<Kbd class="bg-primary-foreground/15 text-primary-foreground">{isMac ? '⌘' : 'Ctrl'}</Kbd>
				<Kbd class="bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
			</span>
		{/if}
	</Button>
{/snippet}

{#snippet slugField()}
	{@const slugError = errorFor('slug')}
	<Field.Field data-invalid={slugError ? true : undefined}>
		<Field.Label for="field-slug">Slug</Field.Label>
		<InputGroup.Root>
			<InputGroup.Input
				id="field-slug"
				name="slug"
				bind:value={form.slug}
				onblur={() => touch('slug')}
				placeholder={slug || 'derived-from-the-name'}
				maxlength={40}
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				class="font-mono text-sm"
				aria-invalid={slugError ? 'true' : undefined}
			/>
			{#if !form.slug && slug}
				<InputGroup.Addon align="inline-end">
					<InputGroup.Text class="text-xs">from the name</InputGroup.Text>
				</InputGroup.Addon>
			{/if}
		</InputGroup.Root>
		<Field.Description>
			The project’s permanent address in Skiff. Secrets it creates are suffixed with it.
		</Field.Description>
		{#if slugError}<Field.Error>{slugError}</Field.Error>{/if}
		{#if slugSuggestions.length > 0}
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="text-xs text-muted-foreground">Try:</span>
				{#each slugSuggestions as suggestion (suggestion)}
					<Button
						variant="outline"
						size="xs"
						class="font-mono"
						onclick={() => {
							form.slug = suggestion;
							slugSuggestions = [];
						}}>{suggestion}</Button
					>
				{/each}
			</div>
		{/if}
	</Field.Field>
{/snippet}

{#snippet fields(group: FormGroup)}
	{#each group.fields as field (field.key)}
		{#if field.replaces && isOffered(template, field, form)}
			{@const on = form.alternatives[field.key] === true}
			<div class="rounded-lg border border-dashed p-3 transition-colors {on ? 'bg-muted/30' : ''}">
				<label class="flex cursor-pointer items-start justify-between gap-4">
					<span class="space-y-0.5">
						<span class="block text-sm font-medium">{field.label}</span>
						{#if field.help}
							<span class="block text-xs text-pretty text-muted-foreground">{field.help}</span>
						{/if}
					</span>
					<Switch
						class="mt-0.5"
						bind:checked={
							() => on,
							(value) => {
								form.alternatives[field.key] = value;
							}
						}
						aria-label={field.label}
					/>
				</label>
				{#if on}
					<div class="mt-3 animate-in fade-in slide-in-from-top-1">
						<FieldControl
							field={{ ...field, help: undefined }}
							bind:value={form.values[field.key]}
							error={errorFor(field.key)}
							suggestions={data.secretNames}
							onblur={() => touch(field.key)}
						/>
					</div>
				{/if}
			</div>
		{:else if !field.replaces && isVisible(template, field, form)}
			<div class="animate-in fade-in">
				<FieldControl
					{field}
					bind:value={form.values[field.key]}
					error={errorFor(field.key)}
					suggestions={data.secretNames}
					onblur={() => touch(field.key)}
				/>
			</div>
		{/if}
	{/each}
{/snippet}
