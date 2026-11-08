<script lang="ts">
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';

	/** The three steps from "nothing" to "runs on push". Without a repository the URL is a pattern. */
	let {
		webhookUrl,
		hasRepository,
		defaultBranch = 'main',
		viaGithubApp = false
	}: {
		webhookUrl: string;
		hasRepository: boolean;
		defaultBranch?: string;
		/** Skiff's GitHub App covers the repository: no webhook step (docs/GITHUB.md). */
		viaGithubApp?: boolean;
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
			{#if viaGithubApp}
				<p class="font-medium">Push</p>
				<p class="text-muted-foreground">
					Nothing to set up: Skiff’s GitHub App delivers this repository’s pushes and pull requests,
					clones it, and reports each run as a commit status.
				</p>
			{:else}
				<p class="font-medium">Add a GitHub webhook</p>
				<p class="text-muted-foreground">
					Repository settings → Webhooks → Add webhook. Use the same secret you set here. Or install
					Skiff’s GitHub App (Settings → GitHub) and skip this step.
				</p>
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
