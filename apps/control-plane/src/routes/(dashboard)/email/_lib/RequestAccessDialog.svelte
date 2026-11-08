<script lang="ts">
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';

	/**
	 * Ask to leave the sandbox (EMAIL.md §7.3). Posts to the page's `request` action, which the
	 * Sandbox page and the overview both spread in from sandbox.server.ts; field errors and the
	 * values typed come back through the page's `form`.
	 */
	let {
		open = $bindable(false),
		errors = {},
		values = {}
	}: {
		open?: boolean;
		errors?: Record<string, string>;
		values?: Record<string, unknown>;
	} = $props();
</script>

<FormDialog
	bind:open
	icon={RocketIcon}
	title="Request production access"
	description="A platform admin reviews this. Approval lifts the sandbox; you get an email either way."
	action="?/request"
	submitLabel="Send request"
	size="lg"
>
	<Field.Group>
		<Field.Field data-invalid={errors.useCase ? true : undefined}>
			<Field.Label for="access-use-case">What you send, and to whom</Field.Label>
			<Textarea
				id="access-use-case"
				name="useCase"
				rows={5}
				required
				minlength={20}
				maxlength={2000}
				placeholder="Password resets and order receipts for customers who signed up on our shop. No marketing."
				value={String(values.useCase ?? '')}
				aria-invalid={errors.useCase ? 'true' : undefined}
			/>
			<Field.Description>
				Say how recipients gave you their address and how you handle bounces and unsubscribes.
			</Field.Description>
			{#if errors.useCase}<Field.Error>{errors.useCase}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={errors.expectedDailyVolume ? true : undefined}>
			<Field.Label for="access-volume">Expected messages a day</Field.Label>
			<Input
				id="access-volume"
				name="expectedDailyVolume"
				type="number"
				min="1"
				step="1"
				required
				placeholder="500"
				class="font-mono"
				value={String(values.expectedDailyVolume ?? '')}
				aria-invalid={errors.expectedDailyVolume ? 'true' : undefined}
			/>
			{#if errors.expectedDailyVolume}<Field.Error>{errors.expectedDailyVolume}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={errors.website ? true : undefined}>
			<Field.Label for="access-website">Website (optional)</Field.Label>
			<Input
				id="access-website"
				name="website"
				type="url"
				placeholder="https://example.com"
				class="font-mono text-sm"
				value={String(values.website ?? '')}
				aria-invalid={errors.website ? 'true' : undefined}
			/>
			{#if errors.website}<Field.Error>{errors.website}</Field.Error>{/if}
		</Field.Field>
	</Field.Group>
</FormDialog>
