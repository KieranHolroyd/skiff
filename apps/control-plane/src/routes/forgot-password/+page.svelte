<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/yoal/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let email = $state('');
	let pending = $state(false);
	let error = $state('');
	/** The address a link was requested for: the answer is the same whether it has an account. */
	let sentTo = $state('');

	async function requestLink(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const address = email.trim();
		const { error: err } = await authClient.requestPasswordReset({
			email: address,
			redirectTo: '/reset-password'
		});
		pending = false;
		if (err) {
			error =
				err.status === 429
					? 'Too many requests from this network. Wait a minute and try again.'
					: (err.message ?? 'Could not request a reset link.');
			return;
		}
		sentTo = address;
	}
</script>

<svelte:head>
	<title>Forgot password · Yoal</title>
</svelte:head>

<AuthShell
	eyebrow="Password reset"
	title={sentTo ? 'Check your email' : 'Forgot your password?'}
	description={sentTo
		? `If ${sentTo} belongs to a Yoal account, a reset link is on its way. It works once and expires in ${data.ttlMinutes} minutes.`
		: data.emailConfigured
			? 'Enter the email address you sign in with and we’ll send you a link to choose a new password.'
			: 'This server can’t send email, so it can’t send you a reset link.'}
>
	{#if sentTo}
		<p class="text-sm text-muted-foreground">
			Nothing after a few minutes? Check your spam folder, or ask the person who runs this Yoal
			server to reset it for you. Resetting signs you out on every device.
		</p>
		<Button size="lg" variant="outline" class="mt-6 h-10 w-full" href="/login"
			>Back to sign-in</Button
		>
	{:else if data.emailConfigured}
		<form class="space-y-3" onsubmit={requestLink}>
			<Field.Field>
				<Field.Label for="email">Email address</Field.Label>
				<Input
					id="email"
					type="email"
					autocomplete="username"
					placeholder="you@example.com"
					class="h-10"
					bind:value={email}
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>
				<MailIcon aria-hidden="true" />
				{pending ? 'Sending…' : 'Email me a reset link'}
			</Button>
		</form>
		{#if error}<Alert.Root variant="destructive" class="mt-5"
				><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
			>{/if}
	{:else}
		<Alert.Root>
			<InfoIcon />
			<Alert.Description>
				Ask the person who runs this Yoal server to reset your password. They run the
				<code class="font-mono text-xs">reset-password</code> script on the control plane, which sets
				a new password and signs you out everywhere.
			</Alert.Description>
		</Alert.Root>
		<p class="mt-4 text-sm text-muted-foreground">
			Until then, any other sign-in method you have set up, such as a passkey or GitHub, still
			works.
		</p>
	{/if}

	{#if !sentTo}
		<p class="mt-6 text-center text-sm text-muted-foreground">
			<a class="underline underline-offset-4" href={resolve('/login')}>Back to sign-in</a>
		</p>
	{/if}

	{#snippet footer()}
		A reset never signs you in. Owners still verify a passkey or authenticator code at the next
		sign-in.
	{/snippet}
</AuthShell>
