<script lang="ts">
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Issues from './_lib/Issues.svelte';
	import Targets from './_lib/Targets.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="space-y-5">
	<PageHeader
		title="Errors"
		eyebrow="Observe"
		description="Sentry-compatible error tracking for this organization's apps. One target per Yoal project, or attach an off-platform app with its own DSN."
	/>

	{#if !data.service}
		<EmptyState
			icon={CircleAlertIcon}
			title="No access to errors"
			description="Viewing this organization's errors needs the project:read permission, or a project-scoped role."
		/>
	{:else}
		<div class="flex flex-wrap items-center gap-1 border-b pb-2">
			<a
				href="?tab=issues"
				class="rounded-md px-3 py-1.5 text-sm {data.tab === 'issues' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
			>
				Issues
			</a>
			<a
				href="?tab=targets"
				class="rounded-md px-3 py-1.5 text-sm {data.tab === 'targets' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
			>
				Targets
			</a>
			<span class="ms-auto text-xs text-muted-foreground">
				{data.service.targets.length} target{data.service.targets.length === 1 ? '' : 's'}
				· {data.service.autoLink ? 'automatic linking on' : 'automatic linking off'}
			</span>
		</div>

		{#if data.tab === 'targets'}
			<Targets service={data.service} projects={data.unlinkedProjects} origin={data.platform.origin} canManage={data.canManage} />
		{:else}
			<Issues
				service={data.service}
				list={data.list}
				detail={data.detail}
				filters={data.filters}
				canManage={data.canManage}
			/>
		{/if}
	{/if}
</div>
