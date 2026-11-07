<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { runAction } from '#lib/actions.js';
	import ModelPicker from '#lib/assistant/ModelPicker.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { AssistantModelInfo } from '@skiff/contracts';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import ConfigProgress from '../ConfigProgress.svelte';
	import PolicyPanel from '../_lib/PolicyPanel.svelte';
	import type { PageProps } from './$types';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';

	let { data, form }: PageProps = $props();
	const fieldErrors = $derived(
		(form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}
	);

	let setupOpen = $state(false);
	let testing = $state(false);

	// OpenRouter's catalogue, loaded on demand (never on a plain dashboard page).
	let openRouterModels = $state<AssistantModelInfo[]>([]);
	let modelsLoading = $state(false);
	let modelsLoaded = $state(false);
	let modelsAttempted = $state(false);
	let modelsError = $state('');

	async function loadOpenRouterModels(force = false) {
		if (modelsLoading || (modelsLoaded && !force)) return;
		modelsAttempted = true;
		modelsLoading = true;
		modelsError = '';
		try {
			const response = await fetch(
				`/api/v1/assistant/models?provider=openrouter${force ? '&refresh=1' : ''}`,
				{ headers: { accept: 'application/json' } }
			);
			const body = (await response.json().catch(() => null)) as {
				models?: AssistantModelInfo[];
				message?: string;
			} | null;
			if (!response.ok) throw new Error(body?.message ?? `OpenRouter answered ${response.status}.`);
			openRouterModels = body?.models ?? [];
			modelsLoaded = true;
		} catch (error) {
			modelsError = error instanceof Error ? error.message : String(error);
		} finally {
			modelsLoading = false;
		}
	}

	// Switching to OpenRouter sets its canonical base URL. Switching away restores the OpenAI one.
	$effect(() => {
		if (provider === 'openrouter') {
			if (!baseUrl || baseUrl === 'https://api.openai.com/v1')
				baseUrl = 'https://openrouter.ai/api/v1';
			// OpenRouter ids are namespaced (`vendor/model`). Clear a bare id from another provider.
			if (model && !model.includes('/')) model = '';
		} else if (baseUrl === 'https://openrouter.ai/api/v1') {
			baseUrl = 'https://api.openai.com/v1';
		}
	});

	// Instructions and tools (owner-only)
	let agentOpen = $state(false);
	let editInstructions = $state('');
	let editModel = $state('');
	let editAllTools = $state(true);
	let editTools = $state<string[]>([]);
	let toolFilter = $state('');

	const catalogNames = $derived(new Set(data.catalog.map((tool) => tool.name)));
	const toolCount = $derived(
		data.agent.tools
			? data.agent.tools.filter((name) => catalogNames.has(name)).length
			: data.catalog.length
	);

	const filteredCatalog = $derived.by(() => {
		const query = toolFilter.trim().toLowerCase();
		if (!query) return data.catalog;
		return data.catalog.filter(
			(tool) =>
				tool.name.includes(query) ||
				tool.title.toLowerCase().includes(query) ||
				tool.description.toLowerCase().includes(query)
		);
	});

	function editAgent() {
		editInstructions = data.agent.instructions;
		editModel = data.agent.model ?? '';
		editAllTools = data.agent.tools === null;
		editTools = (data.agent.tools ?? data.catalog.map((tool) => tool.name)).filter((name) =>
			catalogNames.has(name)
		);
		toolFilter = '';
		agentOpen = true;
	}

	function resetAgent() {
		askConfirm({
			title: 'Reset the assistant?',
			description:
				'Its instructions, model override and tool list return to the built-in defaults: every tool you can use.',
			confirmLabel: 'Reset',
			action: '?/resetAgent'
		});
	}

	const canEdit = $derived(data.availability === 'ready' || data.availability === 'local');
	const ready = $derived(canEdit && !data.inFlight);
	const values = $derived(data.assistant.values);
	const keySaved = $derived(data.assistant.secretsSet.includes('SKIFF_ASSISTANT_API_KEY'));

	let provider = $state('');
	let baseUrl = $state('');
	let model = $state('');
	let initialized = $state(false);

	$effect(() => {
		if (initialized) return;
		initialized = true;
		provider = values.SKIFF_ASSISTANT_PROVIDER ?? 'openai-compatible';
		baseUrl = values.SKIFF_ASSISTANT_BASE_URL ?? '';
		model = values.SKIFF_ASSISTANT_MODEL ?? '';
	});

	$effect(() => {
		if (
			(setupOpen || agentOpen) &&
			provider === 'openrouter' &&
			!modelsLoaded &&
			!modelsLoading &&
			!modelsAttempted
		)
			void loadOpenRouterModels();
	});

	async function test() {
		testing = true;
		await runAction('?/test', {}, { apply: false });
		testing = false;
	}

	function remove() {
		askConfirm({
			title: 'Turn off the dashboard assistant?',
			description:
				'The launcher and the chat API stop working. Your model provider is untouched, and the existing conversation in this browser is discarded.',
			confirmLabel: 'Turn off',
			tone: 'danger',
			action: '?/remove'
		});
	}
