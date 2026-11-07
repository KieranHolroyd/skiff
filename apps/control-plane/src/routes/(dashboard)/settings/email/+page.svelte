<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SignpostIcon from '@lucide/svelte/icons/signpost';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import {
		EMAIL_ACTIVE_DEFAULT_LIMITS,
		EMAIL_SANDBOX_LIMITS,
		emailOrgStates
	} from '@skiff/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import { ORG_STATE_COPY } from '../../email/_lib/email-ui.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	interface OrgFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as OrgFormResult | null)?.fieldErrors ?? {});

	const settings = $derived(data.settings);
	const hostnames = $derived(settings.hostnames);
	const mailNode = $derived(data.mailNode);
	const ip = $derived(settings.ip);

	/** Why a node can't be picked, or null when it can. */
	function blocked(node: PageProps['data']['nodes'][number]): string | null {
		if (!node.mail) return 'update its agent';
		return null;
	}

	let nodeId = $state('');
	let ipInput = $state('');
	let paused = $state(false);
	let orgState = $state('sandbox');
	$effect.pre(() => {
		nodeId = data.settings.nodeId ?? '';
		ipInput = data.settings.ip ?? '';
		paused = data.settings.paused;
		orgState = data.emailOrg?.state ?? 'sandbox';
	});

	let savingNode = $state(false);
	let savingOrg = $state(false);

	async function togglePause(next: boolean) {
		paused = next;
		const result = await runAction('?/pause', { paused: next ? 'true' : '' });
		if (result.type !== 'success') paused = !next;
	}

	function turnOff() {
		askConfirm({
			title: 'Turn email off?',
			description:
				'No node sends or receives mail. Queued messages stay on the old mail node until one is picked again; every send is refused meanwhile.',
			confirmLabel: 'Turn off',
			tone: 'danger',
			action: '?/node',
			fields: { nodeId: '' }
		});
	}

	const limitsHint = $derived(
		orgState === 'sandbox'
			? `Sandbox default: ${EMAIL_SANDBOX_LIMITS.perDay} a day, ${EMAIL_SANDBOX_LIMITS.perSecond} a second.`
			: `Active default: ${EMAIL_ACTIVE_DEFAULT_LIMITS.perDay.toLocaleString('en')} a day, ${EMAIL_ACTIVE_DEFAULT_LIMITS.perSecond} a second. Leave blank to keep the current limits.`
	);
</script>

<svelte:head><title>Email · Settings · Skiff</title></svelte:head>

