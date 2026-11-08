<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SendIcon from '@lucide/svelte/icons/send';
	import ServerIcon from '@lucide/svelte/icons/server';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { EMAIL_SANDBOX_LIMITS, emailEnvNames } from '@skiff/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EnvNames from '../../_lib/service/EnvNames.svelte';
	import DomainRecords from './DomainRecords.svelte';
	import MailNodeForm from './MailNodeForm.svelte';
	import PlatformRecords from './PlatformRecords.svelte';
	import RequestAccessDialog from './RequestAccessDialog.svelte';
	import ReverseDnsCheck from './ReverseDnsCheck.svelte';
	import type { SetupStep, SetupStepId } from './setup-guide.js';
	import type { PageData } from '../$types';

	/**
	 * The one place Email is set up (docs/EMAIL.md §9): seven steps from a fresh install to an app
	 * sending real mail, each judged from live state and each doing its work in place. Platform-admin
	 * steps embed the mail server's own controls; members see what to ask for and of whom. The
	 * overview owns the step states (they feed its collapsed summary too) and passes them in.
	 */
	let {
		data,
		form,
		steps,
		onreversedns
	}: {
		data: PageData;
		form: {
			message?: string;
			fieldErrors?: Record<string, string>;
			values?: Record<string, unknown>;
		} | null;
		steps: SetupStep[];
		onreversedns: (state: import('./setup-guide.js').ReverseDnsState | null) => void;
	} = $props();

	const area = $derived(data.emailArea);
	const hostnames = $derived(area.hostnames);
	const verifiedDomains = $derived(data.domains.filter((domain) => domain.status === 'verified'));
	const errors = $derived(form?.fieldErrors ?? {});
	const request = $derived(data.accessRequest);

	/** Done steps start folded; the rest start open. Toggling one keeps it as the reader left it. */
	let folded = $state<Partial<Record<SetupStepId, boolean>>>({});
	const isOpen = (id: SetupStepId, state: string) => !(folded[id] ?? state === 'done');
	const toggle = (id: SetupStepId, state: string) => (folded[id] = isOpen(id, state));
	const stepNumber = (id: SetupStepId) => steps.findIndex((step) => step.id === id) + 1;

	let busy = $state<'check' | 'publish' | null>(null);
	async function domainAction(kind: 'check' | 'publish', name: string) {
		busy = kind;
		await runAction(kind === 'check' ? '?/checkDomain' : '?/publishDomain', { name });
		busy = null;
	}

	let adding = $state(false);
	let requestOpen = $state(false);

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

