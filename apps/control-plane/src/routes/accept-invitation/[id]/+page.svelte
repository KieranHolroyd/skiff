<script lang="ts">
	import UsersIcon from '@lucide/svelte/icons/users';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/skiff/AuthShell.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');
	let pending = $state(false);

	async function accept() {
		pending = true;
		error = '';
		const { error: err } = await authClient.organization.acceptInvitation({
			invitationId: data.invitationId
		});
		pending = false;
		if (err) error = err.message ?? 'Could not accept the invitation';
		else window.location.href = '/overview';
	}
</script>

<svelte:head>
	<title>Accept invitation · Skiff</title>
</svelte:head>

<AuthShell
	eyebrow="Invitation"
	title="Join this Skiff organisation"
	description="Accept the invitation to access its projects, deployments and audit log."
>
	<div class="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-card">
		<span
			class="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-soft-foreground"
		>
			<UsersIcon class="size-5" aria-hidden="true" />
		</span>
		<div class="min-w-0">
			<p class="text-xs text-muted-foreground">Signed in as</p>
			<p class="truncate text-sm font-semibold">{data.email}</p>
		</div>
	</div>

	{#if error}<Notice tone="danger" class="mt-4">{error}</Notice>{/if}

	<Button size="lg" class="mt-6 h-10 w-full" disabled={pending} onclick={accept}>
		{pending ? 'Joining…' : 'Accept invitation'}
	</Button>

	{#snippet footer()}
		Not you? Sign out and open the invitation link from the right account.
	{/snippet}
</AuthShell>
