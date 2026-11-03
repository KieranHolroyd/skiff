<script lang="ts">
	import { resolve } from '$app/paths';
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ServerIcon from '@lucide/svelte/icons/server';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import { formatDateTime, shortId } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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

	<Panel
		title="Activity"
		count={data.entries.length}
		description="Most recent first, in {data.org.name}."
		flush
	>
		<form
			method="GET"
			class="flex flex-wrap items-end gap-3 border-b bg-muted/25 px-4 py-3"
			aria-label="Filter audit entries"
		>
			<div class="space-y-1">
				<label for="audit-action" class="eyebrow">Action</label>
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						id="audit-action"
						name="action"
						value={data.action}
						placeholder="deployment.promote"
						class="w-52 bg-card pl-8 font-mono text-[12.5px]"
					/>
				</div>
			</div>
			<div class="space-y-1">
				<label for="audit-resource" class="eyebrow">Resource</label>
				<Input
					id="audit-resource"
					name="resource"
					value={data.resource}
					placeholder="project"
					class="w-36 bg-card font-mono text-[12.5px]"
				/>
			</div>
			<div class="space-y-1">
				<label for="audit-limit" class="eyebrow">Show</label>
				<select id="audit-limit" name="limit" class="select-native w-24">
					{#each data.limits as limit (limit)}
						<option value={limit} selected={data.limit === limit}>{limit}</option>
					{/each}
				</select>
			</div>
			<div class="flex gap-2">
				<Button type="submit" variant="outline">Apply</Button>
				{#if filtered}
					<Button href={resolve('/(dashboard)/audit')} variant="ghost">Reset</Button>
				{/if}
			</div>
		</form>

		{#if data.entries.length === 0}
			<div class="p-4">
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
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="data-table">
					<caption class="sr-only">Audit log entries</caption>
					<thead>
						<tr>
							<th class="w-0">When</th>
							<th>Actor</th>
							<th>Action</th>
							<th class="hidden lg:table-cell">Resource</th>
							<th class="text-right">Result</th>
						</tr>
					</thead>
					<tbody>
						{#each data.entries as entry (entry.id)}
							{@const args = prettyArgs(entry.argsJson)}
							{@const Icon = actorIcon(entry.actorType)}
							<tr class="align-top">
								<td class="font-mono text-[11.5px] whitespace-nowrap text-muted-foreground">
									<time datetime={new Date(entry.createdAt).toISOString()}
										>{formatDateTime(entry.createdAt)}</time
									>
								</td>
								<td>
									<div class="flex items-start gap-2">
										<span
											class="mt-px grid size-6 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground"
											title={entry.actorType}
										>
											<Icon class="size-3.5" aria-hidden="true" />
										</span>
										<div class="min-w-0">
											<p class="text-[13px] font-medium">{actorLabel(entry)}</p>
											<p class="font-mono text-[10.5px] text-muted-foreground">
												{entry.actorType}{#if entry.clientId}
													<span title={entry.clientId}>
														· {shortId(entry.clientId, 14)}</span
													>{/if}{#if entry.ipHash}
													<span> · ip {entry.ipHash}</span>{/if}
											</p>
										</div>
									</div>
								</td>
								<td>
									<code
										class="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px] whitespace-nowrap"
										>{entry.action}</code
									>
									{#if entry.error}
										<p class="mt-1.5 max-w-sm text-xs text-destructive">{entry.error}</p>
									{/if}
									{#if args}
										<details class="group mt-1.5 max-w-lg">
											<summary
												class="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
											>
												<ChevronRightIcon
													class="size-3 transition-transform group-open:rotate-90"
													aria-hidden="true"
												/>
												Arguments
											</summary>
											<pre class="code-block mt-1.5 max-h-64">{args}</pre>
										</details>
									{/if}
								</td>
								<td class="hidden text-xs lg:table-cell">
									<span class="font-medium">{entry.resource}</span>
									{#if entry.resourceId}
										<p
											class="font-mono text-[10.5px] text-muted-foreground"
											title={entry.resourceId}
										>
											{shortId(entry.resourceId, 18)}
										</p>
									{/if}
								</td>
								<td class="text-right">
									<StatusBadge
										status={entry.result}
										tone={entry.result === 'ok' ? 'success' : 'danger'}
									/>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Panel>
</div>
