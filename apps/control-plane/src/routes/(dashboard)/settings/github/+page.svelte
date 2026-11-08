<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnlinkIcon from '@lucide/svelte/icons/unlink';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import { resolve } from '$app/paths';
	import type { GithubInstallationView } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { notify } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let createOpen = $state(false);
	let manualOpen = $state(false);
	let syncing = $state(false);
	let autoForm = $state<HTMLFormElement | null>(null);
	/** Follows the server after each save; the switch writes it first. */
	let autoEnabled = $derived(data.pipelineSetup.enabled);
	let manifestForm = $state<HTMLFormElement | null>(null);

	/** The manifest action answers with what to POST to GitHub; send the browser there. */
	const manifestPost = $derived(
		(form as { manifestPost?: { url: string; manifest: string } } | null)?.manifestPost ?? null
	);
	$effect(() => {
		if (!manifestPost) return;
		void tick().then(() => manifestForm?.submit());
	});

	const FEATURES = [
		{
			title: 'Private repositories, no node token',
			body: 'Build nodes clone with a one-hour, read-only token for that one repository, minted per build or job.'
		},
		{
			title: 'Deploy from Git',
			body: 'Projects → Deploy from Git imports a repository: Skiff detects the framework, connects it and deploys every push. GitLab, Gitea and Forgejo connect in Settings → Git providers.'
		},
		{
			title: 'Pipelines set themselves up',
			body: 'A push to a repository with .skiff/workflows adds it to Pipelines and starts its workflows. Nothing to register, no webhook.'
		},
		{
			title: 'Events without webhooks',
			body: 'Pushes and pull requests reach every git build and pipeline that names the repository. Hand-made webhooks for the same repository are ignored, so nothing runs twice.'
		},
		{
			title: 'Statuses and deployments',
			body: 'Builds and pipeline runs report commit statuses; promoted git builds appear under the repository’s Deployments.'
		},
		{
			title: 'GITHUB_TOKEN in pipelines',
			body: 'Trusted jobs get a repository-scoped token as secrets.GITHUB_TOKEN, like GitHub Actions. Fork pull requests never do.'
		},
		{
			title: 'Runners without a PAT',
			body: 'GitHub Actions runner pools can authenticate with “Skiff’s GitHub App” instead of a stored token or key.'
		},
		{
			title: 'Repository pickers',
			body: 'Git builds, pipelines and registry trusts let you pick a repository instead of typing its URL.'
		}
	];

	const PERMISSION_LABELS: Record<string, string> = {
		contents: 'Contents',
		metadata: 'Metadata',
		pull_requests: 'Pull requests',
		statuses: 'Commit statuses',
		deployments: 'Deployments',
		administration: 'Administration (repository runners)',
		organization_self_hosted_runners: 'Self-hosted runners (organisation)'
	};

	function unlink(installation: GithubInstallationView) {
		askConfirm({
			title: `Disconnect ${installation.account.login}?`,
			description: `Builds and pipelines for ${installation.account.login}'s repositories stop receiving events and private clones fall back to the build node's own credentials. The App stays installed on GitHub; uninstall it there to remove its access.`,
			confirmLabel: 'Disconnect',
			tone: 'danger',
			action: '?/unlink',
			fields: { installationId: String(installation.id) }
		});
	}

	function link(installation: GithubInstallationView) {
		askConfirm({
			title: `Connect ${installation.account.login} to this organisation?`,
			description: `Everyone in this organisation with build permissions can then build, run pipelines for and read the repositories this installation covers.`,
			confirmLabel: 'Connect',
			action: '?/link',
			fields: { installationId: String(installation.id) }
		});
	}

	function removeApp() {
		askConfirm({
			title: 'Remove the GitHub App from Skiff?',
			description:
				'Every organisation loses its installations here. Builds and pipelines fall back to hand-made webhooks, stored tokens and node credentials. The App itself stays registered on GitHub; delete it there as well if you no longer need it.',
			confirmLabel: 'Remove App',
			tone: 'danger',
			action: '?/remove'
		});
	}
</script>

<svelte:head><title>GitHub · Settings · Skiff</title></svelte:head>

<SettingsHeader id="github" />

