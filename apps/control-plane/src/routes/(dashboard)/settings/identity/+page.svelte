<script lang="ts">
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { UserPoolClientCreated, UserPoolClientView, UserPoolView } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createPoolOpen = $state(false);
	let addingClientFor = $state<string | null>(null);
	let createdClient = $state<
		| null
		| { poolId: string; client: UserPoolClientView; clientSecret: string | null }
	>(null);

	function discoveryUrl(pool: UserPoolView): string {
		return `${data.discoveryBase}/${pool.id}/.well-known/openid-configuration`;
	}

	function togglePool(pool: UserPoolView) {
		void runAction('?/setPoolDisabled', {
			poolId: pool.id,
			disabled: String(!pool.disabled)
		});
	}

	function removeClient(pool: UserPoolView, client: UserPoolClientView) {
		askConfirm({
			title: `Remove the ${client.name} client?`,
			description:
				'Applications using this client id stop being able to authenticate. The pool and its signing key are unaffected.',
			confirmLabel: 'Remove client',
			tone: 'danger',
			action: '?/deleteClient',
			fields: { poolId: pool.id, clientId: client.id }
		});
	}

	async function createClient(event: SubmitEvent, pool: UserPoolView) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement | null;
		if (!form) return;
		const formData = new FormData(form);
		const name = String(formData.get('name') ?? '').trim();
		const redirectUris = String(formData.get('redirectUris') ?? '')
			.split(/[\s,]+/)
			.map((uri) => uri.trim())
			.filter(Boolean);
		const isPublic = formData.get('public') === 'true';
		const result = await runAction('?/createClient', {
			poolId: pool.id,
			name,
			redirectUris: redirectUris.join(' '),
			public: String(isPublic)
		});
		if (result.type !== 'success') return;
		const payload = result.data as { created?: UserPoolClientCreated } | undefined;
		if (!payload?.created) return;
		createdClient = { poolId: pool.id, ...payload.created };
		addingClientFor = null;
		form.reset();
	}
</script>

<svelte:head><title>Identity · Settings · Skiff</title></svelte:head>

<SettingsHeader id="identity" />

