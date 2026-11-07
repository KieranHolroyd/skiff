<script lang="ts">
	import type { DeploymentView } from '@skiff/core';
	import { contentUrl, type EnvironmentView } from '@skiff/contracts';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import AccessChip from '../../../_lib/AccessChip.svelte';
	import AccessSelect from '../../../_lib/AccessSelect.svelte';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { shortId } from '../../../_lib/format.js';

	let {
		environments,
		deployments,
		can,
		platformOrigin,
		previewAccess = 'platform',
		productionAccess = 'public',
		runtime = 'static'
	}: {
		environments: EnvironmentView[];
		deployments: DeploymentView[];
		can: {
			manageEnvironments: boolean;
			promoteEnvironment: boolean;
			rollbackEnvironment: boolean;
		};
		platformOrigin: string;
		previewAccess?: string;
		productionAccess?: string;
		runtime?: string;
	} = $props();

	let createOpen = $state(false);
	let createAccess = $state('platform');

	let editOpen = $state(false);
	let editing = $state<EnvironmentView | null>(null);
	let editAccess = $state('platform');

	let promoteOpen = $state(false);
	let promoting = $state<EnvironmentView | null>(null);
	let deploymentChoice = $state('');

	const activeDeployments = $derived(deployments.filter((row) => row.status === 'active'));

	const promoteDescription = $derived(
		`Point ${promoting?.host ?? 'this host'} at an existing deployment. Its release and config are served at this host.${
			runtime !== 'static'
				? ' The running app only switches when this is production; environment pointers do not change the active workload.'
				: ''
		}`
	);

	function pointer(environment: EnvironmentView): DeploymentView | undefined {
		return environment.deploymentId
			? deployments.find((row) => row.id === environment.deploymentId)
			: undefined;
	}

	/** Production access lives on the project; older environment rows can lag behind it. */
	function accessFor(environment: EnvironmentView): string {
		return environment.isProduction ? productionAccess : environment.access;
	}

	function openCreate() {
		createAccess = previewAccess;
		createOpen = true;
	}

	function openEdit(environment: EnvironmentView) {
		editing = environment;
		editAccess = environment.access;
		editOpen = true;
	}

	function openPromote(environment: EnvironmentView) {
		promoting = environment;
		deploymentChoice =
			environment.deploymentId &&
			activeDeployments.some((deployment) => deployment.id === environment.deploymentId)
				? environment.deploymentId
				: '';
		promoteOpen = true;
	}

	function rollback(environment: EnvironmentView) {
		askConfirm({
			title: `Roll back ${environment.name}?`,
			description: environment.isProduction
				? 'Production moves back to the previous promoted deployment. Code and config both move.'
				: `The ${environment.name} pointer moves to the previous deployment in this environment.`,
			confirmLabel: 'Roll back',
			action: '?/rollbackEnvironment',
			fields: { environmentSlug: environment.slug }
		});
	}

	function remove(environment: EnvironmentView) {
		askConfirm({
			title: `Delete the ${environment.name} environment?`,
			description: `${environment.host} stops serving. Its deployments must be deleted first, and production cannot be removed.`,
			confirmLabel: 'Delete environment',
			tone: 'danger',
			action: '?/deleteEnvironment',
			fields: { environmentSlug: environment.slug }
		});
	}
</script>

