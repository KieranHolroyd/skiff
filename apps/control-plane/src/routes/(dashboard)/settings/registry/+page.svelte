<script lang="ts">
	import { resolve } from '$app/paths';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PackageIcon from '@lucide/svelte/icons/package';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import ServerIcon from '@lucide/svelte/icons/server';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import type { RegistryCredentialView } from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import type { PageProps } from './$types';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { REGISTRY_MIRROR_UPSTREAMS } from '@yoal/contracts';

	let { data }: PageProps = $props();

	const COSIGN_PLACEHOLDER = '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----';

	let addOpen = $state(false);
	let registryOpen = $state(false);
	let editOpen = $state(false);
	let editing = $state<RegistryCredentialView | null>(null);
	let s3Mode = $state<'disk' | 'managed' | 'external'>(data.registry.s3?.mode ?? 'disk');
	function edit(credential: RegistryCredentialView) {
		editing = credential;
		editOpen = true;
	}

	function remove(credential: RegistryCredentialView) {
		askConfirm({
			title: `Delete ${credential.name}?`,
			description: `Nodes stop authenticating to ${credential.registry}. Running containers keep the image they already pulled, but a private image from ${credential.registry} will fail to pull on its next deploy or move.`,
			confirmLabel: 'Delete credential',
			tone: 'danger',
			action: '?/remove',
			fields: { name: credential.name }
		});
	}
</script>

<svelte:head><title>Container registries · Settings · Yoal</title></svelte:head>

<SettingsHeader id="registry" />

