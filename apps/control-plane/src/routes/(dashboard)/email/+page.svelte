<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SendIcon from '@lucide/svelte/icons/send';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { EMAIL_REPUTATION } from '@yoal/contracts';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import { formatRelative } from '../_lib/format.js';
	import RateGauge from './_lib/RateGauge.svelte';
	import SetupChecklist from './_lib/SetupChecklist.svelte';
	import { setupProgress, setupSteps, type ReverseDnsState } from './_lib/setup-guide.js';
	import {
		ORG_STATE_COPY,
		formatRate,
		messageStatusTone,
		quotaUse,
		reputationGauges
	} from './_lib/email-ui.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const area = $derived(data.emailArea);
	const org = $derived(data.emailOrg);
	const stateCopy = $derived(org ? ORG_STATE_COPY[org.state] : null);
	const gauges = $derived(org ? reputationGauges(org) : null);
	const quota = $derived(org ? quotaUse(org.sentToday, org.perDay) : null);
	const verified = $derived(data.domains.filter((domain) => domain.status === 'verified').length);
	const fmt = (value: number) => value.toLocaleString('en');

	// The reverse DNS check streams in; until it answers its step counts as pending.
	let reverseDns = $state<ReverseDnsState | null>(null);
	const steps = $derived(
		setupSteps({
			nodeChosen: area.configured,
			reverseDns,
			domains: data.domains.length,
			verifiedDomains: verified,
			delivered: data.delivered,
			credentials: data.credentials,
			appSent: data.appSent,
			orgState: org?.state ?? null
		})
	);
	const progress = $derived(setupProgress(steps));
	/** Every step done, counting a reverse DNS lookup still in flight, so the page doesn't jump. */
	const settled = $derived(
		steps.every(
			(step) =>
				step.state === 'done' ||
				(step.id === 'reverse-dns' && reverseDns === null && data.reverseDns !== null)
		)
	);
	let showChecklist = $state(false);
</script>

