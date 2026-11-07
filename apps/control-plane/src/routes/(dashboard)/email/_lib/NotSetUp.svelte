<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import MailIcon from '@lucide/svelte/icons/mail';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';

	/**
	 * The calm "not set up" state every Email page shows until a platform admin picks a mail node
	 * (docs/EMAIL.md §9, the telemetry pattern). `compact` is the banner above a usable page.
	 */
	let { platformAdmin, compact = false }: { platformAdmin: boolean; compact?: boolean } = $props();
</script>

{#if compact}
	<Notice tone="info" title="Email isn't set up yet">
		You can add domains and credentials now; nothing is sent until
		{#if platformAdmin}
			you pick a mail node in <a
				href={resolve('/(dashboard)/settings/email')}
				class="font-medium underline underline-offset-4">Settings → Email</a
			>.
		{:else}
			a platform admin picks a mail node. Ask one to set it up in Settings → Email.
		{/if}
	</Notice>
{:else}
	<EmptyState
		icon={MailIcon}
		title="Email isn't set up yet"
		description={platformAdmin
			? 'Skiff sends mail from one node you choose, with its own MTA. Pick the mail node in Settings → Email; the page checks port 25, reverse DNS and blocklists and lists the DNS records to publish.'
			: 'Skiff sends mail from a node a platform admin chooses. Ask a platform admin to set it up in Settings → Email; until then you can add domains and credentials, but nothing is sent.'}
	>
		{#if platformAdmin}
			<Button href={resolve('/(dashboard)/settings/email')}>Set up email<ArrowRightIcon /></Button>
		{/if}
	</EmptyState>
{/if}
