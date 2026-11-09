<script lang="ts">
	/**
	 * Calm notices for the alerts pages: the optional telemetry store missing or not answering
	 * (rules cannot evaluate; series keep their last state), and no notification channels
	 * configured (alerts show here, but nobody is told). Platform admins are sent to the Channels
	 * tab to set them up.
	 */
	import type { AlertsOverview, ObservabilitySchema } from '@yoal/contracts';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		overview,
		schema,
		onchannels
	}: {
		overview: AlertsOverview | undefined;
		schema: ObservabilitySchema | undefined;
		/** Platform admins: open the Channels tab, where channels are set up and tested. */
		onchannels?: () => void;
	} = $props();

	const owner = $derived(page.data.can?.manageNodes === true && page.data.role === 'owner');
	const notInstalled = $derived(schema?.installed === false);
</script>

{#if overview && !overview.telemetryAvailable}
	{#if notInstalled}
		<div
			class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed bg-muted/30 px-4 py-3"
			role="status"
		>
			<FeatherIcon class="size-4 shrink-0 text-muted-foreground" />
			<p class="min-w-0 flex-1 text-sm">
				Metric alerts read the optional telemetry store (ClickHouse), which is not installed.
				<span class="text-muted-foreground"
					>Rules can be written now and start evaluating once it is.</span
				>
			</p>
			{#if owner}
				<Button href={resolve('/(dashboard)/settings/telemetry')} variant="outline" size="sm">
					Install in Settings → Telemetry
				</Button>
			{:else}
				<span class="text-sm text-muted-foreground"
					>A platform owner can install it in Settings → Telemetry.</span
				>
			{/if}
		</div>
	{:else}
		<Notice tone="warning" title="The telemetry store is not answering">
			{overview.telemetryError ?? 'ClickHouse is unavailable on this control plane.'}
			Rules keep their last state until it is back: nothing fires or resolves in the meantime.
		</Notice>
	{/if}
{/if}

{#if overview && overview.channels.length === 0}
	<div
		class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed bg-muted/30 px-4 py-3"
		role="status"
	>
		<BellOffIcon class="size-4 shrink-0 text-muted-foreground" />
		<p class="min-w-0 flex-1 text-sm">
			No notification channels are configured.
			<span class="text-muted-foreground"
				>{overview.emailAvailable
					? 'Alerts still show on this page; only per-rule email recipients are notified.'
					: 'Alerts still show on this page, but nobody is notified.'}</span
			>
		</p>
		{#if onchannels}
			<Button variant="outline" size="sm" onclick={onchannels}>Set up channels</Button>
		{:else}
			<span class="text-sm text-muted-foreground">A platform admin can set up channels.</span>
		{/if}
	</div>
{/if}
