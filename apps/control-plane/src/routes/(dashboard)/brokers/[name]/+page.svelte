<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import CableIcon from '@lucide/svelte/icons/cable';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { brokerEnvNames, type BrokerCredentials } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import EnvNames from '../../_lib/service/EnvNames.svelte';
	import { readTab, tabHref } from '../../_lib/service/sections.js';
	import { formatDate } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import BrokerHeader from '../_lib/BrokerHeader.svelte';
	import { BROKER_DEFAULT_TAB, BROKER_TABS, type BrokerTab } from '../_lib/broker-tabs.js';
	import type { PageProps } from './$types';

	interface BrokerFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as BrokerFormResult | null)?.fieldErrors ?? {});

	const broker = $derived(data.broker);
	const can = $derived(data.brokerCan);
	const deleted = $derived(broker.deletedAt !== null);
	const nodeLabel = $derived(broker.nodeName ?? broker.nodeId);
	const hostPort = $derived(broker.internalHost.process.split(':').at(-1) ?? '');

	let tab = $state<BrokerTab>(readTab(page.url.searchParams.get('tab'), BROKER_TABS, BROKER_DEFAULT_TAB));

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: BrokerTab) {
		tab = next;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, next, BROKER_DEFAULT_TAB), {});
	}

	// --- credentials: revealed on demand, audited, never in page data (as D58) ------------------

	let credentials = $state<BrokerCredentials | null>(null);
	let revealing = $state(false);

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success')
			credentials = (outcome.data as { credentials?: BrokerCredentials } | undefined)?.credentials ?? null;
	}

	// --- attachments -----------------------------------------------------------------------------

	let attachOpen = $state(false);
	let attachPrefix = $state('NATS');

	function detach(project: string) {
		askConfirm({
			title: `Detach ${broker.name} from ${project}?`,
			description:
				'The app restarts without its broker variables. The broker, its streams and stored messages are untouched.',
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detach',
			fields: { project }
		});
	}

	// --- settings --------------------------------------------------------------------------------

	let resizeOpen = $state(false);
</script>

