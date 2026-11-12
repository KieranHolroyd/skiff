<script lang="ts">
	/**
	 * Errors (docs/APP-ERRORS.md §10): Sentry-compatible error tracking for the organization's apps.
	 * The sections (Issues, Targets, Setup) live in the sidebar subnav and in `?tab=`; an open issue
	 * is `?issue=` on the Issues tab, so every view is a link.
	 */
	import { resolve } from '$app/paths';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import IssueDetail from './_lib/IssueDetail.svelte';
	import IssueList from './_lib/IssueList.svelte';
	import Setup from './_lib/Setup.svelte';
	import Targets from './_lib/Targets.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const headers = {
		issues: {
			title: 'Issues',
			description:
				'Errors from every target, grouped by cause. Resolve what is fixed; if it happens again it comes back flagged as a regression.'
		},
		targets: {
			title: 'Targets',
			description:
				'Where errors come from. Each target has a DSN that any Sentry SDK, or the one-line browser script, can send to.'
		},
		setup: {
			title: 'Set up error tracking',
			description:
				'Sentry-compatible and built into Yoal: no extra account or service. One target, one snippet, one test error.'
		}
	} as const;
	const header = $derived(headers[data.tab]);
	const docs = resolve('/(dashboard)/docs/[...slug]', { slug: 'observe/app-errors' });
</script>

<svelte:head
	><title>{data.detail ? `${data.detail.issue.name} · Errors` : `${header.title} · Errors`}</title
	></svelte:head
>

<div class="space-y-6">
	{#if !data.service}
		<PageHeader title="Errors" eyebrow="Observe" />
		<EmptyState
			icon={CircleAlertIcon}
			title="No access to errors"
			description="Viewing this organization's errors needs the project:read permission, or a project-scoped role."
		/>
	{:else if data.tab === 'issues' && data.detail}
		<IssueDetail
			detail={data.detail}
			service={data.service}
			filters={data.filters}
			canManage={data.canManage}
		/>
	{:else}
		<PageHeader
			title={header.title}
			eyebrow="Errors"
			description={header.description}
			target="errors.header"
		>
			<Button variant="ghost" size="sm" href={docs}><BookOpenIcon />Docs</Button>
		</PageHeader>

		{#if data.missingIssue}
			<Notice tone="warning" title="That issue is gone">
				It was deleted, or it belongs to a target you can no longer read.
			</Notice>
		{/if}

		{#if data.tab === 'setup'}
			<Setup
				service={data.service}
				projects={data.unlinkedProjects}
				origin={data.platform.origin}
				canManage={data.canManage}
				preselect={data.filters.target || null}
			/>
		{:else if data.tab === 'targets'}
			<Targets service={data.service} projects={data.unlinkedProjects} canManage={data.canManage} />
		{:else}
			<IssueList
				service={data.service}
				list={data.list}
				filters={data.filters}
				canManage={data.canManage}
			/>
		{/if}
	{/if}
</div>
