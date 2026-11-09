<script lang="ts">
	import { enhance } from '$app/forms';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import {
		SSO_PRESETS,
		SsoPresetError,
		detectSsoPreset,
		ssoPreset,
		type SsoPreset,
		type SsoPresetConfig
	} from '#lib/sso-presets.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	interface ProviderView {
		id: string;
		name: string;
		issuer: string;
		clientId: string;
		discoveryUrl: string | null;
		scopes: readonly string[];
		claims: { email: string; name: string; groups: string };
		enabled: boolean;
		hasClientSecret: boolean;
		callbackUrl: string;
		updatedAt: number;
	}

	interface DomainView {
		domain: string;
		txtRecordName: string;
		txtRecordValue: string;
		verified: boolean;
		verifiedAt: number | null;
		lastCheckedAt: number | null;
	}

	interface OwnerView {
		id: string;
		email: string;
		name: string;
		hasSecondFactor: boolean;
	}

	interface PolicyView {
		requireSso: boolean;
		require2fa: boolean;
		allowedMethods: string[];
		sessionMaxAge: number | null;
		idleTimeout: number | null;
		ipAllowlist: string[];
		breakGlassUserIds: string[];
	}

	interface ScimTokenView {
		id: string;
		createdBy: string;
		createdAt: number;
		lastUsedAt: number | null;
		revokedAt: number | null;
	}

	interface GroupMappingView {
		id: string;
		providerId: string;
		claimValue: string;
		groupId: string;
		groupName: string;
		createdAt: number;
	}

	interface GroupView {
		id: string;
		name: string;
		source: string;
		members: number;
	}

	let { data }: PageProps = $props();

	let providerOpen = $state(false);
	let editing = $state<ProviderView | null>(null);
	let domainOpen = $state(false);
	let verifying = $state<string | null>(null);
	let savingPolicy = $state(false);
	let scimToken = $state<string | null>(null);
	let creatingToken = $state(false);
	let mappingOpen = $state(false);
	let mappingProvider = $state('');
	let mappingClaim = $state('');
	let mappingGroup = $state('');

	const DEFAULT_SCOPES = 'openid profile email';
	const DEFAULT_CLAIMS = { email: 'email', name: 'name', groups: 'groups' };

	/** `custom` is the plain OIDC form; anything else is a preset id from `sso-presets.ts`. */
	let presetId = $state<string>('custom');
	let presetValues = $state<Record<string, string>>({});
	let providerName = $state('');
	let scopesText = $state(DEFAULT_SCOPES);
	let claims = $state({ ...DEFAULT_CLAIMS });
	/** Once scopes or claims are edited (or come from a saved provider), the preset stops resetting them. */
	let advancedTouched = $state(false);

	const activePreset = $derived<SsoPreset | null>(ssoPreset(presetId));
	const resolved = $derived.by<{ config: SsoPresetConfig } | { error: string } | null>(() => {
		if (!activePreset) return null;
		try {
			return { config: activePreset.resolve(presetValues) };
		} catch (cause) {
			// Say nothing until something is typed; an empty form is not an error yet.
			const typed = activePreset.fields.some(
				(field) => !field.options && (presetValues[field.key] ?? '').trim() !== ''
			);
			return typed && cause instanceof SsoPresetError ? { error: cause.message } : null;
		}
	});
	const consoleUrl = $derived(activePreset?.consoleUrl(presetValues) ?? null);
	const redirectUri = $derived(editing ? editing.callbackUrl : data.reservedCallbackUrl);

	$effect(() => {
		const config = resolved && 'config' in resolved ? resolved.config : null;
		if (!config || advancedTouched) return;
		scopesText = config.scopes.join(' ');
		claims = { ...config.claims };
	});

	function presetDefaults(preset: SsoPreset | null): Record<string, string> {
		return Object.fromEntries(
			(preset?.fields ?? []).map((field) => [field.key, field.options?.[0]?.value ?? ''])
		);
	}

	function choosePreset(id: string) {
		const preset = ssoPreset(id);
		presetId = preset ? preset.id : 'custom';
		presetValues = presetDefaults(preset);
		if (!editing) providerName = preset?.name ?? '';
		advancedTouched = false;
		if (!preset) {
			scopesText = editing?.scopes.join(' ') ?? DEFAULT_SCOPES;
			claims = { ...(editing?.claims ?? DEFAULT_CLAIMS) };
		}
	}
	const METHODS = [
		['password', 'Password'],
		['passkey', 'Passkey'],
		['github', 'GitHub'],
		['gitlab', 'GitLab'],
		['magic-link', 'Magic link'],
		['sso', 'Single sign-on']
	] as const;

	const ssoAvailable = $derived(
		data.providers.some((provider) => provider.enabled) &&
			data.domains.some((domain) => domain.verified)
	);
	const hours = $derived(
		(data.policy as PolicyView).sessionMaxAge
			? (data.policy as PolicyView).sessionMaxAge! / 3600
			: ''
	);
	const minutes = $derived(
		(data.policy as PolicyView).idleTimeout ? (data.policy as PolicyView).idleTimeout! / 60 : ''
	);

	function openProvider(provider: ProviderView | null, preset = 'custom') {
		editing = provider;
		if (provider) {
			// Reopen a saved provider in the preset its issuer came from, keeping its scopes and claims.
			const detected = detectSsoPreset(provider.issuer);
			presetId = detected?.preset.id ?? 'custom';
			presetValues = { ...presetDefaults(detected?.preset ?? null), ...detected?.values };
			providerName = provider.name;
			scopesText = provider.scopes.join(' ');
			claims = { ...provider.claims };
			advancedTouched = true;
		} else {
			choosePreset(preset);
		}
		providerOpen = true;
	}

	function presetName(issuer: string): string | null {
		return detectSsoPreset(issuer)?.preset.name ?? null;
	}

	function removeProvider(provider: ProviderView) {
		askConfirm({
			title: `Remove ${provider.name}?`,
			description:
				'Sign-ins through this provider stop. Its domains stay verified until you remove them, so remove those too before adding a replacement.',
			confirmLabel: 'Remove provider',
			tone: 'danger',
			action: '?/removeProvider',
			fields: { providerId: provider.id }
		});
	}

	function toggleProvider(provider: ProviderView) {
		void runAction('?/toggleProvider', { providerId: provider.id });
	}

	function removeDomain(domain: DomainView) {
		askConfirm({
			title: `Remove ${domain.domain}?`,
			description:
				'Addresses at this domain no longer route to your identity provider. The DNS record can stay; it proves nothing once the domain is removed here.',
			confirmLabel: 'Remove domain',
			tone: 'danger',
			action: '?/removeDomain',
			fields: { domain: domain.domain }
		});
	}

	async function verify(domain: DomainView) {
		verifying = domain.domain;
		await runAction('?/verifyDomain', { domain: domain.domain });
		verifying = null;
	}

	async function mintScimToken(rotate: boolean) {
		creatingToken = true;
		const result = await runAction(
			rotate ? '?/rotateScimToken' : '?/createScimToken',
			{},
			{
				toast: false
			}
		);
		creatingToken = false;
		if (result.type === 'success') {
			const issued = (result.data as { scimToken?: unknown; success?: unknown }).scimToken;
			if (typeof issued === 'string') scimToken = issued;
			toast.success(String((result.data as { success?: unknown }).success ?? 'Token created.'));
		} else if (result.type === 'failure')
			toast.error(
				String((result.data as { message?: unknown }).message ?? 'Could not create the token.')
			);
		else toast.error('Something went wrong. Please try again.');
	}

	function revokeScimToken(token: ScimTokenView) {
		askConfirm({
			title: 'Revoke this SCIM token?',
			description:
				'Your identity provider cannot provision or deprovision users and groups with it any more. Create a replacement token afterwards.',
			confirmLabel: 'Revoke token',
			tone: 'danger',
			action: '?/revokeScimToken',
			fields: { tokenId: token.id }
		});
	}

	function openMapping() {
		mappingProvider = data.providers[0]?.id ?? '';
		mappingClaim = '';
		mappingGroup = data.groups[0]?.id ?? '';
		mappingOpen = true;
	}

	function removeMapping(mapping: GroupMappingView) {
		askConfirm({
			title: `Stop mapping “${mapping.claimValue}”?`,
			description:
				'Members already synced from this claim keep their group membership until the next sign-in, when the mapping set is replaced.',
			confirmLabel: 'Remove mapping',
			tone: 'danger',
			action: '?/removeGroupMapping',
			fields: { mappingId: mapping.id }
		});
	}
