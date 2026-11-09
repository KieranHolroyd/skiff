<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import MailIcon from '@lucide/svelte/icons/mail';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import { authClient } from '#lib/auth-client.js';
	import AuthSplitShell from '#lib/components/skiff/AuthSplitShell.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import ForgeMark from '#lib/components/skiff/ForgeMark.svelte';
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
	let step = $state<'email' | 'methods' | 'code'>('email');
	let useBackup = $state(false);
	/** Passkeys need a secure context (HTTPS or localhost); hide the button where they can't work. */
	let passkeys = $state(true);

	onMount(() => {
		passkeys = window.isSecureContext && 'PublicKeyCredential' in window;
	});

	/** `redirect` lets a protected site send the visitor back after sign-in. */
	// svelte-ignore state_referenced_locally
	const destination = data.redirect;

	const fieldInput =
		'h-11 rounded-xl border-border/80 bg-muted/30 px-3.5 text-[0.95rem] shadow-none transition-colors focus-visible:border-brand/60 focus-visible:ring-brand/20';
	const primaryButton =
		'h-11 w-full rounded-xl bg-brand font-semibold text-[#141a2a] shadow-lg shadow-brand/20 transition-colors hover:bg-brand/90 focus-visible:ring-brand/40 disabled:opacity-60';
	const secondaryButton =
		'h-11 w-full justify-start gap-3 rounded-xl border-border/80 bg-background/70 px-4 font-medium shadow-none hover:bg-muted/50';

	/** After sign-in the OAuth provider may hand back a URL to resume an authorize flow. */
	function continueTo(result: unknown) {
		const next = (result as { url?: string; redirect?: boolean } | null)?.url;
		window.location.href = next ?? destination;
	}

	function reset() {
		error = '';
		notice = '';
	}

	/**
	 * Email first (IAM.md §8.3): a verified domain sends the browser to its organisation's IdP.
	 * Resolution uses Skiff's own `sso_domains` check (exact hostname, verified only), then the
	 * Better Auth plugin starts the flow for that provider id. No provider means the address falls
	 * through to the methods below, and the server-side policy still refuses a method the
	 * organisation does not allow.
	 */
	async function startSignIn(event: SubmitEvent) {
		event.preventDefault();
		reset();
		const address = email.trim();
		if (!address) {
			error = 'Enter your email address first.';
			return;
		}
		pending = true;
		try {
			const response = await fetch(`/api/v1/sso/resolve?email=${encodeURIComponent(address)}`, {
				headers: { accept: 'application/json' }
			});
			const resolved = response.ok
				? ((await response.json()) as { provider?: { id: string } | null })
				: null;
			const providerId = resolved?.provider?.id;
			if (providerId) {
				const { data: result, error: err } = await authClient.signIn.sso({
					providerId,
					loginHint: address,
					callbackURL: destination
				});
				if (result?.url) {
					window.location.href = result.url;
					return;
				}
				if (err) error = err.message ?? 'Could not start single sign-on.';
				step = 'methods';
				return;
			}
			step = 'methods';
		} catch {
			step = 'methods';
		} finally {
			pending = false;
		}
	}

	function changeEmail() {
		password = '';
		code = '';
		useBackup = false;
		reset();
		step = 'email';
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

	async function signInWithGitLab() {
		pending = true;
		reset();
		const { error: err } = await authClient.signIn.social({
			provider: 'gitlab',
			callbackURL: destination
		});
		pending = false;
		if (err) error = err.message ?? 'GitLab sign-in failed';
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
	<title>Sign into your cloud</title>
</svelte:head>

<AuthSplitShell
	eyebrow={step === 'code' ? 'Second factor' : 'Invite only'}
	title={step === 'code' ? 'Enter your code' : 'Sign into your cloud'}
	description={step === 'code'
		? useBackup
			? 'Use one of the backup codes you saved when you set up the authenticator app.'
			: 'Open your authenticator app and enter the 6-digit code for Skiff.'
		: step === 'email'
			? 'Enter your work email. If your organisation uses single sign-on, you go straight to its identity provider.'
			: 'No account? Ask an organisation owner for an invitation.'}
>
	{#if step === 'code'}
		<form class="space-y-4" onsubmit={verifyCode}>
			<Field.Field>
				<Field.Label for="code">{useBackup ? 'Backup code' : 'Authenticator code'}</Field.Label>
				<Input
					id="code"
					bind:value={code}
					inputmode={useBackup ? 'text' : 'numeric'}
					autocomplete="one-time-code"
					placeholder={useBackup ? '' : '123 456'}
					class="{fieldInput} h-12 text-center font-mono text-lg tracking-[0.3em]"
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class={primaryButton} disabled={pending}>
				{#if useBackup}<KeyRoundIcon aria-hidden="true" />{:else}<SmartphoneIcon
						aria-hidden="true"
					/>{/if}
				Verify and continue
			</Button>
		</form>
		<div class="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
			<button
				type="button"
				class="underline-offset-4 hover:text-foreground hover:underline"
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
				class="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
				onclick={() => {
					step = 'methods';
					code = '';
					reset();
				}}>Back</button
			>
		</div>
	{:else if step === 'email'}
		<form class="space-y-4" onsubmit={startSignIn}>
			<Field.Field>
				<Field.Label for="email">Email address</Field.Label>
				<Input
					id="email"
					type="email"
					autocomplete="username"
					placeholder="you@example.com"
					class={fieldInput}
					bind:value={email}
					required
				/>
				<Field.Description>
					We use the domain to find your organisation's sign-in method.
				</Field.Description>
			</Field.Field>
			<Button type="submit" size="lg" class={primaryButton} disabled={pending}>
				<LogInIcon aria-hidden="true" />
				Continue
			</Button>
		</form>
	{:else}
		<div
			class="mb-5 flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 py-2 pr-2 pl-2.5"
		>
			<div class="flex min-w-0 items-center gap-2.5">
				<span
					class="grid size-7 shrink-0 place-items-center rounded-lg bg-background text-xs font-semibold uppercase shadow-xs"
				>
					{email.slice(0, 1)}
				</span>
				<span class="truncate text-sm font-medium">{email}</span>
			</div>
			<button
				type="button"
				class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
				onclick={changeEmail}>Change</button
			>
		</div>
		<form class="space-y-4" onsubmit={signInWithPassword}>
			<input type="hidden" name="email" value={email} />
			<Field.Field>
				<div class="flex items-baseline justify-between gap-2">
					<Field.Label for="password">Password</Field.Label>
					<a
						class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						href={resolve('/forgot-password')}>Forgot password?</a
					>
				</div>
				<Input
					id="password"
					type="password"
					autocomplete="current-password"
					class={fieldInput}
					bind:value={password}
					required
				/>
			</Field.Field>
			<Button type="submit" size="lg" class={primaryButton} disabled={pending}>
				<LogInIcon aria-hidden="true" />
				Sign in
			</Button>
			<button
				type="button"
				class="mx-auto flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				disabled={pending}
				onclick={sendMagicLink}
			>
				<MailIcon class="size-3.5" aria-hidden="true" />
				Email me a sign-in link instead
			</button>
		</form>

		{#if passkeys || data.github || data.gitlab}
			<div class="my-6 flex items-center gap-3" aria-hidden="true">
				<span class="h-px flex-1 bg-border"></span>
				<span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
					>or continue with</span
				>
				<span class="h-px flex-1 bg-border"></span>
			</div>
			<div class="space-y-2.5">
				{#if passkeys}
					<Button
						size="lg"
						variant="outline"
						class={secondaryButton}
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
						class={secondaryButton}
						disabled={pending}
						onclick={signInWithGitHub}
					>
						<GitHubMark />
						Continue with GitHub
					</Button>
				{/if}
				{#if data.gitlab}
					<Button
						size="lg"
						variant="outline"
						class={secondaryButton}
						disabled={pending}
						onclick={signInWithGitLab}
					>
						<ForgeMark kind="gitlab" />
						Continue with GitLab
					</Button>
				{/if}
			</div>
		{/if}
	{/if}

	{#if error}<Alert.Root variant="destructive" class="mt-6"
			><CircleAlertIcon /><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}
	{#if notice}<Alert.Root variant="success" class="mt-6"
			><CircleCheckIcon /><Alert.Description class="break-words">{notice}</Alert.Description
			></Alert.Root
		>{/if}

	{#snippet footer()}
		Signed-in sessions can be reviewed and revoked at any time under Settings → Account.
	{/snippet}
</AuthSplitShell>
