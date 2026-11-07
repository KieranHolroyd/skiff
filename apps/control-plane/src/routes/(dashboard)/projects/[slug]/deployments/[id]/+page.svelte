<script lang="ts">
	/* Host and range links come from the server load with the current query re-applied. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FileCogIcon from '@lucide/svelte/icons/file-cog';
	import GitCommitIcon from '@lucide/svelte/icons/git-commit-horizontal';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PackageIcon from '@lucide/svelte/icons/package';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ServerIcon from '@lucide/svelte/icons/server';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import EmptyState from '../../../../_lib/EmptyState.svelte';
	import { runtimeIcon } from '../../../../_lib/runtime.js';
	import { formatIdleStop } from '../../../../_lib/function-view.js';
	import Panel from '../../../../_lib/Panel.svelte';
	import RowMenu from '../../../../_lib/RowMenu.svelte';
	import TrafficDashboard from '../../../../_lib/TrafficDashboard.svelte';
	import CopyValue from '../../../../_lib/service/CopyValue.svelte';
	import ServiceHeader from '../../../../_lib/service/ServiceHeader.svelte';
	import StatStrip from '../../../../_lib/service/StatStrip.svelte';
	import { readTab, tabHref, type Stat } from '../../../../_lib/service/sections.js';
	import {
		displayUrl,
		formatBytes,
		formatDateTime,
		formatDuration,
		formatRelative,
		shortId,
		shortSha
	} from '../../../../_lib/format.js';
	import LogsPanel from '../../_components/LogsPanel.svelte';
	import SourcePanel from '../../_components/SourcePanel.svelte';
	import {
		DEPLOYMENT_DEFAULT_TAB,
		DEPLOYMENT_TABS,
		deploymentSubnavKey,
		type DeploymentTab
	} from '../../_components/project-subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TABS = DEPLOYMENT_TABS;
	type Tab = DeploymentTab;
	const DEFAULT_TAB = DEPLOYMENT_DEFAULT_TAB;

	const deployment = $derived(data.deployment);
	const build = $derived(deployment.build);
	const spec = $derived(deployment.spec);
	const running = $derived(data.workload !== null);
	const projectHref = $derived(
		resolve('/(dashboard)/projects/[slug]', { slug: data.project.slug })
	);
	const base = $derived(
		resolve('/(dashboard)/projects/[slug]/deployments/[id]', {
			slug: data.project.slug,
			id: deployment.id
		})
	);
	const act = (name: string) => `${base}?/${name}`;

	// --- sections ------------------------------------------------------------------------------

	let tab = $state<Tab>(readTab(page.url.searchParams.get('tab'), TABS, DEFAULT_TAB));
	let logSource = $state<'runtime' | 'build'>(
		page.url.searchParams.get('logSource') === 'build' ? 'build' : 'runtime'
	);

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: string) {
		tab = readTab(next, TABS, DEFAULT_TAB);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, tab, DEFAULT_TAB), {});
	}

	/** The sidebar lists the deployment's sections; they switch here without a page load. */
	useSubnavLocal(() => ({
		key: deploymentSubnavKey(deployment.id),
		active: tab,
		select: (id) => {
			if (!TABS.includes(id as Tab)) return false;
			setTab(id);
			return true;
		}
	}));

	function openBuildLog() {
		logSource = 'build';
		setTab('logs');
	}

	// --- facts ---------------------------------------------------------------------------------

	const lifetime = $derived(Math.max(0, (Date.now() - Date.parse(deployment.createdAt)) / 1000));
	const buildSeconds = $derived(
		build?.startedAt && build.finishedAt
			? (Date.parse(build.finishedAt) - Date.parse(build.startedAt)) / 1000
			: null
	);
	const creator = $derived(
		deployment.createdBy.name ?? deployment.createdBy.email ?? shortId(deployment.createdBy.id, 12)
	);

	const stats = $derived<Stat[]>([
		{
			label: 'Status',
			value: running ? (data.workload?.status ?? deployment.status) : deployment.status,
			icon: ActivityIcon,
			caption: running
				? 'Running as the project workload'
				: deployment.runtime === 'static'
					? 'Served from the release artifact'
					: data.runningDeploymentId
						? 'Not the running workload'
						: 'No workload running'
		},
		{
			label: 'Release',
			value: formatBytes(deployment.release.sizeBytes),
			icon: PackageIcon,
			caption: `${deployment.release.fileCount.toLocaleString('en-GB')} files${deployment.release.precompressed ? ' · precompressed' : ''}`
		},
		spec
			? {
					label: 'Resources',
					value: `${spec.memoryMb}`,
					unit: `MB · ${spec.cpus} vCPU`,
					icon: CpuIcon,
					caption: spec.replicas > 1 ? `${spec.replicas} replicas` : `${deployment.runtime} runtime`
				}
			: {
					label: 'Runtime',
					value: 'Static',
					icon: GlobeIcon,
					caption: deployment.config.spa ? 'Single-page app fallback' : 'Files served as-is'
				},
		{
			label: 'Age',
			value: formatDuration(lifetime),
			icon: RocketIcon,
			caption: `Created ${formatRelative(deployment.createdAt)} by ${creator}`
		}
	]);

	// --- actions -------------------------------------------------------------------------------

	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success('Copied to the clipboard.');
		} catch {
			toast.error('Could not copy. Select the text and copy it manually.');
		}
	}

	function promote() {
		askConfirm({
			title: `Promote ${deployment.shortId} to production?`,
			description: `${displayUrl(data.project.productionUrl)} will serve this deployment. Code and config move together; you can roll back at any time.`,
			confirmLabel: 'Promote',
			action: act('promote')
		});
	}

	function togglePin() {
		void runAction(act('pin'), { pinned: deployment.pinned ? 'false' : 'true' });
	}

	function remove() {
		askConfirm({
			title: `Delete deployment ${deployment.shortId}?`,
			description:
				'Its preview URL stops working on the next reconcile. The release is garbage-collected once no other deployment uses it.',
			confirmLabel: 'Delete deployment',
			tone: 'danger',
			typeToConfirm: deployment.shortId,
			action: act('delete')
		});
	}
