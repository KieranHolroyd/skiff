<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { BrokerView } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';
	import { formatDate } from '../../_lib/format.js';

	type Can = { update: boolean; delete: boolean };

	/** Sections are in the sidebar (`./subnav.ts`); this is identity, facts and actions. */
	let { broker, can }: { broker: BrokerView; can: Can } = $props();

	/** Settings → Policies trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	const base = $derived(resolve('/(dashboard)/brokers/[name]', { name: broker.name }));
	const deleted = $derived(broker.deletedAt !== null);
	/** Actions live on the detail route, so the header works from every sub-route. */
	const act = (name: string) => `${base}?/${name}`;

	function restart() {
		askConfirm({
			title: `Restart ${broker.name}?`,
			description:
				'The broker container stops and starts again. Clients reconnect; streams, consumers and stored messages are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: act('restart')
		});
	}

	function moveToTrash() {
		askConfirm({
			title: `Delete ${broker.name}?`,
			description:
				broker.attachments.length > 0
					? `It is attached to ${broker.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: `The container stops and the broker moves to the trash for ${trashDays} days. Its streams stay on the node, so a restore is lossless.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: broker.name,
			action: act('delete')
		});
	}

	function purge() {
		askConfirm({
			title: `Delete ${broker.name} permanently?`,
			description:
				'Its node deletes the data directory with every stream and stored message, and the broker is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: broker.name,
			action: act('purge')
		});
	}
</script>

<ServiceHeader icon={InboxIcon} title={broker.name} target="page.brokers">
	{#snippet meta()}
		<StatusBadge status={deleted ? 'deleted' : broker.status} />
		<Badge variant="outline">{broker.engineLabel} {broker.version}</Badge>
		<span class="font-mono text-xs">on {broker.nodeName ?? broker.nodeId}</span>
		<span aria-hidden="true">·</span>
		<span class="font-mono text-xs tabular-nums">{broker.memoryMb} MB · {broker.cpus} vCPU</span>
		<span aria-hidden="true">·</span>
		<span class="text-xs"
			>Created <time datetime={broker.createdAt}>{formatDate(broker.createdAt)}</time></span
		>
	{/snippet}

	{#if deleted}
		{#if can.delete}
			<Button variant="outline" onclick={() => void runAction(act('restore'))}
				><RotateCcwIcon />Restore</Button
			>
			<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
		{/if}
	{:else}
		{#if can.update}
			<Button variant="outline" onclick={restart}><RotateCcwIcon />Restart</Button>
		{/if}
		{#if can.delete}
			<RowMenu label="More actions for {broker.name}">
				<DropdownMenu.Item variant="destructive" onSelect={moveToTrash}>
					<TrashIcon />Delete broker
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{/if}
</ServiceHeader>
