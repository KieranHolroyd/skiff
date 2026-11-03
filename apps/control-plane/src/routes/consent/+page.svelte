<script lang="ts">
	import { onMount } from 'svelte';
	import { authClient } from '#lib/auth-client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let clientName = $state('');
	let pending = $state(false);
	let error = $state('');
	// Intentionally seeded once from server data; the user edits it from here.
	// svelte-ignore state_referenced_locally
	let selected = $state(Object.fromEntries(data.scopes.map((s) => [s.scope, s.checked])));

	onMount(async () => {
		const { data: client } = await authClient.oauth2.publicClient({ query: { client_id: data.clientId } });
		clientName = (client as { client_name?: string } | null)?.client_name ?? data.clientId;
	});

	async function decide(accept: boolean) {
		pending = true;
		const scope = Object.entries(selected).filter(([, on]) => on).map(([s]) => s).join(' ');
		const { data: result, error: err } = await authClient.oauth2.consent({ accept, scope });
		pending = false;
		if (err) return (error = err.message ?? 'Consent failed');
		const next = (result as { url?: string; redirect_uri?: string } | null);
		window.location.href = next?.url ?? next?.redirect_uri ?? '/';
	}
</script>

<main class="flex min-h-svh items-center justify-center p-6">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>Authorize {clientName || 'application'}</Card.Title>
			<Card.Description>
				Choose what this client may do on your behalf. You can revoke access at any time.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-2">
			{#each data.scopes as s (s.scope)}
				<div class="flex items-center gap-3">
					<Checkbox id={s.scope} bind:checked={selected[s.scope]} disabled={!s.permission} />
					<Label for={s.scope} class="font-mono text-xs">{s.scope}</Label>
					{#if s.destructive}<Badge variant="destructive">destructive</Badge>{/if}
				</div>
			{/each}
			{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
		</Card.Content>
		<Card.Footer class="flex justify-end gap-2">
			<Button variant="outline" disabled={pending} onclick={() => decide(false)}>Deny</Button>
			<Button disabled={pending} onclick={() => decide(true)}>Allow</Button>
		</Card.Footer>
	</Card.Root>
</main>
