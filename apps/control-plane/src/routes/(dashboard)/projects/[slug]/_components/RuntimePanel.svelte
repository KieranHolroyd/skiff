<script lang="ts">
	import { resolve } from '$app/paths';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import type { ProjectView, SecretView } from '@skiff/core';
	import {
		databasePrefixesFromEnvNames,
		nextEnvPrefix,
		storagePrefixesFromEnvNames,
		type DatabaseAttachmentView,
		type EnvSuggestion,
		type NodeCapacityView,
		type StorageAttachmentView,
		type WorkloadSpec,
		type WorkloadView
	} from '@skiff/contracts';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime, shortId } from '../../../_lib/format.js';

	interface AttachableDatabase {
		name: string;
		version: string;
		engineLabel: string;
		nodeName: string;
	}

	interface AttachableStorage {
		name: string;
		engineLabel: string;
		version: string;
		nodeName: string;
		public: boolean;
		buckets: string[];
	}

	interface LinkTarget {
		kind: 'database' | 'storage';
		name: string;
		label: string;
		prefix: string;
		buckets: string[];
	}

	let {
		project,
		spec,
		workload,
		secrets,
		capacity,
		databaseAttachments = [],
		storageAttachments = [],
		attachableDatabases = [],
		attachableStorage = [],
		canAttachDatabase = false,
		canAttachStorage = false,
		can
	}: {
		project: ProjectView;
		spec: WorkloadSpec | null;
		workload: WorkloadView | null;
		secrets: SecretView[];
		capacity: NodeCapacityView[];
		/** Managed services already attached, and the ones that could be linked from here. */
		databaseAttachments?: DatabaseAttachmentView[];
		storageAttachments?: StorageAttachmentView[];
		attachableDatabases?: AttachableDatabase[];
		attachableStorage?: AttachableStorage[];
		canAttachDatabase?: boolean;
		canAttachStorage?: boolean;
		can: {
			manageWorkload: boolean;
			createSecret: boolean;
			deleteSecret: boolean;
			viewCapacity: boolean;
		};
	} = $props();

	let editOpen = $state(false);
	let secretOpen = $state(false);

	let command = $state('');
	let image = $state('');
	let port = $state('3000');
	let memoryMb = $state('256');
	let cpus = $state('1');
	let healthPath = $state('/');
	let socketActivation = $state(true);
	let dataEnabled = $state(false);
	let dataSizeMb = $state('256');
	let envRows = $state<Array<{ key: string; value: string }>>([]);
	let secretRows = $state<Array<{ name: string; delivery: string; version: string }>>([]);

	let secretType = $state<'secret' | 'env'>('secret');

	let suggestions = $state<EnvSuggestion[]>([]);
	let suggestionState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let linking = $state<string | null>(null);

	/** One row per name: the highest version is what activation resolves by default. */
	const uniqueSecrets = $derived.by(() => {
		const latest: SecretView[] = [];
		for (const secret of secrets) {
			const index = latest.findIndex((row) => row.name === secret.name);
			if (index === -1) {
				latest.push(secret);
			} else {
				const current = latest[index];
				if (current && current.version < secret.version) latest[index] = secret;
			}
		}
		return latest.sort((a, b) => a.name.localeCompare(b.name));
	});

	const secretNames = $derived(uniqueSecrets.map((secret) => secret.name));

	const envKeys = $derived(new Set(envRows.map((row) => row.key.trim()).filter(Boolean)));

	function isSuggestionAdded(item: EnvSuggestion): boolean {
		if (item.source === 'secret') return secretRows.some((row) => row.name === item.name);
		return envKeys.has(item.name);
	}

	const visibleSuggestions = $derived(
		suggestions.filter((item) => item.injected || !isSuggestionAdded(item))
	);

	const detectedCount = $derived(
		suggestions.filter(
			(item) =>
				!item.injected &&
				(item.source === 'env-file' || item.source === 'code') &&
				!isSuggestionAdded(item)
		).length
	);

	const envKeySuggestions = $derived(
		visibleSuggestions.filter((item) => !item.injected && item.source !== 'secret')
	);

	/**
	 * A detected name such as DATABASE_URL or S3_BUCKET means the app expects a managed service.
	 * Offer to link an unattached one, inferring the env prefix from the names the code uses.
	 */
	const linkTargets = $derived.by(() => {
		const targets: LinkTarget[] = [];
		const used = new Set([
			...databaseAttachments.map((item) => item.envPrefix),
			...storageAttachments.map((item) => item.envPrefix)
		]);
		const names = suggestions.filter((item) => !item.injected).map((item) => item.name);
		const databasePrefixes = databasePrefixesFromEnvNames(names);
		const storagePrefixes = storagePrefixesFromEnvNames(names);
		if (canAttachDatabase && databasePrefixes.length > 0) {
			for (const database of attachableDatabases) {
				const preferred =
					databasePrefixes.find((prefix) => !used.has(prefix)) ?? nextEnvPrefix('DATABASE', used);
				used.add(preferred);
				targets.push({
					kind: 'database',
					name: database.name,
					label: `${database.name} · ${database.engineLabel} ${database.version}`,
					prefix: preferred,
					buckets: []
				});
			}
		}
		if (canAttachStorage && storagePrefixes.length > 0) {
			for (const instance of attachableStorage) {
				const preferred =
					storagePrefixes.find((prefix) => !used.has(prefix)) ?? nextEnvPrefix('S3', used);
				used.add(preferred);
				targets.push({
					kind: 'storage',
					name: instance.name,
					label: `${instance.name} · ${instance.public ? 'public' : 'private'}`,
					prefix: preferred,
					buckets: instance.buckets
				});
			}
		}
		return targets;
	});

	const node = $derived(
		workload?.nodeId ? capacity.find((item) => item.nodeId === workload?.nodeId) : undefined
	);

	const memoryPct = $derived(
		workload && node && node.sliceMemoryMb > 0
			? Math.min(100, (workload.memoryMb / node.sliceMemoryMb) * 100)
			: 0
	);

	const runtimeLabel = $derived(
		project.runtime === 'process'
			? 'Process app'
			: project.runtime === 'container'
				? 'Container'
				: 'Static'
	);

	function openEditor() {
		command = spec?.command?.join(' ') ?? (project.runtime === 'process' ? 'bun run start' : '');
		image = spec?.image ?? '';
		port = String(spec?.port ?? 3000);
		memoryMb = String(spec?.memoryMb ?? 256);
		cpus = String(spec?.cpus ?? 1);
		healthPath = spec?.healthPath ?? '/';
		socketActivation = spec?.socketActivation ?? true;
		dataEnabled = Boolean(spec?.data);
		dataSizeMb = String(spec?.data?.sizeMb ?? 256);
		envRows = Object.entries(spec?.env ?? {}).map(([key, value]) => ({ key, value }));
		secretRows = (spec?.secrets ?? []).map((secret) => ({
			name: secret.name,
			delivery: secret.delivery,
			version: secret.version ? String(secret.version) : ''
		}));
		editOpen = true;
		void loadSuggestions();
	}

	async function loadSuggestions(): Promise<void> {
		// Suggestions are cheap (bounded scan, cached artifact) and change when services attach,
		// so refresh on every open instead of caching a stale list.
		if (suggestionState === 'loading') return;
		suggestionState = 'loading';
		try {
			const endpoint = `${resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}/env-suggestions`;
			const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { suggestions?: unknown };
			suggestions = Array.isArray(body.suggestions) ? (body.suggestions as EnvSuggestion[]) : [];
			suggestionState = 'ready';
		} catch {
			suggestionState = 'error';
		}
	}

	function suggestionInitialValue(name: string): string {
		if (name === 'PORT') return port;
		if (name === 'NODE_ENV') return 'production';
		return '';
	}

	function addSuggestion(item: EnvSuggestion): void {
		if (item.injected) return;
		if (item.source === 'secret') {
			if (!secretNames.includes(item.name)) return;
			if (secretRows.some((row) => row.name === item.name)) return;
			secretRows = [...secretRows, { name: item.name, delivery: 'env', version: '' }];
			return;
		}
		if (envRows.some((row) => row.key.trim() === item.name)) return;
		envRows = [...envRows, { key: item.name, value: suggestionInitialValue(item.name) }];
	}

	function addDetectedSuggestions(): void {
		for (const item of suggestions) {
			if (item.source === 'env-file' || item.source === 'code') addSuggestion(item);
		}
	}

	function sourceLabel(source: EnvSuggestion['source']): string {
		if (source === 'env-file') return 'dotenv';
		if (source === 'code') return 'code';
		if (source === 'secret') return 'secret';
		if (source === 'common') return 'common';
		return source;
	}

	async function linkService(target: LinkTarget): Promise<void> {
		if (linking) return;
		linking = `${target.kind}:${target.name}`;
		const fields: Record<string, string> =
			target.kind === 'database'
				? { database: target.name, envPrefix: target.prefix }
				: { storage: target.name, envPrefix: target.prefix };
		if (target.kind === 'storage') {
			for (const bucket of target.buckets) fields[`grant:${bucket}`] = 'read-write';
		}
		try {
			await runAction(target.kind === 'database' ? '?/attachDatabase' : '?/attachStorage', fields);
			await loadSuggestions();
		} finally {
			linking = null;
		}
	}

	function addEnvRow() {
		envRows = [...envRows, { key: '', value: '' }];
	}

	function removeEnvRow(index: number) {
		envRows = envRows.filter((_, position) => position !== index);
	}

	function addSecretRow() {
		secretRows = [...secretRows, { name: secretNames[0] ?? '', delivery: 'env', version: '' }];
	}

	function removeSecretRow(index: number) {
		secretRows = secretRows.filter((_, position) => position !== index);
	}

	function openSecret() {
		secretType = 'secret';
		secretOpen = true;
	}

	function resetWorkload() {
		askConfirm({
			title: 'Stop the workload and reset its runtime?',
			description:
				'The running app is stopped on the next reconcile and the spec is cleared. Deployments and releases are kept, but the production pointer alone cannot serve a process/container app — it stays dark until you configure a runtime and deploy again.',
			confirmLabel: 'Reset runtime',
			tone: 'danger',
			action: '?/removeWorkload'
		});
	}

	function deleteSecret(secret: SecretView) {
		askConfirm({
			title: `Delete secret ${secret.name} (v${secret.version})?`,
			description: secret.projectId
				? 'This removes the latest version. Running workloads keep the value they activated with until they restart.'
				: 'This removes the latest version of an organisation-wide secret. Other projects that reference it lose it when their workloads next restart.',
			confirmLabel: 'Delete secret',
			tone: 'danger',
			action: '?/deleteSecret',
			fields: { secretId: secret.id }
		});
	}
