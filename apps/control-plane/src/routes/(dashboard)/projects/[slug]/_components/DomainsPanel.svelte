<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import type { ProjectView } from '@skiff/core';
	import { contentUrl, type DomainView } from '@skiff/contracts';
	import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime } from '../../../_lib/format.js';

	let {
		project,
		domains,
		contentDomain,
		platformOrigin,
		can
	}: {
		project: ProjectView;
		domains: DomainView[];
		contentDomain: string;
		platformOrigin: string;
		can: { createDomain: boolean; deleteDomain: boolean };
	} = $props();

	let addOpen = $state(false);
	let checking = $state<string[]>([]);

	const target = $derived(
		/^\d{1,3}(?:\.\d{1,3}){3}$/.test(contentDomain)
			? { type: 'A', value: contentDomain }
			: { type: 'CNAME', value: `${project.slug}.${contentDomain}` }
	);

	const verifiedCount = $derived(
		domains.filter((domain) => domain.status === 'verified' || domain.status === 'active').length
	);

	async function check(domain: DomainView) {
		if (checking.includes(domain.id)) return;
		checking = [...checking, domain.id];
		try {
			await runAction('?/checkDomain', { domainId: domain.id });
		} finally {
			checking = checking.filter((id) => id !== domain.id);
		}
	}

	function remove(domain: DomainView) {
		askConfirm({
			title: `Remove ${domain.hostname}?`,
			description:
				'The hostname stops serving and automatic Cloudflare records are deleted. TLS certificates are left to expire.',
			confirmLabel: 'Remove domain',
			tone: 'danger',
			action: '?/deleteDomain',
			fields: { domainId: domain.id }
		});
	}
</script>

