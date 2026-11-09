<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LogsIcon from '@lucide/svelte/icons/logs';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PowerIcon from '@lucide/svelte/icons/power';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { LogDrainView } from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import SecretDialog from '#lib/components/yoal/SecretDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	interface ActionResultData {
		secret?: { name: string; value: string; note: string } | null;
	}

	let { data, form }: PageProps = $props();

	const SOURCES = [
		{ id: 'build', label: 'Build' },
		{ id: 'runtime', label: 'Runtime' },
		{ id: 'system', label: 'System' },
		{ id: 'services', label: 'Managed services' }
	] as const;
	const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

	let createOpen = $state(false);
	let kind = $state<'webhook' | 'otlp'>('webhook');
	let createProject = $state('');
	let editing = $state<LogDrainView | null>(null);
	let editOpen = $state(false);
	let secretOpen = $state(false);
	let secret = $state<{ name: string; value: string; note: string } | null>(null);
	let testing = $state<string | null>(null);

	$effect(() => {
		const shown = (form as ActionResultData | null)?.secret;
		if (shown) {
			secret = shown;
			secretOpen = true;
		}
	});
	$effect(() => {
		// Drop the secret from memory once the dialog is closed.
		if (!secretOpen) secret = null;
	});

	function openCreate() {
		kind = 'webhook';
		createProject = '';
		createOpen = true;
	}

	function openEdit(drain: LogDrainView) {
		editing = drain;
		editOpen = true;
	}

	function forwards(drain: LogDrainView): string {
		const what = drain.sources.length
			? drain.sources
					.map((source) => SOURCES.find((entry) => entry.id === source)?.label ?? source)
					.join(', ')
			: 'All logs';
		return `${what}${drain.minLevel ? `, ${drain.minLevel} and above` : ''}`;
	}

	const statusLabel: Record<LogDrainView['status'], string> = {
		healthy: 'Delivering',
		failing: 'Failing',
		pending: 'Waiting for logs',
		disabled: 'Paused'
	};
	const statusTone = {
		healthy: 'success',
		failing: 'danger',
		pending: 'info',
		disabled: 'neutral'
	} as const;

	async function test(drain: LogDrainView) {
		testing = drain.id;
		await runAction('?/test', { id: drain.id });
		testing = null;
	}

	function toggle(drain: LogDrainView) {
		void runAction('?/toggle', { id: drain.id, enabled: String(!drain.enabled) });
	}

	function rotate(drain: LogDrainView) {
		askConfirm({
			title: `New signing secret for ${drain.name}?`,
			description:
				'The current secret stops working at once: requests are signed with the new one, so update the receiver right after.',
			confirmLabel: 'Rotate secret',
			action: '?/rotate',
			fields: { id: drain.id }
		});
	}

	function remove(drain: LogDrainView) {
		askConfirm({
			title: `Delete ${drain.name}?`,
			description:
				'Forwarding stops at once. Lines already sent stay with the receiver. To stop for a while instead, pause the drain.',
			confirmLabel: 'Delete drain',
			tone: 'danger',
			action: '?/remove',
			fields: { id: drain.id }
		});
	}
</script>

<svelte:head><title>Log drains · Settings · Yoal</title></svelte:head>

<SettingsHeader id="log-drains" />

