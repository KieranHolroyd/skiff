<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { DatabaseView } from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';
	import { formatDate } from '../../_lib/format.js';

	type Can = {
		update: boolean;
		delete: boolean;
		credentials: boolean;
	};

	/** Sections are in the sidebar (`./subnav.ts`); this is identity, facts and actions. */
	let { db, can }: { db: DatabaseView; can: Can } = $props();

	/** Settings → Retention & defaults trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	const base = $derived(resolve('/(dashboard)/databases/[name]', { name: db.name }));
	const deleted = $derived(db.deletedAt !== null);
	const nodeLabel = $derived(db.nodeName ?? db.nodeId);
	/** Actions live on the detail route, so the header works from every sub-route. */
	const act = (name: string) => `${base}?/${name}`;

	/** What the engine supports (docs/DATABASES.md §17); unsupported sections are not shown. */
	const caps = $derived(db.capabilities);

	function restart(target: 'database' | 'pooler') {
		askConfirm({
			title: target === 'pooler' ? `Restart the pooler for ${db.name}?` : `Restart ${db.name}?`,
			description:
				target === 'pooler'
					? 'Only PgBouncer restarts. Postgres and its existing connections are untouched; apps reconnect through the pooler in a few seconds.'
					: db.pooler.enabled
						? 'The database container and its pooler restart. Attached apps lose their connections briefly and reconnect when the database is back.'
						: 'The database container restarts. Attached apps lose their connections briefly and reconnect when the database is back.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: act('restart'),
			fields: { target }
		});
	}

	function rotate() {
		askConfirm({
			title: 'Rotate the owner password?',
			description: `The node changes the ${db.engineLabel} owner's password and verifies it before Yoal swaps the stored secret. Attached apps restart with the new value; a failed rotation leaves the old one working.`,
			confirmLabel: 'Rotate password',
			tone: 'danger',
			action: act('rotate'),
			fields: { role: 'owner' }
		});
	}

	function backupNow() {
		void runAction(act('backup'));
	}

	function moveToTrash() {
		askConfirm({
			title: `Delete ${db.name}?`,
			description:
				db.attachments.length > 0
					? `It is attached to ${db.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: `The container stops and the database moves to the trash for ${trashDays} days. Its data stays on the node, so a restore is lossless.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: db.name,
			action: act('delete')
		});
	}

	function restore() {
		void runAction(act('restore'));
	}

	function purge() {
		askConfirm({
			title: `Delete ${db.name} permanently?`,
			description:
				'Its node deletes the data directory and the database is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: db.name,
			action: act('purge')
		});
	}
</script>

<ServiceHeader icon={DatabaseIcon} title={db.name} target="page.database">
	{#snippet meta()}
		<StatusBadge status={deleted ? 'deleted' : db.status} />
		<Badge variant="outline">{db.engineLabel} {db.version}</Badge>
		<span class="font-mono text-xs">on {nodeLabel}</span>
		<span aria-hidden="true">·</span>
		<span class="font-mono text-xs tabular-nums">{db.memoryMb} MB · {db.cpus} vCPU</span>
		<span aria-hidden="true">·</span>
		<span class="text-xs"
			>Created <time datetime={db.createdAt}>{formatDate(db.createdAt)}</time></span
		>
	{/snippet}

	{#if deleted}
		{#if can.delete}
			<Button variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
			<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
		{/if}
	{:else if can.update || can.delete || can.credentials}
		{#if can.update}
			{#if caps.backups}
				<Button variant="outline" onclick={backupNow}><CloudUploadIcon />Back up now</Button>
			{/if}
			<Button variant="outline" onclick={() => restart('database')}><RotateCcwIcon />Restart</Button
			>
		{/if}
		{#if (can.update && db.pooler.enabled) || can.credentials || can.delete}
			<RowMenu label="More actions for {db.name}">
				{#if can.update && db.pooler.enabled}
					<DropdownMenu.Item onSelect={() => restart('pooler')}>
						<RotateCcwIcon />Restart pooler only
					</DropdownMenu.Item>
				{/if}
				{#if can.credentials && caps.rotation}
					<DropdownMenu.Item onSelect={rotate}
						><KeyRoundIcon />Rotate owner password</DropdownMenu.Item
					>
				{/if}
				{#if can.delete}
					{#if (can.update && db.pooler.enabled) || can.credentials}<DropdownMenu.Separator />{/if}
					<DropdownMenu.Item variant="destructive" onSelect={moveToTrash}>
						<TrashIcon />Delete database
					</DropdownMenu.Item>
				{/if}
			</RowMenu>
		{/if}
	{/if}
</ServiceHeader>