<div class="space-y-6">
	<Panel
		title="User pools"
		icon={FingerprintIcon}
		count={data.pools.length}
		description="An OIDC provider for one app’s own end users. Each pool has its own issuer, signing key and client registrations."
		flush
	>
		{#snippet actions()}
			{#if data.canCreate}
				<Button size="sm" onclick={() => (createPoolOpen = true)}><PlusIcon />Create pool</Button>
			{/if}
		{/snippet}

		{#if data.pools.length === 0}
			<div class="p-4">
				<EmptyState
					icon={FingerprintIcon}
					compact
					title="No user pools yet"
					description="Create a pool, register an OIDC client for your app, then give the app its issuer, client id and (for a confidential client) a secret shown once."
				>
					{#if data.canCreate}
						<Button size="sm" onclick={() => (createPoolOpen = true)}
							><PlusIcon />Create a pool</Button
						>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<div class="divide-y">
				{#each data.pools as pool (pool.id)}
					{@const access = data.access[pool.id]}
					{@const clients = data.clients[pool.id] ?? []}
					{@const discovery = discoveryUrl(pool)}
					<div class="space-y-4 px-4 py-5">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0 space-y-1">
								<p class="flex flex-wrap items-center gap-2">
									<span class="text-sm font-medium">{pool.name}</span>
									<Badge variant={pool.disabled ? 'neutral' : 'success'}>
										{pool.disabled ? 'Disabled' : 'Enabled'}
									</Badge>
									<Badge variant="outline">{pool.signupMode === 'open' ? 'Open sign-up' : 'Invite only'}</Badge>
									<Badge variant="secondary" class="font-mono">{pool.engine}</Badge>
								</p>
								<p class="max-w-2xl text-xs text-pretty text-muted-foreground">
									{pool.description || 'No description.'}
								</p>
								<p class="text-xs text-muted-foreground">
									Created {formatDateTime(pool.createdAt)}
									{#if pool.signingKeyId}
										· key <span class="font-mono">{pool.signingKeyId.slice(0, 16)}…</span>
									{/if}
								</p>
							</div>
							{#if access?.update}
								<Button size="sm" variant="outline" onclick={() => togglePool(pool)}>
									<PowerIcon />{pool.disabled ? 'Enable' : 'Disable'}
								</Button>
							{/if}
						</div>

						<div class="grid gap-3 rounded-lg border bg-muted/20 p-3 lg:grid-cols-2">
							<div class="min-w-0 space-y-1">
								<p class="text-xs font-medium text-muted-foreground">Issuer</p>
								<div class="flex items-center gap-1">
									<code class="min-w-0 truncate font-mono text-xs" title={pool.issuer}>{pool.issuer}</code>
									<CopyButton iconOnly value={pool.issuer} label="Copy issuer" />
								</div>
							</div>
							<div class="min-w-0 space-y-1">
								<p class="text-xs font-medium text-muted-foreground">Discovery document</p>
								<div class="flex items-center gap-1">
									<code class="min-w-0 truncate font-mono text-xs" title={discovery}>{discovery}</code>
									<CopyButton iconOnly value={discovery} label="Copy discovery URL" />
								</div>
							</div>
						</div>

						{#if createdClient && createdClient.poolId === pool.id}
							{@const created = createdClient}
							<div class="space-y-2 rounded-lg border border-success/30 bg-success/5 p-3">
								<p class="text-sm font-medium">
									Copy the secret for {created.client.name} now
								</p>
								<p class="text-xs text-muted-foreground">
									This is the only time Skiff shows it. A public client has no secret and must use PKCE.
								</p>
								<div class="flex flex-wrap items-center gap-2">
									<code class="max-w-full break-all rounded bg-background px-2 py-1 font-mono text-xs">
										{created.clientSecret ?? 'No secret (public client)'}
									</code>
									{#if created.clientSecret}
										<CopyButton value={created.clientSecret} label="Copy secret" />
									{/if}
									<Button size="sm" variant="ghost" onclick={() => (createdClient = null)}>
										Dismiss
									</Button>
								</div>
							</div>
						{/if}

						<div class="space-y-2">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="flex items-center gap-2 text-sm font-medium">
									<KeyRoundIcon class="size-4 text-muted-foreground" />
									OIDC clients
									<Badge variant="secondary" class="tabular-nums">{clients.length}</Badge>
								</p>
								{#if access?.credentials}
									<Button
										size="sm"
										variant="outline"
										onclick={() =>
											(addingClientFor = addingClientFor === pool.id ? null : pool.id)}
									>
										<PlusIcon />Add client
									</Button>
								{/if}
							</div>

							{#if clients.length === 0}
								<p class="text-xs text-muted-foreground">
									No clients yet. A confidential client gets a secret once; a public client uses PKCE.
								</p>
							{:else}
								<ul class="space-y-2">
									{#each clients as client (client.id)}
										<li
											class="flex flex-wrap items-start justify-between gap-2 rounded-lg border bg-background px-3 py-2"
										>
											<div class="min-w-0 space-y-1">
												<p class="flex flex-wrap items-center gap-2 text-sm">
													<span class="font-medium">{client.name}</span>
													<Badge variant={client.public ? 'outline' : 'secondary'}>
														{client.public ? 'Public · PKCE' : 'Confidential'}
													</Badge>
												</p>
												<div class="flex items-center gap-1">
													<code class="truncate font-mono text-xs text-muted-foreground"
														>{client.clientId}</code
													>
													<CopyButton
														iconOnly
														value={client.clientId}
														label="Copy client id"
													/>
												</div>
												<p class="text-xs text-muted-foreground">
													Redirect: {client.redirectUris.join(', ')}
												</p>
											</div>
											{#if access?.credentials}
												<Button
													size="icon-sm"
													variant="ghost"
													aria-label="Remove the {client.name} client"
													onclick={() => removeClient(pool, client)}
												>
													<TrashIcon />
												</Button>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}

							{#if access?.credentials && addingClientFor === pool.id}
								<form
									class="grid gap-3 rounded-lg border p-3"
									onsubmit={(event) => {
										event.preventDefault();
										void createClient(event, pool);
									}}
								>
									<div class="grid gap-3 sm:grid-cols-2">
										<Field.Field>
											<Field.Label for="client-name-{pool.id}">Client name</Field.Label>
											<Input
												id="client-name-{pool.id}"
												name="name"
												required
												maxlength={100}
												placeholder="web"
											/>
										</Field.Field>
										<Field.Field orientation="horizontal" class="items-center gap-2 sm:mt-6">
											<Checkbox id="client-public-{pool.id}" name="public" value="true" />
											<Field.Label for="client-public-{pool.id}" class="font-normal">
												Public client (no secret, PKCE)
											</Field.Label>
										</Field.Field>
									</div>
									<Field.Field>
										<Field.Label for="client-redirect-{pool.id}">Redirect URIs</Field.Label>
										<Textarea
											id="client-redirect-{pool.id}"
											name="redirectUris"
											rows={2}
											required
											placeholder="https://app.example.com/callback"
										/>
										<Field.Description>
											Exact match only. Separate several URIs with spaces or new lines.
										</Field.Description>
									</Field.Field>
									<div class="flex flex-wrap items-center gap-2">
										<Button type="submit" size="sm">Create client</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onclick={() => (addingClientFor = null)}
										>
											Cancel
										</Button>
									</div>
								</form>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		{#snippet footer()}
			<span>
				Issuer and discovery are public. A client secret is sealed with the organisation key and
				shown once, at creation.
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Not yet"
		icon={FingerprintIcon}
		description="This slice stores pools, clients and signing keys. It does not host users or sign-in yet, and says so plainly."
	>
		<div class="space-y-4">
			<div class="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
				<p class="font-medium">Discovery and JWKS are real; the sign-in endpoints are not.</p>
				<p class="mt-1 text-muted-foreground">
					The issuer, discovery document and public key set are served now, so clients can be
					configured and keys can be verified. The authorization, token and userinfo URLs it
					advertises return nothing until the native identity engine ships (IAM.md I27).
				</p>
			</div>
			<ul class="grid gap-3 sm:grid-cols-2">
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">Hosted sign-in UI</p>
					<p class="mt-1 text-xs text-muted-foreground">
						Themed sign-in, sign-up, reset and MFA pages with a custom domain.
					</p>
				</li>
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">Users and passwords</p>
					<p class="mt-1 text-xs text-muted-foreground">
						Email + password, passkeys, magic links and email OTP. No user row lives in the
						control-plane database.
					</p>
				</li>
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">Sessions</p>
					<p class="mt-1 text-xs text-muted-foreground">
						Sign-in sessions, refresh tokens, revocation and per-device views.
					</p>
				</li>
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">MFA and social login</p>
					<p class="mt-1 text-xs text-muted-foreground">
						TOTP, Google, GitHub, Apple and Microsoft, with an MFA reset for support.
					</p>
				</li>
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">Import and export</p>
					<p class="mt-1 text-xs text-muted-foreground">
						JSON export (including scrypt hashes) and imports from Auth0, Cognito and Firebase.
					</p>
				</li>
				<li class="rounded-lg border p-3">
					<p class="text-sm font-medium">Attachment env vars</p>
					<p class="mt-1 text-xs text-muted-foreground">
						Attaching a pool will inject <code class="font-mono">&lt;P&gt;_ISSUER</code>,
						<code class="font-mono">&lt;P&gt;_CLIENT_ID</code> and
						<code class="font-mono">&lt;P&gt;_CLIENT_SECRET</code>, plus the
						<code class="font-mono">env.AUTH</code> function binding and pool events.
					</p>
				</li>
			</ul>
		</div>
	</Panel>
</div>

{#if data.canCreate}
	<FormDialog
		bind:open={createPoolOpen}
		icon={FingerprintIcon}
		title="Create a user pool"
		description="A pool is an OIDC issuer for one app's end users. The issuer is generated from the pool id, so its name can be reused by another organisation."
		action="?/createPool"
		submitLabel="Create pool"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="pool-name">Name</Field.Label>
				<Input
					id="pool-name"
					name="name"
					required
					minlength={2}
					maxlength={40}
					autocapitalize="off"
					spellcheck="false"
					placeholder="shop"
					class="font-mono text-sm"
				/>
				<Field.Description>Lowercase letters, digits and single hyphens.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="pool-description">
					Description <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Textarea id="pool-description" name="description" rows={2} maxlength={1000} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="pool-signup">Sign-up mode</Field.Label>
				<NativeSelect.Root id="pool-signup" name="signupMode" value="invite" class="w-full">
					<NativeSelect.Option value="invite">Invite only</NativeSelect.Option>
					<NativeSelect.Option value="open">Open sign-up</NativeSelect.Option>
				</NativeSelect.Root>
				<Field.Description>
					Stored for the hosted UI. The engine enforces it when sign-in ships.
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