<div class="space-y-6">
	<Panel
		title="Log drains"
		icon={LogsIcon}
		count={data.drains.length}
		description="Every line Yoal stores is forwarded within a few seconds, from when the drain is created."
		flush
	>
		{#snippet actions()}
			{#if data.canEdit && data.drains.length > 0}
				<Button size="sm" onclick={openCreate}><PlusIcon />Add drain</Button>
			{/if}
		{/snippet}

		{#if data.drains.length === 0}
			<div class="p-4">
				<EmptyState
					icon={LogsIcon}
					compact
					title="No log drains"
					description="Send build, runtime, system and managed-service logs to your own log store: any HTTPS webhook, or an OTLP receiver such as Grafana Cloud, Datadog, Honeycomb or an OpenTelemetry Collector."
				>
					{#if data.canEdit}
						<Button size="sm" onclick={openCreate}><PlusIcon />Add a drain</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Drain</Table.Head>
						<Table.Head class="hidden lg:table-cell">Forwards</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.drains as drain (drain.id)}
						<Table.Row>
							<Table.Cell class="max-w-96 pl-4">
								<p class="flex flex-wrap items-center gap-1.5">
									<span class="font-mono text-sm font-medium">{drain.name}</span>
									<Badge variant="outline">
										{drain.kind === 'otlp' ? 'OTLP' : `Webhook · ${drain.format ?? 'ndjson'}`}
									</Badge>
									{#if drain.signed}<Badge variant="neutral">Signed</Badge>{/if}
									{#if drain.allowPrivateNetwork}<Badge variant="warning">Private network</Badge
										>{/if}
								</p>
								<p
									class="mt-0.5 truncate font-mono text-xs text-muted-foreground"
									title={drain.url}
								>
									{drain.url}
								</p>
								{#if drain.headerNames.length}
									<p class="mt-0.5 text-xs text-muted-foreground">
										Headers: <span class="font-mono">{drain.headerNames.join(', ')}</span>
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden lg:table-cell">
								<p class="text-sm">
									{drain.project ? `Project ${drain.project}` : 'Whole organisation'}
								</p>
								<p class="text-xs text-muted-foreground">{forwards(drain)}</p>
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={drain.status}
									label={statusLabel[drain.status]}
									tone={statusTone[drain.status]}
								/>
								<p class="mt-1 text-xs text-muted-foreground">
									{drain.delivery.deliveredLines.toLocaleString()} sent{#if drain.delivery.droppedLines > 0},
										<span class="text-destructive"
											>{drain.delivery.droppedLines.toLocaleString()} dropped</span
										>{/if}
									{#if drain.delivery.lastDeliveredAt}
										· last {formatRelative(drain.delivery.lastDeliveredAt)}
									{/if}
								</p>
								{#if drain.delivery.lastError}
									<p
										class="mt-0.5 max-w-72 truncate text-xs text-destructive"
										title="{drain.delivery.lastError} ({formatDateTime(
											drain.delivery.lastErrorAt
										)})"
									>
										{drain.delivery.lastError}
									</p>
								{/if}
								{#if drain.delivery.nextAttemptAt}
									<p class="mt-0.5 text-xs text-muted-foreground">
										Retry {drain.delivery.attempts + 1}
										{formatRelative(drain.delivery.nextAttemptAt)}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canEdit}
									<div class="flex items-center justify-end gap-1">
										<Button
											size="sm"
											variant="outline"
											onclick={() => test(drain)}
											disabled={testing !== null}
										>
											<PlugZapIcon />{testing === drain.id ? 'Sending…' : 'Test'}
										</Button>
										<RowMenu label="Actions for {drain.name}">
											<DropdownMenu.Item onSelect={() => openEdit(drain)}>
												<PencilIcon />Edit
											</DropdownMenu.Item>
											<DropdownMenu.Item onSelect={() => toggle(drain)}>
												<PowerIcon />{drain.enabled ? 'Pause' : 'Resume'}
											</DropdownMenu.Item>
											{#if drain.kind === 'webhook'}
												<DropdownMenu.Item onSelect={() => rotate(drain)}>
													<KeyRoundIcon />Rotate signing secret
												</DropdownMenu.Item>
											{/if}
											<DropdownMenu.Separator />
											<DropdownMenu.Item variant="destructive" onSelect={() => remove(drain)}>
												<TrashIcon />Delete drain
											</DropdownMenu.Item>
										</RowMenu>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				Delivery is at least once: a failed batch is retried with backoff for about ten minutes,
				then dropped and counted. Every line has a stable <code class="font-mono">id</code> to
				dedupe on.
				{#if !data.canEdit}Org owners and admins manage drains.{/if}
			</span>
		{/snippet}
	</Panel>
</div>

{#snippet sourceFields(prefix: string, selected: readonly string[], projectScoped: boolean)}
	<Field.Set>
		<Field.Legend variant="label">Sources</Field.Legend>
		<Field.Description>None ticked forwards everything.</Field.Description>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each SOURCES as source (source.id)}
				{#if !(projectScoped && source.id === 'services')}
					<Field.Field orientation="horizontal">
						<Checkbox
							id="{prefix}-source-{source.id}"
							name="sources"
							value={source.id}
							checked={selected.includes(source.id)}
						/>
						<Field.Label for="{prefix}-source-{source.id}" class="font-normal"
							>{source.label}</Field.Label
						>
					</Field.Field>
				{/if}
			{/each}
		</div>
	</Field.Set>
{/snippet}

{#snippet levelField(prefix: string, value: string)}
	<Field.Field>
		<Field.Label for="{prefix}-level">Minimum level</Field.Label>
		<NativeSelect.Root id="{prefix}-level" name="minLevel" {value} class="w-full">
			<NativeSelect.Option value="">Every level</NativeSelect.Option>
			{#each LEVELS as level (level)}
				<NativeSelect.Option value={level}>{level} and above</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	</Field.Field>
{/snippet}

{#if data.canEdit}
	<FormDialog
		bind:open={createOpen}
		icon={LogsIcon}
		title="Add a log drain"
		description="Lines logged from now on are forwarded. Send a test line after adding it."
		action="?/create"
		submitLabel="Add drain"
		size="lg"
	>
		<input type="hidden" name="kind" value={kind} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="drain-name">Name</Field.Label>
					<Input
						id="drain-name"
						name="name"
						placeholder="archive"
						required
						maxlength={64}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label>Receiver</Field.Label>
					<ToggleGroup.Root
						type="single"
						variant="outline"
						value={kind}
						onValueChange={(value) => value && (kind = value as 'webhook' | 'otlp')}
						class="w-full"
						aria-label="Receiver kind"
					>
						<ToggleGroup.Item value="webhook" class="flex-1">Webhook</ToggleGroup.Item>
						<ToggleGroup.Item value="otlp" class="flex-1">OTLP</ToggleGroup.Item>
					</ToggleGroup.Root>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="drain-url">URL</Field.Label>
				<Input
					id="drain-url"
					name="url"
					type="url"
					required
					placeholder={kind === 'otlp'
						? 'https://otlp-gateway.example.com/otlp'
						: 'https://logs.example.com/yoal'}
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>
					{#if kind === 'otlp'}
						OTLP/HTTP with JSON encoding; <code class="font-mono">/v1/logs</code> is added to a bare origin.
					{:else}
						Yoal POSTs batches signed with <code class="font-mono">X-Yoal-Signature</code>; the
						secret is shown once, after adding.
					{/if}
				</Field.Description>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="drain-project">Project</Field.Label>
					<NativeSelect.Root
						id="drain-project"
						name="project"
						bind:value={createProject}
						class="w-full"
					>
						<NativeSelect.Option value="">Whole organisation</NativeSelect.Option>
						{#each data.projects as project (project.slug)}
							<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				{#if kind === 'webhook'}
					<Field.Field>
						<Field.Label for="drain-format">Body</Field.Label>
						<NativeSelect.Root id="drain-format" name="format" value="ndjson" class="w-full">
							<NativeSelect.Option value="ndjson"
								>NDJSON (one line per log line)</NativeSelect.Option
							>
							<NativeSelect.Option value="json">JSON array</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
				{:else}
					{@render levelField('drain', '')}
				{/if}
			</div>
			{#if kind === 'webhook'}{@render levelField('drain', '')}{/if}
			{@render sourceFields('drain', [], createProject !== '')}
			<Field.Field>
				<Field.Label for="drain-headers">
					Headers <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Textarea
					id="drain-headers"
					name="headers"
					rows={2}
					placeholder="Authorization: Bearer …"
					spellcheck="false"
					autocomplete="off"
					class="font-mono text-xs"
				/>
				<Field.Description>
					One <code class="font-mono">Name: value</code> per line, sent with every request. Values are
					sealed and never shown again.
				</Field.Description>
			</Field.Field>
			{#if data.canPlatform}
				<Field.Field orientation="horizontal">
					<Checkbox id="drain-private" name="allowPrivateNetwork" />
					<Field.Content>
						<Field.Label for="drain-private">Allow private addresses</Field.Label>
						<Field.Description>
							Platform admins only: lets the drain reach a collector on the LAN, loopback or
							link-local addresses, over plain http too.
						</Field.Description>
					</Field.Content>
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={editOpen}
		icon={PencilIcon}
		title="Edit {editing?.name ?? 'drain'}"
		description="Changes apply to the next batch."
		action="?/update"
		submitLabel="Save"
		size="lg"
	>
		{#if editing}
			{#key editing.id}
				<input type="hidden" name="id" value={editing.id} />
				<Field.Group>
					<Field.Field>
						<Field.Label for="edit-url">URL</Field.Label>
						<Input
							id="edit-url"
							name="url"
							required
							value={editing.url}
							spellcheck="false"
							class="font-mono text-sm"
						/>
						{#if editing.url.includes('=***')}
							<Field.Description>
								Query values are hidden. To change the URL, enter it again in full.
							</Field.Description>
						{/if}
					</Field.Field>
					<div class="grid gap-4 sm:grid-cols-2">
						{#if editing.kind === 'webhook'}
							<Field.Field>
								<Field.Label for="edit-format">Body</Field.Label>
								<NativeSelect.Root
									id="edit-format"
									name="format"
									value={editing.format ?? 'ndjson'}
									class="w-full"
								>
									<NativeSelect.Option value="ndjson">NDJSON</NativeSelect.Option>
									<NativeSelect.Option value="json">JSON array</NativeSelect.Option>
								</NativeSelect.Root>
							</Field.Field>
						{/if}
						{@render levelField('edit', editing.minLevel ?? '')}
					</div>
					{@render sourceFields('edit', editing.sources, editing.project !== null)}
					<Field.Field>
						<Field.Label for="edit-headers">Replace headers</Field.Label>
						<Textarea
							id="edit-headers"
							name="headers"
							rows={2}
							placeholder={editing.headerNames.length
								? `Leave blank to keep ${editing.headerNames.join(', ')}`
								: 'Authorization: Bearer …'}
							spellcheck="false"
							autocomplete="off"
							class="font-mono text-xs"
						/>
						<Field.Description>
							Values are write-only. Anything entered here replaces every current header.
						</Field.Description>
					</Field.Field>
					{#if editing.headerNames.length}
						<Field.Field orientation="horizontal">
							<Checkbox id="edit-clear-headers" name="clearHeaders" />
							<Field.Label for="edit-clear-headers" class="font-normal"
								>Remove all headers</Field.Label
							>
						</Field.Field>
					{/if}
				</Field.Group>
			{/key}
		{/if}
	</FormDialog>
{/if}

{#if secret}
	<SecretDialog
		bind:open={secretOpen}
		title="Signing secret for {secret.name}"
		description={secret.note}
		value={secret.value}
	>
		<p class="text-xs text-muted-foreground">
			Each request carries <code class="font-mono"
				>X-Yoal-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code
			>, where the hex is HMAC-SHA256 of <code class="font-mono">&lt;t&gt;.&lt;raw body&gt;</code>
			with this secret. Reject old <code class="font-mono">t</code> values to stop replays.
		</p>
	</SecretDialog>
{/if}
