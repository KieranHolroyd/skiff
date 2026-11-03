<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import InfoIcon from '@lucide/svelte/icons/info';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link-2';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import SecretReveal from '#lib/components/skiff/SecretReveal.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import AccessChip from '../../_lib/AccessChip.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import ProjectMark from '../../_lib/ProjectMark.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortId, shortSha } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		success?: string;
		fieldErrors?: Record<string, string>;
		shareUrl?: string;
		shareHost?: string;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	const nowLocal = $derived(
		new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
	);
	/** The browser converts the wall-clock picker value to an unambiguous ISO instant. */
	let expiresAtIso = $state('');

	/** Selected access modes; reset whenever the server data changes. */
	let productionMode = $derived(data.project.productionAccess);
	let previewMode = $derived(data.project.previewAccess);

	const activeDeployments = $derived(
		data.deployments.filter((deployment) => deployment.status === 'active')
	);
	const production = $derived(
		data.deployments.find((deployment) => deployment.id === data.project.productionDeploymentId)
	);

	const accessOptions = [
		{ value: 'public', label: 'Public' },
		{ value: 'password', label: 'Password' },
		{ value: 'platform', label: 'Platform login' }
	] as const;

	function shareState(link: {
		revokedAt: string | null;
		expiresAt: string | null;
		redemptions: number;
		maxRedemptions: number | null;
	}): string {
		if (link.revokedAt) return 'revoked';
		if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return 'expired';
		if (link.maxRedemptions !== null && link.redemptions >= link.maxRedemptions) return 'used up';
		return 'active';
	}
</script>

<svelte:head>
	<title>{data.project.name} · Skiff</title>
</svelte:head>

