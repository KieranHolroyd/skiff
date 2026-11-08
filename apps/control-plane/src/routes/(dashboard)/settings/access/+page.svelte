<script lang="ts">
	import { enhance } from '$app/forms';
	import CircleQuestionMarkIcon from '@lucide/svelte/icons/circle-question-mark';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import UsersIcon from '@lucide/svelte/icons/users';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Decision, GrantEvaluation, Permission, ScopeRef } from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { notify } from '#lib/actions.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	type PrincipalType = 'user' | 'group' | 'serviceAccount';
	type ScopeType = 'org' | 'project' | 'environment';

	let { data }: PageProps = $props();

	let createRoleOpen = $state(false);
	let bindingOpen = $state(false);
	let createGroupOpen = $state(false);

	let bindingPrincipalType = $state<PrincipalType>('user');
	let bindingScopeType = $state<ScopeType>('org');
	let bindingProject = $state('');
	let bindingEnvironment = $state('');

	let explainPermission = $state('');
	let explainResourceType = $state<ScopeType>('org');
	let explainProject = $state('');
	let explainEnvironment = $state('');
	let explainLoading = $state(false);
	let explainError = $state('');
	let explainResult = $state<Decision | null>(null);

	let addingMember = $state<string | null>(null);

	const roleById = $derived(new Map(data.roles.map((role) => [role.id, role])));
	const memberById = $derived(new Map(data.members.map((member) => [member.userId, member])));
	const groupById = $derived(new Map(data.groups.map((group) => [group.id, group])));
	const projectById = $derived(new Map(data.projects.map((project) => [project.id, project])));
	const bindingById = $derived(new Map(data.bindings.map((binding) => [binding.id, binding])));
	const riskByPermission = $derived(
		new Map(
			data.catalog.flatMap((group) =>
				group.permissions.map((entry) => [entry.permission, entry.risk] as const)
			)
		)
	);

	const PRINCIPAL_LABELS: Record<PrincipalType, string> = {
		user: 'User',
		group: 'Group',
		serviceAccount: 'Service account'
	};

	const REASONS: Record<string, string> = {
		binding: 'A binding grants it at a scope that covers this resource.',
		'no-binding': 'No binding grants it at a scope that covers this resource.',
		expired: 'A binding mentions it, but that binding has expired.',
		condition: 'A binding mentions it, but its condition does not hold right now.',
		restricted: 'A credential restriction removes it.',
		guardrail: 'A guardrail denies it, and a deny beats every allow.'
	};

	function riskVariant(risk: string | undefined): BadgeVariant {
		switch (risk) {
			case 'read':
				return 'neutral';
			case 'destructive':
				return 'danger';
			case 'secret':
				return 'warning';
			case 'admin':
				return 'brand';
			default:
				return 'outline';
		}
	}

	function outcomeVariant(outcome: GrantEvaluation['outcome']): BadgeVariant {
		switch (outcome) {
			case 'allow':
				return 'success';
			case 'expired':
				return 'neutral';
			case 'condition':
				return 'warning';
			case 'restricted':
				return 'danger';
			default:
				return 'outline';
		}
	}

	function roleName(roleId: string): string {
		return roleById.get(roleId)?.name ?? roleId;
	}

	function memberName(userId: string): string {
		return memberById.get(userId)?.name ?? userId;
	}

	function principalName(binding: { principalType: PrincipalType; principalId: string }): string {
		if (binding.principalType === 'user') return memberName(binding.principalId);
		if (binding.principalType === 'group')
			return groupById.get(binding.principalId)?.name ?? binding.principalId;
		return binding.principalId;
	}

	function projectName(projectId: string): string {
		return projectById.get(projectId)?.name ?? projectId;
	}

	function environmentName(projectId: string, environmentId: string): string {
		return (
			projectById.get(projectId)?.environments.find((entry) => entry.id === environmentId)?.name ??
			environmentId
		);
	}

	function scopeLabel(scope: ScopeRef): string {
		switch (scope.type) {
			case 'platform':
				return 'Platform';
			case 'org':
				return 'Whole organisation';
			case 'project':
				return `Project ${projectName(scope.id)}`;
			case 'environment':
				return `Environment ${environmentName(scope.projectId, scope.id)} · ${projectName(
					scope.projectId
				)}`;
			default:
				return `${scope.type} ${scope.id}`;
		}
	}

	function viaLabel(via: string | undefined): string {
		if (!via) return 'No binding or guardrail matched';
		const binding = bindingById.get(via);
		if (!binding) return `Guardrail ${via}`;
		return `${roleName(binding.roleId)} via ${principalName(binding)}`;
	}

	function availableMembers(groupId: string) {
		const current = new Set((data.groupMembers[groupId] ?? []).map((member) => member.userId));
		return data.members.filter((member) => !current.has(member.userId));
	}

	/** Coarse "in 3d" for an expiry; the exact time sits beside it. */
	function timeUntil(at: number): string {
		const seconds = Math.max(0, Math.round((at - data.now) / 1000));
		if (seconds < 60) return 'in under a minute';
		if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
		if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
		return `in ${Math.floor(seconds / 86_400)}d`;
	}

	function openBinding() {
		bindingPrincipalType = 'user';
		bindingScopeType = 'org';
		bindingProject = '';
		bindingEnvironment = '';
		bindingOpen = true;
	}

	function deleteRole(role: { id: string; name: string }) {
		askConfirm({
			title: `Delete the ${role.name} role?`,
			description:
				'A role still bound to anyone cannot be deleted: remove every binding first. Built-in roles are fixed and cannot be removed.',
			confirmLabel: 'Delete role',
			tone: 'danger',
			action: '?/deleteRole',
			fields: { roleId: role.id }
		});
	}

	function removeBinding(binding: { id: string; roleId: string; principalId: string }) {
		askConfirm({
			title: 'Remove this binding?',
			description:
				'Access granted by this binding stops at once. Other bindings, including ones through a group, are unaffected.',
			confirmLabel: 'Remove binding',
			tone: 'danger',
			action: '?/removeBinding',
			fields: { bindingId: binding.id }
		});
	}

	function removeGroupMember(group: { id: string; name: string }, member: { userId: string }) {
		askConfirm({
			title: `Remove ${memberName(member.userId)} from ${group.name}?`,
			description:
				'They lose any access this group grants. A binding made directly to them is unaffected.',
			confirmLabel: 'Remove member',
			tone: 'danger',
			action: '?/removeGroupMember',
			fields: { groupId: group.id, userId: member.userId }
		});
	}

	async function explain() {
		if (!explainPermission) {
			explainError = 'Pick a permission to check.';
			explainResult = null;
			return;
		}
		explainLoading = true;
		explainError = '';
		try {
			const params = [
				['permission', explainPermission],
				['resourceType', explainResourceType]
			] as Array<[string, string]>;
			if (explainResourceType === 'project') {
				params.push(['resourceId', explainProject]);
			} else if (explainResourceType === 'environment') {
				params.push(['resourceId', explainEnvironment]);
				params.push(['environmentId', explainEnvironment]);
				params.push(['projectId', explainProject]);
			}
			const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
			explainResult = await fetchJson<Decision>(`/api/v1/iam/explain?${query}`, {
				fallback: 'Could not explain that permission'
			});
		} catch (cause) {
			explainResult = null;
			explainError = errorText(cause);
		} finally {
			explainLoading = false;
		}
	}
