<script lang="ts">
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import type { ProjectView, SecretView } from '@yoal/core';
	import type { FunctionView } from '@yoal/contracts';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { formatRelative } from '../../_lib/format.js';
	import {
		SECRET_NAME_PATTERN,
		bindingsBySecret,
		secretBindings,
		secretIndex
	} from '../../_lib/function-view.js';

	/**
	 * The Variables tab for a function (FN8). Plain variables are `vars` in the bundle, so they are
	 * shown, not edited. Secrets are stored here and *bound* in the manifest: a binding decides what
	 * the Worker receives, so storing one never changes the running spec.
	 */
	let {
		project,
		view,
		secrets,
		fieldErrors,
		can
	}: {
		project: ProjectView;
		view: FunctionView | null;
		secrets: SecretView[];
		fieldErrors?: Record<string, string>;
		/** `updateSecret` rotates this function's own secret; `createSecret` adds a new name. */
		can: { createSecret: boolean; updateSecret: boolean; deleteSecret: boolean };
	} = $props();

	const vars = $derived(
		(view?.bindings ?? []).filter((binding) => binding.type === 'text' || binding.type === 'json')
	);
	const bound = $derived(secretBindings(view?.bindings ?? []));
	/** Store secrets visible to this project; a project secret shadows an org one of the same name. */
	const byName = $derived(secretIndex(secrets, project.id));
	const boundBy = $derived(bindingsBySecret(bound));
	const missing = $derived(bound.filter((row) => !byName.has(row.secret)));
	const rows = $derived(
		[...byName.values()]
			.filter((secret) => secret.type === 'secret')
			.sort(
				(a, b) =>
					Number(boundBy.has(b.name)) - Number(boundBy.has(a.name)) || a.name.localeCompare(b.name)
			)
	);

	let addOpen = $state(false);
	let name = $state('');
	const nameProblem = $derived(
		name && !SECRET_NAME_PATTERN.test(name) ? 'Use UPPER_SNAKE_CASE, starting with a letter.' : null
	);

	function openAdd(prefill = '') {
		name = prefill;
		addOpen = true;
	}

	function remove(secret: SecretView) {
		const users = boundBy.get(secret.name);
		askConfirm({
			title: `Delete secret ${secret.name}?`,
			description: users?.length
				? `Binding ${users.join(', ')} still names it. The running host keeps its value until it restarts; the next deploy fails until the secret exists again.`
				: 'No binding in the active deployment names it. The value cannot be recovered.',
			confirmLabel: 'Delete secret',
			tone: 'danger',
			action: '?/deleteSecret',
			fields: { secretId: secret.id }
		});
	}
</script>

