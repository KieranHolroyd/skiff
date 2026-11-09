<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitMergeIcon from '@lucide/svelte/icons/git-merge';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import { resolve } from '$app/paths';
	import {
		FORGE_LABELS,
		FORGE_PRESETS,
		FORGE_TOKEN_HELP,
		type ForgeConnectionView,
		type ForgeKind,
		type ForgeWebhookView
	} from '@yoal/contracts';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import ForgeMark from '#lib/components/yoal/ForgeMark.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import GitHubMark from '#lib/components/yoal/GitHubMark.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { notify } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let editOpen = $state(false);
	let hookOpen = $state(false);
	let kind = $state<ForgeKind>('gitlab');
	let baseUrl = $state(FORGE_PRESETS.gitlab.baseUrl);
	let editing = $state<ForgeConnectionView | null>(null);
	let hookScope = $state<'repository' | 'namespace'>('namespace');
	let autoForm = $state<HTMLFormElement | null>(null);
	/** Follows the server after each save; the switch writes it first. */
	let autoEnabled = $derived(data.pipelineSetup.enabled);
	/** Ignore-list entries for forges are `host/full name`; GitHub's are `owner/name` (owners never contain a dot). */
	const forgeIgnored = $derived(data.pipelineSetup.ignored.filter((name) => /[.:]/.test(name.split('/')[0] ?? '')));

	/** Switching kind swaps the hosted preset in, unless the person typed their own instance. */
	function chooseKind(next: ForgeKind) {
		const presets = Object.values(FORGE_PRESETS).map((preset) => preset.baseUrl);
		if (!baseUrl || presets.includes(baseUrl)) baseUrl = FORGE_PRESETS[next].baseUrl;
		kind = next;
	}

	const help = $derived(FORGE_TOKEN_HELP[kind]);
	const tokenPage = $derived(`${baseUrl.replace(/\/+$/, '')}${help.tokenPage}`);

	function openCreate() {
		kind = 'gitlab';
		baseUrl = FORGE_PRESETS.gitlab.baseUrl;
		createOpen = true;
	}

	function openEdit(connection: ForgeConnectionView) {
		editing = connection;
		editOpen = true;
	}

	function openHook(connection: ForgeConnectionView, scope: 'repository' | 'namespace') {
		editing = connection;
		hookScope = scope;
		hookOpen = true;
	}

	function remove(connection: ForgeConnectionView) {
		askConfirm({
			title: `Remove ${connection.name}?`,
			description:
				'Yoal deletes the webhooks it created there. Git builds and pipelines for its repositories keep their settings but stop receiving events, clone with the build node’s own credentials, and post no statuses.',
			confirmLabel: 'Remove connection',
			tone: 'danger',
			action: '?/remove',
			fields: { id: connection.id }
		});
	}

	function removeHook(connection: ForgeConnectionView, hook: ForgeWebhookView) {
		askConfirm({
			title: `Remove the webhook on ${hook.path}?`,
			description: `${hook.scope === 'namespace' ? 'Repositories under it' : 'The repository'} stop sending events to Yoal unless a hand-made webhook remains.`,
			confirmLabel: 'Remove webhook',
			tone: 'danger',
			action: '?/removeWebhook',
			fields: { id: connection.id, webhookId: hook.id }
		});
	}

	const namespaceWord = (connection: ForgeConnectionView) => (connection.kind === 'gitlab' ? 'group' : 'organisation');
</script>

<svelte:head><title>Git providers · Settings · Yoal</title></svelte:head>

<SettingsHeader id="git" />

