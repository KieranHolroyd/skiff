<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import { authClient } from '#lib/auth-client.js';
	import AuthSplitShell from '#lib/components/yoal/AuthSplitShell.svelte';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	interface TwoFactorFormResult {
		message?: string;
		step?: 'verify' | 'backup';
		totpURI?: string;
		secret?: string;
		backupCodes?: string[];
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as TwoFactorFormResult | null);

	let error = $state('');
	let pending = $state(false);
	let useBackup = $state(false);
	let passkeySupported = $state<boolean | null>(null);
	/** Enrolment details survive a failed verify (the action result is replaced by the error). */
	let enrolment = $state<{ totpURI: string; secret: string; backupCodes: string[] } | null>(null);

	onMount(() => {
		passkeySupported = 'PublicKeyCredential' in window;
	});

	$effect(() => {
		if (result?.totpURI)
			enrolment = {
				totpURI: result.totpURI,
				secret: result.secret ?? '',
				backupCodes: result.backupCodes ?? []
			};
	});

	const fieldInput =
		'h-11 rounded-xl border-border/80 bg-muted/30 px-3.5 text-[0.95rem] shadow-none transition-colors focus-visible:border-brand/60 focus-visible:ring-brand/20';
	const primaryButton =
		'h-11 w-full rounded-xl bg-brand font-semibold text-[#141a2a] shadow-lg shadow-brand/20 transition-colors hover:bg-brand/90 focus-visible:ring-brand/40 disabled:opacity-60';
	const secondaryButton =
		'h-11 w-full rounded-xl border-border/80 bg-background/70 font-medium shadow-none hover:bg-muted/50';

	const heading = $derived(
		data.mode === 'challenge'
			? 'Confirm it’s you'
			: data.mode === 'enrol'
				? 'Secure your owner account'
				: 'Set up an authenticator app'
	);
	const intro = $derived(
		data.mode === 'challenge'
			? 'Owners verify a second factor in every new session (a password, GitHub or email link is only the first). Use your passkey or the code from your authenticator app.'
			: data.mode === 'enrol'
				? 'Organisation owners need a second factor. Add a passkey (recommended) or an authenticator app to continue.'
				: 'Add time-based codes from an app like 1Password, Bitwarden or Google Authenticator.'
	);

	function done() {
		window.location.href = data.redirect;
	}

	async function usePasskey() {
		pending = true;
		error = '';
		const { error: err } = await authClient.signIn.passkey();
		pending = false;
		if (err) error = err.message ?? 'Passkey verification failed.';
		else done();
	}

	async function addPasskey() {
		pending = true;
		error = '';
		try {
			const { error: err } = await authClient.passkey.addPasskey({});
			if (err) error = err.message ?? 'Could not add the passkey.';
			else done();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not add the passkey.';
		} finally {
			pending = false;
		}
	}

	async function signOut() {
		await authClient.signOut();
		window.location.href = '/login';
	}

	const submitting = () => {
		pending = true;
		return async ({ update }: { update: (options?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			pending = false;
		};
	};
</script>

<svelte:head>
	<title>Two-factor verification</title>
</svelte:head>

<AuthSplitShell eyebrow="Second factor" title={heading} description={intro}>
	<div class="space-y-5">
		{#if data.mode === 'challenge'}
			{#if data.hasPasskey}
				<Button size="lg" class={primaryButton} disabled={pending} onclick={usePasskey}>
					<FingerprintIcon aria-hidden="true" />
					Verify with a passkey
				</Button>
			{/if}

			{#if data.hasTotp}
				{#if data.hasPasskey}
					<div class="flex items-center gap-3" aria-hidden="true">
						<span class="h-px flex-1 bg-border"></span>
						<span class="text-xs font-medium text-muted-foreground">or a code</span>
						<span class="h-px flex-1 bg-border"></span>
					</div>
				{/if}
				{#if !useBackup}
					<form
						method="POST"
						action="?/verifyTotp&redirect={encodeURIComponent(data.redirect)}"
						class="space-y-3"
						use:enhance={submitting}
					>
						<Field.Field>
							<Field.Label for="totp-code">Authenticator code</Field.Label>
							<Input
								id="totp-code"
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								maxlength={7}
								placeholder="123 456"
								class="{fieldInput} h-12 text-center font-mono text-lg tracking-[0.3em]"
								required
							/>
						</Field.Field>
						<Button
							type="submit"
							variant={data.hasPasskey ? 'outline' : 'default'}
							size="lg"
							class={data.hasPasskey ? secondaryButton : primaryButton}
							disabled={pending}
						>
							<SmartphoneIcon aria-hidden="true" />
							Verify code
						</Button>
					</form>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-4 hover:underline"
						onclick={() => (useBackup = true)}
					>
						Lost your device? Use a backup code
					</button>
				{:else}
					<form
						method="POST"
						action="?/verifyBackupCode&redirect={encodeURIComponent(data.redirect)}"
						class="space-y-3"
						use:enhance={submitting}
					>
						<Field.Field>
							<Field.Label for="backup-code">Backup code</Field.Label>
							<Input
								id="backup-code"
								name="code"
								autocomplete="off"
								class="{fieldInput} font-mono"
								required
							/>
							<Field.Description>Each backup code works once.</Field.Description>
						</Field.Field>
						<Button
							type="submit"
							variant="outline"
							size="lg"
							class={secondaryButton}
							disabled={pending}
						>
							<KeyRoundIcon aria-hidden="true" />
							Use backup code
						</Button>
					</form>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-4 hover:underline"
						onclick={() => (useBackup = false)}
					>
						Use the authenticator app instead
					</button>
				{/if}
			{/if}
		{:else}
			{#if data.mode === 'enrol'}
				<Button
					size="lg"
					class={primaryButton}
					disabled={pending || passkeySupported === false}
					onclick={addPasskey}
				>
					<FingerprintIcon aria-hidden="true" />
					Add a passkey
				</Button>
				{#if passkeySupported === false}
					<p class="text-xs text-muted-foreground">
						This browser does not support passkeys. Use an authenticator app instead.
					</p>
				{/if}
				<div class="flex items-center gap-3" aria-hidden="true">
					<span class="h-px flex-1 bg-border"></span>
					<span class="text-xs font-medium text-muted-foreground">or</span>
					<span class="h-px flex-1 bg-border"></span>
				</div>
			{/if}

			{#if data.hasTotp}
				<Alert.Root variant="success">
					<ShieldCheckIcon />
					<Alert.Description
						>An authenticator app is already set up for this account.</Alert.Description
					>
				</Alert.Root>
				<Button variant="outline" class={secondaryButton} href={data.redirect}>Continue</Button>
			{:else if !enrolment}
				<form
					method="POST"
					action="?/startTotp&setup=1&redirect={encodeURIComponent(data.redirect)}"
					class="space-y-3"
					use:enhance={submitting}
				>
					{#if data.hasPassword}
						<Field.Field>
							<Field.Label for="totp-password">Your password</Field.Label>
							<Input
								id="totp-password"
								name="password"
								type="password"
								autocomplete="current-password"
								class={fieldInput}
								required
							/>
							<Field.Description>Confirms it’s you before adding the app.</Field.Description>
						</Field.Field>
					{/if}
					<Button
						type="submit"
						variant={data.mode === 'enrol' ? 'outline' : 'default'}
						size="lg"
						class={data.mode === 'enrol' ? secondaryButton : primaryButton}
						disabled={pending}
					>
						<SmartphoneIcon aria-hidden="true" />
						Set up an authenticator app
					</Button>
				</form>
			{:else}
				<ol class="list-decimal space-y-4 pl-5 text-sm">
					<li class="space-y-2">
						<p>
							Add this site to your authenticator app. On a phone, <a
								class="font-medium underline underline-offset-4"
								href={enrolment.totpURI}>open the setup link</a
							>; otherwise enter this key manually:
						</p>
						<div class="flex items-center gap-2 rounded-lg border bg-muted/40 p-2.5">
							<code class="min-w-0 flex-1 font-mono text-xs break-all">{enrolment.secret}</code>
							<CopyButton value={enrolment.secret} label="Copy setup key" iconOnly />
						</div>
					</li>
					{#if enrolment.backupCodes.length > 0}
						<li class="space-y-2">
							<p>
								Save these backup codes somewhere safe. Each works once, and they are shown only
								now.
							</p>
							<div
								class="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/40 p-2.5 font-mono text-xs"
							>
								{#each enrolment.backupCodes as backup (backup)}<span>{backup}</span>{/each}
							</div>
							<CopyButton value={enrolment.backupCodes.join('\n')} label="Copy backup codes" />
						</li>
					{/if}
					<li>
						<form
							method="POST"
							action="?/verifyTotp&setup=1&redirect={encodeURIComponent(data.redirect)}"
							class="space-y-3"
							use:enhance={submitting}
						>
							<Field.Field>
								<Field.Label for="enrol-code">Enter the 6-digit code it shows</Field.Label>
								<Input
									id="enrol-code"
									name="code"
									inputmode="numeric"
									autocomplete="one-time-code"
									maxlength={7}
									placeholder="123 456"
									class="{fieldInput} h-12 text-center font-mono text-lg tracking-[0.3em]"
									required
								/>
							</Field.Field>
							<Button type="submit" size="lg" class={primaryButton} disabled={pending}
								>Verify and finish</Button
							>
						</form>
					</li>
				</ol>
			{/if}
		{/if}

		{#if error || result?.message}
			<Alert.Root variant="destructive">
				<CircleAlertIcon />
				<Alert.Description>{error || result?.message}</Alert.Description>
			</Alert.Root>
		{/if}
	</div>

	{#snippet footer()}
		Signed in as {data.email}.
		{#if data.mode === 'setup'}
			<a class="underline underline-offset-4" href={data.redirect}>Back</a>
		{:else}
			<button type="button" class="underline underline-offset-4" onclick={signOut}>Sign out</button>
		{/if}
	{/snippet}
</AuthSplitShell>
