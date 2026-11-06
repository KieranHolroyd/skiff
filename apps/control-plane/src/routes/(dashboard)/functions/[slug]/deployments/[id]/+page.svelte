<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CableIcon from '@lucide/svelte/icons/cable';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import InfoIcon from '@lucide/svelte/icons/info';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import Panel from '../../../../_lib/Panel.svelte';
	import CopyValue from '../../../../_lib/service/CopyValue.svelte';
	import { readTab } from '../../../../_lib/service/sections.js';
	import {
		displayUrl,
		formatBytes,
		formatDateTime,
		shortId,
		shortSha
	} from '../../../../_lib/format.js';
	import { bindingInfo, formatIdleStop } from '../../../../_lib/function-view.js';
	import LogsPanel from '../../../../projects/[slug]/_components/LogsPanel.svelte';
	import SourcePanel from '../../../../projects/[slug]/_components/SourcePanel.svelte';
	import FunctionHeader from '../../../_lib/FunctionHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TABS = ['overview', 'logs', 'source'] as const;
	type Tab = (typeof TABS)[number];
	let tab = $state<Tab>(readTab(page.url.searchParams.get('tab'), TABS, 'overview'));
	function setTab(next: string) {
		tab = next as Tab;
		const url = new URL(page.url.href);
		if (next === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		void goto(url, { shallow: true, replace: true });
	}

	const deployment = $derived(data.deployment);
	const snapshot = $derived(deployment.spec?.function ?? null);
	const onHost = $derived(data.runningDeploymentId === deployment.id);
	const creator = $derived(
		deployment.createdBy.name ?? deployment.createdBy.email ?? shortId(deployment.createdBy.id, 12)
	);
	let logSource = $state<'runtime' | 'build'>('runtime');

	function promote() {
		askConfirm({
			title: `Promote ${deployment.shortId} to production?`,
			description: `${displayUrl(data.project.productionUrl)} starts serving this deployment.`,
			confirmLabel: 'Promote',
			action: '?/promote'
		});
	}

	function remove() {
		askConfirm({
			title: `Delete deployment ${deployment.shortId}?`,
			description: 'Its preview URL stops working and the release can no longer be promoted.',
			confirmLabel: 'Delete deployment',
			tone: 'danger',
			action: '?/delete'
		});
	}
</script>

<svelte:head>
	<title>{deployment.shortId} · {data.project.name} · Functions · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<FunctionHeader slug={data.project.slug} active="deployment">
		{#snippet meta()}
			<span class="text-foreground">Deployment</span>
			<span class="font-mono text-foreground">{deployment.shortId}</span>
			<StatusBadge status={deployment.status} />
			{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
			{#if onHost}<Badge variant="outline">on the host</Badge>{/if}
			{#if deployment.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
		{/snippet}
		<Button variant="outline" href={deployment.previewUrl} target="_blank" rel="external noreferrer"
			><ArrowUpRightIcon />Open preview</Button
		>
		{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
			<Button onclick={promote}><ArrowUpIcon />Promote</Button>
		{/if}
		{#if data.can.promote}
			<Button
				variant="ghost"
				size="icon"
				aria-label={deployment.pinned ? 'Unpin' : 'Pin'}
				title={deployment.pinned ? 'Unpin' : 'Pin (keep forever)'}
				onclick={() => runAction('?/pin', { pinned: deployment.pinned ? 'false' : 'true' })}
			>
				{#if deployment.pinned}<PinOffIcon />{:else}<PinIcon />{/if}
			</Button>
		{/if}
		{#if data.can.delete && !deployment.isProduction}
			<Button variant="ghost-danger" size="icon" aria-label="Delete deployment" onclick={remove}
				><TrashIcon /></Button
			>
		{/if}
	</FunctionHeader>

	<Tabs.Root value={tab} onValueChange={setTab}>
		<Tabs.List
			variant="line"
			class="w-full justify-start border-b"
			aria-label="Deployment sections"
		>
			<Tabs.Trigger value="overview" class="flex-none"><LayoutDashboardIcon />Overview</Tabs.Trigger
			>
			<Tabs.Trigger value="logs" class="flex-none"><ScrollTextIcon />Logs</Tabs.Trigger>
			<Tabs.Trigger value="source" class="flex-none"><FolderTreeIcon />Bundle</Tabs.Trigger>
		</Tabs.List>
	</Tabs.Root>

	{#if tab === 'overview'}
		<div class="grid items-start gap-5 xl:grid-cols-5">
			<div class="space-y-5 xl:col-span-3">
				{#if snapshot}
					<Panel
						title="Function snapshot"
						icon={CableIcon}
						description="Resolved at deploy time. Promote or roll back restores code, bindings and compatibility together."
					>
						<DetailList>
							<dt>Entry module</dt>
							<dd class="truncate font-mono text-xs" title={snapshot.main}>
								{snapshot.main}
								<span class="text-muted-foreground">· {snapshot.moduleCount} modules</span>
							</dd>
							<dt>Compatibility</dt>
							<dd class="font-mono text-xs">
								{snapshot.compatibilityDate}{snapshot.compatibilityFlags.length
									? ` · ${snapshot.compatibilityFlags.join(', ')}`
									: ''}
							</dd>
							<dt>workerd</dt>
							<dd class="font-mono text-xs">{snapshot.workerdVersion}</dd>
							<dt>Idle stop</dt>
							<dd class="text-xs">{formatIdleStop(snapshot.idleStopSeconds)}</dd>
							<dt>Cron</dt>
							<dd class="font-mono text-xs">
								{snapshot.crons.length ? snapshot.crons.join(', ') : 'none'}
							</dd>
							<dt>Memory / CPU</dt>
							<dd class="font-mono text-xs">
								{deployment.spec?.memoryMb} MB · {deployment.spec?.cpus} vCPU
							</dd>
						</DetailList>
						{#if snapshot.bindings.length > 0}
							<div class="mt-4 flex flex-wrap gap-1.5">
								{#each snapshot.bindings as binding (binding.name)}
									<Badge variant="outline" class="font-mono text-xs">
										{binding.name}
										<span class="font-sans text-muted-foreground"
											>{bindingInfo(binding.type).label}</span
										>
									</Badge>
								{/each}
							</div>
						{/if}
					</Panel>
				{:else}
					<Panel title="Function snapshot" icon={CableIcon}>
						<p class="text-sm text-muted-foreground">
							This deployment carries no resolved function spec. It was made before the project
							became a function, or its bundle had no skiff-function.json.
						</p>
					</Panel>
				{/if}

				<Panel title="Served at" icon={ArrowUpRightIcon}>
					<ul class="space-y-2 text-sm">
						{#each deployment.serving as item (item.host)}
							<li class="flex flex-wrap items-center justify-between gap-2">
								<a
									href={item.url}
									target="_blank"
									rel="external noreferrer"
									class="font-mono text-xs hover:underline">{item.host}</a
								>
								<Badge variant={item.isProduction ? 'brand' : 'outline'}
									>{item.environmentName}</Badge
								>
							</li>
						{/each}
						<li class="flex flex-wrap items-center justify-between gap-2">
							<a
								href={deployment.previewUrl}
								target="_blank"
								rel="external noreferrer"
								class="font-mono text-xs hover:underline">{deployment.previewHost}</a
							>
							<Badge variant="neutral">preview</Badge>
						</li>
					</ul>
				</Panel>
			</div>

			<div class="xl:col-span-2">
				<Panel title="Details" icon={InfoIcon}>
					<DetailList>
						<dt>Deployment id</dt>
						<dd><CopyValue value={deployment.id} label="deployment id" /></dd>
						<dt>Message</dt>
						<dd class="truncate text-xs" title={deployment.message ?? ''}>
							{deployment.message ?? '—'}
						</dd>
						<dt>Created by</dt>
						<dd class="truncate text-xs">{creator}</dd>
						<dt>Created</dt>
						<dd class="text-xs">{formatDateTime(deployment.createdAt)}</dd>
						<dt>Last promoted</dt>
						<dd class="text-xs">
							{deployment.promotedAt ? formatDateTime(deployment.promotedAt) : 'Never'}
						</dd>
						{#if deployment.node}
							<dt>Node</dt>
							<dd class="font-mono text-xs">{deployment.node.name}</dd>
						{/if}
						<dt>Bundle</dt>
						<dd>
							<CopyValue
								value={deployment.release.sha256}
								label="bundle digest"
								display={shortSha(deployment.release.sha256, 16)}
							/>
						</dd>
						<dt>Size</dt>
						<dd class="text-xs">
							{formatBytes(deployment.release.sizeBytes)} · {deployment.release.fileCount} files
						</dd>
					</DetailList>
				</Panel>
			</div>
		</div>
	{:else if tab === 'logs'}
		<LogsPanel
			project={data.project}
			deployments={[deployment]}
			builds={[]}
			workloadStatus={data.workload?.status ?? null}
			workloadDeploymentId={data.runningDeploymentId ?? ''}
			canRead={data.can.readLogs}
			bind:source={logSource}
			single
		/>
	{:else}
		<SourcePanel
			slug={data.project.slug}
			deployments={[deployment]}
			productionDeploymentId={data.project.productionDeploymentId}
		/>
	{/if}
</div>
