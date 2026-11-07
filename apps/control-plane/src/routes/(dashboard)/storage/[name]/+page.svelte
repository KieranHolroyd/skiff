<script lang="ts">
	import TelemetryOff from '../../_lib/TelemetryOff.svelte';
	/* Bucket links are the resolved objects route plus `?bucket=`. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import CableIcon from '@lucide/svelte/icons/cable';
	import EarthIcon from '@lucide/svelte/icons/earth';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import MemoryStickIcon from '@lucide/svelte/icons/memory-stick';
	import FileIcon from '@lucide/svelte/icons/file';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import {
		storageEnvNames,
		type StorageAttachmentView,
		type StorageBucketView,
		type StorageCredentials,
		type StorageKeyReveal,
		type StorageKeyView,
		type StorageReplicationView
	} from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import MetricChart from '#lib/components/skiff/MetricChart.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import RangePicker from '../../_lib/service/RangePicker.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import { readTab, tabHref, type Stat } from '../../_lib/service/sections.js';
	import { formatBytes, formatDateTime, formatDuration } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import StorageMeter from '../../databases/_lib/StorageMeter.svelte';
	import { storagePercent } from '../../databases/_lib/database-series.js';
	import StorageHeader from '../_lib/StorageHeader.svelte';
	import { storageSubnavKey } from '../_lib/subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import { STORAGE_DEFAULT_TAB, STORAGE_TABS, type StorageTab } from '../_lib/storage-tabs.js';
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
	const can = $derived(data.storageCan);
	const deleted = $derived(st.deletedAt !== null);
	const nodeLabel = $derived(st.nodeName ?? st.nodeId);
	const hostPort = $derived(st.internalEndpoint.process.split(':').at(-1) ?? '');
	/** Buckets that can be granted, toggled or deleted normally. */
	const readyBuckets = $derived(st.buckets.filter((bucket) => bucket.state === 'ready'));
	const readyBucketNames = $derived(readyBuckets.map((bucket) => bucket.name));
	const defaultEnvNames = $derived(
		storageEnvNames('S3', { public: st.public, singleBucket: readyBuckets.length === 1 })
	);

	// --- sections --------------------------------------------------------------------------------

	let tab = $state<StorageTab>(
		readTab(page.url.searchParams.get('tab'), STORAGE_TABS, STORAGE_DEFAULT_TAB)
	);

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: StorageTab) {
		tab = next;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, next, STORAGE_DEFAULT_TAB), {});
	}

	/** The sidebar lists the sections; in-place ones switch here without a page load. */
	useSubnavLocal(() => ({
		key: storageSubnavKey(st.name),
		active: tab,
		select: (id) => {
			if (!STORAGE_TABS.includes(id as StorageTab)) return false;
			setTab(id as StorageTab);
			return true;
		}
	}));

	const objectsHref = (bucket?: string) => {
		const href = resolve('/(dashboard)/storage/[name]/objects', { name: st.name });
		return bucket ? `${href}?bucket=${encodeURIComponent(bucket)}` : href;
	};

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

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success') {
			credentials =
				(outcome.data as { credentials?: StorageCredentials } | undefined)?.credentials ?? null;
		}
	}

	function hide() {
		credentials = null;
	}

	// --- root key rotation (§5): staged, proved by the node, rolled back on failure ----------------

	const rootKey = $derived(st.rootKey);

	function rotateRoot() {
		askConfirm({
			title: `Rotate the root key of ${st.name}?`,
			description:
				'RustFS restarts with a new root key, so S3 requests fail briefly. Once the node confirms the new key, the current one stops working: update any tool that uses it. Attached apps and named keys are not affected. If the node cannot confirm it within 10 minutes, the current key comes back.',
			confirmLabel: 'Rotate root key',
			tone: 'danger',
			action: '?/rotateRoot'
		});
	}

	function cancelRotation() {
		askConfirm({
			title: 'Cancel the root key rotation?',
			description: 'RustFS restarts once more with the current root key.',
			confirmLabel: 'Cancel rotation',
			action: '?/cancelRootRotation'
		});
	}

	// --- named keys: metadata in page data, secrets only on an audited reveal -----------------------

	let keyOpen = $state(false);
	let revealedKey = $state<StorageKeyReveal | null>(null);
	let revealingKey = $state<string | null>(null);
	const liveKeys = $derived(data.keys.filter((key) => key.status !== 'revoked'));
	const revokedKeys = $derived(data.keys.filter((key) => key.status === 'revoked'));
	const keyEndpoint = $derived(st.publicUrl ?? st.internalEndpoint.process);

	async function revealKey(key: StorageKeyView) {
		revealingKey = key.id;
		const outcome = await runAction('?/revealKey', { id: key.id }, { apply: false });
		revealingKey = null;
		if (outcome.type === 'success')
			revealedKey =
				(outcome.data as { revealedKey?: StorageKeyReveal } | undefined)?.revealedKey ?? null;
	}

	function revokeKey(key: StorageKeyView) {
		askConfirm({
			title: `Revoke key ${key.name}?`,
			description: `Anything still signing with ${key.accessKeyId} is refused once the node removes it, within a minute. This cannot be undone; create a new key instead.`,
			confirmLabel: 'Revoke key',
			tone: 'danger',
			action: '?/revokeKey',
			fields: { id: key.id }
		});
	}

	const keyTone = (status: StorageKeyView['status']) =>
		status === 'active' ? 'success' : status === 'expired' ? 'warning' : 'neutral';

	// --- replication -------------------------------------------------------------------------------

	/** On the target's own page the rule is read-only: it is managed from the source. */
	const isSource = (replica: StorageReplicationView) => replica.sourceId === st.id;
	const replicaTone = (status: StorageReplicationView['status']) =>
		status === 'protected'
			? 'success'
			: status === 'failed'
				? 'danger'
				: status === 'lagging'
					? 'warning'
					: 'neutral';

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

	const usedBytes = $derived(totals.latestUsedBytes ?? st.usedBytes);
	const kpis = $derived<Stat[]>([
		{
			label: 'Used',
			icon: HardDriveIcon,
			value: usedBytes === null ? '—' : formatBytes(usedBytes),
			unit: `/ ${formatBytes(st.storageMb * 1024 * 1024)}`,
			meter: storagePercent(usedBytes, st.storageMb),
			caption: 'Budget for alerts, not a hard quota'
		},
		{
			label: 'Objects',
			icon: FileIcon,
			value:
				(totals.latestObjects ?? st.objects) === null
					? '—'
					: count((totals.latestObjects ?? st.objects)!),
			caption: 'across all buckets'
		},
		{
			label: 'Buckets',
			icon: ArchiveIcon,
			value: numberFormat.format(totals.latestBucketCount ?? readyBuckets.length),
			caption: st.buckets.some((bucket) => bucket.access === 'public-read')
				? 'Some allow public reads'
				: 'All private'
		},
		{
			label: 'Memory',
			icon: MemoryStickIcon,
			value: totals.latestMemoryBytes === null ? '—' : formatBytes(totals.latestMemoryBytes),
			caption: `of ${st.memoryMb} MB limit${totals.uptime !== null && totals.uptime < 1 ? ` · up ${(totals.uptime * 100).toFixed(1)}%` : ''}`
		}
	]);

	// --- settings and danger zone ----------------------------------------------------------------

	let resizeOpen = $state(false);
	let moveOpen = $state(false);
	let moveNode = $state('');

	function deleteStorage() {
		askConfirm({
			title: `Delete ${st.name}?`,
			description:
				st.attachments.length > 0
					? `It is attached to ${st.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: `The container stops, the public route goes and the instance moves to the trash for ${data.policies.trashDays} days. Its buckets stay on the node, so a restore is lossless.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: st.name,
			action: '?/delete'
		});
	}

	function restore() {
		void runAction('?/restore');
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

	const canAttach = $derived(
		can.attach && !deleted && data.projects.length > 0 && readyBuckets.length > 0
	);

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
	<StorageHeader {st} {can} />

	{#if deleted}
		<Notice tone="warning" title="This storage instance is in the trash">
			The container is stopped, the public route is removed and its buckets are kept on {nodeLabel}.
			{purgeCountdown(st.purgeAt)}. Restore it from the buttons above to bring it back intact.
		</Notice>
	{:else}
		{#if created}
			<Notice tone="success" title="Storage created">
				{nodeLabel} pulls the {st.engineLabel}
				{st.version} image and starts it; buckets are created once it answers. The first start can take
				a minute.
				<Button variant="link" size="sm" class="h-auto p-0" onclick={dismissCreated}>Dismiss</Button
				>
			</Notice>
		{/if}
		{#if st.message}
			<Notice tone={st.status === 'failed' ? 'danger' : 'warning'}>{st.message}</Notice>
		{/if}
	{/if}

	{#if tab === 'overview'}
		<!-- Overview ------------------------------------------------------------------------------ -->
		<StatStrip label="Storage summary" stats={kpis} />

		<Panel
			title="Replication"
			icon={LayersIcon}
			description="Bucket copies on other nodes. The source's node copies new and changed objects every sync interval and mirrors deletes; the target is passive and promotion is manual."
		>
			{#if data.replicas.length === 0}
				<p class="text-sm text-muted-foreground">
					No replication target. A target must be a private instance on another node; its buckets
					are created for it.
				</p>
			{:else}
				<div class="space-y-3">
					{#each data.replicas as replica (replica.id)}
						{@const source = isSource(replica)}
						<div class="space-y-2 rounded-md border px-3 py-2 text-sm">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-mono text-xs">{replica.sourceName ?? replica.sourceId}</span>
									<ArrowRightIcon class="size-3.5 text-muted-foreground" />
									<span class="font-mono text-xs font-medium"
										>{replica.targetName ?? replica.targetId}</span
									>
									<StatusBadge
										status={replica.status}
										label={replica.status}
										tone={replicaTone(replica.status)}
									/>
									{#if !source}
										<Badge variant="outline">this instance is the target</Badge>
									{/if}
								</div>
								{#if source && can.update}
									<Button
										variant="ghost"
										size="xs"
										aria-label="Remove replication to {replica.targetName ?? replica.targetId}"
										onclick={() =>
											askConfirm({
												title: `Remove replication to ${replica.targetName ?? replica.targetId}?`,
												description:
													'Copying stops and the link key is removed. The target instance and the objects already copied stay.',
												confirmLabel: 'Remove target',
												tone: 'danger',
												action: '?/removeReplica',
												fields: { id: replica.id }
											})}
									>
										<TrashIcon class="size-3.5" />
									</Button>
								{/if}
							</div>
							<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
								<div>
									<dt class="text-muted-foreground">Last full sync</dt>
									<dd>
										{replica.lastSyncAt
											? ago(replica.lastSyncAt)
											: 'not yet'}{replica.lagSeconds !== null
											? ` · ${formatDuration(replica.lagSeconds)} lag`
											: ''}
									</dd>
								</div>
								<div>
									<dt class="text-muted-foreground">Last attempt</dt>
									<dd>{ago(replica.lastAttemptAt)}</dd>
								</div>
								<div>
									<dt class="text-muted-foreground">Copied</dt>
									<dd class="tabular-nums">
										{count(replica.objectsCopied)} objects · {formatBytes(replica.bytesCopied)}
									</dd>
								</div>
								<div>
									<dt class="text-muted-foreground">Pending</dt>
									<dd class="tabular-nums">
										{replica.pendingObjects === null ? '—' : count(replica.pendingObjects)}
									</dd>
								</div>
							</dl>
							{#if !replica.initialSyncAt}
								<p class="text-xs text-muted-foreground">
									The first full pass has not finished, so the target is not a usable copy yet.
								</p>
							{/if}
							{#if replica.lastError}
								<Notice tone={replica.status === 'failed' ? 'danger' : 'warning'}>
									<span class="font-mono text-xs break-all">{replica.lastError}</span>
								</Notice>
							{/if}
							{#if replica.buckets.length > 0}
								<ul class="flex flex-wrap gap-1.5">
									{#each replica.buckets as bucket (bucket.name)}
										<li>
											<Badge
												variant={bucket.status === 'error' ? 'destructive' : 'secondary'}
												class="font-mono font-normal"
												title={bucket.error ??
													(bucket.lastSyncAt
														? `in sync as of ${bucket.lastSyncAt}`
														: bucket.status)}
											>
												{bucket.name}
												<span class="text-muted-foreground"
													>{bucket.status === 'in-sync'
														? '✓'
														: bucket.status === 'error'
															? `${bucket.pending} failed`
															: '…'}</span
												>
											</Badge>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#if data.replicaTargets.length > 0 && !deleted && !data.replicas.some((replica) => !isSource(replica))}
				<form method="POST" action="?/addReplica" class="mt-3 flex flex-wrap items-end gap-2">
					<label class="text-xs text-muted-foreground" for="replica-target">Add target</label>
					<select
						id="replica-target"
						name="target"
						class="h-8 rounded-md border bg-background px-2 text-sm"
						required
					>
						{#each data.replicaTargets as target (target.name)}
							<option value={target.name}>{target.name}</option>
						{/each}
					</select>
					<Button type="submit" size="sm" variant="outline"><PlusIcon />Add target</Button>
				</form>
			{/if}
		</Panel>

		<div class="grid items-start gap-5 xl:grid-cols-5">
			<Panel
				title="Endpoints"
				icon={CableIcon}
				description="Attached apps receive the right endpoint and their own scoped key as environment variables at start-up."
				class="xl:col-span-3"
			>
				{#snippet actions()}
					{#if can.credentials && !deleted}
						{#if credentials}
							<Button variant="outline" size="sm" onclick={hide}><EyeOffIcon />Hide root key</Button
							>
						{:else}
							<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
								{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
								Reveal root key
							</Button>
						{/if}
						{#if rootKey?.status === 'rotating'}
							<Button variant="outline" size="sm" onclick={cancelRotation}>Cancel rotation</Button>
						{:else if st.status === 'running'}
							<Button variant="outline" size="sm" onclick={rotateRoot}>
								<RefreshCwIcon />Rotate
							</Button>
						{/if}
					{/if}
				{/snippet}

				{#if rootKey?.status === 'rotating'}
					<Notice tone="warning" title="Root key rotation in progress" class="mb-4">
						RustFS is restarting with {rootKey.pendingAccessKeyId}. The current key ({rootKey.accessKeyId})
						keeps working until the node confirms the new one{rootKey.rotationStartedAt
							? `; started ${ago(rootKey.rotationStartedAt)}`
							: ''}. Without a confirmation within 10 minutes, the current key comes back.
					</Notice>
				{:else if rootKey?.status === 'failed'}
					<Notice tone="danger" title="The last root key rotation was rolled back" class="mb-4">
						{rootKey.error ?? 'The node did not confirm the new key.'} The root key is still {rootKey.accessKeyId}.
					</Notice>
				{/if}

				<DetailList>
					<dt>Process apps</dt>
					<dd><CopyValue value={st.internalEndpoint.process} label="endpoint" /></dd>
					<dt>Container apps</dt>
					<dd><CopyValue value={st.internalEndpoint.container} label="endpoint" /></dd>
					<dt>Public URL</dt>
					<dd>
						{#if st.publicUrl}
							<CopyValue value={st.publicUrl} label="public URL" />
						{:else}
							<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
								<LockIcon class="size-3" />Private ·
								<button
									type="button"
									class="underline-offset-4 hover:text-foreground hover:underline"
									onclick={() => setTab('settings')}>change</button
								>
							</span>
						{/if}
					</dd>
					<dt>Region</dt>
					<dd class="font-mono text-xs">{st.region}</dd>
					<dt>Addressing</dt>
					<dd class="text-xs">Path-style</dd>
					{#if rootKey}
						<dt>Root key</dt>
						<dd class="font-mono text-xs">
							{rootKey.accessKeyId}{#if rootKey.rotatedAt}<span class="text-muted-foreground">
									· rotated {ago(rootKey.rotatedAt)}</span
								>{/if}
						</dd>
					{/if}
					{#if credentials}
						<dt>Root endpoint</dt>
						<dd><CopyValue value={credentials.endpoint} label="root endpoint" /></dd>
						<dt>Access key ID</dt>
						<dd><CopyValue value={credentials.accessKeyId} label="access key ID" /></dd>
						<dt>Secret key</dt>
						<dd><CopyValue value={credentials.secretAccessKey} label="secret key" secret /></dd>
					{/if}
				</DetailList>

				{#if credentials}
					<Notice tone="warning" title="This is the root key" class="mt-4">
						It can manage every bucket on {st.name}. Use it for tools like rclone or
						<code class="font-mono">aws s3</code>; attach apps instead so each gets its own key
						scoped to its buckets. This reveal was recorded in the audit log.
					</Notice>
				{/if}

				<div class="mt-4 space-y-2 rounded-lg border bg-muted/30 p-3">
					<p class="text-xs text-muted-foreground">
						An attached app receives these, with its prefix (default <code class="font-mono"
							>S3</code
						>;
						<code class="font-mono">AWS</code> gives the AWS SDK names):
					</p>
					<div class="flex flex-wrap gap-1.5">
						{#each defaultEnvNames as name (name)}
							<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
						{/each}
					</div>
				</div>

				{#snippet footer()}
					<span class="flex items-start gap-2">
						<TerminalIcon class="mt-0.5 size-3.5 shrink-0" />
						<span>
							{#if credentials}
								{credentials.note}
							{:else if st.public}
								S3 clients must use path-style addressing (<code class="font-mono"
									>{st.publicUrl}/&lt;bucket&gt;/&lt;key&gt;</code
								>) and any region; Skiff sends <code class="font-mono">{st.region}</code>.
							{:else}
								Private: from elsewhere, tunnel with
								<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>
								or make it public.
							{/if}
							{#if !can.credentials}
								Revealing the root key needs <code class="font-mono">storage:credentials</code>.
							{/if}
						</span>
					</span>
				{/snippet}
			</Panel>

			<Panel
				title="Attached projects"
				icon={PlugIcon}
				count={st.attachments.length}
				description={st.public
					? 'Public storage works from any node. Each project gets its own key limited to its granted buckets.'
					: `Private storage is reachable on ${nodeLabel} only, so attached apps run there.`}
				flush
				class="xl:col-span-2"
			>
				{#snippet actions()}
					{#if canAttach && st.attachments.length > 0}
						<Button size="sm" variant="outline" onclick={openAttach}><PlusIcon />Attach</Button>
					{/if}
				{/snippet}

				{#if result?.warning}
					<div class="px-4 pt-4"><Notice tone="warning">{result.warning}</Notice></div>
				{/if}

				{#if st.attachments.length === 0}
					<div class="p-4">
						<EmptyState
							icon={UnplugIcon}
							compact
							title="Not attached yet"
							description={readyBuckets.length === 0
								? 'Create a bucket first, then attach a process or container project to it.'
								: 'Attach a process or container project to give it an endpoint and a key scoped to the buckets you choose.'}
						>
							{#if canAttach}
								<Button size="sm" onclick={openAttach}><PlusIcon />Attach a project</Button>
							{:else if can.update && !deleted && readyBuckets.length === 0}
								<Button size="sm" variant="outline" onclick={() => (bucketOpen = true)}>
									<PlusIcon />Create a bucket
								</Button>
							{/if}
						</EmptyState>
					</div>
				{:else}
					<ul class="divide-y">
						{#each st.attachments as item (item.projectId)}
							<li class="flex items-start gap-3 px-4 py-3">
								<span
									class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
								>
									<FolderKanbanIcon class="size-4" />
								</span>
								<div class="min-w-0 flex-1 space-y-1.5">
									<div>
										<a
											href={resolve('/(dashboard)/projects/[slug]', { slug: item.projectSlug })}
											class="font-mono text-sm font-medium underline-offset-4 hover:underline"
										>
											{item.projectSlug}
										</a>
										<p
											class="truncate font-mono text-xs text-muted-foreground"
											title={item.envNames.join('\n')}
										>
											{item.envPrefix}_* · key {item.accessKeyId}
										</p>
									</div>
									<div class="flex flex-wrap gap-1">
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
										{/each}
									</div>
								</div>
								{#if can.attach}
									<RowMenu label="Actions for {item.projectSlug}">
										{#if !deleted}
											<DropdownMenu.Item onSelect={() => editGrants(item)}>
												<PencilIcon />Edit grants…
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
										{/if}
										<DropdownMenu.Item variant="destructive" onSelect={() => detach(item)}>
											<UnplugIcon />Detach
										</DropdownMenu.Item>
									</RowMenu>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Panel>
		</div>

		<Panel
			title="Access keys"
			icon={KeyRoundIcon}
			count={liveKeys.length}
			description="Named keys for people and outside services, scoped to the buckets you choose. Apps on Skiff get their own key when attached."
			flush
		>
			{#snippet actions()}
				{#if can.update && !deleted && readyBuckets.length > 0}
					<Button size="sm" variant="outline" onclick={() => (keyOpen = true)}>
						<PlusIcon />New key
					</Button>
				{/if}
			{/snippet}

			{#if revealedKey}
				<div class="space-y-3 border-b p-4">
					<DetailList>
						<dt>Endpoint</dt>
						<dd><CopyValue value={keyEndpoint} label="endpoint" /></dd>
						<dt>Access key ID</dt>
						<dd><CopyValue value={revealedKey.accessKeyId} label="access key ID" /></dd>
						<dt>Secret key</dt>
						<dd><CopyValue value={revealedKey.secretAccessKey} label="secret key" secret /></dd>
					</DetailList>
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs text-muted-foreground">
							Key “{revealedKey.name}”. This reveal was recorded in the audit log.
						</p>
						<Button variant="outline" size="sm" onclick={() => (revealedKey = null)}>
							<EyeOffIcon />Hide
						</Button>
					</div>
				</div>
			{/if}

			{#if data.keys.length === 0}
				<div class="p-4">
					<p class="text-sm text-muted-foreground">
						No named keys. Create one for a backup tool, a CDN or a teammate's S3 client; it can
						only reach the buckets you grant.
					</p>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Key</Table.Head>
							<Table.Head>Buckets</Table.Head>
							<Table.Head class="hidden md:table-cell">Status</Table.Head>
							<Table.Head class="hidden lg:table-cell">Expires</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each [...liveKeys, ...revokedKeys] as key (key.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="min-w-0">
										<span class="font-mono text-sm font-medium">{key.name}</span>
										<p class="truncate font-mono text-xs text-muted-foreground">
											{key.accessKeyId}{key.purpose ? ` · ${key.purpose}` : ''}
										</p>
									</div>
								</Table.Cell>
								<Table.Cell>
									<div class="flex flex-wrap gap-1">
										{#each key.grants as grant (grant.bucket)}
											<Badge
												variant={grant.mode === 'read-write' ? 'secondary' : 'outline'}
												class="font-mono font-normal"
												title={grant.mode}
											>
												{grant.bucket}<span class="text-muted-foreground"
													>{grant.mode === 'read-write' ? 'rw' : 'r'}</span
												>
											</Badge>
										{/each}
									</div>
								</Table.Cell>
								<Table.Cell class="hidden md:table-cell">
									<StatusBadge status={key.status} label={key.status} tone={keyTone(key.status)} />
								</Table.Cell>
								<Table.Cell class="hidden text-xs lg:table-cell">
									{key.expiresAt ? formatDateTime(key.expiresAt) : 'Never'}
								</Table.Cell>
								<Table.Cell class="pr-4">
									{#if key.status === 'active' && !deleted && (can.credentials || can.update)}
										<RowMenu label="Actions for {key.name}">
											{#if can.credentials}
												<DropdownMenu.Item
													disabled={revealingKey === key.id}
													onSelect={() => revealKey(key)}
												>
													<KeyRoundIcon />Reveal secret
												</DropdownMenu.Item>
											{/if}
											{#if can.update}
												{#if can.credentials}<DropdownMenu.Separator />{/if}
												<DropdownMenu.Item variant="destructive" onSelect={() => revokeKey(key)}>
													<TrashIcon />Revoke
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
					Revealing a secret needs <code class="font-mono">storage:credentials</code> and is audited.
					MCP clients can list, create and revoke keys but never read a secret.
				</span>
			{/snippet}
		</Panel>
	{:else if tab === 'buckets'}
		<!-- Buckets ------------------------------------------------------------------------------- -->
		<Panel
			title="Buckets"
			icon={ArchiveIcon}
			count={readyBuckets.length}
			description={st.statsAt
				? `Sizes from a snapshot taken ${ago(st.statsAt)}. Refreshed every five minutes.`
				: 'Sizes and object counts arrive a few minutes after the instance starts.'}
			flush
		>
			{#snippet actions()}
				{#if can.update && !deleted}
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
						{#if can.update && !deleted}
							<Button size="sm" onclick={() => (bucketOpen = true)}
								><PlusIcon />Create a bucket</Button
							>
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
							{@const browsable = !deleted && bucket.state === 'ready'}
							<Table.Row class="group">
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-3">
										<span
											class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
										>
											<ArchiveIcon class="size-4" />
										</span>
										<div class="min-w-0">
											{#if browsable}
												<a
													href={objectsHref(bucket.name)}
													class="font-mono text-sm font-medium underline-offset-4 group-hover:underline"
													>{bucket.name}</a
												>
											{:else}
												<span class="font-mono text-sm font-medium">{bucket.name}</span>
											{/if}
											<p class="truncate text-xs text-muted-foreground">
												{users.length > 0
													? `Granted to ${users.join(', ')}`
													: 'Not granted to any project'}
												{#if bucket.versioning}· versioned{/if}
											</p>
										</div>
									</div>
								</Table.Cell>
								<Table.Cell>
									<span class="inline-flex items-center gap-2">
										<Switch
											size="sm"
											bind:checked={
												() => bucket.access === 'public-read', (next) => setAccess(bucket, next)
											}
											disabled={!can.update || deleted || bucket.state !== 'ready'}
											aria-label="Public read for {bucket.name}"
										/>
										<span class="text-xs text-muted-foreground">
											{bucket.access === 'public-read' ? 'Public' : 'Private'}
										</span>
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
									{#if !deleted && bucket.state !== 'deleting'}
										<RowMenu label="Actions for {bucket.name}">
											{#if browsable}
												<DropdownMenu.Item onSelect={() => goto(objectsHref(bucket.name))}>
													<FolderOpenIcon />Browse objects
												</DropdownMenu.Item>
											{/if}
											{#if can.update && bucket.state === 'ready'}
												<DropdownMenu.Item onSelect={() => (bucketSettings = bucket)}>
													<SlidersHorizontalIcon />Bucket settings…
												</DropdownMenu.Item>
											{/if}
											{#if bucket.state === 'delete-blocked' && can.update}
												<DropdownMenu.Item onSelect={() => keepBucket(bucket)}>
													<Undo2Icon />Keep bucket (cancel delete)
												</DropdownMenu.Item>
											{/if}
											{#if (can.update && !hasObjects && bucket.state !== 'delete-blocked') || hasObjects || bucket.state === 'delete-blocked'}
												<DropdownMenu.Separator />
											{/if}
											{#if can.update && !hasObjects && bucket.state !== 'delete-blocked'}
												<DropdownMenu.Item
													variant="destructive"
													onSelect={() => deleteBucket(bucket)}
												>
													<TrashIcon />Delete bucket
												</DropdownMenu.Item>
											{/if}
											{#if hasObjects || bucket.state === 'delete-blocked'}
												{#if can.delete}
													<DropdownMenu.Item
														variant="destructive"
														onSelect={() => forceDeleteBucket(bucket)}
													>
														<TrashIcon />Delete with all objects…
													</DropdownMenu.Item>
												{:else}
													<DropdownMenu.Item disabled>
														<TrashIcon />Force delete needs storage:delete
													</DropdownMenu.Item>
												{/if}
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
					An empty bucket deletes normally; one that holds objects needs a force delete, which
					empties it first. If a delete finds objects the snapshot missed, the bucket is marked
					<em>delete blocked</em>: keep it or force it.
				</span>
			{/snippet}
		</Panel>
	{:else if tab === 'metrics'}
		<!-- Metrics ------------------------------------------------------------------------------- -->
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="text-base font-semibold">Last {data.range.label}</h2>
				<p class="text-sm text-muted-foreground">Sampled once a minute by the node's agent.</p>
			</div>
			<RangePicker
				ranges={data.ranges}
				current={data.range.key}
				links={data.rangeLinks}
				tab="metrics"
			/>
		</div>

		{#if !data.telemetryAvailable}
			<TelemetryOff
				installed={data.telemetryInstalled}
				reason={data.telemetryReason}
				subject="Storage stats"
				unaffected="The instance itself is unaffected."
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
	{:else if tab === 'settings'}
		<!-- Settings ------------------------------------------------------------------------------ -->
		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Panel
				title="Public endpoint"
				icon={EarthIcon}
				description="Serve the S3 API on the internet through the edge, authenticated by S3 signatures."
			>
				<div class="flex items-start justify-between gap-4">
					<div class="space-y-1">
						<label for="storage-public-toggle" class="text-sm font-medium">
							{st.public ? 'Public' : 'Private'}
						</label>
						<p class="text-xs text-muted-foreground">
							{#if st.public}
								Served at <span class="font-mono">{st.publicUrl}</span>. Public traffic goes through
								the edge VPS, and over WireGuard when the instance runs on a worker.
							{:else}
								Listens on loopback and the workload network of {nodeLabel} only. Turning it on serves
								<span class="font-mono">{st.name}--s3.{data.contentDomain}</span> through the edge VPS.
							{/if}
						</p>
					</div>
					<Switch
						id="storage-public-toggle"
						bind:checked={() => st.public, setPublic}
						disabled={!can.update || deleted}
						aria-label="Public endpoint"
					/>
				</div>
				{#if result?.publicError && result.message}
					<Notice tone="danger" title="Could not change the endpoint" class="mt-4">
						{result.message}
					</Notice>
				{/if}
			</Panel>

			<Panel
				title="Resources"
				icon={SlidersHorizontalIcon}
				description="Limits apply when the node restarts the container. The engine version can't change here."
			>
				{#snippet actions()}
					{#if can.update && !deleted}
						{#if data.moveTargets.length > 0}
							<Button
								variant="outline"
								size="sm"
								onclick={() => {
									moveNode = data.moveTargets[0]?.nodeId ?? '';
									moveOpen = true;
								}}
							>
								<ArrowLeftRightIcon />Move
							</Button>
						{/if}
						<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>
							<PencilIcon />Resize
						</Button>
					{/if}
				{/snippet}
				<DetailList>
					<dt>Engine</dt>
					<dd class="text-xs">{st.engineLabel} {st.version}</dd>
					<dt>Node</dt>
					<dd class="font-mono text-xs">{nodeLabel}</dd>
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
		</div>

		{#if can.delete}
			<DangerZone>
				{#snippet description()}
					{#if deleted}
						In the trash. Restore brings it back with its buckets, or delete it permanently now.
					{:else if st.attachments.length > 0}
						Detach it from {st.attachments.map((item) => item.projectSlug).join(', ')} first. Deleted
						storage stays in the trash for {data.policies.trashDays} days with its data intact.
					{:else}
						Deleting stops the container, removes the public route and moves the instance to the
						trash for {data.policies.trashDays} days. Its buckets stay on the node until it is purged.
					{/if}
				{/snippet}
				{#if deleted}
					<Button variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
					<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
				{:else}
					<Button variant="destructive" onclick={deleteStorage}><TrashIcon />Delete storage</Button>
				{/if}
			</DangerZone>
		{/if}
	{/if}
</div>

{#if can.update && !deleted}
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

{#if can.update && !deleted}
	<FormDialog
		bind:open={
			() => bucketSettings !== null, (open) => (bucketSettings = open ? bucketSettings : null)
		}
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
						<NativeSelect.Root
							id="bucket-versioning"
							name="versioning"
							class="w-full"
							value={bucketSettings.versioning ? 'on' : 'off'}
						>
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
						<Field.Description
							>Empty or “none” means unlimited. Writes fail when the bucket is full.</Field.Description
						>
					</Field.Field>
				</div>
				<Field.Field>
					<Field.Label for="bucket-lifecycle">Lifecycle rules (JSON)</Field.Label>
					<Textarea
						id="bucket-lifecycle"
						name="lifecycle"
						rows={5}
						spellcheck="false"
						class="font-mono text-xs"
						value={jsonText(bucketSettings.lifecycle)}
					/>
					<Field.Description>
						Array of {`{ id, prefix?, expireDays?, noncurrentExpireDays?, abortIncompleteDays?, enabled }`}.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="bucket-cors">CORS rules (JSON)</Field.Label>
					<Textarea
						id="bucket-cors"
						name="cors"
						rows={4}
						spellcheck="false"
						class="font-mono text-xs"
						value={jsonText(bucketSettings.cors)}
					/>
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

{#if can.attach && !deleted}
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
				}).join(' ')}{readyBuckets.length > 0
					? ` (+${(attachPrefix || 'S3').toUpperCase()}_BUCKET with one bucket)`
					: ''}
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
		description="Changes the policy on the project's own key ({editing?.accessKeyId ??
			''}). The app restarts with the new grants."
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

{#if can.update && !deleted}
	<FormDialog
		bind:open={keyOpen}
		icon={KeyRoundIcon}
		title="New access key for {st.name}"
		description="The key can reach only the buckets you grant. Its secret is not shown now: reveal it from the list when you need it."
		action="?/createKey"
		submitLabel="Create key"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.name ? true : undefined}>
					<Field.Label for="key-name">Name</Field.Label>
					<Input
						id="key-name"
						name="name"
						placeholder="backup-tool"
						maxlength={60}
						required
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
						aria-invalid={errors.name ? 'true' : undefined}
					/>
					{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.expiresAt ? true : undefined}>
					<Field.Label for="key-expires">Expires</Field.Label>
					<Input id="key-expires" name="expiresAt" type="date" class="text-sm" />
					<Field.Description
						>Optional. The key stops working at the end of that day (UTC).</Field.Description
					>
					{#if errors.expiresAt}<Field.Error>{errors.expiresAt}</Field.Error>{/if}
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="key-purpose">Purpose</Field.Label>
				<Input id="key-purpose" name="purpose" maxlength={120} placeholder="Nightly offsite copy" />
			</Field.Field>
			<GrantsFields buckets={readyBucketNames} error={errors.grants} idPrefix="key-grant" />
		</Field.Group>
	</FormDialog>
{/if}

{#if can.update && !deleted}
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

{#if can.update && !deleted && data.moveTargets.length > 0}
	<FormDialog
		bind:open={moveOpen}
		icon={ArrowLeftRightIcon}
		title="Move {st.name} to another node"
		description="A move does not copy objects, so {st.name} starts empty on the target. Its buckets, access keys and attached apps' credentials come back unchanged; the copy on {nodeLabel} is deleted. Copy what you need first."
		action="?/move"
		submitLabel="Move storage"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="move-node">Target node</Field.Label>
				<NativeSelect.Root id="move-node" name="node" bind:value={moveNode} class="w-full">
					{#each data.moveTargets as node (node.nodeId)}
						<NativeSelect.Option value={node.nodeId}>
							{node.name} · {node.freeMemoryMb} MB free
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>
					{st.public
						? 'Apps reach public storage from any node, so none of them move.'
						: 'Attached apps move with it unless another service they use stays behind.'}
				</Field.Description>
			</Field.Field>
			<label class="flex items-start gap-2 text-sm">
				<Checkbox name="acknowledge" value="on" class="mt-0.5" />
				<span
					>I understand the objects in {st.name} are not copied and are deleted with the old copy.</span
				>
			</label>
		</Field.Group>
	</FormDialog>
{/if}
