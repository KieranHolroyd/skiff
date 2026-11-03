<script lang="ts">
	import { authClient } from '#lib/auth-client.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let email = $state('');
	let password = $state('');
	let error = $state('');
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
		const { data: result, error: err } = await authClient.signIn.email({ email, password });
		pending = false;
		if (err) error = err.message ?? 'Sign-in failed';
		else continueTo(result);
	}

	async function signInWithPasskey() {
		pending = true;
		error = '';
		const { data: result, error: err } = await authClient.signIn.passkey();
		pending = false;
		if (err) error = err.message ?? 'Passkey sign-in failed';
		else continueTo(result);
	}

	async function signInWithGitHub() {
		pending = true;
		error = '';
		const { error: err } = await authClient.signIn.social({
			provider: 'github',
			callbackURL: destination,
		});
		pending = false;
		if (err) error = err.message ?? 'GitHub sign-in failed';
	}

	async function sendMagicLink(event: SubmitEvent) {
		event.preventDefault();
		pending = true;
		error = '';
		const { error: err } = await authClient.signIn.magicLink({ email, callbackURL: destination });
		pending = false;
		if (err) error = err.message ?? 'Could not send the link';
		else error = 'Check your email for a sign-in link.';
	}
</script>

<main class="flex min-h-svh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Sign in to Skiff</Card.Title>
			<Card.Description>Passkeys and GitHub are the primary sign-in methods. Invite only.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<Button class="w-full" disabled={pending} onclick={signInWithPasskey}>Sign in with a passkey</Button>
			<Button class="w-full" variant="outline" disabled={pending} onclick={signInWithGitHub}>
				Continue with GitHub
			</Button>

			<form class="space-y-3 border-t pt-4" onsubmit={sendMagicLink}>
				<div class="space-y-1">
					<Label for="magic-email">Email a sign-in link</Label>
					<Input id="magic-email" type="email" autocomplete="email" bind:value={email} required />
				</div>
				<Button type="submit" variant="secondary" class="w-full" disabled={pending}>Send magic link</Button>
			</form>

			{#if data.devPasswordLogin}
				<form class="space-y-3 border-t pt-4" onsubmit={signInWithPassword}>
					<p class="text-xs text-muted-foreground">Development sign-in (disabled in production)</p>
					<div class="space-y-1">
						<Label for="email">Email</Label>
						<Input id="email" type="email" autocomplete="username" bind:value={email} required />
					</div>
					<div class="space-y-1">
						<Label for="password">Password</Label>
						<Input id="password" type="password" autocomplete="current-password" bind:value={password} required />
					</div>
					<Button type="submit" class="w-full" disabled={pending}>Sign in</Button>
				</form>
			{/if}

			{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
		</Card.Content>
	</Card.Root>
</main>
