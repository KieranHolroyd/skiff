<script lang="ts">
	import { enhance } from '$app/forms';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link-2';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import CopyButton from '../../_lib/CopyButton.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import { formatBytes, formatDateTime, shortId, shortSha } from '../../_lib/format.js';
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

	const selectClass =
		'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
	const nowLocal = $derived(
		new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
	);
	/** The browser converts the wall-clock picker value to an unambiguous ISO instant. */
	let expiresAtIso = $state('');

	const activeDeployments = $derived(
		data.deployments.filter((deployment) => deployment.status === 'active')
	);
	const production = $derived(
		data.deployments.find((deployment) => deployment.id === data.project.productionDeploymentId)
	);

	function accessLabel(value: string): string {
		return value === 'platform' ? 'Platform login' : value === 'password' ? 'Password' : 'Public';
	}

	function deploymentTone(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'active') return 'default';
		if (status === 'failed') return 'destructive';
		if (status === 'pending') return 'secondary';
		return 'outline';
	}

	function shareState(link: {
		revokedAt: string | null;
		expiresAt: string | null;
		redemptions: number;
		maxRedemptions: number | null;
	}): {
		label: string;
		variant: 'default' | 'secondary' | 'destructive' | 'outline';
	} {
		if (link.revokedAt) return { label: 'revoked', variant: 'destructive' };
		if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now())
			return { label: 'expired', variant: 'outline' };
		if (link.maxRedemptions !== null && link.redemptions >= link.maxRedemptions)
			return { label: 'used up', variant: 'secondary' };
		return { label: 'active', variant: 'default' };
	}
</script>