<div class="space-y-5">
	{#if missing.length > 0}
		<Notice tone="warning" title="Bound secrets are missing">
			{missing.map((row) => row.secret).join(', ')}
			{missing.length === 1 ? 'is' : 'are'} named by the active deployment but no longer in the store.
			The running host keeps its value until it restarts; the next deploy will fail.
		</Notice>
	{/if}

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<KeyRoundIcon class="size-4 text-muted-foreground" />
				Secrets
			</Card.Title>
			<Card.Description>
				Values are write-only and reach the host only at activation. Bind one in
				<code class="font-mono text-xs">yoal-function.json</code> with
				<code class="font-mono text-xs">{'{ "name": "API_KEY", "type": "secret" }'}</code>; add
				<code class="font-mono text-xs">"secret"</code> to read a differently named store entry.
			</Card.Description>
			{#if can.createSecret}
				<Card.Action class="self-center">
					<Button size="sm" variant="outline" onclick={() => openAdd()}
						><PlusIcon />Add secret</Button
					>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content class="px-0 py-0">
			{#if rows.length === 0 && missing.length === 0}
				<p class="px-6 py-4 text-sm text-muted-foreground">
					No secrets yet. Store one here before deploying a bundle that binds it; a deploy that
					names a missing secret is rejected.
				</p>
			{:else}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-6">Secret</Table.Head>
							<Table.Head>Bound as</Table.Head>
							<Table.Head class="hidden sm:table-cell">Scope</Table.Head>
							<Table.Head class="hidden md:table-cell">Updated</Table.Head>
							<Table.Head class="w-0 pr-6"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each missing as row (row.binding)}
							<Table.Row>
								<Table.Cell class="pl-6 font-mono text-xs font-medium">{row.secret}</Table.Cell>
								<Table.Cell class="font-mono text-xs">{row.binding}</Table.Cell>
								<Table.Cell class="hidden sm:table-cell"
									><Badge variant="warning">missing</Badge></Table.Cell
								>
								<Table.Cell class="hidden md:table-cell"></Table.Cell>
								<Table.Cell class="pr-6 text-right">
									{#if can.createSecret && SECRET_NAME_PATTERN.test(row.secret)}
										<Button size="xs" variant="outline" onclick={() => openAdd(row.secret)}
											>Set</Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
						{#each rows as secret (secret.id)}
							{@const users = boundBy.get(secret.name)}
							<Table.Row>
								<Table.Cell class="pl-6 font-mono text-xs font-medium">
									{secret.name}
									<span class="ml-1 font-sans text-muted-foreground">v{secret.version}</span>
								</Table.Cell>
								<Table.Cell class="font-mono text-xs">
									{#if users}{users.join(', ')}{:else}<span class="font-sans text-muted-foreground"
											>not bound</span
										>{/if}
								</Table.Cell>
								<Table.Cell class="hidden sm:table-cell">
									<Badge variant={secret.projectId ? 'outline' : 'neutral'}>
										{secret.projectId ? 'this function' : 'organisation'}
									</Badge>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{formatRelative(secret.createdAt)}
								</Table.Cell>
								<Table.Cell class="pr-6 text-right whitespace-nowrap">
									{#if can.updateSecret && secret.projectId === project.id}
										<Button size="xs" variant="ghost" onclick={() => openAdd(secret.name)}
											>Rotate</Button
										>
									{/if}
									{#if can.deleteSecret && secret.projectId === project.id}
										<Button
											size="icon-xs"
											variant="ghost-danger"
											aria-label="Delete {secret.name}"
											onclick={() => remove(secret)}><TrashIcon /></Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<BracesIcon class="size-4 text-muted-foreground" />
				Variables
				<Badge variant="neutral" class="tabular-nums">{vars.length}</Badge>
			</Card.Title>
			<Card.Description>
				Plain values come from <code class="font-mono text-xs">vars</code> in the bundle and ship with
				the code, so a rollback restores them too. Change them in your code and deploy.
			</Card.Description>
		</Card.Header>
		<Card.Content class="py-4">
			{#if !view}
				<p class="text-sm text-muted-foreground">Nothing deployed yet.</p>
			{:else if vars.length === 0}
				<p class="text-sm text-muted-foreground">The active deployment declares no variables.</p>
			{:else}
				<div class="flex flex-wrap gap-1.5">
					{#each vars as binding (binding.name)}
						<Badge variant="outline" class="font-mono text-xs">
							{binding.name}
							<span class="text-muted-foreground">{binding.type}</span>
						</Badge>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

{#if can.createSecret || can.updateSecret}
	<FormDialog
		bind:open={addOpen}
		icon={KeyRoundIcon}
		title={byName.get(name)?.projectId === project.id ? `Rotate ${name}` : 'Add a secret'}
		description="Stored encrypted for this function. A running host keeps its current value until it next activates."
		action="?/setSecret"
		submitLabel="Save secret"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="fn-secret-name">Name</Field.Label>
				<Input
					id="fn-secret-name"
					name="name"
					bind:value={name}
					placeholder="API_KEY"
					autocomplete="off"
					class="font-mono text-sm"
					aria-invalid={Boolean(nameProblem || fieldErrors?.name)}
					required
				/>
				{#if nameProblem || fieldErrors?.name}
					<Field.Error>{nameProblem ?? fieldErrors?.name}</Field.Error>
				{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="fn-secret-value">Value</Field.Label>
				<Input
					id="fn-secret-value"
					name="value"
					type="password"
					autocomplete="new-password"
					required
					class="font-mono text-sm"
				/>
				<Field.Description
					>Write-only. Nobody can read it back from the dashboard.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