</script>

<svelte:head><title>Access · Settings · Skiff</title></svelte:head>

<SettingsHeader id="access" />

<div class="space-y-6">
	<Panel
		title="Roles"
		icon={ShieldCheckIcon}
		count={data.roles.length}
		description="A role is a named set of permissions. Built-in roles are fixed; custom roles belong to this organisation."
		flush
	>
		{#snippet actions()}
			{#if data.accessCan.manageRoles}
				<Button size="sm" onclick={() => (createRoleOpen = true)}><PlusIcon />Create role</Button>
			{/if}
		{/snippet}

		<div class="divide-y">
			{#each data.roles as role (role.id)}
				<div class="px-4 py-4">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 space-y-1">
							<p class="flex flex-wrap items-center gap-2">
								<span class="font-mono text-sm font-medium">{role.name}</span>
								<Badge variant={role.builtIn ? 'neutral' : 'outline'}>
									{role.builtIn ? 'Built-in' : 'Custom'}
								</Badge>
								<Badge variant="secondary" class="tabular-nums">
									{role.permissions.length}
									{role.permissions.length === 1 ? 'permission' : 'permissions'}
								</Badge>
							</p>
							<p class="max-w-2xl text-xs text-pretty text-muted-foreground">
								{role.description || 'No description.'}
							</p>
						</div>
						{#if !role.builtIn && data.accessCan.manageRoles}
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Delete the {role.name} role"
								onclick={() => deleteRole(role)}
							>
								<TrashIcon />
							</Button>
						{/if}
					</div>

					{#if role.builtIn}
						<details class="mt-2">
							<summary class="cursor-pointer text-xs text-muted-foreground">
								Show {role.permissions.length} permissions
							</summary>
							{@render permissionChips(role.permissions)}
						</details>
					{:else}
						{@render permissionChips(role.permissions)}
					{/if}
				</div>
			{/each}
		</div>

		{#snippet footer()}
			<span>
				Built-in roles are read-only. A custom role in use by a binding cannot be deleted: remove
				the binding first.
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Bindings"
		icon={UserRoundIcon}
		count={data.bindings.length}
		description="Who gets a role, and where. A user with only project bindings is a guest: they see only those projects."
		flush
	>
		{#snippet actions()}
			{#if data.accessCan.manageBindings}
				<Button size="sm" onclick={openBinding}><PlusIcon />Add binding</Button>
			{/if}
		{/snippet}

		{#if data.bindings.length === 0}
			<div class="p-4">
				<EmptyState
					icon={UserRoundIcon}
					compact
					title="No bindings yet"
					description="Members get their base role as an organisation binding automatically. Add a binding to grant a role to a person, group or service account at a project, environment or the whole organisation."
				>
					{#if data.accessCan.manageBindings}
						<Button size="sm" onclick={openBinding}><PlusIcon />Add a binding</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Principal</Table.Head>
						<Table.Head>Role</Table.Head>
						<Table.Head class="hidden lg:table-cell">Scope</Table.Head>
						<Table.Head class="hidden md:table-cell">Expires</Table.Head>
						<Table.Head class="hidden xl:table-cell">Reason</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.bindings as binding (binding.id)}
						<Table.Row>
							<Table.Cell class="max-w-72 pl-4">
								<p class="flex flex-wrap items-center gap-1.5 text-sm font-medium">
									{principalName(binding)}
								</p>
								<p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
									<Badge variant="outline">{PRINCIPAL_LABELS[binding.principalType]}</Badge>
									<span class="truncate font-mono" title={binding.principalId}
										>{binding.principalId}</span
									>
								</p>
							</Table.Cell>
							<Table.Cell>
								<span class="font-mono text-sm">{roleName(binding.roleId)}</span>
								<p class="mt-0.5 text-xs text-muted-foreground">
									{roleById.get(binding.roleId)?.builtIn ? 'Built-in' : 'Custom'}
								</p>
							</Table.Cell>
							<Table.Cell class="hidden lg:table-cell">
								<p class="text-sm">{scopeLabel(binding.scope)}</p>
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								{#if binding.expiresAt === null}
									<p class="text-sm text-muted-foreground">No expiry</p>
								{:else}
									<p class="text-sm">{formatDateTime(binding.expiresAt)}</p>
									<p class="mt-0.5 text-xs text-muted-foreground">
										{#if binding.expiresAt <= data.now}
											<Badge variant="danger">Expired</Badge>
										{:else}
											{timeUntil(binding.expiresAt)}
										{/if}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden max-w-64 xl:table-cell">
								<p
									class="truncate text-xs text-muted-foreground"
									title={binding.reason ?? undefined}
								>
									{binding.reason || '—'}
								</p>
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.accessCan.manageBindings}
									<RowMenu label="Actions for the {principalName(binding)} binding">
										<DropdownMenu.Item
											variant="destructive"
											onSelect={() => removeBinding(binding)}
										>
											<TrashIcon />Remove binding
										</DropdownMenu.Item>
									</RowMenu>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				Bindings are additive and scopes nest: an organisation binding covers every project,
				environment and resource. An expired binding grants nothing.
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Groups"
		icon={UsersIcon}
		count={data.groups.length}
		description="Grant access once to a team. Every member of a group inherits the roles bound to it."
		flush
	>
		{#snippet actions()}
			{#if data.accessCan.manageGroups}
				<Button size="sm" onclick={() => (createGroupOpen = true)}><PlusIcon />Create group</Button>
			{/if}
		{/snippet}

		{#if data.groups.length === 0}
			<div class="p-4">
				<EmptyState
					icon={UsersIcon}
					compact
					title="No groups yet"
					description="Create a group, add members, then bind a role to the group. SCIM and SSO can also sync groups from your identity provider."
				>
					{#if data.accessCan.manageGroups}
						<Button size="sm" onclick={() => (createGroupOpen = true)}
							><PlusIcon />Create a group</Button
						>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<div class="divide-y">
				{#each data.groups as group (group.id)}
					{@const members = data.groupMembers[group.id] ?? []}
					{@const available = availableMembers(group.id)}
					<div class="space-y-3 px-4 py-4">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0 space-y-1">
								<p class="flex flex-wrap items-center gap-2">
									<span class="text-sm font-medium">{group.name}</span>
									<Badge variant={group.source === 'local' ? 'outline' : 'info'}>
										{group.source === 'local'
											? 'Local'
											: `Managed by ${group.source.toUpperCase()}`}
									</Badge>
									<Badge variant="secondary" class="tabular-nums">
										{members.length}
										{members.length === 1 ? 'member' : 'members'}
									</Badge>
								</p>
								<p class="max-w-2xl text-xs text-pretty text-muted-foreground">
									{group.description || 'No description.'}
								</p>
							</div>
						</div>

						{#if members.length === 0}
							<p class="text-xs text-muted-foreground">No members yet.</p>
						{:else}
							<ul class="flex flex-wrap gap-1.5">
								{#each members as member (member.userId)}
									<li>
										<span
											class="inline-flex items-center gap-1 rounded-4xl border bg-muted/40 py-0.5 pr-1 pl-2 text-xs"
										>
											<span>{member.name}</span>
											{#if data.accessCan.manageGroups && group.source === 'local'}
												<Button
													size="icon-xs"
													variant="ghost"
													aria-label="Remove {member.name} from {group.name}"
													onclick={() => removeGroupMember(group, member)}
												>
													<XIcon />
												</Button>
											{/if}
										</span>
									</li>
								{/each}
							</ul>
						{/if}

						{#if data.accessCan.manageGroups && group.source === 'local'}
							{#if available.length > 0}
								<form
									method="POST"
									action="?/addGroupMember"
									class="flex flex-wrap items-end gap-2"
									use:enhance={() => {
										addingMember = group.id;
										return async ({ result, update }) => {
											notify(result);
											await update({ reset: true });
											addingMember = null;
										};
									}}
								>
									<input type="hidden" name="groupId" value={group.id} />
									<div class="grid gap-1 text-xs text-muted-foreground">
										<label for="add-member-{group.id}">Add a member</label>
										<NativeSelect.Root
											id="add-member-{group.id}"
											name="userId"
											required
											class="w-56"
										>
											<NativeSelect.Option value="">Pick a member</NativeSelect.Option>
											{#each available as member (member.userId)}
												<NativeSelect.Option value={member.userId}>
													{member.email ? `${member.name} (${member.email})` : member.name}
												</NativeSelect.Option>
											{/each}
										</NativeSelect.Root>
									</div>
									<Button
										type="submit"
										size="sm"
										variant="outline"
										disabled={addingMember === group.id}
									>
										<PlusIcon />{addingMember === group.id ? 'Adding…' : 'Add'}
									</Button>
								</form>
							{:else}
								<p class="text-xs text-muted-foreground">
									Every member of this organisation is already in the group.
								</p>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#snippet footer()}
			<span>
				Group membership follows the group's bindings. Groups synced from SCIM or SSO are read-only
				here.
			</span>
		{/snippet}
	</Panel>

	<Panel
		title="Why can't I?"
		icon={CircleQuestionMarkIcon}
		description="Ask the authorization engine what it decides for you, and which bindings it considered."
	>
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void explain();
			}}
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="explain-permission">Permission</Field.Label>
					<NativeSelect.Root
						id="explain-permission"
						name="permission"
						required
						bind:value={explainPermission}
						class="w-full"
					>
						<NativeSelect.Option value="">Pick a permission</NativeSelect.Option>
						{#each data.catalog as group (group.resource)}
							<NativeSelect.OptGroup label={group.label}>
								{#each group.permissions as entry (entry.permission)}
									<NativeSelect.Option value={entry.permission}>
										{entry.permission}
									</NativeSelect.Option>
								{/each}
							</NativeSelect.OptGroup>
						{/each}
					</NativeSelect.Root>
				</Field.Field>

				<Field.Field>
					<Field.Label for="explain-resource">Resource</Field.Label>
					<NativeSelect.Root
						id="explain-resource"
						name="resourceType"
						value={explainResourceType}
						onchange={(event) => {
							explainResourceType = event.currentTarget.value as ScopeType;
							explainResult = null;
						}}
						class="w-full"
					>
						<NativeSelect.Option value="org">The whole organisation</NativeSelect.Option>
						<NativeSelect.Option value="project">A project</NativeSelect.Option>
						<NativeSelect.Option value="environment">An environment</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
			</div>

			{#if explainResourceType !== 'org'}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="explain-project">Project</Field.Label>
						<NativeSelect.Root
							id="explain-project"
							name="projectId"
							required
							bind:value={explainProject}
							onchange={() => (explainEnvironment = '')}
							class="w-full"
						>
							<NativeSelect.Option value="">Pick a project</NativeSelect.Option>
							{#each data.projects as project (project.id)}
								<NativeSelect.Option value={project.id}>{project.name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					{#if explainResourceType === 'environment'}
						<Field.Field>
							<Field.Label for="explain-environment">Environment</Field.Label>
							<NativeSelect.Root
								id="explain-environment"
								name="environmentId"
								required
								bind:value={explainEnvironment}
								class="w-full"
							>
								<NativeSelect.Option value="">Pick an environment</NativeSelect.Option>
								{#each projectById.get(explainProject)?.environments ?? [] as environment (environment.id)}
									<NativeSelect.Option value={environment.id}>
										{environment.name}
									</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
						</Field.Field>
					{/if}
				</div>
			{/if}

			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" variant="outline" disabled={explainLoading}>
					<CircleQuestionMarkIcon />{explainLoading ? 'Checking…' : 'Check access'}
				</Button>
				{#if explainError}
					<p class="text-sm text-destructive">{explainError}</p>
				{/if}
			</div>
		</form>

		{#if explainResult}
			<div class="mt-5 space-y-3 rounded-lg border bg-muted/20 p-4">
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant={explainResult.allow ? 'success' : 'danger'}>
						{explainResult.allow ? 'Allowed' : 'Denied'}
					</Badge>
					<span class="text-sm font-medium">
						{REASONS[explainResult.reason] ?? explainResult.reason}
					</span>
				</div>
				<p class="text-xs text-muted-foreground">
					Decided by <span class="font-medium text-foreground">{viaLabel(explainResult.via)}</span>.
				</p>

				{#if explainResult.chain.length > 0}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Binding</Table.Head>
								<Table.Head>Scope</Table.Head>
								<Table.Head class="w-0">Outcome</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each explainResult.chain as entry (entry.bindingId + entry.outcome)}
								<Table.Row>
									<Table.Cell>
										<span class="font-mono text-xs">{roleName(entry.roleId)}</span>
										<p class="mt-0.5 font-mono text-xs text-muted-foreground">
											{entry.bindingId}
										</p>
									</Table.Cell>
									<Table.Cell class="text-xs">{scopeLabel(entry.scope)}</Table.Cell>
									<Table.Cell>
										<Badge variant={outcomeVariant(entry.outcome)}>{entry.outcome}</Badge>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{:else}
					<p class="text-xs text-muted-foreground">
						No grant mentions this permission for your principal.
					</p>
				{/if}
			</div>
		{/if}
	</Panel>
</div>

{#if data.accessCan.manageRoles}
	<FormDialog
		bind:open={createRoleOpen}
		icon={ShieldCheckIcon}
		title="Create a role"
		description="Pick the permissions this role grants. A role applies wherever it is bound: organisation, project or environment."
		action="?/createRole"
		submitLabel="Create role"
		size="lg"
	>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="role-name">Name</Field.Label>
				<Input
					id="role-name"
					name="name"
					placeholder="release-manager"
					required
					minlength={2}
					maxlength={40}
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>Lowercase letters, digits and single hyphens.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="role-description">
					Description <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Input id="role-description" name="description" maxlength={200} />
			</Field.Field>
		</div>

		<Field.Set>
			<Field.Legend variant="label">Permissions</Field.Legend>
			<Field.Description>The role needs at least one.</Field.Description>
			<div class="max-h-80 space-y-4 overflow-y-auto rounded-lg border p-3">
				{#each data.catalog as group (group.resource)}
					<fieldset class="space-y-2">
						<legend class="text-xs font-medium text-muted-foreground">{group.label}</legend>
						<div class="grid gap-1.5 sm:grid-cols-2">
							{#each group.permissions as entry (entry.permission)}
								<Field.Field orientation="horizontal" class="gap-2">
									<Checkbox
										id="permission-{entry.permission.replaceAll(':', '-')}"
										name="permissions"
										value={entry.permission}
									/>
									<Field.Label
										for="permission-{entry.permission.replaceAll(':', '-')}"
										class="font-mono text-xs font-normal"
									>
										{entry.permission}
									</Field.Label>
									<Badge variant={riskVariant(entry.risk)}>{entry.risk}</Badge>
								</Field.Field>
							{/each}
						</div>
					</fieldset>
				{/each}
			</div>
		</Field.Set>
	</FormDialog>
{/if}

{#if data.accessCan.manageBindings}
	<FormDialog
		bind:open={bindingOpen}
		icon={UserRoundIcon}
		title="Add a binding"
		description="Grant a role to a person, group or service account. A project binding for someone with no organisation binding makes them a guest."
		action="?/createBinding"
		submitLabel="Add binding"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="binding-principal-type">Binding for</Field.Label>
					<NativeSelect.Root
						id="binding-principal-type"
						name="principalType"
						value={bindingPrincipalType}
						onchange={(event) => {
							bindingPrincipalType = event.currentTarget.value as PrincipalType;
						}}
						class="w-full"
					>
						<NativeSelect.Option value="user">A person</NativeSelect.Option>
						<NativeSelect.Option value="group">A group</NativeSelect.Option>
						<NativeSelect.Option value="serviceAccount">A service account</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>

				<Field.Field>
					{#if bindingPrincipalType === 'user'}
						<Field.Label for="binding-principal">Member</Field.Label>
						<NativeSelect.Root id="binding-principal" name="principalId" required class="w-full">
							<NativeSelect.Option value="">Pick a member</NativeSelect.Option>
							{#each data.members as member (member.userId)}
								<NativeSelect.Option value={member.userId}>
									{member.email ? `${member.name} (${member.email})` : member.name}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{:else if bindingPrincipalType === 'group'}
						<Field.Label for="binding-principal">Group</Field.Label>
						<NativeSelect.Root id="binding-principal" name="principalId" required class="w-full">
							<NativeSelect.Option value="">Pick a group</NativeSelect.Option>
							{#each data.groups as group (group.id)}
								<NativeSelect.Option value={group.id}>{group.name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{:else}
						<Field.Label for="binding-principal">Service account id</Field.Label>
						<Input
							id="binding-principal"
							name="principalId"
							required
							placeholder="sa_…"
							autocapitalize="off"
							spellcheck="false"
							class="font-mono text-sm"
						/>
						<Field.Description>
							Service accounts get their own id on their Access page.
						</Field.Description>
					{/if}
				</Field.Field>
			</div>

			<Field.Field>
				<Field.Label for="binding-role">Role</Field.Label>
				<NativeSelect.Root id="binding-role" name="roleId" required class="w-full">
					<NativeSelect.Option value="">Pick a role</NativeSelect.Option>
					{#each data.roles as role (role.id)}
						<NativeSelect.Option value={role.id}>
							{role.name}{role.builtIn ? ' (built-in)' : ' (custom)'}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="binding-scope">Scope</Field.Label>
					<NativeSelect.Root
						id="binding-scope"
						name="scopeType"
						value={bindingScopeType}
						onchange={(event) => {
							bindingScopeType = event.currentTarget.value as ScopeType;
							bindingProject = '';
							bindingEnvironment = '';
						}}
						class="w-full"
					>
						<NativeSelect.Option value="org">The whole organisation</NativeSelect.Option>
						<NativeSelect.Option value="project">One project</NativeSelect.Option>
						<NativeSelect.Option value="environment">One environment</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>

				{#if bindingScopeType !== 'org'}
					<Field.Field>
						<Field.Label for="binding-project">Project</Field.Label>
						<NativeSelect.Root
							id="binding-project"
							name="projectId"
							required
							bind:value={bindingProject}
							onchange={() => (bindingEnvironment = '')}
							class="w-full"
						>
							<NativeSelect.Option value="">Pick a project</NativeSelect.Option>
							{#each data.projects as project (project.id)}
								<NativeSelect.Option value={project.id}>{project.name}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
				{/if}
			</div>

			{#if bindingScopeType === 'environment'}
				<Field.Field>
					<Field.Label for="binding-environment">Environment</Field.Label>
					<NativeSelect.Root
						id="binding-environment"
						name="environmentId"
						required
						bind:value={bindingEnvironment}
						class="w-full"
					>
						<NativeSelect.Option value="">Pick an environment</NativeSelect.Option>
						{#each projectById.get(bindingProject)?.environments ?? [] as environment (environment.id)}
							<NativeSelect.Option value={environment.id}>{environment.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="binding-expiry">
						Expires <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input id="binding-expiry" name="expiresAt" type="datetime-local" />
					<Field.Description>Leave blank for a standing grant.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="binding-reason">
						Reason <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input id="binding-reason" name="reason" maxlength={500} />
					<Field.Description>Shown in the binding list and the audit log.</Field.Description>
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.accessCan.manageGroups}
	<FormDialog
		bind:open={createGroupOpen}
		icon={UsersIcon}
		title="Create a group"
		description="Add members after creating it, then bind a role to the group."
		action="?/createGroup"
		submitLabel="Create group"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="group-name">Name</Field.Label>
				<Input
					id="group-name"
					name="name"
					placeholder="engineering"
					required
					minlength={2}
					maxlength={40}
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>Letters, digits and single hyphens.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="group-description">
					Description <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Textarea id="group-description" name="description" rows={2} maxlength={200} />
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet permissionChips(permissions: readonly Permission[])}
	<ul class="mt-2 flex flex-wrap gap-1.5">
		{#each permissions as permission (permission)}
			<li>
				<Badge variant={riskVariant(riskByPermission.get(permission))} class="font-mono">
					{permission}
				</Badge>
			</li>
		{/each}
	</ul>
{/snippet}
