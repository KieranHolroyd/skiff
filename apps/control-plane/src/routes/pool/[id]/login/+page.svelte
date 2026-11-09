<script lang="ts">
	import { onMount } from 'svelte';
	import { passkeyErrorMessage, passkeysSupported, signInWithPasskey } from '../../_lib/passkeys.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const error = $derived((data as { form?: { error?: string } | null }).form?.error);

	let supported = $state(false);
	let busy = $state(false);
	let passkeyError = $state('');

	onMount(() => {
		supported = passkeysSupported();
	});

	async function usePasskey() {
		busy = true;
		passkeyError = '';
		try {
			const target = await signInWithPasskey(
				data.pool.id,
				data.csrf,
				data.email,
				data.returnTo ?? null
			);
			window.location.assign(target);
		} catch (cause) {
			passkeyError = passkeyErrorMessage(cause);
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

{#if data.verified}
	<div class="pool-notice">Your email address is verified. Sign in to continue.</div>
{:else if data.verifyEmail}
	<div class="pool-notice">
		Check your inbox for a verification link. Follow it, then sign in.
	</div>
{/if}
{#if data.sent === 'magic'}
	<div class="pool-notice">
		If that address has an account, a sign-in link is on its way. It expires in 15 minutes.
	</div>
{:else if data.sent === 'reset'}
	<div class="pool-notice">
		If that address has an account, a password-reset link is on its way. It expires in one hour.
	</div>
{/if}
{#if data.magicError}
	<div class="pool-error">That sign-in link is invalid or has expired. Request a new one below.</div>
{/if}
{#if error}
	<div class="pool-error">{error}</div>
{/if}
{#if passkeyError}
	<div class="pool-error">{passkeyError}</div>
{/if}

{#if supported}
	<button class="pool-submit passkey-button" type="button" onclick={usePasskey} disabled={busy}>
		{busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
	</button>
	<div class="pool-divider"><span>or use your email</span></div>
{/if}

<form method="POST">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="email">Email</label>
		<input
			id="email"
			name="email"
			type="email"
			autocomplete="username webauthn"
			required
			value={data.email}
		/>
	</div>
	<div class="pool-field">
		<label for="password">Password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
		/>
	</div>
	<button class="pool-submit" type="submit">Sign in</button>
</form>

<form method="POST" action="?/magic" class="pool-request">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="link-email">Email for a one-time link</label>
		<input
			id="link-email"
			name="email"
			type="email"
			autocomplete="username"
			required
			value={data.email}
		/>
	</div>
	<div class="pool-request-actions">
		<button class="pool-link-button" type="submit">Email me a sign-in link</button>
		<button class="pool-link-button" type="submit" formaction="?/reset">
			Forgot password?
		</button>
	</div>
</form>

<div class="pool-alt">
	{#if data.pool.signupMode === 'open'}
		New here? <a href={`/pool/${data.pool.id}/signup${data.returnTo ? `?return_to=${encodeURIComponent(data.returnTo)}` : ''}`}>Create an account</a>
	{:else}
		This pool is invite-only. Ask an administrator for an invitation.
	{/if}
</div>

<style>
	.passkey-button {
		background: #fff;
		color: var(--pool-primary);
		border: 1px solid var(--pool-primary);
	}
	.pool-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 1.1rem 0;
		color: #6b7280;
		font-size: 0.75rem;
	}
	.pool-divider::before,
	.pool-divider::after {
		content: '';
		height: 1px;
		flex: 1;
		background: #e5e7eb;
	}
	.pool-request {
		margin-top: 1.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid #e5e7eb;
	}
	.pool-request-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.pool-link-button {
		border: 0;
		background: none;
		padding: 0;
		color: var(--pool-primary);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 550;
		cursor: pointer;
	}
	.pool-link-button:hover {
		text-decoration: underline;
	}
</style>
