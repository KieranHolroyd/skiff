<script lang="ts">
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { runAction } from '#lib/actions.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import { formatRelative } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const view = $derived(data.whatsNew);
	const groups = $derived.by(() => {
		const grouped: Array<{ version: string; items: typeof view.items }> = [];
		for (const item of view.items) {
			const entry = grouped.find((group) => group.version === item.since);
			if (entry) entry.items.push(item);
			else grouped.push({ version: item.since, items: [item] });
		}
		return grouped;
	});

	let busy = $state<string | null>(null);

	async function decide(itemId: string, decision: 'acknowledged' | 'enabled' | 'declined') {
		busy = `${itemId}:${decision}`;
		await runAction('?/decide', { itemId, decision });
		busy = null;
	}

	async function acknowledge() {
		busy = 'acknowledge';
		await runAction('?/acknowledge');
		busy = null;
	}

	function decisionLabel(item: (typeof view.items)[number]): string {
		if (item.decision === 'enabled') return 'Enabled';
		if (item.decision === 'declined') return 'Kept off';
		if (item.decision === 'acknowledged') return 'Read';
		return item.attention === 'consent' ? 'Needs a decision' : 'New';
	}

	function decisionTone(
		item: (typeof view.items)[number]
	): 'success' | 'neutral' | 'info' | 'warning' {
		if (item.decision === 'enabled') return 'success';
		if (item.decision === 'declined') return 'neutral';
		if (item.decision === 'acknowledged') return 'info';
		return 'warning';
	}
</script>

<svelte:head>
	<title>What’s new · Yoal</title>
</svelte:head>

<header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b pb-5">
	<div class="flex min-w-0 flex-1 basis-80 items-start gap-3.5">
		<span
			class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-brand/10 text-brand shadow-xs"
			aria-hidden="true"
		>
			<SparklesIcon class="size-4" />
		</span>
		<div class="min-w-0 space-y-1">
			<h2 class="text-lg leading-tight font-semibold tracking-tight">What’s new</h2>
			<p class="max-w-2xl text-sm text-pretty text-muted-foreground">
				Changes since you last reviewed this install. Consent items stay hidden until you decide;
				nothing else needs a click.
			</p>
			<p class="text-xs text-muted-foreground">
				Running <span class="font-mono">{view.currentVersion}</span>
				{#if view.lastSeenVersion !== view.currentVersion}
					· last reviewed <span class="font-mono">{view.lastSeenVersion}</span>
				{/if}
			</p>
		</div>
	</div>
</header>

{#if view.items.length === 0}
	<EmptyState
		icon={CheckIcon}
		title="You’re all caught up"
		description={`There are no new changes between ${view.lastSeenVersion} and ${view.currentVersion}. This page fills in after the next update.`}
	/>
{:else}
	{#each groups as group (group.version)}
		<section class="space-y-3">
			<div class="flex items-center gap-2">
				<h3 class="text-sm font-semibold tracking-tight">Yoal {group.version}</h3>
				<Badge variant="outline" class="font-mono text-[10px]">
					{group.items.length}
					{group.items.length === 1 ? 'change' : 'changes'}
				</Badge>
			</div>

			{#each group.items as item (item.id)}
				<Card.Root data-yoal-target={`whats-new.item.${item.id}`}>
					<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 space-y-1">
							<Card.Title class="flex flex-wrap items-center gap-2">
								{item.title}
								<Badge variant={decisionTone(item)}>{decisionLabel(item)}</Badge>
							</Card.Title>
							<Card.Description>{item.summary}</Card.Description>
						</div>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if item.body}
							<p class="max-w-3xl text-sm text-pretty text-muted-foreground">{item.body}</p>
						{/if}

						{#if item.consentState}
							<div class="rounded-md border bg-muted/30 px-3 py-2 text-sm">
								<span class="font-medium"
									>{item.consentState.label} is {item.consentState.enabled ? 'on' : 'off'}.</span
								>
								<span class="text-muted-foreground">
									Pings go to <code class="font-mono text-xs break-all"
										>{item.consentState.endpoint}</code
									>.
								</span>
							</div>
						{/if}

						<div class="flex flex-wrap items-center gap-2">
							{#if item.decision === null}
								{#if item.attention === 'consent'}
									{#if view.canDecide}
										{#if item.consentState?.enabled}
											<Button
												size="sm"
												disabled={busy !== null}
												onclick={() => decide(item.id, 'enabled')}
											>
												<CheckIcon />{item.consentLabels?.keep ?? 'Keep it on'}
											</Button>
										{:else}
											<Button
												size="sm"
												disabled={busy !== null}
												onclick={() => decide(item.id, 'enabled')}
											>
												<CheckIcon />{item.consentLabels?.enable ?? 'Enable'}
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={busy !== null}
												onclick={() => decide(item.id, 'declined')}
											>
												{item.consentLabels?.decline ?? 'Keep it off'}
											</Button>
										{/if}
									{:else}
										<p class="text-sm text-muted-foreground">
											A platform administrator needs to decide this.
										</p>
									{/if}
								{:else if view.canDecide}
									<Button
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onclick={() => decide(item.id, 'acknowledged')}
									>
										<CheckIcon />Got it
									</Button>
								{/if}
							{/if}

							{#if item.href}
								<Button size="sm" variant="ghost" href={item.href}>
									Open settings<ArrowUpRightIcon />
								</Button>
							{/if}
							{#if item.learnMore}
								<Button size="sm" variant="ghost" href={item.learnMore} target="_blank">
									Read the docs<ArrowUpRightIcon />
								</Button>
							{/if}
						</div>

						{#if item.decision && item.decidedAt}
							<p class="text-xs text-muted-foreground">
								{item.decision === 'enabled'
									? 'Enabled'
									: item.decision === 'declined'
										? 'Kept off'
										: 'Acknowledged'}
								· {formatRelative(item.decidedAt)}
							</p>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</section>
	{/each}

	{#if view.pending === 0}
		<Card.Root>
			<Card.Header>
				<Card.Title>Everything is reviewed</Card.Title>
				<Card.Description>
					Clear this page so the next update starts from {view.currentVersion}. Your decisions stay
					in effect.
				</Card.Description>
			</Card.Header>
			<Card.Footer>
				{#if view.canDecide}
					<Button size="sm" disabled={busy !== null} onclick={acknowledge}>
						<CheckIcon />Mark everything as reviewed
					</Button>
				{:else}
					<p class="text-sm text-muted-foreground">
						A platform administrator can clear it once they have reviewed the decisions.
					</p>
				{/if}
			</Card.Footer>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ShieldCheckIcon class="size-4" />
					{view.pending}
					{view.pending === 1 ? 'change is' : 'changes are'} waiting
				</Card.Title>
				<Card.Description>
					{#if view.attention > 0}
						Consent items cannot be skipped: choose Enable or Keep it off, so the setting always
						reflects a decision someone made.
					{:else}
						Mark the informational changes as read to clear them.
					{/if}
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{/if}
{/if}
