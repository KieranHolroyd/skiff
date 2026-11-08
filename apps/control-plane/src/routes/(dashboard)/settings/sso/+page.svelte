<script lang="ts">
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash';
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
	import * as Table from '#lib/components/ui/table/index.js';
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

	let { data }: PageProps = $props();

	let providerOpen = $state(false);
	let editing = $state<ProviderView | null>(null);
	let domainOpen = $state(false);
	let verifying = $state<string | null>(null);

	const DEFAULT_SCOPES = 'openid profile email';

	function openProvider(provider: ProviderView | null) {
		editing = provider;
		providerOpen = true;
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
			{#if data.canManage}
				<Button size="sm" onclick={() => openProvider(null)}><PlusIcon />Add provider</Button>
			{/if}
		{/snippet}

		{#if data.providers.length === 0}
			<div class="p-4">
				<EmptyState
					icon={FingerprintIcon}
					compact
					title="No identity provider"
					description="Add the issuer, client id and client secret from Okta, Entra ID, Google Workspace, Keycloak or any other OpenID Connect provider. Skiff reads its discovery document when you save."
				>
					{#if data.canManage}
						<Button size="sm" onclick={() => openProvider(null)}><PlusIcon />Add a provider</Button>
					{/if}
				</EmptyState>
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
		title="Not yet"
		icon={FingerprintIcon}
		description="This slice stores configuration and proves domain ownership. These follow with the Better Auth plugin."
	>
		<ul class="grid gap-3 text-sm sm:grid-cols-2">
			<li class="flex items-start justify-between gap-3 rounded-md border p-3">
				<span>
					<span class="font-medium">Just-in-time provisioning</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						Create a member on first SSO sign-in, with the default role.
					</span>
				</span>
				<Badge variant="neutral">Not yet</Badge>
			</li>
			<li class="flex items-start justify-between gap-3 rounded-md border p-3">
				<span>
					<span class="font-medium">Group mapping</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						Map IdP groups to Skiff groups, so roles follow the directory.
					</span>
				</span>
				<Badge variant="neutral">Not yet</Badge>
			</li>
			<li class="flex items-start justify-between gap-3 rounded-md border p-3">
				<span class="flex-1">
					<Field.Field orientation="horizontal">
						<Checkbox id="require-sso" disabled />
						<Field.Label for="require-sso" class="font-medium">Require SSO</Field.Label>
					</Field.Field>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						Refuse passwords, magic links and GitHub for verified domains, with break-glass owners.
					</span>
				</span>
				<Badge variant="neutral">Not yet</Badge>
			</li>
			<li class="flex items-start justify-between gap-3 rounded-md border p-3">
				<span>
					<span class="font-medium">SAML and SCIM</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						The same plugin adds SAML 2.0, and a separate plugin adds user and group provisioning.
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
		title={editing ? `Edit ${editing.name}` : 'Add an identity provider'}
		description="Skiff fetches the issuer's discovery document and stores the endpoints. The client secret is sealed with this organisation's key."
		action="?/saveProvider"
		submitLabel={editing ? 'Save provider' : 'Add provider'}
		size="lg"
	>
		{#if editing}<input type="hidden" name="providerId" value={editing.id} />{/if}
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="sso-name">Name</Field.Label>
					<Input
						id="sso-name"
						name="name"
						value={editing?.name ?? ''}
						placeholder="Okta"
						required
						maxlength={80}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="sso-issuer">Issuer</Field.Label>
					<Input
						id="sso-issuer"
						name="issuer"
						value={editing?.issuer ?? ''}
						placeholder="https://example.okta.com"
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description
						>The `iss` value from the IdP, without a trailing slash.</Field.Description
					>
				</Field.Field>
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
			<Field.Field>
				<Field.Label for="sso-discovery">Discovery URL</Field.Label>
				<Input
					id="sso-discovery"
					name="discoveryUrl"
					value={editing?.discoveryUrl ?? ''}
					placeholder="https://example.okta.com/.well-known/openid-configuration"
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
				<Field.Label for="sso-scopes">Scopes</Field.Label>
				<Input
					id="sso-scopes"
					name="scopes"
					value={editing?.scopes.join(' ') ?? DEFAULT_SCOPES}
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
							value={editing?.claims.email ?? 'email'}
							required
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sso-claim-name">Name</Field.Label>
						<Input
							id="sso-claim-name"
							name="claimName"
							value={editing?.claims.name ?? 'name'}
							required
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sso-claim-groups">Groups</Field.Label>
						<Input
							id="sso-claim-groups"
							name="claimGroups"
							value={editing?.claims.groups ?? 'groups'}
							required
							class="font-mono text-sm"
						/>
					</Field.Field>
				</div>
			</Field.Set>
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
{/if}
