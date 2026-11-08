<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import InfoIcon from '@lucide/svelte/icons/info';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { authClient } from '#lib/auth-client.js';
	import AuthShell from '#lib/components/skiff/AuthShell.svelte';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	interface Enrolment {
		totpURI: string;
		secret: string;
		backupCodes: string[];
	}
	interface SetupFormResult {
		values?: { name: string; email: string; organizationName: string };
		field?: 'name' | 'email' | 'organizationName' | 'password';
		claimError?: string;
		unlockError?: string;
		totpError?: string;
		enrolment?: Enrolment;
		totpVerified?: boolean;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as SetupFormResult | null);

	type Step = 'check' | 'account' | 'secure' | 'storage' | 'done';
	const steps: { id: Step; label: string }[] = [
		{ id: 'check', label: 'Check' },
		{ id: 'account', label: 'Account' },
		{ id: 'secure', label: 'Secure' },
		{ id: 'storage', label: 'Storage' },
		{ id: 'done', label: 'Finish' }
	];
	/** The owner is set up but storage is still open (docs/STORAGE.md §4). */
	const storagePending = $derived(data.phase === 'done' && 'storage' in data && data.storage?.state === 'pending');

	let accountStep = $state<'check' | 'account'>('check');
	const step = $derived<Step | null>(
		data.phase === 'account'
			? accountStep
			: data.phase === 'secure'
				? 'secure'
				: data.phase === 'done'
					? storagePending
						? 'storage'
						: 'done'
					: null
	);
	const stepIndex = $derived(step ? steps.findIndex((s) => s.id === step) : -1);

	// A failed claim comes back with the form values: stay on the form.
	$effect(() => {
		if (result?.claimError) accountStep = 'account';
	});

	/** Browser-side facts the server cannot see. `null` until mounted. */
	let browser = $state<{ secureContext: boolean; webauthn: boolean; origin: string } | null>(null);
	onMount(() => {
		browser = {
			secureContext: window.isSecureContext,
			webauthn: 'PublicKeyCredential' in window,
			origin: window.location.origin
		};
	});

	const instance = $derived('instance' in data ? data.instance : undefined);
	/** Why a passkey can't be created here, or null when it can. */
	const passkeyBlocker = $derived.by(() => {
		if (!browser) return null;
		if (!browser.secureContext)
			return 'Passkeys need HTTPS (or localhost). This page was opened over plain HTTP.';
		if (!browser.webauthn) return 'This browser does not support passkeys.';
		if (instance && browser.origin !== instance.platformOrigin)
			return `Passkeys are bound to ${instance.platformOrigin}, but this page is on ${browser.origin}.`;
		return null;
	});

	let pending = $state(false);
	let passkeyError = $state('');
	let enrolment = $state<Enrolment | null>(null);
	$effect(() => {
		if (result?.enrolment) enrolment = result.enrolment;
	});

	async function addPasskey() {
		pending = true;
		passkeyError = '';
		try {
			const { error } = await authClient.passkey.addPasskey({ name: 'Owner passkey' });
			if (error) {
				passkeyError = error.message ?? 'Could not add the passkey.';
				return;
			}
			await invalidateAll();
		} catch (error) {
			passkeyError =
				error instanceof Error && error.name === 'NotAllowedError'
					? 'The passkey prompt was cancelled or timed out. Try again, or use an authenticator app.'
					: error instanceof Error
						? error.message
						: 'Could not add the passkey.';
		} finally {
			pending = false;
		}
	}

	const submitting = () => {
		pending = true;
		return async ({ update, result: actionResult }: { update: (options?: { reset?: boolean }) => Promise<void>; result: { type: string; data?: Record<string, unknown> } }) => {
			await update({ reset: false });
			// A verified code completes enrolment: reload the phase from the server.
			if (actionResult.type === 'success' && actionResult.data?.totpVerified) {
				enrolment = null;
				await invalidateAll();
			}
			pending = false;
		};
	};

	type Check = { status: 'ok' | 'warn' | 'info'; title: string; detail: string };
	const checks = $derived.by((): Check[] => {
		if (!instance) return [];
		const list: Check[] = [
			{
				status: instance.https ? 'ok' : 'warn',
				title: 'Platform address',
				detail: instance.https
					? `${instance.platformOrigin} with HTTPS.`
					: `${instance.platformOrigin} has no HTTPS. That's fine to start with: sign in with your password and an authenticator app, and add a passkey once TLS is set up.`
			},
			{
				status: passkeyBlocker ? 'info' : 'ok',
				title: 'Passkeys in this browser',
				detail: passkeyBlocker
					? `${passkeyBlocker} Your password plus an authenticator app works instead.`
					: browser
						? 'Ready.'
						: 'Checking…'
			},
			{
				status: instance.email === 'smtp' ? 'ok' : 'warn',
				title: 'Email',
				detail:
					instance.email === 'smtp'
						? 'SMTP is configured for sign-in links and invitations.'
						: 'Not configured. Invitations and sign-in links are written to the server log until you add SMTP (Settings → Notifications). You sign in with your password or a passkey, so you don’t need email for that.'
			},
			{
				status: 'info',
				title: 'Storage',
				detail:
					instance.objectStore === 'r2'
						? 'Cloudflare R2.'
						: 'Local disk. Add R2 later for off-site backups (Settings → Backups).'
			},
			{
				status: instance.nodes > 0 ? 'ok' : 'warn',
				title: 'Nodes',
				detail:
					instance.nodes > 0
						? `${instance.nodes} node${instance.nodes === 1 ? '' : 's'} enrolled.`
						: 'No node has joined yet. Sites are served once one does (Nodes → Add node).'
			}
		];
		if (instance.sharedDomain)
			list.push({
				status: 'warn',
				title: 'Shared domain',
				detail: `Sites on ${instance.contentDomain} are same-site with the dashboard. A separate content domain is safer.`
			});
		return list;
	});

	const title = $derived(
		{
			'wrong-host': 'Open setup on the platform address',
			locked: 'Set up Skiff',
			check: 'Welcome to Skiff',
			account: 'Create the owner account',
			secure: 'Secure your account',
			storage: 'Set up storage',
			done: 'You’re all set'
		}[step ?? data.phase] ?? 'Set up Skiff'
	);
	const description = $derived(
		{
			'wrong-host': 'Sign-in cookies and passkeys belong to one address, so setup has to happen there.',
			locked: 'Open the setup link the installer printed, or paste it here.',
			check: 'Here is what this install looks like before you create your account.',
			account: 'You will own this install: its organisation, its nodes and its settings.',
			secure:
				'Owners need a second factor as well as a password. Add a passkey, or an authenticator app if passkeys can’t work here.',
			storage: 'Choose where databases, object storage, app data and builds live before anything is deployed.',
			done: 'Your owner account is ready.'
		}[step ?? data.phase] ?? ''
	);
