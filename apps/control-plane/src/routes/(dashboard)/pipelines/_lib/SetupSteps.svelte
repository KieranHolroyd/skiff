<script lang="ts">
	import { enhance } from '$app/forms';
	import { notify } from '#lib/actions.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';

	/** The three steps from "nothing" to "runs on push". Without a repository the URL is a pattern. */
	let {
		webhookUrl,
		hasRepository,
		defaultBranch = 'main',
		viaGithubApp = false,
		viaForge = null,
		forgeMissing = null,
		coverage = null,
		manageUrl = null,
		owner = null
	}: {
		webhookUrl: string;
		hasRepository: boolean;
		defaultBranch?: string;
		/** Skiff's GitHub App covers the repository: no webhook step (docs/GITHUB.md). */
		viaGithubApp?: boolean;
		/** A connected forge's webhook (created by Skiff) delivers the repository: its name (docs/FORGES.md). */
		viaForge?: string | null;
		/** A connected forge serves the repository but no webhook of Skiff's covers it yet. */
		forgeMissing?: { name: string; error: string | null; canCreate: boolean } | null;
		/** `not-selected` / `not-installed`: one click on GitHub makes the webhook step go away. */
		coverage?: string | null;
		/** Where that click is (the installation's settings, or the App's install page). */
		manageUrl?: string | null;
		owner?: string | null;
	} = $props();

	const example = $derived(`name: ci
on:
  push: { branches: [${defaultBranch}] }
  pull_request: {}
  workflow_dispatch: {}

jobs:
  test:
    runs-on: [linux]
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile && bun test
`);
</script>

<ol class="space-y-5 text-sm">
	<li class="flex gap-3">
		<span
			class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs"
			>1</span
		>
		<div class="min-w-0 space-y-1">
			<p class="font-medium">Add the repository</p>
			<p class="text-muted-foreground">
				{hasRepository
					? 'Done. Builds run on nodes with the Builder role; turn it on under Nodes if none has it.'
					: 'Its name, clone URL and default branch. Jobs run on nodes with the Builder role.'}
			</p>
		</div>
	</li>
	<li class="flex gap-3">
		<span
			class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs"
			>2</span
		>
		<div class="min-w-0 flex-1 space-y-2">
			<p class="font-medium">Add a workflow</p>
			<p class="text-muted-foreground">
				Commit a GitHub Actions–style file. Common actions like <code class="font-mono"
					>actions/checkout</code
				> work as is.
			</p>
			<CodeBlock code={example} label=".skiff/workflows/ci.yml" lang="yaml" />
		</div>
	</li>
	<li class="flex gap-3">
		<span
			class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs"
			>3</span
		>
		<div class="min-w-0 flex-1 space-y-2">
			{#if viaForge}
				<p class="font-medium">Push</p>
				<p class="text-muted-foreground">
					Nothing to set up: Skiff created the webhook on {viaForge}, clones the repository and reports each
					run as a commit status.
				</p>
			{:else if forgeMissing}
				<p class="font-medium">Let Skiff create the webhook on {forgeMissing.name}</p>
				<p class="text-muted-foreground">
					{forgeMissing.error
						? `The last attempt failed: ${forgeMissing.error}`
						: 'The repository is on a connected forge, but no webhook delivers it yet.'}
					Once it exists, pushes and merge or pull requests arrive with no secret to copy.
				</p>
				{#if forgeMissing.canCreate}
					<form
						method="POST"
						action="?/createWebhook"
						use:enhance={() =>
							async ({ result, update }) => {
								await update({ reset: false });
								notify(result);
							}}
					>
						<button type="submit" class="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
							>Create the webhook</button
						>
					</form>
				{/if}
			{:else if viaGithubApp}
				<p class="font-medium">Push</p>
				<p class="text-muted-foreground">
					Nothing to set up: Skiff’s GitHub App delivers this repository’s pushes and pull requests,
					clones it, and reports each run as a commit status.
				</p>
			{:else}
				{#if manageUrl && (coverage === 'not-selected' || coverage === 'not-installed')}
					<p class="font-medium">
						{coverage === 'not-selected'
							? 'Give Skiff’s GitHub App this repository'
							: `Install Skiff’s GitHub App on ${owner ?? 'its owner'}`}
					</p>
					<p class="text-muted-foreground">
						{coverage === 'not-selected'
							? 'The App is installed on this account, but not for this repository. Add it to the installation and pushes arrive with no webhook.'
							: 'Then pushes and pull requests arrive with no webhook, private clones need no token, and runs report commit statuses.'}
					</p>
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL -->
					<a
						href={manageUrl}
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
						>{coverage === 'not-selected' ? 'Choose repositories on GitHub' : 'Install on GitHub'}</a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<p class="pt-2 text-muted-foreground">Or add a webhook by hand, with the secret you set here:</p>
				{:else}
					<p class="font-medium">Add a GitHub webhook</p>
					<p class="text-muted-foreground">
						Repository settings → Webhooks → Add webhook. Use the same secret you set here. Or install
						Skiff’s GitHub App (Settings → GitHub) and skip this step.
					</p>
				{/if}
				<dl class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs">
					<dt class="text-muted-foreground">Payload URL</dt>
					<dd class="flex min-w-0 items-center gap-2">
						<code class="truncate font-mono">{webhookUrl}</code>
						{#if hasRepository}<CopyButton value={webhookUrl} iconOnly size="icon-xs" variant="ghost" />{/if}
					</dd>
					<dt class="text-muted-foreground">Content type</dt>
					<dd><code class="font-mono">application/json</code></dd>
					<dt class="text-muted-foreground">Events</dt>
					<dd>Pushes and pull requests</dd>
				</dl>
			{/if}
		</div>
	</li>
</ol>
