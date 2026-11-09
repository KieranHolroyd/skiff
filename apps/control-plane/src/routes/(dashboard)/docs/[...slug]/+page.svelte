<script lang="ts">
	import '@yoal/docs/prose.css';
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { enhanceDiagrams } from '@yoal/docs/diagrams';
	import DocsSearch from '../_lib/DocsSearch.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const doc = $derived(data.doc);
	const pageHref = (slug: string) => resolve('/(dashboard)/docs/[...slug]', { slug });

	/** The heading nearest the top of the viewport, for the "On this page" rail. */
	let activeHeading = $state<string | null>(null);
	let article = $state<HTMLElement | null>(null);

	$effect(() => {
		if (!article) return;
		void doc.slug;
		activeHeading = doc.headings[0]?.id ?? null;
		const targets = [...article.querySelectorAll<HTMLElement>('h2[id], h3[id]')];
		if (targets.length === 0 || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(
			(records) => {
				const visible = records
					.filter((record) => record.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible[0]) activeHeading = visible[0].target.id;
			},
			{ rootMargin: '-64px 0px -70% 0px' }
		);
		for (const target of targets) observer.observe(target);
		return () => observer.disconnect();
	});

	/** Mermaid diagrams render client-side, again whenever the page or the theme changes. */
	$effect(() => {
		if (!article) return;
		void doc.html;
		return enhanceDiagrams(article);
	});

	/** Copy buttons are part of the rendered HTML; one delegated handler serves them all. */
	async function onArticleClick(event: MouseEvent) {
		const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
			'[data-docs-copy]'
		);
		if (!button) return;
		const code = button.parentElement?.querySelector('pre')?.innerText ?? '';
		try {
			await navigator.clipboard.writeText(code.replace(/\n$/, ''));
			button.textContent = 'Copied';
			button.dataset.copied = '';
		} catch {
			button.textContent = 'Copy failed';
		}
		setTimeout(() => {
			button.textContent = 'Copy';
			delete button.dataset.copied;
		}, 1500);
	}
</script>

<svelte:head>
	<title>{doc.title} · Docs · Yoal</title>
	<meta name="description" content={doc.description} />
</svelte:head>

<div class="flex gap-10">
	<div class="min-w-0 flex-1">
		<div class="mx-auto max-w-3xl space-y-8">
			<PageHeader
				eyebrow={doc.section.title}
				title={doc.title}
				description={doc.description}
				target="docs.header"
			>
				<DocsSearch />
			</PageHeader>

			<!--
				Docs HTML comes from Markdown authored in this repository (packages/docs/content) and
				rendered on the server; the renderer escapes any raw HTML in the source, so the only
				markup here is what it emits.
			-->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<article bind:this={article} class="docs-prose" onclick={onArticleClick}>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html doc.html}
			</article>

			{#if doc.prev || doc.next}
				<nav class="grid gap-3 border-t pt-6 sm:grid-cols-2" aria-label="Previous and next pages">
					{#if doc.prev}
						<a
							href={pageHref(doc.prev.slug)}
							class="group rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20"
						>
							<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
								<ArrowLeftIcon class="size-3.5" /> Previous
							</span>
							<span class="mt-1 block font-medium group-hover:text-brand">{doc.prev.title}</span>
						</a>
					{:else}
						<span class="max-sm:hidden"></span>
					{/if}
					{#if doc.next}
						<a
							href={pageHref(doc.next.slug)}
							class="group rounded-lg border bg-card p-4 text-right transition-colors hover:border-foreground/20"
						>
							<span class="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
								Next <ArrowRightIcon class="size-3.5" />
							</span>
							<span class="mt-1 block font-medium group-hover:text-brand">{doc.next.title}</span>
						</a>
					{/if}
				</nav>
			{/if}
		</div>
	</div>

	{#if doc.headings.length > 1}
		<aside class="hidden w-56 shrink-0 xl:block" aria-label="On this page">
			<div class="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6">
				<p class="mb-2 text-xs font-medium text-muted-foreground">On this page</p>
				<ul class="space-y-1 border-l text-sm">
					{#each doc.headings as heading (heading.id)}
						<li>
							<a
								href="#{heading.id}"
								class="-ml-px block border-l py-0.5 transition-colors {heading.depth === 3
									? 'pl-6'
									: 'pl-3'} {activeHeading === heading.id
									? 'border-brand text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground'}"
							>
								{heading.text}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		</aside>
	{/if}
</div>
