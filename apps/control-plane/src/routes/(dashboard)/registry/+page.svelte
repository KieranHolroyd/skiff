<script lang="ts">
	import { resolve } from '$app/paths';
	import PackageIcon from '@lucide/svelte/icons/package';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { RegistryOidcTrustView, RegistryRepositoryView } from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import GitRepoPicker from '#lib/components/skiff/GitRepoPicker.svelte';
	import ForgeMark from '#lib/components/skiff/ForgeMark.svelte';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import CodeBlock from '../_lib/CodeBlock.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatBytes, formatRelative } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');
	let matched = $state(0);
	let trustOpen = $state(false);
	/** `owner/repo` for a new trust; a pick from the GitHub App's repositories fills it. */
	let trustRepo = $state('');
	let trustProvider = $state<'github' | 'gitlab'>('github');

	const orgSlug = $derived(data.org.slug ?? '<org>');
	const host = $derived(data.denied ? '' : data.registry.host);

	const repoHref = (name: string) =>
		resolve('/(dashboard)/registry/[...repository]', { repository: name });

	const totals = $derived.by(() => {
		if (data.denied) return { pushes: 0, lastPushAt: null as number | null, autodeploy: 0 };
		let pushes = 0;
		let lastPushAt: number | null = null;
		let autodeploy = 0;
		for (const repository of data.repositories) {
			pushes += repository.pushes;
			if (repository.lastPushAt && (!lastPushAt || repository.lastPushAt > lastPushAt))
				lastPushAt = repository.lastPushAt;
			if (repository.deploy?.project) autodeploy += 1;
		}
		return { pushes, lastPushAt, autodeploy };
	});

	const usagePercent = $derived(
		!data.denied && data.usage.limitBytes
			? Math.min(100, (data.usage.usedBytes / data.usage.limitBytes) * 100)
			: null
	);

	const quickstart = $derived(`# Log in with your Skiff API key (or: docker login ${host})
skif registry login

# Tag and push; the first push creates the repository
docker tag web:latest ${host}/${orgSlug}/web:latest
docker push ${host}/${orgSlug}/web:latest

# Deploy it to a container project, pinned to the pushed digest
skif registry deploy <project> ${host}/${orgSlug}/web:latest`);

	const workflowSnippet = $derived(`permissions:
  id-token: write
  contents: read

steps:
  - name: Get an OIDC token for ${host}
    id: oidc
    run: |
      token=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
        "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${host}" | jq -r .value)
      echo "::add-mask::$token"
      echo "token=$token" >> "$GITHUB_OUTPUT"
  - uses: docker/login-action@v3
    with:
      registry: ${host}
      username: github-oidc
      password: \${{ steps.oidc.outputs.token }}
  - run: docker push ${host}/${orgSlug}/app:latest`);

	const gitlabSnippet = $derived(`push-image:
  image: docker:27
  services: [docker:27-dind]
  id_tokens:
    SKIFF_ID_TOKEN:
      aud: ${host}
  script:
    - echo "$SKIFF_ID_TOKEN" | docker login ${host} -u gitlab-oidc --password-stdin
    - docker build -t ${host}/${orgSlug}/app:$CI_COMMIT_SHORT_SHA .
    - docker push ${host}/${orgSlug}/app:$CI_COMMIT_SHORT_SHA`);

	type Row = RegistryRepositoryView;
	const columns: DataColumn<Row>[] = [
		{ id: 'name', header: 'Repository', value: (row) => row.name, cell: nameCell, class: 'pl-4' },
		{
			id: 'last',
			header: 'Last push',
			value: (row) => row.lastPushAt ?? 0,
			searchable: false,
			descFirst: true,
			cell: lastCell
		},
		{
			id: 'pushes',
			header: 'Pushes',
			value: (row) => row.pushes,
			searchable: false,
			descFirst: true,
			cell: pushesCell,
			class: 'hidden text-right font-mono text-xs tabular-nums md:table-cell'
		},
		{
			id: 'size',
			header: 'Size',
			value: (row) => row.bytes,
			searchable: false,
			descFirst: true,
			cell: sizeCell,
			class: 'hidden text-right font-mono text-xs tabular-nums sm:table-cell'
		},
		{
			id: 'deploy',
			header: 'Deploy on push',
			value: (row) => row.deploy?.project ?? '',
			cell: deployCell,
			class: 'hidden lg:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];

	function removeTrust(trust: RegistryOidcTrustView) {
		askConfirm({
			title: `Remove the trust for ${trust.subject ?? trust.githubRepository}?`,
			description: `${trust.provider === 'gitlab' ? 'CI jobs' : 'Workflows'} in ${trust.subject ?? trust.githubRepository} can no longer log in to ${trust.repository}. Images already pushed stay.`,
			confirmLabel: 'Remove trust',
			tone: 'danger',
			action: '?/removeTrust',
			fields: { id: trust.id }
		});
	}
</script>

<svelte:head><title>Registry · Skiff</title></svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.registry"
		eyebrow="Workloads"
		title="Registry"
		description="Container images pushed to this install's own registry. Workflows push with their job login, deploys pin the digest, and a push can deploy a project."
	>
		{#snippet meta()}
			{#if !data.denied && data.registry.enabled}
				<div class="flex flex-wrap items-center gap-2">
					<StatusBadge status={data.registry.status} />
					<span class="font-mono text-xs">{data.registry.host}</span>
					<CopyButton
						value={data.registry.host}
						label="Copy host"
						iconOnly
						size="icon-sm"
						variant="ghost"
					/>
				</div>
			{/if}
		{/snippet}
		{#if !data.denied && data.canAdminister}
			<Button variant="outline" href={resolve('/(dashboard)/settings/registry')}>
				<SettingsIcon />Registry settings
			</Button>
		{/if}
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="The registry is not visible"
			description="This account does not have the image:pull permission."
		/>
	{:else if !data.registry.enabled}
		<EmptyState
			icon={PackageIcon}
			title="The registry is off"
			description={data.canAdminister
				? 'Turn it on in Settings and choose the node that stores images; prefer one with a large disk, or use an S3 bucket.'
				: 'A platform admin can turn it on in Settings → Container registries. Until then, containers pull public images or use registry credentials.'}
		>
			{#if data.canAdminister}
				<Button href={resolve('/(dashboard)/settings/registry')}
					><SettingsIcon />Set up the registry</Button
				>
			{/if}
		</EmptyState>
	{:else}
		<dl
			class="grid gap-x-8 gap-y-4 rounded-xl border bg-card p-4 text-sm shadow-xs sm:grid-cols-2 lg:grid-cols-4"
		>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Repositories</dt>
				<dd class="text-lg font-semibold tabular-nums">{data.repositories.length}</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Storage</dt>
				<dd class="space-y-1.5">
					<p>
						<span class="text-lg font-semibold tabular-nums"
							>{formatBytes(data.usage.usedBytes)}</span
						>
						<span class="text-muted-foreground">
							{data.usage.limitBytes ? `of ${formatBytes(data.usage.limitBytes)}` : 'no limit'}
						</span>
					</p>
					{#if usagePercent !== null}
						<Progress
							value={usagePercent}
							class="h-1.5 {usagePercent >= 90
								? '[&_[data-slot=progress-indicator]]:bg-destructive'
								: usagePercent >= 75
									? '[&_[data-slot=progress-indicator]]:bg-warning'
									: ''}"
							aria-label="{usagePercent.toFixed(0)}% of the registry quota used"
						/>
					{/if}
				</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Pushes</dt>
				<dd>
					<span class="text-lg font-semibold tabular-nums">{totals.pushes}</span>
					<span class="text-muted-foreground">
						{totals.lastPushAt ? `· last ${formatRelative(totals.lastPushAt)}` : ''}
					</span>
				</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Deploy on push</dt>
				<dd>
					<span class="text-lg font-semibold tabular-nums">{totals.autodeploy}</span>
					<span class="text-muted-foreground"
						>{totals.autodeploy === 1 ? 'repository' : 'repositories'}</span
					>
				</dd>
			</div>
		</dl>

		{#if data.repositories.length === 0}
			<Panel title="Push your first image" icon={TerminalIcon}>
				<p class="mb-4 text-sm text-muted-foreground">
					Repositories live under {data.registry.host}/{orgSlug}/. A workflow's
					<code class="font-mono text-xs">skiff/build-image</code> step pushes without a login; from a
					laptop, log in with an API key.
				</p>
				<CodeBlock label="Terminal" lang="bash" code={quickstart} />
			</Panel>
		{:else}
			<div class="space-y-3">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<InputGroup.Root class="max-w-xs bg-card">
						<InputGroup.Input
							placeholder="Search repositories"
							bind:value={query}
							aria-label="Search repositories"
						/>
						<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
						{#if query}
							<InputGroup.Addon align="inline-end">
								<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
							</InputGroup.Addon>
						{/if}
					</InputGroup.Root>
					<p class="text-sm text-muted-foreground">
						Sizes are sampled hourly · newest {data.registry.keepTags} tags kept, plus every deployed
						digest
					</p>
				</div>
				<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
					<DataTable
						label="Repositories"
						rows={data.repositories}
						{columns}
						rowId={(row) => row.name}
						search={query.trim()}
						sort={{ id: 'last', desc: true }}
						onmatch={(count) => (matched = count)}
					/>
				</div>
			</div>

			<Panel title="Push and deploy" icon={TerminalIcon}>
				<CodeBlock label="Terminal" lang="bash" code={quickstart} />
			</Panel>
		{/if}

		<Panel
			title="CI identities (OIDC)"
			icon={GitHubMark}
			count={data.trusts.length}
			description="Let a GitHub repository's workflows or a GitLab project's CI jobs log in with their OIDC token instead of a stored API key."
			flush
		>
			{#snippet actions()}
				{#if data.canEditTrusts}
					<Button size="sm" onclick={() => (trustOpen = true)}><PlusIcon />Add trust</Button>
				{/if}
			{/snippet}

			{#if data.trusts.length === 0}
				<div class="p-4">
					<EmptyState
						icon={GitHubMark}
						compact
						title="No trusted workflows"
						description="Add a trust to let a GitHub repository (Actions) or a GitLab project (CI id_tokens) push or pull {orgSlug}/* images."
					/>
				</div>
			{:else}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">CI repository</Table.Head>
							<Table.Head>Registry repository</Table.Head>
							<Table.Head class="hidden md:table-cell">Ref</Table.Head>
							<Table.Head>Access</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.trusts as trust (trust.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<span class="flex items-center gap-2 font-mono text-sm"
										><ForgeMark kind={trust.provider} class="size-3.5 shrink-0 text-muted-foreground" />{trust.subject ?? trust.githubRepository}</span
									>
									{#if trust.provider === 'gitlab' && trust.issuer}<span class="block text-xs text-muted-foreground">{trust.issuer}</span>{/if}
								</Table.Cell>
								<Table.Cell class="font-mono text-xs">{trust.repository}</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs md:table-cell"
									>{trust.ref ?? 'any ref'}</Table.Cell
								>
								<Table.Cell class="text-xs">{trust.push ? 'push + pull' : 'pull'}</Table.Cell>
								<Table.Cell class="pr-4">
									{#if data.canEditTrusts}
										<div class="flex justify-end">
											<RowMenu label="Actions for {trust.githubRepository}">
												<DropdownMenu.Item
													variant="destructive"
													onSelect={() => removeTrust(trust)}
												>
													<TrashIcon />Remove trust
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

			<div class="grid gap-4 border-t p-4 lg:grid-cols-2">
				<CodeBlock label=".github/workflows/push.yml" lang="yaml" code={workflowSnippet} />
				<CodeBlock label=".gitlab-ci.yml" lang="yaml" code={gitlabSnippet} />
			</div>
		</Panel>
	{/if}
</div>

{#snippet nameCell(row: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<PackageIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={repoHref(row.name)}
				class="font-mono text-sm font-medium underline-offset-4 hover:underline"
			>
				{row.name}
			</a>
			{#if row.projectSlug}
				<p class="text-xs text-muted-foreground">
					project <span class="font-mono">{row.projectSlug}</span>
				</p>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet lastCell(row: Row)}
	{#if row.lastPushAt}
		<p class="font-mono text-xs">
			{row.lastTag ?? '—'}
			<span class="text-muted-foreground">· {row.lastDigest?.slice(7, 19)}</span>
		</p>
		<p class="text-xs text-muted-foreground">{formatRelative(row.lastPushAt)}</p>
	{:else}
		<span class="text-xs text-muted-foreground">Not pushed yet</span>
	{/if}
{/snippet}

{#snippet pushesCell(row: Row)}
	{row.pushes}
{/snippet}

{#snippet sizeCell(row: Row)}
	{row.bytes > 0 ? formatBytes(row.bytes) : '—'}
{/snippet}

{#snippet deployCell(row: Row)}
	{#if row.deploy?.project}
		<Badge variant="secondary" class="font-mono font-normal">
			<RocketIcon />:{row.deploy.tag} → {row.deploy.project}
		</Badge>
	{:else}
		<span class="text-xs text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet actionsCell(row: Row)}
	<div class="flex justify-end gap-1">
		<CopyButton
			value="{host}/{row.name}:{row.lastTag ?? 'latest'}"
			label="Copy pull reference"
			iconOnly
			size="icon-sm"
			variant="ghost"
		/>
	</div>
{/snippet}

{#if !data.denied && data.registry.enabled && data.canEditTrusts}
	<FormDialog
		bind:open={trustOpen}
		icon={GitHubMark}
		title="Trust a CI repository"
		description="{trustProvider === 'gitlab'
			? 'Its CI jobs log in as gitlab-oidc with an id_token'
			: 'Its workflows log in as github-oidc with an OIDC token'} for audience {data.registry.host}. No secret is stored."
		action="?/addTrust"
		submitLabel="Add trust"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="trust-provider">CI</Field.Label>
				<NativeSelect.Root id="trust-provider" name="provider" bind:value={trustProvider} class="w-full">
					<NativeSelect.Option value="github">GitHub Actions</NativeSelect.Option>
					<NativeSelect.Option value="gitlab">GitLab CI</NativeSelect.Option>
				</NativeSelect.Root>
			</Field.Field>
			<GitRepoPicker
				hint={false}
				providers={[trustProvider]}
				selected={trustRepo}
				onpick={(repo) => (trustRepo = repo.fullName)}
			/>
			<div class="grid gap-4 sm:grid-cols-2">
				{#if trustProvider === 'gitlab'}
					<Field.Field class="sm:col-span-2">
						<Field.Label for="trust-issuer">GitLab instance</Field.Label>
						<Input id="trust-issuer" name="issuer" placeholder="https://gitlab.com" autocapitalize="off" spellcheck="false" class="font-mono text-sm" />
						<Field.Description>The issuer of the ID tokens; blank means gitlab.com.</Field.Description>
					</Field.Field>
				{/if}
				<Field.Field>
					<Field.Label for="trust-github">{trustProvider === 'gitlab' ? 'GitLab project path' : 'GitHub repository'}</Field.Label>
					<Input
						id="trust-github"
						name="subject"
						bind:value={trustRepo}
						placeholder={trustProvider === 'gitlab' ? 'group/project' : 'owner/repo'}
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="trust-repository">Registry repository</Field.Label>
					<Input
						id="trust-repository"
						name="repository"
						placeholder="{orgSlug}/*"
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description
						>{orgSlug}/&lt;name&gt;, or {orgSlug}/* for every repository.</Field.Description
					>
				</Field.Field>
				<Field.Field class="sm:col-span-2">
					<Field.Label for="trust-ref">Ref (optional)</Field.Label>
					<Input
						id="trust-ref"
						name="ref"
						placeholder="refs/heads/main"
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description
						>A glob on the token's ref, e.g. refs/tags/*. Empty allows any branch or tag.</Field.Description
					>
				</Field.Field>
			</div>
			<Field.Field orientation="horizontal">
				<Checkbox id="trust-push" name="push" checked={true} />
				<Field.Content>
					<Field.Label for="trust-push">Allow push</Field.Label>
					<Field.Description>Off: pull only.</Field.Description>
				</Field.Content>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
