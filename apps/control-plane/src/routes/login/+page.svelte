<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/skiff/AuthShell.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let email = $state('');
	let password = $state('');
	let code = $state('');
	let error = $state('');
	let notice = $state('');
	let pending = $state(false);
	/** After a password sign-in for an account with an authenticator app (D10, D103). */
	let step = $state<'credentials' | 'code'>('credentials');
	let useBackup = $state(false);
	/** Passkeys need a secure context (HTTPS or localhost); hide the button where they can't work. */
	let passkeys = $state(true);

	onMount(() => {
		passkeys = window.isSecureContext && 'PublicKeyCredential' in window;
	});

	/** `redirect` lets a protected site send the visitor back after sign-in. */
	// svelte-ignore state_referenced_locally
	const destination = data.redirect;

	/** After sign-in the OAuth provider may hand back a URL to resume an authorize flow. */
	function continueTo(result: unknown) {
		const next = (result as { url?: string; redirect?: boolean } | null)?.url;
		window.location.href = next ?? destination;
	}

	function reset() {
		error = '';
		notice = '';
	}

	async function signInWithPassword(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		reset();
		const { data: result, error: err } = await authClient.signIn.email({ email, password });
		pending = false;
		if (err) {
			error =
				err.status === 401 || err.code === 'INVALID_EMAIL_OR_PASSWORD'
					? 'That email and password don’t match. Forgot it? Reset it, or use a sign-in link below.'
					: (err.message ?? 'Sign-in failed');
			return;
		}
		if ((result as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
			step = 'code';
			password = '';
			return;
		}
		continueTo(result);
	}

	async function verifyCode(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		reset();
		const value = useBackup ? code.trim() : code.replace(/[\s-]/g, '');
		const { data: result, error: err } = useBackup
			? await authClient.twoFactor.verifyBackupCode({ code: value })
			: await authClient.twoFactor.verifyTotp({ code: value });
		pending = false;
		if (err) error = err.message ?? 'That code didn’t work.';
		else continueTo(result);
	}

	async function signInWithPasskey() {
		pending = true;
		reset();
		const { data: result, error: err } = await authClient.signIn.passkey();
		pending = false;
		if (err) error = err.message ?? 'Passkey sign-in failed';
		else continueTo(result);
	}

	async function signInWithGitHub() {
		pending = true;
		reset();
		const { error: err } = await authClient.signIn.social({
			provider: 'github',
			callbackURL: destination
		});
		pending = false;
		if (err) error = err.message ?? 'GitHub sign-in failed';
	}

	async function sendMagicLink() {
		reset();
		if (!email) {
			error = 'Enter your email address first.';
			return;
		}
		pending = true;
		const { error: err } = await authClient.signIn.magicLink({ email, callbackURL: destination });
		pending = false;
		if (err) error = err.message ?? 'Could not send the link';
		else
			notice = data.emailToLog
				? 'Sign-in link created. Email isn’t set up on this server, so it is in the server log: journalctl -u skiff-control-plane | grep magic-link'
				: 'Check your email for a sign-in link.';
	}
</script>

<svelte:head>
	<title>Sign in · Skiff</title>
</svelte:head>

<AuthShell
	eyebrow="Invite only"
	title={step === 'code' ? 'Enter your code' : 'Sign in to Skiff'}
	description={step === 'code'
		? useBackup
			? 'Use one of the backup codes you saved when you set up the authenticator app.'
			: 'Open your authenticator app and enter the 6-digit code for Skiff.'
		: 'No account? Ask an organisation owner for an invitation.'}
>
	{#if step === 'code'}
		<form class="space-y-3" onsubmit={verifyCode}>
			<Field.Field>
				<Field.Label for="code">{useBackup ? 'Backup code' : 'Authenticator code'}</Field.Label>
				<Input
					id="code"
					bind:value={code}
					inputmode={useBackup ? 'text' : 'numeric'}
					autocomplete="one-time-code"
					placeholder={useBackup ? '' : '123 456'}
					class="h-10 font-mono tracking-widest"
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>
				{#if useBackup}<KeyRoundIcon aria-hidden="true" />{:else}<SmartphoneIcon
						aria-hidden="true"
					/>{/if}
				Verify
			</Button>
		</form>
		<div class="mt-3 flex justify-between text-xs text-muted-foreground">
			<button
				type="button"
				class="underline-offset-4 hover:underline"
				onclick={() => {
					useBackup = !useBackup;
					code = '';
					reset();
				}}
			>
				{useBackup ? 'Use the authenticator app' : 'Lost your device? Use a backup code'}
			</button>
			<button
				type="button"
				class="underline-offset-4 hover:underline"
				onclick={() => {
					step = 'credentials';
					code = '';
					reset();
				}}>Back</button
			>
		</div>
	{:else}
		<form class="space-y-3" onsubmit={signInWithPassword}>
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
			<Field.Field>
				<div class="flex items-baseline justify-between gap-2">
					<Field.Label for="password">Password</Field.Label>
					<a
						class="text-xs text-muted-foreground underline-offset-4 hover:underline"
						href={resolve('/forgot-password')}
						>Forgot password?</a
					>
				</div>
				<Input
					id="password"
					type="password"
					autocomplete="current-password"
					class="h-10"
					bind:value={password}
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>
				<LogInIcon aria-hidden="true" />
				Sign in
			</Button>
			<button
				type="button"
				class="text-xs text-muted-foreground underline-offset-4 hover:underline"
				disabled={pending}
				onclick={sendMagicLink}
			>
				No password, or prefer a link? Email me a sign-in link
			</button>
		</form>

		{#if passkeys || data.github}
			<div class="my-6 flex items-center gap-3" aria-hidden="true">
				<span class="h-px flex-1 bg-border"></span>
				<span class="text-xs font-medium text-muted-foreground">or</span>
				<span class="h-px flex-1 bg-border"></span>
			</div>
			<div class="space-y-3">
				{#if passkeys}
					<Button
						size="lg"
						variant="outline"
						class="h-10 w-full"
						disabled={pending}
						onclick={signInWithPasskey}
					>
						<FingerprintIcon aria-hidden="true" />
						Sign in with a passkey
					</Button>
				{/if}
				{#if data.github}
					<Button
						size="lg"
						variant="outline"
						class="h-10 w-full"
						disabled={pending}
						onclick={signInWithGitHub}
					>
						<GitHubMark />
						Continue with GitHub
					</Button>
				{/if}
			</div>
		{/if}
	{/if}

	{#if error}<Alert.Root variant="destructive" class="mt-5"
			><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}
	{#if notice}<Alert.Root variant="success" class="mt-5"
			><CircleCheckIcon /><Alert.Description class="break-words">{notice}</Alert.Description
			></Alert.Root
		>{/if}

	{#snippet footer()}
		Signed-in sessions can be reviewed and revoked at any time under Settings → Account.
	{/snippet}
</AuthShell>