<SettingsHeader id="email">
	{#if settings.nodeId}
		<StatusBadge
			status={paused ? 'paused' : 'active'}
			tone={paused ? 'warning' : 'success'}
			label={paused ? 'Delivery paused' : 'Sending'}
		/>
	{:else}
		<StatusBadge status="off" tone="neutral" label="Not set up" />
	{/if}
</SettingsHeader>

{#if !data.enabled}
	<Notice tone="warning" title="Email is switched off">
		Set <code class="font-mono">SKIFF_FEATURE_EMAIL=1</code> and restart the control plane to configure
		a mail node.
	</Notice>
{/if}

<Panel
	title="Mail node"
	icon={ServerIcon}
	description="One node runs skiff-mail and sends every organisation's mail from its public IPv4. Pick one whose IP has a clean reputation and can reach port 25."
>
	<form
		method="POST"
		action="?/node"
		class="flex flex-wrap items-end gap-3"
		use:enhance={() => {
			savingNode = true;
			return async ({ result, update }) => {
				await update({ reset: false });
				savingNode = false;
				notify(result);
			};
		}}
	>
		<Field.Field class="min-w-64 flex-1">
			<Field.Label for="mail-node">Node</Field.Label>
			<NativeSelect.Root
				id="mail-node"
				name="nodeId"
				bind:value={nodeId}
				class="w-full"
				disabled={!data.enabled}
			>
				<NativeSelect.Option value="" disabled={settings.nodeId !== null}
					>Pick a node…</NativeSelect.Option
				>
				{#each data.nodes as node (node.id)}
					{@const reason = blocked(node)}
					<NativeSelect.Option value={node.id} disabled={reason !== null}>
						{node.name} · {node.mode}{reason ? ` — ${reason}` : ''}
					</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</Field.Field>
		<Field.Field class="w-44">
			<Field.Label for="mail-ip">Public IPv4</Field.Label>
			<InputGroup.Root>
				<InputGroup.Input
					id="mail-ip"
					name="ip"
					bind:value={ipInput}
					placeholder="203.0.113.10"
					inputmode="decimal"
					autocomplete="off"
					class="font-mono"
					disabled={!data.enabled}
				/>
			</InputGroup.Root>
		</Field.Field>
		<Button
			type="submit"
			disabled={!data.enabled ||
				savingNode ||
				!nodeId ||
				(nodeId === settings.nodeId && ipInput.trim() === (settings.ip ?? ''))}
		>
			{#if savingNode}<Spinner />{/if}
			{!settings.nodeId ? 'Use this node' : nodeId === settings.nodeId ? 'Save' : 'Move mail node'}
		</Button>
		{#if settings.nodeId}
			<Button variant="outline" onclick={turnOff} disabled={!data.enabled}>Turn off</Button>
		{/if}
	</form>
	<p class="mt-3 text-xs text-muted-foreground">
		The IP the node sends from, the one its provider sets reverse DNS on. Left blank, Skiff uses a
		public IPv4 in the node's address, or for the edge the platform host's record in the Cloudflare
		zone, and asks when it finds neither.
	</p>
	{#if data.nodes.some((node) => !node.mail)}
		<p class="mt-3 text-xs text-muted-foreground">
			Greyed-out nodes run an agent without mail support. Update their agent from
			<a href={resolve('/(dashboard)/nodes')} class="underline underline-offset-4">Nodes</a> to make them
			selectable.
		</p>
	{/if}
	{#snippet footer()}
		Preflight checks (port 25 egress, inbound reachability, FCrDNS, blocklists) are not run from the
		dashboard yet; check them from the node before sending real mail.
	{/snippet}
</Panel>

{#if settings.nodeId}
	<Panel title="Delivery" icon={PauseIcon}>
		<Field.Field orientation="horizontal">
			<Field.Content>
				<Field.Label for="email-paused">Pause delivery for every organisation</Field.Label>
				<Field.Description>
					Sends are still accepted and spooled on {mailNode?.name ?? 'the mail node'}, but nothing
					is attempted until you resume. Use it while fixing a blocklisting or a DNS mistake.
				</Field.Description>
			</Field.Content>
			<Switch
				id="email-paused"
				checked={paused}
				onCheckedChange={togglePause}
				disabled={!data.enabled}
			/>
		</Field.Field>
	</Panel>

	<Panel
		title="Reverse DNS"
		icon={UndoIcon}
		description="Receivers reject mail from an IP whose PTR record doesn't name the host it greets with."
	>
		{#if ip}
			<p class="text-sm">
				In your server provider's console, set the reverse DNS of
				<code class="rounded bg-muted px-1 font-mono text-xs">{ip}</code>
				<CopyButton value={ip} label="Copy IP" iconOnly variant="ghost" size="icon-xs" />
				to
				<code class="rounded bg-muted px-1 font-mono text-xs">{hostnames.helo}</code>
				<CopyButton
					value={hostnames.helo}
					label="Copy host name"
					iconOnly
					variant="ghost"
					size="icon-xs"
				/>.
			</p>
			<p class="mt-2 text-xs text-muted-foreground">
				Skiff can't set PTR records; only the owner of the IP range can. The A record for {hostnames.helo}
				is in the list below.
			</p>
		{:else}
			<p class="text-sm text-muted-foreground">
				{mailNode?.name ?? 'The mail node'} has no public IPv4 set, so there is nothing to point yet.
				Enter it under Mail node.
			</p>
		{/if}
	</Panel>
{/if}

<Panel
	title="Platform DNS records"
	icon={ListChecksIcon}
	count={data.platformRecords.length}
	description="Records the mail node needs under {settings.mailDomain}. With the platform's Cloudflare zone connected, Skiff publishes them when you pick the node."
	flush
>
	<Table.Root>
		<Table.Header class="bg-muted/45">
			<Table.Row>
				<Table.Head class="pl-4">Type</Table.Head>
				<Table.Head>Name</Table.Head>
				<Table.Head class="pr-4">Value</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.platformRecords as record (record.type + record.name + record.value)}
				{@const value =
					record.priority !== undefined ? `${record.priority} ${record.value}` : record.value}
				<Table.Row>
					<Table.Cell class="pl-4 font-mono text-xs">{record.type}</Table.Cell>
					<Table.Cell class="max-w-64">
						<span class="flex min-w-0 items-center gap-0.5 font-mono text-xs">
							<span class="truncate" title={record.name}>{record.name}</span>
							<CopyButton
								value={record.name}
								label="Copy name"
								iconOnly
								variant="ghost"
								size="icon-xs"
							/>
						</span>
					</Table.Cell>
					<Table.Cell class="max-w-80 pr-4">
						<span class="flex min-w-0 items-center gap-0.5 font-mono text-xs">
							<span class="truncate" title={value}>{value}</span>
							<CopyButton {value} label="Copy value" iconOnly variant="ghost" size="icon-xs" />
						</span>
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
	{#if !ip}
		<p class="border-t px-4 py-3 text-xs text-muted-foreground">
			The A and SPF records appear once a mail node with a public IPv4 address is picked.
		</p>
	{/if}
</Panel>

<Panel
	title="Host names"
	icon={SignpostIcon}
	description="What the mail node answers as. Organisations' SPF records include {hostnames.spf}."
>
	<DetailList>
		<dt>Greeting (HELO)</dt>
		<dd><CopyValue value={hostnames.helo} label="HELO host" /></dd>
		<dt>Inbound MX</dt>
		<dd><CopyValue value={hostnames.mx} label="MX host" /></dd>
		<dt>SMTP submission</dt>
		<dd><CopyValue value={hostnames.submission} label="submission host" /></dd>
		<dt>Bounces</dt>
		<dd><CopyValue value={hostnames.bounce} label="bounce host" /></dd>
		<dt>SPF include</dt>
		<dd><CopyValue value={hostnames.spf} label="SPF host" /></dd>
	</DetailList>
</Panel>

<Panel
	title="Sending limits for {data.org.name}"
	icon={GaugeIcon}
	description="New organisations start in the sandbox. Move one to active once you trust what it sends."
>
	{#snippet actions()}
		{#if data.emailOrg}
			{@const copy = ORG_STATE_COPY[data.emailOrg.state]}
			<StatusBadge status={data.emailOrg.state} label={copy.label} tone={copy.tone} />
		{/if}
	{/snippet}
	{#if data.emailOrg?.state === 'paused' && data.emailOrg.pausedReason}
		<Notice tone="danger" title="Paused" class="mb-4">{data.emailOrg.pausedReason}</Notice>
	{/if}
	<form
		method="POST"
		action="?/org"
		class="grid gap-4"
		use:enhance={() => {
			savingOrg = true;
			return async ({ result, update }) => {
				await update({ reset: false });
				savingOrg = false;
				notify(result);
			};
		}}
	>
		<div class="grid gap-4 sm:grid-cols-3">
			<Field.Field data-invalid={errors.state ? true : undefined}>
				<Field.Label for="org-state">State</Field.Label>
				<NativeSelect.Root id="org-state" name="state" bind:value={orgState} class="w-full">
					{#each emailOrgStates as option (option)}
						<NativeSelect.Option value={option}>{ORG_STATE_COPY[option].label}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				{#if errors.state}<Field.Error>{errors.state}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.perDay ? true : undefined}>
				<Field.Label for="org-per-day">Per day</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="org-per-day"
						name="perDay"
						type="number"
						min={1}
						max={10_000_000}
						step={1}
						placeholder={String(data.emailOrg?.perDay ?? '')}
						class="font-mono text-sm"
						aria-invalid={errors.perDay ? 'true' : undefined}
					/>
					<InputGroup.Addon align="inline-end"
						><InputGroup.Text class="text-xs">messages</InputGroup.Text></InputGroup.Addon
					>
				</InputGroup.Root>
				{#if errors.perDay}<Field.Error>{errors.perDay}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.perSecond ? true : undefined}>
				<Field.Label for="org-per-second">Per second</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="org-per-second"
						name="perSecond"
						type="number"
						min={1}
						max={1000}
						step={1}
						placeholder={String(data.emailOrg?.perSecond ?? '')}
						class="font-mono text-sm"
						aria-invalid={errors.perSecond ? 'true' : undefined}
					/>
					<InputGroup.Addon align="inline-end"
						><InputGroup.Text class="text-xs">messages</InputGroup.Text></InputGroup.Addon
					>
				</InputGroup.Root>
				{#if errors.perSecond}<Field.Error>{errors.perSecond}</Field.Error>{/if}
			</Field.Field>
		</div>
		<p class="text-xs text-muted-foreground">
			{limitsHint}
			{#if data.emailOrg}
				Currently {data.emailOrg.perDay.toLocaleString('en')} a day and {data.emailOrg.perSecond} a second;
				{data.emailOrg.sentToday.toLocaleString('en')}
				sent today.
			{/if}
		</p>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<Button variant="link" class="h-auto px-0" href={resolve('/(dashboard)/email')}>
				Reputation and activity<ArrowRightIcon />
			</Button>
			<Button type="submit" disabled={savingOrg}>
				{#if savingOrg}<Spinner />{/if}
				Save limits
			</Button>
		</div>
	</form>
	{#snippet footer()}
		Only this organisation is listed here for now. Switch organisation to change another one's
		limits.
	{/snippet}
</Panel>
