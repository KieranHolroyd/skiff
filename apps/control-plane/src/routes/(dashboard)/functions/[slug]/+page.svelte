<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import InfoIcon from '@lucide/svelte/icons/info';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import AccessChip from '../../_lib/AccessChip.svelte';
	import AccessSelect from '../../_lib/AccessSelect.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import TrafficDashboard from '../../_lib/TrafficDashboard.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import { readTab } from '../../_lib/service/sections.js';
	import {
		displayUrl,
		formatBytes,
		formatDateTime,
		formatRelative,
		shortId,
		shortSha
	} from '../../_lib/format.js';
	import {
		deployCommands,
		formatIdleStop,
		functionStatus,
		statefulBindings
	} from '../../_lib/function-view.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import type { Stat } from '../../_lib/service/sections.js';
	import DatabasesCard from '../../projects/[slug]/_components/DatabasesCard.svelte';
	import StorageCard from '../../projects/[slug]/_components/StorageCard.svelte';
	import { compactCount, formatRate } from '../_lib/function-metrics.js';
	import FunctionInvocations from '../_lib/FunctionInvocations.svelte';
	import { invocationErrorRate } from '../_lib/invocations.js';
	import DomainsPanel from '../../projects/[slug]/_components/DomainsPanel.svelte';
	import LogsPanel from '../../projects/[slug]/_components/LogsPanel.svelte';
	import FunctionDataCard from '../_lib/FunctionDataCard.svelte';
	import FunctionHeader from '../_lib/FunctionHeader.svelte';
	import FunctionPanel from '../_lib/FunctionPanel.svelte';
	import FunctionQuickstart from '../_lib/FunctionQuickstart.svelte';
	import FunctionVariablesPanel from '../_lib/FunctionVariablesPanel.svelte';
	import { FUNCTION_DEFAULT_TAB, FUNCTION_TABS, type FunctionTab } from '../_lib/function-tabs.js';
	import type { PageProps } from './$types';

	interface FormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as FormResult | null);

	const fn = $derived(data.project);
	/** Set by Create function when the attached bundle failed validation. */
	const rejected = $derived(page.url.searchParams.get('rejected'));
	const view = $derived(data.view);
	let tab = $state<FunctionTab>(
		readTab(page.url.searchParams.get('tab'), FUNCTION_TABS, FUNCTION_DEFAULT_TAB)
	);

	function setTab(next: FunctionTab) {
		tab = next;
		const url = new URL(page.url.href);
		if (next === FUNCTION_DEFAULT_TAB) url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		void goto(url, { shallow: true, replace: true });
	}

	const production = $derived(data.deployments.find((d) => d.id === fn.productionDeploymentId));
	const running = $derived(
		data.workload ? data.deployments.find((d) => d.id === data.workload?.deploymentId) : undefined
	);
	const node = $derived(
		data.workload?.nodeId
			? data.capacity.find((item) => item.nodeId === data.workload?.nodeId)
			: undefined
	);
	const nodeLabel = $derived(
		node?.name ?? (data.workload?.nodeId ? shortId(data.workload.nodeId, 12) : null)
	);
	const counts = $derived<Partial<Record<FunctionTab, number>>>({
		deployments: data.deployments.length,
		bindings: view?.bindings.length,
		domains: data.domains.length
	});
	const hostStatus = $derived(functionStatus(data.workload, view));
	const pinnedBy = $derived(statefulBindings(view));
	const replicas = $derived(data.spec?.replicas ?? data.workload?.replicas ?? 1);
	const invocationStats = $derived.by<Stat[]>(() => {
		const summary = data.invocationSummary.summary;
		const exceptions = summary.byOutcome.exception ?? 0;
		const rate = invocationErrorRate(summary.byOutcome);
		return [
			{
				label: 'Invocations · 24h',
				value: compactCount(summary.total),
				icon: ActivityIcon,
				caption: data.invocationSummary.available
					? 'Requests, cron runs and queue batches'
					: 'Telemetry unavailable'
			},
			{
				label: 'Failed',
				value: formatRate(rate),
				caption: `${compactCount(summary.total - (summary.byOutcome.ok ?? 0))} not ok`
			},
			{
				label: 'Exceptions',
				value: compactCount(exceptions),
				caption: exceptions > 0 ? 'See Invocations for stack and logs' : 'None in 24 hours'
			},
			{
				label: 'Host',
				value: hostStatus.label,
				icon: LayersIcon,
				caption:
					replicas > 1
						? `${replicas} replicas, load-balanced`
						: pinnedBy.length > 0
							? 'One host: stateful bindings'
							: 'One host'
			}
		];
	});
	/** Follows the saved count; typing overrides it until the next save reloads the data. */
	let replicaInput = $derived(String(replicas));
	const deploymentHref = (id: string) =>
		resolve('/(dashboard)/functions/[slug]/deployments/[id]', { slug: fn.slug, id });

	// --- deploy ----------------------------------------------------------------------------------
	let deployOpen = $state(false);
	let deployPromote = $state(true);

	// --- logs ------------------------------------------------------------------------------------
	let logSource = $state<'runtime' | 'build'>('runtime');
	let logBuildId = $state('');
	let logDeploymentId = $state('');

	function tailLogs(deploymentId = '') {
		logSource = 'runtime';
		logDeploymentId = deploymentId;
		setTab('logs');
	}

	// --- deployment actions ----------------------------------------------------------------------
	function promote(deployment: { id: string; shortId: string }) {
		askConfirm({
			title: `Promote ${deployment.shortId} to production?`,
			description: `${displayUrl(fn.productionUrl)} starts serving this deployment. The previous one stays available for rollback.`,
			confirmLabel: 'Promote',
			action: '?/promote',
			fields: { deploymentId: deployment.id }
		});
	}

	function rollback() {
		askConfirm({
			title: 'Roll back production?',
			description:
				'Production moves to the previous deployment, restoring its code, bindings and compatibility date together.',
			confirmLabel: 'Roll back',
			tone: 'danger',
			action: '?/rollback'
		});
	}

	function deleteDeployment(deployment: { id: string; shortId: string }) {
		askConfirm({
			title: `Delete deployment ${deployment.shortId}?`,
			description: 'Its preview URL stops working and the release can no longer be promoted.',
			confirmLabel: 'Delete deployment',
			tone: 'danger',
			action: '?/deleteDeployment',
			fields: { deploymentId: deployment.id }
		});
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	// --- settings --------------------------------------------------------------------------------
	let editOpen = $state(false);
	let editName = $state('');
	let editSlug = $state('');
	let editPlacement = $state('auto');
	const placementChoices = $derived.by(() => {
		const options = [
			{ value: 'auto', label: 'Auto — most free slice budget' },
			{ value: 'edge', label: 'Edge node' },
			...data.capacity.map((item) => ({ value: item.nodeId, label: `${item.name} (${item.mode})` }))
		];
		return options.some((option) => option.value === fn.placement)
			? options
			: [...options, { value: fn.placement, label: fn.placement }];
	});

	function openEdit() {
		editName = fn.name;
		editSlug = fn.slug;
		editPlacement = fn.placement;
		editOpen = true;
	}

	let accessOpen = $state(false);
	let accessScope = $state<'production' | 'previews'>('production');
	let accessMode = $state('public');
	function openAccess(scope: 'production' | 'previews') {
		accessScope = scope;
		accessMode = scope === 'production' ? fn.productionAccess : fn.previewAccess;
		accessOpen = true;
	}

	function deleteFunction() {
		askConfirm({
			title: `Delete ${fn.name}?`,
			description: `The function moves to the trash and is kept for ${data.policies.trashDays} days. ${displayUrl(fn.productionUrl)} and every preview stop serving, and its host is stopped.`,
			confirmLabel: 'Delete function',
			tone: 'danger',
			typeToConfirm: fn.slug,
			action: '?/delete'
		});
	}
</script>

<svelte:head>
	<title>{fn.name} · Functions · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<FunctionHeader slug={fn.slug} active={tab} {counts} onselect={setTab}>
		{#snippet meta()}
			<span class="text-foreground">{fn.name}</span>
			<span aria-hidden="true">·</span>
			<StatusBadge status={hostStatus.status} label={hostStatus.label} tone={hostStatus.tone} />
			<a
				href={fn.productionUrl}
				target="_blank"
				rel="external noreferrer"
				class="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground hover:underline"
				>{displayUrl(fn.productionUrl)}<ArrowUpRightIcon class="size-3" /></a
			>
			{#if view}
				<span aria-hidden="true">·</span>
				<span class="font-mono text-xs">workerd {view.workerdVersion}</span>
			{/if}
		{/snippet}
		{#if data.can.rollback && fn.productionDeploymentId}
			<Button variant="outline" onclick={rollback}><RotateCcwIcon />Roll back</Button>
		{/if}
		{#if data.can.deploy}
			<Button onclick={() => (deployOpen = true)}><RocketIcon />Deploy</Button>
		{/if}
	</FunctionHeader>

	{#if tab === 'overview'}
		{#if !view && data.deployments.length === 0}
			<FunctionQuickstart slug={fn.slug} />
		{:else}
			<div class="mb-5">
				<StatStrip stats={invocationStats} label="Invocations summary" />
			</div>
			<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<div class="min-w-0 space-y-5">
					{#if data.traffic}
						<TrafficDashboard
							traffic={data.traffic}
							range={data.trafficRange}
							ranges={data.trafficRanges}
							links={data.trafficLinks}
							variant="project"
						/>
					{:else}
						<Card.Root>
							<Card.Content class="text-sm text-muted-foreground">
								Request metrics are not available right now. They come from the edge's access logs
								once telemetry is on.
							</Card.Content>
						</Card.Root>
					{/if}
				</div>

				<div class="space-y-5">
					<Card.Root class="gap-0 py-0">
						<Card.Header class="border-b py-4">
							<Card.Title class="flex items-center gap-2">
								<RocketIcon class="size-4 text-muted-foreground" />
								Production
							</Card.Title>
						</Card.Header>
						<Card.Content class="py-4">
							{#if production}
								<div class="flex flex-wrap items-center gap-2">
									<a
										href={deploymentHref(production.id)}
										class="font-mono text-lg font-semibold tracking-tight hover:underline"
										>{production.shortId}</a
									>
									<StatusBadge status={production.status} />
								</div>
								<p class="mt-1 text-xs text-muted-foreground">
									{#if production.message}{production.message} ·
									{/if}deployed
									<time datetime={production.createdAt} title={formatDateTime(production.createdAt)}
										>{formatRelative(production.createdAt)}</time
									>
								</p>
								{#if running && running.id !== production.id}
									<p class="mt-2 text-xs text-warning">
										The host runs {running.shortId}, the latest deployment. Every preview and
										environment host proxies to it.
									</p>
								{/if}
							{:else}
								<p class="text-sm text-muted-foreground">
									Nothing promoted yet. Promote a deployment to serve it at
									{displayUrl(fn.productionUrl)}.
								</p>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root class="gap-0 py-0">
						<Card.Header class="border-b py-4">
							<Card.Title class="flex items-center gap-2">
								<ZapIcon class="size-4 text-muted-foreground" />
								Configuration
							</Card.Title>
							<Card.Action class="self-center">
								<Button variant="ghost" size="sm" onclick={() => setTab('bindings')}>Details</Button
								>
							</Card.Action>
						</Card.Header>
						<Card.Content class="py-2">
							{#if view}
								<DetailList>
									<dt>Compatibility</dt>
									<dd class="font-mono text-xs">{view.compatibilityDate}</dd>
									<dt>Bindings</dt>
									<dd class="text-sm">
										<button
											type="button"
											class="font-mono text-xs hover:underline"
											onclick={() => setTab('bindings')}>{view.bindings.length}</button
										>
									</dd>
									<dt>Cron triggers</dt>
									<dd class="font-mono text-xs">{view.triggers.crons.length}</dd>
									<dt>Static assets</dt>
									<dd class="font-mono text-xs">
										{view.assets ? `${view.assets.directory}/` : 'none'}
									</dd>
									<dt>Idle stop</dt>
									<dd class="text-xs">{formatIdleStop(view.idleStopSeconds)}</dd>
									<dt>Memory / CPU</dt>
									<dd class="font-mono text-xs">
										{data.workload?.memoryMb ?? data.spec?.memoryMb ?? '—'} MB · {data.workload
											?.cpus ??
											data.spec?.cpus ??
											'—'} vCPU
									</dd>
									<dt>Node</dt>
									<dd class="font-mono text-xs">{nodeLabel ?? '—'}</dd>
								</DetailList>
							{:else}
								<p class="py-2 text-sm text-muted-foreground">
									The latest deployment has not been resolved yet.
								</p>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root class="gap-0 py-0">
						<Card.Header class="border-b py-4">
							<Card.Title>Recent deployments</Card.Title>
							<Card.Action class="self-center">
								<Button variant="ghost" size="sm" onclick={() => setTab('deployments')}
									>View all</Button
								>
							</Card.Action>
						</Card.Header>
						<Card.Content class="divide-y px-0 py-0">
							{#each data.deployments.slice(0, 5) as deployment (deployment.id)}
								<a
									href={deploymentHref(deployment.id)}
									class="flex items-center justify-between gap-3 px-6 py-2.5 hover:bg-muted/40"
								>
									<span class="flex min-w-0 items-center gap-2">
										<span class="font-mono text-sm">{deployment.shortId}</span>
										{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
									</span>
									<time
										class="shrink-0 text-xs text-muted-foreground"
										datetime={deployment.createdAt}>{formatRelative(deployment.createdAt)}</time
									>
								</a>
							{:else}
								<p class="px-6 py-3 text-sm text-muted-foreground">No deployments yet.</p>
							{/each}
						</Card.Content>
					</Card.Root>
				</div>
			</div>
		{/if}
	{:else if tab === 'invocations'}
		<FunctionInvocations invocations={data.invocations} canRead={data.can.readLogs} />
	{:else if tab === 'deployments'}
		{#if rejected}
			<Notice tone="danger" title="The bundle was not deployed">
				{rejected} Fix it and deploy again; the function itself was created.
			</Notice>
		{/if}
		{#if data.deployments.length === 0}
			<EmptyState
				icon={RocketIcon}
				title="No deployments yet"
				description="Run skif deploy in the Wrangler project, or upload a bundle built in CI. Every deploy gets an immutable preview URL."
			>
				{#if data.can.deploy}
					<Button onclick={() => (deployOpen = true)}><RocketIcon />Deploy</Button>
				{/if}
			</EmptyState>
		{:else}
			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">Deployment</Table.Head>
							<Table.Head class="hidden md:table-cell">Bundle</Table.Head>
							<Table.Head class="hidden lg:table-cell">Created</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.deployments as deployment (deployment.id)}
							<Table.Row class={deployment.isProduction ? 'bg-brand/5 hover:bg-brand/5' : ''}>
								<Table.Cell class="pl-4 whitespace-normal">
									<div class="flex flex-wrap items-center gap-1.5">
										<a
											href={deploymentHref(deployment.id)}
											class="font-mono text-sm font-medium underline-offset-4 hover:underline"
											>{deployment.shortId}</a
										>
										<StatusBadge status={deployment.status} />
										{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
										{#if data.workload?.deploymentId === deployment.id}
											<Badge variant="outline">on the host</Badge>
										{/if}
										{#if deployment.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
									</div>
									<a
										href={deployment.previewUrl}
										target="_blank"
										rel="external noreferrer"
										class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
									>
										{displayUrl(deployment.previewUrl)}
										<ArrowUpRightIcon class="size-3 shrink-0" />
									</a>
									{#if deployment.message}
										<p
											class="max-w-xl truncate text-xs text-muted-foreground"
											title={deployment.message}
										>
											{deployment.message}
										</p>
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground md:table-cell">
									<span title={deployment.release.sha256}
										>{shortSha(deployment.release.sha256)}</span
									>
									<p class="text-xs opacity-80">{formatBytes(deployment.release.sizeBytes)}</p>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
									<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time
									>
								</Table.Cell>
								<Table.Cell class="pr-4">
									<div class="flex items-center justify-end gap-1">
										{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
											<Button variant="outline" size="sm" onclick={() => promote(deployment)}>
												<ArrowUpIcon />Promote
											</Button>
										{/if}
										<RowMenu label="Actions for {deployment.shortId}">
											<DropdownMenu.Item onSelect={() => goto(deploymentHref(deployment.id))}>
												<InfoIcon />View details
											</DropdownMenu.Item>
											<DropdownMenu.Item onSelect={() => tailLogs(deployment.id)}>
												<ScrollTextIcon />Tail logs
											</DropdownMenu.Item>
											<DropdownMenu.Item
												onSelect={() => window.open(deployment.previewUrl, '_blank', 'noreferrer')}
											>
												<ArrowUpRightIcon />Open preview
											</DropdownMenu.Item>
											<DropdownMenu.Item onSelect={() => copy(deployment.previewUrl)}>
												<CopyIcon />Copy preview URL
											</DropdownMenu.Item>
											{#if data.can.promote}
												<DropdownMenu.Item
													onSelect={() =>
														runAction('?/pin', {
															deploymentId: deployment.id,
															pinned: deployment.pinned ? 'false' : 'true'
														})}
												>
													{#if deployment.pinned}<PinOffIcon />Unpin{:else}<PinIcon />Pin (keep
														forever){/if}
												</DropdownMenu.Item>
											{/if}
											{#if data.can.deleteDeployment}
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													variant="destructive"
													onSelect={() => deleteDeployment(deployment)}
												>
													<TrashIcon />Delete deployment
												</DropdownMenu.Item>
											{/if}
										</RowMenu>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
			<p class="text-xs text-muted-foreground">
				The latest deployment is what the host runs; promote moves the production pointer, and
				rollback restores code, bindings and compatibility date together.
			</p>
		{/if}
	{:else if tab === 'bindings'}
		<div class="space-y-5">
			<FunctionPanel
				project={fn}
				{view}
				spec={data.spec}
				workload={data.workload}
				capacity={data.capacity}
				cronNext={data.cronNext}
				can={{ manageWorkload: data.can.update, viewCapacity: data.can.viewCapacity }}
			/>
		</div>
	{:else if tab === 'data'}
		<div class="space-y-5">
			<FunctionDataCard
				databaseAttachments={data.databaseAttachments}
				storageAttachments={data.storageAttachments}
			/>
			<DatabasesCard
				slug={fn.slug}
				attachments={data.databaseAttachments}
				databases={data.attachableDatabases}
				warning={(form as { databaseWarning?: string } | null)?.databaseWarning ?? null}
				fieldErrors={result?.fieldErrors}
				can={{
					readDatabases: data.can.readDatabases,
					createDatabase: data.can.createDatabase,
					attachDatabase: data.can.attachDatabase
				}}
			/>
			<StorageCard
				slug={fn.slug}
				attachments={data.storageAttachments}
				instances={data.attachableStorage}
				bucketsByStorage={data.storageBuckets}
				warning={(form as { storageWarning?: string } | null)?.storageWarning ?? null}
				fieldErrors={result?.fieldErrors}
				can={{
					readStorage: data.can.readStorage,
					createStorage: data.can.createStorage,
					attachStorage: data.can.attachStorage
				}}
			/>
		</div>
	{:else if tab === 'variables'}
		<FunctionVariablesPanel
			project={fn}
			{view}
			secrets={data.secrets}
			fieldErrors={result?.fieldErrors}
			can={{ createSecret: data.can.createSecret, deleteSecret: data.can.deleteSecret }}
		/>
	{:else if tab === 'logs'}
		<LogsPanel
			bind:source={logSource}
			bind:buildId={logBuildId}
			bind:deploymentId={logDeploymentId}
			project={fn}
			deployments={data.deployments}
			builds={[]}
			workloadStatus={data.workload?.status ?? null}
			workloadDeploymentId={data.workload?.deploymentId ?? ''}
			canRead={data.can.readLogs}
		/>
	{:else if tab === 'domains'}
		<DomainsPanel
			project={fn}
			domains={data.domains}
			contentDomain={data.contentDomain}
			platformOrigin={data.platform.origin}
			can={{ createDomain: data.can.createDomain, deleteDomain: data.can.deleteDomain }}
		/>
	{:else if tab === 'settings'}
		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>General</Card.Title>
					<Card.Description>Name, address and where the host is placed.</Card.Description>
					{#if data.can.update}
						<Card.Action class="self-center">
							<Button variant="outline" size="sm" onclick={openEdit}><PencilIcon />Edit</Button>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content>
					<DetailList>
						<dt>Name</dt>
						<dd class="text-sm">{fn.name}</dd>
						<dt>Address</dt>
						<dd class="font-mono text-xs">{fn.slug}.{data.contentDomain}</dd>
						<dt>Placement</dt>
						<dd class="font-mono text-xs">{fn.placement}</dd>
						<dt>Node</dt>
						<dd class="font-mono text-xs">{nodeLabel ?? 'not placed yet'}</dd>
						<dt>Created</dt>
						<dd class="text-sm">
							<time datetime={fn.createdAt}>{formatDateTime(fn.createdAt)}</time>
						</dd>
						<dt>Function ID</dt>
						<dd class="flex items-center justify-end gap-1">
							<span class="truncate font-mono text-xs" title={fn.id}>{shortId(fn.id, 14)}</span>
							<CopyButton value={fn.id} label="Copy function ID" iconOnly />
						</dd>
					</DetailList>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<ShieldIcon class="size-4 text-muted-foreground" />Access
					</Card.Title>
					<Card.Description>Production and previews are protected separately.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-2">
					{#each [{ scope: 'production' as const, label: 'Production', mode: fn.productionAccess, hint: displayUrl(fn.productionUrl) }, { scope: 'previews' as const, label: 'Previews', mode: fn.previewAccess, hint: `${fn.slug}--<id>.${data.contentDomain}` }] as row (row.scope)}
						<div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
							<div class="min-w-0">
								<p class="text-sm font-medium">{row.label}</p>
								<p class="truncate font-mono text-xs text-muted-foreground">{row.hint}</p>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<AccessChip mode={row.mode} />
								{#if data.can.update}
									<Button variant="outline" size="sm" onclick={() => openAccess(row.scope)}
										>Change</Button
									>
								{/if}
							</div>
						</div>
					{/each}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<LayersIcon class="size-4 text-muted-foreground" />Scaling
					</Card.Title>
					<Card.Description>
						Replicas run on the function's node behind one route; each has its own socket.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if pinnedBy.length > 0}
						<p class="text-sm">
							<span class="font-mono">1</span> host.
							<span class="text-muted-foreground"
								>{pinnedBy.map((binding) => binding.name).join(', ')}
								{pinnedBy.length === 1 ? 'keeps' : 'keep'} state on the node, so this function cannot
								scale out until workerd cluster mode lands.</span
							>
						</p>
					{:else if !view}
						<p class="text-sm text-muted-foreground">Deploy once, then choose a replica count.</p>
					{:else if data.can.update}
						<form
							method="POST"
							action="?/setReplicas"
							class="flex flex-wrap items-end gap-2"
							onsubmit={(event) => {
								event.preventDefault();
								void runAction('?/setReplicas', { replicas: replicaInput });
							}}
						>
							<Field.Field class="w-28">
								<Field.Label for="fn-replicas">Replicas</Field.Label>
								<Input
									id="fn-replicas"
									name="replicas"
									type="number"
									min="1"
									max={data.maxReplicas}
									bind:value={replicaInput}
									class="font-mono"
								/>
							</Field.Field>
							<Button type="submit" variant="outline" disabled={Number(replicaInput) === replicas}
								>Save</Button
							>
						</form>
						<p class="text-xs text-muted-foreground">
							Currently <span class="font-mono">{replicas}</span>. Each replica reserves
							{data.spec?.memoryMb ?? 128} MB; idle replicas still scale to zero.
						</p>
					{:else}
						<p class="text-sm">
							<span class="font-mono">{replicas}</span>
							{replicas === 1 ? 'replica' : 'replicas'}
						</p>
					{/if}
				</Card.Content>
			</Card.Root>

			{#if data.can.delete}
				<div class="xl:col-span-2">
					<DangerZone>
						{#snippet description()}
							Deleting moves the function to the trash for {data.policies.trashDays} days. Its URL, previews
							and custom domains stop serving immediately and its host is stopped.
						{/snippet}
						<Button variant="destructive" onclick={deleteFunction}
							><TrashIcon />Delete function</Button
						>
					</DangerZone>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if data.can.deploy}
	<FormDialog
		bind:open={deployOpen}
		icon={UploadIcon}
		title="Deploy {fn.name}"
		description="From the Wrangler project, skif deploy bundles and uploads for you. Upload here a Worker built elsewhere, such as in CI."
		action="?/deploy"
		submitLabel="Deploy"
		onsuccess={() => setTab('deployments')}
	>
		<CodeBlock label="terminal" code={deployCommands(fn.slug)} />
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.artifact ? true : undefined}>
				<Field.Label for="fn-artifact">Or upload a bundle (.zip)</Field.Label>
				<Input
					id="fn-artifact"
					name="artifact"
					type="file"
					accept=".zip,application/zip"
					required
				/>
				<Field.Description>
					A built Worker: <code class="font-mono">index.js</code> or
					<code class="font-mono">worker.js</code> at the root, plus a
					<code class="font-mono">public/</code> directory for assets. Without a
					<code class="font-mono">skiff-function.json</code> the previous deployment's bindings are kept;
					a first upload binds this function's secrets and nothing else.
				</Field.Description>
				{#if result?.fieldErrors?.artifact}<Field.Error>{result.fieldErrors.artifact}</Field.Error
					>{/if}
			</Field.Field>
			<input type="hidden" name="environment" value="production" />
			<Field.Field>
				<Field.Label for="fn-message"
					>Message <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input id="fn-message" name="message" maxlength={500} placeholder="What changed" />
			</Field.Field>
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="fn-promote" name="promote" value="true" bind:checked={deployPromote} />
				<Field.Label for="fn-promote" class="font-normal">
					Promote to production when the upload succeeds
				</Field.Label>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.can.update}
	<FormDialog
		bind:open={editOpen}
		icon={PencilIcon}
		title="Edit function"
		description="A new slug changes the function's address; custom domains follow it."
		action="?/update"
		submitLabel="Save"
	>
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
				<Field.Label for="fn-name">Name</Field.Label>
				<Input id="fn-name" name="name" bind:value={editName} maxlength={120} required />
				{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={result?.fieldErrors?.slug ? true : undefined}>
				<Field.Label for="fn-slug">Slug</Field.Label>
				<Input id="fn-slug" name="slug" bind:value={editSlug} class="font-mono text-sm" />
				<Field.Description>{editSlug || fn.slug}.{data.contentDomain}</Field.Description>
				{#if result?.fieldErrors?.slug}<Field.Error>{result.fieldErrors.slug}</Field.Error>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="fn-placement">Placement</Field.Label>
				<NativeSelect.Root
					id="fn-placement"
					name="placement"
					bind:value={editPlacement}
					class="w-full"
				>
					{#each placementChoices as option (option.value)}
						<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description
					>Applied at the next deploy. Moving a running host is a separate step.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={accessOpen}
		icon={ShieldIcon}
		title={accessScope === 'production' ? 'Production access' : 'Preview access'}
		description="Who may call this function's URLs. Protected URLs never receive platform session cookies."
		action="?/setAccess"
		submitLabel="Save access"
	>
		<input type="hidden" name="scope" value={accessScope} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="fn-access">Mode</Field.Label>
				<AccessSelect
					id="fn-access"
					name="mode"
					bind:value={accessMode}
					invalid={Boolean(result?.fieldErrors?.mode)}
				/>
			</Field.Field>
			{#if accessMode === 'password'}
				<Field.Field data-invalid={result?.fieldErrors?.password ? true : undefined}>
					<Field.Label for="fn-access-password">Password</Field.Label>
					<Input
						id="fn-access-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required
					/>
					{#if result?.fieldErrors?.password}<Field.Error>{result.fieldErrors.password}</Field.Error
						>{/if}
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}
