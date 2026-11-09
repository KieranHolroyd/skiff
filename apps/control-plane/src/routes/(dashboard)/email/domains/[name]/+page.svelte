<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SendIcon from '@lucide/svelte/icons/send';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Panel from '../../../_lib/Panel.svelte';
	import DangerZone from '../../../_lib/service/DangerZone.svelte';
	import ServiceHeader from '../../../_lib/service/ServiceHeader.svelte';
	import { formatDate, formatRelative } from '../../../_lib/format.js';
	import DomainRecords from '../../_lib/DomainRecords.svelte';
	import NotSetUp from '../../_lib/NotSetUp.svelte';
	import { recordState } from '../../_lib/email-ui.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const domain = $derived(data.domain);
	const area = $derived(data.emailArea);
	const missing = $derived(
		domain.records.filter((record) => recordState(record) === 'missing').length
	);

	let checking = $state(false);
	async function check() {
		checking = true;
		await runAction('?/check');
		checking = false;
	}

	/** Follows the saved value; flipped optimistically while the action runs. */
	let sending = $derived(data.domain.sending);
	async function toggleSending(next: boolean) {
		sending = next;
		const result = await runAction('?/sending', { sending: next ? 'true' : '' });
		if (result.type !== 'success') sending = !next;
	}

	function remove() {
		askConfirm({
			title: `Delete ${domain.name}?`,
			description:
				'Sends from this domain are refused straight away and its DKIM key is deleted. Records Yoal created in Cloudflare are removed; records you published yourself stay until you delete them.',
			confirmLabel: 'Delete domain',
			tone: 'danger',
			typeToConfirm: domain.name,
			action: '?/delete'
		});
	}
</script>

<svelte:head>
	<title>{domain.name} · Email · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<ServiceHeader icon={GlobeIcon} title={domain.name} target="page.email.domain">
		{#snippet meta()}
			<StatusBadge status={domain.status} />
			<Badge variant="outline">{domain.sending ? 'Sending on' : 'Sending off'}</Badge>
			<span class="font-mono text-xs">selector {domain.dkimSelector}</span>
			<span aria-hidden="true">·</span>
			<span class="text-xs"
				>Added <time datetime={domain.createdAt}>{formatDate(domain.createdAt)}</time></span
			>
		{/snippet}
		{#if domain.status === 'verified' && domain.sending && data.emailArea.can.send}
			<Button
				variant="outline"
				href={`${resolve('/(dashboard)/email/send')}?domain=${encodeURIComponent(domain.name)}`}
			>
				<SendIcon />Send a test
			</Button>
		{/if}
		<Button variant="outline" onclick={check} disabled={checking}>
			{#if checking}<Spinner />{:else}<RefreshCwIcon />{/if}
			Check now
		</Button>
	</ServiceHeader>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} />
	{/if}

	{#if page.url.searchParams.get('created') === '1' && domain.status !== 'verified'}
		<Notice tone="info" title="Publish these records">
			{#if domain.records.some((record) => record.managed)}
				Yoal created the records it could in Cloudflare. DNS can take a few minutes to update; use
				Check now to look again.
			{:else}
				Add the records below at your DNS provider, then use Check now. Yoal re-checks every domain
				daily.
			{/if}
		</Notice>
	{:else if domain.status === 'failed'}
		<Notice tone="danger" title="Verification is failing">
			A required record stopped matching{domain.failingSince
				? ` ${formatRelative(domain.failingSince)}`
				: ''}. Mail from
			{domain.name} is refused until it is fixed.
		</Notice>
	{:else if domain.status === 'pending'}
		<Notice tone="warning" title="Not verified yet">
			{missing}
			required {missing === 1 ? 'record is' : 'records are'} missing. Mail from {domain.name} is refused
			until the DKIM record is published.
		</Notice>
	{/if}

	<Panel
		title="DNS records"
		icon={ListChecksIcon}
		count={domain.records.length}
		description="Publish these at your DNS provider. Required records gate sending; recommended ones improve inbox placement."
		flush
	>
		<DomainRecords records={domain.records} />
		{#snippet footer()}
			{#if domain.lastCheckedAt}
				Last checked <time datetime={domain.lastCheckedAt}
					>{formatRelative(domain.lastCheckedAt)}</time
				>.
			{:else}
				Not checked yet.
			{/if}
			Yoal re-checks every domain daily{#if domain.verifiedAt}; verified
				<time datetime={domain.verifiedAt}>{formatDate(domain.verifiedAt)}</time>{/if}.
		{/snippet}
	</Panel>

	<Panel title="Sending" icon={SendIcon}>
		<Field.Field orientation="horizontal">
			<Field.Content>
				<Field.Label for="domain-sending">Send from {domain.name}</Field.Label>
				<Field.Description>
					Off keeps the domain and its records but refuses every send from it. Receiving arrives in
					a later release.
				</Field.Description>
			</Field.Content>
			<Switch
				id="domain-sending"
				checked={sending}
				onCheckedChange={toggleSending}
				disabled={!area.can.update}
			/>
		</Field.Field>
	</Panel>

	{#if area.can.delete}
		<DangerZone>
			{#snippet description()}
				Deleting {domain.name} refuses its mail at once and deletes its DKIM key. Adding it again later
				generates a new key, so its DKIM record has to be published again.
			{/snippet}
			<Button variant="destructive" size="sm" onclick={remove}><TrashIcon />Delete domain</Button>
		</DangerZone>
	{/if}
</div>
