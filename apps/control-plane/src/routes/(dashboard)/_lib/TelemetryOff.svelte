<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from './EmptyState.svelte';

	/**
	 * Telemetry is optional (D101). Not installed is a normal, light install, not a failure; only an
	 * installed store that does not answer is an error. Owners get a link to Settings → Telemetry.
	 */
	let {
		installed,
		reason,
		subject,
		unaffected
	}: {
		/** False: the optional store is not installed. Unknown (undefined) is treated as installed. */
		installed?: boolean;
		reason?: string | null;
		/** What would be charted, e.g. "Request history" or "Database stats". */
		subject: string;
		/** Reassurance, e.g. "Deploys are unaffected." */
		unaffected: string;
	} = $props();

	const owner = $derived(page.data.can?.manageNodes === true && page.data.role === 'owner');
</script>

{#if installed === false}
	<EmptyState
		icon={FeatherIcon}
		title="{subject} needs the optional telemetry store"
		description="This install runs without ClickHouse to stay light, so nothing is recorded. {unaffected} {owner
			? 'Install it in Settings → Telemetry (about 240 MB download, 300–800 MB RAM).'
			: 'A platform owner can install it in Settings → Telemetry.'}"
	>
		{#if owner}
			<Button href={resolve('/(dashboard)/settings/telemetry')} variant="outline" size="sm">
				Telemetry settings
			</Button>
		{/if}
	</EmptyState>
{:else}
	<EmptyState
		icon={ActivityIcon}
		title="The telemetry store is not answering"
		description="{reason ??
			'ClickHouse is unavailable on this control plane.'} {subject} cannot be recorded or charted until it is back. {unaffected}"
	>
		{#if owner}
			<Button href={resolve('/(dashboard)/settings/telemetry')} variant="outline" size="sm">
				Telemetry settings
			</Button>
		{/if}
	</EmptyState>
{/if}
