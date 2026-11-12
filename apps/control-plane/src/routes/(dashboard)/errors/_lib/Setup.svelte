<script lang="ts">
	/* Links are relative query strings on this page, or a project page. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import type { AppErrorServiceView, AppErrorTargetView } from '@yoal/contracts';
	import { untrack } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import CheckIcon from '@lucide/svelte/icons/check';
	import FolderGit2Icon from '@lucide/svelte/icons/folder-git-2';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SendIcon from '@lucide/svelte/icons/send';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import XIcon from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { notify, runAction } from '#lib/actions.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { targetHealth, toneDot } from './issue-ui.js';
	import { PLACEHOLDER_DSN, SDKS, sdkById, storeCurl, type SdkId } from './sdks.js';

	/**
	 * Errors' guided setup (docs/APP-ERRORS.md §5): pick or create a target, paste one snippet, see
	 * the first event arrive. Each step is judged from live state, and the last one listens for the
	 * first event on its own so the reader never has to refresh.
	 */
	let {
		service,
		projects,
		origin,
		canManage,
		preselect
	}: {
		service: AppErrorServiceView;
		projects: Array<{ slug: string; name: string }>;
		origin: string;
		canManage: boolean;
		/** `?target=` from a "Setup guide" link. */
		preselect: string | null;
	} = $props();

	type Choice = 'auto' | 'project' | 'standalone';

	let selectedId = $state(
		untrack(
			() =>
				(preselect && service.targets.some((row) => row.id === preselect) ? preselect : null) ??
				service.targets.find((row) => row.enabled && !row.lastSeenAt)?.id ??
				service.targets[0]?.id ??
				''
		)
	);
	let creating = $state(untrack(() => service.targets.length === 0));
	let choice = $state<Choice>(untrack(() => (projects.length > 0 ? 'auto' : 'standalone')));
	let submitting = $state(false);
	let sdkId = $state<SdkId>('node');
	let environment = $state('production');
	let release = $state('');
	let useInjected = $state(true);
	let proof = $state<'yoal' | 'app' | 'terminal'>('yoal');
	let sending = $state(false);
	let lastChecked = $state<number | null>(null);

	const target = $derived<AppErrorTargetView | null>(
		service.targets.find((row) => row.id === selectedId) ?? service.targets[0] ?? null
	);
	const connected = $derived(Boolean(target?.lastSeenAt));
	const sdk = $derived(sdkById(sdkId));
	const injectable = $derived(
		Boolean(target && target.kind === 'project' && target.enabled && sdk.server)
	);
	const injected = $derived(injectable && useInjected);
	const dsn = $derived(target?.dsn ?? PLACEHOLDER_DSN);
	const init = $derived(sdk.init({ dsn, environment, release, injected, origin }));
	const curl = $derived(storeCurl(target?.dsn));
	const done = $derived((target ? 1 : 0) + (connected ? 2 : 0));

	// Pick up a target created in step 1 as soon as the page data has it.
	let known = new Set(untrack(() => service.targets.map((row) => row.id)));
	$effect(() => {
		const ids = service.targets.map((row) => row.id);
		const fresh = ids.find((id) => !known.has(id));
		known = new Set(ids);
		if (fresh) {
			untrack(() => {
				selectedId = fresh;
				creating = false;
			});
		} else if (ids.length > 0 && !ids.includes(untrack(() => selectedId))) {
			untrack(() => (selectedId = ids[0]!));
		}
	});

	// Listen for the first event: re-read the page every few seconds while this target is waiting
	// and the tab is visible, for up to 15 minutes.
	const listening = $derived(target && target.enabled && !connected ? target.id : null);
	$effect(() => {
		if (!listening) return;
		const started = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - started > 15 * 60_000) return clearInterval(timer);
			if (document.visibilityState !== 'visible') return;
			void invalidateAll().then(() => (lastChecked = Date.now()));
		}, 4000);
		return () => clearInterval(timer);
	});

	// Celebrate the moment the first event lands while the reader is watching.
	let wasWaiting = untrack(() => !connected);
	$effect(() => {
		if (connected && wasWaiting) toast.success(`First event received from ${target?.name}.`);
		wasWaiting = !connected;
	});

	async function sendTest() {
		if (!target || sending) return;
		sending = true;
		try {
			await runAction('?/testTarget', { targetId: target.id });
			lastChecked = Date.now();
		} finally {
			sending = false;
		}
	}

	async function turnOnNotifications() {
		if (!target) return;
		await runAction('?/updateTarget', { targetId: target.id, notify: 'true' });
	}

	function nextWaiting() {
		const next = service.targets.find(
			(row) => row.enabled && !row.lastSeenAt && row.id !== target?.id
		);
		if (next) selectedId = next.id;
		else creating = true;
		document
			.getElementById('setup-step-target')
			?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	const choices = $derived([
		...(projects.length > 0
			? [
					{
						id: 'auto' as const,
						icon: SparklesIcon,
						title: 'Every Yoal project',
						text: 'One switch. Every project, now and later, gets a DSN injected on deploy.',
						recommended: true
					},
					{
						id: 'project' as const,
						icon: FolderGit2Icon,
						title: 'One Yoal project',
						text: 'Link a single project and keep the rest untouched.',
						recommended: false
					}
				]
			: []),
		{
			id: 'standalone' as const,
			icon: GlobeIcon,
			title: 'An app outside Yoal',
			text: 'Vercel, a VPS, a phone app: anything that speaks Sentry.',
			recommended: false
		}
	]);

	const createAction = $derived(
		choice === 'auto' ? '?/setAutoLink' : choice === 'project' ? '?/linkProject' : '?/createTarget'
	);
</script>

{#snippet marker(state: 'done' | 'current' | 'upcoming', n: number)}
	<span
		class="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors {state ===
		'done'
			? 'border-success bg-success text-white'
			: state === 'current'
				? 'border-primary bg-background text-primary ring-4 ring-primary/15'
				: 'bg-background text-muted-foreground'}"
	>
		{#if state === 'done'}<CheckIcon class="size-4" aria-label="Done" />{:else}{n}{/if}
	</span>
{/snippet}

<div class="space-y-6">
	{#if connected && target}
		<section
			class="relative overflow-hidden rounded-xl border border-success/30 bg-success/5 p-5 shadow-xs"
			aria-live="polite"
		>
			<div class="flex flex-wrap items-center gap-4">
				<span
					class="grid size-11 shrink-0 place-items-center rounded-full bg-success text-white shadow-sm"
				>
					<CheckIcon class="size-6" />
				</span>
				<div class="min-w-0 flex-1">
					<p class="text-base font-semibold">{target.name} is reporting errors</p>
					<p class="text-sm text-muted-foreground">
						First event {formatRelative(target.firstSeenAt ?? target.lastSeenAt)}, last
						{formatRelative(target.lastSeenAt)}. New errors are grouped into issues as they arrive.
					</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button href="?tab=issues&target={target.id}">View issues<ArrowRightIcon /></Button>
					{#if canManage && !target.notify}
						<Button variant="outline" onclick={turnOnNotifications}
							><BellRingIcon />Notify me of new issues</Button
						>
					{/if}
					<Button variant="ghost" onclick={nextWaiting}><PlusIcon />Set up another</Button>
				</div>
			</div>
		</section>
	{:else}
		<section
			class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card p-4 shadow-xs"
		>
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm font-medium">
					{done === 0
						? 'Three steps, about two minutes'
						: 'Almost there: paste the snippet and send one error'}
				</p>
				<p class="text-xs text-muted-foreground">
					Already using Sentry? Swap the DSN in your existing <code class="font-mono"
						>Sentry.init</code
					> and skip to step 3. Nothing else changes.
				</p>
			</div>
			<div class="flex w-full items-center gap-3 sm:w-56">
				<Progress value={(done / 3) * 100} class="h-1.5" aria-label="Setup progress" />
				<span class="shrink-0 text-xs text-muted-foreground tabular-nums"
					>{Math.min(done, 3)} of 3</span
				>
			</div>
		</section>
	{/if}

	<ol
		class="relative space-y-8 before:absolute before:top-3 before:bottom-3 before:left-[13px] before:w-px before:bg-border"
	>
		<!-- 1. Target -->
		<li id="setup-step-target" class="relative flex scroll-mt-20 gap-4">
			{@render marker(target && !creating ? 'done' : 'current', 1)}
			<div class="min-w-0 flex-1 space-y-4 pt-0.5">
				<div>
					<h2 class="font-medium">Choose where errors go</h2>
					<p class="text-sm text-muted-foreground">
						A target is one DSN. Use a Yoal project, or any app that runs somewhere else.
					</p>
				</div>

				{#if service.targets.length > 0 && !creating}
					<div class="flex flex-wrap items-center gap-2">
						<NativeSelect.Root bind:value={selectedId} class="w-full sm:w-80" aria-label="Target">
							{#each service.targets as row (row.id)}
								<NativeSelect.Option value={row.id}>
									{row.name} — {targetHealth(row).label.toLowerCase()}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						{#if canManage}
							<Button variant="ghost" size="sm" onclick={() => (creating = true)}
								><PlusIcon />New target</Button
							>
						{/if}
					</div>
					{#if target}
						{@const health = targetHealth(target)}
						<p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span class="size-2 rounded-full {toneDot(health.tone)}"></span>
							{health.description}
							{#if target.kind === 'project' && target.projectSlug}
								<span aria-hidden="true">·</span>
								<a
									href="/projects/{target.projectSlug}"
									class="inline-flex items-center gap-1 hover:text-foreground hover:underline"
									>Open project <span class="font-mono">{target.projectSlug}</span></a
								>
							{/if}
							{#if !target.enabled}
								<a
									href="?tab=targets"
									class="font-medium text-foreground underline underline-offset-4"
									>Enable it in Targets</a
								>
							{/if}
						</p>
					{/if}
				{:else if canManage}
					<div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Kind of target">
						{#each choices as option (option.id)}
							<button
								type="button"
								role="radio"
								aria-checked={choice === option.id}
								class="relative flex flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-all {choice ===
								option.id
									? 'border-primary bg-muted/40 shadow-xs'
									: 'bg-card hover:border-foreground/20 hover:bg-muted/40'}"
								onclick={() => (choice = option.id)}
							>
								<span class="flex items-center gap-2">
									<option.icon class="size-4 text-muted-foreground" />
									<span class="text-sm font-medium">{option.title}</span>
								</span>
								<span class="text-xs text-muted-foreground">{option.text}</span>
								{#if option.recommended}
									<Badge class="absolute -top-2 right-3 h-4 px-1.5 text-[10px]">Recommended</Badge>
								{/if}
							</button>
						{/each}
					</div>

					<form
						method="POST"
						action={createAction}
						class="flex flex-wrap items-end gap-2"
						use:enhance={() => {
							submitting = true;
							return async ({ result, update }) => {
								await update({ reset: false });
								submitting = false;
								notify(result);
							};
						}}
					>
						{#if choice === 'auto'}
							<input type="hidden" name="enabled" value="true" />
							<p class="flex-1 text-xs text-muted-foreground">
								Creates {projects.length} target{projects.length === 1 ? '' : 's'} now. Apps that already
								call
								<code class="font-mono">Sentry.init()</code> start reporting after their next deploy.
							</p>
						{:else if choice === 'project'}
							<Field.Field class="min-w-56 flex-1">
								<Field.Label for="setup-project" class="text-xs">Project</Field.Label>
								<NativeSelect.Root id="setup-project" name="project" required class="w-full">
									{#each projects as project (project.slug)}
										<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
							</Field.Field>
						{:else}
							<Field.Field class="min-w-56 flex-1">
								<Field.Label for="setup-name" class="text-xs">Name</Field.Label>
								<Input
									id="setup-name"
									name="name"
									placeholder="Marketing site"
									required
									maxlength={100}
									autocomplete="off"
								/>
							</Field.Field>
						{/if}
						<Button type="submit" disabled={submitting}>
							{#if submitting}<Spinner />{:else if choice === 'auto'}<Link2Icon />{:else}<PlusIcon
								/>{/if}
							{choice === 'auto'
								? 'Link every project'
								: choice === 'project'
									? 'Link project'
									: 'Create target'}
						</Button>
						{#if service.targets.length > 0}
							<Button variant="ghost" onclick={() => (creating = false)}><XIcon />Cancel</Button>
						{/if}
					</form>
				{:else}
					<p class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						Someone with the project:update permission creates the first target. Once it exists,
						this page shows its DSN and snippet.
					</p>
				{/if}
			</div>
		</li>

		<!-- 2. SDK -->
		<li class="relative flex gap-4">
			{@render marker(connected ? 'done' : target ? 'current' : 'upcoming', 2)}
			<div class="min-w-0 flex-1 space-y-4 pt-0.5 {target ? '' : 'opacity-60'}">
				<div class="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 class="font-medium">Add the SDK to your app</h2>
						<p class="text-sm text-muted-foreground">
							Any Sentry SDK works. Pick what the app is written in.
						</p>
					</div>
					{#if target?.dsn}
						<CopyButton value={target.dsn} label="Copy DSN" size="sm" />
					{/if}
				</div>

				<div
					class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
					role="radiogroup"
					aria-label="SDK"
				>
					{#each SDKS as item (item.id)}
						<button
							type="button"
							role="radio"
							aria-checked={sdkId === item.id}
							title={item.blurb}
							class="flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-all {sdkId ===
							item.id
								? 'border-primary bg-muted/40 shadow-xs'
								: 'bg-card hover:border-foreground/20 hover:bg-muted/40'}"
							onclick={() => (sdkId = item.id)}
						>
							<span class="text-sm font-medium">{item.label}</span>
							<span class="truncate font-mono text-[11px] text-muted-foreground"
								>{item.package}</span
							>
						</button>
					{/each}
				</div>
				<p class="-mt-2 text-xs text-muted-foreground">{sdk.blurb}.</p>

				{#if injectable}
					<div class="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
						<Switch id="setup-injected" bind:checked={useInjected} class="mt-0.5" />
						<label for="setup-injected" class="space-y-0.5 text-sm">
							<span class="block font-medium">Read the DSN Yoal injects</span>
							<span class="block text-xs text-muted-foreground">
								{target?.name} gets <code class="font-mono">SENTRY_DSN</code>,
								<code class="font-mono">SENTRY_RELEASE</code> and
								<code class="font-mono">SENTRY_ENVIRONMENT</code> on its next deploy, so the snippet holds
								no secrets and releases are tagged for you.
							</span>
						</label>
					</div>
				{/if}

				{#if sdk.install}
					<CodeBlock code={sdk.install} label="terminal" />
				{/if}
				<CodeBlock code={init} label={sdk.file} lang={sdk.lang} />

				{#if !injected}
					<details class="group text-sm">
						<summary
							class="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground"
						>
							Tag events with an environment and release
						</summary>
						<div class="mt-3 grid gap-3 sm:grid-cols-2">
							<Field.Field>
								<Field.Label for="setup-env" class="text-xs">Environment</Field.Label>
								<Input
									id="setup-env"
									bind:value={environment}
									placeholder="production"
									autocomplete="off"
									class="font-mono text-sm"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="setup-release" class="text-xs">Release</Field.Label>
								<Input
									id="setup-release"
									bind:value={release}
									placeholder="web@1.4.2"
									autocomplete="off"
									class="font-mono text-sm"
								/>
								<Field.Description class="text-xs"
									>Issues show the first and last release they were seen in.</Field.Description
								>
							</Field.Field>
						</div>
					</details>
				{/if}
				{#if sdkId === 'static'}
					<p class="text-xs text-muted-foreground">
						Has a Content-Security-Policy? Allow <code class="font-mono"
							>{origin.replace(/\/$/, '')}</code
						>
						in
						<code class="font-mono">script-src</code> and
						<code class="font-mono">connect-src</code>.
					</p>
				{/if}
			</div>
		</li>

		<!-- 3. First event -->
		<li class="relative flex gap-4">
			{@render marker(connected ? 'done' : target ? 'current' : 'upcoming', 3)}
			<div class="min-w-0 flex-1 space-y-4 pt-0.5 {target ? '' : 'opacity-60'}">
				<div class="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 class="font-medium">Send your first error</h2>
						<p class="text-sm text-muted-foreground">
							Prove the pipe end to end. This page updates the moment it lands.
						</p>
					</div>
					{#if target}
						{#if connected}
							<Badge variant="success"
								><CheckIcon />Received {formatRelative(target.lastSeenAt)}</Badge
							>
						{:else if listening}
							<span
								class="inline-flex items-center gap-2 rounded-full border bg-card px-2.5 py-1 text-xs"
								aria-live="polite"
							>
								<span class="relative inline-grid size-2 place-items-center">
									<span
										class="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60"
									></span>
									<span class="relative size-2 rounded-full bg-info"></span>
								</span>
								Listening for events
								{#if lastChecked}<span
										class="text-muted-foreground"
										title={formatDateTime(lastChecked)}
										>· checked {formatRelative(lastChecked)}</span
									>{/if}
							</span>
						{/if}
					{/if}
				</div>

				{#if target}
					<div
						class="flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border bg-muted/30 p-0.5"
						role="tablist"
						aria-label="How to send it"
					>
						{#each [{ id: 'yoal', label: 'From Yoal' }, { id: 'app', label: 'From your app' }, { id: 'terminal', label: 'From a terminal' }] as const as tab (tab.id)}
							<Button
								size="sm"
								role="tab"
								aria-selected={proof === tab.id}
								variant={proof === tab.id ? 'secondary' : 'ghost'}
								class="h-7 px-2.5 text-xs {proof === tab.id ? 'shadow-xs' : ''}"
								onclick={() => (proof = tab.id)}
							>
								{tab.label}
							</Button>
						{/each}
					</div>

					{#if proof === 'yoal'}
						<div class="flex flex-wrap items-center gap-3">
							<Button
								onclick={sendTest}
								disabled={sending || !canManage || !target.enabled}
								variant={connected ? 'outline' : 'default'}
							>
								{#if sending}<Spinner />{:else}<SendIcon />{/if}Send test error
							</Button>
							<p class="max-w-md text-xs text-muted-foreground">
								{#if !canManage}
									Sending a test needs the project:update permission. Try one of the other ways.
								{:else}
									Posts a synthetic error through the same public ingest path your app uses, then it
									shows up as an issue.
								{/if}
							</p>
						</div>
					{:else if proof === 'app'}
						<p class="text-xs text-muted-foreground">
							Put this anywhere that runs after <code class="font-mono">init</code>, deploy or run
							the app, and hit that code path once.
						</p>
						<CodeBlock
							code={sdk.verify}
							label={sdk.id === 'static' ? 'browser console' : sdk.file}
							lang={sdk.id === 'static' ? 'javascript' : sdk.lang}
						/>
					{:else if curl}
						<p class="text-xs text-muted-foreground">
							No SDK needed: this posts one event straight to the DSN.
						</p>
						<CodeBlock code={curl} label="terminal" />
					{:else}
						<p class="text-xs text-muted-foreground">This target has no DSN yet.</p>
					{/if}

					{#if !connected}
						<details class="rounded-lg border bg-card text-sm">
							<summary
								class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium select-none"
							>
								<LifeBuoyIcon class="size-3.5 text-muted-foreground" />Nothing arriving?
							</summary>
							<ul class="list-disc space-y-1 border-t px-3 py-3 pl-8 text-xs text-muted-foreground">
								<li>
									Restart or redeploy the app after adding the DSN. SDKs read it once, at start-up.
								</li>
								{#if target.kind === 'project'}
									<li>
										Injected variables reach a deployment created after the target existed. Redeploy {target.projectSlug ??
											'the project'}.
									</li>
								{/if}
								<li>
									Check the target is enabled and its key was not rotated more than 24 hours ago.
								</li>
								<li>
									Browser apps: look for a blocked request to <code class="font-mono">/ingest/</code
									> in the network tab (CSP or an ad blocker).
								</li>
								<li>
									SDKs drop errors they consider duplicates or sampled out; <code class="font-mono"
										>captureException</code
									> always sends.
								</li>
							</ul>
						</details>
					{/if}
				{:else}
					<p class="text-sm text-muted-foreground">Choose a target first.</p>
				{/if}
			</div>
		</li>
	</ol>
</div>