</script>

<svelte:head>
	<title>{deployment.shortId} · {data.project.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<ServiceHeader icon={RocketIcon} title={deployment.shortId} target="page.deployment">
		{#snippet meta()}
			<StatusBadge status={deployment.status} />
			{#if deployment.isProduction}
				<Badge variant="brand">production</Badge>
			{:else}
				<Badge variant="outline" title="Environment: {deployment.environmentSlug}"
					>{deployment.environmentName}</Badge
				>
			{/if}
			{#if running}<Badge variant="success">running</Badge>{/if}
			{#if deployment.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
			<a href={projectHref} class="font-mono text-xs underline-offset-4 hover:underline"
				>{data.project.slug}</a
			>
			<span aria-hidden="true">·</span>
			<span class="text-xs capitalize">{deployment.runtime}</span>
			<span aria-hidden="true">·</span>
			<span class="text-xs"
				>Created <time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time
				></span
			>
		{/snippet}

		<Button
			variant="outline"
			href={deployment.previewUrl}
			target="_blank"
			rel="external noreferrer"
		>
			<ArrowUpRightIcon />Open preview
		</Button>
		{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
			<Button onclick={promote}><ArrowUpIcon />Promote</Button>
		{/if}
		<RowMenu label="More actions for {deployment.shortId}">
			<DropdownMenu.Item onSelect={() => copy(deployment.previewUrl)}>
				<CopyIcon />Copy preview URL
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => copy(deployment.id)}>
				<CopyIcon />Copy deployment id
			</DropdownMenu.Item>
			{#if data.can.promote}
				<DropdownMenu.Item onSelect={togglePin}>
					{#if deployment.pinned}<PinOffIcon />Unpin{:else}<PinIcon />Pin (keep forever){/if}
				</DropdownMenu.Item>
			{/if}
			{#if data.can.delete && !deployment.isProduction}
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onSelect={remove}>
					<TrashIcon />Delete deployment
				</DropdownMenu.Item>
			{/if}
		</RowMenu>
	</ServiceHeader>

	{#if deployment.status === 'failed'}
		<Notice tone="danger" title="This deployment failed">
			{data.workload?.message ??
				build?.error ??
				'It never became active. Check the runtime and build logs for the cause.'}
		</Notice>
	{:else if running && data.workload?.message}
		<Notice tone={data.workload.status === 'failed' ? 'danger' : 'warning'}>
			{data.workload.message}
		</Notice>
	{/if}

	{#if tab === 'overview'}
		<!-- Overview ------------------------------------------------------------------------------ -->
		<StatStrip label="Deployment summary" {stats} />

		<div class="grid items-start gap-5 xl:grid-cols-5">
			<div class="space-y-5 xl:col-span-3">
				<Panel
					title="Served at"
					icon={GlobeIcon}
					description="The preview URL is permanent. Environment hosts follow their pointer and move on promote or rollback."
					flush
				>
					<ul class="divide-y">
						{#each deployment.serving as item (item.host)}
							<li class="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
								<div class="flex min-w-0 items-center gap-2">
									{#if item.isProduction}
										<Badge variant="brand">production</Badge>
									{:else}
										<Badge variant="outline">{item.environmentName}</Badge>
									{/if}
									<a
										href={item.url}
										target="_blank"
										rel="external noreferrer"
										class="inline-flex min-w-0 items-center gap-1 font-mono text-sm underline-offset-4 hover:underline"
									>
										<span class="truncate">{displayUrl(item.url)}</span>
										<ArrowUpRightIcon class="size-3 shrink-0" />
									</a>
								</div>
								<Button variant="ghost" size="sm" onclick={() => copy(item.url)}>
									<CopyIcon />Copy
								</Button>
							</li>
						{/each}
						<li class="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
							<div class="flex min-w-0 items-center gap-2">
								<Badge variant="secondary">preview</Badge>
								<a
									href={deployment.previewUrl}
									target="_blank"
									rel="external noreferrer"
									class="inline-flex min-w-0 items-center gap-1 font-mono text-sm underline-offset-4 hover:underline"
								>
									<span class="truncate">{displayUrl(deployment.previewUrl)}</span>
									<ArrowUpRightIcon class="size-3 shrink-0" />
								</a>
							</div>
							<Button variant="ghost" size="sm" onclick={() => copy(deployment.previewUrl)}>
								<CopyIcon />Copy
							</Button>
						</li>
					</ul>
					{#if deployment.serving.length === 0}
						<p class="border-t px-6 py-3 text-xs text-muted-foreground">
							No environment points at this deployment, so only its preview URL serves it.
						</p>
					{/if}
				</Panel>

				{#if build}
					<Panel
						title="Build"
						icon={HammerIcon}
						description="The git build that produced this release."
					>
						{#snippet actions()}
							<Button variant="outline" size="sm" onclick={openBuildLog}>
								<ScrollTextIcon />Build log
							</Button>
						{/snippet}
						<DetailList>
							<dt>Status</dt>
							<dd><StatusBadge status={build.status} /></dd>
							<dt>Ref</dt>
							<dd class="font-mono text-xs">{build.ref}</dd>
							<dt>Commit</dt>
							<dd class="font-mono text-xs">
								{#if build.commitSha}
									<span class="inline-flex items-center gap-1" title={build.commitSha}>
										<GitCommitIcon class="size-3.5 text-muted-foreground" />{shortSha(
											build.commitSha
										)}
									</span>
								{:else}—{/if}
							</dd>
							{#if build.commitMessage}
								<dt>Message</dt>
								<dd class="truncate text-xs" title={build.commitMessage}>{build.commitMessage}</dd>
							{/if}
							<dt>Duration</dt>
							<dd class="text-xs tabular-nums">
								{buildSeconds !== null ? formatDuration(buildSeconds) : '—'}
							</dd>
							<dt>Finished</dt>
							<dd class="text-xs">{build.finishedAt ? formatDateTime(build.finishedAt) : '—'}</dd>
						</DetailList>
						{#if build.error}
							<p
								class="mt-3 rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive"
							>
								{build.error}
							</p>
						{/if}
					</Panel>
				{/if}

				{#if spec}
					<Panel
						title="Runtime spec"
						icon={runtimeIcon(deployment.runtime)}
						description="Snapshot taken at deploy time. Promote or roll back restores this spec with the code."
					>
						<DetailList>
							{#if spec.function}
								{@const fn = spec.function}
								<dt>Entry module</dt>
								<dd class="truncate font-mono text-xs" title={fn.main}>
									{fn.main}
									<span class="text-muted-foreground">· {fn.moduleCount} modules</span>
								</dd>
								<dt>Compatibility</dt>
								<dd class="font-mono text-xs">
									{fn.compatibilityDate}{fn.compatibilityFlags.length
										? ` · ${fn.compatibilityFlags.join(', ')}`
										: ''}
								</dd>
								<dt>Bindings</dt>
								<dd
									class="truncate font-mono text-xs"
									title={fn.bindings.map((b) => b.name).join(', ')}
								>
									{fn.bindings.length ? fn.bindings.map((b) => b.name).join(', ') : 'none'}
								</dd>
								<dt>Idle stop</dt>
								<dd class="text-xs">{formatIdleStop(fn.idleStopSeconds)}</dd>
								<dt>workerd</dt>
								<dd class="font-mono text-xs">{fn.workerdVersion}</dd>
							{/if}
							{#if spec.image}
								<dt>Image</dt>
								<dd><CopyValue value={spec.image} label="image" /></dd>
							{/if}
							{#if spec.command}
								<dt>Command</dt>
								<dd class="truncate font-mono text-xs" title={spec.command.join(' ')}>
									{spec.command.join(' ')}
								</dd>
							{/if}
							{#if !spec.function}
								<dt>Ingress</dt>
								<dd class="text-xs">
									{#if spec.ingress === 'none'}Worker (no route){:else}HTTP on port
										<span class="font-mono">{spec.port}</span>{/if}
								</dd>
							{/if}
							{#if spec.ingress !== 'none' && !spec.function}
								<dt>Health check</dt>
								<dd class="font-mono text-xs">{spec.healthPath}</dd>
							{/if}
							<dt>Memory</dt>
							<dd class="text-xs tabular-nums">
								{spec.memoryMb} MB{spec.replicas > 1 ? ' per replica' : ''}
							</dd>
							<dt>CPU</dt>
							<dd class="text-xs tabular-nums">{spec.cpus} vCPU</dd>
							<dt>Replicas</dt>
							<dd class="text-xs tabular-nums">{spec.replicas}</dd>
						</DetailList>
					</Panel>
				{/if}
			</div>

			<div class="space-y-5 xl:col-span-2">
				<Panel title="Details" icon={InfoIcon}>
					<DetailList>
						<dt>Deployment id</dt>
						<dd><CopyValue value={deployment.id} label="deployment id" /></dd>
						<dt>Environment</dt>
						<dd class="text-xs">
							{deployment.environmentName}
							<span class="font-mono text-muted-foreground">{deployment.environmentSlug}</span>
						</dd>
						<dt>Created by</dt>
						<dd
							class="truncate text-xs"
							title={deployment.createdBy.email ?? deployment.createdBy.id}
						>
							{creator}
						</dd>
						<dt>Created</dt>
						<dd class="text-xs">{formatDateTime(deployment.createdAt)}</dd>
						<dt>Activated</dt>
						<dd class="text-xs">
							{deployment.activatedAt ? formatDateTime(deployment.activatedAt) : '—'}
						</dd>
						<dt>Last promoted</dt>
						<dd class="text-xs">
							{deployment.promotedAt ? formatDateTime(deployment.promotedAt) : 'Never'}
						</dd>
						{#if deployment.node}
							<dt>Node</dt>
							<dd class="inline-flex items-center justify-end gap-1 font-mono text-xs">
								<ServerIcon class="size-3.5 text-muted-foreground" />{deployment.node.name}
							</dd>
						{/if}
						<dt>Release</dt>
						<dd>
							<CopyValue
								value={deployment.release.sha256}
								label="release digest"
								display={shortSha(deployment.release.sha256, 16)}
							/>
						</dd>
						{#if deployment.message}
							<dt>Message</dt>
							<dd class="text-xs whitespace-pre-wrap">{deployment.message}</dd>
						{/if}
					</DetailList>
				</Panel>

				<Panel
					title="Configuration"
					icon={FileCogIcon}
					description="Captured with the release. Values are never shown here."
				>
					<DetailList>
						<dt>Variables</dt>
						<dd class="text-xs tabular-nums">{deployment.config.envNames.length}</dd>
						<dt>Secrets</dt>
						<dd class="text-xs tabular-nums">{deployment.config.secretNames.length}</dd>
						<dt>Redirects</dt>
						<dd class="text-xs tabular-nums">{deployment.config.redirects}</dd>
						<dt>Header rules</dt>
						<dd class="text-xs tabular-nums">{deployment.config.headerRules}</dd>
						<dt>SPA fallback</dt>
						<dd class="text-xs">{deployment.config.spa ? 'On' : 'Off'}</dd>
						<dt>Clean URLs</dt>
						<dd class="text-xs">{deployment.config.cleanUrls ? 'On' : 'Off'}</dd>
					</DetailList>
					{#if deployment.config.envNames.length > 0 || deployment.config.secretNames.length > 0}
						<div class="mt-3 flex flex-wrap gap-1.5">
							{#each deployment.config.envNames as name (name)}
								<Badge variant="outline" class="font-mono text-[11px]">{name}</Badge>
							{/each}
							{#each deployment.config.secretNames as name (name)}
								<Badge variant="secondary" class="font-mono text-[11px]" title="Secret reference"
									>{name}</Badge
								>
							{/each}
						</div>
					{/if}
				</Panel>
			</div>
		</div>
	{:else if tab === 'metrics'}
		<!-- Metrics ------------------------------------------------------------------------------- -->
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-sm text-muted-foreground">Host</span>
			<div
				class="flex flex-wrap items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5"
				role="group"
				aria-label="Traffic host"
			>
				{#each data.hosts as option (option.host)}
					<Button
						href={data.hostLinks[option.host]}
						variant={option.host === data.host ? 'secondary' : 'ghost'}
						size="sm"
						class="h-7 px-2.5 text-xs"
						aria-current={option.host === data.host ? 'true' : undefined}
						data-sveltekit-noscroll
						title={option.host}
					>
						{option.label}
					</Button>
				{/each}
			</div>
			<span class="truncate font-mono text-xs text-muted-foreground">{data.host}</span>
		</div>
		{#if data.hosts.length > 1 && data.host !== deployment.previewHost}
			<p class="text-xs text-muted-foreground">
				Environment hosts serve whichever deployment their pointer names, so this range can include
				traffic from before {deployment.shortId} was promoted. Custom domains are not included.
			</p>
		{/if}
		{#if data.traffic}
			<TrafficDashboard
				traffic={data.traffic}
				range={data.range}
				ranges={data.ranges}
				links={data.rangeLinks}
			/>
		{:else}
			<EmptyState
				icon={ActivityIcon}
				title="Traffic could not be loaded"
				description="The telemetry store did not answer. The deployment itself is unaffected; try again in a moment."
			/>
		{/if}
	{:else if tab === 'logs'}
		<!-- Logs ---------------------------------------------------------------------------------- -->
		<LogsPanel
			project={data.project}
			deployments={[deployment]}
			builds={build ? [build] : []}
			workloadStatus={data.workload?.status ?? null}
			workloadDeploymentId={data.runningDeploymentId ?? ''}
			canRead={data.can.readLogs}
			bind:source={logSource}
			single
		/>
	{:else if tab === 'files'}
		<!-- Files --------------------------------------------------------------------------------- -->
		<SourcePanel
			slug={data.project.slug}
			deployments={[deployment]}
			productionDeploymentId={deployment.id}
		/>
	{/if}
</div>
