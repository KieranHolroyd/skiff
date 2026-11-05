<script lang="ts">
	import ContainerIcon from '@lucide/svelte/icons/container';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import type { Component } from 'svelte';
	import type { AppTemplateView, TemplateField } from '@skiff/contracts';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';

	/**
	 * Create a project from a first-party template (plan 21). The form is generated from the
	 * template's field list, so a new catalog entry needs no dashboard change. Fields hidden by
	 * `showWhen` are not rendered, so they are not submitted either.
	 */
	let {
		open = $bindable(false),
		templates,
		placements,
		form
	}: {
		open?: boolean;
		templates: AppTemplateView[];
		placements: Array<{ value: string; label: string }>;
		form: { template?: string; fieldErrors?: Record<string, string> } | null;
	} = $props();

	const icons: Record<string, Component<{ class?: string }>> = {
		workflow: WorkflowIcon,
		container: ContainerIcon
	};

	let selectedId = $state('');
	const selected = $derived(
		templates.find((template) => template.id === selectedId) ?? templates[0]
	);
	/** Live values of select fields, which drive `showWhen`. */
	let choices = $state<Record<string, string>>({});
	let placement = $state('auto');

	$effect(() => {
		if (!selected) return;
		const next: Record<string, string> = {};
		for (const field of selected.fields)
			if (field.kind === 'select')
				next[field.key] = String(field.default ?? field.options?.[0]?.value ?? '');
		choices = next;
	});

	function visible(field: TemplateField): boolean {
		if (!field.showWhen) return true;
		return choices[field.showWhen.key] === field.showWhen.equals;
	}

	const errors = $derived(form?.template === selected?.id ? (form?.fieldErrors ?? {}) : {});
</script>

{#if selected}
	<FormDialog
		bind:open
		icon={icons[selected.icon] ?? LayoutTemplateIcon}
		title="New project from a template"
		description="Templates create the project, its secrets and its first deployment in one step."
		action="?/fromTemplate"
		submitLabel="Create and deploy"
		size="lg"
	>
		<input type="hidden" name="template" value={selected.id} />
		<Field.Group>
			{#if templates.length > 1}
				<div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
					{#each templates as template (template.id)}
						{@const Icon = icons[template.icon] ?? LayoutTemplateIcon}
						<button
							type="button"
							role="radio"
							aria-checked={template.id === selected.id}
							class="flex items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 aria-checked:border-primary aria-checked:bg-muted/40"
							onclick={() => (selectedId = template.id)}
						>
							<Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<span class="font-medium">{template.name}</span>
						</button>
					{/each}
				</div>
			{/if}

			<p class="text-sm text-muted-foreground">
				{selected.summary}
				{#if selected.docsUrl}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external documentation link -->
					<a
						class="underline underline-offset-2"
						href={selected.docsUrl}
						target="_blank"
						rel="noreferrer">Docs</a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
			</p>

			{#each selected.fields.filter(visible) as field (field.key)}
				{@const id = `template-${field.key}`}
				<Field.Field data-invalid={errors[field.key] ? true : undefined}>
					<Field.Label for={id}>
						{field.label}
						{#if !field.required && field.kind !== 'select'}
							<span class="font-normal text-muted-foreground">optional</span>
						{/if}
					</Field.Label>
					{#if field.kind === 'select'}
						<NativeSelect.Root {id} name={field.key} bind:value={choices[field.key]} class="w-full">
							{#each field.options ?? [] as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{:else if field.kind === 'textarea'}
						<Textarea
							{id}
							name={field.key}
							rows={5}
							spellcheck="false"
							class="font-mono text-xs"
							placeholder={field.placeholder}
							aria-invalid={errors[field.key] ? 'true' : undefined}
						/>
					{:else}
						<Input
							{id}
							name={field.key}
							type={field.kind === 'number'
								? 'number'
								: field.kind === 'secret'
									? 'password'
									: 'text'}
							autocomplete={field.kind === 'secret' ? 'off' : undefined}
							spellcheck="false"
							required={field.required}
							min={field.min}
							max={field.max}
							value={field.default === undefined ? undefined : String(field.default)}
							placeholder={field.placeholder}
							aria-invalid={errors[field.key] ? 'true' : undefined}
						/>
					{/if}
					{#if field.help}<Field.Description>{field.help}</Field.Description>{/if}
					{#if errors[field.key]}<Field.Error>{errors[field.key]}</Field.Error>{/if}
				</Field.Field>
			{/each}

			<Field.Field>
				<Field.Label for="template-placement">Placement</Field.Label>
				<NativeSelect.Root
					id="template-placement"
					name="placement"
					bind:value={placement}
					class="w-full"
				>
					{#each placements as option (option.value)}
						<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description
					>The whole pool runs on one node; admission reserves memory for every copy.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
