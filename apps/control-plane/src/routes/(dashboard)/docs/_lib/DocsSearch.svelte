<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { SearchEntry } from '@skiff/docs';
	import { searchDocs } from '@skiff/docs/search';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';

	/**
	 * Search across every docs page. The index is fetched the first time the box is used, then
	 * filtered locally on each keystroke. `/` focuses the box from anywhere on a docs page.
	 */

	let query = $state('');
	let open = $state(false);
	let highlighted = $state(0);
	let entries = $state.raw<SearchEntry[] | null>(null);
	let failed = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let loading: Promise<void> | null = null;

	const hits = $derived(entries ? searchDocs(entries, query, 8) : []);

	function load() {
		loading ??= fetch(resolve('/(dashboard)/docs/search.json'))
			.then((response) => {
				if (!response.ok) throw new Error(String(response.status));
				return response.json() as Promise<SearchEntry[]>;
			})
			.then((index) => {
				entries = index;
			})
			.catch(() => {
				failed = true;
				loading = null;
			});
	}

	function hrefFor(entry: SearchEntry): string {
		const page = resolve('/(dashboard)/docs/[...slug]', { slug: entry.slug });
		return entry.anchor ? `${page}#${entry.anchor}` : page;
	}

	function choose(entry: SearchEntry) {
		open = false;
		query = '';
		input?.blur();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor() is a resolved docs route plus a fragment
		void goto(hrefFor(entry));
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			highlighted = Math.min(highlighted + 1, hits.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			highlighted = Math.max(highlighted - 1, 0);
		} else if (event.key === 'Enter') {
			const hit = hits[highlighted];
			if (hit) {
				event.preventDefault();
				choose(hit.entry);
			}
		} else if (event.key === 'Escape') {
			open = false;
			input?.blur();
		}
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
		event.preventDefault();
		input?.focus();
	}

	$effect(() => {
		// Typing a new query starts back at the first result.
		void query;
		highlighted = 0;
	});
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- eslint-disable svelte/no-navigation-without-resolve -- result links are resolved docs routes plus a fragment -->

<div class="relative w-full sm:w-72">
	<InputGroup.Root class="bg-card">
		<InputGroup.Input
			bind:ref={input}
			bind:value={query}
			type="search"
			placeholder="Search docs"
			aria-label="Search docs"
			autocomplete="off"
			onfocus={() => {
				open = true;
				load();
			}}
			onblur={() => setTimeout(() => (open = false), 120)}
			{onkeydown}
		/>
		<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
		<InputGroup.Addon align="inline-end" class="max-sm:hidden"><Kbd>/</Kbd></InputGroup.Addon>
	</InputGroup.Root>

	{#if open && query.trim()}
		<div
			class="absolute top-full right-0 z-30 mt-2 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg sm:w-[28rem]"
		>
			{#if failed}
				<p class="px-3 py-4 text-sm text-muted-foreground">Search is unavailable right now.</p>
			{:else if !entries}
				<p class="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
			{:else if hits.length === 0}
				<p class="px-3 py-4 text-sm text-muted-foreground">No results for “{query.trim()}”.</p>
			{:else}
				<ul class="max-h-96 overflow-y-auto py-1" role="listbox" aria-label="Search results">
					{#each hits as hit, index (hit.entry.slug + '#' + hit.entry.anchor)}
						<li role="option" aria-selected={index === highlighted}>
							<a
								href={hrefFor(hit.entry)}
								class="block px-3 py-2 text-sm {index === highlighted ? 'bg-accent' : ''}"
								onmouseenter={() => (highlighted = index)}
								onclick={(event) => {
									event.preventDefault();
									choose(hit.entry);
								}}
							>
								<span class="block truncate font-medium">{hit.entry.heading}</span>
								<span class="block truncate text-xs text-muted-foreground">
									{hit.entry.section} › {hit.entry.page}
								</span>
								{#if hit.snippet}
									<span class="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
										{hit.snippet}
									</span>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
