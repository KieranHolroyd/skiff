<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import { resolve } from '$app/paths';
	import type { ProjectView } from '@skiff/core';
	import type { BuildView, GitSourceView } from '@skiff/contracts';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontalIcon from '@lucide/svelte/icons/git-commit-horizontal';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime, formatDuration, shortId, shortSha } from '../../../_lib/format.js';

	let {
		project,
		gitSource,
		builds,
		platformOrigin,
		can,
		onOpenLog,
		onBuildQueued
	}: {
		project: ProjectView;
		gitSource: GitSourceView | null;
		builds: BuildView[];
		platformOrigin: string;
		can: { createBuild: boolean; cancelBuild: boolean };
		/** The project page opens its live Logs tab; the dialog below is a standalone fallback. */
		onOpenLog?: (buildId: string) => void;
		/** Switch to the newest build's live tail after the queue action succeeds. */
		onBuildQueued?: () => void;
	} = $props();

	let sourceOpen = $state(false);
	let sourceEnabled = $state(true);
	let buildOpen = $state(false);
	let promoteOnSuccess = $state(true);
	let logOpen = $state(false);
	let logTitle = $state('');
	let logText = $state('');
	let logPending = $state(false);
	let logError = $state(false);
	let logRequest = 0;

	const webhookUrl = $derived(`${platformOrigin}/api/webhooks/github/${project.slug}`);
	const activeBuilds = $derived(
		builds.filter((build) => build.status === 'queued' || build.status === 'building').length
	);

	function openSource() {
		sourceEnabled = gitSource?.enabled ?? true;
		sourceOpen = true;
	}

	function openBuild() {
		promoteOnSuccess = true;
		buildOpen = true;
	}

	function removeSource() {
		askConfirm({
			title: 'Remove the git source?',
			description:
				'Automatic GitHub builds stop immediately. Existing builds and deployments are kept.',
			confirmLabel: 'Remove source',
			tone: 'danger',
			action: '?/removeGitSource'
		});
	}

	function cancelBuild(build: BuildView) {
		askConfirm({
			title: `Cancel build ${shortId(build.id)}?`,
			description:
				build.status === 'building'
					? `The Builder stops ${build.ref} and the uploaded artifact is discarded.`
					: `The queued build for ${build.ref} is removed before a Builder claims it.`,
			confirmLabel: 'Cancel build',
			tone: 'danger',
			action: '?/cancelBuild',
			fields: { buildId: build.id }
		});
	}

	async function openLog(build: BuildView) {
		if (onOpenLog) {
			onOpenLog(build.id);
			return;
		}
		const request = ++logRequest;
		logTitle = `${build.ref} · ${shortId(build.id)}`;
		logText = '';
		logError = false;
		logPending = true;
		logOpen = true;
		const result = await runAction(
			'?/buildLog',
			{ buildId: build.id },
			{ apply: false, toast: false }
		);
		if (request !== logRequest) return;
		if (result.type === 'success') {
			const data = result.data as { log?: unknown; status?: unknown };
			const status = typeof data?.status === 'string' ? data.status : build.status;
			if (typeof data?.log === 'string' && data.log) {
				logText = data.log;
			} else if (status === 'queued') {
				logText = 'This build is queued. Output appears once a Builder claims it.';
			} else if (status === 'building') {
				logText = 'The build is running, but no output has been captured yet.';
			} else {
				logText = 'No output was captured for this build.';
			}
		} else {
			logError = true;
			const data = result.type === 'failure' ? (result.data as { message?: unknown }) : undefined;
			logText = typeof data?.message === 'string' ? data.message : 'Could not load the build log.';
		}
		logPending = false;
	}

	function duration(build: BuildView): string {
		if (!build.startedAt) return '—';
		if (!build.finishedAt) return build.status === 'building' ? 'running' : '—';
		return formatDuration((Date.parse(build.finishedAt) - Date.parse(build.startedAt)) / 1000);
	}
</script>