<svelte:head>
	<title>Email · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email"
		eyebrow="Workloads"
		title="Email"
		description="Send mail from your own verified domains through Yoal's MTA, over the REST API, SMTP or a function binding."
	>
		{#if area.configured && area.can.send && area.enabled}
			<Button variant="outline" href={resolve('/(dashboard)/email/send')}
				><SendIcon />Send a test</Button
			>
		{/if}
		{#if area.configured && area.can.update && area.enabled}
			<Button href={resolve('/(dashboard)/email/domains')}><PlusIcon />Add domain</Button>
		{/if}
	</PageHeader>

	{#if !area.enabled}
		<Notice tone="warning" title="Email is switched off">
			Set <code class="font-mono">YOAL_FEATURE_EMAIL=1</code> to add domains and send. Existing settings
			are kept.
		</Notice>
	{/if}

	{#if data.denied || !org || !stateCopy || !gauges || !quota}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Email is not visible"
			description="This account does not have the email:read permission."
		/>
	{:else}
		<section aria-labelledby="email-setup" class="space-y-3">
			{#if settled}
				<div
					class="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs"
				>
					<ListChecksIcon class="size-4 text-success" />
					<span id="email-setup" class="flex-1">
						<span class="font-medium">Email is set up.</span>
						<span class="text-muted-foreground">
							All {progress.total} setup steps are done. Keep an eye on bounces and complaints below:
							sending pauses automatically if they climb.
						</span>
					</span>
					<Button variant="ghost" size="sm" onclick={() => (showChecklist = !showChecklist)}>
						{showChecklist ? 'Hide checklist' : 'Show checklist'}
					</Button>
				</div>
			{:else}
				<div class="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h2 id="email-setup" class="font-semibold">Set up email</h2>
						<p class="text-sm text-muted-foreground">
							From a fresh install to your app sending real mail. Each step checks itself against
							live state and does its work right here.
						</p>
					</div>
					<Button variant="outline" size="sm" onclick={() => invalidateAll()}
						><RefreshCwIcon />Check again</Button
					>
				</div>
				<div class="space-y-1.5">
					<p class="text-xs font-medium">{progress.done} of {progress.total} steps done</p>
					<Progress value={progress.percent} aria-label="Setup progress" />
				</div>
			{/if}
			<div hidden={settled && !showChecklist}>
				<SetupChecklist {data} {form} {steps} onreversedns={(state) => (reverseDns = state)} />
			</div>
		</section>

		{#if area.configured}
			{#if area.paused}
				<Notice tone="warning" title="Delivery is paused platform-wide">
					A platform admin paused outgoing mail. Sends are still accepted and queued; nothing leaves
					the mail node until delivery resumes.
				</Notice>
			{/if}
			{#if org.state === 'paused'}
				<Notice tone="danger" title="Sending is paused for this organisation">
					{org.pausedReason ?? 'Paused by a platform admin.'}
					{#if area.can.platform}
						Resume it in <a
							href={resolve('/(dashboard)/email/server')}
							class="font-medium underline underline-offset-4">Mail server</a
						>.
					{:else}
						A platform admin can resume it once the cause is fixed.
					{/if}
				</Notice>
			{:else if gauges.bounce.level === 'warn' || gauges.complaint.level === 'warn'}
				<Notice tone="warning" title="Reputation is above the warning level">
					Sending pauses automatically at {formatRate(EMAIL_REPUTATION.bouncePause, 0)} hard bounces or
					{formatRate(EMAIL_REPUTATION.complaintPause, 1)} complaints. Remove stale addresses and check
					what recipients signed up for.
				</Notice>
			{/if}

			<div class="grid items-start gap-5 xl:grid-cols-5">
				<Panel title="Sending" icon={ShieldCheckIcon} class="xl:col-span-2">
					{#snippet actions()}
						<StatusBadge status={org.state} label={stateCopy.label} tone={stateCopy.tone} />
					{/snippet}
					<p class="mb-3 text-sm text-muted-foreground">{stateCopy.summary}</p>
					<DetailList>
						<dt>Sent today</dt>
						<dd class="font-mono text-xs tabular-nums">
							{fmt(org.sentToday)} of {fmt(org.perDay)}
						</dd>
						<dt>Daily limit</dt>
						<dd class="font-mono text-xs tabular-nums">{fmt(org.perDay)} messages</dd>
						<dt>Rate limit</dt>
						<dd class="font-mono text-xs tabular-nums">{fmt(org.perSecond)} a second</dd>
						<dt>Domains</dt>
						<dd class="text-xs">{verified} verified of {data.domains.length}</dd>
					</DetailList>
					<div class="mt-4 space-y-1.5">
						<Progress value={quota.percent} aria-label="Daily limit used" />
						<p class="text-xs text-muted-foreground">
							{Math.round(quota.percent)}% of today's limit (resets at 00:00 UTC).
						</p>
					</div>
					{#if org.state === 'sandbox'}
						<Button
							variant="outline"
							size="sm"
							class="mt-4"
							href={resolve('/(dashboard)/email/sandbox')}
							><FlaskConicalIcon />Sandbox recipients and production access<ArrowRightIcon
							/></Button
						>
					{/if}
				</Panel>

				<Panel
					title="Reputation"
					icon={GaugeIcon}
					description="Hard bounces and complaints over the last {fmt(
						EMAIL_REPUTATION.windowMessages
					)} messages or {EMAIL_REPUTATION.windowDays} days."
					class="xl:col-span-3"
				>
					<div class="grid gap-6 sm:grid-cols-2">
						<RateGauge
							label="Hard-bounce rate"
							gauge={gauges.bounce}
							warn={formatRate(EMAIL_REPUTATION.bounceWarn, 0)}
							pause={formatRate(EMAIL_REPUTATION.bouncePause, 0)}
						/>
						<RateGauge
							label="Complaint rate"
							gauge={gauges.complaint}
							warn={formatRate(EMAIL_REPUTATION.complaintWarn, 1)}
							pause={formatRate(EMAIL_REPUTATION.complaintPause, 1)}
						/>
					</div>
					{#snippet footer()}
						{#if gauges.enough}
							Measured over {fmt(org.windowMessages)} recent messages. Crossing a pause level stops sending
							until a platform admin resumes it.
						{:else}
							Rates are judged once {fmt(EMAIL_REPUTATION.minMessages)} messages are in the window ({fmt(
								org.windowMessages
							)} so far).
						{/if}
					{/snippet}
				</Panel>
			</div>

			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Panel title="Domains" icon={GlobeIcon} count={data.domains.length} flush>
					{#snippet actions()}
						<Button variant="outline" size="sm" href={resolve('/(dashboard)/email/domains')}>
							Manage<ArrowRightIcon />
						</Button>
					{/snippet}
					{#if data.domains.length === 0}
						<EmptyState
							compact
							icon={GlobeIcon}
							title="No sending domains"
							description="Add a domain you own and publish its DKIM record to start sending from it."
						/>
					{:else}
						<ul class="divide-y">
							{#each data.domains.slice(0, 6) as domain (domain.name)}
								<li class="flex items-center justify-between gap-3 px-4 py-2.5">
									<a
										href={resolve('/(dashboard)/email/domains/[name]', { name: domain.name })}
										class="truncate font-mono text-sm underline-offset-4 hover:underline"
										>{domain.name}</a
									>
									<span class="flex items-center gap-2">
										{#if !domain.sending}<span class="text-xs text-muted-foreground"
												>sending off</span
											>{/if}
										<StatusBadge status={domain.status} />
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</Panel>

				<Panel title="Recent activity" icon={ActivityIcon} flush>
					{#snippet actions()}
						<Button variant="outline" size="sm" href={resolve('/(dashboard)/email/activity')}>
							All activity<ArrowRightIcon />
						</Button>
					{/snippet}
					{#if data.recent.length === 0}
						<EmptyState
							compact
							icon={ActivityIcon}
							title="Nothing sent yet"
							description="Messages show here as they are accepted, delivered, deferred or bounced."
						/>
					{:else}
						<ul class="divide-y">
							{#each data.recent as message (message.id)}
								<li class="flex items-center justify-between gap-3 px-4 py-2.5">
									<div class="min-w-0">
										<a
											href={resolve('/(dashboard)/email/activity/[id]', { id: message.id })}
											class="block truncate text-sm font-medium underline-offset-4 hover:underline"
											>{message.subject || '(no subject)'}</a
										>
										<p class="truncate font-mono text-xs text-muted-foreground">
											{message.recipients.map((recipient) => recipient.address).join(', ')}
										</p>
									</div>
									<span class="flex shrink-0 items-center gap-2">
										<time class="text-xs text-muted-foreground" datetime={message.createdAt}
											>{formatRelative(message.createdAt)}</time
										>
										<StatusBadge status={message.status} tone={messageStatusTone(message.status)} />
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</Panel>
			</div>
		{/if}
	{/if}
</div>