<div class="space-y-6">
	<Panel title="GitHub" icon={GitHubMark} description="GitHub connects through Yoal’s GitHub App, which has its own page.">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<p class="flex items-center gap-2 text-sm">
				{#if data.github.configured && data.github.installations > 0}
					<CircleCheckIcon class="size-4 text-success" />
					{data.github.name ?? 'The GitHub App'} · {data.github.installations} installation{data.github.installations === 1 ? '' : 's'} linked here
				{:else if data.github.configured}
					<CircleAlertIcon class="size-4 text-muted-foreground" />
					The App is registered but not installed for this organisation.
				{:else}
					<CircleAlertIcon class="size-4 text-muted-foreground" />
					No GitHub App yet. A platform admin can create one.
				{/if}
			</p>
			<Button size="sm" variant="outline" href={resolve('/(dashboard)/settings/github')}>Open GitHub settings</Button>
		</div>
	</Panel>

	<Panel
		title="GitLab, Gitea and Forgejo"
		icon={GitMergeIcon}
		count={data.connections.length}
		description="Connect an instance with an API token. Yoal then lists its repositories, creates their webhooks, clones private ones and posts commit statuses."
	>
		{#snippet actions()}
			{#if data.canManage}
				<Button size="sm" onclick={openCreate}><PlusIcon />Connect</Button>
			{/if}
		{/snippet}

		{#if data.connections.length === 0}
			<EmptyState
				icon={GitMergeIcon}
				compact
				title="No forge connected"
				description={data.canManage
					? 'gitlab.com, Codeberg and self-hosted GitLab, Gitea or Forgejo all work. You need an API token; Yoal checks it before saving.'
					: 'An organisation owner or admin can connect GitLab, Gitea or Forgejo here.'}
			>
				{#if data.canManage}
					<Button size="sm" onclick={openCreate}><PlusIcon />Connect a forge</Button>
				{/if}
			</EmptyState>
		{:else}
			<p class="text-sm text-muted-foreground">
				Use a connected repository’s clone URL in a project’s git source or in Pipelines, or import it from
				<a class="underline underline-offset-2" href={resolve('/(dashboard)/new/github')}>Deploy from Git</a>.
			</p>
		{/if}
	</Panel>

	{#each data.connections as connection (connection.id)}
		<Panel title={connection.name} icon={GitMergeIcon} description="{FORGE_LABELS[connection.kind]} · {connection.baseUrl}" flush>
			{#snippet actions()}
				{#if data.canManage}
					<Button size="sm" variant="outline" onclick={() => openHook(connection, 'namespace')}><WebhookIcon />Watch a {namespaceWord(connection)}</Button>
					<RowMenu label="Actions for {connection.name}">
						<DropdownMenu.Item onSelect={() => openHook(connection, 'repository')}><WebhookIcon />Add a repository webhook</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => openEdit(connection)}><KeyRoundIcon />Rename or replace tokens</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => window.open(connection.baseUrl, '_blank', 'noreferrer')}><ExternalLinkIcon />Open {FORGE_LABELS[connection.kind]}</DropdownMenu.Item>
						<DropdownMenu.Item variant="destructive" onSelect={() => remove(connection)}><TrashIcon />Remove</DropdownMenu.Item>
					</RowMenu>
				{/if}
			{/snippet}

			<div class="p-4">
				<DetailList>
					<dt>API token</dt>
					<dd class="flex items-center gap-2 text-sm">
						<ForgeMark kind={connection.kind} class="size-3.5" />
						{connection.accountLogin ?? '—'}
					</dd>
					<dt>Clones</dt>
					<dd class="text-sm">
						{#if connection.kind === 'gitlab'}
							Per-repository deploy tokens{connection.hasCloneToken ? `, else the clone token of ${connection.cloneLogin ?? 'its account'}` : ' when the token has Maintainer; otherwise the build node’s own credentials'}
						{:else if connection.hasCloneToken}
							Clone token of {connection.cloneLogin ?? 'its account'}
						{:else}
							<span class="text-muted-foreground">The build node’s own credentials (no clone token)</span>
						{/if}
					</dd>
					<dt>Webhook URL</dt>
					<dd class="flex items-center gap-1 font-mono text-xs">
						<span class="truncate">{connection.webhookUrl}</span><CopyButton value={connection.webhookUrl} />
					</dd>
					<dt>Connected</dt>
					<dd class="text-xs text-muted-foreground">{formatDateTime(connection.createdAt)}</dd>
				</DetailList>
			</div>

			{#if connection.webhooks.length > 0}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">Webhook</Table.Head>
							<Table.Head>State</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each connection.webhooks as hook (hook.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<p class="font-mono text-xs">{hook.path}</p>
									<p class="text-xs text-muted-foreground">{hook.scope === 'namespace' ? `Every repository in this ${namespaceWord(connection)}` : 'Repository'}</p>
								</Table.Cell>
								<Table.Cell class="text-sm">
									{#if hook.error}
										<p class="flex items-start gap-1 text-xs text-destructive">
											<CircleAlertIcon class="mt-0.5 size-3 shrink-0" /><span>{hook.error}</span>
										</p>
									{:else}
										<Badge variant="secondary">delivering</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell class="pr-4">
									{#if data.canManage}
										<div class="flex justify-end gap-1">
											{#if hook.error}
												<form
													method="POST"
													action="?/webhook"
													use:enhance={() =>
														async ({ result, update }) => {
															await update({ reset: false });
															notify(result);
														}}
												>
													<input type="hidden" name="id" value={connection.id} />
													<input type="hidden" name="scope" value={hook.scope} />
													<input type="hidden" name="path" value={hook.path} />
													<Button size="sm" variant="ghost" type="submit"><RefreshCwIcon />Retry</Button>
												</form>
											{/if}
											<Button size="sm" variant="ghost" class="text-destructive" onclick={() => removeHook(connection, hook)}>
												<TrashIcon /><span class="sr-only">Remove</span>
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
					Yoal adds a repository webhook when a git source or pipeline names the repository. A {namespaceWord(connection)} webhook
					also lets pushes add repositories with .yoal/workflows to Pipelines{data.pipelineSetup.enabled ? '' : ' (turned off below)'}.
				</span>
			{/snippet}
		</Panel>
	{/each}

	{#if data.connections.length > 0}
		<Panel
			title="Pipelines"
			icon={WorkflowIcon}
			description="Repositories under a watched group or organisation run their .yoal/workflows without being added by hand."
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
					disabled={!data.canManage}
					onCheckedChange={() => void tick().then(() => autoForm?.requestSubmit())}
				/>
				<div class="space-y-0.5">
					<label for="auto-pipelines" class="text-sm font-medium">Set up pipelines automatically</label>
					<p class="text-sm text-muted-foreground">
						On a push through a group or organisation webhook, a repository with workflow files that is not in
						<a class="underline underline-offset-2" href={resolve('/(dashboard)/pipelines')}>Pipelines</a> yet is added
						(as whoever connected the forge) and its workflows run. Merge and pull requests never add one, so a fork
						cannot. This is the same switch as for the GitHub App.{data.canManage ? '' : ' Owners and admins can change this.'}
					</p>
				</div>
			</form>
			{#if forgeIgnored.length > 0}
				<div class="mt-4 space-y-2 border-t pt-4">
					<p class="text-xs text-muted-foreground">Removed from Pipelines, so not added back:</p>
					<ul class="flex flex-wrap gap-2">
						{#each forgeIgnored as repository (repository)}
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
									{#if data.canManage}<Button size="xs" variant="ghost" type="submit">Allow again</Button>{/if}
								</form>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</Panel>
	{/if}

	<Panel title="What a connection does" icon={GitMergeIcon} description="The GitHub App’s features, through each forge’s API.">
		<ul class="grid gap-4 sm:grid-cols-2">
			<li class="space-y-1">
				<p class="text-sm font-medium">Webhooks Yoal creates</p>
				<p class="text-sm text-muted-foreground">No secret to copy: pushes and merge or pull requests arrive signed. Hand-made webhooks for the same repository are ignored.</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-medium">Private clones</p>
				<p class="text-sm text-muted-foreground">GitLab: a read-only deploy token per repository that expires in two days. Gitea and Forgejo: the read-only clone token, sent to that host only.</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-medium">Statuses and deployments</p>
				<p class="text-sm text-muted-foreground">Builds and pipeline runs post commit statuses; promoted GitLab builds appear under Operate → Environments.</p>
			</li>
			<li class="space-y-1">
				<p class="text-sm font-medium">Fork merge requests stay untrusted</p>
				<p class="text-sm text-muted-foreground">A merge or pull request from another project runs without secrets, environments or deploys, as on GitHub.</p>
			</li>
		</ul>
	</Panel>
</div>

{#if data.canManage}
	<FormDialog bind:open={createOpen} icon={GitMergeIcon} title="Connect a forge" description="Yoal checks the token with the forge before saving it." action="?/create" submitLabel="Connect" size="lg">
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-[10rem_1fr]">
				<Field.Field>
					<Field.Label for="forge-kind">Forge</Field.Label>
					<NativeSelect.Root id="forge-kind" name="kind" value={kind} onchange={(event) => chooseKind((event.currentTarget as HTMLSelectElement).value as ForgeKind)}>
						<NativeSelect.Option value="gitlab">GitLab</NativeSelect.Option>
						<NativeSelect.Option value="forgejo">Forgejo</NativeSelect.Option>
						<NativeSelect.Option value="gitea">Gitea</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="forge-base">Instance URL</Field.Label>
					<Input id="forge-base" name="baseUrl" bind:value={baseUrl} placeholder="https://git.example.com" spellcheck="false" autocapitalize="off" required />
					<Field.Description>{FORGE_PRESETS[kind].label} is filled in; replace it for a self-hosted instance.</Field.Description>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="forge-name">Name (optional)</Field.Label>
				<Input id="forge-name" name="name" placeholder="Defaults to the host" maxlength={80} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="forge-token">API token</Field.Label>
				<Input id="forge-token" name="token" type="password" autocomplete="off" required minlength={8} />
				<Field.Description>
					{help.api}
					<a class="underline underline-offset-2" href={tokenPage} target="_blank" rel="noreferrer">Create one</a>.
				</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="forge-clone">Clone token (optional)</Field.Label>
				<Input id="forge-clone" name="cloneToken" type="password" autocomplete="off" />
				<Field.Description>{help.clone}</Field.Description>
			</Field.Field>
			<Notice tone="info">The API token stays on the control plane, sealed with this organisation’s key. Build nodes only ever receive a deploy or clone token for the one repository they clone.</Notice>
		</Field.Group>
	</FormDialog>

	{#if editing}
		<FormDialog bind:open={editOpen} icon={KeyRoundIcon} title="Edit {editing.name}" description="Leave a token blank to keep it. A new token is checked before it is saved." action="?/update" submitLabel="Save">
			<input type="hidden" name="id" value={editing.id} />
			<Field.Group>
				<Field.Field>
					<Field.Label for="edit-name">Name</Field.Label>
					<Input id="edit-name" name="name" value={editing.name} maxlength={80} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="edit-token">New API token</Field.Label>
					<Input id="edit-token" name="token" type="password" autocomplete="off" placeholder="Unchanged" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="edit-clone">New clone token</Field.Label>
					<Input id="edit-clone" name="cloneToken" type="password" autocomplete="off" placeholder={editing.hasCloneToken ? 'Unchanged' : 'None'} />
				</Field.Field>
				{#if editing.hasCloneToken}
					<Field.Field orientation="horizontal">
						<Checkbox id="edit-remove-clone" name="removeCloneToken" />
						<Field.Label for="edit-remove-clone">Remove the clone token</Field.Label>
					</Field.Field>
				{/if}
			</Field.Group>
		</FormDialog>

		<FormDialog
			bind:open={hookOpen}
			icon={WebhookIcon}
			title={hookScope === 'namespace' ? `Watch a ${namespaceWord(editing)}` : 'Add a repository webhook'}
			description={hookScope === 'namespace'
				? `One webhook on the ${namespaceWord(editing)} delivers every repository in it${editing.kind === 'gitlab' ? ' (GitLab group webhooks need Premium or a self-managed instance with them)' : ''}.`
				: 'Yoal adds these by itself for repositories it builds; use this to re-create one.'}
			action="?/webhook"
			submitLabel="Create webhook"
		>
			<input type="hidden" name="id" value={editing.id} />
			<input type="hidden" name="scope" value={hookScope} />
			<Field.Group>
				<Field.Field>
					<Field.Label for="hook-path">{hookScope === 'namespace' ? (editing.kind === 'gitlab' ? 'Group path' : 'Organisation') : 'Repository'}</Field.Label>
					<Input
						id="hook-path"
						name="path"
						required
						spellcheck="false"
						autocapitalize="off"
						placeholder={hookScope === 'namespace' ? (editing.kind === 'gitlab' ? 'acme/platform' : 'acme') : 'acme/app or a clone URL'}
					/>
				</Field.Field>
			</Field.Group>
		</FormDialog>
	{/if}
{/if}
