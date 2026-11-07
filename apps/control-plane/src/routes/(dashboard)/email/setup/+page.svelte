<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PartyPopperIcon from '@lucide/svelte/icons/party-popper';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import XIcon from '@lucide/svelte/icons/x';
	import { EMAIL_SANDBOX_LIMITS, emailEnvNames } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import EnvNames from '../../_lib/service/EnvNames.svelte';
	import { recordState } from '../_lib/email-ui.js';
	import {
		setupProgress,
		setupSteps,
		type ReverseDnsState,
		type SetupStepId
	} from '../_lib/setup-guide.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const area = $derived(data.emailArea);
	const hostnames = $derived(area.hostnames);

	// The reverse DNS check streams in after the page renders.
	let reverseDns = $state<Awaited<NonNullable<PageProps['data']['reverseDns']>> | null>(null);
	let checkingReverse = $state(false);
	$effect(() => {
		const pending = data.reverseDns;
		reverseDns = null;
		if (!pending) return;
		checkingReverse = true;
		let current = true;
		pending
			.then((result) => {
				if (current) reverseDns = result;
			})
			.finally(() => {
				if (current) checkingReverse = false;
			});
		return () => {
			current = false;
		};
	});

	const verifiedDomains = $derived(data.domains.filter((domain) => domain.status === 'verified'));
	const steps = $derived(
		setupSteps({
			nodeChosen: area.configured,
			reverseDns: reverseDns?.state ?? null,
			domains: data.domains.length,
			verifiedDomains: verifiedDomains.length,
			delivered: data.delivered,
			credentials: data.credentials,
			appSent: data.appSent,
			orgState: data.org?.state ?? null
		})
	);
	const progress = $derived(setupProgress(steps));

	/** Done steps start folded; the rest start open. Toggling one keeps it as the reader left it. */
	let folded = $state<Partial<Record<SetupStepId, boolean>>>({});
	const isOpen = (id: SetupStepId, state: string) => !(folded[id] ?? state === 'done');
	const toggle = (id: SetupStepId, state: string) => (folded[id] = isOpen(id, state));

	const REVERSE_COPY: Record<ReverseDnsState, { tone: 'success' | 'warning' | 'danger'; text: string }> =
		{
			ok: { tone: 'success', text: 'Reverse DNS checks out in both directions.' },
			missing: { tone: 'danger', text: 'No PTR record found for this IP yet.' },
			mismatch: {
				tone: 'warning',
				text: "The PTR record or the A record doesn't match yet. Both must name each other."
			},
			unknown: {
				tone: 'warning',
				text: "Couldn't complete the DNS lookups from the control plane. Try again in a minute."
			}
		};

	const PURPOSE: Record<string, string> = { dkim: 'DKIM', spf: 'SPF', dmarc: 'DMARC', mx: 'MX' };
	const valueOf = (record: { priority?: number; value: string }) =>
		record.priority !== undefined ? `${record.priority} ${record.value}` : record.value;

	let checkingDomain = $state(false);
	async function checkDomain(name: string) {
		checkingDomain = true;
		await runAction('?/check', { name });
		checkingDomain = false;
	}

	let settingUp = $state(false);
	async function setupDomain(name: string) {
		settingUp = true;
		await runAction('?/setup', { name });
		settingUp = false;
	}

	async function recheck() {
		await invalidateAll();
	}

	const sender = $derived(verifiedDomains[0]?.name ?? data.pending?.name ?? 'example.com');
	const port25 = 'nc -vz -w 5 gmail-smtp-in.l.google.com 25';
	const attachCommand = 'skif email attach -p <project>';
	const curl = $derived(
		[
			`curl -X POST ${data.apiBase}/send \\`,
			`  -H "Authorization: Bearer $SKIFF_API_KEY" \\`,
			`  -H "Content-Type: application/json" \\`,
			`  -d '{`,
			`    "from": { "name": "My App", "address": "hello@${sender}" },`,
			`    "to": ["you@${sender}"],`,
			`    "subject": "Hello from Skiff",`,
			`    "text": "Sent through my own mail node."`,
			`  }'`
		].join('\n')
	);
	const nodemailer = $derived(
		[
			`import nodemailer from 'nodemailer';`,
			``,
			`// skif email attach injects these into the project's environment.`,
			`const mail = nodemailer.createTransport(process.env.SMTP_URL);`,
			``,
			`await mail.sendMail({`,
			`  from: 'My App <hello@${sender}>',`,
			`  to: 'you@${sender}',`,
			`  subject: 'Hello from Skiff',`,
			`  text: 'Sent through my own mail node.'`,
			`});`
		].join('\n')
	);
