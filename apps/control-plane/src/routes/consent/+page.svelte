<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { onMount } from 'svelte';
	import BotIcon from '@lucide/svelte/icons/bot';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/skiff/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let clientName = $state('');
	let pending = $state(false);
	let error = $state('');
	// Intentionally seeded once from server data; the user edits it from here.
	// svelte-ignore state_referenced_locally
	let selected = $state(Object.fromEntries(data.scopes.map((s) => [s.scope, s.checked])));

	const selectedCount = $derived(Object.values(selected).filter(Boolean).length);

	onMount(async () => {
		const { data: client } = await authClient.oauth2.publicClient({
			query: { client_id: data.clientId }
		});
		clientName = (client as { client_name?: string } | null)?.client_name ?? data.clientId;
	});

	async function decide(accept: boolean) {
		pending = true;
		const scope = Object.entries(selected)
			.filter(([, on]) => on)
			.map(([s]) => s)
			.join(' ');
		const { data: result, error: err } = await authClient.oauth2.consent({ accept, scope });
		pending = false;
		if (err) return (error = err.message ?? 'Consent failed');
		const next = result as { url?: string; redirect_uri?: string } | null;
		window.location.href = next?.url ?? next?.redirect_uri ?? '/';
	}
</script>

<svelte:head>
	<title>Authorize {clientName || 'application'} · Skiff</title>
</svelte:head>

<AuthShell
	eyebrow="Authorization request"
	title="Authorize {clientName || 'application'}"
	description="Choose what this client may do on your behalf. You can revoke access at any time."
>
	<div class="mb-4 flex items-center gap-3 rounded-xl border bg-card p-3 shadow-xs">
		<span
			class="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
		>
			<BotIcon class="size-5" aria-hidden="true" />
		</span>
		<div class="min-w-0">
			<p class="truncate text-sm font-semibold">{clientName || 'Loading client…'}</p>
			<p class="truncate font-mono text-xs text-muted-foreground" title={data.clientId}>
				{data.clientId}
			</p>
		</div>
	</div>

	<fieldset class="overflow-hidden rounded-xl border bg-card shadow-xs">
		<legend class="sr-only">Requested permissions</legend>
		<div class="flex items-center justify-between border-b bg-muted/40 px-3.5 py-2">
			<span class="text-xs font-medium text-muted-foreground">Permissions</span>
			<span class="font-mono text-xs text-muted-foreground tabular-nums"
				>{selectedCount}/{data.scopes.length}</span
			>
		</div>
		<ul class="max-h-80 divide-y overflow-y-auto">
			{#each data.scopes as s (s.scope)}
				<li>
					<label
						for={s.scope}
						class="flex items-center gap-3 px-3.5 py-2.5 transition-colors {s.permission
							? 'cursor-pointer hover:bg-muted/40'
							: 'cursor-not-allowed opacity-55'}"
					>
						<Checkbox id={s.scope} bind:checked={selected[s.scope]} disabled={!s.permission} />
						<span class="min-w-0 flex-1 truncate font-mono text-xs">{s.scope}</span>
						{#if s.destructive}<Badge variant="danger">destructive</Badge>{/if}
						{#if !s.permission}<Badge variant="neutral">not in your role</Badge>{/if}
					</label>
				</li>
			{/each}
		</ul>
	</fieldset>

	{#if error}<Alert.Root variant="destructive" class="mt-4"
			><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}

	<div class="mt-6 grid grid-cols-2 gap-3">
		<Button
			variant="outline"
			size="lg"
			class="h-10"
			disabled={pending}
			onclick={() => decide(false)}>Deny</Button
		>
		<Button size="lg" class="h-10" disabled={pending} onclick={() => decide(true)}
			>Allow access</Button
		>
	</div>

	{#snippet footer()}
		Tokens are limited to the intersection of these permissions and your role, and can be revoked at
		any time.
	{/snippet}
</AuthShell>
