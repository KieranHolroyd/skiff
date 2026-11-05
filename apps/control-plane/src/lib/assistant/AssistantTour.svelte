<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick, untrack } from 'svelte';
	import { assistant } from '#lib/assistant/assistant.svelte.js';
	import { resolveTourTarget, waitForElement } from '#lib/assistant/page-context.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * The guide's spotlight. It navigates, scrolls, and points at one element at a time. The overlay
	 * is inert except for the card, so the user's page stays usable if they ignore it.
	 */

	let stepIndex = $state(0);
	let rect = $state<DOMRect | null>(null);
	let notFound = $state(false);
	let busy = $state(false);

	const guide = $derived(assistant.tour);
	const step = $derived(guide?.steps[stepIndex] ?? null);

	function currentPath(): string {
		return `${page.url.pathname}${page.url.search}`;
	}

	/** Stay inside the dashboard: the tour lives in its layout. */
	function safePath(path: string): boolean {
		if (!path.startsWith('/')) return false;
		const blocked = [
			'/login',
			'/consent',
			'/cli',
			'/two-factor',
			'/accept-invitation',
			'/mcp',
			'/api',
			'/metrics'
		];
		return !blocked.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
	}

	async function show(index: number) {
		const active = assistant.tour;
		const next = active?.steps[index];
		if (!active || !next) return;
		stepIndex = index;
		rect = null;
		notFound = false;
		busy = true;
		try {
			if (next.path && safePath(next.path) && next.path !== currentPath()) {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the guide supplies a concrete path from the page outline
				await goto(next.path);
				await tick();
				if (assistant.tour !== active) return;
			}
			const element = await waitForElement(() => resolveTourTarget(next.target, next.selector));
			if (!element) {
				notFound = true;
				return;
			}
			element.scrollIntoView({ block: 'center', behavior: 'smooth' });
			await new Promise((resolve) => setTimeout(resolve, 260));
			measure(element);
		} finally {
			busy = false;
		}
	}

	function measure(element?: Element | null) {
		const target = element ?? (step ? resolveTourTarget(step.target, step.selector) : null);
		if (target) {
			rect = target.getBoundingClientRect();
			notFound = false;
			return;
		}
		if (step) {
			rect = null;
			notFound = true;
		}
	}

	function close() {
		assistant.dismissTour();
	}

	function finish() {
		assistant.dismissTour();
	}

	$effect(() => {
		if (!assistant.tour) return;
		const next = assistant.tour;
		// Navigation inside `show` must not retrigger this effect.
		untrack(() => void show(0));
		void next;
	});

	$effect(() => {
		// Re-measure when the page scrolls or resizes behind the spotlight.
		void page.url.href;
		tick().then(() => measure());
	});

	const spotlightStyle = $derived.by(() => {
		if (!rect) return '';
		const pad = 6;
		return [
			`top:${Math.max(0, rect.top - pad)}px`,
			`left:${Math.max(0, rect.left - pad)}px`,
			`width:${rect.width + pad * 2}px`,
			`height:${rect.height + pad * 2}px`,
			'box-shadow:0 0 0 9999px rgba(0,0,0,0.55)'
		].join(';');
	});

	const cardStyle = $derived.by(() => {
		if (typeof window === 'undefined' || !rect) return '';
		const width = Math.min(380, window.innerWidth - 32);
		const left = Math.min(
			Math.max(16, rect.left + rect.width / 2 - width / 2),
			window.innerWidth - width - 16
		);
		const below = rect.bottom + 16;
		if (below + 240 < window.innerHeight) return `top:${below}px; left:${left}px; width:${width}px`;
		return `bottom:${Math.max(16, window.innerHeight - rect.top + 16)}px; left:${left}px; width:${width}px`;
	});
</script>

<svelte:window
	onresize={() => measure()}
	onscroll={() => measure()}
	onkeydown={(event) => {
		if (event.key === 'Escape') close();
	}}
/>

{#if guide && step}
	<div
		class="pointer-events-none fixed inset-0 z-[100]"
		role="dialog"
		aria-modal="true"
		aria-label="Guided tour"
	>
		{#if rect}
			<div
				class="pointer-events-none fixed rounded-[10px] ring-2 ring-brand transition-all duration-200"
				style={spotlightStyle}
			></div>
		{:else}
			<div class="absolute inset-0 bg-black/50 backdrop-blur-[1px]"></div>
		{/if}

		<div
			class="pointer-events-auto fixed rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl"
			style={rect
				? cardStyle
				: 'top:50%; left:50%; width:min(380px, calc(100vw - 32px)); transform:translate(-50%,-50%)'}
		>
			<div class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="text-xs font-medium text-brand">
						Step {stepIndex + 1} of {guide.steps.length}
					</p>
					<h2 class="text-base font-semibold tracking-tight">{step.title}</h2>
				</div>
				<Button variant="ghost" size="icon-sm" aria-label="Close tour" onclick={close}>
					<XIcon />
				</Button>
			</div>

			{#if guide.intro && stepIndex === 0}
				<p class="mt-2 text-sm text-muted-foreground">{guide.intro}</p>
			{/if}

			<p class="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{step.body}</p>

			{#if notFound}
				<div
					class="mt-3 flex items-start gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
				>
					<SearchXIcon class="mt-0.5 size-3.5 shrink-0" />
					<span
						>That element is not on this page right now. It may be hidden or you may lack access.</span
					>
				</div>
			{/if}

			<div class="mt-4 flex items-center gap-2">
				{#if stepIndex > 0}
					<Button variant="outline" size="sm" onclick={() => show(stepIndex - 1)} disabled={busy}>
						<ArrowLeftIcon /> Back
					</Button>
				{/if}
				<span class="flex-1"></span>
				{#if busy}
					<Spinner class="size-3.5" />
				{/if}
				{#if stepIndex < guide.steps.length - 1}
					<Button size="sm" onclick={() => show(stepIndex + 1)} disabled={busy}>
						Next <ArrowRightIcon />
					</Button>
				{:else}
					<Button size="sm" onclick={finish}>Done</Button>
				{/if}
			</div>
			<button
				type="button"
				class="mt-3 w-full text-center text-[11px] text-muted-foreground hover:text-foreground"
				onclick={finish}
			>
				Skip the tour
			</button>
		</div>
	</div>
{/if}
