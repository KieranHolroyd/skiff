<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import XIcon from '@lucide/svelte/icons/x';

	/**
	 * A token input for labels. The value stays a comma-joined string (what the form and the
	 * template schema accept); `fixed` labels are shown first and cannot be removed.
	 */
	let {
		id,
		name,
		value = $bindable(''),
		fixed = [],
		placeholder,
		invalid = false,
		onblur
	}: {
		id: string;
		name: string;
		value?: string;
		fixed?: readonly string[];
		placeholder?: string;
		invalid?: boolean;
		onblur?: () => void;
	} = $props();

	let draft = $state('');
	let input = $state<HTMLInputElement | null>(null);

	const labels = $derived(
		value
			.split(/[\s,]+/)
			.map((label) => label.trim())
			.filter(Boolean)
	);
	const fixedLower = $derived(fixed.map((label) => label.toLowerCase()));

	function commit(text: string) {
		const next = [...labels];
		const seen = [...next.map((label) => label.toLowerCase()), ...fixedLower];
		for (const raw of text.split(/[\s,]+/)) {
			const label = raw.trim();
			if (!label || seen.includes(label.toLowerCase())) continue;
			seen.push(label.toLowerCase());
			next.push(label);
		}
		value = next.join(', ');
		draft = '';
	}

	function remove(index: number) {
		value = labels.filter((_, at) => at !== index).join(', ');
		input?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',' || event.key === ' ' || event.key === 'Tab') {
			if (!draft.trim()) return;
			if (event.key !== 'Tab') event.preventDefault();
			commit(draft);
		} else if (event.key === 'Backspace' && draft === '' && labels.length > 0) {
			event.preventDefault();
			remove(labels.length - 1);
		}
	}

	function onpaste(event: ClipboardEvent) {
		const text = event.clipboardData?.getData('text') ?? '';
		if (!/[\s,]/.test(text)) return;
		event.preventDefault();
		commit(`${draft} ${text}`);
	}
</script>

<!-- Clicking anywhere in the box focuses the input, which is the keyboard target. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30 {invalid
		? 'border-destructive ring-3 ring-destructive/20'
		: ''}"
	onclick={() => input?.focus()}
>
	{#each fixed as label (label)}
		<span
			class="inline-flex h-6 items-center gap-1 rounded-md border border-dashed px-1.5 font-mono text-xs text-muted-foreground"
			title="Always added"
		>
			<LockIcon class="size-3" />{label}
		</span>
	{/each}
	{#each labels as label, index (label)}
		<span
			class="inline-flex h-6 animate-in items-center gap-0.5 rounded-md bg-secondary pr-0.5 pl-1.5 font-mono text-xs text-secondary-foreground zoom-in-95 fade-in"
		>
			{label}
			<button
				type="button"
				class="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
				aria-label="Remove {label}"
				onclick={(event) => {
					event.stopPropagation();
					remove(index);
				}}
			>
				<XIcon class="size-3" />
			</button>
		</span>
	{/each}
	<input
		bind:this={input}
		{id}
		bind:value={draft}
		{onkeydown}
		{onpaste}
		onblur={() => {
			if (draft.trim()) commit(draft);
			onblur?.();
		}}
		class="h-6 min-w-24 flex-1 bg-transparent px-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
		placeholder={labels.length === 0 ? placeholder : 'Add another'}
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		aria-invalid={invalid ? 'true' : undefined}
	/>
	<input type="hidden" {name} value={labels.join(',')} />
</div>
