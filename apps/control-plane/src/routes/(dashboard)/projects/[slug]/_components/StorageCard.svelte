<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { nextEnvPrefix, storageEnvNames, type StorageAttachmentView } from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import EnvNames from '../../../_lib/service/EnvNames.svelte';
	import GrantsFields from '../../../storage/_lib/GrantsFields.svelte';

	interface AttachableStorage {
		name: string;
		engineLabel: string;
		version: string;
		nodeName: string;
		public: boolean;
		/** Ready (grantable) bucket names. */
		buckets: string[];
	}

	/** Managed object storage attached to a process/container project (S4). */
	let {
		slug,
		attachments,
		instances,
		bucketsByStorage,
		warning = null,
		fieldErrors = {},
		can
	}: {
		slug: string;
		attachments: StorageAttachmentView[];
		/** Instances this project could attach (not attached yet). */
		instances: AttachableStorage[];
		/** Grantable bucket names per attached instance, for editing grants. */
		bucketsByStorage: Record<string, string[]>;
		/** `warning` from the last attach (e.g. the app runs on another node). */
		warning?: string | null;
		fieldErrors?: Record<string, string>;
		can: { readStorage: boolean; createStorage: boolean; attachStorage: boolean };
	} = $props();

	let attachOpen = $state(false);
	let prefix = $state('S3');
	let selected = $state('');
	let grantsOpen = $state(false);
	let editing = $state<StorageAttachmentView | null>(null);

	const chosen = $derived(instances.find((item) => item.name === selected) ?? instances[0] ?? null);
	const createHref = $derived(
		`${resolve('/(dashboard)/storage')}?project=${encodeURIComponent(slug)}`
	);

	function openAttach() {
		prefix = nextEnvPrefix(
			'S3',
			attachments.map((item) => item.envPrefix)
		);
		selected = instances[0]?.name ?? '';
		attachOpen = true;
	}

	function editGrants(item: StorageAttachmentView) {
		editing = item;
		grantsOpen = true;
	}

	function detach(item: StorageAttachmentView) {
		askConfirm({
			title: `Detach ${item.storageName}?`,
			description: `${slug} restarts without ${item.envPrefix}_ENDPOINT_URL and the other ${item.envPrefix}_* variables, and its access key is deleted. Buckets and objects are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detachStorage',
			fields: { storage: item.storageName }
		});
	}
</script>

{#if can.readStorage}
	<Panel
		title="Object storage"
		icon={CylinderIcon}
		count={attachments.length}
		description="An S3 endpoint and a key scoped to the granted buckets are injected as env vars when the app starts. Private storage keeps the app on its node."
		flush
	>
		{#snippet actions()}
			{#if can.attachStorage && instances.length > 0}
				<Button size="sm" variant="outline" onclick={openAttach}><PlugIcon />Attach</Button>
			{/if}
			{#if can.createStorage && can.attachStorage}
				<Button size="sm" href={createHref}><PlusIcon />New storage</Button>
			{/if}
		{/snippet}

		{#if warning}
			<div class="px-4 pt-4"><Notice tone="warning">{warning}</Notice></div>
		{/if}

		{#if attachments.length === 0}
			<div class="p-4">
				<EmptyState
					icon={CylinderIcon}
					compact
					title="No storage attached"
					description="Attach an S3-compatible storage instance and this app receives S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and friends at start-up."
				>
					{#if can.attachStorage && instances.length > 0}
						<Button size="sm" onclick={openAttach}><PlugIcon />Attach storage</Button>
					{:else if can.createStorage && can.attachStorage}
						<Button size="sm" variant="outline" href={createHref}>
							<PlusIcon />Create storage
						</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<ul class="divide-y">
				{#each attachments as item (item.storageId)}
					{@const href = resolve('/(dashboard)/storage/[name]', { name: item.storageName })}
					<li class="flex items-start gap-3 px-4 py-3">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							aria-hidden="true"
						>
							<CylinderIcon class="size-4" />
						</span>
						<div class="min-w-0 flex-1 space-y-1.5">
							<div>
								<a {href} class="font-mono text-sm font-medium underline-offset-4 hover:underline">
									{item.storageName}
								</a>
								<p class="truncate text-xs text-muted-foreground">
									Injected as <span class="font-mono">{item.envPrefix}_*</span> · key
									<span class="font-mono">{item.accessKeyId}</span>
								</p>
							</div>
							<div class="flex flex-wrap items-center gap-1">
								<span class="mr-0.5 text-xs text-muted-foreground">Buckets</span>
								{#each item.grants as grant (grant.bucket)}
									<Badge
										variant={grant.mode === 'read-write' ? 'secondary' : 'outline'}
										class="font-mono font-normal"
										title={grant.mode}
									>
										{grant.bucket}<span class="text-muted-foreground"
											>{grant.mode === 'read-write' ? 'rw' : 'r'}</span
										>
									</Badge>
								{:else}
									<span class="text-xs text-muted-foreground">none granted</span>
								{/each}
							</div>
							<EnvNames names={item.envNames} />
						</div>
						<RowMenu label="Actions for {item.storageName}">
							<DropdownMenu.Item onSelect={() => goto(href)}>
								<ArrowUpRightIcon />Open storage
							</DropdownMenu.Item>
							{#if can.attachStorage}
								<DropdownMenu.Item onSelect={() => editGrants(item)}>
									<PencilIcon />Edit bucket grants…
								</DropdownMenu.Item>
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onSelect={() => detach(item)}>
									<UnplugIcon />Detach
								</DropdownMenu.Item>
							{/if}
						</RowMenu>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	{#if can.attachStorage && instances.length > 0}
		<FormDialog
			bind:open={attachOpen}
			icon={PlugIcon}
			title="Attach storage"
			description="The app restarts with an endpoint and its own key. Private storage places the app's next deploy on the storage node; public storage works from anywhere."
			action="?/attachStorage"
			submitLabel="Attach"
			size="lg"
		>
			<Field.Group>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={fieldErrors.storage ? true : undefined}>
						<Field.Label for="attach-storage">Storage</Field.Label>
						<NativeSelect.Root
							id="attach-storage"
							name="storage"
							bind:value={selected}
							class="w-full"
							required
						>
							{#each instances as instance (instance.name)}
								<NativeSelect.Option value={instance.name}>
									{instance.name} · {instance.public ? 'public' : 'private'} · {instance.nodeName}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						{#if fieldErrors.storage}<Field.Error>{fieldErrors.storage}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={fieldErrors.envPrefix ? true : undefined}>
						<Field.Label for="attach-storage-prefix">Env prefix</Field.Label>
						<Input
							id="attach-storage-prefix"
							name="envPrefix"
							bind:value={prefix}
							maxlength={64}
							autocapitalize="characters"
							spellcheck="false"
							class="font-mono text-sm uppercase"
							aria-invalid={fieldErrors.envPrefix ? 'true' : undefined}
						/>
						<Field.Description>
							<code class="font-mono">AWS</code> gives the AWS SDKs' own variable names (it would shadow
							real AWS credentials).
						</Field.Description>
						{#if fieldErrors.envPrefix}<Field.Error>{fieldErrors.envPrefix}</Field.Error>{/if}
					</Field.Field>
				</div>
				{#if chosen}
					<p class="font-mono text-xs text-muted-foreground">
						{storageEnvNames((prefix || 'S3').toUpperCase(), {
							public: chosen.public,
							singleBucket: false
						}).join(' ')}
					</p>
					{#key chosen.name}
						<GrantsFields
							buckets={chosen.buckets}
							defaultMode="read-write"
							error={fieldErrors.grants}
							idPrefix="attach-storage-grant"
						/>
					{/key}
				{/if}
			</Field.Group>
		</FormDialog>
	{/if}

	{#if can.attachStorage && attachments.length > 0}
		<FormDialog
			bind:open={grantsOpen}
			icon={KeyRoundIcon}
			title="Grants on {editing?.storageName ?? ''}"
			description="Changes the policy on this project's key ({editing?.accessKeyId ??
				''}). The app restarts with the new grants."
			action="?/updateStorageGrants"
			submitLabel="Save grants"
		>
			<input type="hidden" name="storage" value={editing?.storageName ?? ''} />
			{#key editing?.storageId}
				<GrantsFields
					buckets={editing ? (bucketsByStorage[editing.storageName] ?? []) : []}
					grants={editing?.grants ?? []}
					error={fieldErrors.grants}
					idPrefix="edit-storage-grant"
				/>
			{/key}
		</FormDialog>
	{/if}
{/if}
