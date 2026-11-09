<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FileKeyIcon from '@lucide/svelte/icons/file-key';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import XIcon from '@lucide/svelte/icons/x';
	import type { TemplateField } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import LabelsInput from './LabelsInput.svelte';
	import { formatUnit } from './template-form.js';

	/**
	 * One template field, rendered from its definition. Every kind posts a plain string under
	 * `field.key`, so the server action reads the form the same way whatever the control looks like.
	 */
	let {
		field,
		value = $bindable(''),
		error,
		suggestions = null,
		onblur
	}: {
		field: TemplateField;
		value?: string;
		/** Shown under the control when set. */
		error?: string;
		/** Existing secret names for `suggest: 'secrets'` fields. */
		suggestions?: string[] | null;
		onblur?: () => void;
	} = $props();

	let fileError = $state('');
	const id = $derived(`field-${field.key}`);
	const invalid = $derived(error || fileError ? 'true' : undefined);
	/** Few choices read better as cards than as a dropdown. */
	const asCards = $derived(field.kind === 'select' && (field.options?.length ?? 0) <= 3);

	let reveal = $state(false);
	let dragging = $state(false);
	let fileName = $state<string | null>(null);
	const shownError = $derived(error ?? (fileError || undefined));
	const columns: Record<number, string> = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };
	let picker = $state<HTMLInputElement | null>(null);

	function step(direction: 1 | -1) {
		const size = field.step ?? 1;
		const current = Number(value);
		const base = Number.isFinite(current) && value !== '' ? current : Number(field.default ?? 0);
		let next = base + direction * size;
		if (field.min !== undefined) next = Math.max(field.min, next);
		if (field.max !== undefined) next = Math.min(field.max, next);
		value = String(next);
		onblur?.();
	}

	async function load(file: File | undefined) {
		if (!file) return;
		if (file.size > 64 * 1024) {
			fileName = null;
			fileError = `That file is too large for this field.`;
			return;
		}
		fileError = '';
		value = (await file.text()).trim();
		fileName = file.name;
		onblur?.();
	}

	function ondrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		void load(event.dataTransfer?.files[0]);
	}

	const numeric = $derived(Number(value));
	const lines = $derived(value ? value.split('\n').length : 0);
</script>

