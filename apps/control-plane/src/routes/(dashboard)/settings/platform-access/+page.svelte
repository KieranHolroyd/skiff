<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let bindOpen = $state(false);
	let guardrailOpen = $state(false);

	const users = $derived(data.users);
	const bindings = $derived(data.bindings);
	const guardrails = $derived(data.guardrails);

	function userLabel(id: string): string {
		const user = users.find((entry) => entry.id === id);
		return user ? (user.email || user.name) : id;
	}

	function conditionLabel(condition: { op: string } | null): string {
		if (!condition) return 'Any credential';
		if (condition.op === 'credentialIn')
			return 'Dashboard session only (D129)';
		return condition.op;
	}

	function roleTone(roleId: string): 'danger' | 'info' | 'neutral' {
		if (roleId === 'platform-admin') return 'danger';
		if (roleId === 'platform-operator') return 'info';
		return 'neutral';
	}

	function unbind(id: string, roleId: string) {
		askConfirm({
			title: `Remove the ${roleId} binding?`,
			description: 'That user loses the platform permissions this role granted.',
			confirmLabel: 'Remove binding',
			tone: 'danger',
			action: '?/unbind',
			fields: { id },
		});
	}

	function removeGuardrail(id: string, name: string) {
		askConfirm({
			title: `Delete the guardrail “${name}”?`,
			description: 'The deny rule stops applying to every organisation at once.',
			confirmLabel: 'Delete guardrail',
			tone: 'danger',
			action: '?/deleteGuardrail',
			fields: { id },
		});
	}
</script>

<SettingsHeader
	id="platform-access"
	description="Platform roles apply across the whole install, never inside an organisation. A platform admin who needs org access still needs an org binding. Guardrails are deny rules that beat every allow."