<div class="space-y-6">
	<Panel
		title="Platform registry"
		icon={ServerIcon}
		description="An OCI registry Yoal runs for this install. Push with your Yoal API key; deploys pin the digest."
	>
		{#snippet actions()}
			{#if data.canAdminister}
				<Button size="sm" variant="outline" onclick={() => (registryOpen = true)}>
					<PencilIcon />{data.registry.enabled ? 'Change' : 'Turn on'}
				</Button>
			{/if}
		{/snippet}

		{#if data.registry.enabled}
			<DetailList>
				<dt>Host</dt>
				<dd class="font-mono text-xs">{data.registry.host}</dd>
				<dt>Status</dt>
				<dd><StatusBadge status={data.registry.status} /></dd>
				<dt>Node</dt>
				<dd class="font-mono text-xs">{data.registry.node?.name ?? '—'}</dd>
				<dt>Engine</dt>
				<dd class="font-mono text-xs">{data.registry.engine} {data.registry.version}</dd>
				<dt>Retention</dt>
				<dd class="text-sm">
					newest {data.registry.keepTags} tags per repository, plus every deployed digest.
					<a
						href={resolve('/(dashboard)/settings/maintenance')}
						class="underline underline-offset-4">Prune old tags</a
					>
				</dd>
				<dt>Mirrors</dt>
				<dd class="font-mono text-xs">
					{data.registry.mirrors.length > 0 ? data.registry.mirrors.join(', ') : '—'}
				</dd>
				<dt>Signatures</dt>
				<dd class="text-sm">
					{data.registry.signatures}
					<span class="text-muted-foreground">
						· {data.registry.cosignKeys} cosign {data.registry.cosignKeys === 1
							? 'key'
							: 'keys'}{data.registry.cosignKeysPending ? ' · uploading…' : ''}
					</span>
				</dd>
				<dt>CVE scanning</dt>
				<dd class="text-sm">{data.registry.cveScanning ? 'On (Trivy)' : 'Off'}</dd>
				<dt>Storage</dt>
				<dd class="font-mono text-xs">
					{data.registry.s3
						? data.registry.s3.mode === 'managed'
							? `Yoal storage ${data.registry.s3.storage?.name ?? '…'} · bucket ${data.registry.s3.bucket}`
							: `s3 ${data.registry.s3.bucket}@${data.registry.s3.endpoint}`
						: "node's disk"}
				</dd>
			</DetailList>
			<div
				class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/50 p-3 text-sm"
			>
				<span class="text-muted-foreground"
					>Repositories, tags, deploy on push and GitHub Actions logins are on the Registry page.</span
				>
				<Button size="sm" variant="outline" href={resolve('/(dashboard)/registry')}>
					<PackageIcon />Open the registry
				</Button>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">
				Off. {data.canAdminister
					? 'Turn it on and choose the node that stores images (prefer one with a large disk).'
					: 'A platform admin can turn it on.'}
			</p>
		{/if}
	</Panel>

	<Panel
		title="Registry credentials"
		icon={PackageIcon}
		count={data.credentials.length}
		description="One login per registry host. Deploys use it to pin an image's tag to its digest, and nodes use it to pull."
		flush
	>
		{#snippet actions()}
			{#if data.canEdit && data.credentials.length > 0}
				<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add credential</Button>
			{/if}
		{/snippet}

		{#if data.credentials.length === 0}
			<div class="p-4">
				<EmptyState
					icon={PackageIcon}
					compact
					title="Public images only"
					description="Containers can pull public images from any registry. Add a credential to pull private images from GHCR, Docker Hub or your own registry."
				>
					{#if data.canEdit}
						<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add a credential</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Credential</Table.Head>
						<Table.Head>Registry</Table.Head>
						<Table.Head class="hidden md:table-cell">Last used</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.credentials as credential (credential.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-3">
									<span
										class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									>
										<KeyRoundIcon class="size-4" />
									</span>
									<div class="min-w-0 space-y-0.5">
										<p class="font-mono text-sm font-medium">{credential.name}</p>
										<p class="text-xs text-muted-foreground">{credential.username}</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell><span class="font-mono text-xs">{credential.registry}</span></Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
								{credential.lastUsedAt ? formatDateTime(credential.lastUsedAt) : 'Never'}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canEdit}
									<div class="flex justify-end">
										<RowMenu label="Actions for {credential.name}">
											<DropdownMenu.Item onSelect={() => edit(credential)}>
												<PencilIcon />Change login
											</DropdownMenu.Item>
											<DropdownMenu.Item variant="destructive" onSelect={() => remove(credential)}>
												<TrashIcon />Delete credential
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
				Passwords and tokens are sealed with the organisation key and never shown again. They reach
				a node only when it pulls, as a root-only auth file beside the container.
			</span>
		{/snippet}
	</Panel>
</div>

{#if data.canAdminister}
	<FormDialog
		bind:open={registryOpen}
		icon={ServerIcon}
		title="Platform registry"
		description="zot runs on the chosen node; its host must point at your ingress (DNS-only: proxied uploads are size-capped)."
		action="?/registry"
		submitLabel="Save"
	>
		<Field.Group>
			<Field.Field orientation="horizontal">
				<Checkbox id="registry-enabled" name="enabled" checked={data.registry.enabled} />
				<Field.Content>
					<Field.Label for="registry-enabled">Run the registry</Field.Label>
					<Field.Description
						>Turning it off stops zot; its data stays on the node.</Field.Description
					>
				</Field.Content>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="registry-node">Node</Field.Label>
					<NativeSelect.Root id="registry-node" name="node" value={data.registry.node?.id ?? ''}>
						<NativeSelect.Option value="">Choose a node</NativeSelect.Option>
						{#each data.nodes as node (node.id)}
							<NativeSelect.Option value={node.id}>{node.name} ({node.status})</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="registry-keep">Tags kept per repository</Field.Label>
					<Input
						id="registry-keep"
						name="keepTags"
						type="number"
						min={1}
						max={1000}
						value={data.registry.keepTags}
					/>
					<p class="text-xs text-muted-foreground">
						zot's own retention keeps these. A prune in Settings → Maintenance can also remove older
						tags beyond them; deployment pins and images a workload still uses are always kept.
					</p>
				</Field.Field>
				<Field.Field class="sm:col-span-2">
					<Field.Label for="registry-host">Host</Field.Label>
					<Input
						id="registry-host"
						name="host"
						value={data.registry.host}
						spellcheck="false"
						autocapitalize="off"
						class="font-mono text-sm"
					/>
					<Field.Description
						>Defaults to registry.&lt;content domain&gt;, covered by its wildcard certificate.</Field.Description
					>
				</Field.Field>
			</div>
			<Field.Set>
				<Field.Legend variant="label">Pull-through mirrors</Field.Legend>
				<Field.Description
					>Nodes pull these upstreams through the registry, cached under
					&lt;host&gt;/&lt;upstream&gt;/….</Field.Description
				>
				<div class="flex flex-wrap gap-4">
					{#each REGISTRY_MIRROR_UPSTREAMS as upstream (upstream)}
						<Field.Field orientation="horizontal" class="w-auto">
							<Checkbox
								id="registry-mirror-{upstream}"
								name="mirrors"
								value={upstream}
								checked={data.registry.mirrors.includes(upstream)}
							/>
							<Field.Label for="registry-mirror-{upstream}" class="font-mono text-xs"
								>{upstream}</Field.Label
							>
						</Field.Field>
					{/each}
				</div>
			</Field.Set>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="registry-signatures">Signature policy</Field.Label>
					<NativeSelect.Root
						id="registry-signatures"
						name="signatures"
						value={data.registry.signatures}
					>
						<NativeSelect.Option value="off">Off</NativeSelect.Option>
						<NativeSelect.Option value="warn">Warn on unsigned images</NativeSelect.Option>
						<NativeSelect.Option value="enforce">Refuse unsigned images</NativeSelect.Option>
					</NativeSelect.Root>
					<Field.Description
						>Checked when a deploy uses an image from this registry.</Field.Description
					>
				</Field.Field>
				<Field.Field orientation="horizontal" class="self-start sm:pt-6">
					<Checkbox id="registry-cve" name="cveScanning" checked={data.registry.cveScanning} />
					<Field.Content>
						<Field.Label for="registry-cve">Scan for CVEs</Field.Label>
						<Field.Description>Trivy; needs the node's disk, not S3.</Field.Description>
					</Field.Content>
				</Field.Field>
				<Field.Field class="sm:col-span-2">
					<Field.Label for="registry-cosign">Cosign public keys</Field.Label>
					<Textarea
						id="registry-cosign"
						name="cosignKeys"
						rows={4}
						spellcheck="false"
						placeholder={COSIGN_PLACEHOLDER}
						class="font-mono text-xs"
					/>
					<Field.Description>
						{data.registry.cosignKeys} trusted now. Paste cosign.pub keys separated by a blank line to
						replace them; leave empty to keep them.
					</Field.Description>
				</Field.Field>
			</div>
			<Field.Set>
				<Field.Legend variant="label">Storage</Field.Legend>
				<Field.Description>
					{#if data.registry.s3}
						{data.registry.s3.mode === 'managed'
							? `Blobs are in bucket ${data.registry.s3.bucket} on ${data.registry.s3.storage?.name ?? 'a Yoal storage instance'}.`
							: `Blobs are in s3 ${data.registry.s3.bucket}@${data.registry.s3.endpoint}.`}
					{:else}
						Blobs are on the node's disk.
					{/if}
					Existing data is not migrated either way.
				</Field.Description>
				<Field.Field>
					<Field.Label for="registry-s3-mode">Where blobs live</Field.Label>
					<NativeSelect.Root id="registry-s3-mode" name="s3Mode" bind:value={s3Mode}>
						<NativeSelect.Option value="disk">The node's disk</NativeSelect.Option>
						<NativeSelect.Option value="managed"
							>Yoal object storage (automatic)</NativeSelect.Option
						>
						<NativeSelect.Option value="external">Another S3 endpoint</NativeSelect.Option>
					</NativeSelect.Root>
					<Field.Description>
						Yoal object storage creates a RustFS instance on the registry node when needed, a
						bucket, and a key that can reach only that bucket.
					</Field.Description>
				</Field.Field>
				{#if s3Mode === 'managed'}
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field>
							<Field.Label for="registry-s3-storage">Storage instance</Field.Label>
							<NativeSelect.Root
								id="registry-s3-storage"
								name="s3Storage"
								value={data.registry.s3?.storage?.id ?? ''}
							>
								<NativeSelect.Option value="">Create a dedicated one</NativeSelect.Option>
								{#each data.storage as instance (instance.id)}
									<NativeSelect.Option value={instance.id}>
										{instance.name}{instance.nodeName ? ` (${instance.nodeName})` : ''}
									</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							<Field.Description
								>A private instance must run on the registry node; Yoal creates the bucket and key.</Field.Description
							>
						</Field.Field>
						<Field.Field>
							<Field.Label for="registry-s3-managed-bucket">Bucket</Field.Label>
							<Input
								id="registry-s3-managed-bucket"
								name="s3Bucket"
								value={data.registry.s3?.mode === 'managed' ? data.registry.s3.bucket : 'registry'}
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
							<Field.Description
								>Created if it does not exist. Path-style, private.</Field.Description
							>
						</Field.Field>
					</div>
				{:else if s3Mode === 'external'}
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field class="sm:col-span-2">
							<Field.Label for="registry-s3-endpoint">S3 endpoint</Field.Label>
							<Input
								id="registry-s3-endpoint"
								name="s3Endpoint"
								type="url"
								placeholder="https://s3.example.com"
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="registry-s3-bucket">Bucket</Field.Label>
							<Input
								id="registry-s3-bucket"
								name="s3Bucket"
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="registry-s3-region">Region</Field.Label>
							<Input
								id="registry-s3-region"
								name="s3Region"
								placeholder="us-east-1"
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="registry-s3-key">Access key ID</Field.Label>
							<Input
								id="registry-s3-key"
								name="s3AccessKeyId"
								autocomplete="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="registry-s3-secret">Secret access key</Field.Label>
							<Input
								id="registry-s3-secret"
								name="s3SecretAccessKey"
								type="password"
								autocomplete="new-password"
								class="font-mono text-sm"
							/>
						</Field.Field>
						<Field.Field class="sm:col-span-2">
							<Field.Label for="registry-s3-cache">Cache URL</Field.Label>
							<Input
								id="registry-s3-cache"
								name="s3CacheUrl"
								placeholder="redis://:password@valkey.internal:6379"
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
							/>
							<Field.Description
								>Optional. Omit for a single replica (zot keeps its dedupe cache on the node); a
								redis:// URL is only needed when several replicas share the bucket.</Field.Description
							>
						</Field.Field>
					</div>
				{:else}
					<Field.Description>
						Existing bucket data is left in place. Switch back to keep serving the same images.
					</Field.Description>
				{/if}
			</Field.Set>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.canEdit}
	<FormDialog
		bind:open={addOpen}
		icon={PackageIcon}
		title="Add a registry credential"
		description="Use a read-only token where the registry offers one: a GitHub token with read:packages, a Docker Hub access token."
		action="?/add"
		submitLabel="Save credential"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="credential-name">Name</Field.Label>
					<Input
						id="credential-name"
						name="name"
						placeholder="ghcr"
						required
						minlength={3}
						maxlength={40}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="credential-registry">Registry host</Field.Label>
					<Input
						id="credential-registry"
						name="registry"
						placeholder="ghcr.io"
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description>Use docker.io for Docker Hub.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="credential-username">Username</Field.Label>
					<Input
						id="credential-username"
						name="username"
						required
						autocomplete="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="credential-password">Password or token</Field.Label>
					<Input
						id="credential-password"
						name="password"
						type="password"
						required
						autocomplete="new-password"
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={editOpen}
		icon={KeyRoundIcon}
		title="Change {editing?.name ?? 'credential'}"
		description="Leave a field blank to keep it. The next pull from {editing?.registry ??
			'the registry'} uses the new login."
		action="?/update"
		submitLabel="Save changes"
	>
		<input type="hidden" name="name" value={editing?.name ?? ''} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="edit-username">Username</Field.Label>
					<Input
						id="edit-username"
						name="username"
						placeholder={editing?.username ?? ''}
						autocomplete="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="edit-password">New password or token</Field.Label>
					<Input
						id="edit-password"
						name="password"
						type="password"
						autocomplete="new-password"
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>
{/if}
