<script lang="ts">
	import { authClient } from '#lib/auth-client.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');
	let pending = $state(false);

	async function accept() {
		pending = true;
		error = '';
		const { error: err } = await authClient.organization.acceptInvitation({
			invitationId: data.invitationId,
		});
		pending = false;
		if (err) error = err.message ?? 'Could not accept the invitation';
		else window.location.href = '/overview';
	}
</script>

<main class="flex min-h-svh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Join this Skiff org</Card.Title>
			<Card.Description>
				You're signed in as {data.email}. Accept the invitation to access its projects.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-2">
			{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
			<Button class="w-full" disabled={pending} onclick={accept}>Accept invitation</Button>
		</Card.Content>
	</Card.Root>
</main>
