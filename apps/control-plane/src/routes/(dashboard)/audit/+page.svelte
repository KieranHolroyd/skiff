<script lang="ts">
	import { resolve } from '$app/paths';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatDateTime, shortId } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const selectClass =
		'h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

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
</script>

<svelte:head>
	<title>Audit log · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Audit log"
		description="Every mutating surface writes here: the dashboard, REST API, CLI and MCP. Tokens and secrets are redacted in args."
	/>

	<Card.Root>
		<Card.Header class="border-b pb-4">
			<div class="flex flex-wrap items-end justify-between gap-3">
				<div class="space-y-1">
					<Card.Title>Activity</Card.Title>
					<Card.Description
						>{data.entries.length} entries shown in {data.org.name}.</Card.Description
					>
				</div>
				<form method="GET" class="flex flex-wrap items-end gap-2">
					<div class="space-y-1.5">
						<label for="audit-limit" class="text-xs font-medium text-muted-foreground">Limit</label>
						<select id="audit-limit" name="limit" class={selectClass}>
							{#each data.limits as limit (limit)}
								<option value={limit} selected={data.limit === limit}>{limit}</option>
							{/each}
						</select>
					</div>
					<div class="space-y-1.5">
						<label for="audit-action" class="text-xs font-medium text-muted-foreground"
							>Action</label
						>
						<Input
							id="audit-action"
							name="action"
							value={data.action}
							placeholder="deployment.promote"
							class="h-8 w-44"
						/>
					</div>
					<div class="space-y-1.5">
						<label for="audit-resource" class="text-xs font-medium text-muted-foreground"
							>Resource</label
						>
						<Input
							id="audit-resource"
							name="resource"
							value={data.resource}
							placeholder="project"
							class="h-8 w-32"
						/>
					</div>
					<Button type="submit" variant="outline" size="sm">Apply</Button>
					{#if data.action || data.resource || data.limit !== 50}
						<Button href={resolve('/(dashboard)/audit')} variant="ghost" size="sm">Reset</Button>
					{/if}
				</form>
			</div>
		</Card.Header>
		<Card.Content class="p-0">
			{#if data.entries.length === 0}
				<div class="p-4">
					<EmptyState
						title="No audit entries"
						description={data.action || data.resource
							? 'No entries match these filters. Try clearing them.'
							: 'Deploys, promotes, access changes and API-key actions appear here as soon as they happen.'}
					>
						{#if data.action || data.resource}
							<Button href={resolve('/(dashboard)/audit')} variant="outline" size="sm"
								>Clear filters</Button
							>
						{:else}
							<Button href={resolve('/(dashboard)/projects')} size="sm">
								<ScrollTextIcon class="size-3.5" aria-hidden="true" />
								Open projects
							</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<caption class="sr-only">Audit log entries</caption>
						<thead>
							<tr class="border-b text-left text-xs text-muted-foreground">
								<th class="px-4 py-2.5 font-medium">When</th>
								<th class="px-4 py-2.5 font-medium">Actor</th>
								<th class="px-4 py-2.5 font-medium">Action</th>
								<th class="hidden px-4 py-2.5 font-medium lg:table-cell">Resource</th>
								<th class="px-4 py-2.5 text-right font-medium">Result</th>
								<th class="hidden px-4 py-2.5 font-medium xl:table-cell">Args</th>
							</tr>
						</thead>
						<tbody>
							{#each data.entries as entry (entry.id)}
								{@const args = prettyArgs(entry.argsJson)}
								<tr class="border-b align-top last:border-0 hover:bg-muted/35">
									<td class="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
										<time datetime={new Date(entry.createdAt).toISOString()}
											>{formatDateTime(entry.createdAt)}</time
										>
									</td>
									<td class="px-4 py-3">
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="text-xs font-medium">{actorLabel(entry)}</span>
											<Badge variant="outline">{entry.actorType}</Badge>
										</div>
										{#if entry.clientId}
											<p
												class="mt-1 font-mono text-[10px] text-muted-foreground"
												title={entry.clientId}
											>
												client {shortId(entry.clientId, 14)}
											</p>
										{/if}
										{#if entry.ipHash}
											<p class="font-mono text-[10px] text-muted-foreground">ip {entry.ipHash}</p>
										{/if}
									</td>
									<td class="px-4 py-3">
										<code class="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs"
											>{entry.action}</code
										>
										{#if entry.error}
											<p class="mt-1 max-w-sm text-xs text-destructive">{entry.error}</p>
										{/if}
									</td>
									<td class="hidden px-4 py-3 text-xs lg:table-cell">
										<span class="text-muted-foreground">{entry.resource}</span>
										{#if entry.resourceId}
											<p
												class="font-mono text-[10px] text-muted-foreground"
												title={entry.resourceId}
											>
												{shortId(entry.resourceId, 18)}
											</p>
										{/if}
									</td>
									<td class="px-4 py-3 text-right">
										<Badge variant={entry.result === 'ok' ? 'default' : 'destructive'}
											>{entry.result}</Badge
										>
									</td>
									<td class="hidden px-4 py-3 xl:table-cell">
										{#if args}
											<details class="max-w-md">
												<summary
													class="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
													>args</summary
												>
												<pre
													class="mt-1 max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed">{args}</pre>
											</details>
										{:else}
											<span class="text-xs text-muted-foreground">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
