<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/skiff/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let password = $state('');
	let confirm = $state('');
	let pending = $state(false);
	let error = $state('');
	let done = $state(false);
	// svelte-ignore state_referenced_locally
	let invalid = $state(data.invalid);
	// svelte-ignore state_referenced_locally
	const token = data.token;

	// Drop the token from the address bar and history once it is in memory.
	onMount(() => {
		if (location.search) replaceState(resolve('/reset-password'), {});
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		if (password.length < data.minLength) {
			error = `Use at least ${data.minLength} characters.`;
			return;
		}
		if (password !== confirm) {
			error = 'The passwords don’t match.';
			return;
		}
		pending = true;
		const { error: err } = await authClient.resetPassword({ newPassword: password, token });
		pending = false;
		if (err) {
			if (err.code === 'INVALID_TOKEN') invalid = true;
			else
				error =
					err.status === 429
						? 'Too many attempts from this network. Wait a minute and try again.'
						: (err.message ?? 'Could not set the new password.');
			return;
		}
		password = confirm = '';
		done = true;
	}
</script>

<svelte:head>
	<title>Choose a new password · Skiff</title>
	<meta name="robots" content="noindex" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthShell
	eyebrow="Password reset"
	title={done ? 'Password changed' : invalid ? 'This link doesn’t work' : 'Choose a new password'}
	description={done
		? 'You have been signed out on every device. Sign in with your new password.'
		: invalid
			? `Reset links work once and expire after ${data.ttlMinutes} minutes. Request a new one.`
			: `Use ${data.minLength} to ${data.maxLength} characters. Saving it signs you out on every device.`}
>
	{#if done}
		<Alert.Root variant="success"
			><CircleCheckIcon /><Alert.Description
				>Your new password is saved. Owners verify a passkey or authenticator code after signing in,
				as before.</Alert.Description
			></Alert.Root
		>
		<Button size="lg" class="mt-6 h-10 w-full" href="/login">Sign in</Button>
	{:else if invalid}
		<Alert.Root variant="destructive"
			><CircleAlertIcon /><Alert.Description
				>The link has expired, was already used, or was replaced by a newer one.</Alert.Description
			></Alert.Root
		>
		<Button size="lg" class="mt-6 h-10 w-full" href="/forgot-password">Request a new link</Button>
		<p class="mt-4 text-center text-sm text-muted-foreground">
			<a class="underline underline-offset-4" href={resolve('/login')}>Back to sign-in</a>
		</p>
	{:else}
		<form class="space-y-3" onsubmit={submit}>
			<Field.Field>
				<Field.Label for="password">New password</Field.Label>
				<Input
					id="password"
					type="password"
					autocomplete="new-password"
					minlength={data.minLength}
					maxlength={data.maxLength}
					class="h-10"
					bind:value={password}
					required
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="confirm">Confirm new password</Field.Label>
				<Input
					id="confirm"
					type="password"
					autocomplete="new-password"
					maxlength={data.maxLength}
					class="h-10"
					bind:value={confirm}
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>
				<KeyRoundIcon aria-hidden="true" />
				{pending ? 'Saving…' : 'Save new password'}
			</Button>
		</form>
		{#if error}<Alert.Root variant="destructive" class="mt-5"
				><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
			>{/if}
	{/if}
</AuthShell>
