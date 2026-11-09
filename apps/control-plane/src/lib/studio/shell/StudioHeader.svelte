<script lang="ts">
	import ClockIcon from '@lucide/svelte/icons/clock';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import XIcon from '@lucide/svelte/icons/x';
	import type { StudioInfo } from '@yoal/studio/protocol';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { countdown } from './errors.js';

	/** The studio session bar (plan 22): mode, expiry, session actions and "New query". */
	let {
		name,
		engine,
		readOnly,
		expiresAt,
		info,
		canWrite,
		onopenreadonly,
		onenablewrites,
		onclose,
		onnewquery
	}: {
		name: string;
		/** Engine from the database record, shown until `info` reports the running version. */
		engine: string;
		readOnly: boolean;
		expiresAt: string | null;
		info: StudioInfo | undefined;
		/** The user holds `database:update`. */
		canWrite: boolean;
		onopenreadonly: () => void;
		onenablewrites: () => void;
		onclose: () => void;
		onnewquery: () => void;
	} = $props();

	let now = $state(Date.now());
	$effect(() => {
		if (!expiresAt) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const remainingMs = $derived(expiresAt ? Date.parse(expiresAt) - now : null);
	const expired = $derived(remainingMs !== null && remainingMs <= 0);
	const soon = $derived(remainingMs !== null && remainingMs > 0 && remainingMs < 60_000);
</script>

<div
	class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2"
	role="group"
	aria-label="Studio session"
>
	<div class="flex min-w-0 items-center gap-2">
		<DatabaseIcon class="size-4 shrink-0 text-muted-foreground" />
		<span class="truncate font-medium">{name}</span>
		<Badge variant="outline" class="font-mono font-normal">
			{info ? `${info.engine} ${info.version}` : engine}
		</Badge>
		{#if readOnly}
			<Badge variant="secondary"><ShieldCheckIcon />Read-only</Badge>
		{:else}
			<Badge variant="warning"><PencilIcon />Read-write</Badge>
		{/if}
	</div>

	{#if remainingMs !== null}
		<span
			class="flex items-center gap-1 text-xs {expired
				? 'text-destructive'
				: soon
					? 'text-warning'
					: 'text-muted-foreground'}"
		>
			<ClockIcon class="size-3.5" />
			{#if expired}
				Session expired
			{:else}
				Expires in <time class="font-mono tabular-nums" datetime={expiresAt}>{countdown(remainingMs)}</time>
			{/if}
		</span>
	{/if}

	<div class="ml-auto flex flex-wrap items-center gap-2">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="sm" variant="outline" disabled={expired} onclick={onnewquery}>
						<PlusIcon />New query
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content><Kbd>⌘</Kbd><Kbd>⌥</Kbd><Kbd>N</Kbd></Tooltip.Content>
		</Tooltip.Root>
		{#if expired}
			<Button size="sm" onclick={onopenreadonly}><RefreshCwIcon />Open again</Button>
		{:else if readOnly && canWrite}
			<Button variant="outline" size="sm" onclick={onenablewrites}><PencilIcon />Enable writes</Button>
		{:else if !readOnly}
			<Button variant="outline" size="sm" onclick={onopenreadonly}>
				<ShieldCheckIcon />Switch to read-only
			</Button>
		{/if}
		<Button variant="outline" size="sm" onclick={onclose}><XIcon />Close</Button>
	</div>
</div>
