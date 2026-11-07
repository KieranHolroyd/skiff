<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import MailIcon from '@lucide/svelte/icons/mail';
	import TagIcon from '@lucide/svelte/icons/tag';
	import UsersIcon from '@lucide/svelte/icons/users';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../../_lib/Panel.svelte';
	import CopyValue from '../../../_lib/service/CopyValue.svelte';
	import ServiceHeader from '../../../_lib/service/ServiceHeader.svelte';
	import { formatDateTime, formatRelative } from '../../../_lib/format.js';
	import { messageStatusTone } from '../../_lib/email-ui.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const message = $derived(data.message);
	const tags = $derived(Object.entries(message.tags));
	const SOURCE: Record<string, string> = {
		api: 'REST API',
		smtp: 'SMTP',
		binding: 'Function binding'
	};
</script>

<svelte:head>
	<title>{message.subject || message.id} · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<ServiceHeader
		icon={MailIcon}
		title={message.subject || '(no subject)'}
		target="page.email.message"
	>
		{#snippet meta()}
			<StatusBadge status={message.status} tone={messageStatusTone(message.status)} />
			<span class="font-mono text-xs">{message.id}</span>
			<span aria-hidden="true">·</span>
			<span class="text-xs"
				>Sent <time datetime={message.createdAt} title={formatDateTime(message.createdAt)}
					>{formatRelative(message.createdAt)}</time
				></span
			>
		{/snippet}
	</ServiceHeader>

	{#if page.url.searchParams.get('sent') === '1'}
		<Notice tone="success" title="Accepted for delivery">
			The mail node picks it up within a few seconds. This page shows each recipient's status as delivery
			events arrive; reload to refresh.
		</Notice>
	{/if}

	<div class="grid items-start gap-5 xl:grid-cols-5">
		<Panel title="Message" icon={MailIcon} class="xl:col-span-2">
			<DetailList>
				<dt>From</dt>
				<dd><CopyValue value={message.from} label="sender" /></dd>
				<dt>Message id</dt>
				<dd><CopyValue value={message.id} label="message id" /></dd>
				<dt>Sent via</dt>
				<dd class="text-xs">{SOURCE[message.source] ?? message.source}</dd>
				<dt>Project</dt>
				<dd class="text-xs">
					{#if data.project}
						<a
							href={resolve('/(dashboard)/projects/[slug]', { slug: data.project })}
							class="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline"
							><FolderKanbanIcon class="size-3.5" />{data.project}</a
						>
					{:else if message.projectId}
						<span class="font-mono">{message.projectId}</span>
					{:else}
						<span class="text-muted-foreground">Organisation-wide</span>
					{/if}
				</dd>
				<dt>Accepted</dt>
				<dd class="font-mono text-xs">{formatDateTime(message.createdAt)}</dd>
			</DetailList>
			{#if tags.length > 0}
				<div class="mt-4 space-y-2">
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<TagIcon class="size-3.5" />Tags
					</p>
					<div class="flex flex-wrap gap-1.5">
						{#each tags as [key, value] (key)}
							<Badge variant="secondary" class="font-mono font-normal">{key}={value}</Badge>
						{/each}
					</div>
				</div>
			{/if}
			{#snippet footer()}
				Bodies are never kept after the message is handed to the mail node.
			{/snippet}
		</Panel>

		<Panel
			title="Recipients"
			icon={UsersIcon}
			count={message.recipients.length}
			description="The latest status per recipient and the last reply from their mail server."
			class="xl:col-span-3"
			flush
		>
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Recipient</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="pr-4">Last response</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each message.recipients as recipient (recipient.address)}
						<Table.Row class="align-top">
							<Table.Cell class="pl-4 font-mono text-xs">{recipient.address}</Table.Cell>
							<Table.Cell>
								<StatusBadge status={recipient.status} tone={messageStatusTone(recipient.status)} />
								<p class="mt-1 text-xs text-muted-foreground">
									<time datetime={recipient.updatedAt} title={formatDateTime(recipient.updatedAt)}
										>{formatRelative(recipient.updatedAt)}</time
									>
								</p>
							</Table.Cell>
							<Table.Cell class="max-w-96 pr-4">
								{#if recipient.lastResponse}
									<p class="font-mono text-xs break-words whitespace-normal">
										{recipient.lastResponse}
									</p>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Panel>
	</div>
</div>