<svelte:head>
	<title>{broker.name} · Queues · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<BrokerHeader {broker} {can} active={tab} onselect={setTab} />

	{#if page.url.searchParams.get('created') === '1' && broker.status === 'pending'}
		<Notice tone="info" title="Starting on {nodeLabel}">
			The node pulls the {broker.engineLabel} image and starts the container on its next reconcile. This
			page shows <em>running</em> once the server answers.
		</Notice>
	{/if}
	{#if broker.message && !deleted}
		<Notice tone="warning" title="Broker message">{broker.message}</Notice>
	{/if}
	{#if deleted}
		<Notice tone="warning" title="In the trash">
			The container is stopped; its streams stay on {nodeLabel} until
			<time datetime={broker.purgeAt}>{purgeCountdown(broker.purgeAt)}</time>. Restore it from the header.
		</Notice>
	{/if}

	{#if tab === 'overview'}
		<div class="grid items-start gap-5 xl:grid-cols-5">
			<Panel
				title="Connection"
				icon={CableIcon}
				description="Attached apps receive these as environment variables at start-up."
				class="xl:col-span-3"
			>
				{#snippet actions()}
					{#if can.credentials && !deleted}
						{#if credentials}
							<Button variant="outline" size="sm" onclick={() => (credentials = null)}>
								<EyeOffIcon />Hide credentials
							</Button>
						{:else}
							<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
								{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
								Reveal credentials
							</Button>
						{/if}
					{/if}
				{/snippet}

				<DetailList>
					<dt>Protocol</dt>
					<dd class="text-xs">{broker.protocol}</dd>
					<dt>Process apps</dt>
					<dd><CopyValue value={broker.internalHost.process} label="host" /></dd>
					<dt>Container apps</dt>
					<dd><CopyValue value={broker.internalHost.container} label="host" /></dd>
					<dt>User</dt>
					<dd><CopyValue value={broker.username} label="user" /></dd>
					{#if credentials}
						<dt>URL</dt>
						<dd>
							<CopyValue
								value={credentials.url}
								label="URL"
								secret
								display={credentials.url.replace(`:${encodeURIComponent(credentials.password)}@`, ':••••••@')}
							/>
						</dd>
						<dt>Password</dt>
						<dd><CopyValue value={credentials.password} label="password" secret /></dd>
					{/if}
				</DetailList>

				{#if credentials}
					<div class="mt-4 space-y-3">
						{#each Object.entries(credentials.connectionSnippets) as [client, snippet] (client)}
							<CodeBlock code={snippet} label={client} />
						{/each}
						<p class="text-xs text-muted-foreground">This reveal was recorded in the audit log.</p>
					</div>
				{/if}

				<div class="mt-4 space-y-2 rounded-lg border bg-muted/30 p-3">
					<p class="text-xs text-muted-foreground">
						An attached app receives these, with its prefix (default <code class="font-mono">NATS</code>):
					</p>
					<div class="flex flex-wrap gap-1.5">
						{#each brokerEnvNames('NATS') as name (name)}
							<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
						{/each}
					</div>
				</div>

				{#snippet footer()}
					<span class="flex items-start gap-2">
						<TerminalIcon class="mt-0.5 size-3.5 shrink-0" />
						<span>
							Private to {nodeLabel}: from elsewhere, tunnel with
							<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>.
							{#if !can.credentials}
								Revealing the password needs <code class="font-mono">broker:credentials</code>.
							{/if}
						</span>
					</span>
				{/snippet}
			</Panel>

			<Panel title="Resources" icon={SlidersHorizontalIcon} class="xl:col-span-2">
				{#snippet actions()}
					{#if can.update && !deleted}
						<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>Resize</Button>
					{/if}
				{/snippet}
				<DetailList>
					<dt>Engine</dt>
					<dd class="text-xs">{broker.engineLabel} {broker.version}</dd>
					<dt>Memory</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.memoryMb} MB</dd>
					<dt>CPU</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.cpus} vCPU</dd>
					<dt>Message store</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.storageMb} MB cap</dd>
					<dt>Data</dt>
					<dd class="text-xs">{broker.volume ? `Volume ${broker.volume.name}` : 'Node state directory'}</dd>
					<dt>Features</dt>
					<dd class="flex flex-wrap justify-end gap-1">
						{#if broker.capabilities.streams}<Badge variant="outline">Streams</Badge>{/if}
						{#if broker.capabilities.workQueues}<Badge variant="outline">Work queues</Badge>{/if}
						{#if broker.capabilities.keyValue}<Badge variant="outline">Key-value</Badge>{/if}
						{#if broker.capabilities.requestReply}<Badge variant="outline">Request/reply</Badge>{/if}
					</dd>
				</DetailList>
			</Panel>
		</div>

		<Panel
			title="Attached projects"
			icon={PlugIcon}
			count={broker.attachments.length}
			description="Each attached project runs on {nodeLabel} and gets the broker's URL and credentials at start-up."
			flush
		>
			{#snippet actions()}
				{#if can.attach && !deleted && data.projects.length > 0}
					<Button variant="outline" size="sm" onclick={() => (attachOpen = true)}><PlugIcon />Attach</Button>
				{/if}
			{/snippet}
			{#if broker.attachments.length === 0}
				<EmptyState
					icon={PlugIcon}
					title="Not attached"
					description="Attach a process or container project; it is placed next to this broker on its next deploy."
				/>
			{:else}
				<ul class="divide-y">
					{#each broker.attachments as attachment (attachment.projectId)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div class="flex min-w-0 items-center gap-3">
								<FolderKanbanIcon class="size-4 text-muted-foreground" />
								<a
									href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
									class="font-mono text-sm font-medium underline-offset-4 hover:underline"
									>{attachment.projectSlug}</a
								>
								<EnvNames names={attachment.envNames} />
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground">since {formatDate(attachment.createdAt)}</span>
								{#if can.attach}
									<Button variant="ghost" size="sm" onclick={() => detach(attachment.projectSlug)}>
										<UnplugIcon />Detach
									</Button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:else if tab === 'settings'}
		<Panel title="Version" icon={SlidersHorizontalIcon}>
			<p class="text-sm text-muted-foreground">
				{broker.engineLabel} {broker.version}.
				{#if broker.upgradeVersions.length > 0}
					A newer version is available ({broker.upgradeVersions.join(', ')}); upgrading restarts the broker in
					place and keeps its streams. Downgrades are refused.
				{:else}
					This is the newest version Skiff ships for {broker.engineLabel}.
				{/if}
			</p>
			{#if can.update && !deleted && broker.upgradeVersions.length > 0}
				<form method="POST" action="?/update" class="mt-3 flex flex-wrap items-end gap-2">
					<NativeSelect.Root name="version" value={broker.upgradeVersions[0]} aria-label="Target version">
						{#each broker.upgradeVersions as version (version)}
							<NativeSelect.Option value={version}>{broker.engineLabel} {version}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Button type="submit" size="sm" variant="outline">Upgrade</Button>
				</form>
			{/if}
		</Panel>

		{#if can.delete && !deleted}
			<DangerZone>
				{#snippet description()}
					Delete moves the broker to the trash for {page.data.policies?.trashDays ?? 7} days; its streams stay
					on {nodeLabel} so a restore is lossless. Detach every project first.
				{/snippet}
				<Button
					variant="destructive"
					size="sm"
					onclick={() =>
						askConfirm({
							title: `Delete ${broker.name}?`,
							description:
								broker.attachments.length > 0
									? `It is attached to ${broker.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`
									: 'The container stops and the broker moves to the trash.',
							confirmLabel: 'Move to trash',
							tone: 'danger',
							typeToConfirm: broker.name,
							action: '?/delete'
						})}
				>
					<TrashIcon />Delete broker
				</Button>
			</DangerZone>
		{/if}
	{/if}
</div>

{#if can.attach && !deleted}
	<FormDialog
		bind:open={attachOpen}
		icon={PlugIcon}
		title="Attach {broker.name}"
		description="The project's next start gets {attachPrefix || 'NATS'}_URL and credentials. It must run on {nodeLabel}; auto placement moves it there on its next deploy."
		action="?/attach"
		submitLabel="Attach"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.project ? true : undefined}>
				<Field.Label for="attach-project">Project</Field.Label>
				<NativeSelect.Root id="attach-project" name="project" class="w-full" required>
					{#each data.projects as project (project.slug)}
						<NativeSelect.Option value={project.slug}>{project.name} ({project.runtime})</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.envPrefix ? true : undefined}>
				<Field.Label for="attach-prefix">Env prefix</Field.Label>
				<Input
					id="attach-prefix"
					name="envPrefix"
					bind:value={attachPrefix}
					maxlength={64}
					autocapitalize="characters"
					spellcheck="false"
					class="font-mono text-sm uppercase"
					aria-invalid={errors.envPrefix ? 'true' : undefined}
				/>
				{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
			</Field.Field>
			<p class="font-mono text-xs text-muted-foreground">
				{brokerEnvNames((attachPrefix || 'NATS').toUpperCase()).join(' ')}
			</p>
		</Field.Group>
	</FormDialog>
{/if}

{#if can.update && !deleted}
	<FormDialog
		bind:open={resizeOpen}
		icon={SlidersHorizontalIcon}
		title="Resize {broker.name}"
		description="More memory is admitted against {nodeLabel}'s workload slice. The broker restarts with the new limits; streams are kept."
		action="?/update"
		submitLabel="Save resources"
	>
		<div class="grid gap-4 sm:grid-cols-3">
			<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
				<Field.Label for="resize-memory">Memory</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-memory"
						name="memoryMb"
						type="number"
						min={64}
						max={16384}
						value={String(broker.memoryMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"><InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text></InputGroup.Addon>
				</InputGroup.Root>
				{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.cpus ? true : undefined}>
				<Field.Label for="resize-cpus">CPUs</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-cpus"
						name="cpus"
						type="number"
						min={0.1}
						max={8}
						step={0.1}
						value={String(broker.cpus)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"><InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text></InputGroup.Addon>
				</InputGroup.Root>
				{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.storageMb ? true : undefined}>
				<Field.Label for="resize-store">Message store</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-store"
						name="storageMb"
						type="number"
						min={256}
						max={1048576}
						value={String(broker.storageMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"><InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text></InputGroup.Addon>
				</InputGroup.Root>
				{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
			</Field.Field>
		</div>
	</FormDialog>
{/if}
