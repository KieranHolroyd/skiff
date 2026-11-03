<script lang="ts">
	import { enhance } from '$app/forms';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import CopyButton from '../_lib/CopyButton.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import { formatDateTime, shortId } from '../_lib/format.js';
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

	const selectClass =
		'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

	function roleBadge(role: string): 'default' | 'secondary' | 'outline' {
		if (role === 'owner') return 'default';
		if (role === 'admin') return 'secondary';
		return 'outline';
	}

	function keyState(key: { enabled: boolean; expiresAt: string | null }): {
		label: string;
		variant: 'default' | 'secondary' | 'destructive' | 'outline';
	} {
		if (!key.enabled) return { label: 'disabled', variant: 'outline' };
		if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())
			return { label: 'expired', variant: 'destructive' };
		return { label: 'active', variant: 'default' };
	}
</script>

<svelte:head>
	<title>Organisation settings · Skiff</title>
</svelte:head>

<div class="space-y-6">
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

	{#if result?.createdKey}
		<Card.Root size="sm" class="border-emerald-300/70 dark:border-emerald-500/30">
			<Card.Header class="border-b pb-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<Card.Title>{result.createdKeyName ?? 'API key'} created</Card.Title>
						<Card.Description
							>Copy this key now. It is stored hashed and cannot be shown again.</Card.Description
						>
					</div>
					<CopyButton value={result.createdKey} label="Copy key" variant="default" />
				</div>
			</Card.Header>
			<Card.Content class="space-y-3">
				<Input
					readonly
					value={result.createdKey}
					class="font-mono text-xs"
					aria-label="New API key"
				/>
				{#if result.createdKeyScopes?.length}
					<div class="space-y-1">
						<p class="text-xs text-muted-foreground">Scopes granted to this key</p>
						<div class="flex flex-wrap gap-1">
							{#each result.createdKeyScopes as scope (scope)}
								<Badge variant="outline">{scope}</Badge>
							{/each}
						</div>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<div class="grid items-start gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header class="border-b pb-4">
				<Card.Title>Organisation</Card.Title>
				<Card.Description>Tenant boundary for every project and deployment.</Card.Description>
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
					<dt class="text-muted-foreground">Name</dt>
					<dd class="font-medium">{data.org.name}</dd>
					<dt class="text-muted-foreground">Slug</dt>
					<dd class="font-mono text-xs">{data.org.slug ?? '—'}</dd>
					<dt class="text-muted-foreground">Your role</dt>
					<dd><Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge></dd>
					<dt class="text-muted-foreground">Created</dt>
					<dd>{formatDateTime(data.org.createdAt)}</dd>
					<dt class="text-muted-foreground">Org ID</dt>
					<dd class="font-mono text-xs" title={data.org.id}>{shortId(data.org.id, 18)}</dd>
					<dt class="text-muted-foreground">Members</dt>
					<dd>{data.members.length}</dd>
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="flex-row items-center justify-between gap-2 border-b pb-4">
				<div class="space-y-1">
					<Card.Title>Members</Card.Title>
					<Card.Description
						>Roles are enforced identically by the dashboard, API, CLI and MCP.</Card.Description
					>
				</div>
				<UsersIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			</Card.Header>
			<Card.Content class="p-0">
				{#if data.members.length === 0}
					<div class="p-4">
						<EmptyState
							title="No members loaded"
							description="The auth tables may still be initialising on first boot."
						/>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<caption class="sr-only">Organisation members</caption>
							<thead>
								<tr class="border-b text-left text-xs text-muted-foreground">
									<th class="px-4 py-2.5 font-medium">Member</th>
									<th class="px-4 py-2.5 font-medium">Role</th>
									<th class="hidden px-4 py-2.5 font-medium sm:table-cell">Joined</th>
								</tr>
							</thead>
							<tbody>
								{#each data.members as member (member.userId)}
									<tr class="border-b last:border-0">
										<td class="px-4 py-3">
											<p class="font-medium">{member.name}</p>
											{#if member.email}
												<p class="text-xs text-muted-foreground">{member.email}</p>
											{:else}
												<p class="text-xs text-muted-foreground">Email hidden</p>
											{/if}
										</td>
										<td class="px-4 py-3"
											><Badge variant={roleBadge(member.role)} class="capitalize"
												>{member.role}</Badge
											></td
										>
										<td
											class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
										>
											{formatDateTime(member.joinedAt)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if !data.canSeeEmails}
						<p class="border-t px-4 py-2 text-xs text-muted-foreground">
							Member emails are visible to owners and admins only.
						</p>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header class="border-b pb-4">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="space-y-1">
					<Card.Title>API keys</Card.Title>
					<Card.Description>
						Headless access for CI, scripts and the CLI. A key's effective permissions are always a
						subset of your current role.
					</Card.Description>
				</div>
				<KeyRoundIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			</div>
		</Card.Header>
		<Card.Content class="space-y-5">
			{#if data.apiKeysError}
				<div
					class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
					role="status"
				>
					{data.apiKeysError}
				</div>
			{/if}

			<div class="grid items-start gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
				{#if data.canCreateKey}
					<form
						method="POST"
						action="?/createKey"
						use:enhance
						class="space-y-3 rounded-lg border bg-muted/20 p-3"
					>
						<div class="space-y-1.5">
							<Label for="key-name">Key name</Label>
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
							<Label for="key-expiry">Expires</Label>
							<select id="key-expiry" name="expiresIn" class={selectClass}>
								<option value="30">30 days</option>
								<option value="90" selected>90 days</option>
								<option value="365">365 days</option>
								<option value="never">No expiry</option>
							</select>
						</div>

						<details class="rounded-md border bg-background/60 p-2.5" open>
							<summary class="cursor-pointer text-xs font-medium">Scopes</summary>
							<p class="mt-1 text-xs text-muted-foreground">
								All scopes you hold are selected by default. Uncheck anything this key does not
								need. A key can never exceed your role.
							</p>
							<div class="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
								{#each data.scopeGroups as group (group.resource)}
									<fieldset class="space-y-1">
										<legend
											class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
											>{group.resource}</legend
										>
										{#each group.permissions as permission (permission)}
											<label class="flex items-center gap-2 text-xs">
												<input
													type="checkbox"
													name="permissions"
													value={permission}
													checked
													class="size-3.5 rounded border-input accent-foreground"
												/>
												<span class="font-mono">{permission}</span>
											</label>
										{/each}
									</fieldset>
								{/each}
							</div>
							{#if result?.fieldErrors?.permissions}<p class="mt-1 text-xs text-destructive">
									{result.fieldErrors.permissions}
								</p>{/if}
						</details>

						<Button type="submit" class="w-full" size="sm">
							<KeyRoundIcon class="size-3.5" aria-hidden="true" />
							Create API key
						</Button>
						<p class="text-xs text-muted-foreground">
							The full key is shown once. Revoking a key or narrowing your role takes effect
							immediately.
						</p>
					</form>
				{:else}
					<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						Your role cannot create API keys. Ask an owner or admin if you need headless access.
					</div>
				{/if}

				<div class="min-w-0">
					{#if !data.canReadKeys}
						<p class="text-sm text-muted-foreground">Your role cannot list API keys.</p>
					{:else if data.apiKeys.length === 0}
						<EmptyState
							title="No API keys"
							description="Create a key for the CLI or CI. Prefer narrow scopes and a short expiry."
						/>
					{:else}
						<div class="overflow-x-auto rounded-lg border">
							<table class="w-full text-sm">
								<caption class="sr-only">API keys</caption>
								<thead>
									<tr class="border-b text-left text-xs text-muted-foreground">
										<th class="px-3 py-2.5 font-medium">Key</th>
										<th class="hidden px-3 py-2.5 font-medium md:table-cell">Created</th>
										<th class="hidden px-3 py-2.5 font-medium lg:table-cell">Last used</th>
										<th class="px-3 py-2.5 text-right font-medium">Status</th>
										<th class="px-3 py-2.5"><span class="sr-only">Actions</span></th>
									</tr>
								</thead>
								<tbody>
									{#each data.apiKeys as key (key.id)}
										{@const state = keyState(key)}
										<tr class="border-b last:border-0">
											<td class="px-3 py-3">
												<p class="font-medium">{key.name ?? 'Unnamed key'}</p>
												<p class="font-mono text-xs text-muted-foreground">
													{key.start ?? key.prefix ?? key.id}
												</p>
												{#if key.expiresAt}
													<p class="text-xs text-muted-foreground">
														expires {formatDateTime(key.expiresAt)}
													</p>
												{:else}
													<p class="text-xs text-muted-foreground">no expiry</p>
												{/if}
											</td>
											<td
												class="hidden px-3 py-3 text-xs whitespace-nowrap text-muted-foreground md:table-cell"
												>{formatDateTime(key.createdAt)}</td
											>
											<td
												class="hidden px-3 py-3 text-xs whitespace-nowrap text-muted-foreground lg:table-cell"
											>
												{key.lastRequest ? formatDateTime(key.lastRequest) : 'never'}
											</td>
											<td class="px-3 py-3 text-right"
												><Badge variant={state.variant}>{state.label}</Badge></td
											>
											<td class="px-3 py-3 text-right">
												{#if data.canRevokeKey}
													<form method="POST" action="?/deleteKey" use:enhance>
														<input type="hidden" name="keyId" value={key.id} />
														<Button
															type="submit"
															variant="ghost"
															size="xs"
															class="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
						<p class="mt-2 text-xs text-muted-foreground">
							Keys are user-owned. Their scopes are intersected with your current role on every
							request.
						</p>
					{/if}
				</div>
			</div>
		</Card.Content>
	</Card.Root>
</div>