<div class="space-y-6">
	{#if data.notice}<Notice tone="success">{data.notice}</Notice>{/if}

	<Panel
		title="GitHub App"
		icon={SparklesIcon}
		description="One App serves this whole Skiff install; each GitHub account that installs it is linked to one organisation."
	>
		{#snippet actions()}
			{#if data.isAdmin && data.app.configured}
				<Button size="sm" variant="outline" onclick={() => (manualOpen = true)}><KeyRoundIcon />Update credentials</Button>
			{/if}
		{/snippet}

		{#if data.app.configured}
			<DetailList>
				<dt>App</dt>
				<dd class="flex items-center gap-2 text-sm">
					<GitHubMark class="size-3.5" />
					{#if data.app.htmlUrl}
						<a class="font-medium underline-offset-2 hover:underline" href={data.app.htmlUrl} target="_blank" rel="noreferrer"
							>{data.app.name ?? data.app.slug}</a
						>
					{:else}
						<span class="font-medium">{data.app.name ?? `App ${data.app.appId}`}</span>
					{/if}
					<span class="font-mono text-xs text-muted-foreground">#{data.app.appId}</span>
				</dd>
				<dt>Owner</dt>
				<dd class="font-mono text-xs">{data.app.owner ?? '—'}</dd>
				<dt>Sign in with GitHub</dt>
				<dd class="text-sm">
					{#if data.app.signInFromEnv}
						Uses <span class="font-mono text-xs">GITHUB_CLIENT_ID</span> from the environment
					{:else if data.app.signInReady}
						Through this App <span class="text-muted-foreground">(after the next control-plane restart)</span>
					{:else}
						<span class="text-muted-foreground">Off: the App has no OAuth client secret</span>
					{/if}
				</dd>
				{#if data.isAdmin}
					<dt>Webhook URL</dt>
					<dd class="flex items-center gap-1 font-mono text-xs">
						<span class="truncate">{data.app.webhookUrl}</span><CopyButton value={data.app.webhookUrl} />
					</dd>
					<dt>Added</dt>
					<dd class="text-xs text-muted-foreground">
						{data.app.createdAt ? formatDateTime(data.app.createdAt) : '—'} · {data.app.source === 'manifest'
							? 'created from Skiff'
							: 'credentials pasted'}
					</dd>
				{/if}
			</DetailList>
			{#if data.isAdmin}
				<div class="mt-4 flex justify-end">
					<Button size="sm" variant="ghost" class="text-destructive" onclick={removeApp}><TrashIcon />Remove App</Button>
				</div>
			{/if}
		{:else if data.isAdmin}
			<EmptyState
				icon={SparklesIcon}
				compact
				title="Connect GitHub in one click"
				description="Skiff registers an App on your GitHub account or organisation with exactly the permissions it uses, and stores its key sealed on the control plane."
			>
				<div class="flex flex-wrap justify-center gap-2">
					<Button size="sm" onclick={() => (createOpen = true)}><GitHubMark class="size-3.5" />Create GitHub App</Button>
					<Button size="sm" variant="outline" onclick={() => (manualOpen = true)}><KeyRoundIcon />Use an existing App</Button>
				</div>
			</EmptyState>
		{:else}
			<p class="text-sm text-muted-foreground">
				No GitHub App is connected yet. A platform admin can create one here; until then builds and pipelines use webhooks and
				tokens you set up by hand.
			</p>
		{/if}
	</Panel>

	{#if data.app.configured}
		<Panel
			title="Installations"
			icon={LinkIcon}
			count={data.installations.length}
			description="GitHub accounts whose repositories this organisation can use through the App."
			flush
		>
			{#snippet actions()}
				{#if data.isAdmin}
					<form
						method="POST"
						action="?/sync"
						use:enhance={() => {
							syncing = true;
							return async ({ result, update }) => {
								await update({ reset: false });
								syncing = false;
								notify(result);
							};
						}}
					>
						<Button size="sm" variant="ghost" type="submit" disabled={syncing}>
							{#if syncing}<Spinner />{:else}<RefreshCwIcon />{/if}Sync
						</Button>
					</form>
				{/if}
				{#if data.installUrl && data.canLink}
					<Button size="sm" href={data.installUrl}><PlusIcon />Install on GitHub</Button>
				{/if}
			{/snippet}

			{#if data.installations.length === 0}
				<div class="p-4">
					<EmptyState
						icon={GitHubMark}
						compact
						title="Not installed for this organisation"
						description={data.canLink
							? 'Install the App on your GitHub account or organisation and choose which repositories it may see. GitHub sends you back here to finish.'
							: 'An organisation owner or admin can install the App and connect it here.'}
					>
						{#if data.installUrl && data.canLink}
							<Button size="sm" href={data.installUrl}><GitHubMark class="size-3.5" />Install on GitHub</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">Account</Table.Head>
							<Table.Head>Repositories</Table.Head>
							<Table.Head class="hidden md:table-cell">Connected</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.installations as installation (installation.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-3">
										{#if installation.account.avatarUrl}
											<img src="{installation.account.avatarUrl}&s=64" alt="" class="size-8 shrink-0 rounded-md" />
										{:else}
											<span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><GitHubMark /></span>
										{/if}
										<div class="min-w-0 space-y-0.5">
											<p class="flex items-center gap-2 text-sm font-medium">
												{installation.account.login}
												{#if installation.suspended}<Badge variant="destructive">suspended</Badge>{/if}
											</p>
											<p class="text-xs text-muted-foreground">
												{installation.account.type === 'Organization' ? 'Organisation' : 'User'} · installation {installation.id}
											</p>
										</div>
									</div>
								</Table.Cell>
								<Table.Cell class="text-sm">
									{installation.repositorySelection === 'all' ? 'All repositories' : 'Selected repositories'}
									{#if installation.missingPermissions.length > 0}
										<p class="mt-1 flex items-start gap-1 text-xs text-warning">
											<CircleAlertIcon class="mt-0.5 size-3 shrink-0" />
											<span>
												Not granted: {installation.missingPermissions.map((name) => PERMISSION_LABELS[name] ?? name).join(', ')}.
												Accept the App’s new permissions on GitHub.
											</span>
										</p>
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{installation.linkedAt ? formatDateTime(installation.linkedAt) : '—'}
								</Table.Cell>
								<Table.Cell class="pr-4">
									<div class="flex justify-end">
										<RowMenu label="Actions for {installation.account.login}">
											<DropdownMenu.Item onSelect={() => window.open(installation.settingsUrl, '_blank', 'noreferrer')}>
												<ExternalLinkIcon />Choose repositories on GitHub
											</DropdownMenu.Item>
											{#if data.canLink || data.isAdmin}
												<DropdownMenu.Item variant="destructive" onSelect={() => unlink(installation)}>
													<UnlinkIcon />Disconnect
												</DropdownMenu.Item>
											{/if}
										</RowMenu>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}

			{#snippet footer()}
				<span>
					Linking checks with GitHub that you can see the installation, so nobody can claim another account’s repositories.
					Tokens are minted per use and never stored.
				</span>
			{/snippet}
		</Panel>

		<Panel
			title="Pipelines"
			icon={WorkflowIcon}
			description="Repositories the App covers run their .skiff/workflows without being added by hand."
		>
			<form
				bind:this={autoForm}
				method="POST"
				action="?/autoPipelines"
				use:enhance={() =>
					async ({ result, update }) => {
						await update({ reset: false });
						notify(result);
					}}
				class="flex items-start gap-3"
			>
				<Switch
					id="auto-pipelines"
					name="enabled"
					value="1"
					bind:checked={autoEnabled}
					disabled={!data.canLink}
					onCheckedChange={() => void tick().then(() => autoForm?.requestSubmit())}
				/>
				<div class="space-y-0.5">
					<label for="auto-pipelines" class="text-sm font-medium">Set up pipelines automatically</label>
					<p class="text-sm text-muted-foreground">
						On a push, a repository with workflow files that is not in
						<a class="underline underline-offset-2" href={resolve('/(dashboard)/pipelines')}>Pipelines</a> yet
						is added (as whoever linked the installation) and its workflows run. Pull requests never add
						one, so a fork cannot.{data.canLink ? '' : ' Owners and admins can change this.'}
					</p>
				</div>
			</form>
			{#if data.pipelineSetup.ignored.length > 0}
				<div class="mt-4 space-y-2 border-t pt-4">
					<p class="text-xs text-muted-foreground">Removed from Pipelines, so not added back:</p>
					<ul class="flex flex-wrap gap-2">
						{#each data.pipelineSetup.ignored as repository (repository)}
							<li>
								<form
									method="POST"
									action="?/unignore"
									use:enhance={() =>
										async ({ result, update }) => {
											await update({ reset: false });
											notify(result);
										}}
									class="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2"
								>
									<input type="hidden" name="repository" value={repository} />
									<span class="font-mono text-xs">{repository}</span>
									{#if data.canLink}
										<Button size="xs" variant="ghost" type="submit">Allow again</Button>
									{/if}
								</form>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Panel>

		{#if data.isAdmin && (data.unclaimed.length > 0 || data.elsewhere.length > 0)}
			<Panel
				title="Other installations"
				icon={GitHubMark}
				description="Visible to platform admins: installations not linked here, and which organisation holds the rest."
				flush
			>
				<Table.Root>
					<Table.Body>
						{#each [...data.unclaimed, ...data.elsewhere] as installation (installation.id)}
							<Table.Row>
								<Table.Cell class="pl-4 text-sm font-medium">{installation.account.login}</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									{installation.orgId ? `Linked to ${installation.orgName ?? installation.orgId}` : 'Not linked to any organisation'}
								</Table.Cell>
								<Table.Cell class="pr-4 text-right">
									{#if !installation.orgId && data.canLink}
										<Button size="sm" variant="outline" onclick={() => link(installation)}><LinkIcon />Link here</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Panel>
		{/if}
	{/if}

	<Panel title="What the App does" icon={GitHubMark} description="Everything is per repository the App can see; repositories it cannot see work as before.">
		<ul class="grid gap-4 sm:grid-cols-2">
			{#each FEATURES as feature (feature.title)}
				<li class="space-y-1">
					<p class="text-sm font-medium">{feature.title}</p>
					<p class="text-sm text-muted-foreground">{feature.body}</p>
				</li>
			{/each}
		</ul>
	</Panel>
</div>

{#if manifestPost}
	<!-- Posted to GitHub automatically; GitHub returns to /settings/github/created. -->
	<form bind:this={manifestForm} method="POST" action={manifestPost.url} class="hidden">
		<input type="hidden" name="manifest" value={manifestPost.manifest} />
		<noscript><button type="submit">Continue to GitHub</button></noscript>
	</form>
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
		<p class="flex items-center gap-2 text-sm"><Spinner />Opening GitHub…</p>
	</div>
{/if}

{#if data.isAdmin}
	<FormDialog
		bind:open={createOpen}
		icon={SparklesIcon}
		title="Create a GitHub App"
		description="GitHub asks you to confirm, then sends you back here with the App's credentials."
		action="?/manifest"
		submitLabel="Continue to GitHub"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="app-name">Name</Field.Label>
				<Input id="app-name" name="name" value={data.defaultName} maxlength={34} required />
				<Field.Description>Unique across GitHub; shown on commit statuses and deployments.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="app-owner">GitHub organisation (optional)</Field.Label>
				<Input id="app-owner" name="owner" placeholder="my-org" spellcheck="false" autocapitalize="off" />
				<Field.Description>Leave blank to register it on your personal account. You must own the organisation.</Field.Description>
			</Field.Field>
			<Field.Field orientation="horizontal">
				<Checkbox id="app-public" name="public" />
				<Field.Content>
					<Field.Label for="app-public">Installable by any GitHub account</Field.Label>
					<Field.Description>Needed when organisations in this Skiff use different GitHub accounts.</Field.Description>
				</Field.Content>
			</Field.Field>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={manualOpen}
		icon={KeyRoundIcon}
		title={data.app.configured ? 'Update App credentials' : 'Use an existing GitHub App'}
		description="Paste the App's credentials from its settings page on GitHub."
		action="?/manual"
		submitLabel="Save"
		size="lg"
	>
		<Field.Group>
			<Notice tone="info">
				Set the App’s webhook URL to <span class="font-mono text-xs break-all">{data.app.webhookUrl}</span>, its callback URL to
				<span class="font-mono text-xs break-all">{data.app.setupUrl}</span> with “Request user authorization (OAuth) during
				installation” on, and subscribe to Push and Pull request events.
			</Notice>
			<Field.Field>
				<Field.Label for="manual-app-id">App ID</Field.Label>
				<Input id="manual-app-id" name="appId" type="number" min={1} value={data.app.appId ?? ''} required />
			</Field.Field>
			<Field.Field>
				<Field.Label for="manual-key">Private key</Field.Label>
				<Textarea id="manual-key" name="privateKey" rows={5} placeholder="-----BEGIN RSA PRIVATE KEY-----" class="font-mono text-xs" required />
			</Field.Field>
			<Field.Field>
				<Field.Label for="manual-secret">Webhook secret</Field.Label>
				<Input id="manual-secret" name="webhookSecret" type="password" minlength={16} required autocomplete="off" />
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="manual-client-id">Client ID (optional)</Field.Label>
					<Input id="manual-client-id" name="clientId" value={data.app.clientId ?? ''} autocomplete="off" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="manual-client-secret">Client secret (optional)</Field.Label>
					<Input
						id="manual-client-secret"
						name="clientSecret"
						type="password"
						autocomplete="off"
						placeholder={data.app.hasClientSecret ? 'Unchanged' : ''}
					/>
				</Field.Field>
			</div>
			<p class="text-xs text-muted-foreground">
				The client credentials let org owners link installations themselves (GitHub confirms who installed it) and enable
				“Sign in with GitHub”. Without them only platform admins can link installations.
			</p>
		</Field.Group>
	</FormDialog>
{/if}
