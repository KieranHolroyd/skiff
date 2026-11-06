<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { toast } from 'svelte-sonner';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import ServerCogIcon from '@lucide/svelte/icons/server-cog';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UsersIcon from '@lucide/svelte/icons/users';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import type { Tone } from '#lib/status.js';
	import Panel from '../_lib/Panel.svelte';
	import { formatDate, plural, shortId } from '../_lib/format.js';
	import SettingsHeader from './_lib/SettingsHeader.svelte';
	import { ROLE_DESCRIPTIONS, ROLE_ORDER, initials, roleBadge } from './_lib/roles.js';
	import type { SectionHref } from './_lib/sections.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const AVATARS = 6;
	const shownMembers = $derived(data.members.slice(0, AVATARS));
	const roleCounts = $derived(
		ROLE_ORDER.map((role) => ({
			role,
			count: data.members.filter((member) => member.role === role).length
		})).filter((entry) => entry.count > 0)
	);

	const orgMark = $derived(initials(data.org.name));

	// --- rename (owners and admins) ---------------------------------------------------------------

	let renaming = $state(false);
	let saving = $state(false);
	let nameDraft = $state('');
	let slugDraft = $state('');
	function startRename() {
		nameDraft = data.org.name;
		slugDraft = data.org.slug ?? '';
		renaming = true;
	}

	// --- platform setup (owners) ----------------------------------------------------------------

	type Check = {
		id: string;
		label: string;
		icon: typeof MailIcon;
		href: SectionHref;
		optional?: boolean;
		state: 'done' | 'todo' | 'problem' | 'loading' | 'optional';
		detail: string;
	};

	const platform = $derived(data.hints.platform);
	const local = $derived(platform?.availability === 'local');

	function baseChecks(): Check[] {
		if (!platform) return [];
		return [
			{
				id: 'email',
				label: 'Outbound email',
				icon: MailIcon,
				href: '/(dashboard)/settings/notifications',
				state: platform.email ? 'done' : 'todo',
				detail: platform.email
					? 'Sign-in links and invitations are delivered.'
					: 'Sign-in links and invitations only reach the server log.'
			},
			{
				id: 'alerts',
				label: 'Alert channel',
				icon: BellRingIcon,
				href: '/(dashboard)/settings/notifications',
				state: platform.alerts ? 'done' : 'todo',
				detail: platform.alerts
					? 'Offline nodes, full disks and failed backups reach you.'
					: 'Nobody hears about an offline node or a failed backup.'
			},
			{
				id: 'assistant',
				label: 'Dashboard assistant',
				icon: SparklesIcon,
				href: '/(dashboard)/settings/assistant',
				optional: true,
				state: platform.assistant ? 'done' : 'optional',
				detail: platform.assistant
					? 'Members can ask the assistant and take guided tours.'
					: 'Optional. Bring any OpenAI-compatible provider.'
			}
		];
	}

	const backupTone: Record<Tone, Check['state']> = {
		success: 'done',
		neutral: 'todo',
		warning: 'todo',
		info: 'todo',
		brand: 'todo',
		danger: 'problem'
	};

	const stateLook = {
		done: { icon: CircleCheckIcon, class: 'text-success', label: 'Done' },
		todo: { icon: CircleDashedIcon, class: 'text-warning', label: 'To do' },
		problem: { icon: CircleXIcon, class: 'text-destructive', label: 'Problem' },
		loading: {
			icon: LoaderCircleIcon,
			class: 'animate-spin text-muted-foreground',
			label: 'Checking'
		},
		optional: { icon: CircleDashedIcon, class: 'text-muted-foreground/60', label: 'Optional' }
	} as const;
</script>

<svelte:head>
	<title>General · Settings · Skiff</title>
</svelte:head>

<SettingsHeader id="general" />