{#snippet adminOnly(what: string)}
	<p class="text-sm text-muted-foreground">
		A platform admin does this step. Ask one to {what}; they can do it from this checklist.
	</p>
{/snippet}

{#snippet code(value: string)}
	<span class="inline-flex max-w-full items-center gap-0.5 align-middle">
		<code class="truncate rounded bg-muted px-1 font-mono text-xs">{value}</code>
		<CopyButton {value} label="Copy" iconOnly variant="ghost" size="icon-xs" />
	</span>
{/snippet}

{#snippet done(text: string)}
	<p class="flex items-center gap-1.5 text-success"><CheckIcon class="size-4 shrink-0" />{text}</p>
{/snippet}

<ol class="space-y-3" aria-label="Email setup steps">
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
					{#if step.state === 'done'}<CheckIcon class="size-4" aria-label="Done" />{:else}{index +
							1}{/if}
				</span>
				<span class="flex-1 font-medium {step.state === 'upcoming' ? 'text-muted-foreground' : ''}">
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

			<!-- Hidden rather than unmounted, so the streamed reverse DNS check keeps reporting. -->
			<div id="step-{step.id}" class="space-y-3 border-t px-4 py-4 text-sm sm:pl-14" hidden={!open}>
				{#if step.id === 'node'}
					<p>
						Skiff delivers mail with its own MTA, <code class="font-mono text-xs">skiff-mail</code>,
						running on one node you choose. Recipients judge your mail partly by that node's IP, so
						pick it with care:
					</p>
					<ul class="list-disc space-y-1 pl-5 text-muted-foreground">
						<li>A public IPv4 address, not residential or home broadband space.</li>
						<li>
							Outbound port 25 open. Most clouds block it by default. On Scaleway, enable SMTP on
							the instance's security group (it needs a verified account).
						</li>
						<li>An agent recent enough to advertise mail support, usually the edge node.</li>
					</ul>
					<p>From the node, check port 25 gets out. It should print "succeeded" or "open":</p>
					<CodeBlock code={port25} label="on the mail node" />
					{#if area.can.platform}
						<MailNodeForm
							nodes={data.mailNodes}
							nodeId={data.mailNodeId}
							ip={data.mailIp}
							enabled={area.enabled}
						/>
					{/if}
					{#if area.configured}
						{@render done(`Mail node chosen. It greets as ${hostnames.helo}.`)}
					{:else if !area.can.platform}
						{@render adminOnly('pick a mail node')}
					{/if}
				{:else if step.id === 'reverse-dns'}
					<p>
						Gmail and Outlook refuse or junk mail from an IP whose reverse DNS doesn't name the host
						it greets with. Only whoever owns the IP can set this, usually in your server provider's
						console under "Reverse DNS" or "PTR".
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
								Cloudflare zone connected, Skiff published it with the other platform records{area
									.can.platform
									? ' below'
									: ''}.
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
						<ReverseDnsCheck check={data.reverseDns} ip={data.ip} onresult={onreversedns} />
						{#if area.can.platform && data.platformRecords.length > 0}
							<details class="overflow-hidden rounded-md border">
								<summary
									class="cursor-pointer bg-muted/45 px-3 py-2 text-xs font-medium select-none"
								>
									Platform DNS records ({data.platformRecords.length})
								</summary>
								<PlatformRecords records={data.platformRecords} />
							</details>
						{:else if !area.can.platform}
							{@render adminOnly('set the reverse DNS')}
						{/if}
					{/if}
				{:else if step.id === 'domain'}
					<p>
						Add the domain your mail will come from. A subdomain such as
						<span class="font-mono text-xs">mail.example.com</span> or
						<span class="font-mono text-xs">notify.example.com</span> keeps your app's reputation apart
						from the mail your people send. If its zone is in the Cloudflare account Skiff uses, Skiff
						creates the DNS records itself; otherwise the next step lists them to copy.
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
					{#if area.can.update && area.enabled}
						<form
							method="POST"
							action="?/addDomain"
							class="flex flex-wrap items-start gap-2"
							use:enhance={() => {
								adding = true;
								return async ({ result, update }) => {
									await update();
									adding = false;
									notify(result);
								};
							}}
						>
							<Field.Field class="min-w-56 flex-1" data-invalid={errors.name ? true : undefined}>
								<Field.Label for="setup-domain" class="sr-only">Domain</Field.Label>
								<Input
									id="setup-domain"
									name="name"
									placeholder="mail.example.com"
									required
									autocapitalize="off"
									autocomplete="off"
									spellcheck="false"
									class="font-mono text-sm"
									aria-invalid={errors.name ? 'true' : undefined}
								/>
								{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
							</Field.Field>
							<Button
								type="submit"
								variant={data.domains.length > 0 ? 'outline' : 'default'}
								disabled={adding}
							>
								{#if adding}<Spinner />{:else}<PlusIcon />{/if}
								{data.domains.length > 0 ? 'Add another domain' : 'Add domain'}
							</Button>
						</form>
					{:else if !area.can.update}
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
							Start DMARC at <span class="font-mono text-xs">p=none</span> and tighten it once a few weeks
							of reports look clean.
						</li>
					</ul>
					{#if data.pending}
						{@const domain = data.pending}
						<div class="overflow-hidden rounded-md border">
							<div
								class="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/45 px-3 py-2"
							>
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
												onclick={() => domainAction('publish', domain.name)}
												disabled={busy !== null}
											>
												{#if busy === 'publish'}<Spinner />{:else}<WandSparklesIcon />{/if}
												Set up for me
											</Button>
										{/if}
										<Button
											size="sm"
											variant="outline"
											onclick={() => domainAction('check', domain.name)}
											disabled={busy !== null}
										>
											{#if busy === 'check'}<Spinner />{:else}<RefreshCwIcon />{/if}
											Check DNS now
										</Button>
									</div>
								{/if}
							</div>
							<DomainRecords records={domain.records} />
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
						{@render done(
							`${verifiedDomains.map((domain) => domain.name).join(', ')} ${verifiedDomains.length === 1 ? 'is' : 'are'} verified.`
						)}
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
					{#if data.emailOrg?.state === 'sandbox'}
						<Notice tone="info" title="You're in the sandbox">
							Until step {stepNumber('sandbox')}, mail can only go to addresses at your own verified
							domains and to
							<a
								href={resolve('/(dashboard)/email/sandbox')}
								class="font-medium underline underline-offset-4">sandbox recipients</a
							>
							whose owners confirmed them, so send the test to a mailbox at {verifiedDomains[0]
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
							Needs a mail node and a verified domain (steps {stepNumber('node')} and {stepNumber(
								'verify'
							)}).
						</p>
					{:else if !area.can.send}
						<p class="text-muted-foreground">Sending needs the email:send permission.</p>
					{:else if data.delivered}
						{@render done("A message reached the recipient's mail server.")}
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
						{EMAIL_SANDBOX_LIMITS.perSecond} a second, and only to your own verified domains and confirmed
						<a href={resolve('/(dashboard)/email/sandbox')} class="underline underline-offset-4"
							>sandbox recipients</a
						>. It keeps a mistake from burning the mail node's reputation for everyone.
					</p>
					<p class="text-muted-foreground">
						Once test mail lands in the inbox with every check passing, an organisation owner or
						admin requests production access. A platform admin reviews it, moves the organisation to
						Active with its daily and per-second limits, and the requester gets an email with the
						answer.
					</p>
					{#if data.emailOrg?.state === 'paused'}
						<Notice tone="danger" title="Sending is paused">
							{data.emailOrg.pausedReason ?? 'Paused by a platform admin.'}
						</Notice>
						{#if area.can.platform}
							<Button href={resolve('/(dashboard)/email/server')}
								><ServerIcon />Resume in Mail server<ArrowRightIcon /></Button
							>
						{/if}
					{:else if data.emailOrg?.state === 'active'}
						{@render done(
							`Active: up to ${data.emailOrg.perDay.toLocaleString('en')} a day and ${data.emailOrg.perSecond} a second.`
						)}
					{:else if data.emailOrg?.state === 'sandbox'}
						{#if request?.status === 'pending'}
							<p class="flex items-center gap-2">
								<ClockIcon class="size-4 text-muted-foreground" />
								Requested {new Date(request.createdAt).toLocaleDateString('en-GB')}. Waiting for a
								platform admin; you get an email with the answer.
							</p>
						{:else if request?.status === 'denied'}
							<Notice tone="warning" title="The last request was declined">
								{request.note ?? 'No reason was given.'} Address it, then ask again.
							</Notice>
						{/if}
						<div class="flex flex-wrap gap-2">
							{#if request?.status !== 'pending' && data.canRequest && area.can.update && area.enabled}
								<Button onclick={() => (requestOpen = true)}
									><RocketIcon />Request production access</Button
								>
							{/if}
							<Button variant="outline" href={resolve('/(dashboard)/email/sandbox')}
								><FlaskConicalIcon />Sandbox recipients</Button
							>
							{#if area.can.platform}
								<Button variant="outline" href={resolve('/(dashboard)/email/requests')}
									><InboxIcon />Access requests</Button
								>
							{/if}
						</div>
						{#if request?.status !== 'pending' && !data.canRequest}
							<p class="text-muted-foreground">
								An organisation owner or admin requests production access.
							</p>
						{/if}
					{/if}
				{/if}
			</div>
		</li>
	{/each}
</ol>

{#if data.canRequest && area.can.update && area.enabled}
	<RequestAccessDialog bind:open={requestOpen} {errors} values={form?.values} />
{/if}
