<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LaptopIcon from '@lucide/svelte/icons/laptop';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { authClient } from '#lib/auth-client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime, shortId } from '../../_lib/format.js';
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
</script>

<svelte:head>
	<title>Account settings · Skiff</title>
</svelte:head>

<div class="space-y-6">
	{#if result?.success}
		<div
			class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
			role="status"
		>
			{result.success}
		</div>
	{/if}
	{#if result?.message}
		<div
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			role="alert"
		>
			{result.message}
		</div>
	{/if}

	<div class="grid items-start gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header class="border-b pb-4">
				<div class="flex items-center justify-between gap-2">
					<div class="space-y-1">
						<Card.Title>Profile</Card.Title>
						<Card.Description>How you appear to teammates across the dashboard.</Card.Description>
					</div>
					<UserRoundIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</div>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/updateProfile" use:enhance class="space-y-3">
					<div class="space-y-1.5">
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
					<div class="flex items-center justify-between gap-3">
						<p class="text-xs text-muted-foreground">
							Changes appear on members, invitations and the audit log.
						</p>
						<Button type="submit" size="sm">Save profile</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="border-b pb-4">
				<div class="flex items-center justify-between gap-2">
					<div class="space-y-1">
						<Card.Title>Account</Card.Title>
						<Card.Description>Identity and organisation membership.</Card.Description>
					</div>
					<ShieldCheckIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</div>
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
					<dt class="text-muted-foreground">Email</dt>
					<dd class="flex flex-wrap items-center gap-2">
						<span class="break-all">{data.user.email}</span>
						{#if data.user.emailVerified}
							<Badge variant="secondary">verified</Badge>
						{:else}
							<Badge variant="outline">unverified</Badge>
						{/if}
					</dd>
					<dt class="text-muted-foreground">Role</dt>
					<dd><Badge variant="outline" class="capitalize">{data.role}</Badge></dd>
					<dt class="text-muted-foreground">Member since</dt>
					<dd>{formatDateTime(data.user.createdAt)}</dd>
					<dt class="text-muted-foreground">User ID</dt>
					<dd class="font-mono text-xs" title={data.user.id}>{shortId(data.user.id, 18)}</dd>
				</dl>
				<p class="mt-4 border-t pt-3 text-xs text-muted-foreground">
					Your email and role are managed by an organisation owner. Contact them if either is wrong.
				</p>
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header class="border-b pb-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="space-y-1">
					<Card.Title>Active sessions</Card.Title>
					<Card.Description>
						Every browser or CLI session signed in as you. Revoke anything you do not recognise.
					</Card.Description>
				</div>
				<div class="flex items-center gap-2">
					<LaptopIcon class="size-4 text-muted-foreground" aria-hidden="true" />
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
				</div>
			</div>
		</Card.Header>
		<Card.Content class="p-0">
			{#if data.sessionsError}
				<div class="p-4">
					<div
						class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
						role="status"
					>
						{data.sessionsError}
					</div>
				</div>
			{:else if data.sessions.length === 0}
				<div class="p-4">
					<EmptyState
						title="No active sessions"
						description="Sessions appear here after you sign in on a browser or approve a CLI login."
					/>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<caption class="sr-only">Your active sessions</caption>
						<thead>
							<tr class="border-b text-left text-xs text-muted-foreground">
								<th class="px-4 py-2.5 font-medium">Device</th>
								<th class="hidden px-4 py-2.5 font-medium sm:table-cell">IP address</th>
								<th class="hidden px-4 py-2.5 font-medium lg:table-cell">Signed in</th>
								<th class="hidden px-4 py-2.5 font-medium lg:table-cell">Last active</th>
								<th class="px-4 py-2.5 text-right font-medium">
									<span class="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{#each data.sessions as session (session.id)}
								<tr class="border-b last:border-0">
									<td class="px-4 py-3">
										<div class="flex flex-wrap items-center gap-2">
											<p class="font-medium">{session.device}</p>
											{#if session.current}
												<Badge variant="default">this device</Badge>
											{/if}
										</div>
										<p
											class="max-w-md truncate text-xs text-muted-foreground"
											title={session.userAgent ?? 'No user agent reported'}
										>
											{session.userAgent ?? 'No user agent reported'}
										</p>
									</td>
									<td
										class="hidden px-4 py-3 font-mono text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
									>
										{session.ipAddress ?? '—'}
									</td>
									<td
										class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground lg:table-cell"
									>
										{formatDateTime(session.createdAt)}
									</td>
									<td
										class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground lg:table-cell"
									>
										{formatDateTime(session.lastActiveAt)}
									</td>
									<td class="px-4 py-3 text-right">
										{#if session.current}
											<Badge variant="outline">current</Badge>
										{:else}
											<form method="POST" action="?/revokeSession" use:enhance>
												<input type="hidden" name="sessionId" value={session.id} />
												<Button
													type="submit"
													variant="ghost"
													size="xs"
													class="text-destructive hover:bg-destructive/10 hover:text-destructive"
													onclick={(event) => {
														if (!confirm(`Sign out ${session.device}?`)) event.preventDefault();
													}}
												>
													Revoke
												</Button>
											</form>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="border-t px-4 py-2 text-xs text-muted-foreground">
					Session tokens stay on the server. Revoking a session signs that device out immediately.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid items-start gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header class="border-b pb-4">
				<div class="flex items-center justify-between gap-2">
					<div class="space-y-1">
						<Card.Title>Passkeys</Card.Title>
						<Card.Description>
							Phishing-resistant sign-in using your device, fingerprint or security key.
						</Card.Description>
					</div>
					<FingerprintIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</div>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if data.passkeysError}
					<div
						class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
						role="status"
					>
						{data.passkeysError}
					</div>
				{:else if data.passkeys.length === 0}
					<EmptyState
						title="No passkeys yet"
						description="Add one so you can sign in without an email link or GitHub."
					/>
				{:else}
					<ul class="divide-y rounded-lg border">
						{#each data.passkeys as passkey (passkey.id)}
							<li class="flex flex-wrap items-center gap-3 px-3 py-3">
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<p class="truncate text-sm font-medium">{passkey.name}</p>
										{#if passkey.backedUp}
											<Badge variant="secondary">synced</Badge>
										{/if}
									</div>
									<p class="text-xs text-muted-foreground">
										{passkey.authenticator ?? passkey.deviceType} · added {formatDateTime(
											passkey.createdAt
										)}
									</p>
								</div>
								<form method="POST" action="?/deletePasskey" use:enhance>
									<input type="hidden" name="passkeyId" value={passkey.id} />
									<Button
										type="submit"
										variant="ghost"
										size="xs"
										class="text-destructive hover:bg-destructive/10 hover:text-destructive"
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

				<form class="space-y-2 rounded-lg border bg-muted/20 p-3" onsubmit={addPasskey}>
					<Label for="passkey-name">Add a passkey</Label>
					<div class="flex flex-wrap items-center gap-2">
						<Input
							id="passkey-name"
							bind:value={passkeyName}
							maxlength={64}
							placeholder="Work laptop"
							autocomplete="off"
							class="min-w-0 flex-1"
						/>
						<Button type="submit" size="sm" disabled={passkeySupported !== true || passkeyPending}>
							<KeyRoundIcon class="size-3.5" aria-hidden="true" />
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
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="border-b pb-4">
				<div class="flex items-center justify-between gap-2">
					<div class="space-y-1">
						<Card.Title>Linked sign-in methods</Card.Title>
						<Card.Description>External accounts connected to your Skiff identity.</Card.Description>
					</div>
					<LinkIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</div>
			</Card.Header>
			<Card.Content>
				{#if data.accountsError}
					<div
						class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
						role="status"
					>
						{data.accountsError}
					</div>
				{:else if data.accounts.length === 0}
					<EmptyState
						title="No linked accounts"
						description="You signed in with a passkey or email link. An owner can connect GitHub if needed."
					/>
				{:else}
					<ul class="divide-y rounded-lg border">
						{#each data.accounts as account (account.id)}
							<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
								<div>
									<p class="text-sm font-medium">{account.provider}</p>
									<p class="font-mono text-xs text-muted-foreground">
										{account.providerId}
									</p>
								</div>
								<p class="text-xs text-muted-foreground">
									linked {formatDateTime(account.createdAt)}
								</p>
							</li>
						{/each}
					</ul>
				{/if}
				<p class="mt-3 text-xs text-muted-foreground">
					Linking or unlinking providers is not available from the dashboard yet. Ask an owner if a
					provider needs to change.
				</p>
			</Card.Content>
		</Card.Root>
	</div>
</div>
