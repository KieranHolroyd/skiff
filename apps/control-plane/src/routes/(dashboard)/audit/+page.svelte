<script lang="ts">
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ServerIcon from '@lucide/svelte/icons/server';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatDateTime, shortId } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Entry = (typeof data.entries)[number];

	let limit = $derived(String(data.limit));
	let selected = $state<Entry | null>(null);

	const filtered = $derived(Boolean(data.action || data.resource || data.limit !== 50));

	function prettyArgs(json: string | null): string | null {
		if (!json) return null;
		try {
			return JSON.stringify(JSON.parse(json), null, 2);
		} catch {
			return json;
		}
	}

	function actorLabel(entry: { actorId: string | null; actorType: string }): string {
		if (!entry.actorId) return entry.actorType;
		const actor = data.actors[entry.actorId];
		return actor?.name || shortId(entry.actorId, 12);
	}

	function actorIcon(type: string) {
		if (type === 'apiKey') return KeyRoundIcon;
		if (type === 'agent') return ServerIcon;
		if (type === 'mcp' || type === 'system') return BotIcon;
		return UserRoundIcon;
	}
</script>

<svelte:head>
	<title>Audit log · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Platform"
		title="Audit log"
		description="Every mutating surface writes here: the dashboard, REST API, CLI and MCP. Tokens and secrets are redacted in args."
	/>

	<form method="GET" class="flex flex-wrap items-end gap-3" aria-label="Filter audit entries">
		<Field.Field class="w-60">
			<Field.Label for="audit-action" class="eyebrow">Action</Field.Label>
			<InputGroup.Root class="bg-card">
				<InputGroup.Input
					id="audit-action"
					name="action"
					value={data.action}
					placeholder="deployment.promote"
					class="font-mono text-[12.5px]"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
			</InputGroup.Root>
		</Field.Field>
		<Field.Field class="w-40">
			<Field.Label for="audit-resource" class="eyebrow">Resource</Field.Label>
			<Input
				id="audit-resource"
				name="resource"
				value={data.resource}
				placeholder="project"
				class="bg-card font-mono text-[12.5px]"
			/>
		</Field.Field>
		<Field.Field class="w-28">
			<Field.Label for="audit-limit" class="eyebrow">Show</Field.Label>
			<Select.Root type="single" name="limit" bind:value={limit}>
				<Select.Trigger id="audit-limit" class="w-full bg-card">{limit}</Select.Trigger>
				<Select.Content>
					{#each data.limits as option (option)}
						<Select.Item value={String(option)} label={String(option)}>{option}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</Field.Field>
		<div class="flex gap-2">
			<Button type="submit" variant="outline">Apply</Button>
			{#if filtered}
				<Button href={resolve('/(dashboard)/audit')} variant="ghost">Reset</Button>
			{/if}
		</div>
	</form>

	{#if data.entries.length === 0}
		<EmptyState
			icon={ScrollTextIcon}
			title="No audit entries"
			description={data.action || data.resource
				? 'No entries match these filters. Try clearing them.'
				: 'Deploys, promotes, access changes and API-key actions appear here as soon as they happen.'}
		>
			{#if data.action || data.resource}
				<Button href={resolve('/(dashboard)/audit')} variant="outline" size="sm"
					>Clear filters</Button
				>
			{/if}
		</EmptyState>
	{:else}
		<div class="overflow-hidden rounded-xl border bg-card shadow-card">
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>Actor</Table.Head>
						<Table.Head>Action</Table.Head>
						<Table.Head class="hidden lg:table-cell">Resource</Table.Head>
						<Table.Head>Result</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Details</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.entries as entry (entry.id)}
						{@const Icon = actorIcon(entry.actorType)}
						<Table.Row>
							<Table.Cell class="pl-4 font-mono text-[11.5px] text-muted-foreground">
								<time datetime={new Date(entry.createdAt).toISOString()}
									>{formatDateTime(entry.createdAt)}</time
								>
							</Table.Cell>
							<Table.Cell>
								<div class="flex items-center gap-2">
									<span
										class="grid size-6 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground"
										title={entry.actorType}
									>
										<Icon class="size-3.5" />
									</span>
									<div class="min-w-0 leading-tight">
										<p class="text-[13px] font-medium">{actorLabel(entry)}</p>
										<p class="font-mono text-[10.5px] text-muted-foreground">{entry.actorType}</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell>
								<code class="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px]"
									>{entry.action}</code
								>
								{#if entry.error}
									<p class="mt-1 max-w-sm truncate text-xs text-destructive">{entry.error}</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden text-xs lg:table-cell">
								<span class="font-medium">{entry.resource}</span>
								{#if entry.resourceId}
									<p class="font-mono text-[10.5px] text-muted-foreground" title={entry.resourceId}>
										{shortId(entry.resourceId, 18)}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={entry.result}
									tone={entry.result === 'ok' ? 'success' : 'danger'}
								/>
							</Table.Cell>
							<Table.Cell class="pr-4">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="View details for {entry.action}"
									onclick={() => (selected = entry)}
								>
									<ChevronRightIcon />
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<Sheet.Root open={selected !== null} onOpenChange={(open) => !open && (selected = null)}>
	<Sheet.Content class="w-full gap-0 sm:max-w-lg">
		{#if selected}
			{@const args = prettyArgs(selected.argsJson)}
			<Sheet.Header class="border-b">
				<Sheet.Title class="font-mono text-base">{selected.action}</Sheet.Title>
				<Sheet.Description>
					<time datetime={new Date(selected.createdAt).toISOString()}
						>{formatDateTime(selected.createdAt)}</time
					>
				</Sheet.Description>
			</Sheet.Header>
			<ScrollArea class="min-h-0 flex-1">
				<div class="space-y-6 p-4">
					<dl class="kv">
						<dt>Result</dt>
						<dd>
							<StatusBadge
								status={selected.result}
								tone={selected.result === 'ok' ? 'success' : 'danger'}
							/>
						</dd>
						<dt>Actor</dt>
						<dd>
							{actorLabel(selected)}
							<span class="text-muted-foreground">({selected.actorType})</span>
						</dd>
						{#if selected.clientId}
							<dt>Client</dt>
							<dd class="font-mono text-[12px] break-all">{selected.clientId}</dd>
						{/if}
						{#if selected.ipHash}
							<dt>IP hash</dt>
							<dd class="font-mono text-[12px]">{selected.ipHash}</dd>
						{/if}
						<dt>Resource</dt>
						<dd>{selected.resource}</dd>
						{#if selected.resourceId}
							<dt>Resource ID</dt>
							<dd class="font-mono text-[12px] break-all">{selected.resourceId}</dd>
						{/if}
					</dl>
					{#if selected.error}
						<div class="space-y-1.5">
							<p class="eyebrow">Error</p>
							<p class="text-sm text-destructive">{selected.error}</p>
						</div>
					{/if}
					<div class="space-y-1.5">
						<p class="eyebrow">Arguments</p>
						{#if args}
							<pre class="code-block max-h-[50svh]">{args}</pre>
						{:else}
							<p class="text-sm text-muted-foreground">No arguments recorded.</p>
						{/if}
					</div>
				</div>
			</ScrollArea>
		{/if}
	</Sheet.Content>
</Sheet.Root>
