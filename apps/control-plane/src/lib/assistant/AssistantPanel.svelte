<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
	import CornerDownLeftIcon from '@lucide/svelte/icons/corner-down-left';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import { tick } from 'svelte';
	import { assistant } from '#lib/assistant/assistant.svelte.js';
	import { collectPageContext } from '#lib/assistant/page-context.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { AssistantStatus } from '@skiff/contracts';

	let { status }: { status: AssistantStatus } = $props();

	let input = $state('');
	let draft = $state<HTMLTextAreaElement | null>(null);
	let scroller = $state<HTMLDivElement | null>(null);

	const sending = $derived(assistant.status === 'sending');

	const suggestions = $derived.by(() => {
		const path = typeof window === 'undefined' ? '' : window.location.pathname;
		if (/^\/projects\/[^/]+/.test(path)) {
			return [
				'What is deployed right now, and is anything failing?',
				'Walk me through rolling back production.',
				'Is this project attached to a database or storage?'
			];
		}
		if (path.startsWith('/databases')) {
			return [
				'Which databases are close to their storage budget?',
				'How do I attach a database to an app?'
			];
		}
		if (path.startsWith('/storage')) {
			return ['Which buckets are public?', 'How do I give an app a scoped bucket key?'];
		}
		if (path.startsWith('/nodes')) {
			return ['Is the fleet healthy?', 'How much workload budget is free?'];
		}
		return [
			'What needs my attention right now?',
			'Where do I deploy a new site?',
			'Point me at the audit log.'
		];
	});

	async function send(text = input) {
		const value = text.trim();
		if (!value || sending) return;
		input = '';
		assistant.send(value, collectPageContext());
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}

	function speakerLabel(speaker: string | undefined): string {
		if (!speaker) return 'Skiff';
		if (speaker === 'lead') return 'Skiff';
		return status.agents.find((agent) => agent.id === speaker)?.label ?? speaker;
	}

	$effect(() => {
		// Follow the stream unless the user has scrolled up to read something.
		void assistant.messages;
		if (!scroller) return;
		const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
		if (nearBottom) scroller.scrollTo({ top: scroller.scrollHeight });
	});

	$effect(() => {
		if (assistant.open) tick().then(() => draft?.focus());
	});
</script>

