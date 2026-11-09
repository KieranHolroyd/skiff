<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { AssistantModelInfo } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';

	/**
	 * A searchable model picker for OpenRouter's catalogue. The selected id is the form value, so
	 * the surrounding dialog submits like a plain input. Prices are shown per million tokens.
	 */
	let {
		models,
		value = $bindable(''),
		name = 'model',
		allowEmpty = false
	}: {
		models: AssistantModelInfo[];
		value?: string;
		name?: string;
		allowEmpty?: boolean;
	} = $props();

	let filter = $state('');

	const filtered = $derived.by(() => {
		const query = filter.trim().toLowerCase();
		if (!query) return models;
		return models.filter(
			(model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
		);
	});

	const selected = $derived(models.find((model) => model.id === value) ?? null);

	function price(perToken: number | null): string {
		if (perToken === null) return '—';
		if (perToken === 0) return 'free';
		const perMillion = perToken * 1_000_000;
		return `$${perMillion < 0.01 ? perMillion.toFixed(4) : perMillion.toFixed(2)}/M`;
	}

	function context(tokens: number | null): string {
		if (!tokens) return '—';
		return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k ctx` : `${tokens} ctx`;
	}
</script>

<input type="hidden" {name} {value} />

<div class="space-y-2">
	<div class="relative">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
		/>
		<Input
			bind:value={filter}
			placeholder="Search {models.length} tool-capable models…"
			autocomplete="off"
			class="pl-8"
		/>
	</div>

	{#if allowEmpty}
		<Button
			type="button"
			variant={value ? 'outline' : 'secondary'}
			size="sm"
			onclick={() => (value = '')}
		>
			Use the platform model
		</Button>
	{/if}

	<div class="max-h-64 overflow-y-auto rounded-lg border p-1">
		{#each filtered as model (model.id)}
			<button
				type="button"
				class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted {model.id ===
				value
					? 'bg-muted'
					: ''}"
				onclick={() => (value = model.id)}
				aria-pressed={model.id === value}
			>
				<span class="mt-0.5 flex size-4 shrink-0 items-center justify-center">
					{#if model.id === value}<CheckIcon class="size-3.5 text-brand" />{/if}
				</span>
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-medium">{model.name}</span>
					<span class="block truncate font-mono text-[11px] text-muted-foreground">{model.id}</span>
					<span class="mt-0.5 block text-[11px] text-muted-foreground">
						{context(model.contextLength)} · {price(model.promptPrice)} in ·
						{price(model.completionPrice)} out
					</span>
				</span>
			</button>
		{:else}
			<p class="p-3 text-sm text-muted-foreground">No models match that search.</p>
		{/each}
	</div>

	{#if selected}
		<p class="text-xs text-muted-foreground">
			Selected <span class="font-mono text-foreground">{selected.id}</span>
			{#if selected.supportsTools}· supports tools{/if}
		</p>
	{:else if value}
		<p class="text-xs text-warning">The saved model id is not in the catalogue list.</p>
	{:else}
		<p class="text-xs text-muted-foreground">Pick a model to continue.</p>
	{/if}
</div>
