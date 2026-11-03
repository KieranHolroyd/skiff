<script lang="ts">
	import { enhance } from '$app/forms';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import SecretReveal from '#lib/components/skiff/SecretReveal.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import Panel from '../_lib/Panel.svelte';
	import { formatDate, formatDateTime, shortId } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface SettingsFormResult {
		message?: string;
		success?: string;
		fieldErrors?: Record<string, string>;
		createdKey?: string;
		createdKeyName?: string;
		createdKeyScopes?: string[];
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as SettingsFormResult | null);

	function roleBadge(role: string): BadgeVariant {
		if (role === 'owner') return 'brand';
		if (role === 'admin') return 'info';
		return 'neutral';
	}

	function keyState(key: { enabled: boolean; expiresAt: string | null }): string {
		if (!key.enabled) return 'disabled';
		if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return 'expired';
		return 'active';
	}

	function initials(name: string): string {
		return (
			name
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]?.toUpperCase() ?? '')
				.join('') || '?'
		);
	}
</script>

<svelte:head>
	<title>Organisation settings · Skiff</title>
</svelte:head>

{#snippet emailsHidden()}Member emails are visible to owners and admins only.{/snippet}

<div class="space-y-5">
	<FormFeedback {result} />

	{#if result?.createdKey}
		<SecretReveal
			title="{result.createdKeyName ?? 'API key'} created"
			description="Copy this key now. It is stored hashed and cannot be shown again."
			value={result.createdKey}
			copyLabel="Copy key"
		>
			{#if result.createdKeyScopes?.length}
				<div class="space-y-1.5">
					<p class="eyebrow">Scopes granted</p>
					<div class="flex flex-wrap gap-1">
						{#each result.createdKeyScopes as scope (scope)}
							<Badge variant="outline" class="font-mono text-[11px]">{scope}</Badge>
						{/each}
					</div>
				</div>
			{/if}
		</SecretReveal>
	{/if}

	<div class="grid items-start gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
		<Panel
			title="Organisation"
			icon={Building2Icon}
			description="Tenant boundary for every project and deployment."
		>
			<dl class="kv">
				<dt>Name</dt>
				<dd class="font-medium">{data.org.name}</dd>
				<dt>Slug</dt>
				<dd class="font-mono text-[12.5px]">{data.org.slug ?? '—'}</dd>
				<dt>Your role</dt>
				<dd><Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge></dd>
				<dt>Created</dt>
				<dd class="text-[13px]">{formatDateTime(data.org.createdAt)}</dd>
				<dt>Org ID</dt>
				<dd class="flex items-center justify-end gap-1">
					<span class="truncate font-mono text-[12px]" title={data.org.id}
						>{shortId(data.org.id, 16)}</span
					>
					<CopyButton value={data.org.id} label="Copy org ID" variant="ghost" iconOnly />
				</dd>
			</dl>
		</Panel>

		<Panel
			title="Members"
			icon={UsersIcon}
			count={data.members.length}
			description="Roles are enforced identically by the dashboard, API, CLI and MCP."
			footer={data.canSeeEmails ? undefined : emailsHidden}
			flush
		>
			{#if data.members.length === 0}
				<div class="p-4">
					<EmptyState
						icon={UsersIcon}
						compact
						title="No members loaded"
						description="The auth tables may still be initialising on first boot."
					/>
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.members as member (member.userId)}
						<li class="flex items-center gap-3 px-4 py-3">
							<span
								class="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
								aria-hidden="true">{initials(member.name)}</span
							>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{member.name}</p>
								<p class="truncate text-xs text-muted-foreground">
									{member.email ?? 'Email hidden'}
								</p>
							</div>
							<span class="hidden text-xs text-muted-foreground sm:inline">
								joined {formatDate(member.joinedAt)}
							</span>
							<Badge variant={roleBadge(member.role)} class="capitalize">{member.role}</Badge>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	</div>

	<Panel
		title="API keys"
		icon={KeyRoundIcon}
		count={data.canReadKeys ? data.apiKeys.length : undefined}
		description="Headless access for CI, scripts and the CLI. A key's permissions are always a subset of your current role."
		flush
	>
		{#if data.apiKeysError}
			<div class="border-b p-4">
				<Notice tone="warning">{data.apiKeysError}</Notice>
			</div>
		{/if}

		<div class="grid items-stretch xl:grid-cols-[340px_minmax(0,1fr)]">
			<div class="border-b p-4 xl:border-r xl:border-b-0">
				{#if data.canCreateKey}
					<form method="POST" action="?/createKey" use:enhance class="space-y-4">
						<p class="text-sm font-semibold">Create a key</p>
						<div class="space-y-1.5">
							<Label for="key-name">Name</Label>
							<Input
								id="key-name"
								name="name"
								maxlength={64}
								placeholder="CI deploy key"
								required
								aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
							/>
							{#if result?.fieldErrors?.name}<p class="text-xs text-destructive">
									{result.fieldErrors.name}
								</p>{/if}
						</div>
						<div class="space-y-1.5">
							<Label for="key-expiry">Expires after</Label>
							<select id="key-expiry" name="expiresIn" class="select-native">
								<option value="30">30 days</option>
								<option value="90" selected>90 days</option>
								<option value="365">365 days</option>
								<option value="never">Never</option>
							</select>
						</div>

						<details class="group rounded-lg border bg-muted/25" open>
							<summary
								class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[13px] font-medium [&::-webkit-details-marker]:hidden"
							>
								Scopes
								<ChevronRightIcon
									class="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
									aria-hidden="true"
								/>
							</summary>
							<div class="space-y-3 border-t px-3 py-3">
								<p class="text-xs leading-relaxed text-muted-foreground">
									Everything you hold is selected. Uncheck what this key does not need — it can
									never exceed your role.
								</p>
								{#each data.scopeGroups as group (group.resource)}
									<fieldset class="space-y-1.5">
										<legend class="eyebrow mb-1.5">{group.resource}</legend>
										<div class="flex flex-wrap gap-1.5">
											{#each group.permissions as permission (permission)}
												<label
													class="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-card px-2 py-1 font-mono text-[11px] transition-colors select-none has-checked:border-foreground/25 has-checked:bg-secondary"
												>
													<input
														type="checkbox"
														name="permissions"
														value={permission}
														checked
														class="size-3 accent-[var(--brand)]"
													/>
													{permission.split(':')[1] ?? permission}
												</label>
											{/each}
										</div>
									</fieldset>
								{/each}
								{#if result?.fieldErrors?.permissions}<p class="text-xs text-destructive">
										{result.fieldErrors.permissions}
									</p>{/if}
							</div>
						</details>

						<Button type="submit" class="w-full">
							<PlusIcon aria-hidden="true" />
							Create API key
						</Button>
						<p class="text-xs leading-relaxed text-muted-foreground">
							The full key is shown once. Revoking a key or narrowing your role takes effect
							immediately.
						</p>
					</form>
				{:else}
					<p class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						Your role cannot create API keys. Ask an owner or admin if you need headless access.
					</p>
				{/if}
			</div>

			<div class="min-w-0">
				{#if !data.canReadKeys}
					<p class="p-4 text-sm text-muted-foreground">Your role cannot list API keys.</p>
				{:else if data.apiKeys.length === 0}
					<div class="p-4">
						<EmptyState
							icon={KeyRoundIcon}
							title="No API keys"
							description="Create a key for the CLI or CI. Prefer narrow scopes and a short expiry."
						/>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="data-table">
							<caption class="sr-only">API keys</caption>
							<thead>
								<tr>
									<th>Key</th>
									<th class="hidden md:table-cell">Created</th>
									<th class="hidden lg:table-cell">Last used</th>
									<th class="text-right">Status</th>
									<th><span class="sr-only">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								{#each data.apiKeys as key (key.id)}
									<tr>
										<td>
											<p class="font-medium">{key.name ?? 'Unnamed key'}</p>
											<p class="font-mono text-[11px] text-muted-foreground">
												{key.start ?? key.prefix ?? key.id} · {key.expiresAt
													? `expires ${formatDate(key.expiresAt)}`
													: 'no expiry'}
											</p>
										</td>
										<td class="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell"
											>{formatDate(key.createdAt)}</td
										>
										<td
											class="hidden text-xs whitespace-nowrap text-muted-foreground lg:table-cell"
										>
											{key.lastRequest ? formatDateTime(key.lastRequest) : 'never'}
										</td>
										<td class="text-right"><StatusBadge status={keyState(key)} /></td>
										<td class="text-right">
											{#if data.canRevokeKey}
												<form method="POST" action="?/deleteKey" use:enhance>
													<input type="hidden" name="keyId" value={key.id} />
													<Button
														type="submit"
														variant="ghost-danger"
														size="sm"
														onclick={(event) => {
															if (
																!confirm(
																	`Revoke ${key.name ?? 'this API key'}? Requests using it stop immediately.`
																)
															)
																event.preventDefault();
														}}
													>
														Revoke
													</Button>
												</form>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="border-t px-4 py-2.5 text-xs text-muted-foreground">
						Keys are user-owned. Their scopes are intersected with your current role on every
						request.
					</p>
				{/if}
			</div>
		</div>
	</Panel>
</div>
