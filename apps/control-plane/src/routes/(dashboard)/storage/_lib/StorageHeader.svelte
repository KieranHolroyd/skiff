<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import EarthIcon from '@lucide/svelte/icons/earth';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import Settings2Icon from '@lucide/svelte/icons/settings-2';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { StorageView } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';
	import { tabHref, type ServiceSection } from '../../_lib/service/sections.js';
	import { formatDate } from '../../_lib/format.js';
	import { STORAGE_DEFAULT_TAB, type StorageTab } from './storage-tabs.js';

	type Can = { update: boolean; delete: boolean };

	let {
		st,
		can,
		active,
		onselect
	}: {
		st: StorageView;
		can: Can;
		active: StorageTab | 'objects' | 'logs';
		onselect?: (tab: StorageTab) => void;
	} = $props();

	/** Settings → Policies trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	const base = $derived(resolve('/(dashboard)/storage/[name]', { name: st.name }));
	const deleted = $derived(st.deletedAt !== null);
	const nodeLabel = $derived(st.nodeName ?? st.nodeId);
	const readyBuckets = $derived(st.buckets.filter((bucket) => bucket.state === 'ready').length);
	/** Actions live on the detail route, so the header works from every sub-route. */
	const act = (name: string) => `${base}?/${name}`;
	const local = (id: StorageTab, label: string, icon: ServiceSection['icon'], count?: number) => ({
		id,
		label,
		icon,
		count,
		href: tabHref(base, id, STORAGE_DEFAULT_TAB),
		local: true
	});

	const sections = $derived<ServiceSection[]>([
		local('overview', 'Overview', LayoutDashboardIcon),
		local('buckets', 'Buckets', ArchiveIcon, readyBuckets),
		...(deleted
			? []
			: [
					{
						id: 'objects',
						label: 'Objects',
						icon: FolderOpenIcon,
						href: resolve('/(dashboard)/storage/[name]/objects', { name: st.name })
					}
				]),
		local('metrics', 'Metrics', ActivityIcon),
		{
			id: 'logs',
			label: 'Logs',
			icon: ScrollTextIcon,
			href: resolve('/(dashboard)/storage/[name]/logs', { name: st.name })
		},
		local('settings', 'Settings', Settings2Icon)
	]);

	function restart() {
		askConfirm({
			title: `Restart ${st.name}?`,
			description:
				'The RustFS container stops and starts again. S3 requests fail briefly; buckets, objects and access keys are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: act('restart')
		});
	}

	function moveToTrash() {
		askConfirm({
			title: `Delete ${st.name}?`,
			description:
				st.attachments.length > 0
					? `It is attached to ${st.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: `The container stops, the public route goes and the instance moves to the trash for ${trashDays} days. Its buckets stay on the node, so a restore is lossless.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: st.name,
			action: act('delete')
		});
	}

	function restore() {
		void runAction(act('restore'));
	}

	function purge() {
		askConfirm({
			title: `Delete ${st.name} permanently?`,
			description:
				'Its node deletes the data directory with every bucket and object, and the instance is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: st.name,
			action: act('purge')
		});
	}
</script>

<ServiceHeader
	icon={CylinderIcon}
	backHref={resolve('/(dashboard)/storage')}
	backLabel="Storage"
	title={st.name}
	target="page.storage"
	{sections}
	{active}
	onselect={onselect ? (id) => onselect(id as StorageTab) : undefined}
>
	{#snippet meta()}
		<StatusBadge status={deleted ? 'deleted' : st.status} />
		<Badge variant="outline">{st.engineLabel} {st.version}</Badge>
		{#if st.public}
			<Badge variant="info"><EarthIcon />Public</Badge>
		{:else}
			<Badge variant="outline"><LockIcon />Private</Badge>
		{/if}
		<span class="font-mono text-xs">on {nodeLabel}</span>
		<span aria-hidden="true">·</span>
		<span class="font-mono text-xs tabular-nums">{st.memoryMb} MB · {st.cpus} vCPU</span>
		<span aria-hidden="true">·</span>
		<span class="text-xs"
			>Created <time datetime={st.createdAt}>{formatDate(st.createdAt)}</time></span
		>
	{/snippet}

	{#if deleted}
		{#if can.delete}
			<Button variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
			<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
		{/if}
	{:else}
		{#if can.update}
			<Button variant="outline" onclick={restart}><RotateCcwIcon />Restart</Button>
		{/if}
		{#if can.delete}
			<RowMenu label="More actions for {st.name}">
				<DropdownMenu.Item variant="destructive" onSelect={moveToTrash}>
					<TrashIcon />Delete storage
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{/if}
</ServiceHeader>
