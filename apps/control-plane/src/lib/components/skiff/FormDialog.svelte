<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import type { SubmitFunction } from '$app/forms';
	import { enhance } from '$app/forms';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button, type ButtonVariant } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { notify } from '#lib/actions.js';

	/**
	 * A dialog wrapping a progressively-enhanced form action. Closes on success (or redirect),
	 * stays open on failure with the error inline. Field errors are read by the caller from `form`.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		icon: Icon,
		action,
		submitLabel = 'Save',
		submitVariant = 'default',
		size = 'md',
		trigger,
		children,
		onsuccess
	}: {
		open?: boolean;
		title: string;
		description?: string;
		icon?: Component<{ class?: string }>;
		action: string;
		submitLabel?: string;
		submitVariant?: ButtonVariant;
		size?: 'sm' | 'md' | 'lg';
		trigger?: Snippet<[Record<string, unknown>]>;
		children: Snippet;
		onsuccess?: () => void;
	} = $props();

	let pending = $state(false);
	let error = $state('');

	const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-xl' };

	const submit: SubmitFunction = () => {
		pending = true;
		error = '';
		return async ({ result, update }) => {
			await update({ reset: false });
			pending = false;
			if (result.type === 'success' || result.type === 'redirect') {
				notify(result);
				open = false;
				onsuccess?.();
			} else if (result.type === 'failure') {
				const message = (result.data as { message?: unknown } | undefined)?.message;
				error = typeof message === 'string' ? message : 'Check the form and try again.';
			} else {
				error = 'Something went wrong. Please try again.';
			}
		};
	};

	$effect(() => {
		if (open) error = '';
	});
</script>

<Dialog.Root bind:open>
	{#if trigger}
		<Dialog.Trigger>
			{#snippet child({ props })}{@render trigger(props)}{/snippet}
		</Dialog.Trigger>
	{/if}
	<Dialog.Content class={widths[size]}>
		<Dialog.Header class="flex-row items-start gap-3.5">
			{#if Icon}
				<span
					class="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/50 text-muted-foreground"
				>
					<Icon class="size-4" />
				</span>
			{/if}
			<div class="space-y-1.5">
				<Dialog.Title>{title}</Dialog.Title>
				{#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
			</div>
		</Dialog.Header>
		<form method="POST" {action} use:enhance={submit} class="grid gap-5">
			{#if error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{/if}
			{@render children()}
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props} disabled={pending}>Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" variant={submitVariant} disabled={pending}>
					{#if pending}<Spinner />{/if}
					{submitLabel}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
