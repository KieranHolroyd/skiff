<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	interface Org {
		id: string;
		name: string;
		slug: string;
		role: string;
	}

	let {
		current,
		orgs
	}: {
		current: { id: string; name: string };
		orgs: Org[];
	} = $props();

	let switching = $state<string | null>(null);
	let error = $state('');

	/** Ask the server to move the session, then re-run every load with the new org (IAM.md I5). */
	async function switchTo(orgId: string) {
		if (orgId === current.id || switching) return;
		switching = orgId;
		error = '';
		try {
			const response = await fetch('/api/v1/org/switch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ organizationId: orgId })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string };
				error = body.message ?? 'Could not switch organisation.';
				return;
			}
			await goto(`${page.url.pathname}${page.url.search}`, { invalidateAll: true });
		} catch {
			error = 'Could not switch organisation. Check your connection and try again.';
		} finally {
			switching = null;
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				variant="ghost"
				size="sm"
				class="h-8 max-w-52 gap-1.5 px-2 font-normal"
				disabled={switching !== null}
				title="Switch organisation"
				{...props}
			>
				<Building2Icon class="size-4 shrink-0 text-muted-foreground" />
				<span class="truncate">{current.name}</span>
				<ChevronsUpDownIcon class="size-3.5 shrink-0 text-muted-foreground" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-60">
		<DropdownMenu.Label class="text-xs text-muted-foreground">Organisations</DropdownMenu.Label>
		{#each orgs as org (org.id)}
			<DropdownMenu.Item
				disabled={switching !== null}
				onSelect={() => switchTo(org.id)}
				class="gap-2"
			>
				<span class="min-w-0 flex-1 truncate">{org.name}</span>
				<span class="text-xs text-muted-foreground capitalize">{org.role}</span>
				{#if org.id === current.id}
					<CheckIcon class="size-4 shrink-0" />
				{:else}
					<span class="size-4 shrink-0"></span>
				{/if}
			</DropdownMenu.Item>
		{/each}
		{#if error}
			<DropdownMenu.Separator />
			<p class="px-2 py-1.5 text-xs text-destructive">{error}</p>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