<div class="space-y-5">
	<div
		class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/70 px-4 py-3"
	>
		<div class="flex items-start gap-3">
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<GlobeIcon class="size-4" />
			</span>
			<div class="min-w-0">
				<p class="text-sm font-medium">Custom domains</p>
				<p class="text-xs text-muted-foreground">
					{verifiedCount}/{domains.length} verified · on-demand TLS issues a certificate on the first
					verified request.
				</p>
				<p class="text-xs text-muted-foreground">
					Domains serve the production deployment; environment hosts are separate.
				</p>
			</div>
		</div>
		{#if can.createDomain}
			<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add domain</Button>
		{/if}
	</div>

	{#if domains.length === 0}
		<EmptyState
			icon={GlobeIcon}
			title="No custom domains"
			description={`Every project already answers on ${project.slug}.${contentDomain}. Attach your own hostname when you are ready to go live on it.`}
		>
			{#if can.createDomain}
				<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon />Add domain</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="space-y-3">
			{#each domains as domain (domain.id)}
				<Card.Root class="gap-0 py-0">
					<Card.Header class="border-b py-4">
						<div class="min-w-0 space-y-1">
							<Card.Title class="flex flex-wrap items-center gap-2">
								<a
									href={contentUrl(platformOrigin, domain.hostname)}
									target="_blank"
									rel="external noreferrer"
									title={domain.hostname}
									class="inline-flex max-w-full min-w-0 items-center gap-1 underline-offset-4 hover:underline"
								>
									<span class="truncate">{domain.hostname}</span>
									<ArrowUpRightIcon class="size-3.5 shrink-0 text-muted-foreground" />
								</a>
								<StatusBadge status={domain.status} />
								<Badge variant="outline" class="font-mono text-xs">{domain.kind}</Badge>
								{#if domain.redirectWww}
									<Badge variant="neutral" class="font-mono text-xs">www → apex</Badge>
								{/if}
							</Card.Title>
							<p class="text-xs text-muted-foreground">
								{#if domain.lastCheckedAt}
									Last checked <time datetime={domain.lastCheckedAt}
										>{formatDateTime(domain.lastCheckedAt)}</time
									>
								{:else}
									Not checked yet
								{/if}
								{#if domain.verifiedAt}
									· verified
									<time datetime={domain.verifiedAt}>{formatDateTime(domain.verifiedAt)}</time>
								{/if}
							</p>
						</div>
						<Card.Action class="flex flex-wrap items-center justify-end gap-2 self-center">
							<Button
								variant="outline"
								size="sm"
								disabled={checking.includes(domain.id)}
								onclick={() => check(domain)}
							>
								<RefreshCwIcon class={checking.includes(domain.id) ? 'animate-spin' : ''} />
								Check DNS
							</Button>
							{#if can.deleteDomain}
								<Button
									variant="ghost-danger"
									size="icon-sm"
									aria-label={`Remove ${domain.hostname}`}
									onclick={() => remove(domain)}
								>
									<TrashIcon />
								</Button>
							{/if}
						</Card.Action>
					</Card.Header>

					<Card.Content class="space-y-4 py-4">
						{#if domain.status === 'verified' || domain.status === 'active'}
							<div
								class="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-3"
							>
								<CheckIcon class="mt-0.5 size-4 shrink-0 text-success" />
								<p class="text-xs text-muted-foreground">
									Control is proven. Traffic for <span class="font-mono">{domain.hostname}</span> is routed
									to this project, and Caddy issues a certificate on the first request.
								</p>
							</div>
						{:else}
							<div class="grid gap-3 sm:grid-cols-2">
								{#if domain.verification}
									<div class="rounded-lg border bg-muted/25 p-3">
										<p class="mb-1.5 text-xs font-medium text-muted-foreground">
											1 · Prove control (TXT)
										</p>
										<DetailList class="text-xs">
											<dt>Name</dt>
											<dd class="flex min-w-0 items-center justify-end gap-1">
												<span class="truncate font-mono" title={domain.verification.recordName}
													>{domain.verification.recordName}</span
												>
												<CopyButton
													value={domain.verification.recordName}
													label="Copy TXT name"
													iconOnly
												/>
											</dd>
											<dt>Value</dt>
											<dd class="flex min-w-0 items-center justify-end gap-1">
												<span class="truncate font-mono" title={domain.verification.recordValue}
													>{domain.verification.recordValue}</span
												>
												<CopyButton
													value={domain.verification.recordValue}
													label="Copy TXT value"
													iconOnly
												/>
											</dd>
										</DetailList>
									</div>
								{/if}
								<div class="rounded-lg border bg-muted/25 p-3">
									<p class="mb-1.5 text-xs font-medium text-muted-foreground">
										2 · Point traffic ({target.type})
									</p>
									<DetailList class="text-xs">
										<dt>Name</dt>
										<dd class="flex min-w-0 items-center justify-end gap-1">
											<span class="truncate font-mono" title={domain.hostname}
												>{domain.hostname}</span
											>
											<CopyButton value={domain.hostname} label="Copy hostname" iconOnly />
										</dd>
										<dt>Value</dt>
										<dd class="flex min-w-0 items-center justify-end gap-1">
											<span class="truncate font-mono" title={target.value}>{target.value}</span>
											<CopyButton value={target.value} label="Copy target" iconOnly />
										</dd>
										{#if domain.redirectWww}
											<dt>www</dt>
											<dd class="truncate font-mono">www.{domain.hostname}</dd>
										{/if}
									</DetailList>
								</div>
							</div>
						{/if}

						{#if domain.lastError}
							<Alert.Root variant="warning" class="py-3">
								<AlertCircleIcon />
								<Alert.Description>{domain.lastError}</Alert.Description>
							</Alert.Root>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

{#if can.createDomain}
	<FormDialog
		bind:open={addOpen}
		icon={GlobeIcon}
		title="Add a custom domain"
		description="The hostname must not already be attached to another project. Skiff verifies control with a TXT record before issuing a certificate."
		action="?/addDomain"
		submitLabel="Attach domain"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="domain-hostname">Hostname</Field.Label>
				<Input
					id="domain-hostname"
					name="hostname"
					placeholder="www.example.com"
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description
					>No scheme, port or path. Apex and subdomains both work.</Field.Description
				>
			</Field.Field>
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="domain-www" name="redirectWww" value="1" />
				<Field.Label for="domain-www" class="font-normal">
					Also create the www sibling and redirect it to the apex
				</Field.Label>
			</Field.Field>
			<Field.Description>
				The www choice is fixed after attaching; remove and re-add the domain to change it.
			</Field.Description>
			<Field.Description>
				Cloudflare records are created automatically when a token and zone are configured; otherwise
				add the records shown after attaching.
			</Field.Description>
		</Field.Group>
	</FormDialog>
{/if}
