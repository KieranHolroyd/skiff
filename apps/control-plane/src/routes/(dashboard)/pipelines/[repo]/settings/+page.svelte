<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import VariableIcon from '@lucide/svelte/icons/variable';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { notify } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import PageHeader from '../../../_lib/PageHeader.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import { formatRelative } from '../../../_lib/format.js';
	import RepoTabs from '../../_lib/RepoTabs.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const repo = $derived(data.repository.name);
	const manage = $derived(data.can.manage);

	/** Inline forms: toast the result; clear the fields on success unless asked to keep them. */
	function submit(reset = true): SubmitFunction {
		return () =>
			async ({ result, update }) => {
				await update({ reset });
				notify(result);
			};
	}

	// Edit buttons fill these forms.
	let variableName = $state('');
	let variableValue = $state('');
	let environmentName = $state('');
	let environmentRefs = $state('');
	let environmentApproval = $state(false);
	// svelte-ignore state_referenced_locally
	let enabled = $state(data.repository.enabled);

	function confirmDelete(title: string, description: string, action: string, fields: Record<string, string>) {
		askConfirm({ title, description, confirmLabel: 'Delete', tone: 'danger', action, fields });
	}
</script>

<svelte:head>
	<title>Settings · {repo} · Pipelines · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Pipelines" title={repo} bordered={false} />
	<RepoTabs {repo} current="settings" />

	<form method="POST" action="?/update" use:enhance={submit(false)}>
		<Panel title="Repository" icon={SettingsIcon}>
			<div class="grid gap-5">
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="settings-clone">Clone URL</Field.Label>
						<Input
							id="settings-clone"
							name="cloneUrl"
							value={data.repository.cloneUrl}
							required
							disabled={!manage}
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-branch">Default branch</Field.Label>
						<Input
							id="settings-branch"
							name="defaultBranch"
							value={data.repository.defaultBranch}
							required
							disabled={!manage}
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="settings-image">
						Default image <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="settings-image"
						name="defaultImage"
						value={data.repository.defaultImage ?? ''}
						placeholder="docker.io/library/node:24-bookworm"
						disabled={!manage}
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description>For jobs without <code class="font-mono">container:</code>.</Field.Description>
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Switch id="settings-enabled" name="enabled" bind:checked={enabled} disabled={!manage} />
					<Field.Label for="settings-enabled" class="font-normal">
						Enabled <span class="text-muted-foreground">— when off, webhooks and schedules are ignored</span>
					</Field.Label>
				</Field.Field>
				{#if manage}
					<div><Button type="submit">Save</Button></div>
				{/if}
			</div>
		</Panel>
	</form>

	<Panel title="Webhook" icon={WebhookIcon} description="GitHub → repository settings → Webhooks → Add webhook.">
		<div class="grid gap-5">
			<dl class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
				<dt class="text-muted-foreground">Payload URL</dt>
				<dd class="flex min-w-0 items-center gap-2">
					<code class="truncate font-mono text-xs">{data.webhookUrl}</code>
					<CopyButton value={data.webhookUrl} iconOnly size="icon-xs" variant="ghost" />
				</dd>
				<dt class="text-muted-foreground">Content type</dt>
				<dd><code class="font-mono text-xs">application/json</code></dd>
				<dt class="text-muted-foreground">Events</dt>
				<dd>Pushes and pull requests</dd>
				<dt class="text-muted-foreground">Secret</dt>
				<dd>
					{#if data.repository.hasWebhookSecret}
						<Badge variant="success">Set</Badge>
					{:else}
						<Badge variant="warning">Not set</Badge>
						<span class="ml-1 text-xs text-muted-foreground">Unsigned deliveries are rejected.</span>
					{/if}
				</dd>
			</dl>
			{#if manage}
				<form
					method="POST"
					action="?/setWebhookSecret"
					use:enhance={submit()}
					class="flex flex-wrap items-end gap-2"
				>
					<Field.Field class="max-w-sm flex-1">
						<Field.Label for="settings-webhook-secret">
							{data.repository.hasWebhookSecret ? 'Replace secret' : 'Set secret'}
						</Field.Label>
						<Input
							id="settings-webhook-secret"
							name="webhookSecret"
							type="password"
							autocomplete="new-password"
							minlength={16}
							required
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Button type="submit" variant="outline">Save secret</Button>
					{#if data.repository.hasWebhookSecret}
						<Button
							type="button"
							variant="ghost"
							onclick={() =>
								askConfirm({
									title: 'Clear the webhook secret?',
									description: 'Deliveries from GitHub will be rejected until a new secret is set.',
									confirmLabel: 'Clear',
									tone: 'danger',
									action: '?/clearWebhookSecret'
								})}>Clear</Button
						>
					{/if}
				</form>
			{/if}
		</div>
	</Panel>

	<Panel
		title="Commit statuses and isolation"
		icon={ShieldCheckIcon}
		description="Report each run on its GitHub commit, and choose how strongly jobs are isolated."
	>
		<div class="grid gap-6">
			<div class="grid gap-3">
				<p class="text-sm text-muted-foreground">
					A GitHub token with <em>Commit statuses: write</em> on this repository. Each run then shows as
					<code class="font-mono text-xs">skiff/&lt;workflow&gt;</code> on its commit and pull request.
				</p>
				<div class="flex items-center gap-2 text-sm">
					<span class="text-muted-foreground">Status token</span>
					{#if data.repository.hasStatusToken}<Badge variant="success">Set</Badge>{:else}<Badge variant="secondary">Not set</Badge>{/if}
				</div>
				{#if manage}
					<form method="POST" action="?/setStatusToken" use:enhance={submit()} class="flex flex-wrap items-end gap-2">
						<Field.Field class="max-w-sm flex-1">
							<Field.Label for="settings-status-token">{data.repository.hasStatusToken ? 'Replace token' : 'Set token'}</Field.Label>
							<Input id="settings-status-token" name="statusToken" type="password" autocomplete="off" required class="font-mono text-sm" />
						</Field.Field>
						<Button type="submit" variant="outline">Save token</Button>
						{#if data.repository.hasStatusToken}
							<Button
								type="button"
								variant="ghost"
								onclick={() =>
									askConfirm({
										title: 'Clear the status token?',
										description: 'Runs stop reporting commit statuses to GitHub.',
										confirmLabel: 'Clear',
										tone: 'danger',
										action: '?/clearStatusToken'
									})}>Clear</Button
							>
						{/if}
					</form>
				{/if}
			</div>
			<form method="POST" action="?/setIsolation" use:enhance={submit()} class="grid gap-3">
				<p class="text-sm text-muted-foreground">
					The weakest isolation a job may run under. A job waits for a build node that can give at least this:
					the Builder sandbox, a container, gVisor, or a microVM (needs KVM). Pull requests from forks and inline
					workflows are untrusted.
				</p>
				<div class="flex flex-wrap items-end gap-3">
					{#each [['trusted', 'Trusted runs'], ['untrusted', 'Untrusted runs']] as [key, label] (key)}
						<Field.Field class="w-48">
							<Field.Label for={`isolation-${key}`}>{label}</Field.Label>
							<NativeSelect.Root
								id={`isolation-${key}`}
								name={key}
								class="w-full"
								value={data.repository.minIsolation?.[key as 'trusted' | 'untrusted'] ?? ''}
								disabled={!data.can.approve}
							>
								<NativeSelect.Option value="">Any</NativeSelect.Option>
								<NativeSelect.Option value="container">Container</NativeSelect.Option>
								<NativeSelect.Option value="gvisor">gVisor</NativeSelect.Option>
								<NativeSelect.Option value="microvm">MicroVM</NativeSelect.Option>
							</NativeSelect.Root>
						</Field.Field>
					{/each}
					{#if data.can.approve}<Button type="submit" variant="outline">Save</Button>{/if}
				</div>
				{#if !data.can.approve}<p class="text-xs text-muted-foreground">Only org owners and admins can change these.</p>{/if}
			</form>
		</div>
	</Panel>

	<Panel
		title="Secrets"
		icon={KeyRoundIcon}
		flush
		count={data.secrets?.length}
		description="Available to trusted runs as secrets.NAME. Values are write-only."
	>
		{#if data.secrets === null}
			<p class="px-6 pb-4 text-sm text-muted-foreground">You don't have permission to see secrets.</p>
		{:else}
			{#if data.secrets.length > 0}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-6">Name</Table.Head>
							<Table.Head>Environment</Table.Head>
							<Table.Head class="hidden sm:table-cell">Updated</Table.Head>
							<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.secrets as secret (`${secret.environment ?? ''}/${secret.name}`)}
							<Table.Row>
								<Table.Cell class="pl-6 font-mono text-sm">{secret.name}</Table.Cell>
								<Table.Cell class="text-xs">
									{#if secret.environment}<Badge variant="outline" class="font-mono font-normal"
											>{secret.environment}</Badge
										>{:else}<span class="text-muted-foreground">All</span>{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell"
									>{formatRelative(secret.updatedAt)}</Table.Cell
								>
								<Table.Cell class="pr-6">
									{#if data.can.writeSecrets}
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Delete {secret.name}"
											onclick={() =>
												confirmDelete(
													`Delete secret ${secret.name}?`,
													'Workflows that read it get an empty string.',
													'?/deleteSecret',
													{ name: secret.name, environment: secret.environment ?? '' }
												)}><Trash2Icon /></Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
			{#if data.can.writeSecrets}
				<form
					method="POST"
					action="?/setSecret"
					use:enhance={submit()}
					class="grid gap-3 border-t px-6 pt-4 pb-2 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-end"
				>
					<Field.Field>
						<Field.Label for="secret-name">Name</Field.Label>
						<Input
							id="secret-name"
							name="name"
							placeholder="NPM_TOKEN"
							required
							autocapitalize="characters"
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="secret-env">Environment</Field.Label>
						<NativeSelect.Root id="secret-env" name="environment" class="w-full">
							<NativeSelect.Option value="">All</NativeSelect.Option>
							{#each data.environments as environment (environment.name)}
								<NativeSelect.Option value={environment.name}>{environment.name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="secret-value">Value</Field.Label>
						<Input
							id="secret-value"
							name="value"
							type="password"
							autocomplete="new-password"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Button type="submit" variant="outline">Save</Button>
				</form>
				<p class="px-6 pb-2 text-xs text-muted-foreground">Saving an existing name replaces its value.</p>
			{/if}
		{/if}
	</Panel>

	<Panel
		title="Variables"
		icon={VariableIcon}
		flush
		count={data.variables?.length}
		description="Plain values as vars.NAME. Visible to every run, including forks."
	>
		{#if data.variables && data.variables.length > 0}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-6">Name</Table.Head>
						<Table.Head>Value</Table.Head>
						<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.variables as variable (variable.name)}
						<Table.Row>
							<Table.Cell class="pl-6 font-mono text-sm">{variable.name}</Table.Cell>
							<Table.Cell class="max-w-md truncate font-mono text-xs" title={variable.value}
								>{variable.value}</Table.Cell
							>
							<Table.Cell class="pr-6">
								{#if manage}
									<div class="flex gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Edit {variable.name}"
											onclick={() => {
												variableName = variable.name;
												variableValue = variable.value;
											}}><PencilIcon /></Button
										>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Delete {variable.name}"
											onclick={() =>
												confirmDelete(
													`Delete variable ${variable.name}?`,
													'Workflows that read it get an empty string.',
													'?/deleteVariable',
													{ name: variable.name }
												)}><Trash2Icon /></Button
										>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if manage}
			<form
				method="POST"
				action="?/setVariable"
				use:enhance={submit()}
				class="grid gap-3 border-t px-6 pt-4 pb-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
			>
				<Field.Field>
					<Field.Label for="variable-name">Name</Field.Label>
					<Input
						id="variable-name"
						name="name"
						bind:value={variableName}
						placeholder="NODE_VERSION"
						required
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="variable-value">Value</Field.Label>
					<Input
						id="variable-value"
						name="value"
						bind:value={variableValue}
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Button type="submit" variant="outline">Save</Button>
			</form>
			<div class="pb-2"></div>
		{/if}
	</Panel>

	<Panel
		title="Environments"
		icon={ShieldCheckIcon}
		flush
		count={data.environments.length}
		description="Jobs with environment: get its secrets, but only from allowed refs and, if set, after approval."
	>
		{#if data.environments.length > 0}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-6">Name</Table.Head>
						<Table.Head>Allowed refs</Table.Head>
						<Table.Head>Approval</Table.Head>
						<Table.Head class="hidden sm:table-cell">Secrets</Table.Head>
						<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.environments as environment (environment.name)}
						<Table.Row>
							<Table.Cell class="pl-6 font-mono text-sm">{environment.name}</Table.Cell>
							<Table.Cell>
								{#if environment.allowedRefs.length === 0}
									<span class="text-xs text-muted-foreground">Any</span>
								{:else}
									<div class="flex flex-wrap gap-1">
										{#each environment.allowedRefs as ref (ref)}
											<Badge variant="outline" class="font-mono font-normal">{ref}</Badge>
										{/each}
									</div>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-xs">
								{#if environment.requireApproval}<Badge variant="warning">Required</Badge>{:else}<span
										class="text-muted-foreground">No</span
									>{/if}
							</Table.Cell>
							<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell"
								>{environment.secretNames.join(', ') || '—'}</Table.Cell
							>
							<Table.Cell class="pr-6">
								{#if data.can.approve}
									<div class="flex gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Edit {environment.name}"
											onclick={() => {
												environmentName = environment.name;
												environmentRefs = environment.allowedRefs.join('\n');
												environmentApproval = environment.requireApproval;
											}}><PencilIcon /></Button
										>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Delete {environment.name}"
											onclick={() =>
												confirmDelete(
													`Delete environment ${environment.name}?`,
													'Its secrets are deleted too. Jobs that name it will fail.',
													'?/deleteEnvironment',
													{ name: environment.name }
												)}><Trash2Icon /></Button
										>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if data.can.approve && manage}
			<form
				method="POST"
				action="?/setEnvironment"
				use:enhance={submit()}
				class="grid gap-3 border-t px-6 pt-4 pb-4 sm:grid-cols-[1fr_2fr] sm:items-start"
			>
				<div class="grid gap-3">
					<Field.Field>
						<Field.Label for="environment-name">Name</Field.Label>
						<Input
							id="environment-name"
							name="name"
							bind:value={environmentName}
							placeholder="production"
							required
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field orientation="horizontal">
						<Checkbox
							id="environment-approval"
							name="requireApproval"
							value="on"
							bind:checked={environmentApproval}
						/>
						<Field.Label for="environment-approval" class="font-normal">Require approval</Field.Label>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="environment-refs">
						Allowed refs <span class="font-normal text-muted-foreground">one per line; empty allows any</span>
					</Field.Label>
					<Textarea
						id="environment-refs"
						name="allowedRefs"
						bind:value={environmentRefs}
						rows={3}
						placeholder={'refs/heads/main\nrefs/tags/v*'}
						spellcheck="false"
						class="font-mono text-xs"
					/>
				</Field.Field>
				<div><Button type="submit" variant="outline">Save environment</Button></div>
			</form>
		{:else if !data.can.approve}
			<p class="px-6 pb-4 text-xs text-muted-foreground">Only org owners and admins can change environments.</p>
		{/if}
	</Panel>

	<Panel
		title="Deploy targets"
		icon={RocketIcon}
		flush
		count={data.links.length}
		description="Projects that skiff/deploy may deploy to from this repository."
	>
		{#if data.links.length > 0}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-6">Project</Table.Head>
						<Table.Head>Runtime</Table.Head>
						<Table.Head>Environment</Table.Head>
						<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.links as link (link.projectSlug)}
						<Table.Row>
							<Table.Cell class="pl-6">
								<span class="inline-flex items-center gap-2 text-sm"
									><FolderKanbanIcon class="size-4 text-muted-foreground" />{link.projectName}
									<span class="font-mono text-xs text-muted-foreground">{link.projectSlug}</span></span
								>
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">{link.runtime}</Table.Cell>
							<Table.Cell class="text-xs">
								{#if link.environment}<Badge variant="outline" class="font-mono font-normal"
										>{link.environment}</Badge
									>{:else}<span class="text-muted-foreground">Any trusted job</span>{/if}
							</Table.Cell>
							<Table.Cell class="pr-6">
								{#if data.can.link}
									<Button
										variant="ghost"
										size="sm"
										onclick={() =>
											askConfirm({
												title: `Unlink ${link.projectName}?`,
												description: 'Workflows can no longer deploy to it.',
												confirmLabel: 'Unlink',
												tone: 'danger',
												action: '?/unlink',
												fields: { project: link.projectSlug }
											})}>Unlink</Button
									>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if data.can.link}
			<form
				method="POST"
				action="?/link"
				use:enhance={submit()}
				class="grid gap-3 border-t px-6 pt-4 pb-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
			>
				<Field.Field>
					<Field.Label for="link-project">Project</Field.Label>
					<NativeSelect.Root id="link-project" name="project" class="w-full" required>
						<NativeSelect.Option value="">Choose a project</NativeSelect.Option>
						{#each data.projects as project (project.slug)}
							<NativeSelect.Option value={project.slug}>{project.name} ({project.runtime})</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="link-environment">Environment</Field.Label>
					<NativeSelect.Root id="link-environment" name="environment" class="w-full">
						<NativeSelect.Option value="">Any</NativeSelect.Option>
						{#each data.environments as environment (environment.name)}
							<NativeSelect.Option value={environment.name}>{environment.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Button type="submit" variant="outline">Link</Button>
			</form>
		{/if}
	</Panel>

	{#if manage}
		<Panel title="Danger zone" icon={TriangleAlertIcon} class="border-destructive/40">
			<div class="flex flex-wrap items-center justify-between gap-4">
				<p class="max-w-xl text-sm text-muted-foreground">
					Delete this repository with its runs, logs, artifacts, caches, secrets and variables. Linked
					projects keep running.
				</p>
				<Button
					variant="destructive"
					onclick={() =>
						askConfirm({
							title: `Delete ${repo}?`,
							description:
								'Every run, log, artifact, cache, secret and variable of this repository is deleted. This cannot be undone.',
							confirmLabel: 'Delete repository',
							tone: 'danger',
							typeToConfirm: repo,
							action: '?/delete',
							fields: { confirm: repo }
						})}><Trash2Icon />Delete repository</Button
				>
			</div>
		</Panel>
	{/if}
</div>

