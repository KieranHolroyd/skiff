<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import MailIcon from '@lucide/svelte/icons/mail';
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
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import MailNodeForm from '../_lib/MailNodeForm.svelte';
	import PlatformRecords from '../_lib/PlatformRecords.svelte';
	import ReverseDnsCheck from '../_lib/ReverseDnsCheck.svelte';
	import { ORG_STATE_COPY } from '../_lib/email-ui.js';
	import type { PageProps } from './$types';

	interface OrgFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as OrgFormResult | null)?.fieldErrors ?? {});

	const enabled = $derived(data.emailArea.enabled);
	const settings = $derived(data.settings);
	const hostnames = $derived(settings.hostnames);
	const mailNode = $derived(data.mailNode);
	const ip = $derived(settings.ip);
	const relay = $derived(data.platformMail.relay);

	let domainInput = $state('');
	let paused = $state(false);
	let orgState = $state('sandbox');
	$effect.pre(() => {
		domainInput = data.settings.mailDomainSource === 'custom' ? data.settings.mailDomain : '';
		paused = data.settings.paused;
		orgState = data.emailOrg?.state ?? 'sandbox';
	});

	let savingDomain = $state(false);
	const customDomain = $derived(settings.mailDomainSource === 'custom' ? settings.mailDomain : '');
	let savingOrg = $state(false);

	async function togglePause(next: boolean) {
		paused = next;
		const result = await runAction('?/pause', { paused: next ? 'true' : '' });
		if (result.type !== 'success') paused = !next;
	}

	const limitsHint = $derived(
		orgState === 'sandbox'
			? `Sandbox default: ${EMAIL_SANDBOX_LIMITS.perDay} a day, ${EMAIL_SANDBOX_LIMITS.perSecond} a second.`
			: `Active default: ${EMAIL_ACTIVE_DEFAULT_LIMITS.perDay.toLocaleString('en')} a day, ${EMAIL_ACTIVE_DEFAULT_LIMITS.perSecond} a second. Leave blank to keep the current limits.`
	);
</script>