<Field.Field data-invalid={invalid}>
	<Field.Label for={asCards ? undefined : id} id="{id}-label">{field.label}</Field.Label>

	{#if field.kind === 'select' && asCards}
		<div
			class="grid gap-2 {columns[field.options?.length ?? 1] ?? ''}"
			role="radiogroup"
			aria-labelledby="{id}-label"
		>
			{#each field.options ?? [] as option (option.value)}
				{@const checked = value === option.value}
				<label
					class="group relative flex cursor-pointer gap-3 rounded-lg border bg-card p-3 text-sm transition-all hover:border-foreground/20 hover:bg-muted/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 {checked
						? 'border-foreground/40 bg-muted/40 shadow-xs ring-1 ring-foreground/10'
						: ''}"
				>
					<input
						type="radio"
						class="sr-only"
						name={field.key}
						value={option.value}
						bind:group={value}
						onchange={onblur}
					/>
					<span
						class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors {checked
							? 'border-foreground bg-foreground text-background'
							: 'bg-background'}"
						aria-hidden="true"
					>
						{#if checked}<CheckIcon class="size-2.5" strokeWidth={3.5} />{/if}
					</span>
					<span class="min-w-0 space-y-0.5">
						<span class="block leading-tight font-medium">{option.label}</span>
						{#if option.description}
							<span class="block text-xs leading-snug text-pretty text-muted-foreground"
								>{option.description}</span
							>
						{/if}
					</span>
				</label>
			{/each}
		</div>
	{:else if field.kind === 'select'}
		<NativeSelect.Root {id} name={field.key} bind:value class="w-full" onchange={onblur}>
			{#each field.options ?? [] as option (option.value)}
				<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	{:else if field.kind === 'secret'}
		<InputGroup.Root>
			<InputGroup.Input
				{id}
				name={field.key}
				type={reveal ? 'text' : 'password'}
				bind:value
				{onblur}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				placeholder={field.placeholder}
				class="font-mono text-sm"
				aria-invalid={invalid}
				data-1p-ignore
			/>
			<InputGroup.Addon align="inline-end">
				<InputGroup.Button
					size="icon-xs"
					aria-label={reveal ? 'Hide value' : 'Show value'}
					aria-pressed={reveal}
					onclick={() => (reveal = !reveal)}
				>
					{#if reveal}<EyeOffIcon />{:else}<EyeIcon />{/if}
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	{:else if field.kind === 'textarea'}
		<div
			class="relative"
			role="group"
			ondragover={(event) => {
				if (!field.accept) return;
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={field.accept ? ondrop : undefined}
		>
			<Textarea
				{id}
				name={field.key}
				rows={value ? 6 : 4}
				spellcheck="false"
				class="font-mono text-xs transition-all {dragging ? 'border-ring ring-3 ring-ring/40' : ''}"
				placeholder={field.placeholder}
				bind:value
				{onblur}
				aria-invalid={invalid}
			/>
			{#if field.accept}
				{#if dragging}
					<div
						class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/80 text-sm font-medium backdrop-blur-[1px]"
					>
						<UploadIcon class="mr-2 size-4" />Drop the {field.accept} file
					</div>
				{/if}
				<div class="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
					{#if value}
						<span class="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
							<FileKeyIcon class="size-3.5 shrink-0" />
							<span class="truncate">{fileName ?? 'Pasted'} · {lines} lines</span>
						</span>
						<Button
							variant="ghost"
							size="xs"
							onclick={() => {
								value = '';
								fileName = null;
							}}><XIcon />Clear</Button
						>
					{:else}
						<span class="text-muted-foreground"
							>Paste it, or drop the {field.accept} file here.</span
						>
						<Button variant="outline" size="xs" onclick={() => picker?.click()}>
							<UploadIcon />Choose file
						</Button>
					{/if}
				</div>
				<input
					bind:this={picker}
					type="file"
					accept={field.accept}
					class="hidden"
					tabindex="-1"
					onchange={(event) => void load(event.currentTarget.files?.[0])}
				/>
			{/if}
		</div>
	{:else if field.kind === 'labels'}
		<LabelsInput
			{id}
			name={field.key}
			bind:value
			fixed={field.fixed ?? []}
			placeholder={field.placeholder}
			invalid={Boolean(error)}
			{onblur}
		/>
	{:else if field.kind === 'number'}
		<div class="flex flex-wrap items-center gap-2">
			<InputGroup.Root class="w-auto min-w-40 flex-1 sm:max-w-56">
				<InputGroup.Addon>
					<InputGroup.Button
						size="icon-xs"
						aria-label="Decrease {field.label}"
						disabled={field.min !== undefined && numeric <= field.min}
						onclick={() => step(-1)}><MinusIcon /></InputGroup.Button
					>
				</InputGroup.Addon>
				<InputGroup.Input
					{id}
					name={field.key}
					type="number"
					inputmode="decimal"
					value={value === '' ? null : Number(value)}
					oninput={(event) => (value = event.currentTarget.value)}
					{onblur}
					min={field.min}
					max={field.max}
					step={field.step ?? 'any'}
					placeholder={field.placeholder}
					class="[appearance:textfield] text-center font-mono tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
					aria-invalid={invalid}
				/>
				{#if field.unit}
					<InputGroup.Addon align="inline-end" class="pr-0">
						<InputGroup.Text class="font-mono text-xs">{field.unit}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
				<InputGroup.Addon align="inline-end">
					<InputGroup.Button
						size="icon-xs"
						aria-label="Increase {field.label}"
						disabled={field.max !== undefined && numeric >= field.max}
						onclick={() => step(1)}><PlusIcon /></InputGroup.Button
					>
				</InputGroup.Addon>
			</InputGroup.Root>
			{#if field.presets?.length}
				<div class="flex flex-wrap gap-1" role="group" aria-label="{field.label} presets">
					{#each field.presets as preset (preset)}
						<Button
							variant={numeric === preset && value !== '' ? 'secondary' : 'ghost'}
							size="xs"
							class="font-mono tabular-nums {numeric === preset && value !== ''
								? 'ring-1 ring-foreground/15'
								: 'text-muted-foreground'}"
							aria-pressed={numeric === preset}
							onclick={() => {
								value = String(preset);
								onblur?.();
							}}>{formatUnit(preset, field.unit)}</Button
						>
					{/each}
				</div>
			{/if}
		</div>
	{:else}
		<Input
			{id}
			name={field.key}
			bind:value
			{onblur}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			placeholder={field.placeholder}
			list={field.suggest === 'secrets' && suggestions?.length ? `${id}-suggestions` : undefined}
			class={field.suggest === 'secrets' ? 'font-mono text-sm' : ''}
			aria-invalid={invalid}
		/>
		{#if field.suggest === 'secrets' && suggestions?.length}
			<datalist id="{id}-suggestions">
				{#each suggestions as name (name)}<option value={name}></option>{/each}
			</datalist>
		{/if}
	{/if}

	{#if field.help}<Field.Description>{field.help}</Field.Description>{/if}
	{#if shownError}<Field.Error>{shownError}</Field.Error>{/if}
</Field.Field>