<Sheet.Root bind:open={assistant.open}>
	<Sheet.Content side="right" class="w-full gap-0 p-0 sm:max-w-md" showCloseButton={false}>
		<Sheet.Header class="flex flex-row items-center gap-3 border-b px-4 py-3">
			<div
				class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
			>
				<SparklesIcon class="size-4" />
			</div>
			<div class="min-w-0 flex-1">
				<Sheet.Title class="text-sm font-semibold">Skiff assistant</Sheet.Title>
				<Sheet.Description class="truncate font-mono text-xs">
					{status.model ?? 'not configured'} · {status.maxAgents} agents max
				</Sheet.Description>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				title="New conversation"
				aria-label="New conversation"
				onclick={() => assistant.reset()}
			>
				<RotateCcwIcon />
			</Button>
		</Sheet.Header>

		<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
			{#if assistant.messages.length === 0}
				<div class="space-y-4 py-6">
					<div class="space-y-1">
						<p class="text-sm font-medium">Ask about this page or your platform.</p>
						<p class="text-sm text-muted-foreground">
							I can read the same MCP tools your agents use, point at things on screen, and walk you
							through changes. Destructive actions always ask first.
						</p>
					</div>
					<div class="space-y-2">
						{#each suggestions as suggestion (suggestion)}
							<button
								type="button"
								class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
								onclick={() => send(suggestion)}
							>
								<ChevronRightIcon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
								<span>{suggestion}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class="space-y-4">
				{#each assistant.messages as message (message.id)}
					{#if message.role === 'user'}
						<div class="flex justify-end">
							<div
								class="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
							>
								{message.content}
							</div>
						</div>
					{:else}
						<div class="flex gap-2.5">
							<div
								class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground"
							>
								{#if message.speaker === 'lead'}
									<SparklesIcon class="size-3.5" />
								{:else}
									<BotIcon class="size-3.5" />
								{/if}
							</div>
							<div class="min-w-0 flex-1 space-y-1">
								<p class="text-xs font-medium text-muted-foreground">
									{speakerLabel(message.speaker)}
								</p>
								{#if message.content}
									<div
										class="text-sm leading-relaxed whitespace-pre-wrap {message.error
											? 'text-destructive'
											: ''}"
									>
										{message.content}
									</div>
								{:else if sending}
									<span class="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
										<Spinner /> thinking…
									</span>
								{/if}
							</div>
						</div>
					{/if}
				{/each}
			</div>

			{#if assistant.activities.length > 0}
				<details class="mt-4 rounded-lg border bg-muted/30" open={sending}>
					<summary
						class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground"
					>
						<WrenchIcon class="size-3.5" />
						{assistant.activities.length} tool
						{assistant.activities.length === 1 ? 'call' : 'calls'}
					</summary>
					<ul class="space-y-1.5 border-t px-3 py-2">
						{#each assistant.activities as activity (activity.callId)}
							<li class="flex items-start gap-2 text-xs">
								{#if activity.status === 'running'}
									<Spinner class="mt-0.5 size-3" />
								{:else if activity.status === 'ok'}
									<span class="mt-1 size-1.5 shrink-0 rounded-full bg-success"></span>
								{:else}
									<span class="mt-1 size-1.5 shrink-0 rounded-full bg-destructive"></span>
								{/if}
								<div class="min-w-0 flex-1">
									<p class="font-medium">{activity.title}</p>
									{#if activity.summary}
										<p class="line-clamp-2 text-muted-foreground">{activity.summary}</p>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if assistant.confirmation}
				{@const confirmation = assistant.confirmation}
				<div class="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-3">
					<div class="flex items-start gap-2">
						<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />
						<div class="min-w-0 flex-1 space-y-2">
							<p class="text-sm font-medium">Confirm: {confirmation.title}</p>
							<pre
								class="max-h-36 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{confirmation.summary}</pre>
							{#if confirmation.status === 'pending'}
								<div class="flex gap-2">
									<Button size="sm" variant="destructive" onclick={() => assistant.confirm()}
										>Confirm</Button
									>
									<Button size="sm" variant="outline" onclick={() => assistant.deny()}
										>Cancel</Button
									>
								</div>
							{:else if confirmation.status === 'running'}
								<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
									><Spinner /> running…</span
								>
							{:else if confirmation.status === 'done'}
								<p class="text-xs text-success">Done.</p>
								{#if confirmation.result}
									<pre
										class="max-h-36 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{confirmation.result}</pre>
								{/if}
							{:else if confirmation.status === 'denied'}
								<p class="text-xs text-muted-foreground">Cancelled. Nothing changed.</p>
							{:else}
								<p class="text-xs text-destructive">{confirmation.error ?? 'The action failed.'}</p>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			{#if assistant.error}
				<Alert.Root variant="destructive" class="mt-4">
					<TriangleAlertIcon />
					<Alert.Title>Assistant unavailable</Alert.Title>
					<Alert.Description>{assistant.error}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if assistant.activeAgents.length > 0 && assistant.messages.length > 0}
				<div class="mt-3 flex flex-wrap gap-1">
					{#each assistant.activeAgents as agent (agent)}
						<Badge variant="outline" class="gap-1.5 font-normal">
							<span class="relative flex size-1.5">
								<span class="absolute size-full animate-ping rounded-full bg-brand opacity-60"
								></span>
								<span class="relative size-1.5 rounded-full bg-brand"></span>
							</span>
							{agent}
						</Badge>
					{/each}
				</div>
			{/if}
		</div>

		<Sheet.Footer class="border-t p-3">
			<div class="flex items-end gap-2">
				<Textarea
					bind:ref={draft}
					bind:value={input}
					rows={2}
					placeholder="Ask about this page, a project, or the fleet…"
					class="max-h-40 min-h-10 resize-none text-sm"
					onkeydown={keydown}
					disabled={sending}
				/>
				{#if sending}
					<Button
						variant="outline"
						size="icon"
						title="Stop"
						aria-label="Stop"
						onclick={() => assistant.stop()}
					>
						<CircleStopIcon />
					</Button>
				{:else}
					<Button
						size="icon"
						title="Send"
						aria-label="Send"
						disabled={!input.trim()}
						onclick={() => send()}
					>
						<SendIcon />
					</Button>
				{/if}
			</div>
			<p class="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
				<CornerDownLeftIcon class="size-3" /> Enter to send · Shift+Enter for a new line ·
				<span class="truncate">actions are audited</span>
			</p>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
