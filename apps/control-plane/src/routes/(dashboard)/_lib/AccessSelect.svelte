<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LockKeyholeIcon from '@lucide/svelte/icons/lock-keyhole';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import * as Select from '#lib/components/ui/select/index.js';

	/** Access-mode picker. Submits as a normal form field via `name`. */
	let {
		id,
		name,
		value = $bindable('public'),
		invalid = false
	}: { id: string; name: string; value?: string; invalid?: boolean } = $props();

	const options = [
		{ value: 'public', label: 'Public', hint: 'Anyone with the URL', icon: GlobeIcon },
		{
			value: 'password',
			label: 'Password',
			hint: 'One project-wide secret',
			icon: LockKeyholeIcon
		},
		{
			value: 'platform',
			label: 'Platform login',
			hint: 'Members of this org',
			icon: ShieldCheckIcon
		},
		{
			value: 'access',
			label: 'Yoal Access',
			hint: 'A policy: groups, email, SSO or a pool',
			icon: ShieldCheckIcon
		}
	] as const;
	const selected = $derived(options.find((option) => option.value === value) ?? options[0]);
</script>

<Select.Root type="single" {name} bind:value>
	<Select.Trigger {id} class="w-full" aria-invalid={invalid ? 'true' : undefined}>
		<selected.icon class="text-muted-foreground" />
		{selected.label}
	</Select.Trigger>
	<Select.Content>
		{#each options as option (option.value)}
			<Select.Item value={option.value} label={option.label}>
				<option.icon />
				<span class="flex flex-col">
					<span>{option.label}</span>
					<span class="text-xs text-muted-foreground">{option.hint}</span>
				</span>
			</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