</script>

<svelte:head><title>Assistant · Settings · Skiff</title></svelte:head>

<SettingsHeader id="assistant" />

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['assistant']}
	/>

	<Panel
		title="Dashboard assistant"
		icon={SparklesIcon}
		description="An optional chat panel over the same MCP tools your agents use, with a guided tour that can point at anything on screen."
	>
		{#snippet actions()}
			<StatusBadge
				status={data.assistant.configured ? 'active' : 'unverified'}
				label={data.assistant.configured ? 'Enabled' : 'Not set up'}
			/>
		{/snippet}

		{#if data.assistant.configured}
			<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Provider</dt>
					<dd class="font-mono text-sm">
						{values.SKIFF_ASSISTANT_PROVIDER ?? 'openai-compatible'}
					</dd>
				</div>
				<div class="space-y-1 sm:col-span-2">
					<dt class="text-xs text-muted-foreground">Base URL</dt>
					<dd class="font-mono text-sm break-all">{values.SKIFF_ASSISTANT_BASE_URL ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Model</dt>
					<dd class="font-mono text-sm">{values.SKIFF_ASSISTANT_MODEL ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">API key</dt>
					<dd class="flex items-center gap-1.5 text-sm">
						<KeyRoundIcon class="size-3.5 text-muted-foreground" />
						{keySaved ? 'Saved (write-only)' : 'Not set'}
					</dd>
				</div>
			</dl>
		{:else}
			<EmptyState
				icon={SparklesIcon}
				compact
				title="The assistant is not set up"
				description="Point Skiff at an OpenAI-compatible endpoint — OpenAI, OpenRouter, vLLM, LM Studio or a local Ollama — to turn on the chat panel. Nothing is sent anywhere until then."
			>
				{#if canEdit}
					<Button onclick={() => (setupOpen = true)} disabled={!ready}
						><SparklesIcon />Set up</Button
					>
				{/if}
			</EmptyState>
		{/if}

		{#snippet footer()}
			{#if data.assistant.configured}
				<div class="flex w-full flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onclick={test} disabled={testing}>
						{#if testing}<Spinner />{:else}<SendIcon />{/if}
						Test provider
					</Button>
					{#if canEdit}
						<Button variant="outline" size="sm" onclick={() => (setupOpen = true)} disabled={!ready}
							><SettingsIcon />Edit</Button
						>
						<span class="flex-1"></span>
						<Button variant="ghost-danger" size="sm" onclick={remove} disabled={!ready}
							><Trash2Icon />Turn off</Button
						>
					{/if}
				</div>
			{:else}
				The assistant is optional and off by default. Only an owner can configure it.
			{/if}
		{/snippet}
	</Panel>

	<Panel
		title="Instructions and tools"
		icon={BotIcon}
		description="One assistant answers every question with the MCP tools the signed-in user may call. Only the owner can change its instructions, model or tools."
	>
		<div class="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="flex flex-wrap items-center gap-2">
					<p class="font-medium">Skiff assistant</p>
					{#if data.agent.customized}
						<Badge variant="outline">Customized</Badge>
					{/if}
					{#if data.agent.model}
						<Badge variant="outline" class="font-mono">{data.agent.model}</Badge>
					{/if}
				</div>
				<p class="text-sm text-muted-foreground">
					{data.agent.tools === null
						? `All ${toolCount} tools`
						: `${toolCount} of ${data.catalog.length} tools`} · {data.agent.instructions.length.toLocaleString()}
					characters of instructions
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				<Button variant="outline" size="sm" onclick={editAgent}>
					<SettingsIcon />Edit
				</Button>
				{#if data.agent.customized}
					<Button variant="ghost" size="sm" onclick={resetAgent}>Reset</Button>
				{/if}
			</div>
		</div>
		<div class="mt-4 space-y-2">
			<Alert.Root>
				<SparklesIcon />
				<Alert.Title>One service layer, one audit trail</Alert.Title>
				<Alert.Description>
					Every tool call is the same call the MCP server and dashboard make. Chat actions are
					audited as <code class="font-mono text-xs">assistant.&lt;tool&gt;</code>. Destructive
					calls are held for an explicit Confirm in the chat. Database and storage credentials are
					never returned to the model.
				</Alert.Description>
			</Alert.Root>
			<Alert.Root variant="warning">
				<KeyRoundIcon />
				<Alert.Title>Model traffic leaves the server</Alert.Title>
				<Alert.Description>
					Prompts and tool results are sent to the base URL you configure. Use a local endpoint (for
					example Ollama at <code class="font-mono text-xs">http://127.0.0.1:11434/v1</code>) if
					that should stay on the host.
				</Alert.Description>
			</Alert.Root>
		</div>
	</Panel>

	<PolicyPanel group="assistant" policies={data.policies} defaults={data.policyDefaults} {form}>
		{#if !data.assistant.configured}
			<p class="mb-5 text-sm text-muted-foreground">
				The assistant is not set up yet. These caps apply once it is.
			</p>
		{/if}
	</PolicyPanel>
</div>

<FormDialog
	bind:open={setupOpen}
	icon={SparklesIcon}
	title={data.assistant.configured ? 'Edit the assistant' : 'Set up the assistant'}
	description="Skiff lists the provider's models before saving, so a wrong URL or key is caught here."
	action="?/save"
	submitLabel="Check provider and save"
	size="lg"
>
	<Field.Group>
		<Field.Field data-invalid={fieldErrors.provider ? true : undefined}>
			<Field.Label for="assistant-provider">Provider</Field.Label>
			<NativeSelect.Root id="assistant-provider" name="provider" bind:value={provider}>
				<NativeSelect.Option value="openai-compatible">OpenAI-compatible</NativeSelect.Option>
				<NativeSelect.Option value="openai">OpenAI</NativeSelect.Option>
				<NativeSelect.Option value="openrouter">OpenRouter</NativeSelect.Option>
				<NativeSelect.Option value="ollama">Ollama</NativeSelect.Option>
			</NativeSelect.Root>
			<Field.Description>
				One protocol covers OpenAI, OpenRouter, vLLM, LM Studio and Ollama's
				<code class="font-mono text-xs">/v1</code> endpoint.
			</Field.Description>
		</Field.Field>

		<Field.Field data-invalid={fieldErrors.baseUrl ? true : undefined}>
			<Field.Label for="assistant-base-url">Base URL</Field.Label>
			<Input
				id="assistant-base-url"
				name="baseUrl"
				required
				autocomplete="off"
				spellcheck={false}
				class="font-mono"
				bind:value={baseUrl}
				placeholder={provider === 'openrouter'
					? 'https://openrouter.ai/api/v1'
					: 'https://api.openai.com/v1'}
				aria-invalid={fieldErrors.baseUrl ? 'true' : undefined}
			/>
			{#if fieldErrors.baseUrl}<Field.Error>{fieldErrors.baseUrl}</Field.Error>
			{:else}<Field.Description
					>No trailing slash. The client calls <code class="font-mono text-xs"
						>/chat/completions</code
					>.</Field.Description
				>{/if}
		</Field.Field>

		<Field.Field data-invalid={fieldErrors.model ? true : undefined}>
			<div class="flex items-center justify-between gap-2">
				<Field.Label for={provider === 'openrouter' ? undefined : 'assistant-model'}
					>Model</Field.Label
				>
				{#if provider === 'openrouter'}
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onclick={() => loadOpenRouterModels(true)}
						disabled={modelsLoading}
					>
						{#if modelsLoading}<Spinner />{:else}Refresh list{/if}
					</Button>
				{/if}
			</div>
			{#if provider === 'openrouter'}
				{#if modelsLoading && !modelsLoaded}
					<div class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
						<Spinner />Loading OpenRouter's tool-capable models…
					</div>
				{:else if modelsError}
					<Alert.Root variant="destructive">
						<TriangleAlertIcon />
						<Alert.Title>Could not load OpenRouter models</Alert.Title>
						<Alert.Description>{modelsError}</Alert.Description>
					</Alert.Root>
					<Input
						id="assistant-model"
						name="model"
						required
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						bind:value={model}
						placeholder="Enter a model id manually, e.g. openai/gpt-4.1-mini"
						aria-invalid={fieldErrors.model ? 'true' : undefined}
					/>
				{:else}
					<ModelPicker models={openRouterModels} bind:value={model} name="model" />
				{/if}
			{:else}
				<Input
					id="assistant-model"
					name="model"
					required
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					bind:value={model}
					placeholder="gpt-4.1-mini"
					aria-invalid={fieldErrors.model ? 'true' : undefined}
				/>
			{/if}
			{#if fieldErrors.model}<Field.Error>{fieldErrors.model}</Field.Error>
			{:else if provider === 'openrouter' && !modelsError}<Field.Description
					>Only models that advertise tool calling are listed.</Field.Description
				>{/if}
		</Field.Field>

		<Field.Field data-invalid={fieldErrors.apiKey ? true : undefined}>
			<Field.Label for="assistant-api-key">API key</Field.Label>
			<Input
				id="assistant-api-key"
				name="apiKey"
				type="password"
				autocomplete="new-password"
				placeholder={keySaved ? 'Saved — leave blank to keep' : 'Optional for a local endpoint'}
				aria-invalid={fieldErrors.apiKey ? 'true' : undefined}
			/>
			{#if fieldErrors.apiKey}<Field.Error>{fieldErrors.apiKey}</Field.Error>
			{:else}<Field.Description
					>Stored write-only on the server. It is never sent back to this browser or to the model.</Field.Description
				>{/if}
		</Field.Field>
	</Field.Group>
</FormDialog>

<FormDialog
	bind:open={agentOpen}
	icon={BotIcon}
	title="Edit the assistant"
	description="Changes apply to the next assistant turn."
	action="?/saveAgent"
	submitLabel="Save"
	size="lg"
>
	<input type="hidden" name="allTools" value={editAllTools ? '1' : ''} />
	{#if !editAllTools}
		{#each editTools as name (name)}
			<input type="hidden" name="tools" value={name} />
		{/each}
	{/if}
	<Field.Group>
		<Field.Field>
			<Field.Label for={provider === 'openrouter' ? undefined : 'agent-model'}
				>Model override</Field.Label
			>
			{#if provider === 'openrouter' && modelsLoaded && !modelsError}
				<ModelPicker models={openRouterModels} bind:value={editModel} name="model" allowEmpty />
			{:else}
				<Input
					id="agent-model"
					name="model"
					class="font-mono"
					bind:value={editModel}
					autocomplete="off"
					spellcheck={false}
					placeholder="Use the platform model"
				/>
				<Field.Description>Leave blank to use the main assistant model.</Field.Description>
			{/if}
		</Field.Field>

		<Field.Field>
			<Field.Label for="agent-instructions">Instructions</Field.Label>
			<Textarea
				id="agent-instructions"
				name="instructions"
				rows={12}
				class="max-h-96 min-h-48 font-mono text-xs"
				bind:value={editInstructions}
			/>
			<Field.Description>
				The assistant's full system prompt. Keep the safety rules; add guidance specific to your
				platform.
			</Field.Description>
		</Field.Field>

		<Field.Field orientation="horizontal" class="gap-2">
			<Switch id="agent-all-tools" bind:checked={editAllTools} />
			<Field.Label for="agent-all-tools" class="font-normal">Every tool</Field.Label>
			<Field.Description
				>Offer every MCP tool the signed-in user may call, including tools added later.</Field.Description
			>
		</Field.Field>

		{#if !editAllTools}
			<Field.Field>
				<div class="flex flex-wrap items-center justify-between gap-2">
					<Field.Label>Tools</Field.Label>
					<div class="flex items-center gap-1">
						<Button
							type="button"
							variant="outline"
							size="xs"
							onclick={() => (editTools = data.catalog.map((tool) => tool.name))}
						>
							All
						</Button>
						<Button type="button" variant="outline" size="xs" onclick={() => (editTools = [])}>
							None
						</Button>
					</div>
				</div>
				<Input
					bind:value={toolFilter}
					placeholder="Filter by name, title or description…"
					autocomplete="off"
					class="mt-1"
				/>
				<div class="mt-2 max-h-64 overflow-y-auto rounded-lg border p-2">
					{#each filteredCatalog as tool (tool.name)}
						<label class="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted">
							<input
								type="checkbox"
								value={tool.name}
								bind:group={editTools}
								class="mt-0.5 size-4 shrink-0 accent-brand"
							/>
							<span class="min-w-0 flex-1">
								<span class="text-sm font-medium">{tool.title}</span>
								<span class="ml-1 font-mono text-xs text-muted-foreground">{tool.name}</span>
								{#if tool.destructive}
									<Badge variant="outline" class="ml-1 align-middle">confirm</Badge>
								{/if}
								<span class="block text-xs text-muted-foreground">{tool.description}</span>
							</span>
						</label>
					{:else}
						<p class="p-2 text-sm text-muted-foreground">No tools match that filter.</p>
					{/each}
				</div>
				<Field.Description>
					{editTools.length} of {data.catalog.length} selected. Destructive tools are still held for an
					explicit Confirm in the chat.
				</Field.Description>
			</Field.Field>
		{/if}
	</Field.Group>
</FormDialog>
