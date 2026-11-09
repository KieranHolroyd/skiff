<script lang="ts">
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import LockIcon from '@lucide/svelte/icons/lock';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';

	/** The body of every SvelteKit error page, inside or outside the dashboard shell. */
	let { home = '/' }: { home?: string } = $props();

	const status = $derived(page.status);
	const Icon = $derived(status === 404 ? SearchXIcon : status === 403 ? LockIcon : CircleAlertIcon);
	const title = $derived(
		status === 404 ? 'Page not found' : status === 403 ? 'Access denied' : 'Something went wrong'
	);
</script>

<Empty.Root class="min-h-[60svh]">
	<Empty.Header>
		<Empty.Media variant="icon"><Icon /></Empty.Media>
		<Empty.Title>{title}</Empty.Title>
		<Empty.Description>
			{page.error?.message && page.error.message !== 'Not Found' ? page.error.message : ''}
			<span class="block font-mono text-xs">Error {status}</span>
			{#if page.error?.errorId}
				<!-- Settings → Server errors finds the issue by this id. -->
				<span class="block font-mono text-xs">Reference {page.error.errorId}</span>
			{/if}
		</Empty.Description>
	</Empty.Header>
	<Empty.Content>
		<Button variant="outline" href={home}><ArrowLeftIcon />Go back home</Button>
	</Empty.Content>
</Empty.Root>