</script>

{#if project.runtime === 'static'}
	<EmptyState
		icon={LayersIcon}
		title="Static project"
		description="Static projects serve files from a release and have no workload. Create a project with runtime “process” or “container” to run an app with a command, port, memory budget and environment variables."
	/>
{:else}
	<div class="space-y-5">
		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						{#if project.runtime === 'container'}
							<BoxesIcon class="size-4" />
						{:else}
							<CpuIcon class="size-4" />
						{/if}
					</span>
					<div class="space-y-1">
						<Card.Title class="flex flex-wrap items-center gap-2">
							Runtime
							<Badge variant="outline">{runtimeLabel}</Badge>
							{#if workload}<StatusBadge status={workload.status} />{/if}
						</Card.Title>
						<Card.Description>
							{project.runtime === 'container'
								? 'A rootless Podman container in the node workload slice.'
								: 'A sandboxed systemd service in the node workload slice.'}
							Only the latest deployment is active — deploying to any environment restarts this workload
							on that release.
						</Card.Description>
					</div>
				</div>
				<Card.Action class="flex flex-wrap items-center justify-end gap-2 self-center">
					{#if can.manageWorkload}
						<Button variant="outline" size="sm" onclick={openEditor}><PencilIcon />Configure</Button
						>
					{/if}
					{#if can.manageWorkload && workload}
						<Button variant="ghost-danger" size="sm" onclick={resetWorkload}>
							<RotateCcwIcon />Reset
						</Button>
					{/if}
				</Card.Action>
			</Card.Header>
			<Card.Content class="py-4">
				{#if workload}
					<DetailList>
						<dt>Node</dt>
						<dd class="font-mono text-xs">
							{#if node}
								{node.name}
							{:else}
								{shortId(workload.nodeId ?? '', 12)}
							{/if}
						</dd>
						<dt>Upstream</dt>
						<dd class="truncate font-mono text-xs" title={workload.upstream ?? ''}>
							{workload.upstream ?? '—'}
						</dd>
						<dt>Memory / CPU</dt>
						<dd class="font-mono text-xs">{workload.memoryMb} MB · {workload.cpus} vCPU</dd>
						<dt>Deployment</dt>
						<dd class="truncate font-mono text-xs">{shortId(workload.deploymentId, 12)}</dd>
						<dt>Updated</dt>
						<dd class="text-sm">
							<time datetime={workload.updatedAt}>{formatDateTime(workload.updatedAt)}</time>
						</dd>
					</DetailList>
					{#if workload.message}
						<p class="mt-3 text-xs break-words text-muted-foreground">{workload.message}</p>
					{/if}
					<div class="mt-4 space-y-1.5">
						<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
							<span class="text-muted-foreground">Memory reservation</span>
							<span class="font-mono text-xs tabular-nums">
								{node
									? `${workload.memoryMb} MB of ${node.sliceMemoryMb} MB slice`
									: `${workload.memoryMb} MB`}
							</span>
						</div>
						{#if node}
							<Progress value={memoryPct} aria-label="Workload memory reservation" class="h-1.5" />
						{:else if can.viewCapacity}
							<p class="text-xs text-muted-foreground">
								The node is not reporting slice capacity right now.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Slice capacity is only visible to platform admins.
							</p>
						{/if}
					</div>
				{:else}
					<div class="space-y-2">
						<p class="text-sm">
							{spec
								? 'Configuration saved. An existing workload picks it up on the next reconcile; otherwise it applies at the next deployment.'
								: project.runtime === 'container'
									? 'No runtime configured yet. Container projects need an image before they can deploy.'
									: 'No runtime configured yet. The deploy pipeline uses `bun run start` by default.'}
						</p>
						<p class="text-xs text-muted-foreground">
							Admission is checked against the target node's workload slice at deploy time.
						</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<div class="grid items-start gap-5 lg:grid-cols-2">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>Specification</Card.Title>
					<Card.Description>The public fields applied to the project workload.</Card.Description>
				</Card.Header>
				<Card.Content class="py-4">
					{#if spec}
						<DetailList>
							{#if project.runtime === 'process'}
								<dt>Command</dt>
								<dd class="truncate font-mono text-xs" title={spec.command?.join(' ') ?? ''}>
									{spec.command?.join(' ') ?? 'bun run start'}
								</dd>
								<dt>Socket activation</dt>
								<dd class="text-sm">{spec.socketActivation ? 'enabled' : 'disabled'}</dd>
							{:else}
								<dt>Image</dt>
								<dd class="truncate font-mono text-xs" title={spec.image ?? ''}>
									{spec.image ?? 'not set'}
								</dd>
							{/if}
							<dt>Port</dt>
							<dd class="font-mono text-sm">{spec.port}</dd>
							<dt>Health check</dt>
							<dd class="font-mono text-sm">{spec.healthPath}</dd>
							<dt>Memory</dt>
							<dd class="font-mono text-sm">{spec.memoryMb} MB</dd>
							<dt>CPU</dt>
							<dd class="font-mono text-sm">{spec.cpus} vCPU</dd>
							<dt>Env vars</dt>
							<dd class="font-mono text-sm">{Object.keys(spec.env).length}</dd>
							<dt>Secret refs</dt>
							<dd class="font-mono text-sm">{spec.secrets.length}</dd>
							<dt>Data volume</dt>
							<dd class="font-mono text-sm">
								{spec.data ? `${spec.data.sizeMb} MB` : 'none'}
							</dd>
						</DetailList>
					{:else}
						<p class="text-sm text-muted-foreground">
							No spec saved. Configure the runtime to choose a command or image, port, memory budget
							and environment variables.
						</p>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title class="flex items-center gap-2">
						<ServerIcon class="size-4 text-muted-foreground" />
						Node capacity
					</Card.Title>
					<Card.Description>
						Admission reserves memory from each node's <code class="font-mono text-xs"
							>skiff-workloads.slice</code
						>.
					</Card.Description>
				</Card.Header>
				<Card.Content class="py-4">
					{#if !can.viewCapacity}
						<p class="text-sm text-muted-foreground">
							Fleet capacity is visible to platform admins. Placement still resolves automatically
							at deploy time.
						</p>
					{:else if capacity.length === 0}
						<p class="text-sm text-muted-foreground">
							No nodes report a workload slice yet. Enrol a node and set its slice budget.
						</p>
					{:else}
						<div class="space-y-4">
							{#each capacity as item (item.nodeId)}
								{@const used = item.sliceMemoryMb - item.freeMemoryMb}
								{@const pct = item.sliceMemoryMb > 0 ? (used / item.sliceMemoryMb) * 100 : 0}
								<div class="space-y-1.5">
									<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
										<span class="inline-flex items-center gap-1.5">
											<ServerIcon class="size-3 text-muted-foreground" />
											<span class="font-medium">{item.name}</span>
											<Badge variant="secondary" class="capitalize">{item.mode}</Badge>
											{#if workload?.nodeId === item.nodeId}
												<Badge variant="brand">this workload</Badge>
											{/if}
										</span>
										<span class="font-mono text-xs text-muted-foreground tabular-nums"
											>{item.freeMemoryMb} MB free · {item.workloadCount} workloads</span
										>
									</div>
									<Progress
										value={Math.min(100, Math.max(0, pct))}
										aria-label="Reserved slice memory on {item.name}"
										class="h-1.5"
									/>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						<KeyRoundIcon class="size-4" />
					</span>
					<div class="space-y-1">
						<Card.Title>Environment &amp; secrets</Card.Title>
						<Card.Description>
							Secret values are write-only. The agent fetches them just-in-time at activation, so
							they never enter desired state or the on-disk cache.
						</Card.Description>
					</div>
				</div>
				<Card.Action class="self-center">
					{#if can.createSecret}
						<Button size="sm" onclick={openSecret}><PlusIcon />Add secret</Button>
					{/if}
				</Card.Action>
			</Card.Header>
			<Card.Content class="px-0">
				{#if uniqueSecrets.length === 0}
					<div class="p-4">
						<EmptyState
							icon={ShieldCheckIcon}
							compact
							title="No secrets yet"
							description="Add API keys or database URLs for this project, then reference them from the runtime spec. Values can never be read back."
						/>
					</div>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Name</Table.Head>
								<Table.Head class="hidden sm:table-cell">Type</Table.Head>
								<Table.Head class="hidden md:table-cell">Created for</Table.Head>
								<Table.Head>Version</Table.Head>
								<Table.Head class="hidden lg:table-cell">Updated</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each uniqueSecrets as secret (secret.id)}
								<Table.Row>
									<Table.Cell class="max-w-48 truncate pl-4 font-mono text-xs" title={secret.name}
										>{secret.name}</Table.Cell
									>
									<Table.Cell class="hidden sm:table-cell">
										<Badge variant={secret.type === 'secret' ? 'brand' : 'outline'}>
											{secret.type === 'secret' ? 'secret' : 'plain env'}
										</Badge>
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{secret.projectId ? 'This project' : 'Organisation'}
									</Table.Cell>
									<Table.Cell class="font-mono text-xs">v{secret.version}</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
										<time datetime={secret.createdAt}>{formatDateTime(secret.createdAt)}</time>
									</Table.Cell>
									<Table.Cell class="pr-4 text-right">
										{#if can.deleteSecret && secret.projectId === project.id}
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label={`Delete secret ${secret.name} version ${secret.version}`}
												onclick={() => deleteSecret(secret)}
											>
												<TrashIcon />
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
				A new secret version is used at the next activation (restart or redeploy); it is never
				hot-swapped into a running process. Secrets resolve by name across the organisation, so keep
				names unique per project. Plain spec env vars live in desired state, so use secrets for
				sensitive values. Deleting removes the latest version; the previous one becomes eligible
				again.
			</Card.Footer>
		</Card.Root>
	</div>
{/if}

{#if can.manageWorkload && project.runtime !== 'static'}
	<FormDialog
		bind:open={editOpen}
		icon={CpuIcon}
		title="Configure runtime"
		description="These values are validated and recorded as the project's workload spec. Admission runs at deploy time."
		action="?/saveWorkload"
		submitLabel="Save runtime"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field class="sm:col-span-2">
					<Field.Label for="workload-port">Port</Field.Label>
					<Input
						id="workload-port"
						name="port"
						type="number"
						min="1"
						max="65535"
						bind:value={port}
					/>
					<Field.Description>The app must listen on this port.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="workload-health">Health path</Field.Label>
					<Input id="workload-health" name="healthPath" bind:value={healthPath} placeholder="/" />
				</Field.Field>
			</div>

			{#if project.runtime === 'process'}
				<Field.Field>
					<Field.Label for="workload-command">Command</Field.Label>
					<Input
						id="workload-command"
						name="command"
						bind:value={command}
						placeholder="bun run start"
						class="font-mono text-sm"
					/>
					<Field.Description>
						Split on spaces and run without a shell; quotes are not interpreted. Leave blank to use
						<code class="font-mono">bun run start</code>.
					</Field.Description>
				</Field.Field>
				<Field.Field orientation="horizontal" class="gap-2">
					<Checkbox
						id="workload-socket"
						name="socketActivation"
						value="1"
						bind:checked={socketActivation}
					/>
					<Field.Label for="workload-socket" class="font-normal">
						Pass the listen socket with socket activation (recommended)
					</Field.Label>
				</Field.Field>
			{:else}
				<Field.Field>
					<Field.Label for="workload-image">Container image</Field.Label>
					<Input
						id="workload-image"
						name="image"
						bind:value={image}
						placeholder="ghcr.io/acme/app:latest"
						required
						class="font-mono text-sm"
					/>
					<Field.Description>
						Pulled rootlessly on the node. Use a digest or immutable tag for reproducible deploys.
					</Field.Description>
				</Field.Field>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="workload-memory">Memory (MB)</Field.Label>
					<Input
						id="workload-memory"
						name="memoryMb"
						type="number"
						min="32"
						max="8192"
						bind:value={memoryMb}
					/>
					<Field.Description
						>Reserved in the node slice and enforced with MemoryMax.</Field.Description
					>
				</Field.Field>
				<Field.Field>
					<Field.Label for="workload-cpu">vCPU</Field.Label>
					<Input
						id="workload-cpu"
						name="cpus"
						type="number"
						min="0.1"
						max="8"
						step="0.1"
						bind:value={cpus}
					/>
					<Field.Description>A CPU quota, not a hard pin.</Field.Description>
				</Field.Field>
			</div>

			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="workload-data" name="dataEnabled" value="1" bind:checked={dataEnabled} />
				<Field.Label for="workload-data" class="font-normal">
					Mount a persistent data directory at <code class="font-mono">/data</code>
				</Field.Label>
			</Field.Field>
			{#if dataEnabled}
				<Field.Field>
					<Field.Label for="workload-data-size">Data size (MB)</Field.Label>
					<Input
						id="workload-data-size"
						name="dataSizeMb"
						type="number"
						min="32"
						max="65536"
						bind:value={dataSizeMb}
					/>
					<Field.Description>
						A per-project directory. SQLite files are the intended default for tier 2 apps.
					</Field.Description>
				</Field.Field>
			{/if}

			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div>
						<p class="text-sm font-medium">Plain environment variables</p>
						<p class="text-xs text-muted-foreground">Readable config for non-sensitive values.</p>
					</div>
					<Button type="button" variant="outline" size="sm" onclick={addEnvRow}
						><PlusIcon />Add variable</Button
					>
				</div>

				{#if suggestionState === 'ready' && visibleSuggestions.length > 0}
					<div class="space-y-2 rounded-lg border bg-muted/30 p-3">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div>
								<p class="text-xs font-medium">Suggestions</p>
								<p class="text-xs text-muted-foreground">
									From linked services, <code class="font-mono">.env</code> files and your code. Injected
									values are already set at start-up.
								</p>
							</div>
							{#if detectedCount > 0}
								<Button type="button" variant="outline" size="sm" onclick={addDetectedSuggestions}>
									Add {detectedCount} detected
								</Button>
							{/if}
						</div>
						<div class="flex flex-wrap gap-1">
							{#each visibleSuggestions as item (item.name)}
								{#if item.injected}
									<Badge
										variant="secondary"
										class="gap-1 font-mono font-normal"
										title="Injected automatically by {item.detail}"
									>
										<PlugIcon class="size-3" />{item.name}
									</Badge>
								{:else}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-[11px] transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
										title={item.detail}
										onclick={() => addSuggestion(item)}
									>
										{item.name}<span class="font-sans text-muted-foreground"
											>{sourceLabel(item.source)}</span
										>
									</button>
								{/if}
							{/each}
						</div>
					</div>
				{:else if suggestionState === 'loading'}
					<p class="text-xs text-muted-foreground">Looking for suggested variables…</p>
				{:else if suggestionState === 'error'}
					<p class="text-xs text-muted-foreground">
						Suggestions could not be loaded. The form still works.
					</p>
				{/if}

				{#if linkTargets.length > 0}
					<div class="space-y-2 rounded-lg border border-dashed p-3">
						<div>
							<p class="text-xs font-medium">Link a service</p>
							<p class="text-xs text-muted-foreground">
								Your code expects these names. Linking attaches the service and injects them at the
								next start.
							</p>
						</div>
						<div class="space-y-1.5">
							{#each linkTargets as target (target.kind + ':' + target.name)}
								<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
									<span class="min-w-0" title={target.label}>
										<span class="font-medium">{target.name}</span>
										<span class="text-muted-foreground"> → {target.prefix}_*</span>
									</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={linking !== null}
										onclick={() => linkService(target)}
									>
										{linking === `${target.kind}:${target.name}` ? 'Linking…' : 'Link'}
									</Button>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<datalist id="env-key-suggestions">
					{#each envKeySuggestions as item (item.name)}
						<option value={item.name}>{item.detail}</option>
					{/each}
				</datalist>

				{#if envRows.length === 0}
					<p class="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
						No plain env vars. Reference a secret below for sensitive values.
					</p>
				{:else}
					<div class="space-y-2">
						{#each envRows as row, index (index)}
							<div class="flex items-start gap-2">
								<Input
									name="envKey"
									bind:value={row.key}
									list="env-key-suggestions"
									placeholder="DATABASE_URL"
									aria-label="Environment variable name"
									class="font-mono text-xs sm:max-w-52"
								/>
								<Input
									name="envValue"
									bind:value={row.value}
									placeholder="value"
									aria-label="Environment variable value"
									class="font-mono text-xs"
								/>
								<Button
									type="button"
									variant="ghost-danger"
									size="icon-sm"
									aria-label="Remove variable"
									onclick={() => removeEnvRow(index)}
								>
									<TrashIcon />
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div>
						<p class="text-sm font-medium">Secret references</p>
						<p class="text-xs text-muted-foreground">
							Delivered as environment variables, or as files readable at activation. Leave the
							version blank for “latest”; pin a number to keep a deployment on that version.
						</p>
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={secretNames.length === 0}
						onclick={addSecretRow}
					>
						<PlusIcon />Add secret
					</Button>
				</div>
				{#if secretNames.length === 0}
					<p class="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
						No secrets in this organisation yet. Save the runtime, add a secret, then edit it again
						to reference the secret.
					</p>
				{:else if secretRows.length === 0}
					<p class="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
						No secret references. Add one to inject a value at activation.
					</p>
				{:else}
					<div class="space-y-2">
						{#each secretRows as row, index (index)}
							<div class="flex flex-wrap items-start gap-2">
								<NativeSelect.Root
									name="secretName"
									bind:value={row.name}
									aria-label="Secret"
									class="min-w-40 flex-1 font-mono text-xs"
								>
									{#each secretNames as name (name)}
										<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
								<NativeSelect.Root
									name="secretDelivery"
									bind:value={row.delivery}
									aria-label="Delivery mode"
									class="min-w-36 sm:max-w-40"
								>
									<NativeSelect.Option value="env">Environment variable</NativeSelect.Option>
									<NativeSelect.Option value="file">File</NativeSelect.Option>
								</NativeSelect.Root>
								<Input
									name="secretVersion"
									type="number"
									min="1"
									step="1"
									placeholder="latest"
									aria-label="Pin secret version"
									bind:value={row.version}
									class="w-24 font-mono text-xs"
								/>
								<Button
									type="button"
									variant="ghost-danger"
									size="icon-sm"
									aria-label="Remove secret reference"
									onclick={() => removeSecretRow(index)}
								>
									<TrashIcon />
								</Button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</Field.Group>
	</FormDialog>
{/if}

{#if can.createSecret && project.runtime !== 'static'}
	<FormDialog
		bind:open={secretOpen}
		icon={KeyRoundIcon}
		title="Add a secret"
		description="Values are encrypted at rest and can never be read back from the dashboard or API."
		action="?/setSecret"
		submitLabel="Save secret"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="secret-name">Name</Field.Label>
				<Input
					id="secret-name"
					name="secretName"
					placeholder="STRIPE_SECRET_KEY"
					required
					autocapitalize="characters"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description
					>UPPER_SNAKE_CASE. Re-using a name creates a new version.</Field.Description
				>
			</Field.Field>
			<Field.Field>
				<Field.Label for="secret-value">Value</Field.Label>
				<Input
					id="secret-value"
					name="secretValue"
					type="password"
					autocomplete="new-password"
					required
					class="font-mono text-sm"
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="secret-type">Type</Field.Label>
				<NativeSelect.Root
					id="secret-type"
					name="secretType"
					bind:value={secretType}
					class="w-full"
				>
					<NativeSelect.Option value="secret">Secret (write-only)</NativeSelect.Option>
					<NativeSelect.Option value="env">Plain env (still write-only)</NativeSelect.Option>
				</NativeSelect.Root>
			</Field.Field>
			<Field.Description>
				Both types are encrypted and never readable. Use the runtime form's plain env vars for
				non-sensitive config. The agent fetches the value only when it activates the workload.
			</Field.Description>
		</Field.Group>
	</FormDialog>
{/if}