<div class="space-y-5">
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<div class="flex items-start gap-3">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
				>
					<GitBranchIcon class="size-4" />
				</span>
				<div class="space-y-1">
					<Card.Title>Git source</Card.Title>
					<Card.Description>
						Builds run on a node marked as a Builder. The result goes through the normal release and
						deployment pipeline.
					</Card.Description>
				</div>
			</div>
			<Card.Action class="flex flex-wrap items-center justify-end gap-2 self-center">
				{#if gitSource}
					{#if can.createBuild}
						<Button variant="outline" size="sm" onclick={openSource}
							><PencilIcon />Edit source</Button
						>
					{/if}
					{#if can.createBuild}
						<Button variant="ghost-danger" size="sm" onclick={removeSource}>
							<TrashIcon />Remove
						</Button>
					{/if}
				{:else if can.createBuild}
					<Button size="sm" onclick={openSource}><PlusIcon />Connect repository</Button>
				{/if}
			</Card.Action>
		</Card.Header>
		<Card.Content class="py-4">
			{#if !gitSource}
				<EmptyState
					icon={GitBranchIcon}
					compact
					title="No repository connected"
					description="Connect a GitHub repository to build on push, or trigger builds by hand from the dashboard."
				>
					{#if can.createBuild}
						<Button size="sm" onclick={openSource}><PlusIcon />Connect repository</Button>
					{/if}
				</EmptyState>
			{:else}
				<DetailList>
					<dt>Repository</dt>
					<dd class="flex min-w-0 items-center justify-end gap-2">
						<a
							href={gitSource.repoUrl}
							target="_blank"
							rel="external noreferrer"
							class="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							<span class="truncate">{gitSource.repoUrl}</span>
							<ArrowUpRightIcon class="size-3 shrink-0" />
						</a>
					</dd>
					<dt>Branch</dt>
					<dd class="truncate font-mono text-sm" title={gitSource.branch}>
						{gitSource.branch}
					</dd>
					<dt>Root / output</dt>
					<dd
						class="truncate font-mono text-xs"
						title={`${gitSource.rootDir} → ${gitSource.outputDir}`}
					>
						{gitSource.rootDir} → {gitSource.outputDir}
					</dd>
					<dt>Build command</dt>
					<dd class="max-w-full truncate font-mono text-xs" title={gitSource.buildCommand}>
						{gitSource.buildCommand}
					</dd>
					<dt>State</dt>
					<dd>
						<Badge variant={gitSource.enabled ? 'success' : 'neutral'}>
							{gitSource.enabled ? 'enabled' : 'disabled'}
						</Badge>
					</dd>
					<dt>Webhook</dt>
					<dd class="flex min-w-0 items-center justify-end gap-2">
						<span class="truncate font-mono text-xs text-muted-foreground">{webhookUrl}</span>
						<CopyButton value={webhookUrl} label="Copy webhook URL" iconOnly />
					</dd>
				</DetailList>
				<p class="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
					<WebhookIcon class="mt-0.5 size-3.5 shrink-0" />
					<span>
						{#if gitSource.hasWebhookSecret}
							Signed deliveries only. Add the webhook in GitHub and use the same secret you set
							here.
						{:else}
							No webhook secret is set. Add one before enabling the GitHub webhook; unsigned
							deliveries are rejected.
						{/if}
					</span>
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<HammerIcon class="size-4 text-muted-foreground" />
				Builds
				{#if activeBuilds > 0}
					<Badge variant="warning">{activeBuilds} active</Badge>
				{/if}
			</Card.Title>
			<Card.Description>
				{gitSource
					? `Builds clone ${gitSource.repoUrl} on a Builder node and deploy the output.`
					: 'Connect a repository to build artifacts from git.'}
			</Card.Description>
			<Card.Action class="self-center">
				{#if can.createBuild && gitSource?.enabled}
					<Button size="sm" onclick={openBuild}><PlayIcon />Build now</Button>
				{/if}
			</Card.Action>
		</Card.Header>
		<Card.Content class="px-0">
			{#if builds.length === 0}
				<div class="p-4">
					<EmptyState
						icon={HammerIcon}
						compact
						title="No builds yet"
						description={gitSource
							? 'Trigger a build, or push to the branch to let the GitHub webhook queue one.'
							: 'Connect a repository first, then trigger a build.'}
					/>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Build</Table.Head>
							<Table.Head class="hidden md:table-cell">Commit</Table.Head>
							<Table.Head class="hidden lg:table-cell">Started</Table.Head>
							<Table.Head class="hidden sm:table-cell">Duration</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each builds as build (build.id)}
							<Table.Row>
								<Table.Cell class="pl-4 whitespace-normal">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-xs font-medium">{shortId(build.id)}</span>
										<StatusBadge status={build.status} />
										<Badge
											variant="outline"
											class="max-w-full truncate font-mono text-xs"
											title={build.ref}>{build.ref}</Badge
										>
									</div>
									{#if build.commitMessage}
										<p
											class="mt-0.5 max-w-lg truncate text-xs text-muted-foreground"
											title={build.commitMessage}
										>
											{build.commitMessage}
										</p>
									{/if}
									{#if build.error}
										<p
											class="mt-0.5 max-w-lg truncate text-xs text-destructive"
											title={build.error}
										>
											{build.error}
										</p>
									{/if}
									{#if build.deploymentId}
										<p
											class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
										>
											<a
												href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
												class="font-mono underline-offset-4 hover:text-foreground hover:underline"
												title="Open the project's deployments"
											>
												deployment {shortId(build.deploymentId, 10)}
											</a>
											{#if build.releaseSha256}
												<span class="font-mono opacity-80"
													>· release {shortSha(build.releaseSha256, 10)}</span
												>
											{/if}
										</p>
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground md:table-cell">
									{#if build.commitSha}
										<span class="inline-flex items-center gap-1" title={build.commitSha}>
											<GitCommitHorizontalIcon class="size-3.5" />
											{shortSha(build.commitSha, 8)}
										</span>
									{:else}
										—
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
									{#if build.startedAt}
										<time datetime={build.startedAt}>{formatDateTime(build.startedAt)}</time>
									{:else if build.status === 'queued'}
										queued
									{:else}
										—
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell"
									>{duration(build)}</Table.Cell
								>
								<Table.Cell class="pr-4">
									<div class="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											class={build.status === 'building' ? 'text-warning' : ''}
											aria-label={`View log for build ${shortId(build.id)}`}
											onclick={() => openLog(build)}
										>
											<ScrollTextIcon />
										</Button>
										{#if can.cancelBuild && (build.status === 'queued' || build.status === 'building')}
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label={`Cancel build ${shortId(build.id)}`}
												onclick={() => cancelBuild(build)}
											>
												<CircleSlashIcon />
											</Button>
										{/if}
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
		<Card.Footer class="py-3 text-xs text-muted-foreground">
			Showing the most recent builds. A Builder claims one job at a time; abandoned claims are
			requeued after 15 minutes.
		</Card.Footer>
	</Card.Root>
</div>

{#if can.createBuild}
	<FormDialog
		bind:open={sourceOpen}
		icon={GitBranchIcon}
		title={gitSource ? 'Edit git source' : 'Connect a repository'}
		description="One repository, branch and output directory per project. Builds are capped at 10 minutes."
		action="?/saveGitSource"
		submitLabel={gitSource ? 'Save source' : 'Connect repository'}
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="git-repo">Repository URL</Field.Label>
				<Input
					id="git-repo"
					name="repoUrl"
					value={gitSource?.repoUrl ?? ''}
					placeholder="https://github.com/acme/site.git"
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>
					Public HTTPS, SSH or git URL. Private repositories need a Builder-side deploy key.
				</Field.Description>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="git-branch">Branch</Field.Label>
					<Input
						id="git-branch"
						name="branch"
						value={gitSource?.branch ?? 'main'}
						placeholder="main"
						required
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="git-root">Root directory</Field.Label>
					<Input
						id="git-root"
						name="rootDir"
						value={gitSource?.rootDir ?? '.'}
						placeholder="."
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="git-command">Build command</Field.Label>
				<Input
					id="git-command"
					name="buildCommand"
					value={gitSource?.buildCommand ?? 'bun install && bun run build'}
					placeholder="bun install && bun run build"
					required
					class="font-mono text-sm"
				/>
				<Field.Description>
					Runs inside the worktree with a shared build cache, memory and CPU limits.
				</Field.Description>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="git-output">Output directory</Field.Label>
					<Input
						id="git-output"
						name="outputDir"
						value={gitSource?.outputDir ?? 'dist'}
						placeholder="dist"
						required
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="git-secret">
						Webhook secret
						<span class="font-normal text-muted-foreground"
							>{gitSource?.hasWebhookSecret ? 'set — leave blank to keep' : 'optional'}</span
						>
					</Field.Label>
					<Input
						id="git-secret"
						name="webhookSecret"
						type="password"
						autocomplete="new-password"
						minlength={16}
						placeholder={gitSource?.hasWebhookSecret
							? '••••••••••••••••'
							: 'At least 16 characters'}
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="git-enabled" name="enabled" value="1" bind:checked={sourceEnabled} />
				<Field.Label for="git-enabled" class="font-normal">
					Accept GitHub push webhooks for this branch
				</Field.Label>
			</Field.Field>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={buildOpen}
		icon={HammerIcon}
		title="Build now"
		description="Queue a build for {project.slug}. The Builder clones, builds and uploads the artifact."
		action="?/triggerBuild"
		submitLabel="Queue build"
		onsuccess={onBuildQueued}
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="build-ref">
					Branch, tag or commit <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Input
					id="build-ref"
					name="ref"
					placeholder={gitSource?.branch ?? 'main'}
					class="font-mono text-sm"
				/>
				<Field.Description>Leave blank to build the configured branch.</Field.Description>
			</Field.Field>
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="build-promote" name="promote" value="1" bind:checked={promoteOnSuccess} />
				<Field.Label for="build-promote" class="font-normal">
					Promote the deployment to production when the build succeeds
				</Field.Label>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

<Dialog.Root bind:open={logOpen}>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ScrollTextIcon class="size-4 text-muted-foreground" />
				Build log
			</Dialog.Title>
			<Dialog.Description class="font-mono text-xs">{logTitle}</Dialog.Description>
		</Dialog.Header>
		{#if logPending}
			<p class="py-8 text-center text-sm text-muted-foreground" role="status">
				Loading build output…
			</p>
		{:else if logError}
			<p class="py-8 text-center text-sm text-destructive">{logText}</p>
		{:else}
			<pre
				class="max-h-[26rem] overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{logText}</pre>
		{/if}
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}<Button {...props}>Close</Button>{/snippet}
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