</script>

<svelte:head>
	<title>Setup guide · Email · Skiff</title>
</svelte:head>

{#snippet adminOnly(what: string)}
	<p class="text-sm text-muted-foreground">
		A platform admin does this step. Ask one to {what} in Settings → Email.
	</p>
{/snippet}

{#snippet code(value: string)}
	<span class="inline-flex max-w-full items-center gap-0.5 align-middle">
		<code class="truncate rounded bg-muted px-1 font-mono text-xs">{value}</code>
		<CopyButton {value} label="Copy" iconOnly variant="ghost" size="icon-xs" />
	</span>
{/snippet}

<div class="space-y-6">
	<PageHeader
		eyebrow="Email"
		title="Set up email"
		description="From a fresh install to your app sending real mail, one step at a time. Each step checks itself against live state, so come back to this page whenever you're unsure what's next."
	>
		<Button variant="outline" onclick={recheck}><RefreshCwIcon />Check again</Button>
	</PageHeader>

	{#if !area.enabled}
		<Notice tone="warning" title="Email is switched off">
			Set <code class="font-mono">SKIFF_FEATURE_EMAIL=1</code> and restart the control plane before
			following this guide.
		</Notice>
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Email is not visible"
			description="This account does not have the email:read permission."
		/>
	{:else}
		<div class="space-y-2">
			<div class="flex items-center justify-between text-sm">
				<span class="font-medium">{progress.done} of {progress.total} steps done</span>
				{#if progress.complete}
					<span class="text-success">All set</span>
				{/if}
			</div>
			<Progress value={progress.percent} aria-label="Setup progress" />
		</div>

		{#if progress.complete}
			<Notice tone="success" title="Email is set up">
				Your mail node is live, a domain is verified and your app can send. Keep an eye on bounces and
				complaints on the <a href={resolve('/(dashboard)/email')} class="font-medium underline underline-offset-4"
					>overview</a
				>: sending pauses automatically if they climb.
			</Notice>
		{/if}

		<ol class="space-y-3">
			{#each steps as step, index (step.id)}
				{@const open = isOpen(step.id, step.state)}
				<li
					class="rounded-xl border bg-card text-card-foreground shadow-xs {step.state === 'current'
						? 'ring-2 ring-primary/30'
						: ''}"
				>
					<button
						type="button"
						class="flex w-full items-center gap-3 px-4 py-3.5 text-left"
						aria-expanded={open}
						aria-controls="step-{step.id}"
						onclick={() => toggle(step.id, step.state)}
					>
						<span
							class="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums {step.state ===
							'done'
								? 'border-success bg-success text-white'
								: step.state === 'current'
									? 'border-primary text-primary'
									: 'text-muted-foreground'}"
						>
							{#if step.state === 'done'}<CheckIcon class="size-4" aria-label="Done" />{:else}{index + 1}{/if}
						</span>
						<span
							class="flex-1 font-medium {step.state === 'upcoming' ? 'text-muted-foreground' : ''}"
						>
							{step.title}
						</span>
						{#if step.owner === 'platform'}
							<Badge variant="outline" class="hidden font-normal sm:inline-flex">Platform admin</Badge>
						{/if}
						{#if step.state === 'current'}
							<Badge class="font-normal">Next</Badge>
						{/if}
						<ChevronDownIcon
							class="size-4 shrink-0 text-muted-foreground transition-transform {open
								? 'rotate-180'
								: ''}"
						/>
					</button>

					{#if open}
						<div id="step-{step.id}" class="space-y-3 border-t px-4 py-4 text-sm sm:pl-14">
							{#if step.id === 'node'}
								<p>
									Skiff delivers mail with its own MTA, <code class="font-mono text-xs">skiff-mail</code
									>, running on one node you choose. Recipients judge your mail partly by that node's IP,
									so pick it with care:
								</p>
								<ul class="list-disc space-y-1 pl-5 text-muted-foreground">
									<li>A public IPv4 address, not residential or home broadband space.</li>
									<li>
										Outbound port 25 open. Most clouds block it by default. On Scaleway, enable SMTP on the
										instance's security group (it needs a verified account).
									</li>
									<li>An agent recent enough to advertise mail support, usually the edge node.</li>
								</ul>
								<p>From the node, check port 25 gets out. It should print "succeeded" or "open":</p>
								<CodeBlock code={port25} label="on the mail node" />
								{#if area.configured}
									<p class="flex items-center gap-1.5 text-success">
										<CheckIcon class="size-4" />Mail node chosen. It greets as {@render code(hostnames.helo)}
									</p>
								{:else if area.can.platform}
									<Button href={resolve('/(dashboard)/settings/email')}
										><SettingsIcon />Choose a mail node</Button
									>
								{:else}
									{@render adminOnly('pick a mail node')}
								{/if}
							{:else if step.id === 'reverse-dns'}
								<p>
									Gmail and Outlook refuse or junk mail from an IP whose reverse DNS doesn't name the
									host it greets with. Only whoever owns the IP can set this, usually in your server
									provider's console under "Reverse DNS" or "PTR".
								</p>
								{#if !data.ip}
									<p class="text-muted-foreground">
										Choose a mail node with a public IPv4 address first; the exact values appear here.
									</p>
								{:else}
									<ol class="list-decimal space-y-2 pl-5">
										<li>
											Set the reverse DNS of {@render code(data.ip)} to {@render code(hostnames.helo)}.
										</li>
										<li>
											Make sure {@render code(hostnames.helo)} resolves to {data.ip}. With the platform's
											Cloudflare zone connected, Skiff published it with the other
											{#if area.can.platform}
												<a
													href={resolve('/(dashboard)/settings/email')}
													class="underline underline-offset-4">platform records</a
												>.
											{:else}
												platform records.
											{/if}
										</li>
										<li>
											Check the IP isn't on a blocklist at
											<a
												href="https://check.spamhaus.org/"
												target="_blank"
												rel="noreferrer"
												class="inline-flex items-center gap-0.5 underline underline-offset-4"
												>Spamhaus<ExternalLinkIcon class="size-3" /></a
											>. A listed IP has to be delisted before mail lands in inboxes.
										</li>
									</ol>
									<div class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5">
										{#if checkingReverse || !reverseDns}
											<Spinner />
											<span class="text-muted-foreground">Looking up {data.ip}…</span>
										{:else}
											{@const copy = REVERSE_COPY[reverseDns.state]}
											{#if reverseDns.state === 'ok'}
												<CheckIcon class="size-4 text-success" />
											{:else}
												<XIcon class="size-4 {copy.tone === 'danger' ? 'text-destructive' : 'text-warning'}" />
											{/if}
											<span class="flex-1">
												{copy.text}
												{#if reverseDns.ptr.length > 0 && reverseDns.state !== 'ok'}
													<span class="text-muted-foreground">
														PTR returns <span class="font-mono text-xs">{reverseDns.ptr.join(', ')}</span>.
													</span>
												{/if}
											</span>
											<Button variant="outline" size="sm" onclick={recheck}><RefreshCwIcon />Check again</Button>
										{/if}
									</div>
									{#if !area.can.platform}
										{@render adminOnly('set the reverse DNS')}
									{/if}
								{/if}
							{:else if step.id === 'domain'}
								<p>
									Add the domain your mail will come from. A subdomain such as
									<span class="font-mono text-xs">mail.example.com</span> or
									<span class="font-mono text-xs">notify.example.com</span> keeps your app's reputation
									apart from the mail your people send.
								</p>
								<p class="text-muted-foreground">
									If the domain's zone is in the Cloudflare account Skiff uses, Skiff creates the DNS
									records itself. Otherwise you get a list to copy.
								</p>
								{#if data.domains.length > 0}
									<ul class="flex flex-wrap gap-2">
										{#each data.domains as domain (domain.name)}
											<li>
												<a
													href={resolve('/(dashboard)/email/domains/[name]', { name: domain.name })}
													class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs hover:bg-muted"
												>
													<GlobeIcon class="size-3.5 text-muted-foreground" />{domain.name}
												</a>
											</li>
										{/each}
									</ul>
								{/if}
								{#if area.can.update}
									<Button
										variant={data.domains.length > 0 ? 'outline' : 'default'}
										href={resolve('/(dashboard)/email/domains')}
									>
										<GlobeIcon />{data.domains.length > 0 ? 'Add another domain' : 'Add a domain'}
									</Button>
								{:else}
									<p class="text-muted-foreground">Adding a domain needs the email:update permission.</p>
								{/if}
							{:else if step.id === 'verify'}
								<p>
									Skiff signs every message with a DKIM key made for your domain. Publishing the key in
									DNS proves you control the domain and verifies it. SPF and DMARC aren't required to
									verify, but Gmail and Yahoo expect both before they trust bulk mail.
								</p>
								<ul class="list-disc space-y-1 pl-5 text-muted-foreground">
									<li>
										If the domain already has an SPF record, add the <span class="font-mono text-xs"
											>include:</span
										> to it. A domain with two SPF records fails SPF everywhere.
									</li>
									<li>
										Start DMARC at <span class="font-mono text-xs">p=none</span> and tighten it once a few
										weeks of reports look clean.
									</li>
								</ul>
								{#if data.pending}
									{@const domain = data.pending}
									<div class="overflow-hidden rounded-md border">
										<div class="flex items-center justify-between gap-2 border-b bg-muted/45 px-3 py-2">
											<a
												href={resolve('/(dashboard)/email/domains/[name]', { name: domain.name })}
												class="font-mono text-xs font-medium underline-offset-4 hover:underline"
												>{domain.name}</a
											>
											{#if area.can.update}
												<div class="flex flex-wrap items-center gap-2">
													{#if data.pendingAutoDns}
														<Button
															size="sm"
															onclick={() => setupDomain(domain.name)}
															disabled={settingUp || checkingDomain}
														>
															{#if settingUp}<Spinner />{:else}<WandSparklesIcon />{/if}
															Set up for me
														</Button>
													{/if}
													<Button
														size="sm"
														variant="outline"
														onclick={() => checkDomain(domain.name)}
														disabled={checkingDomain || settingUp}
													>
														{#if checkingDomain}<Spinner />{:else}<RefreshCwIcon />{/if}
														Check DNS now
													</Button>
												</div>
											{/if}
										</div>
										<ul class="divide-y">
											{#each domain.records as record (record.purpose + record.name)}
												{@const state = recordState(record)}
												<li class="grid gap-1 px-3 py-2.5 sm:grid-cols-[7rem_1fr_auto] sm:items-start sm:gap-3">
													<div>
														<p class="font-medium">
															{PURPOSE[record.purpose] ?? record.purpose}
															<span class="font-mono text-xs text-muted-foreground">{record.type}</span>
														</p>
														<p class="text-xs text-muted-foreground">
															{record.required ? 'Required' : 'Recommended'}
														</p>
													</div>
													<div class="min-w-0 space-y-1">
														<p class="flex min-w-0 items-center gap-1">
															<span class="w-10 shrink-0 text-xs text-muted-foreground">Name</span>
															<span class="truncate font-mono text-xs" title={record.name}>{record.name}</span>
															<CopyButton value={record.name} label="Copy name" iconOnly variant="ghost" size="icon-xs" />
														</p>
														<p class="flex min-w-0 items-center gap-1">
															<span class="w-10 shrink-0 text-xs text-muted-foreground">Value</span>
															<span class="truncate font-mono text-xs" title={valueOf(record)}>{valueOf(record)}</span>
															<CopyButton value={valueOf(record)} label="Copy value" iconOnly variant="ghost" size="icon-xs" />
														</p>
														{#if record.note}
															<p class="text-xs text-muted-foreground">{record.note}</p>
														{/if}
													</div>
													<span class="flex items-center gap-1.5 text-xs">
														{#if state === 'ok'}
															<CheckIcon class="size-4 text-success" aria-hidden="true" />Found
														{:else}
															<XIcon
																class="size-4 {state === 'missing' ? 'text-destructive' : 'text-warning'}"
																aria-hidden="true"
															/>{state === 'missing' ? 'Missing' : 'Not found'}
														{/if}
													</span>
												</li>
											{/each}
										</ul>
									</div>
									{#if data.pendingAutoDns && area.can.update}
										<p class="text-xs text-muted-foreground">
											{domain.name} is in the Cloudflare zone Skiff has a token for, so
											<span class="font-medium text-foreground">Set up for me</span> creates the DKIM record,
											plus SPF and DMARC where the domain has none. Existing SPF and DMARC records are never
											overwritten.
										</p>
									{/if}
									<p class="text-xs text-muted-foreground">
										New records usually show up within a few minutes, sometimes up to an hour. Skiff also
										re-checks every domain daily.
									</p>
								{:else if verifiedDomains.length > 0}
									<p class="flex items-center gap-1.5 text-success">
										<CheckIcon class="size-4" />
										{verifiedDomains.map((domain) => domain.name).join(', ')}
										{verifiedDomains.length === 1 ? 'is' : 'are'} verified.
									</p>
								{:else}
									<p class="text-muted-foreground">Add a domain first; its records appear here.</p>
								{/if}
							{:else if step.id === 'test'}
								<p>
									Send one real message to a mailbox you can read, then open it and look at the headers
									(in Gmail: <span class="italic">Show original</span>). You want
									<span class="font-mono text-xs">DKIM: PASS</span>,
									<span class="font-mono text-xs">SPF: PASS</span> and
									<span class="font-mono text-xs">DMARC: PASS</span>, and the message in the inbox, not
									spam.
								</p>
								{#if data.org?.state === 'sandbox'}
									<Notice tone="info" title="You're in the sandbox">
										Until step 7, mail can only go to addresses at your own verified domains and to
										<a
											href={resolve('/(dashboard)/email/sandbox')}
											class="font-medium underline underline-offset-4">sandbox recipients</a
										> whose owners confirmed them, so send the test to a mailbox at {verifiedDomains[0]
											?.name ?? 'your domain'} or add one you can read.
									</Notice>
								{/if}
								<div class="flex flex-wrap gap-2">
									{#if verifiedDomains.length > 0 && area.can.send && area.configured}
										<Button
											variant={data.delivered ? 'outline' : 'default'}
											href={resolve('/(dashboard)/email/send')}><SendIcon />Send a test</Button
										>
									{/if}
									<Button variant="outline" href={resolve('/(dashboard)/email/activity')}
										><ActivityIcon />Activity</Button
									>
								</div>
								{#if !area.configured || verifiedDomains.length === 0}
									<p class="text-muted-foreground">
										Needs a mail node and a verified domain (steps 1 and 4).
									</p>
								{:else if !area.can.send}
									<p class="text-muted-foreground">Sending needs the email:send permission.</p>
								{:else if data.delivered}
									<p class="flex items-center gap-1.5 text-success">
										<CheckIcon class="size-4" />A message reached the recipient's mail server.
									</p>
								{/if}
							{:else if step.id === 'connect'}
								<p>Apps send the same mail two ways. Use whichever your framework already speaks.</p>
								<div class="space-y-2">
									<h3 class="font-medium">SMTP, for any mailer library</h3>
									<p class="text-muted-foreground">
										Attach email to a Skiff project and its next deploy gets a project-scoped credential
										as environment variables:
									</p>
									<CodeBlock code={attachCommand} />
									<EnvNames names={emailEnvNames('SMTP')} limit={6} />
									<CodeBlock code={nodemailer} label="send.ts" />
									<p class="text-muted-foreground">
										Running elsewhere? Create a credential by hand and point your app at
										{@render code(hostnames.submission)} on port 587 (STARTTLS) or 465 (TLS).
									</p>
									{#if area.can.credentials}
										<Button variant="outline" href={resolve('/(dashboard)/email/credentials')}
											><KeyRoundIcon />SMTP credentials</Button
										>
									{/if}
								</div>
								<div class="space-y-2 pt-2">
									<h3 class="font-medium">HTTP, with an API key</h3>
									<p class="text-muted-foreground">
										Any Skiff API key with the email:send permission works as a Bearer token.
									</p>
									<CodeBlock code={curl} />
									<Button variant="outline" href={resolve('/(dashboard)/settings/api-keys')}
										><KeyRoundIcon />API keys</Button
									>
								</div>
							{:else if step.id === 'sandbox'}
								<p>
									Every organisation starts in the sandbox: {EMAIL_SANDBOX_LIMITS.perDay} messages a day,
									{EMAIL_SANDBOX_LIMITS.perSecond} a second, and only to your own verified domains and
									confirmed sandbox recipients. It keeps a mistake from burning the mail node's reputation
									for everyone.
								</p>
								<p class="text-muted-foreground">
									Once test mail lands in the inbox with every check passing, an organisation owner or admin
									requests production access. A platform admin reviews it, moves the organisation to Active
									with its daily and per-second limits, and the requester gets an email with the answer.
								</p>
								{#if data.org?.state === 'paused'}
									<Notice tone="danger" title="Sending is paused">
										{data.org.pausedReason ?? 'Paused by a platform admin.'}
									</Notice>
								{:else if data.org?.state === 'active'}
									<p class="flex items-center gap-1.5 text-success">
										<CheckIcon class="size-4" />Active: up to {data.org.perDay.toLocaleString('en')} a day
										and {data.org.perSecond} a second.
									</p>
								{/if}
								{#if data.org?.state === 'sandbox'}
									<div class="flex flex-wrap gap-2">
										<Button href={resolve('/(dashboard)/email/sandbox')}
											><RocketIcon />Request production access<ArrowRightIcon /></Button
										>
										{#if area.can.platform}
											<Button variant="outline" href={resolve('/(dashboard)/email/requests')}
												><InboxIcon />Access requests</Button
											>
										{/if}
									</div>
								{:else if data.org?.state === 'paused' && area.can.platform}
									<Button href={resolve('/(dashboard)/settings/email')}
										><SettingsIcon />Resume sending<ArrowRightIcon /></Button
									>
								{/if}
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ol>

		{#if progress.complete}
			<EmptyState
				compact
				icon={PartyPopperIcon}
				title="Before you send in volume"
				description="Add a List-Unsubscribe header to bulk mail (the send API's unsubscribe field does it), remove addresses that bounce, and raise DMARC to quarantine once its reports are clean."
			/>
		{/if}
	{/if}
</div>
