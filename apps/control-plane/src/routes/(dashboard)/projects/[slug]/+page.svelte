<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import BoxIcon from '@lucide/svelte/icons/box';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import InfoIcon from '@lucide/svelte/icons/info';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import AccessChip from '../../_lib/AccessChip.svelte';
	import AccessSelect from '../../_lib/AccessSelect.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import ProjectMark from '../../_lib/ProjectMark.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import TrafficDashboard from '../../_lib/TrafficDashboard.svelte';
	import BuildsPanel from './_components/BuildsPanel.svelte';
	import ContainerFiles from './_components/ContainerFiles.svelte';
	import ContainerPanel from './_components/ContainerPanel.svelte';
	import ContainerShell from './_components/ContainerShell.svelte';
	import DatabasesCard from './_components/DatabasesCard.svelte';
	import DomainsPanel from './_components/DomainsPanel.svelte';
	import EnvironmentsPanel from './_components/EnvironmentsPanel.svelte';
	import LogsPanel from './_components/LogsPanel.svelte';
	import JobsPanel from './_components/JobsPanel.svelte';
	import {
		PROJECT_TABS,
		readProjectTab,
		shareState,
		type ProjectTab
	} from './_components/project-nav.js';
	import { projectSubnavKey } from './_components/project-subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import RuntimePanel from './_components/RuntimePanel.svelte';
	import VariablesPanel from './_components/VariablesPanel.svelte';
	import SourcePanel from './_components/SourcePanel.svelte';
	import StorageCard from './_components/StorageCard.svelte';
	import VolumesCard from './_components/VolumesCard.svelte';
	import WorkerCard from './_components/WorkerCard.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortId, shortSha } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		success?: string;
		suggestions?: string[];
		fieldErrors?: Record<string, string>;
		shareUrl?: string;
		shareHost?: string;
		databaseWarning?: string | null;
		storageWarning?: string | null;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	type Deployment = (typeof data.deployments)[number];

	/** Follows `?tab=` on navigation (back/forward, plain links); `setTab` overrides it in place. */
	let tab = $derived<ProjectTab>(readProjectTab(page.url.searchParams.get('tab')));
	let logSource = $state<'runtime' | 'build'>(
		page.url.searchParams.get('logSource') === 'build' ? 'build' : 'runtime'
	);
	let logBuildId = $state(page.url.searchParams.get('build') ?? '');
	let logDeploymentId = $state(page.url.searchParams.get('deployment') ?? '');

	// Container console (D127): one replica choice shared by Overview, Shell and Files.
	let containerReplica = $state<number | null>(null);
	let filesPath = $state(page.url.searchParams.get('path') ?? '/');
	let filesKey = $state(0);
	function openContainer(next: 'shell' | 'files' | 'logs', path?: string) {
		if (next === 'files' && path) {
			filesPath = path;
			filesKey += 1;
		}
		if (next === 'logs') logSource = 'runtime';
		setTab(next);
	}

	// Deploy dialog
	let deployOpen = $state(false);
	let deployEnvironment = $state('production');
	let deployPromote = $state(true);

	// Share-link dialog
	let shareOpen = $state(false);
	let shareDeploymentId = $state('');
	let expiresAtIso = $state('');
	let shareSecretOpen = $state(false);
	const nowLocal = $derived(
		new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
	);

	// Access dialog
	let accessOpen = $state(false);
	let accessScope = $state<'production' | 'previews'>('production');
	let accessMode = $state('public');
	let accessPolicyId = $state('');
	/** Re-saving password mode on a scope that already has a password may leave the field blank. */
	const accessKeepsPassword = $derived(
		accessScope === 'production'
			? data.project.productionAccess === 'password' && data.project.productionPasswordSet
			: data.project.previewAccess === 'password' && data.project.previewPasswordSet
	);

	// Project details dialog
	let projectOpen = $state(false);
	let projectName = $state('');
	let projectSlug = $state('');
	let placement = $state('edge');
	let placementSpecText = $state('');

	// Move a running app to another node (D97). Node choices come from capacity (platform admins).
	let moveOpen = $state(false);
	let moveNode = $state('');
	const workloadNode = $derived(
		data.workload?.nodeId
			? (data.capacity.find((item) => item.nodeId === data.workload?.nodeId)?.name ??
					data.workload.nodeId)
			: null
	);
	const moveTargets = $derived(
		data.workload?.nodeId
			? data.capacity.filter(
					(item) => item.nodeId !== data.workload?.nodeId && item.status === 'online'
				)
			: []
	);

	const placementOptions = $derived([
		{ value: 'edge', label: 'Edge node' },
		{ value: 'auto', label: 'Auto — most free slice budget' },
		...data.capacity
			.filter((item) => item.mode !== 'edge')
			.map((item) => ({ value: item.nodeId, label: `${item.name} (${item.mode})` }))
	]);
	const placementChoices = $derived(
		placementOptions.some((option) => option.value === data.project.placement)
			? placementOptions
			: [...placementOptions, { value: data.project.placement, label: data.project.placement }]
	);

	$effect(() => {
		if (result?.shareUrl) shareSecretOpen = true;
	});

	const activeDeployments = $derived(data.deployments.filter((d) => d.status === 'active'));
	const production = $derived(
		data.deployments.find((d) => d.id === data.project.productionDeploymentId)
	);
	const runningDeployment = $derived(
		data.workload ? data.deployments.find((d) => d.id === data.workload?.deploymentId) : undefined
	);
	const runningAppDrift = $derived(
		data.project.runtime !== 'static' &&
			runningDeployment !== undefined &&
			runningDeployment.id !== data.project.productionDeploymentId
	);
	/** Switch sections in place, keeping `?tab=` deep-linkable. */
	function setTab(next: ProjectTab) {
		tab = next;
		if (page.url.searchParams.get('tab') === next) return;
		const url = new URL(page.url.href);
		url.searchParams.set('tab', next);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		void goto(url, { shallow: true, replace: true });
	}

	/** The sidebar lists the project's sections; they switch here without waiting on a load. */
	useSubnavLocal(() => ({
		key: projectSubnavKey(data.project.slug),
		active: tab,
		select: (id) => {
			if (!PROJECT_TABS.includes(id as ProjectTab)) return false;
			setTab(id as ProjectTab);
			return true;
		}
	}));

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	function openDeploy() {
		deployEnvironment = 'production';
		deployPromote = true;
		deployOpen = true;
	}

	function openShare(deploymentId = '') {
		shareDeploymentId = deploymentId;
		expiresAtIso = '';
		shareOpen = true;
	}

	function openAccess(scope: 'production' | 'previews') {
		accessScope = scope;
		accessMode =
			scope === 'production' ? data.project.productionAccess : data.project.previewAccess;
		accessPolicyId =
			(scope === 'production'
				? data.project.productionAccessPolicyId
				: data.project.previewAccessPolicyId) ?? '';
		accessOpen = true;
	}

	function openProject() {
		projectName = data.project.name;
		projectSlug = data.project.slug;
		placement = data.project.placement;
		placementSpecText = data.project.placementSpec
			? JSON.stringify(data.project.placementSpec, null, 2)
			: '';
		projectOpen = true;
	}

	function openBuildLog(id: string) {
		logSource = 'build';
		logBuildId = id;
		setTab('logs');
	}

	function openDeploymentLog(id: string) {
		logSource = 'runtime';
		logDeploymentId = id;
		setTab('logs');
	}

	function promote(deployment: Deployment) {
		askConfirm({
			title: `Promote ${deployment.shortId} to production?`,
			description: `${displayUrl(data.project.productionUrl)} will serve this deployment. Code and config move together; you can roll back at any time.`,
			confirmLabel: 'Promote',
			action: '?/promote',
			fields: { deploymentId: deployment.id }
		});
	}

	function rollback() {
		askConfirm({
			title: 'Roll back production?',
			description:
				'Production moves back to the previous deployment. Code and config both move; nothing is deleted.',
			confirmLabel: 'Roll back',
			action: '?/rollback'
		});
	}

	function deleteDeployment(deployment: Deployment) {
		askConfirm({
			title: `Delete deployment ${deployment.shortId}?`,
			description: 'Its preview URL stops working on the next reconcile. This cannot be undone.',
			confirmLabel: 'Delete deployment',
			tone: 'danger',
			action: '?/deleteDeployment',
			fields: { deploymentId: deployment.id }
		});
	}

	function revokeSiteSession(id: string) {
		askConfirm({
			title: 'End this visitor session?',
			description:
				'The visitor loses access within seconds. The share link keeps working, so revoke the link too if they should not come back.',
			confirmLabel: 'End session',
			tone: 'danger',
			action: '?/revokeSiteSession',
			fields: { sessionId: id }
		});
	}

	function signOutVisitors() {
		askConfirm({
			title: `Sign out every visitor of ${data.project.name}?`,
			description:
				'Password, platform and share-link sessions end on production, previews and every environment within seconds. Visitors have to sign in again; share links keep working.',
			confirmLabel: 'Sign out everyone',
			tone: 'danger',
			action: '?/signOutVisitors'
		});
	}

	function revokeShare(id: string) {
		askConfirm({
			title: 'Revoke this share link?',
			description: 'Anyone using it loses access, including sessions it already started.',
			confirmLabel: 'Revoke link',
			tone: 'danger',
			action: '?/revokeShare',
			fields: { shareId: id }
		});
	}

	function deleteProject() {
		askConfirm({
			title: `Delete ${data.project.name}?`,
			description: `The project moves to the trash and is kept for ${data.policies.trashDays} days. ${displayUrl(data.project.productionUrl)} and every preview stop serving.`,
			confirmLabel: 'Delete project',
			tone: 'danger',
			typeToConfirm: data.project.slug,
			action: `${resolve('/(dashboard)/projects')}?/delete`,
			fields: { slug: data.project.slug },
			apply: false,
			onResult: async (outcome) => {
				if (outcome.type === 'success') await goto(resolve('/(dashboard)/projects'));
			}
		});
	}
