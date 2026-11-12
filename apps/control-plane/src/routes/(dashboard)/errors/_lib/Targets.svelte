<script lang="ts">
	/* Links are relative query strings on this page, or a project page. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import type { AppErrorServiceView, AppErrorTargetView } from '@yoal/contracts';
	import BugIcon from '@lucide/svelte/icons/bug';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CrosshairIcon from '@lucide/svelte/icons/crosshair';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FolderGit2Icon from '@lucide/svelte/icons/folder-git-2';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import Bars from './Bars.svelte';
	import { compactNumber, dayLabels, targetHealth, toneDot } from './issue-ui.js';

	let {
		service,
		projects,
		canManage
	}: {
		service: AppErrorServiceView;
		projects: Array<{ slug: string; name: string }>;
		canManage: boolean;
	} = $props();

	const autoLinked = $derived(service.targets.filter((target) => target.autoLinked).length);
	const week = dayLabels(7);

	let adding = $state(false);
	let addKind = $state<'project' | 'standalone'>('project');
	let editing = $state<AppErrorTargetView | null>(null);
	let editOpen = $state(false);
	let notify = $state(true);
	let autoBusy = $state(false);

	$effect(() => {
		if (projects.length === 0) addKind = 'standalone';
	});

	function edit(target: AppErrorTargetView) {
		editing = target;
		notify = target.notify;
		editOpen = true;
	}

	async function setAutoLink(enabled: boolean) {
		if (!enabled) {
			askConfirm({
				title: 'Turn automatic linking off?',
				description: `The ${autoLinked} target${autoLinked === 1 ? '' : 's'} it created will be disabled and stop accepting events. Their issues are kept, and targets you enabled by hand stay on.`,
				confirmLabel: 'Turn off',
				action: '?/setAutoLink',
				fields: { enabled: 'false' }
			});
			return;
		}
		autoBusy = true;
		try {
			await runAction('?/setAutoLink', { enabled: 'true' });
		} finally {
			autoBusy = false;
		}
	}

	function rotate(target: AppErrorTargetView) {
		askConfirm({
			title: `Rotate the key for ${target.name}?`,
			description:
				'A new DSN is issued now. The current one keeps working for 24 hours, so update every app that sends to it before then.',
			confirmLabel: 'Rotate key',
			action: '?/rotateTargetKey',
			fields: { targetId: target.id }
		});
	}

	function remove(target: AppErrorTargetView) {
		askConfirm({
			title: `Delete ${target.name}?`,
			description:
				'Its DSN stops working at once, and every issue, event and count it holds is deleted. This cannot be undone.',
			confirmLabel: 'Delete target',
			tone: 'danger',
			action: '?/deleteTarget',
			fields: { targetId: target.id },
			typeToConfirm: target.name
		});
	}

	async function copyDsn(target: AppErrorTargetView) {
		if (!target.dsn) return;
		try {
			await navigator.clipboard.writeText(target.dsn);
			toast.success('DSN copied.');
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}

	/** `2026-11` → "November 2026". */
	function monthName(month: string): string {
		const [year, index] = month.split('-').map(Number);
		if (!year || !index) return month;
		return new Intl.DateTimeFormat('en-GB', {
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(Date.UTC(year, index - 1, 1));
	}

	function usagePct(target: AppErrorTargetView): number {
		return target.usage.limit > 0 ? (target.usage.accepted / target.usage.limit) * 100 : 0;
	}
</script>

<div class="space-y-5">
	<Card.Root class="gap-0 py-0">
		<Card.Content class="flex flex-wrap items-center gap-4 py-4">
			<span class="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/40">
				<Link2Icon class="size-4 text-muted-foreground" />
			</span>
			<div class="min-w-0 flex-1 space-y-0.5">
				<p class="flex items-center gap-2 text-sm font-medium">
					Automatic linking
					<Badge variant={service.autoLink ? 'success' : 'neutral'}
						>{service.autoLink ? 'On' : 'Off'}</Badge
					>
				</p>
				<p class="text-xs text-pretty text-muted-foreground">
					{#if service.autoLink}
						Every project has a target, and new projects get one as they are created. Process apps
						and functions receive <code class="font-mono">SENTRY_DSN</code> on their next deploy.
					{:else}
						Turn on to give every current and future project a target, with
						<code class="font-mono">SENTRY_DSN</code> injected on deploy. No code changes for apps that
						already use a Sentry SDK.
					{/if}
				</p>
			</div>
			<span class="hidden text-xs text-muted-foreground tabular-nums sm:inline">
				{autoLinked} auto-linked · {service.summary.reporting24h} of {service.summary.targets} reporting
			</span>
			<Switch
				checked={service.autoLink}
				onCheckedChange={(value) => setAutoLink(value)}
				disabled={!canManage || autoBusy}
				aria-label="Automatic linking"
			/>
		</Card.Content>
	</Card.Root>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<CrosshairIcon class="size-4 text-muted-foreground" />Targets
				<Badge variant="secondary" class="tabular-nums">{service.targets.length}</Badge>
			</Card.Title>
			<Card.Description>
				Each target has its own DSN. Errors sent to it are grouped into issues.
			</Card.Description>
			{#if canManage}
				<Card.Action class="self-center">
					<Button size="sm" onclick={() => (adding = true)}><PlusIcon />Add target</Button>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content class="px-0">
			{#if service.targets.length === 0}
				<div class="p-4">
					<EmptyState
						icon={CrosshairIcon}
						title="No targets yet"
						description="Turn on automatic linking, or add a target for one project or an app outside Yoal."
						compact
					>
						<Button href="?tab=setup"><RocketIcon />Guided setup</Button>
					</EmptyState>
				</div>
			{:else}
				<ul class="divide-y">
					{#each service.targets as target (target.id)}
						{@const health = targetHealth(target)}
						{@const pct = usagePct(target)}
						<li class="px-4 py-3.5 {target.enabled ? '' : 'bg-muted/20'}">
							<div class="flex flex-wrap items-center gap-x-5 gap-y-3">
								<div class="flex min-w-0 flex-1 items-start gap-3">
									<span
										class="relative mt-1.5 inline-grid size-2 shrink-0 place-items-center"
										title={health.description}
									>
										{#if health.live}
											<span
												class="absolute inline-flex size-full animate-ping rounded-full opacity-50 {toneDot(
													health.tone
												)}"
											></span>
										{/if}
										<span class="relative size-2 rounded-full {toneDot(health.tone)}"></span>
									</span>
									<div class="min-w-0 space-y-0.5">
										<p class="flex flex-wrap items-center gap-1.5">
											<a
												href="?tab=issues&target={target.id}"
												class="font-medium hover:underline {target.enabled
													? ''
													: 'text-muted-foreground'}"
											>
												{target.name}
											</a>
											<Badge variant="outline" class="gap-1 font-normal">
												{#if target.kind === 'project'}<FolderGit2Icon class="size-3" />Yoal project{:else}<GlobeIcon
														class="size-3"
													/>Off-platform{/if}
											</Badge>
											{#if target.autoLinked}<Badge variant="neutral" class="font-normal"
													>auto-linked</Badge
												>{/if}
											{#if pct >= 80}
												<Badge variant={pct >= 100 ? 'danger' : 'warning'} class="font-normal">
													{Math.round(pct)}% of monthly cap
												</Badge>
											{/if}
										</p>
										<p class="text-xs text-muted-foreground">
											<span>{health.label}</span>
											{#if target.lastSeenAt}
												· <span title={formatDateTime(target.lastSeenAt)}
													>last event {formatRelative(target.lastSeenAt)}</span
												>
											{/if}
											{#if target.projectSlug}
												· <a
													href="/projects/{target.projectSlug}"
													class="font-mono hover:text-foreground hover:underline"
													>{target.projectSlug}</a
												>
											{/if}
										</p>
									</div>
								</div>

								<Bars
									values={target.daily}
									labels={week}
									showHeader={false}
									height="h-7"
									class="hidden w-24 md:block"
								/>

								<a href="?tab=issues&target={target.id}" class="w-20 text-right hover:underline">
									<span
										class="block text-sm font-medium tabular-nums {target.unresolved > 0
											? 'text-destructive'
											: ''}"
									>
										{compactNumber(target.unresolved)}
									</span>
									<span class="text-xs text-muted-foreground">unresolved</span>
								</a>
								<div class="hidden w-16 text-right sm:block">
									<span class="block text-sm font-medium tabular-nums"
										>{compactNumber(target.events24h)}</span
									>
									<span class="text-xs text-muted-foreground">in 24h</span>
								</div>

								<RowMenu label="Actions for {target.name}">
									<DropdownMenu.Item onSelect={() => goto(`?tab=issues&target=${target.id}`)}
										><BugIcon />View issues</DropdownMenu.Item
									>
									<DropdownMenu.Item onSelect={() => goto(`?tab=setup&target=${target.id}`)}
										><RocketIcon />Setup guide</DropdownMenu.Item
									>
									{#if target.dsn}
										<DropdownMenu.Item onSelect={() => copyDsn(target)}
											><CopyIcon />Copy DSN</DropdownMenu.Item
										>
									{/if}
									{#if canManage}
										<DropdownMenu.Item
											disabled={!target.enabled}
											onSelect={() => runAction('?/testTarget', { targetId: target.id })}
										>
											<SendIcon />Send test error
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item onSelect={() => edit(target)}
											><SettingsIcon />Settings…</DropdownMenu.Item
										>
										<DropdownMenu.Item onSelect={() => rotate(target)}
											><KeyRoundIcon />Rotate key…</DropdownMenu.Item
										>
										<DropdownMenu.Item
											onSelect={() =>
												runAction('?/toggleTarget', {
													targetId: target.id,
													enabled: target.enabled ? 'false' : 'true'
												})}
										>
											<PowerIcon />{target.enabled ? 'Disable' : 'Enable'}
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => remove(target)}
											><TrashIcon />Delete…</DropdownMenu.Item
										>
									{/if}
								</RowMenu>
							</div>

							{#if target.dsn}
								<div class="mt-2.5 flex min-w-0 items-center gap-2 pl-5">
									<span class="shrink-0 text-xs text-muted-foreground">DSN</span>
									<code
										class="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
										title={target.dsn}>{target.dsn}</code
									>
									<CopyButton
										value={target.dsn}
										label="Copy DSN"
										iconOnly
										variant="ghost"
										size="icon-xs"
									/>
									<a
										href="?tab=setup&target={target.id}"
										class="ms-auto hidden shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
									>
										Setup guide<ArrowRightIcon class="size-3" />
									</a>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

{#if canManage}
	<FormDialog
		bind:open={adding}
		title="Add a target"
		description="A target gets its own DSN. Errors sent to it are grouped into issues here."
		icon={CrosshairIcon}
		action={addKind === 'project' ? '?/linkProject' : '?/createTarget'}
		submitLabel={addKind === 'project' ? 'Link project' : 'Create target'}
	>
		<div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Kind of target">
			{#each [{ id: 'project', icon: FolderGit2Icon, title: 'A Yoal project', text: 'DSN injected on deploy.', disabled: projects.length === 0 }, { id: 'standalone', icon: GlobeIcon, title: 'An app outside Yoal', text: 'Paste the DSN yourself.', disabled: false }] as const as option (option.id)}
				<button
					type="button"
					role="radio"
					aria-checked={addKind === option.id}
					disabled={option.disabled}
					class="flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 {addKind ===
					option.id
						? 'border-primary bg-muted/40 shadow-xs'
						: 'hover:bg-muted/50'}"
					onclick={() => (addKind = option.id)}
				>
					<option.icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<span>
						<span class="block text-sm font-medium">{option.title}</span>
						<span class="block text-xs text-muted-foreground">
							{option.disabled ? 'Every project is already linked.' : option.text}
						</span>
					</span>
				</button>
			{/each}
		</div>
		{#if addKind === 'project'}
			<Field.Field>
				<Field.Label for="add-project">Project</Field.Label>
				<NativeSelect.Root id="add-project" name="project" required class="w-full">
					{#each projects as project (project.slug)}
						<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
		{:else}
			<Field.Field>
				<Field.Label for="add-name">Name</Field.Label>
				<Input
					id="add-name"
					name="name"
					placeholder="Marketing site"
					required
					maxlength={100}
					autocomplete="off"
				/>
				<Field.Description>Shown in the issue list. You can rename it later.</Field.Description>
			</Field.Field>
		{/if}
	</FormDialog>

	{#if editing}
		{@const target = editing}
		<FormDialog
			bind:open={editOpen}
			title="{target.name} settings"
			icon={SettingsIcon}
			action="?/updateTarget"
			submitLabel="Save"
		>
			<input type="hidden" name="targetId" value={target.id} />
			{#if target.kind === 'standalone'}
				<Field.Field>
					<Field.Label for="target-name">Name</Field.Label>
					<Input id="target-name" name="name" value={target.name} required maxlength={100} />
				</Field.Field>
			{/if}
			<Field.Field>
				<Field.Label for="target-sample">Stored-event sample rate</Field.Label>
				<Input
					id="target-sample"
					name="sampleRate"
					type="number"
					min="0"
					max="1"
					step="0.05"
					value={target.sampleRate}
					class="w-28"
				/>
				<Field.Description>
					The share of events whose full payload (stack, tags, context) is kept. Counts and charts
					always include every event. 1 keeps all of them.
				</Field.Description>
			</Field.Field>
			<Field.Field orientation="horizontal">
				<Switch id="target-notify" bind:checked={notify} />
				<input type="hidden" name="notify" value={notify ? 'true' : 'false'} />
				<Field.Content>
					<Field.Label for="target-notify">Notify on new and regressed issues</Field.Label>
					<Field.Description
						>Sent through the platform's notification channels, at most 10 an hour.</Field.Description
					>
				</Field.Content>
			</Field.Field>
			<div class="space-y-1.5 rounded-lg border bg-muted/30 p-3">
				<div class="flex items-center justify-between text-xs">
					<span class="font-medium">Usage in {monthName(target.usage.month)}</span>
					<span class="text-muted-foreground tabular-nums">
						{target.usage.accepted.toLocaleString('en-GB')} / {target.usage.limit.toLocaleString(
							'en-GB'
						)}
					</span>
				</div>
				<Progress
					value={Math.min(100, usagePct(target))}
					class="h-1.5"
					aria-label="Monthly usage"
				/>
				<p class="text-xs text-muted-foreground">
					{target.usage.dropped.toLocaleString('en-GB')} dropped over the cap ·
					{target.usage.ignored.toLocaleString('en-GB')} non-error items ignored
				</p>
			</div>
		</FormDialog>
	{/if}
{/if}