<div class="space-y-5">
	<div
		class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/70 px-4 py-3"
	>
		<div class="flex items-start gap-3">
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<LayersIcon class="size-4" />
			</span>
			<div class="min-w-0">
				<p class="text-sm font-medium">Named environments</p>
				<p class="text-xs text-muted-foreground">
					Each environment has its own host and deployment pointer. Production is built in.
				</p>
			</div>
		</div>
		{#if can.manageEnvironments}
			<Button size="sm" onclick={openCreate}><PlusIcon />New environment</Button>
		{/if}
	</div>

	{#if runtime !== 'static'}
		<Alert.Root variant="warning">
			<TriangleAlertIcon />
			<Alert.Title>Only the latest deployment is active</Alert.Title>
			<Alert.Description>
				This project runs one app workload. Deploying to any environment makes that release the
				running app, and every environment host and preview URL proxies to it. Environment pointers
				do not start separate copies; promoting an older deployment to production moves the workload
				back to that release.
			</Alert.Description>
		</Alert.Root>
	{/if}

	{#if environments.length === 0}
		<EmptyState
			icon={LayersIcon}
			title="No environments"
			description={runtime === 'static'
				? 'Production is created lazily on the next deploy. Add staging or preview environments to test before promoting.'
				: 'Production is created lazily on the next deploy. Process and container apps run one workload, so adding staging does not create an isolated copy: a deploy to any environment switches the running app.'}
		/>
	{:else}
		<div class="grid gap-4 lg:grid-cols-2">
			{#each environments as environment (environment.id)}
				{@const deployment = pointer(environment)}
				<Card.Root class="gap-0 py-0">
					<Card.Header class="border-b py-4">
						<div class="min-w-0 space-y-1">
							<Card.Title class="flex flex-wrap items-center gap-2 break-words">
								{environment.name}
								{#if environment.isProduction}
									<Badge variant="brand">production</Badge>
								{:else}
									<Badge variant="outline" class="font-mono text-xs">{environment.slug}</Badge>
								{/if}
							</Card.Title>
							<a
								href={contentUrl(platformOrigin, environment.host)}
								target="_blank"
								rel="external noreferrer"
								title={environment.host}
								class="inline-flex max-w-full min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								<GlobeIcon class="size-3 shrink-0" />
								<span class="truncate">{environment.host}</span>
								<ArrowUpRightIcon class="size-3 shrink-0" />
							</a>
						</div>
						<Card.Action class="self-center">
							<AccessChip mode={accessFor(environment)} />
						</Card.Action>
					</Card.Header>

					<Card.Content class="space-y-3 py-4">
						{#if deployment}
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-mono text-sm font-medium">{deployment.shortId}</span>
								<StatusBadge status={deployment.status} />
								{#if deployment.pinned}<Badge variant="outline">pinned</Badge>{/if}
								{#if deployment.environmentSlug !== environment.slug}
									<Badge variant="outline" class="font-mono text-xs"
										>{deployment.environmentName}</Badge
									>
								{/if}
							</div>
							<p class="text-xs text-muted-foreground">
								{#if deployment.message}{deployment.message} ·
								{/if}
								<span class="font-mono">release {shortId(deployment.release.sha256, 10)}</span>
							</p>
						{:else if environment.deploymentId}
							<p class="text-sm text-muted-foreground">
								Deployment
								<span class="font-mono text-foreground"
									>{shortId(environment.deploymentId, 10)}</span
								>
								is serving this host.
							</p>
						{:else}
							<p class="text-sm text-muted-foreground">
								Nothing is serving this host yet. Promote a deployment to publish it.
							</p>
						{/if}
					</Card.Content>

					<Card.Footer class="flex flex-wrap items-center justify-end gap-2 border-t py-3">
						{#if can.promoteEnvironment}
							<Button variant="outline" size="sm" onclick={() => openPromote(environment)}>
								<GitBranchIcon />Promote
							</Button>
						{/if}
						{#if can.rollbackEnvironment && environment.deploymentId}
							<Button variant="ghost" size="sm" onclick={() => rollback(environment)}>
								<RotateCcwIcon />Roll back
							</Button>
						{/if}
						{#if can.manageEnvironments && !environment.isProduction}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Edit ${environment.name} environment`}
								onclick={() => openEdit(environment)}
							>
								<PencilIcon />
							</Button>
							<Button
								variant="ghost-danger"
								size="icon-sm"
								aria-label={`Delete ${environment.name} environment`}
								onclick={() => remove(environment)}
							>
								<TrashIcon />
							</Button>
						{/if}
					</Card.Footer>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

{#if can.manageEnvironments}
	<FormDialog
		bind:open={createOpen}
		icon={LayersIcon}
		title="New environment"
		description="Environments use <slug>--<name> on the content domain, so the wildcard certificate still covers them."
		action="?/createEnvironment"
		submitLabel="Create environment"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="env-name">Name</Field.Label>
					<Input id="env-name" name="name" placeholder="Staging" maxlength={60} required />
				</Field.Field>
				<Field.Field>
					<Field.Label for="env-slug">
						Slug <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="env-slug"
						name="slug"
						placeholder="staging"
						maxlength={30}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="env-access">Access</Field.Label>
				<AccessSelect id="env-access" name="access" bind:value={createAccess} />
				<Field.Description>
					Staging usually uses platform login so only members of this organisation can open it.
				</Field.Description>
			</Field.Field>
			{#if createAccess === 'password'}
				<Field.Field>
					<Field.Label for="env-password">Environment password</Field.Label>
					<Input
						id="env-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required
					/>
					<Field.Description
						>At least 8 characters. Only this environment uses it.</Field.Description
					>
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={editOpen}
		icon={PencilIcon}
		title="Edit {editing?.name ?? 'environment'}"
		description="The host name stays the same; only the display name and access mode change."
		action="?/updateEnvironment"
		submitLabel="Save environment"
	>
		<input type="hidden" name="environmentSlug" value={editing?.slug ?? ''} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="env-edit-name">Name</Field.Label>
				<Input id="env-edit-name" name="name" value={editing?.name ?? ''} maxlength={60} required />
			</Field.Field>
			<Field.Field>
				<Field.Label for="env-edit-access">Access</Field.Label>
				<AccessSelect id="env-edit-access" name="access" bind:value={editAccess} />
			</Field.Field>
			{#if editAccess === 'password'}
				{@const keep = editing?.access === 'password' && editing.passwordSet}
				<Field.Field>
					<Field.Label for="env-edit-password">Environment password</Field.Label>
					<Input
						id="env-edit-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required={!keep}
						placeholder={keep ? 'Unchanged' : undefined}
					/>
					<Field.Description
						>{keep
							? 'Leave blank to keep the current password.'
							: 'At least 8 characters. Only this environment uses it.'}</Field.Description
					>
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}

{#if can.promoteEnvironment}
	<FormDialog
		bind:open={promoteOpen}
		icon={GitBranchIcon}
		title="Promote to {promoting?.name ?? 'environment'}"
		description={promoteDescription}
		action="?/promoteEnvironment"
		submitLabel="Promote deployment"
	>
		<input type="hidden" name="environmentSlug" value={promoting?.slug ?? ''} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="env-deployment">Deployment</Field.Label>
				<NativeSelect.Root
					id="env-deployment"
					name="deploymentId"
					bind:value={deploymentChoice}
					class="w-full"
					required
				>
					<NativeSelect.Option value="">Choose a deployment</NativeSelect.Option>
					{#each activeDeployments as deployment (deployment.id)}
						<NativeSelect.Option value={deployment.id}>
							{deployment.shortId} · {deployment.environmentName}
							{deployment.isProduction ? ' (production)' : ''}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>
					Only active deployments are shown. Deploy a new build first if the one you need is
					missing.
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
