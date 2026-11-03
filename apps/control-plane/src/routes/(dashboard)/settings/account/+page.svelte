<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import LaptopIcon from '@lucide/svelte/icons/laptop';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { authClient } from '#lib/auth-client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDate, formatDateTime, shortId } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface AccountFormResult {
		message?: string;
		success?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as AccountFormResult | null);

	const otherSessions = $derived(data.sessions.filter((session) => !session.current));

	let passkeyName = $state('');
	let passkeyPending = $state(false);
	let passkeyError = $state('');
	let passkeySupported = $state<boolean | null>(null);

	onMount(() => {
		passkeySupported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
	});

	async function addPasskey(event: SubmitEvent) {
		event.preventDefault();
		if (passkeySupported !== true || passkeyPending) return;

		passkeyPending = true;
		passkeyError = '';
		try {
			const { error } = await authClient.passkey.addPasskey({
				name: passkeyName.trim() || undefined
			});
			if (error) {
				passkeyError = error.message ?? 'Could not add the passkey.';
				return;
			}
			passkeyName = '';
			await invalidateAll();
		} catch (error) {
			passkeyError = error instanceof Error ? error.message : 'Could not add the passkey.';
		} finally {
			passkeyPending = false;
		}
	}

	const initials = $derived(
		data.user.name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('') || '?'
	);
</script>

<svelte:head>
	<title>Account settings · Skiff</title>
</svelte:head>

