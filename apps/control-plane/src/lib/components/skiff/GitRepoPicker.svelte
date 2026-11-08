<script lang="ts">
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { FORGE_LABELS, type GitProviderKind, type GitRepositoryList, type GitRepositoryView } from '@skiff/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import ForgeMark from './ForgeMark.svelte';

	/**
	 * Pick a repository from every git provider the org connects (docs/FORGES.md): the GitHub App's
	 * installations and each GitLab, Gitea or Forgejo connection. Calls `onpick` with the repository
	 * so the form can fill its URL, branch and name; renders only a one-line pointer to the settings
	 * until something is connected.
	 */
	let {
		onpick,
		selected = '',
		hint = true,
		providers
	}: {
		onpick: (repo: GitRepositoryView) => void;
		/** `key` (host/full name) or full name of the repository the form currently names. */
		selected?: string;
		/** Show where to connect a provider when none is. */
		hint?: boolean;
		/** Only these providers (e.g. registry trusts for one CI). */
		providers?: GitProviderKind[];
	} = $props();

	const client = useQueryClient();
	let filter = $state('');
	let refreshing = $state(false);

	const repos = createQuery(() => ({
		queryKey: ['git-repositories'] as const,
		queryFn: ({ signal }) =>
			fetchJson<GitRepositoryList>('/api/v1/git/repositories', {
				signal,
				fallback: 'Could not list repositories'
			}),
		enabled: browser,
		staleTime: 60_000,
		retry: false
	}));

	async function refresh() {
		refreshing = true;
		try {
			const fresh = await fetchJson<GitRepositoryList>('/api/v1/git/repositories?refresh=1');
			client.setQueryData(['git-repositories'], fresh);
		} finally {
			refreshing = false;
		}
	}

	const available = $derived(
		(repos.data?.repositories ?? []).filter((repo) => !repo.archived && (!providers || providers.includes(repo.provider)))
	);
	const visible = $derived.by(() => {
		const query = filter.trim().toLowerCase();
		return (query ? available.filter((repo) => repo.fullName.toLowerCase().includes(query)) : available).slice(0, 50);
	});
	const connected = $derived(Boolean(repos.data && (repos.data.github || repos.data.connections.length > 0)));
	const isSelected = (repo: GitRepositoryView) =>
		Boolean(selected) && (selected.toLowerCase() === repo.key || selected.toLowerCase() === repo.fullName.toLowerCase());
	const multiple = $derived(new Set(available.map((repo) => repo.provider)).size > 1);
</script>

{#if repos.isPending}
	<p class="flex items-center gap-2 text-xs text-muted-foreground">
		<Spinner class="size-3" />Looking for repositories…
	</p>
{:else if repos.isError}
	<p class="text-xs text-muted-foreground">Repositories unavailable: {errorText(repos.error)}</p>
{:else if repos.data && !connected}
	{#if hint}
		<p class="flex items-center gap-2 text-xs text-muted-foreground">
			<ForgeMark kind="generic" class="size-3.5" />
			<span>
				Connect GitHub, GitLab, Gitea or Forgejo in
				<a class="underline underline-offset-2" href={resolve('/(dashboard)/settings/github')}>Settings → GitHub</a> or Settings → Git providers
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
					placeholder="Search {available.length} repositories"
					bind:value={filter}
					onkeydown={(event) => {
						// The picker sits inside forms; Enter here must not submit them.
						if (event.key === 'Enter') event.preventDefault();
					}}
					aria-label="Search repositories"
				/>
			</div>
			<Button type="button" size="icon-sm" variant="ghost" onclick={refresh} disabled={refreshing} aria-label="Refresh the list">
				{#if refreshing}<Spinner />{:else}<RefreshCwIcon />{/if}
			</Button>
		</div>
		<ul class="max-h-48 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Repositories">
			{#each visible as repo (`${repo.connectionId ?? 'github'}:${repo.fullName}`)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={isSelected(repo)}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent aria-selected:bg-accent"
						onclick={() => onpick(repo)}
						title="{FORGE_LABELS[repo.provider]} · {repo.htmlUrl}"
					>
						<ForgeMark kind={repo.provider} class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
						{#if multiple}<span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">{FORGE_LABELS[repo.provider]}</span>{/if}
						{#if repo.private}<LockIcon class="size-3 shrink-0 text-muted-foreground" aria-label="private" />{/if}
						<span class="shrink-0 text-xs text-muted-foreground">{repo.defaultBranch}</span>
					</button>
				</li>
			{:else}
				<li class="px-2 py-1.5 text-xs text-muted-foreground">No repository matches.</li>
			{/each}
		</ul>
		{#if repos.data.truncated}<p class="px-1 text-xs text-muted-foreground">Some providers list more repositories than were fetched; search narrows the list.</p>{/if}
		{#each repos.data.errors as failure (`${failure.provider}:${failure.connectionId}`)}
			<p class="px-1 text-xs text-destructive">{failure.name}: {failure.error}</p>
		{/each}
	</div>
{/if}
