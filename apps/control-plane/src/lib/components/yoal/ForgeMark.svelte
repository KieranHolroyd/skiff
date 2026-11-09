<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import GitMergeIcon from '@lucide/svelte/icons/git-merge';
	import type { GitProviderKind } from '@yoal/contracts';
	import GitHubMark from './GitHubMark.svelte';

	/** A small mark for a git provider (docs/FORGES.md); plain shapes, not the vendors' logos. */
	let { kind, class: className = 'size-4' }: { kind: GitProviderKind; class?: string } = $props();
</script>

{#if kind === 'github'}
	<GitHubMark class={className} />
{:else if kind === 'gitlab'}
	<svg viewBox="0 0 24 24" fill="currentColor" class={className} aria-hidden="true">
		<path d="M12 21.5 2.6 14.3a1 1 0 0 1-.36-1.12L5.3 4.1a.5.5 0 0 1 .95 0L8.4 10.6h7.2l2.15-6.5a.5.5 0 0 1 .95 0l3.06 9.08a1 1 0 0 1-.36 1.12Z" />
	</svg>
{:else if kind === 'gitea'}
	<GitMergeIcon class={className} />
{:else if kind === 'forgejo'}
	<GitForkIcon class={className} />
{:else}
	<GitBranchIcon class={className} />
{/if}
