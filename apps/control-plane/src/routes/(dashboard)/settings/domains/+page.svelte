<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import InfoIcon from '@lucide/svelte/icons/info';
	import LockIcon from '@lucide/svelte/icons/lock';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import ConfigProgress from '../ConfigProgress.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	interface DnsProbe {
		display: string;
		addresses: string[];
		status: 'here' | 'elsewhere' | 'missing';
	}
	interface DomainsFormResult {
		message?: string;
		success?: string;
		fieldErrors?: Record<string, string>;
		values?: { platformHost: string; contentDomain: string; tls: boolean; acmeEmail: string; confirmDns: boolean };
		dns?: { platform: DnsProbe | null; content: DnsProbe; address: string | null };
		needsConfirm?: boolean;
		checked?: boolean;
		newOrigin?: string;
		hostChanges?: boolean;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as DomainsFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	// svelte-ignore state_referenced_locally
	const initial = result?.values ?? data.current;
	let platformHost = $state(initial.platformHost);
	let contentDomain = $state(initial.contentDomain);
	let tls = $state(initial.tls);
	let acmeEmail = $state(initial.acmeEmail);
	let pending = $state<'check' | 'save' | null>(null);

	const canEdit = $derived(data.availability === 'ready');
	const ready = $derived(canEdit && !data.inFlight);
	const hostChanges = $derived(
		platformHost.trim().toLowerCase() !== data.current.platformHost || tls !== data.current.tls
	);
	const nextOrigin = $derived(`${tls ? 'https' : 'http'}://${platformHost.trim().toLowerCase() || '…'}`);
	const ipLike = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim());

	const submitting = ({ submitter }: { submitter: HTMLElement | null }) => {
		pending = submitter?.getAttribute('formaction') === '?/check' ? 'check' : 'save';
		return async ({ update }: { update: (options?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			pending = null;
		};
	};

	const statusLabel: Record<DnsProbe['status'], string> = {
		here: 'points at this server',
		elsewhere: 'points somewhere else',
		missing: 'does not resolve yet'
	};
</script>

<svelte:head>
	<title>Domains · Settings · Skiff</title>
</svelte:head>

<SettingsHeader id="domains" />

<div class="space-y-5">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['domains']}
	/>

	{#if result?.newOrigin}
		<Alert.Root variant="info">
			<InfoIcon />
			<Alert.Title>Skiff is moving to {result.newOrigin}</Alert.Title>
			<Alert.Description>
				{#if result.hostChanges}
					This page stops responding once the move finishes (about a minute, longer while an HTTPS
					certificate is issued). Then sign in again at the new address with your password and
					authenticator code. If the new address doesn’t answer, the previous domains are restored
					automatically and this page comes back.
				{:else}
					Sites move to the new content domain once the control plane restarts (about a minute).
				{/if}
			</Alert.Description>
			{#if result.hostChanges}
				<div class="mt-2">
					<Button size="sm" href={`${result.newOrigin}/login`} target="_blank" rel="noopener">
						Open {result.newOrigin}
						<ArrowRightIcon />
					</Button>
				</div>
			{/if}
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				<GlobeIcon class="size-4 text-muted-foreground" />Current address
				{#if data.current.ipOnly || data.current.temporaryContent}<Badge variant="warning"
						>temporary</Badge
					>{/if}
				<Badge variant={data.current.tls ? 'success' : 'neutral'}
					>{data.current.tls ? 'HTTPS' : 'HTTP only'}</Badge
				>
			</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<dl class="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
				<dt class="text-muted-foreground">Dashboard, API, MCP</dt>
				<dd class="font-mono break-all">{data.current.origin}</dd>
				<dt class="text-muted-foreground">Sites</dt>
				<dd class="font-mono break-all">
					{data.current.tls ? 'https' : 'http'}://&lt;name&gt;.{data.current.contentDomain}
				</dd>
			</dl>
			{#if data.current.ipOnly || data.current.temporaryContent}
				<Alert.Root variant="info">
					<InfoIcon />
					<Alert.Description>
						This install runs on its IP address{data.current.temporaryContent
							? ' and a temporary sslip.io domain for sites'
							: ''}, over plain HTTP. That works for trying things out. Add your own domains below for
						real URLs and HTTPS. Password-protected sites and share links need HTTPS.
					</Alert.Description>
				</Alert.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Change domains</Card.Title>
			<Card.Description>
				Create the DNS records first{data.serverAddress ? `, pointing at ${data.serverAddress}` : ''}.
				Check them here, then apply. Skiff restarts on the new address and puts the old one back if
				the new one doesn’t answer.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/save" class="space-y-5" use:enhance={submitting}>
				<Field.Field data-invalid={errors.platformHost ? true : undefined}>
					<Field.Label for="platform-host">Dashboard address</Field.Label>
					<Input
						id="platform-host"
						name="platformHost"
						bind:value={platformHost}
						placeholder="control.example.com"
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						aria-invalid={errors.platformHost ? 'true' : undefined}
						disabled={!ready}
						required
					/>
					<Field.Description>
						A domain (A record → {data.serverAddress ?? 'this server'}), or the server’s IP address.
					</Field.Description>
					{#if errors.platformHost}<Field.Error>{errors.platformHost}</Field.Error>{/if}
				</Field.Field>

				<Field.Field data-invalid={errors.contentDomain ? true : undefined}>
					<Field.Label for="content-domain">Content domain</Field.Label>
					<Input
						id="content-domain"
						name="contentDomain"
						bind:value={contentDomain}
						placeholder="example.com"
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						aria-invalid={errors.contentDomain ? 'true' : undefined}
						disabled={!ready}
						required
					/>
					<Field.Description>
						Sites are served at <span class="font-mono">&lt;name&gt;.{contentDomain || 'example.com'}</span>.
						Needs a wildcard record <span class="font-mono">*.{contentDomain || 'example.com'}</span> → {data.serverAddress ??
							'this server'}.
						{#if data.temporaryDomain && contentDomain !== data.temporaryDomain}
							<button
								type="button"
								class="underline underline-offset-4"
								onclick={() => {
									contentDomain = data.temporaryDomain!;
									tls = false;
								}}>Use the temporary {data.temporaryDomain}</button
							>
						{/if}
					</Field.Description>
					{#if errors.contentDomain}<Field.Error>{errors.contentDomain}</Field.Error>{/if}
				</Field.Field>

				<Field.Field orientation="horizontal" data-invalid={errors.tls ? true : undefined}>
					<Checkbox
						id="tls"
						name="tls"
						value="on"
						bind:checked={tls}
						disabled={!ready || ipLike(platformHost)}
					/>
					<Field.Content>
						<Field.Label for="tls" class="flex items-center gap-1.5"
							><LockIcon class="size-3.5" />HTTPS with Let’s Encrypt</Field.Label
						>
						<Field.Description>
							Needs domains for both (not an IP or sslip.io) and a Cloudflare DNS token for the
							wildcard certificate.
						</Field.Description>
						{#if errors.tls}<Field.Error>{errors.tls}</Field.Error>{/if}
					</Field.Content>
				</Field.Field>

				{#if tls}
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={errors.acmeEmail ? true : undefined}>
							<Field.Label for="acme-email">Let’s Encrypt email</Field.Label>
							<Input
								id="acme-email"
								name="acmeEmail"
								type="email"
								bind:value={acmeEmail}
								placeholder="ops@example.com"
								disabled={!ready}
								aria-invalid={errors.acmeEmail ? 'true' : undefined}
								required
							/>
							{#if errors.acmeEmail}<Field.Error>{errors.acmeEmail}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={errors.cloudflareToken ? true : undefined}>
							<Field.Label for="cloudflare-token">Cloudflare DNS token</Field.Label>
							<Input
								id="cloudflare-token"
								name="cloudflareToken"
								type="password"
								autocomplete="off"
								placeholder={data.cloudflareTokenSaved ? 'Saved — leave blank to keep' : 'Zone → DNS → Edit'}
								disabled={!ready}
								aria-invalid={errors.cloudflareToken ? 'true' : undefined}
								required={!data.cloudflareTokenSaved}
							/>
							<Field.Description>
								<a
									href={data.cloudflareTokenUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 font-medium underline underline-offset-4"
									>Create one in Cloudflare<ExternalLinkIcon class="size-3" /></a
								>. Permissions are filled in; set Zone Resources to {contentDomain.trim() || 'your sites domain'}’s
								zone.
							</Field.Description>
							{#if errors.cloudflareToken}<Field.Error>{errors.cloudflareToken}</Field.Error>{/if}
						</Field.Field>
					</div>
				{/if}

				{#if result?.dns}
					<ul class="divide-y rounded-lg border text-sm">
						{#each [result.dns.platform, result.dns.content].filter((probe) => probe !== null) as probe (probe.display)}
							<li class="flex gap-3 p-3">
								{#if probe.status === 'here'}
									<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" />
								{:else if probe.status === 'elsewhere'}
									<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />
								{:else}
									<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
								{/if}
								<div class="min-w-0">
									<p class="font-mono break-all">{probe.display}</p>
									<p class="text-muted-foreground">
										{statusLabel[probe.status]}{probe.addresses.length ? ` (${probe.addresses.join(', ')})` : ''}
									</p>
								</div>
							</li>
						{/each}
					</ul>
				{/if}

				{#if result?.needsConfirm}
					<Field.Field orientation="horizontal">
						<Checkbox id="confirm-dns" name="confirmDns" value="on" />
						<Field.Label for="confirm-dns">I understand; apply anyway.</Field.Label>
					</Field.Field>
				{/if}

				{#if hostChanges && platformHost.trim()}
					<Alert.Root variant="warning">
						<TriangleAlertIcon />
						<Alert.Title>The dashboard moves to {nextOrigin}</Alert.Title>
						<Alert.Description>
							<ul class="list-disc space-y-1 pl-4">
								<li>Everyone signs in again there, with their password (or a sign-in link).</li>
								<li>Passkeys stop working: they belong to the old address. Add new ones afterwards.</li>
								<li>
									The CLI and MCP clients need <span class="font-mono">skif login --url {nextOrigin}</span> or
									re-authorising. API keys keep working at the new address.
								</li>
								<li>Worker nodes keep their old control URL; update their agent.env (docs/OPS.md §3.7).</li>
							</ul>
						</Alert.Description>
					</Alert.Root>
					{#if data.needsAuthenticator}
						<Alert.Root variant="destructive">
							<CircleAlertIcon />
							<Alert.Description>
								Set up an authenticator app in <a class="underline" href="/settings/account">Settings →
									Account</a
								> first, so you still have a second factor at the new address.
							</Alert.Description>
						</Alert.Root>
					{/if}
				{/if}

				{#if result?.message && !result.newOrigin}
					<Alert.Root variant="destructive">
						<CircleAlertIcon />
						<Alert.Description>{result.message}</Alert.Description>
					</Alert.Root>
				{:else if result?.checked && !result.message}
					<p class="text-xs text-muted-foreground">DNS checked against public resolvers (1.1.1.1, 8.8.8.8).</p>
				{/if}

				<div class="flex flex-wrap gap-2">
					<Button
						type="submit"
						variant="outline"
						formaction="?/check"
						formnovalidate
						disabled={!ready || pending !== null}
					>
						{#if pending === 'check'}<Spinner />{/if}Check DNS
					</Button>
					<Button
						type="submit"
						disabled={!ready || pending !== null || (hostChanges && data.needsAuthenticator)}
					>
						{#if pending === 'save'}<Spinner />{/if}Apply
					</Button>
				</div>
			</form>
		</Card.Content>
	</Card.Root>
</div>