<div class="space-y-5">
	<FormFeedback {result} />

	<div class="grid items-start gap-5 lg:grid-cols-2">
		<Panel
			title="Profile"
			icon={UserRoundIcon}
			description="How you appear to teammates across the dashboard."
		>
			<form method="POST" action="?/updateProfile" use:enhance class="space-y-4">
				<div class="flex items-center gap-4">
					<span
						class="grid size-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-[oklch(0.55_0.17_25)] text-lg font-semibold text-brand-foreground shadow-card"
						aria-hidden="true">{initials}</span
					>
					<div class="min-w-0 flex-1 space-y-1.5">
						<Label for="profile-name">Display name</Label>
						<Input
							id="profile-name"
							name="name"
							value={data.user.name}
							maxlength={80}
							required
							autocomplete="name"
							aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
						/>
						{#if result?.fieldErrors?.name}
							<p class="text-xs text-destructive">{result.fieldErrors.name}</p>
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
					<p class="text-xs text-muted-foreground">
						Shown on members, invitations and the audit log.
					</p>
					<Button type="submit">Save profile</Button>
				</div>
			</form>
		</Panel>

		<Panel
			title="Account"
			icon={ShieldCheckIcon}
			description="Identity and organisation membership."
		>
			<dl class="kv">
				<dt>Email</dt>
				<dd class="flex flex-wrap items-center justify-end gap-2">
					<span class="break-all">{data.user.email}</span>
					{#if data.user.emailVerified}
						<Badge variant="success">verified</Badge>
					{:else}
						<Badge variant="warning">unverified</Badge>
					{/if}
				</dd>
				<dt>Role</dt>
				<dd><Badge variant="outline" class="capitalize">{data.role}</Badge></dd>
				<dt>Member since</dt>
				<dd class="text-[13px]">{formatDate(data.user.createdAt)}</dd>
				<dt>User ID</dt>
				<dd class="flex items-center justify-end gap-1">
					<span class="truncate font-mono text-[12px]" title={data.user.id}
						>{shortId(data.user.id, 16)}</span
					>
					<CopyButton value={data.user.id} label="Copy user ID" variant="ghost" iconOnly />
				</dd>
			</dl>
			<p class="mt-3 text-xs text-muted-foreground">
				Your email and role are managed by an organisation owner. Contact them if either is wrong.
			</p>
		</Panel>
	</div>

	<Panel
		title="Active sessions"
		icon={LaptopIcon}
		count={data.sessionsError ? undefined : data.sessions.length}
		description="Every browser or CLI session signed in as you. Revoke anything you do not recognise."
		flush
	>
		{#snippet actions()}
			{#if otherSessions.length > 0}
				<form method="POST" action="?/revokeOtherSessions" use:enhance>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						onclick={(event) => {
							if (
								!confirm(
									`Sign out ${otherSessions.length} other ${
										otherSessions.length === 1 ? 'session' : 'sessions'
									}?`
								)
							)
								event.preventDefault();
						}}
					>
						Sign out other sessions
					</Button>
				</form>
			{/if}
		{/snippet}

		{#if data.sessionsError}
			<div class="p-4">
				<Notice tone="warning">{data.sessionsError}</Notice>
			</div>
		{:else if data.sessions.length === 0}
			<div class="p-4">
				<EmptyState
					icon={LaptopIcon}
					compact
					title="No active sessions"
					description="Sessions appear here after you sign in on a browser or approve a CLI login."
				/>
			</div>
		{:else}
			<ul class="divide-y">
				{#each data.sessions as session (session.id)}
					<li
						class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 {session.current
							? 'bg-success-soft/40'
							: ''}"
					>
						<span
							class="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-muted-foreground"
						>
							<MonitorSmartphoneIcon class="size-4" aria-hidden="true" />
						</span>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<p class="text-sm font-medium">{session.device}</p>
								{#if session.current}
									<Badge variant="success">this device</Badge>
								{/if}
							</div>
							<p
								class="max-w-xl truncate text-xs text-muted-foreground"
								title={session.userAgent ?? 'No user agent reported'}
							>
								<span class="font-mono">{session.ipAddress ?? 'unknown IP'}</span>
								· signed in {formatDateTime(session.createdAt)}
								<span class="hidden lg:inline"
									>· last active {formatDateTime(session.lastActiveAt)}</span
								>
							</p>
						</div>
						{#if !session.current}
							<form method="POST" action="?/revokeSession" use:enhance>
								<input type="hidden" name="sessionId" value={session.id} />
								<Button
									type="submit"
									variant="ghost-danger"
									size="sm"
									onclick={(event) => {
										if (!confirm(`Sign out ${session.device}?`)) event.preventDefault();
									}}
								>
									Revoke
								</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#snippet footer()}
			Session tokens stay on the server. Revoking a session signs that device out immediately.
		{/snippet}
	</Panel>

	<div class="grid items-start gap-5 lg:grid-cols-2">
		<Panel
			title="Passkeys"
			icon={FingerprintIcon}
			description="Phishing-resistant sign-in with your device, fingerprint or security key."
		>
			<div class="space-y-4">
				{#if data.passkeysError}
					<Notice tone="warning">{data.passkeysError}</Notice>
				{:else if data.passkeys.length === 0}
					<EmptyState
						icon={FingerprintIcon}
						compact
						title="No passkeys yet"
						description="Add one so you can sign in without an email link or GitHub."
					/>
				{:else}
					<ul class="divide-y overflow-hidden rounded-lg border">
						{#each data.passkeys as passkey (passkey.id)}
							<li class="flex items-center gap-3 px-3 py-2.5">
								<FingerprintIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<p class="truncate text-sm font-medium">{passkey.name}</p>
										{#if passkey.backedUp}
											<Badge variant="info">synced</Badge>
										{/if}
									</div>
									<p class="text-xs text-muted-foreground">
										{passkey.authenticator ?? passkey.deviceType} · added {formatDate(
											passkey.createdAt
										)}
									</p>
								</div>
								<form method="POST" action="?/deletePasskey" use:enhance>
									<input type="hidden" name="passkeyId" value={passkey.id} />
									<Button
										type="submit"
										variant="ghost-danger"
										size="sm"
										onclick={(event) => {
											if (
												!confirm(
													`Remove ${passkey.name}? You will not be able to use it to sign in.`
												)
											)
												event.preventDefault();
										}}
									>
										Remove
									</Button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}

				<form class="space-y-2 rounded-lg border bg-muted/30 p-3" onsubmit={addPasskey}>
					<Label for="passkey-name">Add a passkey</Label>
					<div class="flex flex-wrap items-center gap-2">
						<Input
							id="passkey-name"
							bind:value={passkeyName}
							maxlength={64}
							placeholder="Work laptop"
							autocomplete="off"
							class="min-w-0 flex-1 bg-card"
						/>
						<Button type="submit" disabled={passkeySupported !== true || passkeyPending}>
							<PlusIcon aria-hidden="true" />
							{passkeyPending ? 'Waiting for device…' : 'Add passkey'}
						</Button>
					</div>
					{#if passkeyError}
						<p class="text-xs text-destructive" role="alert">{passkeyError}</p>
					{:else if passkeySupported === null}
						<p class="text-xs text-muted-foreground">Checking browser support…</p>
					{:else if passkeySupported}
						<p class="text-xs text-muted-foreground">
							Your browser will ask for your fingerprint, face or security key. The name is only a
							label for this list.
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							This browser does not support passkeys. Try a recent version of Chrome, Safari or
							Firefox.
						</p>
					{/if}
				</form>
			</div>
		</Panel>

		<Panel
			title="Linked sign-in methods"
			icon={LinkIcon}
			description="External accounts connected to your Skiff identity."
		>
			{#if data.accountsError}
				<Notice tone="warning">{data.accountsError}</Notice>
			{:else if data.accounts.length === 0}
				<EmptyState
					icon={LinkIcon}
					compact
					title="No linked accounts"
					description="You signed in with a passkey or email link. An owner can connect GitHub if needed."
				/>
			{:else}
				<ul class="divide-y overflow-hidden rounded-lg border">
					{#each data.accounts as account (account.id)}
						<li class="flex items-center gap-3 px-3 py-2.5">
							{#if account.provider.toLowerCase() === 'github'}
								<GitHubMark class="size-4 shrink-0" />
							{:else}
								<LinkIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{/if}
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium capitalize">{account.provider}</p>
								<p class="truncate font-mono text-[11px] text-muted-foreground">
									{account.providerId}
								</p>
							</div>
							<p class="text-xs whitespace-nowrap text-muted-foreground">
								linked {formatDate(account.createdAt)}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
			<p class="mt-3 text-xs text-muted-foreground">
				Linking or unlinking providers is not available from the dashboard yet. Ask an owner if a
				provider needs to change.
			</p>
		</Panel>
	</div>
</div>