<svelte:head><title>Mail server · Email · Skiff</title></svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Email · Platform"
		title="Mail server"
		description="The one mail node that sends for every organisation, the domain its host names live under, the DNS it needs and the global pause. Setting email up for the first time? The checklist on the Email overview walks through it in order."
	>
		{#if settings.nodeId}
			<StatusBadge
				status={paused ? 'paused' : 'active'}
				tone={paused ? 'warning' : 'success'}
				label={paused ? 'Delivery paused' : 'Sending'}
			/>
		{:else}
			<StatusBadge status="off" tone="neutral" label="Not set up" />
			<Button variant="outline" href={resolve('/(dashboard)/email')}
				><ListChecksIcon />Setup checklist</Button
			>
		{/if}
	</PageHeader>

	{#if !enabled}
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
		<MailNodeForm nodes={data.nodes} nodeId={settings.nodeId} ip={settings.ip} {enabled} turnOff />
		{#snippet footer()}
			Reverse DNS is checked live below. Port 25 egress, inbound reachability and blocklists are not
			checked from the dashboard yet; run <code class="font-mono"
				>nc -vz -w 5 gmail-smtp-in.l.google.com 25</code
			>
			on the node before sending real mail.
		{/snippet}
	</Panel>

	<Panel
		title="Mail domain"
		icon={GlobeIcon}
		description="The domain the mail node's host names live under. By default it is the content domain, {settings.contentDomain}; set a custom one to send from somewhere else."
	>
		<form
			method="POST"
			action="?/mailDomain"
			class="flex flex-wrap items-end gap-3"
			use:enhance={() => {
				savingDomain = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					savingDomain = false;
					notify(result);
				};
			}}
		>
			<Field.Field class="min-w-64 flex-1">
				<Field.Label for="mail-domain">Custom domain</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="mail-domain"
						name="mailDomain"
						bind:value={domainInput}
						placeholder={settings.contentDomain}
						autocomplete="off"
						spellcheck="false"
						class="font-mono"
						disabled={!enabled}
					/>
				</InputGroup.Root>
			</Field.Field>
			<Button
				type="submit"
				disabled={!enabled || savingDomain || domainInput.trim() === customDomain}
			>
				{#if savingDomain}<Spinner />{/if}
				Save
			</Button>
			{#if settings.mailDomainSource === 'custom'}
				<Button
					type="submit"
					name="reset"
					value="1"
					variant="outline"
					disabled={!enabled || savingDomain}>Use content domain</Button
				>
			{/if}
		</form>
		<p class="mt-3 text-xs text-muted-foreground">
			{#if settings.mailDomainSource === 'content'}
				Using the content domain: mail goes out as <code class="font-mono">{hostnames.helo}</code>.
			{:else if settings.mailDomainSource === 'env'}
				Set by <code class="font-mono">SKIFF_MAIL_DOMAIN</code> to
				<code class="font-mono">{settings.mailDomain}</code>. A custom domain saved here takes over
				from it.
			{:else}
				Using <code class="font-mono">{settings.mailDomain}</code>.
			{/if}
			A domain or a URL works. Changing it moves every host name below: update the PTR, publish the new
			records, and re-check organisations' SPF and MX records, which name the old hosts.
		</p>
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
					disabled={!enabled}
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
				{#if data.reverseIp}
					<div class="mt-3"><ReverseDnsCheck check={data.reverseDns} ip={data.reverseIp} /></div>
				{/if}
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
		<PlatformRecords records={data.platformRecords} />
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
		title="Platform mail"
		icon={MailIcon}
		description="Mail Skiff sends for itself, apart from what organisations send. It is kept on its own path so sign-in links and alerts still arrive when the mail node is down or its IP is listed (D22)."
	>
		{#snippet actions()}
			<StatusBadge
				status={relay ? 'active' : 'unverified'}
				tone={relay ? 'success' : 'warning'}
				label={relay ? 'Relay set' : 'No relay'}
			/>
		{/snippet}
		<DetailList>
			<dt>Sign-in links, invitations, alerts</dt>
			<dd class="text-xs">
				{#if relay}
					SMTP relay <span class="font-mono">{relay.host}:{relay.port}</span>{relay.from
						? `, from ${relay.from}`
						: ''}
				{:else}
					No SMTP relay: written to the server log only
				{/if}
			</dd>
			<dt>Sandbox verification links</dt>
			<dd class="text-xs">
				{#if settings.nodeId}
					This mail node, from <span class="font-mono">no-reply@{settings.mailDomain}</span>{data
						.platformMail.platformDkim
						? ', signed with the platform DKIM key'
						: ''}
				{:else if relay}
					SMTP relay, until a mail node is chosen
				{:else}
					Nowhere yet: choose a mail node or set a relay
				{/if}
			</dd>
			<dt>Organisations' mail</dt>
			<dd class="text-xs">
				{settings.nodeId
					? `This mail node (${mailNode?.name ?? settings.nodeId})`
					: 'Not sent until a mail node is chosen'}
			</dd>
		</DetailList>
		{#snippet footer()}
			<div class="flex w-full flex-wrap items-center justify-between gap-2">
				<span>The relay is any SMTP server; Amazon SES is the tested default.</span>
				{#if data.platformMail.canEdit}
					<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/notifications')}>
						{relay ? 'Edit relay' : 'Set up relay'}<ArrowRightIcon />
					</Button>
				{:else}
					<span
						>An organisation owner who is a platform admin sets it in Settings → Notifications.</span
					>
				{/if}
			</div>
		{/snippet}
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
							<NativeSelect.Option value={option}
								>{ORG_STATE_COPY[option].label}</NativeSelect.Option
							>
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
					Currently {data.emailOrg.perDay.toLocaleString('en')} a day and {data.emailOrg.perSecond} a
					second;
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
</div>