</script>

<svelte:head><title>SSO · Settings · Skiff</title></svelte:head>

<SettingsHeader id="sso" />

<div class="space-y-6">
	<Panel
		title="Identity provider"
		icon={FingerprintIcon}
		count={data.providers.length}
		description="OpenID Connect. Users sign in at your IdP; Skiff trusts the email claim from a verified domain."
		flush
	>
		{#snippet actions()}
			{#if data.canManage && data.providers.length === 0}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button size="sm" {...props}><PlusIcon />Add provider<ChevronDownIcon /></Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-56">
						{#each SSO_PRESETS as preset (preset.id)}
							<DropdownMenu.Item onSelect={() => openProvider(null, preset.id)}>
								{preset.name}
							</DropdownMenu.Item>
						{/each}
						<DropdownMenu.Separator />
						<DropdownMenu.Item onSelect={() => openProvider(null)}
							>Other OpenID Connect</DropdownMenu.Item
						>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		{/snippet}

		{#if data.providers.length === 0}
			<div class="p-4">
				{#if data.canManage}
					<p class="text-sm font-medium">Choose your identity provider</p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						Skiff fills in the issuer, scopes and claims, and shows the steps and the redirect URI
						for that provider’s console. It checks the provider’s discovery document when you save.
					</p>
					<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
						{#each SSO_PRESETS as preset (preset.id)}
							<button
								type="button"
								class="rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
								onclick={() => openProvider(null, preset.id)}
							>
								<span class="block text-sm font-medium">{preset.name}</span>
								<span class="mt-0.5 block text-xs text-muted-foreground">{preset.summary}</span>
							</button>
						{/each}
						<button
							type="button"
							class="rounded-lg border border-dashed bg-background p-3 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
							onclick={() => openProvider(null)}
						>
							<span class="block text-sm font-medium">Other OpenID Connect</span>
							<span class="mt-0.5 block text-xs text-muted-foreground">
								Any issuer with a discovery document.
							</span>
						</button>
					</div>
				{:else}
					<EmptyState
						icon={FingerprintIcon}
						compact
						title="No identity provider"
						description="Org owners and admins can connect Entra ID, Google Workspace, Okta, GitLab, Gitea, Forgejo or any other OpenID Connect provider here."
					/>
				{/if}
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Provider</Table.Head>
						<Table.Head class="hidden lg:table-cell">Claims</Table.Head>
						<Table.Head>State</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.providers as provider (provider.id)}
						<Table.Row>
							<Table.Cell class="max-w-96 pl-4">
								<p class="flex flex-wrap items-center gap-1.5">
									<span class="font-medium">{provider.name}</span>
									{#if presetName(provider.issuer) && presetName(provider.issuer) !== provider.name}
										<Badge variant="outline">{presetName(provider.issuer)}</Badge>
									{/if}
									<Badge variant="outline">OIDC</Badge>
								</p>
								<p
									class="mt-0.5 truncate font-mono text-xs text-muted-foreground"
									title={provider.issuer}
								>
									{provider.issuer}
								</p>
								<p class="mt-0.5 truncate text-xs text-muted-foreground">
									Client id <span class="font-mono">{provider.clientId}</span>
								</p>
								<div class="mt-0.5 flex items-center gap-1">
									<p class="truncate text-xs text-muted-foreground">
										Callback <span class="font-mono">{provider.callbackUrl}</span>
									</p>
									<CopyButton value={provider.callbackUrl} iconOnly label="Copy callback URL" />
								</div>
							</Table.Cell>
							<Table.Cell class="hidden lg:table-cell">
								<p class="text-xs text-muted-foreground">
									email <span class="font-mono">{provider.claims.email}</span>, name
									<span class="font-mono">{provider.claims.name}</span>, groups
									<span class="font-mono">{provider.claims.groups}</span>
								</p>
								<p class="mt-0.5 text-xs text-muted-foreground">
									Scopes <span class="font-mono">{provider.scopes.join(' ')}</span>
								</p>
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={provider.enabled ? 'enabled' : 'disabled'}
									label={provider.enabled ? 'Enabled' : 'Disabled'}
									tone={provider.enabled ? 'success' : 'neutral'}
								/>
								<p class="mt-1 text-xs text-muted-foreground">
									Saved {formatRelative(provider.updatedAt)}
								</p>
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canManage}
									<div class="flex items-center justify-end gap-1">
										<Button size="sm" variant="outline" onclick={() => openProvider(provider)}>
											<PencilIcon />Edit
										</Button>
										<RowMenu label="Actions for {provider.name}">
											<DropdownMenu.Item onSelect={() => toggleProvider(provider)}>
												<PowerIcon />{provider.enabled ? 'Disable' : 'Enable'}
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() => removeProvider(provider)}
											>
												<TrashIcon />Remove provider
											</DropdownMenu.Item>
										</RowMenu>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				The client secret is write-only: it is sealed with this organisation's key and never
				returned. {#if !data.canManage}Org owners and admins manage SSO.{/if}
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Email domains"
		icon={GlobeIcon}
		count={data.domains.length}
		description="A domain routes sign-in only after its TXT record proves ownership. Domains are re-checked daily."
		flush
	>
		{#snippet actions()}
			{#if data.canManage}
				<Button size="sm" onclick={() => (domainOpen = true)}><PlusIcon />Add domain</Button>
			{/if}
		{/snippet}

		{#if data.domains.length === 0}
			<div class="p-4">
				<EmptyState
					icon={GlobeIcon}
					compact
					title="No verified domains"
					description="Add the domain your users' email addresses use, for example example.com. Skiff gives you a TXT record to publish; the same pattern the email service uses."
				>
					{#if data.canManage}
						<Button size="sm" onclick={() => (domainOpen = true)}><PlusIcon />Add a domain</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Domain</Table.Head>
						<Table.Head class="hidden lg:table-cell">TXT record</Table.Head>
						<Table.Head>State</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.domains as domain (domain.domain)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<p class="font-mono text-sm font-medium">{domain.domain}</p>
								<p class="mt-0.5 text-xs text-muted-foreground">
									{#if domain.verifiedAt}
										Verified {formatDateTime(domain.verifiedAt)}
									{:else}
										Not verified{#if domain.lastCheckedAt}, checked {formatRelative(
												domain.lastCheckedAt
											)}{/if}
									{/if}
								</p>
							</Table.Cell>
							<Table.Cell class="hidden max-w-96 lg:table-cell">
								<p class="text-xs text-muted-foreground">
									<span class="font-mono">{domain.txtRecordName}</span> TXT
								</p>
								<div class="mt-1 flex items-center gap-1">
									<code class="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
										>{domain.txtRecordValue}</code
									>
									<CopyButton value={domain.txtRecordValue} iconOnly label="Copy TXT value" />
								</div>
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={domain.verified ? 'verified' : 'pending'}
									label={domain.verified ? 'Verified' : 'Pending'}
									tone={domain.verified ? 'success' : 'warning'}
								/>
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canManage}
									<div class="flex items-center justify-end gap-1">
										<Button
											size="sm"
											variant="outline"
											onclick={() => verify(domain)}
											disabled={verifying !== null}
										>
											<RefreshCwIcon />{verifying === domain.domain ? 'Checking…' : 'Verify'}
										</Button>
										<RowMenu label="Actions for {domain.domain}">
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() => removeDomain(domain)}
											>
												<TrashIcon />Remove domain
											</DropdownMenu.Item>
										</RowMenu>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel
		title="SCIM provisioning"
		icon={KeyRoundIcon}
		count={data.scimTokens.length}
		description="Let your identity provider create, update and deactivate users and groups. A deactivated user is signed out and their sessions, connected apps and access keys are revoked immediately."
		flush
	>
		{#snippet actions()}
			{#if data.canManage}
				<Button
					size="sm"
					variant={data.scimTokens.some((token: ScimTokenView) => token.revokedAt === null)
						? 'outline'
						: 'default'}
					onclick={() =>
						mintScimToken(data.scimTokens.some((token: ScimTokenView) => token.revokedAt === null))}
					disabled={creatingToken}
				>
					<RefreshCwIcon />
					{data.scimTokens.some((token: ScimTokenView) => token.revokedAt === null)
						? creatingToken
							? 'Rotating…'
							: 'Rotate token'
						: creatingToken
							? 'Creating…'
							: 'Create token'}
				</Button>
			{/if}
		{/snippet}

		<div class="border-b bg-muted/30 px-4 py-3">
			<p class="text-xs text-muted-foreground">
				SCIM 2.0 base URL. Paste it and the bearer token into your provider's provisioning settings.
			</p>
			<div class="mt-1 flex items-center gap-1">
				<code class="truncate rounded bg-background px-1.5 py-0.5 font-mono text-xs"
					>{data.scimEndpoint}</code
				>
				<CopyButton value={data.scimEndpoint} iconOnly label="Copy SCIM endpoint" />
			</div>
		</div>

		{#if scimToken}
			<div
				class="border-b border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
			>
				<p class="text-sm font-medium">Copy this token now. It is shown once.</p>
				<div class="mt-1 flex items-center gap-1">
					<code
						class="min-w-0 flex-1 truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-xs"
						>{scimToken}</code
					>
					<CopyButton value={scimToken} iconOnly label="Copy SCIM token" />
					<Button size="sm" variant="ghost" onclick={() => (scimToken = null)}>Done</Button>
				</div>
			</div>
		{/if}

		{#if data.scimTokens.length === 0}
			<div class="p-4">
				<EmptyState
					icon={KeyRoundIcon}
					compact
					title="No SCIM token"
					description="Create a token to let Okta, Entra ID or another directory provision this organisation."
				>
					{#if data.canManage}
						<Button size="sm" onclick={() => mintScimToken(false)} disabled={creatingToken}>
							<PlusIcon />Create token
						</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Token</Table.Head>
						<Table.Head class="hidden lg:table-cell">Last used</Table.Head>
						<Table.Head>State</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.scimTokens as token (token.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<p class="font-mono text-xs">Token …{token.id.slice(-6)}</p>
								<p class="mt-0.5 text-xs text-muted-foreground">
									Created {formatRelative(token.createdAt)}
								</p>
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
								{token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'Never'}
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={token.revokedAt === null ? 'active' : 'revoked'}
									label={token.revokedAt === null ? 'Active' : 'Revoked'}
									tone={token.revokedAt === null ? 'success' : 'neutral'}
								/>
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canManage && token.revokedAt === null}
									<div class="flex justify-end">
										<Button size="sm" variant="outline" onclick={() => revokeScimToken(token)}>
											<TrashIcon />Revoke
										</Button>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				SCIM users become members with the {data.defaultSsoRole === 'none' ? 'default' : 'viewer'}
				role. Groups appear in IAM with source <span class="font-mono">scim</span>, and their
				membership is read-only here. {#if !data.canManage}Org owners and admins manage SCIM.{/if}
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Group mapping"
		icon={UsersIcon}
		count={data.groupMappings.length}
		description="IdP groups become Skiff groups on each SSO sign-in, so roles follow the directory. Local and SCIM-managed membership is left alone."
		flush
	>
		{#snippet actions()}
			{#if data.canManage}
				<Button
					size="sm"
					onclick={openMapping}
					disabled={data.providers.length === 0 || data.groups.length === 0}
				>
					<PlusIcon />Add mapping
				</Button>
			{/if}
		{/snippet}

		{#if data.groupMappings.length === 0}
			<div class="p-4">
				<EmptyState
					icon={UsersIcon}
					compact
					title="No group mapping"
					description={data.providers.length === 0
						? 'Add an identity provider first, then map its groups to Skiff groups.'
						: data.groups.length === 0
							? 'Create a group under IAM first, then map an IdP group claim to it.'
							: 'Without a mapping, every SSO user gets the default role and no group-derived access.'}
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">IdP group claim</Table.Head>
						<Table.Head>Skiff group</Table.Head>
						<Table.Head class="hidden lg:table-cell">Added</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.groupMappings as mapping (mapping.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<p class="font-mono text-sm">{mapping.claimValue}</p>
							</Table.Cell>
							<Table.Cell>
								<p class="text-sm font-medium">{mapping.groupName}</p>
								<p class="mt-0.5 font-mono text-xs text-muted-foreground">{mapping.groupId}</p>
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
								{formatRelative(mapping.createdAt)}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canManage}
									<div class="flex justify-end">
										<Button size="sm" variant="outline" onclick={() => removeMapping(mapping)}>
											<TrashIcon />Remove
										</Button>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				Matching is case-insensitive. The groups claim comes from the provider's claim mapping
				above. A missing claim is ignored; an empty claim clears previously synced membership.
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Authentication policy"
		icon={ShieldCheckIcon}
		description="Enforced for every member of this organisation, on top of the owner rules. Owners always need a second factor."
	>
		<form
			method="POST"
			action="?/savePolicy"
			use:enhance={() => {
				savingPolicy = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					savingPolicy = false;
					if (result.type === 'success')
						toast.success(
							String((result.data as { success?: unknown } | undefined)?.success ?? 'Saved')
						);
					else if (result.type === 'failure')
						toast.error(
							String(
								(result.data as { message?: unknown } | undefined)?.message ?? 'Could not save'
							)
						);
				};
			}}
		>
			<div class="grid gap-5 sm:grid-cols-2">
				<Field.Field orientation="horizontal">
					<Checkbox
						id="policy-require-sso"
						name="requireSso"
						value="true"
						checked={(data.policy as PolicyView).requireSso}
						disabled={!data.canManage}
					/>
					<Field.Label for="policy-require-sso" class="font-medium"
						>Require single sign-on</Field.Label
					>
					<Field.Description>
						Refuse password, magic links, GitHub and passkeys for members. Break-glass owners below
						keep them. Needs an enabled provider and a verified domain.
					</Field.Description>
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Checkbox
						id="policy-require-2fa"
						name="require2fa"
						value="true"
						checked={(data.policy as PolicyView).require2fa}
						disabled={!data.canManage}
					/>
					<Field.Label for="policy-require-2fa" class="font-medium"
						>Require a second factor</Field.Label
					>
					<Field.Description>
						Every member must use a passkey or authenticator app. The owner rule stays on even when
						this is off.
					</Field.Description>
				</Field.Field>
			</div>

			<Field.Set class="mt-5">
				<Field.Legend variant="label">Allowed sign-in methods</Field.Legend>
				<Field.Description>
					Methods not selected are refused, including on an existing session. Single sign-on
					requires a provider and a verified domain{#if !ssoAvailable}<span class="text-amber-600">
							(a provider or domain is still missing)</span
						>{/if}.
				</Field.Description>
				<div class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
					{#each METHODS as [value, label] (value)}
						<Field.Field orientation="horizontal">
							<Checkbox
								id={`policy-method-${value}`}
								name="methods"
								{value}
								checked={(data.policy as PolicyView).allowedMethods.includes(value)}
								disabled={!data.canManage}
							/>
							<Field.Label for={`policy-method-${value}`}>{label}</Field.Label>
						</Field.Field>
					{/each}
				</div>
			</Field.Set>

			<div class="mt-5 grid gap-5 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="policy-session-age">Session maximum age (hours)</Field.Label>
					<Input
						id="policy-session-age"
						name="sessionMaxAgeHours"
						type="number"
						min="1"
						step="1"
						value={hours}
						placeholder="No limit"
						disabled={!data.canManage}
					/>
					<Field.Description>Leave blank for no maximum age.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="policy-idle">Idle timeout (minutes)</Field.Label>
					<Input
						id="policy-idle"
						name="idleTimeoutMinutes"
						type="number"
						min="5"
						step="1"
						value={minutes}
						placeholder="No timeout"
						disabled={!data.canManage}
					/>
					<Field.Description>
						Signed-in sessions are checked against the last request, tracked at most once a minute.
					</Field.Description>
				</Field.Field>
			</div>

			<Field.Field class="mt-5">
				<Field.Label for="policy-ip">IP allowlist</Field.Label>
				<Textarea
					id="policy-ip"
					name="ipAllowlist"
					rows={3}
					placeholder="203.0.113.0/24"
					value={(data.policy as PolicyView).ipAllowlist.join('\n')}
					disabled={!data.canManage}
					class="font-mono text-sm"
				/>
				<Field.Description>
					One IPv4 address or CIDR per line. Empty means any network. Sessions from other addresses
					are refused.
				</Field.Description>
			</Field.Field>

			<Field.Set class="mt-5">
				<Field.Legend variant="label">Break-glass owners</Field.Legend>
				<Field.Description>
					Owners who keep their non-SSO methods when SSO is required. Pick at least one with a
					passkey or authenticator app before turning enforcement on.
				</Field.Description>
				{#if data.owners.length === 0}
					<p class="mt-2 text-sm text-muted-foreground">This organisation has no owners.</p>
				{:else}
					<div class="mt-2 grid gap-2 sm:grid-cols-2">
						{#each data.owners as owner (owner.id)}
							<Field.Field orientation="horizontal">
								<Checkbox
									id={`policy-break-glass-${owner.id}`}
									name="breakGlass"
									value={owner.id}
									checked={(data.policy as PolicyView).breakGlassUserIds.includes(owner.id)}
									disabled={!data.canManage}
								/>
								<Field.Label for={`policy-break-glass-${owner.id}`} class="min-w-0">
									<span class="truncate">{owner.name || owner.email}</span>
									<span class="block truncate text-xs font-normal text-muted-foreground">
										{owner.email}{#if !owner.hasSecondFactor}
											· no passkey or authenticator{/if}
									</span>
								</Field.Label>
							</Field.Field>
						{/each}
					</div>
				{/if}
			</Field.Set>

			<p class="mt-5 text-xs text-muted-foreground">
				New SSO users get the
				<span class="font-medium"
					>{data.defaultSsoRole === 'none' ? 'no organisation role' : 'viewer role'}</span
				>{#if data.defaultSsoRole === 'none'}
					(server started with <span class="font-mono">SKIFF_SSO_DEFAULT_ROLE=none</span>){/if}.
			</p>

			<div class="mt-5 flex justify-end">
				<Button type="submit" size="sm" disabled={savingPolicy || !data.canManage}>
					{savingPolicy ? 'Saving…' : 'Save policy'}
				</Button>
			</div>
		</form>
	</Panel>

	<Panel
		title="Not yet"
		icon={FingerprintIcon}
		description="Sign-in, JIT provisioning, group mapping and SCIM are live. SAML follows in the same plugin."
	>
		<ul class="grid gap-3 text-sm sm:grid-cols-2">
			<li class="flex items-start justify-between gap-3 rounded-md border p-3">
				<span>
					<span class="font-medium">SAML 2.0</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						The same plugin accepts SAML providers; the dashboard form still speaks OIDC only.
					</span>
				</span>
				<Badge variant="neutral">Not yet</Badge>
			</li>
		</ul>
	</Panel>
</div>

{#if data.canManage}
	<FormDialog
		bind:open={providerOpen}
		icon={FingerprintIcon}
		title={editing
			? `Edit ${editing.name}`
			: activePreset
				? `Connect ${activePreset.name}`
				: 'Add an identity provider'}
		description={activePreset
			? 'Create a client at the provider, then paste its client ID and secret here. Skiff works out the rest and checks it against the provider’s discovery document.'
			: 'Skiff fetches the issuer’s discovery document and stores the endpoints. The client secret is sealed with this organisation’s key.'}
		action="?/saveProvider"
		submitLabel={editing ? 'Save provider' : 'Add provider'}
		size="lg"
	>
		{#if editing}
			<input type="hidden" name="providerId" value={editing.id} />
		{:else}
			<input type="hidden" name="reservedProviderId" value={data.reservedProviderId} />
		{/if}
		<Field.Group>
			<Field.Field>
				<Field.Label for="sso-preset">Identity provider</Field.Label>
				<NativeSelect.Root
					id="sso-preset"
					name="preset"
					value={presetId}
					onchange={(event) => choosePreset(event.currentTarget.value)}
					class="w-full"
				>
					{#each SSO_PRESETS as preset (preset.id)}
						<NativeSelect.Option value={preset.id}>{preset.name}</NativeSelect.Option>
					{/each}
					<NativeSelect.Option value="custom">Other OpenID Connect</NativeSelect.Option>
				</NativeSelect.Root>
			</Field.Field>

			{#if activePreset}
				<section class="rounded-lg border bg-muted/30 p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<p class="text-sm font-medium">At {activePreset.name}</p>
						{#if consoleUrl}
							<Button
								size="sm"
								variant="outline"
								href={consoleUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon />Open console
							</Button>
						{/if}
					</div>
					<ol class="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
						{#each activePreset.steps as step, index (index)}
							<li>{step}</li>
						{/each}
					</ol>
					<div class="mt-3">
						<p class="text-xs font-medium">Redirect URI</p>
						<div class="mt-1 flex items-center gap-1">
							<code
								class="min-w-0 truncate rounded bg-background px-1.5 py-0.5 font-mono text-xs"
								title={redirectUri}>{redirectUri}</code
							>
							<CopyButton value={redirectUri} iconOnly label="Copy redirect URI" />
						</div>
					</div>
				</section>

				{#if activePreset.fields.length > 0}
					<div class="grid gap-4 sm:grid-cols-2">
						{#each activePreset.fields as field (field.key)}
							<Field.Field class={activePreset.fields.length === 1 ? 'sm:col-span-2' : undefined}>
								<Field.Label for={`sso-preset-${field.key}`}>
									{field.label}{#if field.optional}<span class="font-normal text-muted-foreground">
											(optional)</span
										>{/if}
								</Field.Label>
								{#if field.options}
									<NativeSelect.Root
										id={`sso-preset-${field.key}`}
										name={`preset.${field.key}`}
										bind:value={presetValues[field.key]}
										class="w-full"
									>
										{#each field.options as option (option.value)}
											<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								{:else}
									<Input
										id={`sso-preset-${field.key}`}
										name={`preset.${field.key}`}
										bind:value={presetValues[field.key]}
										placeholder={field.placeholder}
										required={!field.optional}
										autocapitalize="off"
										spellcheck="false"
										class="font-mono text-sm"
									/>
								{/if}
								<Field.Description>{field.description}</Field.Description>
							</Field.Field>
						{/each}
					</div>
				{/if}

				<div class="rounded-md border px-3 py-2 text-xs">
					{#if resolved && 'config' in resolved}
						<p class="text-muted-foreground">
							Issuer <span class="font-mono break-all text-foreground"
								>{resolved.config.issuer}</span
							>
						</p>
					{:else if resolved && 'error' in resolved}
						<p class="text-destructive">{resolved.error}</p>
					{:else}
						<p class="text-muted-foreground">
							The issuer appears here as you fill in the fields above.
						</p>
					{/if}
					<p class="mt-1 text-muted-foreground">{activePreset.groups}</p>
				</div>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field class={activePreset ? 'sm:col-span-2' : undefined}>
					<Field.Label for="sso-name">Name</Field.Label>
					<Input
						id="sso-name"
						name="name"
						bind:value={providerName}
						placeholder={activePreset?.name ?? 'Okta'}
						required
						maxlength={80}
					/>
					{#if activePreset}
						<Field.Description>Shown on the sign-in page.</Field.Description>
					{/if}
				</Field.Field>
				{#if !activePreset}
					<Field.Field>
						<Field.Label for="sso-issuer">Issuer</Field.Label>
						<Input
							id="sso-issuer"
							name="issuer"
							value={editing?.issuer ?? ''}
							placeholder="https://idp.example.com"
							required
							autocapitalize="off"
							spellcheck="false"
							class="font-mono text-sm"
						/>
						<Field.Description>The `iss` value from the IdP.</Field.Description>
					</Field.Field>
				{/if}
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="sso-client-id">Client id</Field.Label>
					<Input
						id="sso-client-id"
						name="clientId"
						value={editing?.clientId ?? ''}
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="sso-client-secret">Client secret</Field.Label>
					<Input
						id="sso-client-secret"
						name="clientSecret"
						type="password"
						placeholder={editing?.hasClientSecret ? 'Leave blank to keep the stored secret' : ''}
						required={!editing}
						autocomplete="new-password"
					/>
				</Field.Field>
			</div>

			{#if !activePreset}
				<Field.Field>
					<Field.Label for="sso-discovery">Discovery URL</Field.Label>
					<Input
						id="sso-discovery"
						name="discoveryUrl"
						value={editing?.discoveryUrl ?? ''}
						placeholder="https://idp.example.com/.well-known/openid-configuration"
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description>
						Leave blank for the standard <span class="font-mono"
							>/.well-known/openid-configuration</span
						>
						under the issuer.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="sso-callback">Redirect URI</Field.Label>
					<div class="flex items-center gap-1">
						<code
							id="sso-callback"
							class="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
							title={redirectUri}>{redirectUri}</code
						>
						<CopyButton value={redirectUri} iconOnly label="Copy redirect URI" />
					</div>
					<Field.Description
						>Register this at the IdP as the client’s redirect (callback) URI.</Field.Description
					>
				</Field.Field>
			{/if}

			<details class="group" open={!activePreset}>
				<summary
					class="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
				>
					<ChevronRightIcon class="size-3.5 transition-transform group-open:rotate-90" />
					{activePreset ? 'Scopes and claims (filled in for you)' : 'Scopes and claims'}
				</summary>
				<div class="mt-3 grid gap-4">
					<Field.Field>
						<Field.Label for="sso-scopes">Scopes</Field.Label>
						<Input
							id="sso-scopes"
							name="scopes"
							bind:value={scopesText}
							oninput={() => (advancedTouched = true)}
							placeholder={DEFAULT_SCOPES}
							autocapitalize="off"
							spellcheck="false"
							class="font-mono text-sm"
						/>
						<Field.Description
							>Space or comma separated. `openid` is always requested.</Field.Description
						>
					</Field.Field>
					<Field.Set>
						<Field.Legend variant="label">Claim mapping</Field.Legend>
						<Field.Description>Which claim in the ID token carries each value.</Field.Description>
						<div class="grid gap-4 sm:grid-cols-3">
							<Field.Field>
								<Field.Label for="sso-claim-email">Email</Field.Label>
								<Input
									id="sso-claim-email"
									name="claimEmail"
									bind:value={claims.email}
									oninput={() => (advancedTouched = true)}
									class="font-mono text-sm"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="sso-claim-name">Name</Field.Label>
								<Input
									id="sso-claim-name"
									name="claimName"
									bind:value={claims.name}
									oninput={() => (advancedTouched = true)}
									class="font-mono text-sm"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="sso-claim-groups">Groups</Field.Label>
								<Input
									id="sso-claim-groups"
									name="claimGroups"
									bind:value={claims.groups}
									oninput={() => (advancedTouched = true)}
									class="font-mono text-sm"
								/>
							</Field.Field>
						</div>
					</Field.Set>
				</div>
			</details>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={domainOpen}
		icon={GlobeIcon}
		title="Add an email domain"
		description="Skiff checks for a TXT record at the domain itself. Nothing routes until it is found."
		action="?/addDomain"
		submitLabel="Add domain"
	>
		<Field.Field>
			<Field.Label for="sso-domain">Domain</Field.Label>
			<Input
				id="sso-domain"
				name="domain"
				placeholder="example.com"
				required
				autocapitalize="off"
				spellcheck="false"
				class="font-mono text-sm"
			/>
			<Field.Description>
				A bare hostname, not a URL or an email address. After adding, publish the TXT value shown in
				the list and press Verify.
			</Field.Description>
		</Field.Field>
	</FormDialog>

	<FormDialog
		bind:open={mappingOpen}
		icon={UsersIcon}
		title="Map an IdP group"
		description="The claim value is matched case-insensitively on each SSO sign-in. It becomes this Skiff group's membership."
		action="?/saveGroupMapping"
		submitLabel="Save mapping"
	>
		<Field.Field>
			<Field.Label for="mapping-provider">Identity provider</Field.Label>
			<NativeSelect.Root
				id="mapping-provider"
				name="providerId"
				bind:value={mappingProvider}
				class="w-full"
			>
				{#each data.providers as provider (provider.id)}
					<NativeSelect.Option value={provider.id}>{provider.name}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</Field.Field>
		<Field.Field>
			<Field.Label for="mapping-claim">IdP group name</Field.Label>
			<Input
				id="mapping-claim"
				name="claimValue"
				bind:value={mappingClaim}
				placeholder="Engineering"
				required
				maxlength={200}
				autocapitalize="off"
				spellcheck="false"
				class="font-mono text-sm"
			/>
			<Field.Description>The exact value the IdP sends in its groups claim.</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label for="mapping-group">Skiff group</Field.Label>
			<NativeSelect.Root id="mapping-group" name="groupId" bind:value={mappingGroup} class="w-full">
				{#each data.groups as group (group.id)}
					<NativeSelect.Option value={group.id}>
						{group.name}{group.source === 'local' ? '' : ` (${group.source})`}
					</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<Field.Description>
				Roles bound to this group apply while the user is in the IdP group.
			</Field.Description>
		</Field.Field>
	</FormDialog>
{/if}