</script>

<svelte:head>
	<title>Set up · Skiff</title>
</svelte:head>

<AuthShell wide eyebrow="First-run setup" {title} {description}>
	{#snippet header()}
		{#if step}
			<ol class="mb-3 flex items-center justify-center gap-2 text-xs" aria-label="Setup progress">
				{#each steps as s, i (s.id)}
					<li class="flex items-center gap-2" aria-current={i === stepIndex ? 'step' : undefined}>
						<span
							class={[
								'flex size-6 items-center justify-center rounded-full border font-medium',
								i < stepIndex && 'border-brand bg-brand text-brand-foreground',
								i === stepIndex && 'border-brand text-brand',
								i > stepIndex && 'text-muted-foreground'
							]}
						>
							{#if i < stepIndex}<CheckIcon class="size-3.5" aria-hidden="true" />{:else}{i + 1}{/if}
						</span>
						<span class={i === stepIndex ? 'font-medium' : 'text-muted-foreground'}>{s.label}</span>
						{#if i < steps.length - 1}<span class="h-px w-4 bg-border" aria-hidden="true"></span>{/if}
					</li>
				{/each}
			</ol>
		{/if}
	{/snippet}

	{#if data.phase === 'wrong-host'}
		<div class="space-y-4">
			<p class="text-sm text-muted-foreground">
				This install is configured for <span class="font-medium text-foreground">{data.platformOrigin}</span>.
				If that address doesn’t load yet, check DNS and TLS first (<code class="text-xs"
					>systemctl status caddy</code
				>).
			</p>
			<Button size="lg" class="h-10 w-full" href={data.platformUrl}>
				Continue on {data.platformOrigin}
				<ArrowRightIcon aria-hidden="true" />
			</Button>
		</div>
	{:else if data.phase === 'locked'}
		<div class="space-y-4">
			{#if data.error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Description>{data.error}</Alert.Description>
				</Alert.Root>
			{/if}
			<form method="POST" action="?/unlock" class="space-y-3" use:enhance={submitting}>
				<Field.Field>
					<Field.Label for="setup-token">Setup link or token</Field.Label>
					<Input
						id="setup-token"
						name="token"
						autocomplete="off"
						spellcheck={false}
						class="h-10 font-mono text-xs"
						required
					/>
					<Field.Description>
						On the server: <code class="text-xs">sudo cat {data.tokenFile}</code>, or
						<code class="text-xs">journalctl -u skiff-control-plane | grep setup</code>.
					</Field.Description>
				</Field.Field>
				{#if result?.unlockError}
					<Alert.Root variant="destructive">
						<CircleAlertIcon />
						<Alert.Description>{result.unlockError}</Alert.Description>
					</Alert.Root>
				{/if}
				<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>Continue</Button>
			</form>
		</div>
	{:else if step === 'check'}
		<div class="space-y-4">
			<ul class="divide-y rounded-lg border">
				{#each checks as check (check.title)}
					<li class="flex gap-3 p-3 text-sm">
						{#if check.status === 'ok'}
							<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-label="OK" />
						{:else if check.status === 'warn'}
							<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
						{:else}
							<InfoIcon class="mt-0.5 size-4 shrink-0 text-info" aria-label="Info" />
						{/if}
						<div class="min-w-0">
							<p class="font-medium">{check.title}</p>
							<p class="text-pretty break-words text-muted-foreground">{check.detail}</p>
						</div>
					</li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">
				Warnings don’t block setup; everything here can be changed later in Settings.
			</p>
			<Button size="lg" class="h-10 w-full" onclick={() => (accountStep = 'account')}>
				Continue
				<ArrowRightIcon aria-hidden="true" />
			</Button>
		</div>
	{:else if step === 'account'}
		<form method="POST" action="?/claim" class="space-y-4" use:enhance={submitting}>
			<Field.Field data-invalid={result?.field === 'name' || undefined}>
				<Field.Label for="owner-name">Your name</Field.Label>
				<Input
					id="owner-name"
					name="name"
					autocomplete="name"
					class="h-10"
					value={result?.values?.name ?? ''}
					aria-invalid={result?.field === 'name' || undefined}
					required
				/>
			</Field.Field>
			<Field.Field data-invalid={result?.field === 'email' || undefined}>
				<Field.Label for="owner-email">Email address</Field.Label>
				<Input
					id="owner-email"
					name="email"
					type="email"
					autocomplete="email"
					class="h-10"
					value={result?.values?.email ?? ('email' in data ? data.email : '')}
					aria-invalid={result?.field === 'email' || undefined}
					required
				/>
				<Field.Description>Your sign-in name, and where invitations and alerts go.</Field.Description>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={result?.field === 'password' || undefined}>
					<Field.Label for="owner-password">Password</Field.Label>
					<Input
						id="owner-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={12}
						maxlength={128}
						class="h-10"
						aria-invalid={result?.field === 'password' || undefined}
						required
					/>
				</Field.Field>
				<Field.Field data-invalid={result?.field === 'password' || undefined}>
					<Field.Label for="owner-password-confirm">Confirm password</Field.Label>
					<Input
						id="owner-password-confirm"
						name="passwordConfirm"
						type="password"
						autocomplete="new-password"
						minlength={12}
						maxlength={128}
						class="h-10"
						aria-invalid={result?.field === 'password' || undefined}
						required
					/>
				</Field.Field>
				<Field.Description class="sm:col-span-2">At least 12 characters. A password manager helps.</Field.Description>
			</div>
			<Field.Field data-invalid={result?.field === 'organizationName' || undefined}>
				<Field.Label for="org-name">Organisation name</Field.Label>
				<Input
					id="org-name"
					name="organizationName"
					autocomplete="organization"
					placeholder="Acme"
					class="h-10"
					value={result?.values?.organizationName ?? ''}
					aria-invalid={result?.field === 'organizationName' || undefined}
					required
				/>
				<Field.Description>Projects and members live here. You can rename it later.</Field.Description>
			</Field.Field>
			{#if result?.claimError}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Description>{result.claimError}</Alert.Description>
				</Alert.Root>
			{/if}
			<div class="flex gap-2">
				<Button variant="outline" size="lg" class="h-10" onclick={() => (accountStep = 'check')}>Back</Button>
				<Button type="submit" size="lg" class="h-10 flex-1" disabled={pending}>
					Create account
					<ArrowRightIcon aria-hidden="true" />
				</Button>
			</div>
		</form>
	{:else if step === 'storage' && data.phase === 'done' && 'storage' in data}
		<div class="space-y-4">
			<div class="space-y-2 rounded-lg border p-3 text-sm">
				<p>
					Skiff can keep everything on each node's system disk, or you can add more disks. Each disk is
					<strong>fast</strong> (SSD, NVMe) or <strong>bulk</strong> (spinning disks, arrays, a NAS), and you pick
					which one databases, object storage, app data and builds use.
				</p>
				<p class="text-muted-foreground">
					{data.storage.nodes} node{data.storage.nodes === 1 ? '' : 's'} enrolled ·
					{data.storage.mounts} extra filesystem{data.storage.mounts === 1 ? '' : 's'} detected. You can change this any time under
					Settings → Storage.
				</p>
			</div>
			<Button size="lg" class="h-10 w-full" href="/settings/storage?onboarding=1">
				Set up storage
				<ArrowRightIcon aria-hidden="true" />
			</Button>
			<form method="POST" action="?/skipStorage">
				<Button type="submit" variant="outline" size="lg" class="h-10 w-full">Use the system disk for now</Button>
			</form>
		</div>
	{:else if step === 'secure' || step === 'done'}
		<div class="space-y-5">
			{#if step === 'done'}
				<Alert.Root variant="success">
					<CircleCheckIcon />
					<Alert.Description>
						{data.phase === 'done' && data.hasPasskey
							? 'Your owner account is protected by a passkey.'
							: 'Your owner account is protected by an authenticator app.'}
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if step === 'secure'}
				<div class="space-y-2">
					<Button
						size="lg"
						class="h-10 w-full"
						disabled={pending || passkeyBlocker !== null}
						onclick={addPasskey}
					>
						<FingerprintIcon aria-hidden="true" />
						Add a passkey
					</Button>
					{#if passkeyBlocker}
						<p class="text-xs text-muted-foreground">{passkeyBlocker} Use an authenticator app instead.</p>
					{/if}
					{#if passkeyError}
						<Alert.Root variant="destructive">
							<CircleAlertIcon />
							<Alert.Description>{passkeyError}</Alert.Description>
						</Alert.Root>
					{/if}
				</div>
			{/if}

			{#if data.phase === 'secure' || (data.phase === 'done' && !data.hasTotp)}
				{#if !enrolment}
					{#if step === 'secure'}
						<div class="flex items-center gap-3" aria-hidden="true">
							<span class="h-px flex-1 bg-border"></span>
							<span class="text-xs font-medium text-muted-foreground">or</span>
							<span class="h-px flex-1 bg-border"></span>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">
							Recommended: add an authenticator app as a backup, so losing a passkey doesn’t lock you
							out. It also gives you one-time backup codes.
						</p>
					{/if}
					<form method="POST" action="?/startTotp" class="space-y-3" use:enhance={submitting}>
						{#if (data.phase === 'secure' || data.phase === 'done') && data.hasPassword}
							<Field.Field>
								<Field.Label for="totp-password">Your password</Field.Label>
								<Input
									id="totp-password"
									name="password"
									type="password"
									autocomplete="current-password"
									class="h-10"
									required
								/>
								<Field.Description>Confirms it’s you before adding the app.</Field.Description>
							</Field.Field>
						{/if}
						<Button
							type="submit"
							variant={step === 'secure' && passkeyBlocker ? 'default' : 'outline'}
							size="lg"
							class="h-10 w-full"
							disabled={pending}
						>
							<SmartphoneIcon aria-hidden="true" />
							{step === 'secure' ? 'Use an authenticator app' : 'Add an authenticator app'}
						</Button>
					</form>
				{:else}
					<ol class="list-decimal space-y-4 pl-5 text-sm">
						<li class="space-y-2">
							<p>
								Add Skiff to your authenticator app (1Password, Bitwarden, Google Authenticator…). On a
								phone, <a class="font-medium underline underline-offset-4" href={enrolment.totpURI}
									>open the setup link</a
								>; otherwise enter this key:
							</p>
							<div class="flex items-center gap-2 rounded-lg border bg-muted/40 p-2.5">
								<code class="min-w-0 flex-1 font-mono text-xs break-all">{enrolment.secret}</code>
								<CopyButton value={enrolment.secret} label="Copy setup key" iconOnly />
							</div>
						</li>
						{#if enrolment.backupCodes.length > 0}
							<li class="space-y-2">
								<p>Save these backup codes somewhere safe. Each works once; they are shown only now.</p>
								<div class="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/40 p-2.5 font-mono text-xs">
									{#each enrolment.backupCodes as backup (backup)}<span>{backup}</span>{/each}
								</div>
								<CopyButton value={enrolment.backupCodes.join('\n')} label="Copy backup codes" />
							</li>
						{/if}
						<li>
							<form method="POST" action="?/verifyTotp" class="space-y-3" use:enhance={submitting}>
								<Field.Field>
									<Field.Label for="totp-code">Enter the 6-digit code it shows</Field.Label>
									<Input
										id="totp-code"
										name="code"
										inputmode="numeric"
										autocomplete="one-time-code"
										maxlength={7}
										placeholder="123 456"
										class="h-10 font-mono tracking-widest"
										required
									/>
								</Field.Field>
								<Button type="submit" size="lg" class="h-10 w-full" disabled={pending}>
									<KeyRoundIcon aria-hidden="true" />
									Verify code
								</Button>
							</form>
						</li>
					</ol>
				{/if}
				{#if result?.totpError}
					<Alert.Root variant="destructive">
						<CircleAlertIcon />
						<Alert.Description>{result.totpError}</Alert.Description>
					</Alert.Root>
				{/if}
			{:else if data.phase === 'done' && data.hasTotp}
				<p class="flex items-center gap-2 text-sm text-muted-foreground">
					<CircleCheckIcon class="size-4 text-success" aria-hidden="true" />
					Authenticator app and backup codes set up.
				</p>
			{/if}

			{#if step === 'done' && data.phase === 'done'}
				<div class="space-y-2 rounded-lg border p-3 text-sm">
					<p class="font-medium">Next steps</p>
					<ul class="space-y-1 text-muted-foreground">
						{#if data.instance.email === 'console'}
							<li>
								<a class="underline underline-offset-4" href="/settings/notifications">Set up email</a> so
								invitations and sign-in links reach people.
							</li>
						{/if}
						<li>
							<a class="underline underline-offset-4" href="/settings/backups">Configure backups</a>.
						</li>
						<li>
							<a class="underline underline-offset-4" href="/settings/members">Invite your team</a>.
						</li>
						<li>
							<a class="underline underline-offset-4" href="/settings/api-keys">Create an API key</a> or run
							<code class="text-xs">skif login --url {data.instance.platformOrigin}</code>.
						</li>
					</ul>
				</div>
				<Button size="lg" class="h-10 w-full" href="/overview">
					Open the dashboard
					<ArrowRightIcon aria-hidden="true" />
				</Button>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if data.phase === 'secure' || data.phase === 'done'}
			Signed in as {data.account.email}.
		{:else}
			Only someone with access to the server can finish setup.
		{/if}
	{/snippet}
</AuthShell>
