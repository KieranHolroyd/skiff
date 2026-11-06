<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { nameError } from './changes.js';

	/**
	 * Asks for one name (rename, new schema, new collection, rename field). `onsubmit` gets the
	 * trimmed name once it passes the basic checks; the review dialog takes over from there.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		label = 'Name',
		initial = '',
		submitLabel = 'Review',
		onsubmit
	}: {
		open?: boolean;
		title: string;
		description?: string;
		label?: string;
		initial?: string;
		submitLabel?: string;
		onsubmit: (name: string) => void;
	} = $props();

	const uid = $props.id();
	let value = $state('');
	let error = $state<string | null>(null);

	// Each opening starts from `initial`.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			value = initial;
			error = null;
		}
		wasOpen = open;
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const name = value.trim();
		error = nameError(name, label.toLowerCase());
		if (!error && name === initial) error = `That is already its ${label.toLowerCase()}.`;
		if (error) return;
		open = false;
		onsubmit(name);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>{title}</Dialog.Title>
				{#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
			</Dialog.Header>
			<div class="space-y-1.5">
				<Label for="name-{uid}">{label}</Label>
				<Input
					id="name-{uid}"
					bind:value
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? `name-error-${uid}` : undefined}
				/>
				{#if error}<p id="name-error-{uid}" class="text-xs text-destructive" role="alert">{error}</p>{/if}
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit">{submitLabel}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