<!-- Identity and people -->
<div class="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
	<section
		class="relative overflow-hidden rounded-xl border bg-card shadow-xs"
		aria-labelledby="org-name"
	>
		<div class="relative flex flex-wrap items-center gap-4 p-5">
			<span
				class="flex size-14 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-semibold tracking-tight text-brand-foreground shadow-sm ring-4 ring-brand/10"
				aria-hidden="true">{orgMark}</span
			>
			{#if renaming}
				<form
					method="POST"
					action="?/rename"
					class="flex min-w-0 flex-1 flex-wrap items-end gap-2"
					use:enhance={() => {
						saving = true;
						return async ({ result, update }) => {
							await update({ reset: false });
							saving = false;
							if (result.type === 'success') {
								renaming = false;
								toast.success('Organisation renamed');
							} else if (result.type === 'failure')
								toast.error(
									String(
										(result.data as { message?: unknown } | undefined)?.message ??
											'Could not rename'
									)
								);
						};
					}}
				>
					<label class="grid min-w-48 flex-1 gap-1 text-xs text-muted-foreground">
						Name
						<Input
							name="name"
							required
							maxlength={64}
							bind:value={nameDraft}
							aria-label="Organisation name"
						/>
					</label>
					<label class="grid min-w-40 gap-1 text-xs text-muted-foreground">
						Slug
						<Input
							name="slug"
							required
							minlength={2}
							maxlength={48}
							pattern="[a-z0-9]+(-[a-z0-9]+)*"
							class="font-mono"
							bind:value={slugDraft}
							aria-label="Organisation slug"
						/>
					</label>
					<div class="flex gap-2">
						<Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
						<Button type="button" size="sm" variant="ghost" onclick={() => (renaming = false)}
							>Cancel</Button
						>
					</div>
				</form>
			{:else}
				<div class="min-w-0 flex-1 space-y-1">
					<h3 id="org-name" class="flex items-center gap-2 text-xl font-semibold tracking-tight">
						<span class="truncate">{data.org.name}</span>
						{#if data.canRename}
							<Button
								variant="ghost"
								size="icon-sm"
								class="text-muted-foreground"
								title="Rename organisation"
								aria-label="Rename organisation"
								onclick={startRename}><PencilIcon class="size-3.5" /></Button
							>
						{/if}
					</h3>
					<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
						<span class="font-mono text-xs">{data.org.slug ?? 'no slug'}</span>
						<span aria-hidden="true">·</span>
						<span>You are {data.role === 'admin' || data.role === 'owner' ? 'an' : 'a'}</span>
						<Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge>
						{#if data.platformAdmin}
							<Badge variant="outline" title="Manages nodes and installs Skiff updates"
								><ServerCogIcon />Platform admin</Badge
							>
						{/if}
					</p>
				</div>
			{/if}
		</div>
		<dl class="relative grid border-t text-sm sm:grid-cols-3 sm:divide-x">
			<div class="space-y-1 px-5 py-3.5">
				<dt class="text-xs text-muted-foreground">Organisation ID</dt>
				<dd class="flex items-center gap-1">
					<span class="truncate font-mono text-xs" title={data.org.id}
						>{shortId(data.org.id, 18)}</span
					>
					<CopyButton value={data.org.id} label="Copy organisation ID" iconOnly />
				</dd>
			</div>
			<div class="space-y-1 border-t px-5 py-3.5 sm:border-t-0">
				<dt class="text-xs text-muted-foreground">Created</dt>
				<dd>{data.org.createdAt ? formatDate(data.org.createdAt) : '—'}</dd>
			</div>
			<div class="space-y-1 border-t px-5 py-3.5 sm:border-t-0">
				<dt class="text-xs text-muted-foreground">Tenant boundary</dt>
				<dd class="text-pretty">Every project, database and key</dd>
			</div>
		</dl>
	</section>

	<section class="flex flex-col rounded-xl border bg-card shadow-xs" aria-labelledby="people">
		<div class="flex items-center justify-between gap-3 px-5 pt-5">
			<h3 id="people" class="flex items-center gap-2 font-medium">
				<UsersIcon class="size-4 text-muted-foreground" />People
			</h3>
			<span class="text-sm text-muted-foreground tabular-nums"
				>{data.members.length} {plural(data.members.length, 'member')}</span
			>
		</div>
		<div class="flex flex-1 flex-col justify-center gap-4 px-5 py-5">
			{#if data.members.length === 0}
				<p class="text-sm text-muted-foreground">
					Members are still loading. The auth tables may be initialising on first boot.
				</p>
			{:else}
				<div class="flex items-center">
					<div class="flex -space-x-2">
						{#each shownMembers as member (member.userId)}
							<Avatar.Root class="size-9 ring-2 ring-card" title="{member.name} · {member.role}">
								<Avatar.Fallback
									class="text-xs font-semibold {member.role === 'owner'
										? 'bg-brand/15 text-brand'
										: ''}">{initials(member.name)}</Avatar.Fallback
								>
							</Avatar.Root>
						{/each}
						{#if data.members.length > AVATARS}
							<span
								class="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-card"
								>+{data.members.length - AVATARS}</span
							>
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each roleCounts as entry (entry.role)}
						<Badge variant="outline" class="font-normal">
							<span class="font-medium tabular-nums">{entry.count}</span>
							{entry.count === 1 ? entry.role : `${entry.role}s`}
						</Badge>
					{/each}
					{#if data.hints.invitations}
						<Badge variant="info" class="font-normal">
							<span class="font-medium tabular-nums">{data.hints.invitations}</span> invited
						</Badge>
					{/if}
				</div>
			{/if}
		</div>
		<div class="border-t px-5 py-3">
			<a
				href={resolve('/(dashboard)/settings/members')}
				class="group inline-flex items-center gap-1.5 text-sm font-medium"
			>
				{data.permissions.includes('member:invite')
					? 'Manage and invite members'
					: 'See all members'}
				<ArrowRightIcon class="size-3.5 transition-transform group-hover:translate-x-0.5" />
			</a>
		</div>
	</section>
</div>

<!-- Platform setup: owners only -->
{#if platform}
	{#await platform.backups}
		{@render setup([
			{
				id: 'backups',
				label: 'Off-site backups',
				icon: DatabaseBackupIcon,
				href: '/(dashboard)/settings/backups',
				state: 'loading',
				detail: 'Checking Litestream and the last restore drill…'
			},
			...baseChecks()
		])}
	{:then status}
		{@render setup([
			{
				id: 'backups',
				label: 'Off-site backups',
				icon: DatabaseBackupIcon,
				href: '/(dashboard)/settings/backups',
				state: status ? backupTone[status.tone] : 'todo',
				detail: status?.detail ?? 'Backup status is unavailable right now.'
			},
			...baseChecks()
		])}
	{/await}
{/if}

{#snippet setup(checks: Check[])}
	{@const essentials = checks.filter((check) => !check.optional)}
	{@const done = essentials.filter((check) => check.state === 'done').length}
	{@const complete = done === essentials.length}
	<Panel
		title="Platform setup"
		icon={complete ? CircleCheckIcon : TriangleAlertIcon}
		description={complete
			? 'Everything an install needs is in place.'
			: 'What this install needs before you can rely on it. Each row opens where it is fixed.'}
		flush
	>
		{#snippet actions()}
			<div class="flex items-center gap-3">
				<span class="text-sm text-muted-foreground tabular-nums">
					<span class="font-medium text-foreground">{done}</span> of {essentials.length}
				</span>
				<Progress
					value={(done / Math.max(essentials.length, 1)) * 100}
					class="hidden h-1.5 w-24 sm:block {complete
						? '[&_[data-slot=progress-indicator]]:bg-success'
						: '[&_[data-slot=progress-indicator]]:bg-warning'}"
					aria-label="Setup progress"
				/>
			</div>
		{/snippet}
		<ul class="divide-y">
			{#each checks as check (check.id)}
				{@const look = stateLook[check.state]}
				<li>
					<a
						href={resolve(check.href)}
						class="group flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-muted/40"
					>
						<look.icon class="size-[1.125rem] shrink-0 {look.class}" aria-label={look.label} />
						<span
							class="hidden size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground sm:flex"
						>
							<check.icon class="size-4" />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex flex-wrap items-center gap-2 text-sm font-medium">
								{check.label}
								{#if check.optional}<span class="text-xs font-normal text-muted-foreground"
										>optional</span
									>{/if}
							</span>
							<span class="block text-sm text-pretty text-muted-foreground">{check.detail}</span>
						</span>
						<ChevronRightIcon
							class="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
						/>
					</a>
				</li>
			{/each}
			{#if data.updateAvailable}
				{#await data.updateAvailable then update}
					{#if update}
						<li>
							<a
								href={resolve('/(dashboard)/settings/updates')}
								class="group flex items-center gap-3.5 bg-brand/5 px-4 py-3 transition-colors hover:bg-brand/10"
							>
								<CircleArrowUpIcon class="size-[1.125rem] shrink-0 text-brand" />
								<span
									class="hidden size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground sm:flex"
								>
									<ServerCogIcon class="size-4" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="text-sm font-medium"
										>Skiff <span class="font-mono">{update.latest}</span> is available</span
									>
									<span class="block text-sm text-muted-foreground">
										Running {update.current}. Upgrades snapshot first and roll back on failure.
									</span>
								</span>
								<ChevronRightIcon
									class="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
								/>
							</a>
						</li>
					{/if}
				{/await}
			{/if}
		</ul>
		{#snippet footer()}
			<p>
				{#if local}
					Local dev server: settings are saved to <code>.data/platform-settings.json</code> and apply
					after a restart.
				{:else}
					Platform settings are owner-only and every change is recorded in the audit log.
				{/if}
			</p>
		{/snippet}
	</Panel>
{/snippet}

<!-- What the viewer's role can do -->
<section id="access" class="scroll-mt-24">
	<Panel
		title="Your access"
		icon={ShieldCheckIcon}
		description="Exactly what the {data.role} role can do here. The dashboard, API, CLI and MCP all enforce the same table."
		flush
	>
		{#snippet actions()}
			<span class="text-sm text-muted-foreground tabular-nums">
				<span class="font-medium text-foreground">{data.heldCount}</span> of {data.totalCount}
				permissions
			</span>
		{/snippet}
		<div class="border-b bg-muted/30 px-4 py-3">
			<p class="flex flex-wrap items-center gap-2 text-sm">
				<Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge>
				<span class="text-muted-foreground">{ROLE_DESCRIPTIONS[data.role] ?? ''}.</span>
			</p>
		</div>
		<!-- 1px gaps over a border-coloured background draw the grid lines. -->
		<div class="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
			{#each data.access as group (group.resource)}
				{@const heldHere = group.actions.filter((action) => action.held).length}
				<div class="space-y-2.5 bg-card px-4 py-3.5">
					<p class="flex items-center justify-between gap-2 text-sm font-medium">
						{group.label}
						<span
							class="text-xs font-normal tabular-nums {heldHere === 0
								? 'text-muted-foreground/60'
								: heldHere === group.actions.length
									? 'text-success'
									: 'text-muted-foreground'}"
						>
							{heldHere === group.actions.length
								? 'Full'
								: heldHere === 0
									? 'None'
									: `${heldHere}/${group.actions.length}`}
						</span>
					</p>
					<ul class="flex flex-wrap gap-1.5">
						{#each group.actions as action (action.action)}
							<li
								class="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.7rem] {action.held
									? action.destructive
										? 'border-destructive/25 bg-destructive/5 text-destructive'
										: 'bg-background text-foreground'
									: 'border-dashed text-muted-foreground/60 line-through decoration-muted-foreground/40'}"
								title={action.held
									? action.destructive
										? 'Held — destructive'
										: 'Held'
									: 'Not held by your role'}
							>
								{#if action.held}<CheckIcon class="size-3" />{:else}<MinusIcon
										class="size-3"
									/>{/if}
								{action.action}
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
		{#snippet footer()}
			<span class="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span class="inline-flex items-center gap-1.5"
					><span class="size-2 rounded-sm border border-destructive/40 bg-destructive/10"
					></span>Destructive</span
				>
				<span class="inline-flex items-center gap-1.5"
					><span class="size-2 rounded-sm border border-dashed"></span>Not held</span
				>
				<span>API keys and agents only ever get a subset of this.</span>
				{#if data.permissions.includes('apiKey:create')}
					<Button
						href={resolve('/(dashboard)/settings/api-keys')}
						variant="link"
						size="sm"
						class="h-auto p-0 text-xs">Create a scoped key</Button
					>
				{/if}
			</span>
		{/snippet}
	</Panel>
</section>
