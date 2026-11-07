<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { roleBadge } from './_lib/roles.js';

	/**
	 * Settings sections are listed in the main sidebar, which swaps to them while a settings page
	 * is open (see the dashboard layout and `_lib/SettingsNav.svelte`).
	 */
	let { data, children } = $props();
</script>

<div class="space-y-6 lg:space-y-8">
	<PageHeader
		target="page.settings"
		eyebrow={data.org.name}
		title="Settings"
		description="You, the organisation you are signed in to, and the Skiff platform it runs on."
	>
		<span class="flex items-center gap-2 text-sm text-muted-foreground">
			Signed in as <span class="font-medium text-foreground">{data.user.name}</span>
			<Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge>
		</span>
	</PageHeader>

	<div class="w-full max-w-5xl min-w-0 space-y-6">
		{@render children()}
	</div>
</div>
