<script lang="ts">
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { GithubRepositoryList, GithubRepositoryView } from '@skiff/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import GitHubMark from './GitHubMark.svelte';

	/**
	 * Pick a repository from the org's GitHub App installations (docs/GITHUB.md). Calls `onpick`
	 * with the repository so the form can fill its URL, branch and name; renders nothing until the
	 * App is installed for the org, except a one-line pointer to Settings → GitHub.
	 */
	let {
		onpick,
		selected = '',
		hint = true
	}: {
		onpick: (repo: GithubRepositoryView) => void;
		/** `owner/name` of the repository the form currently names, highlighted in the list. */
		selected?: string;
		/** Show "Connect GitHub" when no installation is linked. */
		hint?: boolean;
	} = $props();

	const client = useQueryClient();
	let filter = $state('');
	let refreshing = $state(false);

	const repos = createQuery(() => ({
		queryKey: ['github-repositories'] as const,
		queryFn: ({ signal }) =>
			fetchJson<GithubRepositoryList>('/api/v1/github/repositories', {
				signal,
				fallback: 'Could not list GitHub repositories'
			}),
		enabled: browser,
		staleTime: 60_000,
		retry: false
	}));

	async function refresh() {
		refreshing = true;
		try {
			const fresh = await fetchJson<GithubRepositoryList>('/api/v1/github/repositories?refresh=1');
			client.setQueryData(['github-repositories'], fresh);
		} finally {
			refreshing = false;
		}
	}

	const visible = $derived.by(() => {
		const list = repos.data?.repositories.filter((repo) => !repo.archived) ?? [];
		const query = filter.trim().toLowerCase();
		return (query ? list.filter((repo) => repo.fullName.toLowerCase().includes(query)) : list).slice(0, 50);
	});
</script>

{#if repos.isPending}
	<p class="flex items-center gap-2 text-xs text-muted-foreground">
		<Spinner class="size-3" />Looking for GitHub repositories…
	</p>
{:else if repos.isError}
	<p class="text-xs text-muted-foreground">GitHub repositories unavailable: {errorText(repos.error)}</p>
{:else if repos.data && !repos.data.connected}
	{#if hint}
		<p class="flex items-center gap-2 text-xs text-muted-foreground">
			<GitHubMark class="size-3.5" />
			<span>
				Install Skiff’s GitHub App in
				<a class="underline underline-offset-2" href={resolve('/(dashboard)/settings/github')}>Settings → GitHub</a>
				to pick a repository here, clone private repositories and skip webhook setup.
			</span>
		</p>
	{/if}
{:else if repos.data}
	<div class="space-y-2 rounded-md border bg-muted/30 p-2">
		<div class="flex items-center gap-2">
			<div class="relative flex-1">
				<SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					class="h-8 pl-7 text-sm"
					placeholder="Search {repos.data.repositories.length} GitHub repositories"
					bind:value={filter}
					onkeydown={(event) => {
						// The picker sits inside forms; Enter here must not submit them.
						if (event.key === 'Enter') event.preventDefault();
					}}
					aria-label="Search GitHub repositories"
				/>
			</div>
			<Button type="button" size="icon-sm" variant="ghost" onclick={refresh} disabled={refreshing} aria-label="Refresh the list">
				{#if refreshing}<Spinner />{:else}<RefreshCwIcon />{/if}
			</Button>
		</div>
		<ul class="max-h-48 space-y-0.5 overflow-y-auto" role="listbox" aria-label="GitHub repositories">
			{#each visible as repo (repo.id)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={selected.toLowerCase() === repo.fullName.toLowerCase()}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent aria-selected:bg-accent"
						onclick={() => onpick(repo)}
					>
						<GitHubMark class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
						{#if repo.private}<LockIcon class="size-3 shrink-0 text-muted-foreground" aria-label="private" />{/if}
						<span class="shrink-0 text-xs text-muted-foreground">{repo.defaultBranch}</span>
					</button>
				</li>
			{:else}
				<li class="px-2 py-1.5 text-xs text-muted-foreground">No repository matches.</li>
			{/each}
		</ul>
		<p class="px-1 text-xs text-muted-foreground">
			{#if repos.data.truncated}Showing the first 500 repositories. {/if}
			Missing one?
			{#if repos.data.manageUrl}
				<a class="underline underline-offset-2" href={repos.data.manageUrl} target="_blank" rel="noreferrer">Grant the App access on GitHub</a>,
				then refresh.
			{/if}
		</p>
		{#if repos.data.error}<p class="px-1 text-xs text-destructive">{repos.data.error}</p>{/if}
	</div>
{/if}