{#snippet accessForm(
	scope: 'production' | 'previews',
	current: string,
	selected: string,
	onSelect: (value: string) => void
)}
	{@const id = scope === 'production' ? 'production-mode' : 'preview-mode'}
	<form method="POST" action="?/setAccess" use:enhance class="space-y-2.5">
		<input type="hidden" name="scope" value={scope} />
		<div class="flex items-center justify-between gap-2">
			<Label for={id}>{scope === 'production' ? 'Production' : 'Previews'}</Label>
			<AccessChip mode={current} />
		</div>
		<select
			{id}
			name="mode"
			class="select-native"
			value={selected}
			onchange={(event) => onSelect(event.currentTarget.value)}
		>
			{#each accessOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		{#if selected === 'password'}
			<Input
				name="password"
				type="password"
				autocomplete="new-password"
				minlength={8}
				required
				placeholder="Project password (8+ characters)"
				aria-label="{scope === 'production' ? 'Production' : 'Preview'} password"
			/>
		{/if}
		<Button
			type="submit"
			size="sm"
			variant="outline"
			class="w-full"
			disabled={selected === current && selected !== 'password'}
		>
			Update {scope === 'production' ? 'production' : 'previews'}
		</Button>
	</form>
{/snippet}

<div class="space-y-6">
	<PageHeader eyebrow="Project" title={data.project.name}>
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2">
				<a
					href={data.project.productionUrl}
					target="_blank"
					rel="external noreferrer"
					class="inline-flex items-center gap-1 font-mono text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					{displayUrl(data.project.productionUrl)}
					<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
				</a>
				<span class="text-muted-foreground/40" aria-hidden="true">/</span>
				<AccessChip scope="Prod" mode={data.project.productionAccess} />
				<AccessChip scope="Preview" mode={data.project.previewAccess} />
			</div>
		{/snippet}
		<CopyButton value={data.project.productionUrl} label="Copy URL" size="default" />
		<Button href={data.project.productionUrl} target="_blank" rel="noreferrer">
			<ArrowUpRightIcon aria-hidden="true" />
			Visit site
		</Button>
	</PageHeader>

	<FormFeedback {result} />

	{#if result?.shareUrl}
		<SecretReveal
			title="Share link ready for {result.shareHost}"
			description="Copy it now. The clear token cannot be shown again."
			value={result.shareUrl}
			copyLabel="Copy share link"
		/>
	{/if}

	<!-- Production hero -->
	<section
		class="relative overflow-hidden rounded-xl border bg-card shadow-card"
		aria-labelledby="production-heading"
	>
		<div class="absolute inset-y-0 left-0 w-1 bg-brand" aria-hidden="true"></div>
		<div class="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 pl-6">
			<span class="hidden sm:block"
				><ProjectMark slug={data.project.slug} name={data.project.name} size="lg" /></span
			>
			<div class="min-w-0 flex-1 basis-64 space-y-1">
				<p
					id="production-heading"
					class="eyebrow flex items-center gap-1.5 text-brand-soft-foreground"
				>
					<RadioTowerIcon class="size-3" aria-hidden="true" />
					Live in production
				</p>
				{#if production}
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-mono text-lg font-semibold tracking-tight">{production.shortId}</span>
						<StatusBadge status={production.status} />
						{#if production.pinned}<Badge variant="outline">pinned</Badge>{/if}
					</div>
					<p class="truncate text-[13px] text-muted-foreground">
						{#if production.message}{production.message} ·
						{/if}<span class="font-mono text-xs">{shortSha(production.release.sha256)}</span>
						· {formatBytes(production.release.sizeBytes)} · deployed
						<time datetime={production.createdAt}>{formatDateTime(production.createdAt)}</time>
					</p>
				{:else}
					<p class="text-lg font-semibold tracking-tight">Nothing in production yet</p>
					<p class="text-[13px] text-muted-foreground">
						Deploy and promote a deployment to serve it at {displayUrl(data.project.productionUrl)}.
					</p>
				{/if}
			</div>
			{#if data.can.rollback && data.project.productionDeploymentId}
				<form method="POST" action="?/rollback" use:enhance>
					<Button
						type="submit"
						variant="outline"
						onclick={(event) => {
							if (
								!confirm(
									'Roll production back to the previous deployment? Code and config both move.'
								)
							)
								event.preventDefault();
						}}
					>
						<RotateCcwIcon aria-hidden="true" />
						Roll back
					</Button>
				</form>
			{/if}
		</div>
	</section>

	<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
		<div class="min-w-0 space-y-5">
			<Panel
				title="Deployments"
				count={data.deployments.length}
				description="{activeDeployments.length} active · the last 10 unpinned are retained."
				flush
			>
				{#if data.deployments.length === 0}
					<div class="p-4">
						<EmptyState
							icon={RocketIcon}
							title="No deployments yet"
							description="Deployments come from the CLI, MCP clients or the REST API. Every deploy gets an immutable preview URL."
						>
							<code class="rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs"
								><span class="text-muted-foreground select-none">$ </span>skif deploy ./dist
								--project {data.project.slug}</code
							>
						</EmptyState>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="data-table">
							<caption class="sr-only">Deployments for {data.project.name}</caption>
							<thead>
								<tr>
									<th>Deployment</th>
									<th class="hidden md:table-cell">Release</th>
									<th class="hidden lg:table-cell">Created</th>
									<th class="text-right"><span class="sr-only">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								{#each data.deployments as deployment (deployment.id)}
									<tr
										class={deployment.isProduction ? 'bg-brand-soft/35 hover:bg-brand-soft/50' : ''}
									>
										<td>
											<div class="flex flex-wrap items-center gap-1.5">
												<span class="font-mono text-[13px] font-medium">{deployment.shortId}</span>
												<StatusBadge status={deployment.status} />
												{#if deployment.isProduction}
													<Badge variant="brand">production</Badge>
												{/if}
												{#if deployment.pinned}
													<Badge variant="outline"><PinIcon aria-hidden="true" />pinned</Badge>
												{/if}
											</div>
											<a
												href={deployment.previewUrl}
												target="_blank"
												rel="external noreferrer"
												class="mt-1 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
											>
												{displayUrl(deployment.previewUrl)}
												<ArrowUpRightIcon class="size-3 shrink-0" aria-hidden="true" />
											</a>
											{#if deployment.message}
												<p
													class="mt-0.5 max-w-xl truncate text-xs text-muted-foreground"
													title={deployment.message}
												>
													{deployment.message}
												</p>
											{/if}
										</td>
										<td class="hidden font-mono text-xs text-muted-foreground md:table-cell">
											<span title={deployment.release.sha256}
												>{shortSha(deployment.release.sha256)}</span
											>
											<p class="text-[11px] opacity-80">
												{formatBytes(deployment.release.sizeBytes)}
											</p>
										</td>
										<td
											class="hidden text-xs whitespace-nowrap text-muted-foreground lg:table-cell"
										>
											<time datetime={deployment.createdAt}
												>{formatDateTime(deployment.createdAt)}</time
											>
										</td>
										<td>
											<div class="flex items-center justify-end gap-1">
												{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
													<form method="POST" action="?/promote" use:enhance>
														<input type="hidden" name="deploymentId" value={deployment.id} />
														<Button type="submit" variant="outline" size="sm">
															<ArrowUpIcon aria-hidden="true" />
															Promote
														</Button>
													</form>
												{/if}
												{#if data.can.promote}
													<form method="POST" action="?/pin" use:enhance>
														<input type="hidden" name="deploymentId" value={deployment.id} />
														<input
															type="hidden"
															name="pinned"
															value={deployment.pinned ? 'false' : 'true'}
														/>
														<Button
															type="submit"
															variant="ghost"
															size="icon-sm"
															aria-label={deployment.pinned
																? `Unpin deployment ${deployment.shortId}`
																: `Pin deployment ${deployment.shortId}`}
															title={deployment.pinned ? 'Unpin' : 'Pin (exempt from retention)'}
														>
															{#if deployment.pinned}
																<PinOffIcon aria-hidden="true" />
															{:else}
																<PinIcon aria-hidden="true" />
															{/if}
														</Button>
													</form>
												{/if}
												{#if data.can.deleteDeployment}
													<form method="POST" action="?/deleteDeployment" use:enhance>
														<input type="hidden" name="deploymentId" value={deployment.id} />
														<Button
															type="submit"
															variant="ghost-danger"
															size="icon-sm"
															aria-label="Delete deployment {deployment.shortId}"
															title="Delete deployment"
															onclick={(event) => {
																if (
																	!confirm(
																		`Delete deployment ${deployment.shortId}? Its preview URL stops working.`
																	)
																)
																	event.preventDefault();
															}}
														>
															<TrashIcon aria-hidden="true" />
														</Button>
													</form>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</Panel>

			<Panel
				title="Share links"
				icon={LinkIcon}
				count={data.shareLinks.length}
				description="Time- and usage-limited access to protected sites. A visit is a redemption, not a page load."
			>
				<div class="space-y-4">
					{#if data.can.createShare}
						<form
							method="POST"
							action="?/createShare"
							use:enhance
							class="grid gap-3 rounded-lg border bg-muted/30 p-3.5 sm:grid-cols-2"
						>
							<div class="space-y-1.5">
								<Label for="share-deployment">Deployment</Label>
								<select id="share-deployment" name="deploymentId" class="select-native">
									<option value="">Production site</option>
									{#each data.deployments as deployment (deployment.id)}
										<option value={deployment.id}
											>{deployment.shortId}{deployment.isProduction ? ' (production)' : ''}</option
										>
									{/each}
								</select>
							</div>
							<div class="space-y-1.5">
								<Label for="share-expires"
									>Expires at <span class="font-normal text-muted-foreground">optional</span></Label
								>
								<Input
									id="share-expires"
									name="expiresAtLocal"
									type="datetime-local"
									min={nowLocal}
									oninput={(event) => {
										const value = event.currentTarget.value;
										expiresAtIso = value ? new Date(value).toISOString() : '';
									}}
								/>
								<input type="hidden" name="expiresAt" value={expiresAtIso} />
							</div>
							<div class="space-y-1.5">
								<Label for="share-max"
									>Max redemptions <span class="font-normal text-muted-foreground">optional</span
									></Label
								>
								<Input
									id="share-max"
									name="maxRedemptions"
									type="number"
									min="1"
									step="1"
									placeholder="Unlimited"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for="share-note"
									>Note <span class="font-normal text-muted-foreground">optional</span></Label
								>
								<Input
									id="share-note"
									name="note"
									maxlength={500}
									placeholder="Design review with Alex"
								/>
							</div>
							<div
								class="flex flex-wrap items-center justify-between gap-3 border-t pt-3 sm:col-span-2"
							>
								<p class="text-xs text-muted-foreground">
									Sessions last one hour by default. Revocation reaches agents in seconds.
								</p>
								<Button type="submit">
									<LinkIcon aria-hidden="true" />
									Create link
								</Button>
							</div>
						</form>
					{/if}

					{#if data.shareLinks.length === 0}
						<EmptyState
							icon={LinkIcon}
							compact
							title="No share links"
							description="Create a link when someone outside the org needs temporary access to a protected site."
						/>
					{:else}
						<ul class="divide-y overflow-hidden rounded-lg border">
							{#each data.shareLinks as link (link.id)}
								{@const state = shareState(link)}
								<li
									class="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 {state !==
									'active'
										? 'bg-muted/25'
										: ''}"
								>
									<div class="min-w-0 space-y-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="truncate font-mono text-[13px]">{link.host}</span>
											<StatusBadge status={state} />
										</div>
										<p class="text-xs text-muted-foreground">
											{#if link.note}<span class="text-foreground">{link.note}</span> ·
											{/if}<span class="font-mono tabular-nums"
												>{link.redemptions}{link.maxRedemptions !== null
													? `/${link.maxRedemptions}`
													: ''}</span
											>
											redemptions ·
											{#if link.expiresAt}
												expires <time datetime={link.expiresAt}
													>{formatDateTime(link.expiresAt)}</time
												>
											{:else}
												no expiry
											{/if}
										</p>
									</div>
									{#if data.can.revokeShare && !link.revokedAt}
										<form method="POST" action="?/revokeShare" use:enhance>
											<input type="hidden" name="shareId" value={link.id} />
											<Button
												type="submit"
												variant="ghost-danger"
												size="sm"
												onclick={(event) => {
													if (
														!confirm('Revoke this share link? Existing sessions are revoked too.')
													)
														event.preventDefault();
												}}
											>
												Revoke
											</Button>
										</form>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</Panel>
		</div>

		<div class="space-y-5 xl:sticky xl:top-20">
			<Panel
				title="Access"
				icon={KeyRoundIcon}
				description="Production and previews are set separately."
			>
				{#if data.can.update}
					<div class="space-y-5">
						{@render accessForm(
							'production',
							data.project.productionAccess,
							productionMode,
							(v) => (productionMode = v as typeof productionMode)
						)}
						<div class="border-t"></div>
						{@render accessForm(
							'previews',
							data.project.previewAccess,
							previewMode,
							(v) => (previewMode = v as typeof previewMode)
						)}
					</div>
				{:else}
					<dl class="kv">
						<dt>Production</dt>
						<dd><AccessChip mode={data.project.productionAccess} /></dd>
						<dt>Previews</dt>
						<dd><AccessChip mode={data.project.previewAccess} /></dd>
					</dl>
				{/if}
				{#if result?.fieldErrors?.password}
					<p class="mt-3 text-xs text-destructive">{result.fieldErrors.password}</p>
				{/if}
				{#snippet footer()}
					Protected sites set <span class="font-mono">X-Robots-Tag: noindex</span> and never receive platform
					session cookies.
				{/snippet}
			</Panel>

			<Panel title="Details" icon={InfoIcon}>
				<dl class="kv">
					<dt>Production</dt>
					<dd class="font-mono text-[13px]">{production?.shortId ?? 'not deployed'}</dd>
					<dt>Runtime</dt>
					<dd class="capitalize">{data.project.runtime}</dd>
					<dt>Placement</dt>
					<dd class="font-mono text-[13px]">{data.project.placement}</dd>
					<dt>Created</dt>
					<dd class="text-[13px]">
						<time datetime={data.project.createdAt}>{formatDateTime(data.project.createdAt)}</time>
					</dd>
					<dt>Project ID</dt>
					<dd class="flex items-center justify-end gap-1">
						<span class="truncate font-mono text-[12px]" title={data.project.id}
							>{shortId(data.project.id, 14)}</span
						>
						<CopyButton value={data.project.id} label="Copy project ID" variant="ghost" iconOnly />
					</dd>
				</dl>
			</Panel>
		</div>
	</div>
</div>
