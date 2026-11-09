<script lang="ts">
	/**
	 * The telemetry store's state for the dashboards pages (D101). ClickHouse is optional: not
	 * installed is a calm, normal state with a pointer to Settings → Telemetry; installed but not
	 * answering is a warning with the server's reason. Nothing renders when it is available.
	 */
	import type { ObservabilitySchema } from '@yoal/contracts';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';

	let {
		schema,
		editable = true,
		large = false
	}: {
		schema: ObservabilitySchema | undefined;
		/** Saved dashboards can still be edited (list and dashboard pages; not Explore). */
		editable?: boolean;
		/** A full empty state instead of a banner (Explore, where there is nothing else to show). */
		large?: boolean;
	} = $props();

	const owner = $derived(page.data.can?.manageNodes === true && page.data.role === 'owner');
	const message =
		'Dashboards need the optional telemetry store (ClickHouse). This install runs without it to stay light.';
</script>

{#snippet action()}
	{#if owner}
		<Button href={resolve('/(dashboard)/settings/telemetry')} variant="outline" size="sm">
			Install in Settings → Telemetry
		</Button>
	{:else}
		<span class="text-sm text-muted-foreground"
			>A platform owner can install it in Settings → Telemetry.</span
		>
	{/if}
{/snippet}

{#if schema && !schema.installed}
	{#if large}
		<Empty.Root class="border border-dashed py-12">
			<Empty.Header>
				<Empty.Media variant="icon"><FeatherIcon /></Empty.Media>
				<Empty.Title>Telemetry is not installed</Empty.Title>
				<Empty.Description>{message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>{@render action()}</Empty.Content>
		</Empty.Root>
	{:else}
		<div
			class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed bg-muted/30 px-4 py-3"
			role="status"
		>
			<FeatherIcon class="size-4 shrink-0 text-muted-foreground" />
			<p class="min-w-0 flex-1 text-sm">
				{message}
				{#if editable}<span class="text-muted-foreground"
						>Saved dashboards can still be opened and edited.</span
					>{/if}
			</p>
			{@render action()}
		</div>
	{/if}
{:else if schema && !schema.available}
	<Notice tone="warning" title="The telemetry store is not answering">
		{schema.error ?? 'ClickHouse is unavailable on this control plane.'}
		{#if editable}Dashboards can still be edited and saved.{/if}
	</Notice>
{/if}