</script>

<svelte:head>
	<title>{data.project.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Project" title={data.project.name} target="page.project">
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2">
				<a
					href={data.project.productionUrl}
					target="_blank"
					rel="external noreferrer"
					class="inline-flex items-center gap-1 font-mono text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					{displayUrl(data.project.productionUrl)}
					<ArrowUpRightIcon class="size-3.5" />
				</a>
				<AccessChip scope="Prod" mode={data.project.productionAccess} />
				<AccessChip scope="Preview" mode={data.project.previewAccess} />
				<Badge variant="secondary" class="capitalize">{data.project.runtime}</Badge>
				<Badge variant="outline" class="font-mono text-xs">{data.project.placement}</Badge>
			</div>
		{/snippet}
		{#if data.can.createDeployment}
			<Button onclick={openDeploy} data-skiff-target="project.deploy">
				<UploadIcon />
				Deploy
			</Button>
		{/if}
		<Button href={data.project.productionUrl} target="_blank" rel="external noreferrer">
			<ArrowUpRightIcon />
			Visit site
		</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="icon" aria-label="More project actions">
						<EllipsisIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				<DropdownMenu.Item onSelect={() => copy(data.project.productionUrl)}>
					<CopyIcon />Copy production URL
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => copy(data.project.id)}>
					<CopyIcon />Copy project ID
				</DropdownMenu.Item>
				{#if data.can.createShare}
					<DropdownMenu.Item onSelect={() => openShare()}>
						<LinkIcon />Create share link
					</DropdownMenu.Item>
				{/if}
				{#if data.can.update}
					<DropdownMenu.Item onSelect={() => openAccess('production')}>
						<KeyRoundIcon />Change access
					</DropdownMenu.Item>
				{/if}
				{#if data.can.deleteProject}
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={deleteProject}>
						<TrashIcon />Delete project
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</PageHeader>

	<Card.Root class="relative overflow-hidden py-0">
		<div class="absolute inset-y-0 left-0 w-1 bg-brand" aria-hidden="true"></div>
		<Card.Content class="flex flex-wrap items-center gap-x-5 gap-y-4 py-5 pl-7">
			<div class="hidden sm:block">
				<ProjectMark slug={data.project.slug} name={data.project.name} size="lg" />
			</div>
			<div class="min-w-0 flex-1 basis-64 space-y-1">
				<p class="flex items-center gap-1.5 text-xs font-medium text-brand">
					<RadioTowerIcon class="size-3" />
					Live in production
				</p>
				{#if production}
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-mono text-lg font-semibold tracking-tight">{production.shortId}</span>
						<StatusBadge status={production.status} />
						{#if production.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
					</div>
					<p class="truncate text-sm text-muted-foreground">
						{#if production.message}{production.message} ·
						{/if}<span class="font-mono text-xs">{shortSha(production.release.sha256)}</span>
						· {formatBytes(production.release.sizeBytes)} · deployed
						<time datetime={production.createdAt}>{formatDateTime(production.createdAt)}</time>
					</p>
				{:else}
					<p class="text-lg font-semibold tracking-tight">Nothing in production yet</p>
					<p class="text-sm text-muted-foreground">
						Promote a deployment to serve it at {displayUrl(data.project.productionUrl)}.
					</p>
				{/if}
				{#if data.project.runtime !== 'static'}
					{#if runningAppDrift && runningDeployment}
						<p class="flex items-start gap-1.5 text-xs text-warning">
							<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
							<span>
								Only the latest deployment is active. The running app is
								<span class="font-mono">{runningDeployment.shortId}</span>
								({runningDeployment.environmentName}), not the production pointer above. Every
								environment host and preview URL proxies to it.
							</span>
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							Process and container apps run only the latest deployment; every environment host and
							preview URL proxies to it.
						</p>
					{/if}
				{/if}
			</div>
			{#if data.can.rollback && data.project.productionDeploymentId}
				<Button variant="outline" onclick={rollback}>
					<RotateCcwIcon />
					Roll back
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="min-w-0">
		{#if (tab === 'container' || tab === 'shell' || tab === 'files') && data.project.runtime !== 'container'}
			<EmptyState
				icon={BoxIcon}
				title="Only container projects have a console"
				description="Inspect, file browsing and shells are for projects with runtime “container”. This project runs as {data.project.runtime}."
			/>
		{:else if tab === 'container'}
			{#if data.can.inspectContainer}
				<ContainerPanel
					slug={data.project.slug}
					cpus={data.workload?.cpus ?? null}
					bind:replica={containerReplica}
					can={{
						restart: data.can.restartContainer,
						files: data.can.containerFiles,
						exec: data.can.containerExec
					}}
					onOpen={openContainer}
				/>
			{:else}
				<EmptyState icon={BoxIcon} title="No access" description="Inspecting containers needs the container:inspect permission." />
			{/if}
		{:else if tab === 'shell'}
			{#if data.can.containerExec}
				<ContainerShell slug={data.project.slug} bind:replica={containerReplica} />
			{:else}
				<EmptyState
					icon={SquareTerminalIcon}
					title="No access"
					description="Opening a shell needs the container:exec permission and a signed-in person (API keys and MCP clients cannot)."
				/>
			{/if}
		{:else if tab === 'files'}
			{#if data.can.containerFiles}
				{#key filesKey}
					<ContainerFiles slug={data.project.slug} bind:replica={containerReplica} initialPath={filesPath} />
				{/key}
			{:else}
				<EmptyState icon={FolderTreeIcon} title="No access" description="Browsing container files needs the container:files permission." />
			{/if}
		{:else if tab === 'traffic'}
			<TrafficDashboard
				traffic={data.traffic}
				range={data.trafficRange}
				ranges={data.trafficRanges}
				links={data.trafficLinks}
				variant="project"
			/>
		{:else if tab === 'environments'}
			<EnvironmentsPanel
				environments={data.environments}
				deployments={data.deployments}
				platformOrigin={data.platform.origin}
				previewAccess={data.project.previewAccess}
				productionAccess={data.project.productionAccess}
				accessPolicies={data.accessPolicies}
				runtime={data.project.runtime}
				can={{
					manageEnvironments: data.can.manageEnvironments,
					promoteEnvironment: data.can.promoteEnvironment,
					rollbackEnvironment: data.can.rollbackEnvironment
				}}
			/>
		{:else if tab === 'source'}
			{#if data.deployments.length === 0}
				<EmptyState
					icon={FolderTreeIcon}
					title="Nothing to browse yet"
					description="The source viewer reads the immutable release artifact behind a deployment. Deploy a build and its files will appear here."
				/>
			{:else}
				<SourcePanel
					slug={data.project.slug}
					deployments={data.deployments}
					productionDeploymentId={data.project.productionDeploymentId}
				/>
			{/if}
		{:else if tab === 'builds'}
			<BuildsPanel
				project={data.project}
				gitSource={data.gitSource}
				builds={data.builds}
				platformOrigin={data.platform.origin}
				can={{ createBuild: data.can.createBuild, cancelBuild: data.can.cancelBuild }}
				onOpenLog={openBuildLog}
				onBuildQueued={() => {
					logSource = 'build';
					logBuildId = '';
					setTab('logs');
				}}
			/>
		{:else if tab === 'logs'}
			<LogsPanel
				bind:source={logSource}
				bind:buildId={logBuildId}
				bind:deploymentId={logDeploymentId}
				project={data.project}
				deployments={data.deployments}
				builds={data.builds}
				workloadStatus={data.workload?.status ?? null}
				workloadDeploymentId={data.workload?.deploymentId ?? ''}
				canRead={data.can.readLogs}
			/>
		{:else if tab === 'domains'}
			<DomainsPanel
				project={data.project}
				domains={data.domains}
				contentDomain={data.contentDomain}
				platformOrigin={data.platform.origin}
				can={{ createDomain: data.can.createDomain, deleteDomain: data.can.deleteDomain }}
			/>
		{:else if tab === 'data'}
			<div class="space-y-5">
				{#if data.project.runtime === 'static'}
					<EmptyState
						icon={DatabaseIcon}
						title="Static sites have no data services"
						description="Databases, object storage and volumes attach to a running process or container. A static site is served as files, so there is nothing to attach them to."
					/>
				{:else}
					<DatabasesCard
						slug={data.project.slug}
						attachments={data.databaseAttachments}
						databases={data.attachableDatabases}
						warning={result?.databaseWarning ?? null}
						fieldErrors={result?.fieldErrors}
						can={{
							readDatabases: data.can.readDatabases,
							createDatabase: data.can.createDatabase,
							attachDatabase: data.can.attachDatabase
						}}
					/>
					<StorageCard
						slug={data.project.slug}
						attachments={data.storageAttachments}
						instances={data.attachableStorage}
						bucketsByStorage={data.storageBuckets}
						warning={result?.storageWarning ?? null}
						fieldErrors={result?.fieldErrors}
						can={{
							readStorage: data.can.readStorage,
							createStorage: data.can.createStorage,
							attachStorage: data.can.attachStorage
						}}
					/>
					<VolumesCard
						slug={data.project.slug}
						volumes={data.appVolumes}
						storage={data.appVolumeStorage}
						workloadId={data.workload?.id ?? data.project.slug}
						enabled={data.appVolumesEnabled}
						fieldErrors={result?.fieldErrors}
						can={{ manageVolumes: data.can.manageVolumes }}
					/>
				{/if}
			</div>
		{:else if tab === 'variables'}
			<VariablesPanel
				project={data.project}
				spec={data.workloadSpec}
				workload={data.workload}
				secrets={data.secrets}
				databaseAttachments={data.databaseAttachments}
				storageAttachments={data.storageAttachments}
				attachableDatabases={data.attachableDatabases}
				attachableStorage={data.attachableStorage}
				canAttachDatabase={data.can.attachDatabase}
				canAttachStorage={data.can.attachStorage}
				can={{
					edit: data.can.manageWorkload,
					createSecret: data.can.createSecret,
					updateSecret: data.can.updateSecret,
					deleteSecret: data.can.deleteSecret
				}}
			/>
		{:else if tab === 'jobs'}
			{#if !data.jobsEnabled}
				<EmptyState
					icon={ClockIcon}
					title="Jobs are not enabled"
					description="A platform admin turns jobs on with SKIFF_FEATURE_JOBS=1."
				/>
			{:else if data.project.runtime === 'static'}
				<EmptyState
					icon={ClockIcon}
					title="Jobs run on apps"
					description="A job is a command run in a process or container app's sandbox, on a schedule or by hand. A static site has no process to run it in."
				/>
			{:else}
				<JobsPanel
					slug={data.project.slug}
					deployed={Boolean(data.workload)}
					can={{
						manage: data.can.update && data.can.createDeployment,
						run: data.can.createDeployment,
						readLogs: data.can.readLogs
					}}
				/>
			{/if}
		{:else if tab === 'runtime'}
			{#if data.project.runtime !== 'static' && data.workloadSpec}
				<div class="mb-5">
					<WorkerCard
						spec={data.workloadSpec}
						workload={data.workload}
						pool={data.runnerPool}
						canManage={data.can.manageWorkload}
					/>
				</div>
			{/if}
			<RuntimePanel
				project={data.project}
				spec={data.workloadSpec}
				workload={data.workload}
				capacity={data.capacity}
				registryImages={data.registryImages}
				can={{
					manageWorkload: data.can.manageWorkload,
					viewCapacity: data.can.viewCapacity
				}}
			/>
		{:else if tab === 'deployments'}
			{#if data.deployments.length === 0}
				<EmptyState
					icon={RocketIcon}
					title="No deployments yet"
					description="Deploy a built .zip from this page, or use the CLI, MCP clients or the REST API. Every deploy gets an immutable preview URL."
				>
					<code class="rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs"
						><span class="text-muted-foreground select-none">$ </span>skif deploy ./dist --project {data
							.project.slug}</code
					>
				</EmptyState>
			{:else}
				<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-4">Deployment</Table.Head>
								<Table.Head class="hidden md:table-cell">Release</Table.Head>
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
												href={resolve('/(dashboard)/projects/[slug]/deployments/[id]', {
													slug: data.project.slug,
													id: deployment.id
												})}
												class="font-mono text-sm font-medium underline-offset-4 hover:underline"
												>{deployment.shortId}</a
											>
											<StatusBadge status={deployment.status} />
											{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
											{#if !deployment.isProduction}
												<Badge variant="outline" class="font-mono text-xs"
													>{deployment.environmentSlug}</Badge
												>
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
										<p class="text-xs opacity-80">
											{formatBytes(deployment.release.sizeBytes)}
										</p>
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
										<time datetime={deployment.createdAt}
											>{formatDateTime(deployment.createdAt)}</time
										>
									</Table.Cell>
									<Table.Cell class="pr-4">
										<div class="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Tail runtime logs for {deployment.shortId}"
												onclick={() => openDeploymentLog(deployment.id)}
											>
												<ScrollTextIcon />
											</Button>
											{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
												<Button variant="outline" size="sm" onclick={() => promote(deployment)}>
													<ArrowUpIcon />Promote
												</Button>
											{/if}
											<RowMenu label="Actions for {deployment.shortId}">
												<DropdownMenu.Item
													onSelect={() =>
														goto(
															resolve('/(dashboard)/projects/[slug]/deployments/[id]', {
																slug: data.project.slug,
																id: deployment.id
															})
														)}
												>
													<InfoIcon />View details
												</DropdownMenu.Item>
												<DropdownMenu.Item onSelect={() => openDeploymentLog(deployment.id)}>
													<ScrollTextIcon />Tail logs
												</DropdownMenu.Item>
												<DropdownMenu.Item
													onSelect={() =>
														window.open(deployment.previewUrl, '_blank', 'noreferrer')}
												>
													<ArrowUpRightIcon />Open preview
												</DropdownMenu.Item>
												<DropdownMenu.Item onSelect={() => copy(deployment.previewUrl)}>
													<CopyIcon />Copy preview URL
												</DropdownMenu.Item>
												{#if data.can.createShare}
													<DropdownMenu.Item onSelect={() => openShare(deployment.id)}>
														<LinkIcon />Share this deployment
													</DropdownMenu.Item>
												{/if}
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
				<p class="mt-3 text-xs text-muted-foreground">
					{activeDeployments.length} active · the last 10 unpinned deployments are retained.
				</p>
			{/if}
		{:else if tab === 'shares'}
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>Share links</Card.Title>
					<Card.Description>
						Time- and usage-limited access to protected sites. A visit is a redemption, not a page
						load.
					</Card.Description>
					{#if data.can.createShare}
						<Card.Action class="self-center">
							<Button onclick={() => openShare()}><PlusIcon />Create link</Button>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content class="px-0">
					{#if data.shareLinks.length === 0}
						<div class="p-4">
							<EmptyState
								icon={LinkIcon}
								compact
								title="No share links"
								description="Create a link when someone outside the org needs temporary access to a protected site."
							/>
						</div>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Link</Table.Head>
									<Table.Head class="hidden sm:table-cell">Redemptions</Table.Head>
									<Table.Head class="hidden md:table-cell">Expires</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each data.shareLinks as link (link.id)}
									{@const state = shareState(link)}
									<Table.Row class={state === 'active' ? '' : 'text-muted-foreground'}>
										<Table.Cell class="pl-4">
											<p class="font-mono text-sm">{link.host}</p>
											{#if link.note}<p class="text-xs text-muted-foreground">{link.note}</p>{/if}
										</Table.Cell>
										<Table.Cell class="hidden font-mono text-xs tabular-nums sm:table-cell">
											{link.redemptions}{link.maxRedemptions !== null
												? ` / ${link.maxRedemptions}`
												: ''}
										</Table.Cell>
										<Table.Cell class="hidden text-xs md:table-cell">
											{#if link.expiresAt}
												<time datetime={link.expiresAt}>{formatDateTime(link.expiresAt)}</time>
											{:else}
												Never
											{/if}
										</Table.Cell>
										<Table.Cell><StatusBadge status={state} /></Table.Cell>
										<Table.Cell class="pr-4">
											{#if data.can.revokeShare && !link.revokedAt}
												<Button
													variant="ghost-danger"
													size="sm"
													onclick={() => revokeShare(link.id)}
												>
													Revoke
												</Button>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
				<Card.Footer class="py-3 text-xs text-muted-foreground">
					Sessions last one hour by default. Revocation reaches agents in seconds.
				</Card.Footer>
			</Card.Root>
		{:else if tab === 'access'}
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2"><ShieldCheckIcon class="size-4" />Skiff Access</Card.Title>
					<Card.Description>
						An identity-aware proxy in front of every host: a policy decides who gets in, and the
						app receives <code class="font-mono text-xs">Skiff-Access-Email</code> and a signed JWT.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<Item.Group class="gap-2">
						{#each [{ label: 'Production', mode: data.project.productionAccess, policyId: data.project.productionAccessPolicyId }, { label: 'Previews', mode: data.project.previewAccess, policyId: data.project.previewAccessPolicyId }] as row (row.label)}
							<Item.Root variant="outline">
								<Item.Content>
									<Item.Title>{row.label}</Item.Title>
									<Item.Description>
										{#if row.mode === 'access'}
											{data.accessPolicies.find((policy) => policy.id === row.policyId)?.name ?? row.policyId}
										{:else}
											Not using Skiff Access.
										{/if}
									</Item.Description>
								</Item.Content>
								<Item.Actions><AccessChip mode={row.mode} /></Item.Actions>
							</Item.Root>
						{/each}
					</Item.Group>
					{#if data.accessPolicies.length === 0}
						<EmptyState
							icon={ShieldCheckIcon}
							title="No policies for this project"
							description="Create a policy under Settings → Access policies, then assign it to production, previews or a named environment."
						/>
					{/if}
				</Card.Content>
				<Card.Footer class="py-3">
					<Button variant="outline" size="sm" href="/settings/access-policies?project={data.project.slug}">
						Manage access policies<ArrowUpRightIcon class="size-3.5" />
					</Button>
				</Card.Footer>
			</Card.Root>
		{:else if tab === 'settings'}
			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Card.Root class="xl:col-span-2">
					<Card.Header>
						<Card.Title>Project</Card.Title>
						<Card.Description>Name, address and where the project is placed.</Card.Description>
						{#if data.can.update}
							<Card.Action class="self-center">
								<Button variant="outline" size="sm" onclick={openProject}
									><PencilIcon />Edit project</Button
								>
							</Card.Action>
						{/if}
					</Card.Header>
					<Card.Content>
						<DetailList>
							<dt>Name</dt>
							<dd class="text-sm">{data.project.name}</dd>
							<dt>Address</dt>
							<dd class="font-mono text-xs">{data.project.slug}.{data.contentDomain}</dd>
							<dt>Runtime</dt>
							<dd class="capitalize">{data.project.runtime}</dd>
							<dt>Placement</dt>
							<dd class="font-mono text-sm">{data.project.placement}</dd>
							<dt>Environments</dt>
							<dd class="font-mono text-sm">{data.environments.length}</dd>
							<dt>Custom domains</dt>
							<dd class="font-mono text-sm">{data.domains.length}</dd>
						</DetailList>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Access</Card.Title>
						<Card.Description>Production and previews are protected separately.</Card.Description>
					</Card.Header>
					<Card.Content>
						<Item.Group class="gap-2">
							{#each [{ scope: 'production', label: 'Production', mode: data.project.productionAccess, hint: displayUrl(data.project.productionUrl) }, { scope: 'previews', label: 'Previews', mode: data.project.previewAccess, hint: `${data.project.slug}--<id>.${data.contentDomain}` }] as row (row.scope)}
								<Item.Root variant="outline">
									<Item.Content>
										<Item.Title>{row.label}</Item.Title>
										<Item.Description class="font-mono text-xs">{row.hint}</Item.Description>
									</Item.Content>
									<Item.Actions>
										<AccessChip mode={row.mode} />
										{#if data.can.update}
											<Button
												variant="outline"
												size="sm"
												onclick={() => openAccess(row.scope as 'production' | 'previews')}
												>Change</Button
											>
										{/if}
									</Item.Actions>
								</Item.Root>
							{/each}
						</Item.Group>
						<div class="mt-4 space-y-2">
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0">
									<p class="text-sm font-medium">Visitor sessions</p>
									<p class="text-xs text-muted-foreground">
										{data.siteSessions.length === 0
											? 'No live share-link sessions.'
											: `${data.siteSessions.length} live share-link ${data.siteSessions.length === 1 ? 'session' : 'sessions'}.`}
										Password and platform sign-ins are not listed.
									</p>
								</div>
								{#if data.can.update}
									<Button variant="outline" size="sm" onclick={signOutVisitors}
										>Sign out everyone</Button
									>
								{/if}
							</div>
							{#if data.siteSessions.length > 0}
								<ul class="divide-y rounded-lg border">
									{#each data.siteSessions.slice(0, 20) as session (session.id)}
										<li class="flex items-center justify-between gap-3 px-3 py-2">
											<div class="min-w-0">
												<p class="truncate text-sm">
													{session.email ?? session.note ?? 'Share-link visitor'}
												</p>
												<p class="truncate font-mono text-xs text-muted-foreground">
													{session.host} · until
													<time datetime={session.expiresAt}>{formatDateTime(session.expiresAt)}</time>
												</p>
											</div>
											{#if data.can.revokeShare}
												<Button
													variant="ghost-danger"
													size="sm"
													onclick={() => revokeSiteSession(session.id)}>End</Button
												>
											{/if}
										</li>
									{/each}
								</ul>
								{#if data.siteSessions.length > 20}
									<p class="text-xs text-muted-foreground">
										Showing the 20 newest. Sign out everyone to end them all.
									</p>
								{/if}
							{/if}
						</div>
					</Card.Content>
					<Card.Footer class="text-xs text-muted-foreground">
						Protected sites set <code class="mx-1 font-mono">X-Robots-Tag: noindex</code> and never receive
						platform session cookies.
					</Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Details</Card.Title>
						{#if data.can.update && data.project.runtime !== 'static' && moveTargets.length > 0}
							<Card.Action>
								<Button
									variant="outline"
									size="sm"
									onclick={() => {
										moveNode = moveTargets[0]?.nodeId ?? '';
										moveOpen = true;
									}}><ArrowLeftRightIcon />Move</Button
								>
							</Card.Action>
						{/if}
					</Card.Header>
					<Card.Content>
						<DetailList>
							<dt>Production</dt>
							<dd class="font-mono text-sm">{production?.shortId ?? 'not deployed'}</dd>
							<dt>Runtime</dt>
							<dd class="capitalize">{data.project.runtime}</dd>
							<dt>Placement</dt>
							<dd class="font-mono text-sm">{data.project.placement}</dd>
							<dt>Workload</dt>
							<dd class="text-sm">
								{#if data.workload}
									<span class="capitalize">{data.workload.status}</span>
									<span class="text-muted-foreground">
										· {data.workload.memoryMb} MB · {data.workload.cpus} vCPU{workloadNode
											? ` · on ${workloadNode}`
											: ''}</span
									>
								{:else}
									<span class="text-muted-foreground">not running</span>
								{/if}
							</dd>
							<dt>Created</dt>
							<dd class="text-sm">
								<time datetime={data.project.createdAt}
									>{formatDateTime(data.project.createdAt)}</time
								>
							</dd>
							<dt>Project ID</dt>
							<dd class="flex items-center justify-end gap-1">
								<span class="truncate font-mono text-xs" title={data.project.id}
									>{shortId(data.project.id, 14)}</span
								>
								<CopyButton value={data.project.id} label="Copy project ID" iconOnly />
							</dd>
						</DetailList>
					</Card.Content>
				</Card.Root>

				{#if data.can.deleteProject}
					<Card.Root class="border-destructive/30 xl:col-span-2">
						<Card.Header>
							<Card.Title class="text-destructive">Danger zone</Card.Title>
							<Card.Description>
								Deleting moves the project to the trash for {data.policies.trashDays} days. Its production
								site and every preview stop serving immediately.
							</Card.Description>
							<Card.Action class="self-center">
								<Button variant="destructive" onclick={deleteProject}
									><TrashIcon />Delete project</Button
								>
							</Card.Action>
						</Card.Header>
					</Card.Root>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if data.can.createDeployment}
	<FormDialog
		bind:open={deployOpen}
		icon={UploadIcon}
		title="Deploy a zip"
		description="Upload an already-built static site or app. Every deploy gets an immutable preview URL; promote moves production."
		action="?/deploy"
		submitLabel="Deploy"
		onsuccess={() => setTab('deployments')}
	>
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.artifact ? true : undefined}>
				<Field.Label for="deploy-artifact">Artifact (.zip)</Field.Label>
				<Input
					id="deploy-artifact"
					name="artifact"
					type="file"
					accept=".zip,application/zip"
					required
				/>
				<Field.Description>
					Zip the <strong class="font-medium text-foreground">contents</strong> of your build output
					directory, not the folder itself — for example
					<code class="font-mono">cd dist &amp;&amp; zip -r ../site.zip .</code>. Limits: 500 MB
					archive, 20,000 files, 25 MB per file. For a repository, a git build is the alternative.
				</Field.Description>
				{#if result?.fieldErrors?.artifact}<Field.Error>{result.fieldErrors.artifact}</Field.Error
					>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="deploy-environment">Environment</Field.Label>
				<NativeSelect.Root
					id="deploy-environment"
					name="environment"
					bind:value={deployEnvironment}
					class="w-full"
				>
					{#if data.environments.length === 0}
						<NativeSelect.Option value="production">Production</NativeSelect.Option>
					{:else}
						{#each data.environments as environment (environment.id)}
							<NativeSelect.Option value={environment.slug}
								>{environment.name} ({environment.slug})</NativeSelect.Option
							>
						{/each}
					{/if}
				</NativeSelect.Root>
				<Field.Description>
					{#if data.project.runtime === 'static'}
						Production moves the live site when promoted; other environments update only their own
						host.
					{:else}
						Process and container apps run one workload, so only the latest deployment is active:
						deploying to any environment restarts the app on this release, whether or not you
						promote it.
					{/if}
				</Field.Description>
			</Field.Field>
			<Field.Field data-invalid={result?.fieldErrors?.message ? true : undefined}>
				<Field.Label for="deploy-message"
					>Message <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input
					id="deploy-message"
					name="message"
					maxlength={500}
					placeholder="Release notes or a commit summary"
				/>
				{#if result?.fieldErrors?.message}<Field.Error>{result.fieldErrors.message}</Field.Error
					>{/if}
			</Field.Field>
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="deploy-promote" name="promote" value="true" bind:checked={deployPromote} />
				<Field.Label for="deploy-promote" class="font-normal">
					Promote to the selected environment when the upload succeeds
				</Field.Label>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.can.createShare}
	<FormDialog
		bind:open={shareOpen}
		icon={LinkIcon}
		title="Create share link"
		description="Grant someone outside the org temporary access to a protected site."
		action="?/createShare"
		submitLabel="Create link"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="share-deployment">Deployment</Field.Label>
				<NativeSelect.Root
					id="share-deployment"
					name="deploymentId"
					bind:value={shareDeploymentId}
					class="w-full"
				>
					<NativeSelect.Option value="">Production site</NativeSelect.Option>
					{#each data.deployments as deployment (deployment.id)}
						<NativeSelect.Option value={deployment.id}
							>{deployment.shortId}{deployment.isProduction
								? ' (production)'
								: ''}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-expires">
						Expires <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="share-expires"
						name="expiresAtLocal"
						type="datetime-local"
						min={nowLocal}
						oninput={(event) => {
							const value = event.currentTarget.value;
							expiresAtIso = value ? new Date(value).toISOString() : '';
						}}
					/>
					<input type="hidden" name="expiresAt" value={expiresAtIso} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-max">
						Max visits <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="share-max"
						name="maxRedemptions"
						type="number"
						min="1"
						step="1"
						placeholder="Unlimited"
					/>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="share-note"
					>Note <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input id="share-note" name="note" maxlength={500} placeholder="Design review with Alex" />
				<Field.Description
					>Only shown to your org, to remember who the link is for.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if result?.shareUrl}
	<SecretDialog
		bind:open={shareSecretOpen}
		title="Share link ready"
		description="Anyone with this link can open {result.shareHost} within the limits you set."
		value={result.shareUrl}
	/>
{/if}

{#if data.can.update}
	<FormDialog
		bind:open={accessOpen}
		icon={KeyRoundIcon}
		title="Change {accessScope === 'production' ? 'production' : 'preview'} access"
		description="Agents converge within seconds of saving."
		action="?/setAccess"
		submitLabel="Save access"
	>
		<input type="hidden" name="scope" value={accessScope} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="access-mode">Who can view</Field.Label>
				<AccessSelect id="access-mode" name="mode" bind:value={accessMode} />
			</Field.Field>
			{#if accessMode === 'access'}
				<Field.Field data-invalid={result?.fieldErrors?.policyId ? true : undefined}>
					<Field.Label for="access-policy">Policy</Field.Label>
					<NativeSelect.Root id="access-policy" name="policyId" bind:value={accessPolicyId} required>
						<NativeSelect.Option value="">Choose a policy</NativeSelect.Option>
						{#each data.accessPolicies as policy (policy.id)}
							<NativeSelect.Option value={policy.id}>{policy.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Field.Description
						>Manage the ordered rules under Settings → Access policies.</Field.Description
					>
					{#if result?.fieldErrors?.policyId}<Field.Error>{result.fieldErrors.policyId}</Field.Error>{/if}
				</Field.Field>
			{/if}
			{#if accessMode === 'password'}
				<Field.Field data-invalid={result?.fieldErrors?.password ? true : undefined}>
					<Field.Label for="access-password"
						>{accessScope === 'production' ? 'Production' : 'Preview'} password</Field.Label
					>
					<Input
						id="access-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required={!accessKeepsPassword}
						placeholder={accessKeepsPassword ? 'Unchanged' : undefined}
						aria-invalid={result?.fieldErrors?.password ? 'true' : undefined}
					/>
					<Field.Description
						>{accessKeepsPassword
							? 'Leave blank to keep the current password. '
							: 'At least 8 characters. '}Only {accessScope === 'production'
							? 'production'
							: 'previews'} use it; the other scope keeps its own.</Field.Description
					>
					{#if result?.fieldErrors?.password}<Field.Error>{result.fieldErrors.password}</Field.Error
						>{/if}
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

{#if data.can.update}
	<FormDialog
		bind:open={projectOpen}
		icon={PencilIcon}
		title="Edit project"
		description="Renaming the slug keeps a 30-day redirect from the old address."
		action="?/updateProject"
		submitLabel="Save project"
	>
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
				<Field.Label for="edit-name">Name</Field.Label>
				<Input id="edit-name" name="name" bind:value={projectName} maxlength={120} required />
				{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={result?.fieldErrors?.slug ? true : undefined}>
				<Field.Label for="edit-slug">Slug</Field.Label>
				<Input
					id="edit-slug"
					name="slug"
					bind:value={projectSlug}
					maxlength={40}
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>
					Address: <span class="font-mono">{projectSlug || '…'}.{data.contentDomain}</span> — the old
					address redirects for 30 days after a rename.
				</Field.Description>
				{#if result?.fieldErrors?.slug}<Field.Error>{result.fieldErrors.slug}</Field.Error>{/if}
				{#if result?.suggestions?.length}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="text-xs text-muted-foreground">Try:</span>
						{#each result.suggestions as suggestion (suggestion)}
							<Button
								type="button"
								variant="outline"
								size="xs"
								class="font-mono"
								onclick={() => (projectSlug = suggestion)}>{suggestion}</Button
							>
						{/each}
					</div>
				{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="edit-placement-spec">Placement constraints (JSON)</Field.Label>
				<Textarea
					id="edit-placement-spec"
					name="placementSpec"
					bind:value={placementSpecText}
					rows={5}
					placeholder={'{\n  "zone": "home",\n  "labels": { "tier": "critical" }\n}'}
					class="font-mono text-xs"
				/>
				<Field.Description>
					Optional hard constraints: node, zone, roles, labels, volumeClass, volumeId, spread and
					near. They are applied once at deploy time; leave blank for none.
				</Field.Description>
				{#if result?.fieldErrors?.placementSpec}
					<Field.Error>{result.fieldErrors.placementSpec}</Field.Error>
				{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="edit-placement">Placement</Field.Label>
				<NativeSelect.Root
					id="edit-placement"
					name="placement"
					bind:value={placement}
					class="w-full"
				>
					{#each placementChoices as option (option.value)}
						<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>
					<code class="font-mono">auto</code> resolves once at deploy time and is recorded on the
					deployment, so a running app never moves by itself. Changing placement here does not move
					an existing workload; it applies to the next deployment. Use <strong>Move</strong> on the Details
					card to move it now.
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.can.update && moveTargets.length > 0}
	<FormDialog
		bind:open={moveOpen}
		icon={ArrowLeftRightIcon}
		title="Move {data.project.name} to another node"
		description="{workloadNode ??
			'The current node'} stops the app and the target starts the same deployment, so expect a short gap. Its placement is set to the target so later deploys stay there."
		action="?/move"
		submitLabel="Move app"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="move-node">Target node</Field.Label>
				<NativeSelect.Root id="move-node" name="node" bind:value={moveNode} class="w-full">
					{#each moveTargets as node (node.nodeId)}
						<NativeSelect.Option value={node.nodeId}>
							{node.name} ({node.mode}) · {node.freeMemoryMb} MB free
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>
					Apps with an attached database or private storage move with that database instead. App
					volumes and a persistent data directory stay on the node, so those apps cannot move yet.
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
