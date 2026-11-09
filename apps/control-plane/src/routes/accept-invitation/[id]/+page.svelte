<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/yoal/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
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
		else
			window.location.href = data.projectSlug
				? `/projects/${encodeURIComponent(data.projectSlug)}?tab=access`
				: '/overview';
	}
</script>

<svelte:head>
	<title>Accept invitation · Yoal</title>
</svelte:head>

<AuthShell
	eyebrow="Invitation"
	title="Join this Yoal organisation"
	description="Accept the invitation to access its projects, deployments and audit log."
>
	<div class="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-xs">
		<span class="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
			<UsersIcon class="size-5" aria-hidden="true" />
		</span>
		<div class="min-w-0">
			<p class="text-xs text-muted-foreground">Signed in as</p>
			<p class="truncate text-sm font-semibold">{data.email}</p>
		</div>
	</div>

	{#if error}<Alert.Root variant="destructive" class="mt-4"
			><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}

	<Button size="lg" class="mt-6 h-10 w-full" disabled={pending} onclick={accept}>
		{pending ? 'Joining…' : 'Accept invitation'}
	</Button>

	{#snippet footer()}
		Not you? Sign out and open the invitation link from the right account.
	{/snippet}
</AuthShell>
