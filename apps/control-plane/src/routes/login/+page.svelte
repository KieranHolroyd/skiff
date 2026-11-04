<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import MailIcon from '@lucide/svelte/icons/mail';
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
	let error = $state('');
	let notice = $state('');
	let pending = $state(false);

	/** `redirect` lets a protected site send the visitor back after sign-in. */
	// svelte-ignore state_referenced_locally
	const destination = data.redirect;

	/** After sign-in the OAuth provider may hand back a URL to resume an authorize flow. */
	function continueTo(result: unknown) {
		const next = (result as { url?: string; redirect?: boolean } | null)?.url;
		window.location.href = next ?? destination;
	}

	async function signInWithPassword(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		notice = '';
		const { data: result, error: err } = await authClient.signIn.email({ email, password });
		pending = false;
		if (err) error = err.message ?? 'Sign-in failed';
		else continueTo(result);
	}

	async function signInWithPasskey() {
		pending = true;
		error = '';
		notice = '';
		const { data: result, error: err } = await authClient.signIn.passkey();
		pending = false;
		if (err) error = err.message ?? 'Passkey sign-in failed';
		else continueTo(result);
	}

	async function signInWithGitHub() {
		pending = true;
		error = '';
		notice = '';
		const { error: err } = await authClient.signIn.social({
			provider: 'github',
			callbackURL: destination
		});
		pending = false;
		if (err) error = err.message ?? 'GitHub sign-in failed';
	}

	async function sendMagicLink(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		notice = '';
		const { error: err } = await authClient.signIn.magicLink({ email, callbackURL: destination });
		pending = false;
		if (err) error = err.message ?? 'Could not send the link';
		else notice = 'Check your email for a sign-in link.';
	}
</script>

<svelte:head>
	<title>Sign in · Skiff</title>
</svelte:head>

<AuthShell
	eyebrow="Invite only"
	title="Sign in to Skiff"
	description="Use a passkey or GitHub. No account? Ask an organisation owner for an invitation."
>
	<div class="space-y-3">
		<Button size="lg" class="h-10 w-full" disabled={pending} onclick={signInWithPasskey}>
			<FingerprintIcon aria-hidden="true" />
			Sign in with a passkey
		</Button>
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
	</div>

	<div class="my-6 flex items-center gap-3" aria-hidden="true">
		<span class="h-px flex-1 bg-border"></span>
		<span class="text-xs font-medium text-muted-foreground">or email</span>
		<span class="h-px flex-1 bg-border"></span>
	</div>

	<form class="space-y-3" onsubmit={sendMagicLink}>
		<Field.Field>
			<Field.Label for="magic-email">Email address</Field.Label>
			<Input
				id="magic-email"
				type="email"
				autocomplete="email"
				placeholder="you@example.com"
				class="h-10"
				bind:value={email}
				required
			/>
		</Field.Field>
		<Button type="submit" variant="secondary" size="lg" class="h-10 w-full" disabled={pending}>
			<MailIcon aria-hidden="true" />
			Email me a sign-in link
		</Button>
	</form>

	{#if data.devPasswordLogin}
		<form
			class="mt-6 space-y-3 rounded-xl border border-dashed border-warning/50 bg-warning/5 p-4"
			onsubmit={signInWithPassword}
		>
			<p class="text-xs font-medium text-warning">Development sign-in</p>
			<Field.Field>
				<Field.Label for="email">Email</Field.Label>
				<Input
					id="email"
					type="email"
					autocomplete="username"
					class="bg-card"
					bind:value={email}
					required
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="password">Password</Field.Label>
				<Input
					id="password"
					type="password"
					autocomplete="current-password"
					class="bg-card"
					bind:value={password}
					required
				/>
			</Field.Field>
			<Button type="submit" class="w-full" disabled={pending}>Sign in</Button>
			<p class="text-xs text-muted-foreground">Disabled in production.</p>
		</form>
	{/if}

	{#if error}<Alert.Root variant="destructive" class="mt-5"
			><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}
	{#if notice}<Alert.Root variant="success" class="mt-5"
			><CircleCheckIcon /><Alert.Description>{notice}</Alert.Description></Alert.Root
		>{/if}

	{#snippet footer()}
		Signed-in sessions can be reviewed and revoked at any time under Settings → Account.
	{/snippet}
</AuthShell>
