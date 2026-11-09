<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import type { PlatformPolicies, PlatformPolicyKey } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { POLICY_GROUPS, type PolicyGroupId } from './policy-groups.js';

	/**
	 * One group of platform policies with its own Save, posting to the page's `?/savePolicies`
	 * action (policies.server.ts). `children` renders above the fields (a live readout, a notice).
	 */
	let {
		group: groupId,
		policies,
		defaults,
		form,
		children
	}: {
		group: PolicyGroupId;
		policies: PlatformPolicies;
		defaults: PlatformPolicies;
		/** The page's `form`, for field errors. */
		form: unknown;
		children?: Snippet;
	} = $props();

	const group = $derived(POLICY_GROUPS[groupId]);
	let values = $state<Partial<Record<PlatformPolicyKey, string>>>({});
	let saving = $state(false);

	function seed(source: PlatformPolicies) {
		values = Object.fromEntries(group.items.map((item) => [item.key, String(source[item.key])]));
	}

	$effect.pre(() => seed(policies));

	const errors = $derived(
		((form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}) as Record<
			string,
			string
		>
	);
	const changedFromDefault = $derived(
		group.items.some((item) => String(defaults[item.key]) !== values[item.key])
	);
</script>

<form
	method="POST"
	action="?/savePolicies"
	use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') toast.success(`${group.title} saved`);
			else if (result.type === 'failure')
				toast.error(
					String((result.data as { message?: unknown } | undefined)?.message ?? 'Could not save')
				);
		};
	}}
>
	<Panel title={group.title} description={group.description} icon={group.icon}>
		{@render children?.()}
		<div class="grid gap-5 sm:grid-cols-2">
			{#each group.items as item (item.key)}
				<Field.Field data-invalid={errors[item.key] ? true : undefined}>
					<Field.Label for={`policy-${item.key}`}>
						{item.label}
						{#if item.unit}<span class="font-normal text-muted-foreground">({item.unit})</span>{/if}
					</Field.Label>
					{#if item.options}
						<NativeSelect.Root
							id={`policy-${item.key}`}
							name={item.key}
							class="w-full"
							bind:value={values[item.key]}
						>
							{#each item.options as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{:else if item.text}
						<Input
							id={`policy-${item.key}`}
							name={item.key}
							required
							class="font-mono"
							bind:value={values[item.key]}
							aria-invalid={errors[item.key] ? true : undefined}
						/>
					{:else}
						<Input
							id={`policy-${item.key}`}
							name={item.key}
							type="number"
							required
							min={item.min}
							max={item.max}
							step={1}
							bind:value={values[item.key]}
							aria-invalid={errors[item.key] ? true : undefined}
						/>
					{/if}
					<Field.Description>
						{item.description}
						<span class="text-muted-foreground/80">
							Default {defaults[item.key]}{item.min !== undefined
								? `; ${item.min}–${item.max}`
								: ''}.
						</span>
					</Field.Description>
					{#if errors[item.key]}<Field.Error>{errors[item.key]}</Field.Error>{/if}
				</Field.Field>
			{/each}
		</div>

		{#snippet footer()}
			<div class="flex w-full flex-wrap items-center justify-end gap-2">
				{#if changedFromDefault}
					<Button type="button" variant="ghost" size="sm" onclick={() => seed(defaults)}
						>Reset to defaults</Button
					>
				{/if}
				<Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
			</div>
		{/snippet}
	</Panel>
</form>
