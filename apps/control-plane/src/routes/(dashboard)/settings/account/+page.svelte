<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import LaptopIcon from '@lucide/svelte/icons/laptop';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { toast } from 'svelte-sonner';
	import { authClient } from '#lib/auth-client.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDate, formatDateTime, shortId } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface AccountFormResult {
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as AccountFormResult | null);

	const otherSessions = $derived(data.sessions.filter((session) => !session.current));

	let profileOpen = $state(false);
	let passkeyOpen = $state(false);
	let passkeyName = $state('');
	let passkeyPending = $state(false);
	let passkeyError = $state('');
	let passkeySupported = $state<boolean | null>(null);

	onMount(() => {
		passkeySupported = 'PublicKeyCredential' in window;
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
			passkeyOpen = false;
			toast.success('Passkey added.');
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

	function revokeSession(session: { id: string; device: string }) {
		askConfirm({
			title: `Sign out ${session.device}?`,
			description: 'That device is signed out immediately.',
			confirmLabel: 'Sign out device',
			tone: 'danger',
			action: '?/revokeSession',
			fields: { sessionId: session.id }
		});
	}

	function revokeOthers() {
		askConfirm({
			title: `Sign out ${otherSessions.length} other ${otherSessions.length === 1 ? 'session' : 'sessions'}?`,
			description: 'Every browser and CLI session except this one is signed out immediately.',
			confirmLabel: 'Sign out others',
			tone: 'danger',
			action: '?/revokeOtherSessions'
		});
	}

	function disableTotp() {
		askConfirm({
			title: 'Remove the authenticator app?',
			description: data.twoFactor.requiredForRole
				? 'Codes from the app stop working. As an owner you will need a passkey (or to set up an app again) in your next session.'
				: 'Codes from the app stop working, and the backup codes are discarded.',
			confirmLabel: 'Remove app',
			tone: 'danger',
			action: '?/disableTotp'
		});
	}

	const factorLabels: Record<string, string> = {
		passkey: 'a passkey',
		totp: 'an authenticator code',
		'backup-code': 'a backup code'
	};

	function removePasskey(passkey: { id: string; name: string }) {
		askConfirm({
			title: `Remove ${passkey.name}?`,
			description: 'You will no longer be able to sign in with this passkey.',
			confirmLabel: 'Remove passkey',
			tone: 'danger',
			action: '?/deletePasskey',
			fields: { passkeyId: passkey.id }
		});
	}
</script>

<svelte:head>
	<title>Account settings · Skiff</title>
</svelte:head>

<div class="space-y-5">
	<Card.Root>
		<Card.Content class="flex flex-wrap items-center gap-4">
			<Avatar.Root class="size-14">
				<Avatar.Fallback
					class="bg-gradient-to-br from-brand to-[oklch(0.55_0.17_25)] text-lg font-semibold text-brand-foreground"
					>{initials}</Avatar.Fallback
				>
			</Avatar.Root>
			<div class="min-w-0 flex-1 basis-56 space-y-1">
				<p class="text-lg leading-tight font-semibold tracking-[-0.015em]">{data.user.name}</p>
				<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<span class="break-all">{data.user.email}</span>
					{#if data.user.emailVerified}
						<Badge variant="success">verified</Badge>
					{:else}
						<Badge variant="warning">unverified</Badge>
					{/if}
					<Badge variant="outline" class="capitalize">{data.role}</Badge>
				</div>
			</div>
			<Button variant="outline" onclick={() => (profileOpen = true)}
				><PencilIcon />Edit profile</Button
			>
		</Card.Content>
		<Card.Footer class="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
			<span
				>Member since {formatDate(data.user.createdAt)} · email and role are managed by an owner</span
			>
			<span class="flex items-center gap-1 font-mono">
				{shortId(data.user.id, 16)}
				<CopyButton value={data.user.id} label="Copy user ID" iconOnly />
			</span>
		</Card.Footer>
	</Card.Root>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<LaptopIcon class="size-4 text-muted-foreground" />Active sessions
				{#if !data.sessionsError}<Badge variant="neutral" class="font-mono"
						>{data.sessions.length}</Badge
					>{/if}
			</Card.Title>
			<Card.Description>
				Every browser or CLI session signed in as you. Revoke anything you do not recognise.
			</Card.Description>
			{#if otherSessions.length > 0}
				<Card.Action class="self-center">
					<Button variant="outline" onclick={revokeOthers}>Sign out other sessions</Button>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content class="px-0">
			{#if data.sessionsError}
				<div class="p-4">
					<Alert.Root variant="warning">
						<TriangleAlertIcon />
						<Alert.Description>{data.sessionsError}</Alert.Description>
					</Alert.Root>
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
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Device</Table.Head>
							<Table.Head class="hidden sm:table-cell">IP address</Table.Head>
							<Table.Head class="hidden md:table-cell">Signed in</Table.Head>
							<Table.Head class="hidden lg:table-cell">Last active</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.sessions as session (session.id)}
							<Table.Row
								class={session.current ? 'bg-success-soft/40 hover:bg-success-soft/50' : ''}
							>
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-3">
										<span
											class="grid size-8 shrink-0 place-items-center rounded-lg border bg-card text-muted-foreground"
										>
											<MonitorSmartphoneIcon class="size-4" />
										</span>
										<div class="min-w-0">
											<p class="flex items-center gap-2 font-medium">
												{session.device}
												{#if session.current}<Badge variant="success">this device</Badge>{/if}
											</p>
											<p
												class="max-w-xs truncate text-xs text-muted-foreground"
												title={session.userAgent ?? 'No user agent reported'}
											>
												{session.userAgent ?? 'No user agent reported'}
											</p>
										</div>
									</div>
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
									{session.ipAddress ?? '—'}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{formatDateTime(session.createdAt)}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
									{formatDateTime(session.lastActiveAt)}
								</Table.Cell>
								<Table.Cell class="pr-4">
									{#if !session.current}
										<Button variant="ghost-danger" size="sm" onclick={() => revokeSession(session)}>
											Revoke
										</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				<ShieldCheckIcon class="size-4 text-muted-foreground" />Two-factor authentication
				{#if data.twoFactor.requiredForRole}<Badge variant="info">required for owners</Badge>{/if}
			</Card.Title>
			<Card.Description>
				A passkey counts as a second factor. An authenticator app adds one-time codes for when you
				sign in with GitHub or an email link.
			</Card.Description>
			<Card.Action>
				{#if data.twoFactor.totpEnabled}
					<Button size="sm" variant="ghost-danger" onclick={disableTotp}>Remove app</Button>
				{:else}
					<Button
						size="sm"
						variant="outline"
						href="/two-factor?setup=1&redirect=%2Fsettings%2Faccount"><PlusIcon />Set up app</Button
					>
				{/if}
			</Card.Action>
		</Card.Header>
		<Card.Content class="flex flex-wrap gap-2 text-sm">
			<Badge variant={data.twoFactor.totpEnabled ? 'success' : 'neutral'}>
				Authenticator app {data.twoFactor.totpEnabled ? 'on' : 'off'}
			</Badge>
			<Badge variant={data.passkeys.length > 0 ? 'success' : 'neutral'}>
				{data.passkeys.length}
				{data.passkeys.length === 1 ? 'passkey' : 'passkeys'}
			</Badge>
			{#if data.twoFactor.sessionFactor}
				<span class="self-center text-xs text-muted-foreground">
					This session was verified with {factorLabels[data.twoFactor.sessionFactor] ??
						'a second factor'}.
				</span>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid items-start gap-5 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<FingerprintIcon class="size-4 text-muted-foreground" />Passkeys
				</Card.Title>
				<Card.Description
					>Phishing-resistant sign-in with your device, fingerprint or security key.</Card.Description
				>
				<Card.Action>
					<Button size="sm" variant="outline" onclick={() => (passkeyOpen = true)}>
						<PlusIcon />Add
					</Button>
				</Card.Action>
			</Card.Header>
			<Card.Content>
				{#if data.passkeysError}
					<Alert.Root variant="warning">
						<TriangleAlertIcon />
						<Alert.Description>{data.passkeysError}</Alert.Description>
					</Alert.Root>
				{:else if data.passkeys.length === 0}
					<EmptyState
						icon={FingerprintIcon}
						compact
						title="No passkeys yet"
						description="Add one so you can sign in without an email link or GitHub."
					/>
				{:else}
					<Item.Group class="gap-2">
						{#each data.passkeys as passkey (passkey.id)}
							<Item.Root variant="outline" size="sm">
								<Item.Media variant="icon"><FingerprintIcon /></Item.Media>
								<Item.Content>
									<Item.Title>
										{passkey.name}
										{#if passkey.backedUp}<Badge variant="info">synced</Badge>{/if}
									</Item.Title>
									<Item.Description>
										{passkey.authenticator ?? passkey.deviceType} · added {formatDate(
											passkey.createdAt
										)}
									</Item.Description>
								</Item.Content>
								<Item.Actions>
									<Button variant="ghost-danger" size="sm" onclick={() => removePasskey(passkey)}
										>Remove</Button
									>
								</Item.Actions>
							</Item.Root>
						{/each}
					</Item.Group>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<LinkIcon class="size-4 text-muted-foreground" />Linked sign-in methods
				</Card.Title>
				<Card.Description>External accounts connected to your Skiff identity.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if data.accountsError}
					<Alert.Root variant="warning">
						<TriangleAlertIcon />
						<Alert.Description>{data.accountsError}</Alert.Description>
					</Alert.Root>
				{:else if data.accounts.length === 0}
					<EmptyState
						icon={LinkIcon}
						compact
						title="No linked accounts"
						description="You signed in with a passkey or email link. An owner can connect GitHub if needed."
					/>
				{:else}
					<Item.Group class="gap-2">
						{#each data.accounts as account (account.id)}
							<Item.Root variant="outline" size="sm">
								<Item.Media variant="icon">
									{#if account.provider.toLowerCase() === 'github'}<GitHubMark />{:else}<LinkIcon
										/>{/if}
								</Item.Media>
								<Item.Content class="min-w-0">
									<Item.Title class="capitalize">{account.provider}</Item.Title>
									<Item.Description class="truncate font-mono text-[11px]"
										>{account.providerId}</Item.Description
									>
								</Item.Content>
								<Item.Actions>
									<span class="text-xs text-muted-foreground"
										>linked {formatDate(account.createdAt)}</span
									>
								</Item.Actions>
							</Item.Root>
						{/each}
					</Item.Group>
				{/if}
			</Card.Content>
			<Card.Footer class="text-xs text-muted-foreground">
				Linking or unlinking providers is not available from the dashboard yet.
			</Card.Footer>
		</Card.Root>
	</div>
</div>

<FormDialog
	bind:open={profileOpen}
	icon={UserRoundIcon}
	title="Edit profile"
	description="Shown on members, invitations and the audit log."
	action="?/updateProfile"
	submitLabel="Save profile"
	size="sm"
>
	<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
		<Field.Label for="profile-name">Display name</Field.Label>
		<Input
			id="profile-name"
			name="name"
			value={data.user.name}
			maxlength={80}
			required
			autocomplete="name"
			aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
		/>
		{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
	</Field.Field>
</FormDialog>

<Dialog.Root bind:open={passkeyOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header class="flex-row items-start gap-3.5">
			<span
				class="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/50 text-muted-foreground"
			>
				<FingerprintIcon class="size-4" />
			</span>
			<div class="space-y-1.5">
				<Dialog.Title>Add a passkey</Dialog.Title>
				<Dialog.Description
					>Your browser will ask for your fingerprint, face or security key.</Dialog.Description
				>
			</div>
		</Dialog.Header>
		<form class="grid gap-5" onsubmit={addPasskey}>
			{#if passkeyError}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Description>{passkeyError}</Alert.Description>
				</Alert.Root>
			{:else if passkeySupported === false}
				<Alert.Root variant="warning">
					<TriangleAlertIcon />
					<Alert.Description>
						This browser does not support passkeys. Try a recent version of Chrome, Safari or
						Firefox.
					</Alert.Description>
				</Alert.Root>
			{/if}
			<Field.Field>
				<Field.Label for="passkey-name">Name</Field.Label>
				<Input
					id="passkey-name"
					bind:value={passkeyName}
					maxlength={64}
					placeholder="Work laptop"
					autocomplete="off"
				/>
				<Field.Description>Only a label for this list.</Field.Description>
			</Field.Field>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}<Button variant="outline" {...props}>Cancel</Button>{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={passkeySupported !== true || passkeyPending}>
					{#if passkeyPending}<Spinner />Waiting for device…{:else}<FingerprintIcon />Add passkey{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
