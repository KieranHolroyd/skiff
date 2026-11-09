<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { addPasskey, passkeyErrorMessage, passkeysSupported } from '../_lib/passkeys.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const form = $derived(
		(data as {
			form?: {
				error?: string;
				sent?: boolean;
				removed?: boolean;
				totpEnrolment?: { secret: string; otpauthUri: string; account: string; issuer: string };
				recoveryCodes?: string[];
				totpDisabled?: boolean;
			} | null;
		}).form
	);
	const error = $derived(form?.error);
	const authAppRequired = $derived(data.pool.mfaRequired ?? false);

	let supported = $state(false);
	let busy = $state(false);
	let passkeyError = $state('');
	let passkeyNotice = $state('');
	let passkeyName = $state('');

	onMount(() => {
		supported = passkeysSupported();
	});

	async function add() {
		busy = true;
		passkeyError = '';
		passkeyNotice = '';
		try {
			await addPasskey(data.pool.id, data.csrf, passkeyName.trim());
			passkeyName = '';
			passkeyNotice = 'Passkey added. You can use it to sign in next time.';
			await invalidateAll();
		} catch (cause) {
			passkeyError = passkeyErrorMessage(cause);
		} finally {
			busy = false;
		}
	}

	function recoveryCopy(codes: string[]): string {
		return codes.join('\n');
	}

	function addedOn(value: number): string {
		return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}
</script>

<svelte:head>
	<title>Signed in · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

<p style="margin-bottom: 1rem; font-size: 0.9rem; color: #374151;">
	Signed in as <strong>{data.user.email}</strong>.
</p>