>
	{#snippet actions()}
		{#if data.can.administer}
			<Button size="sm" onclick={() => (bindOpen = true)}><PlusIcon />Bind a role</Button>
		{/if}
	{/snippet}
</SettingsHeader>

{#if data.denied}
	<EmptyState
		icon={ShieldCheckIcon}
		title="Platform access permission required"
		description="You need a platform read to see platform bindings and guardrails."
	/>
{:else}
	<Card.Root>
		<Card.Header>
			<Card.Title>Platform roles</Card.Title>
			<Card.Description>
				<code>platform-admin</code> holds every platform permission, <code>platform-operator</code>
				runs nodes, drain, storage, HA and updates, and <code>platform-viewer</code> reads the fleet.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#each data.roles as role (role.id)}
				<div class="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2">
					<div class="min-w-0">
						<p class="font-mono text-sm font-medium">{role.id}</p>
						<p class="text-xs text-muted-foreground">{role.description}</p>
					</div>
					<Badge variant="outline" class="font-mono text-[10px]">{role.id}</Badge>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	{#if bindings.length === 0}
		<EmptyState
			icon={KeyRoundIcon}
			title="No platform bindings"
			description="The Better Auth admin flag seeds a platform-admin binding at boot. Bind operators and viewers here."
		>
			{#if data.can.administer}
				<Button size="sm" onclick={() => (bindOpen = true)}><PlusIcon />Bind a role</Button>
			{/if}
		</EmptyState>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Bindings</Card.Title>
				<Card.Description>Who holds which platform role, and under which credential rule.</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-2">
				{#each bindings as binding (binding.id)}
					<div class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
						<div class="min-w-0 space-y-0.5">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate text-sm font-medium">{userLabel(binding.principalId)}</span>
								<Badge variant={roleTone(binding.roleId)} class="font-mono text-[10px]">{binding.roleId}</Badge>
								<Badge variant="outline" class="text-[10px]">{conditionLabel(binding.condition)}</Badge>
							</div>
							<p class="text-xs text-muted-foreground">
								<span class="font-mono">{binding.principalId}</span>
								{#if binding.reason}· {binding.reason}{/if}
								{#if binding.expiresAt}· expires {formatRelative(binding.expiresAt)}{/if}
								· created {formatRelative(binding.createdAt)}
							</p>
						</div>
						{#if data.can.administer}
							<Button
								variant="ghost"
								size="xs"
								aria-label="Remove platform binding"
								onclick={() => unbind(binding.id, binding.roleId)}
							>
								<Trash2Icon class="size-3.5" />
							</Button>
						{/if}
					</div>
				{/each}
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-3">
			<div class="min-w-0 space-y-1">
				<Card.Title>Fleet-wide guardrails</Card.Title>
				<Card.Description>
					Deny rules stored with no organisation: every org's decisions load them, and a deny wins.
					Writes need a platform admin who also holds <code>iam:manage-guardrails</code>.
				</Card.Description>
			</div>
			{#if data.can.manageGuardrails}
				<Button variant="outline" size="sm" onclick={() => (guardrailOpen = true)}>
					<PlusIcon />New guardrail
				</Button>
			{/if}
		</Card.Header>
		<Card.Content class="space-y-2">
			{#if guardrails.length === 0}
				<p class="text-sm text-muted-foreground">No fleet-wide guardrails.</p>
			{:else}
				{#each guardrails as guardrail (guardrail.id)}
					<div class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
						<div class="min-w-0 space-y-0.5">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate text-sm font-medium">{guardrail.name}</span>
								<Badge variant={guardrail.enabled ? 'info' : 'outline'} class="text-[10px]">
									{guardrail.enabled ? 'enabled' : 'disabled'}
								</Badge>
								<Badge variant="outline" class="text-[10px]">
									{guardrail.scope ? guardrail.scope.type : 'fleet-wide'}
								</Badge>
							</div>
							<p class="font-mono text-xs text-muted-foreground">
								{guardrail.permissions.join(', ')}
							</p>
						</div>
						{#if data.can.manageGuardrails}
							<Button
								variant="ghost"
								size="xs"
								aria-label="Delete guardrail"
								onclick={() => removeGuardrail(guardrail.id, guardrail.name)}
							>
								<Trash2Icon class="size-3.5" />
							</Button>
						{/if}
					</div>
				{/each}
			{/if}
		</Card.Content>
	</Card.Root>
{/if}

<FormDialog
	bind:open={bindOpen}
	icon={KeyRoundIcon}
	title="Bind a platform role"
	description="Platform roles never grant access inside an organisation; that needs an org binding."
	action="?/bind"
	submitLabel="Bind role"
>
	<Field.Group>
		<Field.Field>
			<Field.Label for="platform-user">User</Field.Label>
			<NativeSelect.Root id="platform-user" name="userId" required>
				{#each users as user (user.id)}
					<NativeSelect.Option value={user.id}>
						{user.email || user.name} ({user.id})
					</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</Field.Field>
		<Field.Field>
			<Field.Label for="platform-role">Role</Field.Label>
			<NativeSelect.Root id="platform-role" name="roleId">
				{#each data.roles as role (role.id)}
					<NativeSelect.Option value={role.id}>{role.id}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</Field.Field>
		<Field.Field>
			<Field.Label for="platform-condition">Credential rule</Field.Label>
			<NativeSelect.Root id="platform-condition" name="condition">
				<NativeSelect.Option value="default">Dashboard session only (recommended, D129)</NativeSelect.Option>
				<NativeSelect.Option value="none">Allow any credential (quota-write exception)</NativeSelect.Option>
			</NativeSelect.Root>
			<Field.Description>
				Session-only bindings refuse API keys and MCP tokens. Choose the exception only for a
				role that must write quotas from the CLI.
			</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label for="platform-reason">Reason (optional)</Field.Label>
			<Input id="platform-reason" name="reason" maxlength={500} placeholder="On-call operator, quota CLI" />
		</Field.Field>
	</Field.Group>
</FormDialog>

<FormDialog
	bind:open={guardrailOpen}
	icon={ShieldCheckIcon}
	title="New fleet-wide guardrail"
	description="A deny rule that applies to every organisation. It beats every allow, including a platform admin's."
	action="?/createGuardrail"
	submitLabel="Create guardrail"
>
	<Field.Group>
		<Field.Field>
			<Field.Label for="guardrail-name">Name</Field.Label>
			<Input id="guardrail-name" name="name" required minlength={2} maxlength={80} placeholder="No destructive MCP" />
		</Field.Field>
		<Field.Field>
			<Field.Label for="guardrail-permissions">Permissions to deny</Field.Label>
			<Input
				id="guardrail-permissions"
				name="permissions"
				required
				placeholder="secret:read, iam:manage-bindings"
			/>
			<Field.Description>
				Comma or space separated. Use <code>all</code> to deny everything, or a <code>resource:*</code> pattern.
			</Field.Description>
		</Field.Field>
	</Field.Group>
</FormDialog>
