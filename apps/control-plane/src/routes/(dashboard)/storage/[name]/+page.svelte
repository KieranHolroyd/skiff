<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import CableIcon from '@lucide/svelte/icons/cable';
	import EarthIcon from '@lucide/svelte/icons/earth';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import {
		storageEnvNames,
		type StorageAttachmentView,
		type StorageBucketView,
		type StorageCredentials
	} from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import MetricChart from '#lib/components/skiff/MetricChart.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatBytes, formatDate, formatDateTime, formatDuration } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import StorageMeter from '../../databases/_lib/StorageMeter.svelte';
	import GrantsFields from '../_lib/GrantsFields.svelte';
	import { storageChart, storageTotals } from '../_lib/storage-series.js';
	import type { PageProps } from './$types';

	interface StorageFormResult {
		message?: string;
		success?: string;
		warning?: string | null;
		publicError?: boolean;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as StorageFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	const st = $derived(data.storage);
	const deleted = $derived(st.deletedAt !== null);
	const nodeLabel = $derived(st.nodeName ?? st.nodeId);
	const hostPort = $derived(st.internalEndpoint.process.split(':').at(-1) ?? '');
	/** Buckets that can be granted, toggled or deleted normally. */
	const readyBuckets = $derived(st.buckets.filter((bucket) => bucket.state === 'ready'));
	const readyBucketNames = $derived(readyBuckets.map((bucket) => bucket.name));
	const defaultEnvNames = $derived(
		storageEnvNames('S3', { public: st.public, singleBucket: readyBuckets.length === 1 })
	);

	const numberFormat = new Intl.NumberFormat('en-GB');
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const count = (value: number) =>
		value >= 10_000 ? compactFormat.format(value) : numberFormat.format(Math.round(value));

	function ago(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return 'never';
		return `${formatDuration(Math.max(0, (Date.now() - ms) / 1000))} ago`;
	}

	// --- public toggle (S3) ----------------------------------------------------------------------

	function setPublic(next: boolean) {
		if (next === st.public) return;
		if (next) {
			askConfirm({
				title: `Make ${st.name} public?`,
				description: `The S3 API is served at ${st.name}--s3.${data.contentDomain}, authenticated by S3 signatures only. All public traffic goes through the edge VPS, and over WireGuard to ${nodeLabel} when that is a worker node, so large uploads and downloads count against its bandwidth. The container keeps running.`,
				confirmLabel: 'Make public',
				action: '?/setPublic',
				fields: { public: 'true' }
			});
		} else {
			askConfirm({
				title: `Make ${st.name} private?`,
				description:
					'The public route is removed. Apps attached from other nodes would lose their endpoint, so this is refused while any depend on it. Apps on the same node keep working.',
				confirmLabel: 'Make private',
				tone: 'danger',
				action: '?/setPublic',
				fields: { public: '' }
			});
		}
	}

	// --- credentials (S6): revealed on demand, audited, never in page data ----------------------

	let credentials = $state<StorageCredentials | null>(null);
	let revealing = $state(false);
	let showSecret = $state(false);

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success') {
			credentials =
				(outcome.data as { credentials?: StorageCredentials } | undefined)?.credentials ?? null;
			showSecret = false;
		}
	}

	function hide() {
		credentials = null;
		showSecret = false;
	}

	const mask = (value: string) => '•'.repeat(Math.min(24, Math.max(12, value.length)));

	// --- buckets ---------------------------------------------------------------------------------

	let bucketOpen = $state(false);
	let bucketSettings = $state<StorageBucketView | null>(null);

	const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
	const bucketQuotaMb = (bucket: StorageBucketView) =>
		bucket.quotaBytes === null ? '' : String(Math.round(bucket.quotaBytes / 1024 / 1024));
	const configTone = (status: StorageBucketView['configStatus']) =>
		status === 'converged'
			? 'success'
			: status === 'error'
				? 'danger'
				: status === 'unsupported'
					? 'warning'
					: 'neutral';

	function grantedTo(bucket: string): string[] {
		return st.attachments
			.filter((item) => item.grants.some((grant) => grant.bucket === bucket))
			.map((item) => item.projectSlug);
	}

	function setAccess(bucket: StorageBucketView, publicRead: boolean) {
		if (publicRead === (bucket.access === 'public-read')) return;
		if (publicRead) {
			askConfirm({
				title: `Allow anonymous reads of ${bucket.name}?`,
				description: st.public
					? `Anyone on the internet can GET objects in “${bucket.name}” at ${st.publicUrl}/${bucket.name}/<key> without signing. Listing stays private.`
					: `Unsigned GETs of objects in “${bucket.name}” are allowed. The instance is private, so only apps on ${nodeLabel} can reach it until you make it public. Listing stays private.`,
				confirmLabel: 'Make public-read',
				action: '?/bucketAccess',
				fields: { bucket: bucket.name, access: 'public-read' }
			});
		} else {
			void runAction('?/bucketAccess', { bucket: bucket.name, access: 'private' });
		}
	}

	function deleteBucket(bucket: StorageBucketView) {
		const users = grantedTo(bucket.name);
		askConfirm({
			title: `Delete bucket ${bucket.name}?`,
			description:
				users.length > 0
					? `It is granted to ${users.join(', ')}. Remove it from their grants first; the delete is refused until then.`
					: bucket.objects === null
						? 'Its node deletes it if it is empty. If it turns out to hold objects, it stays and is marked blocked so you can force it or keep it.'
						: 'The bucket is empty. Its node deletes it on the next reconcile.',
			confirmLabel: 'Delete bucket',
			tone: 'danger',
			action: '?/deleteBucket',
			fields: { bucket: bucket.name }
		});
	}

	function forceDeleteBucket(bucket: StorageBucketView) {
		const users = grantedTo(bucket.name);
		askConfirm({
			title: `Delete ${bucket.name} and every object in it?`,
			description:
				users.length > 0
					? `It is granted to ${users.join(', ')}. Remove it from their grants first; the delete is refused until then.`
					: `Its node empties the bucket${bucket.objects ? ` (${numberFormat.format(bucket.objects)} objects, ${formatBytes(bucket.sizeBytes)})` : ''} and then deletes it. This cannot be undone.`,
			confirmLabel: 'Delete with objects',
			tone: 'danger',
			typeToConfirm: bucket.name,
			action: '?/deleteBucket',
			fields: { bucket: bucket.name, force: 'true' }
		});
	}

	function keepBucket(bucket: StorageBucketView) {
		void runAction('?/createBucket', { bucket: bucket.name, access: bucket.access });
	}

	const bucketStateLabel: Record<StorageBucketView['state'], string> = {
		ready: 'Ready',
		deleting: 'Deleting',
		'delete-blocked': 'Delete blocked'
	};
	const bucketStateTone = {
		ready: 'success',
		deleting: 'warning',
		'delete-blocked': 'danger'
	} as const;

	// --- attachments -----------------------------------------------------------------------------

	let attachOpen = $state(false);
	let attachPrefix = $state('S3');
	let grantsOpen = $state(false);
	let editing = $state<StorageAttachmentView | null>(null);

	function openAttach() {
		attachPrefix = 'S3';
		attachOpen = true;
	}

	function editGrants(item: StorageAttachmentView) {
		editing = item;
		grantsOpen = true;
	}

	function detach(item: StorageAttachmentView) {
		askConfirm({
			title: `Detach ${st.name} from ${item.projectSlug}?`,
			description: `${item.projectSlug} restarts without ${item.envPrefix}_ENDPOINT_URL and the other ${item.envPrefix}_* variables, and its access key ${item.accessKeyId} is deleted. Buckets and objects are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detach',
			fields: { project: item.projectSlug }
		});
	}

	// --- metrics ---------------------------------------------------------------------------------

	const windowFrom = $derived(Date.parse(data.range.from));
	const windowTo = $derived(Date.parse(data.range.to) + 60_000);
	const chart = $derived(
		storageChart(data.metrics, data.range.interval, { from: windowFrom, to: windowTo })
	);
	const totals = $derived(storageTotals(data.metrics));
	const chartBuckets = $derived(chart.buckets);

	const kpis = $derived([
		{
			label: 'Used',
			value: formatBytes(totals.latestUsedBytes ?? st.usedBytes),
			caption: `of ${formatBytes(st.storageMb * 1024 * 1024)} budget`
		},
		{
			label: 'Objects',
			value:
				(totals.latestObjects ?? st.objects) === null
					? '—'
					: count((totals.latestObjects ?? st.objects)!),
			caption: 'across all buckets'
		},
		{
			label: 'Buckets',
			value: numberFormat.format(totals.latestBucketCount ?? readyBuckets.length),
			caption: 'reported by the node'
		},
		{
			label: 'Memory',
			value: totals.latestMemoryBytes === null ? '—' : formatBytes(totals.latestMemoryBytes),
			caption: `of ${st.memoryMb} MB limit${totals.uptime !== null && totals.uptime < 1 ? ` · up ${(totals.uptime * 100).toFixed(1)}%` : ''}`
		}
	]);

	// --- settings and danger zone ----------------------------------------------------------------

	let resizeOpen = $state(false);

	function deleteStorage() {
		askConfirm({
			title: `Delete ${st.name}?`,
			description:
				st.attachments.length > 0
					? `It is attached to ${st.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: 'The container stops, the public route goes and the instance moves to the trash for 7 days. Its buckets stay on the node, so a restore is lossless.',
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: st.name,
			action: '?/delete'
		});
	}

	function restore() {
		void runAction('?/restore');
	}

	function restart() {
		askConfirm({
			title: `Restart ${st.name}?`,
			description:
				'The RustFS container stops and starts again. S3 requests fail briefly; buckets, objects and access keys are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart'
		});
	}

	function purge() {
		askConfirm({
			title: `Delete ${st.name} permanently?`,
			description:
				'Its node deletes the data directory with every bucket and object, and the instance is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: st.name,
			action: '?/purge'
		});
	}

	const created = $derived(page.url.searchParams.get('created') === '1');
	function dismissCreated() {
		const href = resolve('/(dashboard)/storage/[name]', { name: st.name });
		void goto(href, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>{st.name} · Storage · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Storage" title={st.name} target="page.storage">
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				{#if deleted}
					<StatusBadge status="deleted" />
				{:else}
					<StatusBadge status={st.status} />
				{/if}
				<Badge variant="outline">{st.engineLabel} {st.version}</Badge>
				{#if st.public}
					<Badge variant="info"><EarthIcon />Public</Badge>
				{:else}
					<Badge variant="outline"><LockIcon />Private</Badge>
				{/if}
				<span class="font-mono text-xs">on {nodeLabel}</span>
				<span aria-hidden="true">·</span>
				<span class="font-mono text-xs">{st.memoryMb} MB · {st.cpus} vCPU</span>
				<span aria-hidden="true">·</span>
				<span class="text-xs">
					Created <time datetime={st.createdAt}>{formatDate(st.createdAt)}</time>
				</span>
			</div>
		{/snippet}
		{#if !deleted}
			{#if data.logsCanRead}
				<Button
					variant="outline"
					href={resolve('/(dashboard)/storage/[name]/logs', { name: st.name })}
				>
					<ScrollTextIcon />
					Logs
				</Button>
			{/if}
			<Button
				variant="outline"
				href={resolve('/(dashboard)/storage/[name]/objects', { name: st.name })}
			>
				<FolderKanbanIcon />
				Browse objects
			</Button>
			{#if data.storageCan.update}
				<Button variant="outline" onclick={restart}><RotateCcwIcon />Restart</Button>
			{/if}
		{/if}
	</PageHeader>

	{#if deleted}
		<Notice tone="warning" title="This storage instance is in the trash">
			The container is stopped, the public route is removed and its buckets are kept on {nodeLabel}.
			{purgeCountdown(st.purgeAt)}.
			{#if data.storageCan.delete}
				<span class="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
					<Button size="sm" variant="destructive" onclick={purge}>
						<TrashIcon />Delete permanently
					</Button>
				</span>
			{/if}
		</Notice>
	{:else}
		{#if created}
			<Notice tone="success" title="Storage created">
				{nodeLabel} pulls the {st.engineLabel}
				{st.version} image and starts it; buckets are created once it answers. The first start can take
				a minute.
				<Button variant="link" size="sm" class="h-auto p-0" onclick={dismissCreated}>Dismiss</Button>
			</Notice>
		{/if}
		{#if st.message}
			<Notice tone={st.status === 'failed' ? 'danger' : 'warning'}>{st.message}</Notice>
		{/if}
	{/if}

	<div class="grid items-start gap-5 xl:grid-cols-2">
		<!-- Endpoints --------------------------------------------------------------------------- -->
		<Panel
			title="Endpoints"
			icon={CableIcon}
			description="Attached apps receive the right endpoint and their own scoped key as environment variables at start-up."
		>
			{#snippet actions()}
				{#if data.storageCan.credentials && !deleted}
					{#if credentials}
						<Button variant="outline" size="sm" onclick={hide}><EyeOffIcon />Hide</Button>
					{:else}
						<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
							{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
							Reveal root key
						</Button>
					{/if}
				{/if}
			{/snippet}

			<div class="space-y-4">
				<DetailList>
					<dt>Process apps</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate">{st.internalEndpoint.process}</span>
						<CopyButton value={st.internalEndpoint.process} label="Copy endpoint" iconOnly />
					</dd>
					<dt>Container apps</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate">{st.internalEndpoint.container}</span>
						<CopyButton value={st.internalEndpoint.container} label="Copy endpoint" iconOnly />
					</dd>
					<dt>Public URL</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						{#if st.publicUrl}
							<span class="truncate">{st.publicUrl}</span>
							<CopyButton value={st.publicUrl} label="Copy URL" iconOnly />
						{:else}
							<span class="text-muted-foreground">Private</span>
						{/if}
					</dd>
					<dt>Region</dt>
					<dd class="font-mono text-xs">{st.region}</dd>
					<dt>Addressing</dt>
					<dd class="text-xs">Path-style required</dd>
					{#if credentials}
						<dt>Root endpoint</dt>
						<dd class="flex items-center justify-end gap-1 font-mono text-xs">
							<span class="truncate">{credentials.endpoint}</span>
							<CopyButton value={credentials.endpoint} label="Copy endpoint" iconOnly />
						</dd>
						<dt>Access key ID</dt>
						<dd class="flex items-center justify-end gap-1 font-mono text-xs">
							<span class="truncate">{credentials.accessKeyId}</span>
							<CopyButton value={credentials.accessKeyId} label="Copy access key ID" iconOnly />
						</dd>
						<dt>Secret key</dt>
						<dd class="flex items-center justify-end gap-1 font-mono text-xs">
							<span class="truncate">
								{showSecret ? credentials.secretAccessKey : mask(credentials.secretAccessKey)}
							</span>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={showSecret ? 'Hide secret key' : 'Show secret key'}
								onclick={() => (showSecret = !showSecret)}
							>
								{#if showSecret}<EyeOffIcon />{:else}<EyeIcon />{/if}
							</Button>
							<CopyButton value={credentials.secretAccessKey} label="Copy secret key" iconOnly />
						</dd>
					{/if}
				</DetailList>

				{#if credentials}
					<Notice tone="warning" title="This is the root key">
						It can manage every bucket on {st.name}. Use it for tools like rclone or
						<code class="font-mono">aws s3</code>; apps should be attached instead, so each gets
						its own key scoped to its buckets. This reveal was recorded in the audit log.
					</Notice>
				{/if}

				<div class="rounded-lg border p-3">
					<div class="flex items-start justify-between gap-4">
						<div class="space-y-1">
							<label for="storage-public-toggle" class="text-sm font-medium">Public endpoint</label>
							<p class="text-xs text-muted-foreground">
								{#if st.public}
									Served at <span class="font-mono">{st.publicUrl}</span>. All public traffic goes
									through the edge VPS, and over WireGuard when the instance runs on a worker.
								{:else}
									Off: listens on loopback and the workload network of {nodeLabel} only. Turning it
									on serves the S3 API at
									<span class="font-mono">{st.name}--s3.{data.contentDomain}</span> through the edge
									VPS (and over WireGuard for worker nodes), authenticated by S3 signatures.
								{/if}
							</p>
						</div>
						<Switch
							id="storage-public-toggle"
							bind:checked={() => st.public, setPublic}
							disabled={!data.storageCan.update || deleted}
							aria-label="Public endpoint"
						/>
					</div>
					{#if result?.publicError && result.message}
						<div class="mt-3">
							<Notice tone="danger" title="Could not change the endpoint">{result.message}</Notice>
						</div>
					{/if}
				</div>

				<div class="space-y-1.5">
					<p class="text-xs text-muted-foreground">
						Env vars an attached app receives (with its prefix, default <code class="font-mono"
							>S3</code
						>; <code class="font-mono">AWS</code> gives the AWS SDK names):
					</p>
					<div class="flex flex-wrap gap-1.5">
						{#each defaultEnvNames as name (name)}
							<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
						{/each}
					</div>
				</div>
			</div>

			{#snippet footer()}
				<span class="flex items-start gap-2">
					<TerminalIcon class="mt-0.5 size-3.5 shrink-0" />
					<span>
						{#if credentials}
							{credentials.note}
						{:else if st.public}
							S3 clients must use path-style addressing
							(<code class="font-mono">{st.publicUrl}/&lt;bucket&gt;/&lt;key&gt;</code>) and any
							region; Skiff sends <code class="font-mono">{st.region}</code>.
						{:else}
							Private: from elsewhere, tunnel with
							<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>, or
							make it public. Clients must use path-style addressing.
						{/if}
						{#if !data.storageCan.credentials}
							Revealing the root key needs the <code class="font-mono">storage:credentials</code>
							permission.
						{/if}
					</span>
				</span>
			{/snippet}
		</Panel>

		<!-- Attachments ------------------------------------------------------------------------- -->
		<Panel
			title="Attached projects"
			icon={PlugIcon}
			count={st.attachments.length}
			description={st.public
				? 'Public storage works from any node. Each project gets its own key limited to its granted buckets; changes restart the app, no redeploy needed.'
				: `Private storage is reachable on ${nodeLabel} only, so attached apps run there. Each project gets its own key limited to its granted buckets.`}
			flush
		>
			{#snippet actions()}
				{#if data.storageCan.attach && !deleted && data.projects.length > 0 && readyBuckets.length > 0}
					<Button size="sm" variant="outline" onclick={openAttach}><PlusIcon />Attach</Button>
				{/if}
			{/snippet}

			{#if result?.warning}
				<div class="px-4 pt-4">
					<Notice tone="warning">{result.warning}</Notice>
				</div>
			{/if}

			{#if st.attachments.length === 0}
				<div class="p-4">
					<EmptyState
						icon={UnplugIcon}
						compact
						title="Not attached"
						description={readyBuckets.length === 0
							? 'Create a bucket first, then attach a process or container project to it.'
							: 'Attach a process or container project to give it an endpoint and a key scoped to the buckets you choose. Static projects cannot use storage.'}
					>
						{#if data.storageCan.attach && !deleted && data.projects.length > 0 && readyBuckets.length > 0}
							<Button size="sm" onclick={openAttach}><PlusIcon />Attach a project</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Project</Table.Head>
							<Table.Head>Grants</Table.Head>
							<Table.Head class="hidden md:table-cell">Env</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each st.attachments as item (item.projectId)}
							<Table.Row>
								<Table.Cell class="pl-4 align-top">
									<a
										href={resolve('/(dashboard)/projects/[slug]', { slug: item.projectSlug })}
										class="inline-flex items-center gap-1.5 font-mono text-xs font-medium underline-offset-4 hover:underline"
									>
										<FolderKanbanIcon class="size-3.5 text-muted-foreground" />
										{item.projectSlug}
									</a>
									<p
										class="mt-1 font-mono text-[11px] text-muted-foreground"
										title="The project's own access key ID"
									>
										{item.accessKeyId}
									</p>
								</Table.Cell>
								<Table.Cell class="align-top whitespace-normal">
									<div class="flex flex-wrap gap-1">
										{#each item.grants as grant (grant.bucket)}
											<Badge
												variant={grant.mode === 'read-write' ? 'secondary' : 'outline'}
												class="font-mono font-normal"
											>
												{grant.bucket}<span class="text-muted-foreground"
													>{grant.mode === 'read-write' ? 'rw' : 'r'}</span
												>
											</Badge>
										{/each}
									</div>
								</Table.Cell>
								<Table.Cell class="hidden align-top md:table-cell">
									<span class="font-mono text-xs" title={item.envNames.join('\n')}>
										{item.envPrefix}_*
										<span class="text-muted-foreground">{item.envNames.length} vars</span>
									</span>
								</Table.Cell>
								<Table.Cell class="pr-4 text-right align-top">
									{#if data.storageCan.attach && !deleted}
										<div class="flex justify-end gap-1">
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Edit grants for {item.projectSlug}"
												onclick={() => editGrants(item)}
											>
												<PencilIcon />
											</Button>
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label="Detach from {item.projectSlug}"
												onclick={() => detach(item)}
											>
												<UnplugIcon />
											</Button>
										</div>
									{:else if data.storageCan.attach}
										<Button
											variant="ghost-danger"
											size="icon-sm"
											aria-label="Detach from {item.projectSlug}"
											onclick={() => detach(item)}
										>
											<UnplugIcon />
										</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>
	</div>

	<!-- Buckets ------------------------------------------------------------------------------- -->
	<Panel
		title="Buckets"
		icon={ArchiveIcon}
		count={readyBuckets.length}
		description={st.statsAt
			? `Sizes from a snapshot taken ${ago(st.statsAt)} (refreshed every five minutes).`
			: 'Sizes and object counts arrive a few minutes after the instance starts.'}
		flush
	>
		{#snippet actions()}
			{#if data.storageCan.update && !deleted}
				<Button size="sm" variant="outline" onclick={() => (bucketOpen = true)}>
					<PlusIcon />New bucket
				</Button>
			{/if}
		{/snippet}

		{#if st.buckets.length === 0}
			<div class="p-4">
				<EmptyState
					icon={ArchiveIcon}
					compact
					title="No buckets yet"
					description="Buckets are created by the node once the instance runs. Grant them to attached projects to give apps access."
				>
					{#if data.storageCan.update && !deleted}
						<Button size="sm" onclick={() => (bucketOpen = true)}><PlusIcon />Create a bucket</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Bucket</Table.Head>
						<Table.Head>Public read</Table.Head>
						<Table.Head class="text-right">Size</Table.Head>
						<Table.Head class="hidden text-right sm:table-cell">Objects</Table.Head>
						<Table.Head class="hidden md:table-cell">State</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each st.buckets as bucket (bucket.name)}
						{@const users = grantedTo(bucket.name)}
						{@const hasObjects = (bucket.objects ?? 0) > 0}
						<Table.Row>
							<Table.Cell class="pl-4">
								<span class="inline-flex items-center gap-1.5 font-mono text-xs font-medium">
									<ArchiveIcon class="size-3.5 text-muted-foreground" />
									{bucket.name}
								</span>
								{#if users.length > 0}
									<p class="mt-0.5 text-[11px] text-muted-foreground">
										Granted to {users.join(', ')}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<Switch
									size="sm"
									bind:checked={() => bucket.access === 'public-read', (next) => setAccess(bucket, next)}
									disabled={!data.storageCan.update || deleted || bucket.state !== 'ready'}
									aria-label="Public read for {bucket.name}"
								/>
								<span class="ml-1.5 text-xs text-muted-foreground">
									{bucket.access === 'public-read' ? 'public-read' : 'private'}
								</span>
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{bucket.sizeBytes === null ? '—' : formatBytes(bucket.sizeBytes)}
							</Table.Cell>
							<Table.Cell class="hidden text-right font-mono text-xs tabular-nums sm:table-cell">
								{bucket.objects === null ? '—' : numberFormat.format(bucket.objects)}
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								<StatusBadge
									status={bucket.state}
									label={bucketStateLabel[bucket.state]}
									tone={bucketStateTone[bucket.state]}
								/>
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if !deleted && (data.storageCan.update || data.storageCan.delete) && bucket.state !== 'deleting'}
									<RowMenu label="Actions for {bucket.name}">
										{#if data.storageCan.update && !deleted && bucket.state === 'ready'}
											<DropdownMenu.Item onSelect={() => (bucketSettings = bucket)}>
												<SlidersHorizontalIcon />Bucket settings…
											</DropdownMenu.Item>
										{/if}
										{#if bucket.state === 'delete-blocked'}
											{#if data.storageCan.update}
												<DropdownMenu.Item onSelect={() => keepBucket(bucket)}>
													<Undo2Icon />Keep bucket (cancel delete)
												</DropdownMenu.Item>
											{/if}
										{:else if data.storageCan.update && !hasObjects}
											<DropdownMenu.Item variant="destructive" onSelect={() => deleteBucket(bucket)}>
												<TrashIcon />Delete bucket
											</DropdownMenu.Item>
										{/if}
										{#if data.storageCan.delete && (hasObjects || bucket.state === 'delete-blocked')}
											<DropdownMenu.Item
												variant="destructive"
												onSelect={() => forceDeleteBucket(bucket)}
											>
												<TrashIcon />Delete with all objects…
											</DropdownMenu.Item>
										{:else if hasObjects || bucket.state === 'delete-blocked'}
											<DropdownMenu.Item disabled>
												<TrashIcon />Force delete needs storage:delete
											</DropdownMenu.Item>
										{/if}
									</RowMenu>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#snippet footer()}
			<span>
				An empty bucket deletes normally. One that holds objects needs a force delete, which empties
				it first. If a delete finds objects the snapshot missed, the bucket is kept and marked
				<em>delete blocked</em>: keep it (re-creating it cancels the delete) or force it.
			</span>
		{/snippet}
	</Panel>

	<!-- Metrics ------------------------------------------------------------------------------- -->
	<section class="space-y-4" aria-labelledby="storage-metrics">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 id="storage-metrics" class="text-xs font-medium text-muted-foreground">
					Metrics · last {data.range.label}
				</h2>
				<p class="text-sm text-muted-foreground">Sampled once a minute by the node's agent.</p>
			</div>
			<div class="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
				{#each data.ranges as option (option.key)}
					<Button
						href={data.rangeLinks[option.key]}
						variant={option.key === data.range.key ? 'secondary' : 'ghost'}
						size="sm"
						class="h-7 px-2.5 text-xs"
					>
						{option.shortLabel}
					</Button>
				{/each}
			</div>
		</div>

		{#if !data.telemetryAvailable}
			<EmptyState
				icon={ActivityIcon}
				title="Telemetry is not running"
				description="DuckDB is unavailable on this control plane, so storage samples cannot be stored or charted. The instance itself is unaffected."
			/>
		{:else if data.metrics.length === 0}
			<EmptyState
				icon={ActivityIcon}
				title="No stats in the last {data.range.label}"
				description={deleted
					? 'The instance is stopped, so its node is not sampling it.'
					: 'Stats arrive about a minute after the instance starts.'}
			/>
		{:else}
			<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Storage summary">
				{#each kpis as kpi (kpi.label)}
					<Card.Root class="gap-3">
						<Card.Header>
							<Card.Description class="text-xs font-medium text-muted-foreground"
								>{kpi.label}</Card.Description
							>
							<Card.Title class="text-2xl leading-none font-semibold tracking-tight tabular-nums">
								{kpi.value}
							</Card.Title>
						</Card.Header>
						<Card.Footer class="text-xs text-muted-foreground">{kpi.caption}</Card.Footer>
					</Card.Root>
				{/each}
			</section>

			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Panel title="Used" description="Bytes stored across all buckets.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						reference={{ label: 'budget', value: st.storageMb * 1024 * 1024 }}
						series={[
							{
								label: 'used',
								color: 'var(--color-chart-1)',
								values: chartBuckets.map((bucket) => bucket.usedBytes),
								fill: true
							}
						]}
						label="Stored bytes over time"
					/>
				</Panel>
				<Panel title="Objects" description="Objects across all buckets.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'objects',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.objects),
								fill: true
							}
						]}
						label="Object count over time"
					/>
				</Panel>
				<Panel
					title="Memory"
					description="Container memory{chart.span > 1 ? `, ${chart.spanLabel} averages` : ''}."
					class="xl:col-span-2"
				>
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						reference={{ label: 'limit', value: st.memoryMb * 1024 * 1024 }}
						series={[
							{
								label: 'memory',
								color: 'var(--color-chart-3)',
								values: chartBuckets.map((bucket) => bucket.memoryBytes)
							}
						]}
						label="Container memory over time"
					/>
				</Panel>
			</div>
		{/if}
	</section>

	<!-- Settings + danger zone ---------------------------------------------------------------- -->
	<div class="grid items-start gap-5 xl:grid-cols-2">
		<Panel
			title="Resources"
			icon={SlidersHorizontalIcon}
			description="Limits apply when the node restarts the container. The engine version can't change here."
		>
			{#snippet actions()}
				{#if data.storageCan.update && !deleted}
					<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>
						<PencilIcon />Resize
					</Button>
				{/if}
			{/snippet}
			<DetailList>
				<dt>Memory</dt>
				<dd class="font-mono text-xs">{st.memoryMb} MB</dd>
				<dt>CPU</dt>
				<dd class="font-mono text-xs">{st.cpus} vCPU</dd>
				<dt>Storage</dt>
				<dd><StorageMeter sizeBytes={st.usedBytes} storageMb={st.storageMb} /></dd>
				<dt>Updated</dt>
				<dd class="text-xs">
					<time datetime={st.updatedAt}>{formatDateTime(st.updatedAt)}</time>
				</dd>
			</DetailList>
		</Panel>

		{#if data.storageCan.delete}
			<Card.Root class="border-destructive/30">
				<Card.Header>
					<Card.Title class="text-destructive">Danger zone</Card.Title>
					<Card.Description>
						{#if deleted}
							In the trash. Restore brings it back with its buckets, or delete it permanently now.
						{:else if st.attachments.length > 0}
							Detach it from {st.attachments.map((item) => item.projectSlug).join(', ')} before deleting.
							Deleted storage stays in the trash for 7 days with its data intact.
						{:else}
							Deleting stops the container, removes the public route and moves the instance to the
							trash for 7 days. Its buckets stay on the node until it is purged.
						{/if}
					</Card.Description>
					<Card.Action class="flex flex-wrap gap-2 self-center">
						{#if deleted}
							<Button variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
							<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
						{:else}
							<Button variant="destructive" onclick={deleteStorage}>
								<TrashIcon />Delete storage
							</Button>
						{/if}
					</Card.Action>
				</Card.Header>
			</Card.Root>
		{/if}
	</div>
</div>

{#if data.storageCan.update && !deleted}
	<FormDialog
		bind:open={bucketOpen}
		icon={ArchiveIcon}
		title="New bucket"
		description="Skiff records the bucket and the node creates it on {st.name}. Re-creating a bucket whose delete was blocked cancels that delete."
		action="?/createBucket"
		submitLabel="Create bucket"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.bucket ? true : undefined}>
				<Field.Label for="bucket-name">Name</Field.Label>
				<Input
					id="bucket-name"
					name="bucket"
					placeholder="uploads"
					minlength={3}
					maxlength={63}
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.bucket ? 'true' : undefined}
				/>
				<Field.Description>
					3–63 lowercase letters, digits and hyphens. No dots, so path-style URLs and TLS stay
					simple.
				</Field.Description>
				{#if errors.bucket}<Field.Error>{errors.bucket}</Field.Error>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="bucket-access">Anonymous access</Field.Label>
				<NativeSelect.Root id="bucket-access" name="access" value="private" class="w-full">
					<NativeSelect.Option value="private">Private: signed requests only</NativeSelect.Option>
					<NativeSelect.Option value="public-read"
						>Public read: unsigned GET of objects</NativeSelect.Option
					>
				</NativeSelect.Root>
				<Field.Description>
					Public read never allows listing.{st.public
						? ''
						: ' The instance is private, so it only matters for apps on its node until you make it public.'}
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.storageCan.update && !deleted}
	<FormDialog
		bind:open={() => bucketSettings !== null, (open) => (bucketSettings = open ? bucketSettings : null)}
		icon={SlidersHorizontalIcon}
		title="Configure {bucketSettings?.name ?? ''}"
		description="Desired state; the node applies it on its next reconcile and reports convergence. Object lock is set at creation and cannot be undone."
		action="?/bucketConfig"
		submitLabel="Save configuration"
		size="lg"
	>
		{#if bucketSettings}
			<input type="hidden" name="bucket" value={bucketSettings.name} />
			<Field.Group>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="bucket-versioning">Versioning</Field.Label>
						<NativeSelect.Root id="bucket-versioning" name="versioning" class="w-full" value={bucketSettings.versioning ? 'on' : 'off'}>
							<NativeSelect.Option value="off">Off</NativeSelect.Option>
							<NativeSelect.Option value="on">On</NativeSelect.Option>
						</NativeSelect.Root>
						<Field.Description>
							{bucketSettings.objectLock
								? 'Object lock is configured: versioning cannot be suspended.'
								: 'Keeps previous object versions. Noncurrent lifecycle expiry needs it.'}
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="bucket-quota">Hard quota (MB)</Field.Label>
						<Input
							id="bucket-quota"
							name="quotaMb"
							value={bucketQuotaMb(bucketSettings)}
							placeholder="none"
							class="font-mono text-sm"
						/>
						<Field.Description>Empty or “none” means unlimited. Writes fail when the bucket is full.</Field.Description>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="bucket-lifecycle">Lifecycle rules (JSON)</Field.Label>
					<textarea
						id="bucket-lifecycle"
						name="lifecycle"
						rows="5"
						class="w-full rounded-md border bg-background p-2 font-mono text-xs"
						value={jsonText(bucketSettings.lifecycle)}
					></textarea>
					<Field.Description>
						Array of {`{ id, prefix?, expireDays?, noncurrentExpireDays?, abortIncompleteDays?, enabled }`}.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="bucket-cors">CORS rules (JSON)</Field.Label>
					<textarea
						id="bucket-cors"
						name="cors"
						rows="4"
						class="w-full rounded-md border bg-background p-2 font-mono text-xs"
						value={jsonText(bucketSettings.cors)}
					></textarea>
					<Field.Description>
						Array of {`{ origin: [], method: [], header?: [], expose?: [], maxAge? }`}.
					</Field.Description>
				</Field.Field>
				{#if bucketSettings.objectLock}
					<Notice tone="warning" title="Object lock is irreversible">
						{bucketSettings.objectLock.mode} retention of {bucketSettings.objectLock.retainDays} days.
						It was enabled at creation and cannot be disabled from Skiff.
					</Notice>
				{/if}
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<StatusBadge
						status={bucketSettings.configStatus}
						label={bucketSettings.configStatus}
						tone={configTone(bucketSettings.configStatus)}
					/>
					<span>config version {bucketSettings.configVersion}</span>
					{#if bucketSettings.configMessage}<span>· {bucketSettings.configMessage}</span>{/if}
				</div>
			</Field.Group>
		{/if}
	</FormDialog>
{/if}

{#if data.storageCan.attach && !deleted}
	<FormDialog
		bind:open={attachOpen}
		icon={PlugIcon}
		title="Attach {st.name}"
		description={st.public
			? "The project's next start gets an endpoint and its own key. Public storage works from any node."
			: `The project's next start gets an endpoint and its own key. Private storage needs the app on ${nodeLabel}.`}
		action="?/attach"
		submitLabel="Attach"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.project ? true : undefined}>
					<Field.Label for="attach-project">Project</Field.Label>
					<NativeSelect.Root id="attach-project" name="project" class="w-full" required>
						{#each data.projects as project (project.slug)}
							<NativeSelect.Option value={project.slug}>
								{project.name} ({project.runtime})
							</NativeSelect.Option>
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
					<Field.Description>
						<code class="font-mono">AWS</code> gives the AWS SDKs' own variable names.
					</Field.Description>
					{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
				</Field.Field>
			</div>
			<p class="font-mono text-xs text-muted-foreground">
				{storageEnvNames((attachPrefix || 'S3').toUpperCase(), {
					public: st.public,
					singleBucket: false
				}).join(' ')}{readyBuckets.length > 0 ? ` (+${(attachPrefix || 'S3').toUpperCase()}_BUCKET with one bucket)` : ''}
			</p>
			<GrantsFields
				buckets={readyBucketNames}
				defaultMode="read-write"
				error={errors.grants}
				idPrefix="attach-grant"
			/>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={grantsOpen}
		icon={KeyRoundIcon}
		title="Grants for {editing?.projectSlug ?? ''}"
		description="Changes the policy on the project's own key ({editing?.accessKeyId ?? ''}). The app restarts with the new grants."
		action="?/updateGrants"
		submitLabel="Save grants"
	>
		<input type="hidden" name="project" value={editing?.projectSlug ?? ''} />
		{#key editing?.projectSlug}
			<GrantsFields
				buckets={readyBucketNames}
				grants={editing?.grants ?? []}
				error={errors.grants}
				idPrefix="edit-grant"
			/>
		{/key}
	</FormDialog>
{/if}

{#if data.storageCan.update && !deleted}
	<FormDialog
		bind:open={resizeOpen}
		icon={SlidersHorizontalIcon}
		title="Resize {st.name}"
		description="More memory is admitted against {nodeLabel}'s workload slice. The instance restarts with the new limits."
		action="?/update"
		submitLabel="Save resources"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="resize-memory">Memory</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="resize-memory"
							name="memoryMb"
							type="number"
							min={data.engine.minMemoryMb}
							max={16384}
							step={1}
							value={String(st.memoryMb)}
							class="font-mono text-sm"
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
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
							value={String(st.cpus)}
							class="font-mono text-sm"
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
				</Field.Field>
			</div>
			<Field.Field data-invalid={errors.storageMb ? true : undefined}>
				<Field.Label for="resize-storage">Storage budget</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-storage"
						name="storageMb"
						type="number"
						min={256}
						max={10485760}
						step={1}
						value={String(st.storageMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
				<Field.Description>
					Drives the gauge and the 85% alert. It is not enforced on disk.
				</Field.Description>
				{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
