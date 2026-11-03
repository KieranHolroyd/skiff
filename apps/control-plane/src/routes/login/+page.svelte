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

	/** After sign-in the OAuth provider may hand back a URL to resume an authorize flow. */
	function continueTo(result: unknown) {
		const next = (result as { url?: string; redirect?: boolean } | null)?.url;
		window.location.href = next ?? '/';
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
</script>

<main class="flex min-h-svh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Sign in to Skiff</Card.Title>
			<Card.Description>Passkeys and GitHub sign-in arrive with the auth milestone.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<Button class="w-full" disabled>Sign in with a passkey</Button>
			<Button class="w-full" variant="outline" disabled>Continue with GitHub</Button>

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
					{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
					<Button type="submit" class="w-full" disabled={pending}>Sign in</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</main>