{#if !data.user.emailVerified}
	<div class="pool-notice">
		Your email address is not verified yet. Some pool features may be limited until you follow the
		link we sent.
	</div>
	{#if form?.sent}
		<div class="pool-notice">A fresh verification link is on its way.</div>
	{:else}
		<form method="POST" action="?/resend" class="pool-resend">
			<input type="hidden" name="csrf" value={data.csrf} />
			<button class="pool-submit" type="submit">Resend verification email</button>
		</form>
	{/if}
{/if}

{#if error}
	<div class="pool-error">{error}</div>
{:else if passkeyError}
	<div class="pool-error">{passkeyError}</div>
{:else if passkeyNotice}
	<div class="pool-notice">{passkeyNotice}</div>
{:else if form?.removed}
	<div class="pool-notice">That passkey was removed.</div>
{:else if form?.totpDisabled}
	<div class="pool-notice">Two-factor authentication is off.</div>
{/if}

{#if data.groups.length > 0}
	<p class="pool-groups">
		Groups: {data.groups.join(', ')}
	</p>
{/if}

<section class="mfa">
	<h2>Two-factor authentication</h2>
	{#if form?.recoveryCodes}
		<div class="pool-notice">
			Save these recovery codes somewhere safe. Each works once, and this is the only time they
			are shown.
			<ul class="recovery-list">
				{#each form.recoveryCodes as recoveryCode (recoveryCode)}
					<li><code>{recoveryCode}</code></li>
				{/each}
			</ul>
			<button
				class="pool-link-button"
				type="button"
				onclick={() => navigator.clipboard?.writeText(recoveryCopy(form?.recoveryCodes ?? []))}
			>
				Copy all codes
			</button>
		</div>
	{/if}

	{#if data.totp.enabled}
		<p class="mfa-intro">
			Enabled {data.totp.confirmedAt ? addedOn(data.totp.confirmedAt) : ''}.
			{data.totp.recoveryCodesRemaining} recovery code{data.totp.recoveryCodesRemaining === 1
				? ''
				: 's'} left.
		</p>
		<details class="mfa-details">
			<summary>Replace recovery codes</summary>
			<form method="POST" action="?/regenerateRecoveryCodes" class="mfa-form">
				<input type="hidden" name="csrf" value={data.csrf} />
				<div class="pool-field">
					<label for="regen-code">Current authenticator code or recovery code</label>
					<input id="regen-code" name="code" type="text" autocomplete="one-time-code" required />
				</div>
				<button class="pool-submit" type="submit">Generate new recovery codes</button>
			</form>
		</details>
		<details class="mfa-details">
			<summary>Turn off two-factor authentication</summary>
			<form method="POST" action="?/disableTotp" class="mfa-form">
				<input type="hidden" name="csrf" value={data.csrf} />
				<div class="pool-field">
					<label for="disable-code">Current authenticator code or recovery code</label>
					<input id="disable-code" name="code" type="text" autocomplete="one-time-code" required />
				</div>
				<button class="pool-submit mfa-danger" type="submit">Turn off two-factor authentication</button>
			</form>
		</details>
	{:else if form?.totpEnrolment}
		{@const enrolment = form.totpEnrolment}
		<p class="mfa-intro">
			Add this account to your authenticator app, then enter the six-digit code it shows.
		</p>
		<div class="mfa-secret">
			<p><strong>Secret</strong> <code>{enrolment.secret}</code></p>
			<p><strong>URI</strong> <code class="mfa-uri">{enrolment.otpauthUri}</code></p>
		</div>
		<form method="POST" action="?/confirmTotp" class="mfa-form">
			<input type="hidden" name="csrf" value={data.csrf} />
			<div class="pool-field">
				<label for="confirm-code">Six-digit code</label>
				<input
					id="confirm-code"
					name="code"
					type="text"
					inputmode="numeric"
					pattern={String.raw`[0-9 ]{6,9}`}
					autocomplete="one-time-code"
					required
				/>
			</div>
			<button class="pool-submit" type="submit">Enable two-factor authentication</button>
		</form>
	{:else}
		<p class="mfa-intro">
			{authAppRequired
				? 'This pool asks every account to use an authenticator app.'
				: 'Add a second step to sign-in with an authenticator app.'}
		</p>
		<form method="POST" action="?/beginTotp">
			<input type="hidden" name="csrf" value={data.csrf} />
			<button class="pool-submit" type="submit">Set up two-factor authentication</button>
		</form>
	{/if}
</section>

<section class="passkeys">
	<h2>Passkeys</h2>
	<p class="passkeys-intro">
		A passkey signs you in with your fingerprint, face or device PIN. It works without a password
		and cannot be phished.
	</p>

	{#if data.passkeys.length > 0}
		<ul class="passkey-list">
			{#each data.passkeys as passkey (passkey.id)}
				<li>
					<span class="passkey-meta">
						<strong>{passkey.name}</strong>
						<span>Added {addedOn(passkey.createdAt)}{passkey.lastUsedAt ? ` · last used ${addedOn(passkey.lastUsedAt)}` : ''}</span>
					</span>
					<form method="POST" action="?/removePasskey">
						<input type="hidden" name="csrf" value={data.csrf} />
						<input type="hidden" name="passkey_id" value={passkey.id} />
						<button class="passkey-remove" type="submit">Remove</button>
					</form>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="passkeys-empty">No passkeys yet.</p>
	{/if}

	{#if supported}
		<form
			class="passkey-add"
			onsubmit={(event) => {
				event.preventDefault();
				void add();
			}}
		>
			<div class="pool-field">
				<label for="passkey-name">Name this passkey (optional)</label>
				<input
					id="passkey-name"
					name="passkey-name"
					type="text"
					maxlength="80"
					placeholder="e.g. My laptop"
					bind:value={passkeyName}
				/>
			</div>
			<button class="pool-submit" type="submit" disabled={busy}>
				{busy ? 'Waiting for your device…' : 'Add a passkey'}
			</button>
		</form>
	{:else}
		<p class="passkeys-empty">Passkeys need HTTPS (or localhost) and a supported browser.</p>
	{/if}
</section>

<div class="pool-alt">
	<a href={`/pool/${data.pool.id}/logout`}>Sign out</a>
</div>

<style>
	.pool-resend {
		margin-bottom: 1rem;
	}
	.passkeys {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid #e5e7eb;
	}
	.mfa {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid #e5e7eb;
	}
	.mfa h2 {
		font-size: 1rem;
		font-weight: 650;
		margin-bottom: 0.35rem;
	}
	.mfa-intro,
	.pool-groups {
		font-size: 0.85rem;
		color: #4b5563;
		margin-bottom: 0.9rem;
	}
	.pool-groups {
		margin-bottom: 0.5rem;
	}
	.mfa-secret {
		border: 1px solid #e5e7eb;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		font-size: 0.8rem;
		margin-bottom: 0.9rem;
		overflow-wrap: anywhere;
	}
	.mfa-secret p {
		margin-bottom: 0.35rem;
	}
	.mfa-uri {
		font-size: 0.7rem;
	}
	.mfa-details {
		border: 1px solid #e5e7eb;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		margin-bottom: 0.75rem;
		font-size: 0.85rem;
	}
	.mfa-details summary {
		cursor: pointer;
		font-weight: 550;
	}
	.mfa-form {
		margin-top: 0.75rem;
	}
	.mfa-danger {
		background: #b91c1c;
	}
	.recovery-list {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.35rem;
		margin: 0.6rem 0;
		padding: 0;
	}
	.passkeys h2 {
		font-size: 1rem;
		font-weight: 650;
		margin-bottom: 0.35rem;
	}
	.passkeys-intro,
	.passkeys-empty {
		font-size: 0.85rem;
		color: #4b5563;
		margin-bottom: 0.9rem;
	}
	.passkey-list {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.passkey-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border: 1px solid #e5e7eb;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
	}
	.passkey-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.85rem;
	}
	.passkey-meta span {
		color: #6b7280;
		font-size: 0.75rem;
	}
	.passkey-remove {
		border: 0;
		background: none;
		padding: 0;
		color: var(--pool-primary);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 550;
		cursor: pointer;
	}
	.passkey-remove:hover {
		text-decoration: underline;
	}
	.passkey-add {
		margin-top: 0.5rem;
	}
</style>
