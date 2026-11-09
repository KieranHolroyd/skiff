<script lang="ts">
	import { enhance } from '$app/forms';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import MailCheckIcon from '@lucide/svelte/icons/mail-check';
	import AuthShell from '#lib/components/yoal/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let pending = $state(false);

	const verified = $derived(form && 'verified' in form ? form.verified : null);
	const failure = $derived(form && 'message' in form ? form.message : null);
	const orgName = $derived(verified?.orgName ?? data.link?.orgName ?? 'An organisation');
</script>

<svelte:head>
	<title>Confirm your email address · Yoal</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthShell
	eyebrow="Email"
	title={verified ? 'Address confirmed' : 'Confirm your email address'}
	description={verified
		? `${orgName} can now send test messages to ${verified.address}.`
		: `${orgName} is setting up email on Yoal and asked to send test messages to this address.`}
>
	{#if verified}
		<div class="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-xs">
			<span class="grid size-10 shrink-0 place-items-center rounded-lg bg-success/10 text-success">
				<CircleCheckIcon class="size-5" aria-hidden="true" />
			</span>
			<p class="min-w-0 truncate font-mono text-sm">{verified.address}</p>
		</div>
		<p class="mt-4 text-sm text-muted-foreground">
			You can close this page. To stop receiving their mail later, use the unsubscribe link in it or
			ask them to remove your address.
		</p>
	{:else if failure}
		<Alert.Root variant="destructive"
			><CircleAlertIcon /><Alert.Description>{failure}</Alert.Description></Alert.Root
		>
	{:else if !data.link}
		<Alert.Root variant="destructive"
			><CircleAlertIcon /><Alert.Description
				>This link is not valid or was already used.</Alert.Description
			></Alert.Root
		>
	{:else if data.link.expired}
		<Alert.Root variant="destructive"
			><CircleAlertIcon /><Alert.Description
				>This link has expired. Ask whoever added your address to send a new one.</Alert.Description
			></Alert.Root
		>
	{:else}
		<div class="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-xs">
			<span class="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
				<MailCheckIcon class="size-5" aria-hidden="true" />
			</span>
			<div class="min-w-0">
				<p class="text-xs text-muted-foreground">Allow mail from {orgName} to</p>
				<p class="truncate font-mono text-sm font-semibold">{data.link.address}</p>
			</div>
		</div>
		<form
			method="POST"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update();
					pending = false;
				};
			}}
		>
			<input type="hidden" name="token" value={data.token} />
			<Button type="submit" size="lg" class="mt-6 h-10 w-full" disabled={pending}>
				{pending ? 'Confirming…' : 'Confirm this address'}
			</Button>
		</form>
	{/if}

	{#snippet footer()}
		Don't know {orgName}? Close this page: nothing is sent to you unless you confirm.
	{/snippet}
</AuthShell>