<svelte:head>
	<title>{data.project.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title={data.project.name}
		description="Production pointer, preview deployments and access for {data.project
			.slug}.{data.contentDomain}."
	>
		<CopyButton value={data.project.productionUrl} label="Copy URL" />
		<Button
			href={data.project.productionUrl}
			target="_blank"
			rel="noreferrer"
			variant="outline"
			size="sm"
		>
			<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
			Visit site
		</Button>
	</PageHeader>

	{#if result?.success}
		<div
			class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
			role="status"
		>
			{result.success}
		</div>
	{/if}
	{#if result?.message}
		<div
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			role="alert"
		>
			{result.message}
		</div>
	{/if}

	{#if result?.shareUrl}
		<div
			class="rounded-xl border border-emerald-300/70 bg-emerald-50/70 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10"
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="space-y-0.5">
					<p class="text-sm font-medium">Share link ready for {result.shareHost}</p>
					<p class="text-xs text-muted-foreground">
						Copy it now. The clear token cannot be shown again.
					</p>
				</div>
				<CopyButton value={result.shareUrl} label="Copy share link" variant="default" />
			</div>
			<Input
				readonly
				value={result.shareUrl}
				class="mt-3 font-mono text-xs"
				aria-label="Share link URL"
			/>
		</div>
	{/if}

	<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
		<div class="space-y-4">
			<Card.Root>
				<Card.Header class="flex-row flex-wrap items-center justify-between gap-3 border-b pb-4">
					<div class="space-y-1">
						<Card.Title>Deployments</Card.Title>
						<Card.Description>
							{activeDeployments.length} active · {data.deployments.length} retained · last 10 unpinned
							are kept
						</Card.Description>
					</div>
					{#if data.can.rollback && data.project.productionDeploymentId}
						<form method="POST" action="?/rollback" use:enhance>
							<Button
								type="submit"
								variant="outline"
								size="sm"
								onclick={(event) => {
									if (
										!confirm(
											'Roll production back to the previous deployment? Code and config both move.'
										)
									)
										event.preventDefault();
								}}
							>
								<RotateCcwIcon class="size-3.5" aria-hidden="true" />
								Rollback
							</Button>
						</form>
					{/if}
				</Card.Header>
				<Card.Content class="p-0">
					{#if data.deployments.length === 0}
						<div class="p-4">
							<EmptyState
								title="No deployments yet"
								description="Deployments come from the CLI, MCP clients or the REST API. Every deploy gets an immutable preview URL."
							>
								<code class="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs"
									>skif deploy ./dist --project {data.project.slug}</code
								>
							</EmptyState>
						</div>
					{:else}
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<caption class="sr-only">Deployments for {data.project.name}</caption>
								<thead>
									<tr class="border-b text-left text-xs text-muted-foreground">
										<th class="px-4 py-2.5 font-medium">Deployment</th>
										<th class="hidden px-4 py-2.5 font-medium md:table-cell">Commit</th>
										<th class="hidden px-4 py-2.5 font-medium sm:table-cell">Created</th>
										<th class="px-4 py-2.5 text-right font-medium">Actions</th>
									</tr>
								</thead>
								<tbody>
									{#each data.deployments as deployment (deployment.id)}
										<tr class="border-b last:border-0 hover:bg-muted/35">
											<td class="px-4 py-3">
												<div class="flex flex-wrap items-center gap-1.5">
													<span class="font-mono text-xs">{deployment.shortId}</span>
													{#if deployment.isProduction}
														<Badge>production</Badge>
													{/if}
													{#if deployment.pinned}
														<Badge variant="outline">pinned</Badge>
													{/if}
													<Badge variant={deploymentTone(deployment.status)}
														>{deployment.status}</Badge
													>
												</div>
												<a
													href={deployment.previewUrl}
													target="_blank"
													rel="external noreferrer"
													class="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
												>
													{deployment.previewUrl.replace('https://', '')}
													<ExternalLinkIcon class="size-3" aria-hidden="true" />
												</a>
												{#if deployment.message}
													<p
														class="mt-1 max-w-xl truncate text-xs text-muted-foreground"
														title={deployment.message}
													>
														{deployment.message}
													</p>
												{/if}
											</td>
											<td
												class="hidden px-4 py-3 font-mono text-xs text-muted-foreground md:table-cell"
												title={deployment.release.sha256}
											>
												{shortSha(deployment.release.sha256)}
												<span class="ml-1 text-[10px]"
													>· {formatBytes(deployment.release.sizeBytes)}</span
												>
											</td>
											<td
												class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
											>
												<time datetime={deployment.createdAt}
													>{formatDateTime(deployment.createdAt)}</time
												>
											</td>
											<td class="px-4 py-3">
												<div class="flex flex-wrap items-center justify-end gap-1">
													{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
														<form method="POST" action="?/promote" use:enhance>
															<input type="hidden" name="deploymentId" value={deployment.id} />
															<Button type="submit" variant="outline" size="xs">Promote</Button>
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
																size="xs"
																aria-label={deployment.pinned
																	? 'Unpin deployment'
																	: 'Pin deployment'}
															>
																{#if deployment.pinned}
																	<PinOffIcon class="size-3.5" aria-hidden="true" />
																	Unpin
																{:else}
																	<PinIcon class="size-3.5" aria-hidden="true" />
																	Pin
																{/if}
															</Button>
														</form>
													{/if}
													{#if data.can.deleteDeployment}
														<form method="POST" action="?/deleteDeployment" use:enhance>
															<input type="hidden" name="deploymentId" value={deployment.id} />
															<Button
																type="submit"
																variant="ghost"
																size="icon-xs"
																class="text-destructive hover:bg-destructive/10 hover:text-destructive"
																aria-label="Delete deployment {deployment.shortId}"
																onclick={(event) => {
																	if (
																		!confirm(
																			`Delete deployment ${deployment.shortId}? Its preview URL stops working.`
																		)
																	)
																		event.preventDefault();
																}}
															>
																<TrashIcon class="size-3.5" aria-hidden="true" />
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
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header class="border-b pb-4">
					<Card.Title>Share links</Card.Title>
					<Card.Description
						>Time- and usage-limited access to protected previews or production. A visit is a
						redemption, not a page load.</Card.Description
					>
				</Card.Header>
				<Card.Content class="space-y-4">
					{#if data.can.createShare}
						<form
							method="POST"
							action="?/createShare"
							use:enhance
							class="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2"
						>
							<div class="space-y-1.5">
								<Label for="share-deployment">Deployment</Label>
								<select id="share-deployment" name="deploymentId" class={selectClass}>
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
									>Expires at <span class="font-normal text-muted-foreground">(optional)</span
									></Label
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
									>Max redemptions <span class="font-normal text-muted-foreground">(optional)</span
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
									>Note <span class="font-normal text-muted-foreground">(optional)</span></Label
								>
								<Input
									id="share-note"
									name="note"
									maxlength={500}
									placeholder="Design review with Alex"
								/>
							</div>
							<div class="flex items-end justify-between gap-2 sm:col-span-2">
								<p class="text-xs text-muted-foreground">
									Sessions last one hour by default. Revocation reaches agents in seconds.
								</p>
								<Button type="submit" size="sm">
									<LinkIcon class="size-3.5" aria-hidden="true" />
									Create link
								</Button>
							</div>
						</form>
					{/if}

					{#if data.shareLinks.length === 0}
						<EmptyState
							title="No share links"
							description="Create a link when someone outside the org needs temporary access to a protected site."
						/>
					{:else}
						<ul class="divide-y rounded-lg border">
							{#each data.shareLinks as link (link.id)}
								{@const state = shareState(link)}
								<li class="flex flex-wrap items-start justify-between gap-3 p-3">
									<div class="min-w-0 space-y-1">
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="truncate font-mono text-xs">{link.host}</span>
											<Badge variant={state.variant}>{state.label}</Badge>
										</div>
										{#if link.note}<p class="text-xs text-muted-foreground">{link.note}</p>{/if}
										<p class="text-xs text-muted-foreground">
											{link.redemptions}{link.maxRedemptions !== null
												? ` / ${link.maxRedemptions}`
												: ''} redemptions
											{#if link.expiresAt}
												· expires <time datetime={link.expiresAt}
													>{formatDateTime(link.expiresAt)}</time
												>
											{:else}
												· no expiry
											{/if}
										</p>
									</div>
									{#if data.can.revokeShare && !link.revokedAt}
										<form method="POST" action="?/revokeShare" use:enhance>
											<input type="hidden" name="shareId" value={link.id} />
											<Button
												type="submit"
												variant="ghost"
												size="xs"
												class="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
				</Card.Content>
			</Card.Root>
		</div>

		<div class="space-y-4">
			<Card.Root size="sm">
				<Card.Header class="border-b pb-3">
					<Card.Title>Production</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-3">
					<div class="rounded-lg border bg-muted/25 p-2.5">
						<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<GlobeIcon class="size-3.5" aria-hidden="true" />
							Production URL
						</p>
						<p class="mt-1 font-mono text-xs break-all">{data.project.productionUrl}</p>
						<div class="mt-2 flex gap-2">
							<CopyButton value={data.project.productionUrl} />
							<Button
								href={data.project.productionUrl}
								target="_blank"
								rel="noreferrer"
								variant="ghost"
								size="xs">Open</Button
							>
						</div>
					</div>
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
						<dt class="text-muted-foreground">Pointer</dt>
						<dd class="font-mono">{production?.shortId ?? 'not deployed'}</dd>
						<dt class="text-muted-foreground">Runtime</dt>
						<dd class="capitalize">{data.project.runtime}</dd>
						<dt class="text-muted-foreground">Placement</dt>
						<dd class="font-mono">{data.project.placement}</dd>
						<dt class="text-muted-foreground">Created</dt>
						<dd>
							<time datetime={data.project.createdAt}>{formatDateTime(data.project.createdAt)}</time
							>
						</dd>
						<dt class="text-muted-foreground">Project ID</dt>
						<dd class="font-mono break-all" title={data.project.id}>
							{shortId(data.project.id, 16)}
						</dd>
					</dl>
				</Card.Content>
			</Card.Root>

			<Card.Root size="sm">
				<Card.Header class="border-b pb-3">
					<Card.Title>Access</Card.Title>
					<Card.Description>Production and previews are set separately.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center justify-between gap-2 text-sm">
						<span class="flex items-center gap-1.5 text-muted-foreground">
							<KeyRoundIcon class="size-3.5" aria-hidden="true" />
							Production
						</span>
						<Badge variant="outline">{accessLabel(data.project.productionAccess)}</Badge>
					</div>
					{#if data.can.update}
						<form
							method="POST"
							action="?/setAccess"
							use:enhance
							class="space-y-2 rounded-lg border bg-muted/20 p-2.5"
						>
							<input type="hidden" name="scope" value="production" />
							<Label for="production-mode" class="text-xs">Change production</Label>
							<select id="production-mode" name="mode" class={selectClass}>
								<option value="public" selected={data.project.productionAccess === 'public'}
									>Public</option
								>
								<option value="password" selected={data.project.productionAccess === 'password'}
									>Password</option
								>
								<option value="platform" selected={data.project.productionAccess === 'platform'}
									>Platform login</option
								>
							</select>
							<Input
								name="password"
								type="password"
								autocomplete="new-password"
								placeholder="Project password (8+ characters)"
								aria-label="Production password"
							/>
							<Button type="submit" size="xs" variant="outline" class="w-full"
								>Update production</Button
							>
						</form>
					{/if}

					<div class="flex items-center justify-between gap-2 border-t pt-3 text-sm">
						<span class="flex items-center gap-1.5 text-muted-foreground">
							<KeyRoundIcon class="size-3.5" aria-hidden="true" />
							Previews
						</span>
						<Badge variant="secondary">{accessLabel(data.project.previewAccess)}</Badge>
					</div>
					{#if data.can.update}
						<form
							method="POST"
							action="?/setAccess"
							use:enhance
							class="space-y-2 rounded-lg border bg-muted/20 p-2.5"
						>
							<input type="hidden" name="scope" value="previews" />
							<Label for="preview-mode" class="text-xs">Change previews</Label>
							<select id="preview-mode" name="mode" class={selectClass}>
								<option value="platform" selected={data.project.previewAccess === 'platform'}
									>Platform login</option
								>
								<option value="public" selected={data.project.previewAccess === 'public'}
									>Public</option
								>
								<option value="password" selected={data.project.previewAccess === 'password'}
									>Password</option
								>
							</select>
							<Input
								name="password"
								type="password"
								autocomplete="new-password"
								placeholder="Project password (8+ characters)"
								aria-label="Preview password"
							/>
							<Button type="submit" size="xs" variant="outline" class="w-full"
								>Update previews</Button
							>
						</form>
					{/if}
					<p class="text-xs text-muted-foreground">
						Protected sites set <span class="font-mono">X-Robots-Tag: noindex</span> and never receive
						platform session cookies. Password mode uses one project-wide secret.
					</p>
				</Card.Content>
			</Card.Root>
		</div>
	</div>
</div>
