<script lang="ts">
	import { goto } from '$app/navigation';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { copyText } from '#lib/assistant/clipboard.js';
	import { parseMarkdown, type Inline } from '#lib/assistant/markdown.js';

	/**
	 * Renders assistant Markdown as Svelte elements (no `{@html}`), see markdown.ts. Internal links
	 * navigate inside the dashboard and leave the panel open; external links open a new tab.
	 */
	let {
		source,
		streaming = false,
		onnavigate
	}: { source: string; streaming?: boolean; onnavigate?: (href: string) => void } = $props();

	const blocks = $derived(parseMarkdown(source));
	let copied = $state<number | null>(null);

	async function copyBlock(index: number, text: string) {
		if (await copyText(text)) {
			copied = index;
			setTimeout(() => {
				if (copied === index) copied = null;
			}, 1500);
		}
	}

	function follow(event: MouseEvent, href: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		onnavigate?.(href);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- safeHref() allows only same-origin dashboard paths
		void goto(href);
	}
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs come from safeHref(): relative dashboard paths or http(s) only -->
{#snippet inlines(children: Inline[])}
	{#each children as child, index (index)}
		{#if child.type === 'text'}{child.text}{:else if child.type === 'strong'}<strong
				class="font-semibold">{@render inlines(child.children)}</strong
			>{:else if child.type === 'em'}<em>{@render inlines(child.children)}</em
			>{:else if child.type === 'code'}<code
				class="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">{child.text}</code
			>{:else if child.type === 'br'}<br />{:else if child.type === 'link'}{#if child.internal}<a
					href={child.href}
					class="font-medium text-brand underline-offset-2 hover:underline"
					onclick={(event) => follow(event, child.href)}>{@render inlines(child.children)}</a
				>{:else}<a
					href={child.href}
					target="_blank"
					rel="noopener noreferrer nofollow"
					class="inline-flex items-baseline gap-0.5 font-medium text-brand underline-offset-2 hover:underline"
					>{@render inlines(child.children)}<ExternalLinkIcon class="size-3 self-center" /></a
				>{/if}{/if}
	{/each}
{/snippet}

<div class="assistant-md space-y-2.5 text-sm leading-relaxed break-words">
	{#each blocks as block, index (index)}
		{#if block.type === 'paragraph'}
			<p>{@render inlines(block.children)}</p>
		{:else if block.type === 'heading'}
			<p class="pt-1 font-semibold {block.level === 1 ? 'text-base' : 'text-sm'}">
				{@render inlines(block.children)}
			</p>
		{:else if block.type === 'code'}
			<div class="group/code relative overflow-hidden rounded-lg border bg-muted/50">
				<div
					class="flex items-center justify-between border-b bg-muted/60 px-2.5 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase"
				>
					<span>{block.lang || 'text'}</span>
					{#if !(streaming && block.open)}
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded px-1 py-0.5 normal-case hover:bg-background hover:text-foreground"
							onclick={() => copyBlock(index, block.text)}
							aria-label="Copy code"
						>
							{#if copied === index}
								<CheckIcon class="size-3" /> Copied
							{:else}
								<CopyIcon class="size-3" /> Copy
							{/if}
						</button>
					{/if}
				</div>
				<pre class="max-h-80 overflow-auto p-2.5 font-mono text-xs leading-relaxed"><code
						>{block.text}</code
					></pre>
			</div>
		{:else if block.type === 'list'}
			{#if block.ordered}
				<ol class="list-decimal space-y-1 pl-5 marker:text-muted-foreground" start={block.start}>
					{#each block.items as item, itemIndex (itemIndex)}
						<li style:margin-left="{item.depth * 1}rem">{@render inlines(item.children)}</li>
					{/each}
				</ol>
			{:else}
				<ul class="space-y-1 pl-5">
					{#each block.items as item, itemIndex (itemIndex)}
						<li
							class={item.checked === undefined
								? 'list-disc marker:text-muted-foreground'
								: 'list-none'}
							style:margin-left="{item.depth * 1}rem"
						>
							{#if item.checked !== undefined}
								<span class="mr-1 -ml-4 inline-block w-3 font-mono text-xs text-muted-foreground"
									>{item.checked ? '✓' : '○'}</span
								>
							{/if}
							{@render inlines(item.children)}
						</li>
					{/each}
				</ul>
			{/if}
		{:else if block.type === 'quote'}
			<blockquote class="border-l-2 pl-3 text-muted-foreground">
				{@render inlines(block.children)}
			</blockquote>
		{:else if block.type === 'table'}
			<div class="overflow-x-auto rounded-lg border">
				<table class="w-full text-xs">
					<thead class="bg-muted/60">
						<tr>
							{#each block.header as cell, cellIndex (cellIndex)}
								<th
									class="px-2.5 py-1.5 text-left font-medium whitespace-nowrap"
									style:text-align={block.align[cellIndex] ?? undefined}
								>
									{@render inlines(cell)}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each block.rows as row, rowIndex (rowIndex)}
							<tr class="border-t">
								{#each row as cell, cellIndex (cellIndex)}
									<td class="px-2.5 py-1.5" style:text-align={block.align[cellIndex] ?? undefined}>
										{@render inlines(cell)}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if block.type === 'hr'}
			<hr class="border-border" />
		{/if}
	{/each}
</div>
