<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDate } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { ROLE_DESCRIPTIONS, initials, roleBadge } from '../_lib/roles.js';
	import type { PageProps } from './$types';

	interface MembersFormResult {
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as MembersFormResult | null);

	let inviteOpen = $state(false);
	let pendingMember = $state<string | null>(null);

	const roleDescriptions = ROLE_DESCRIPTIONS;

	/** Owners can only be changed by owners, and the last owner stays an owner. */
	function canChangeRole(member: (typeof data.members)[number]) {
		if (!data.memberCan.updateRole) return false;
		if (member.role === 'owner' && data.actorRole !== 'owner') return false;
		return true;
	}

	function canRemove(member: (typeof data.members)[number]) {
		if (!data.memberCan.remove || member.self) return false;
		if (member.role === 'owner' && (data.actorRole !== 'owner' || data.ownerCount <= 1))
			return false;
		return true;
	}

	async function changeRole(member: (typeof data.members)[number], role: string) {
		if (role === member.role) return;
		pendingMember = member.id;
		await runAction('?/updateRole', { memberId: member.id, role });
		pendingMember = null;
	}

	function remove(member: (typeof data.members)[number]) {
		askConfirm({
			title: `Remove ${member.name}?`,
			description:
				'They lose access to this organisation immediately. Their API keys stop working for it.',
			confirmLabel: 'Remove member',
			tone: 'danger',
			action: '?/remove',
			fields: { memberId: member.id }
		});
	}

	function cancelInvitation(invitation: { id: string; email: string }) {
		askConfirm({
			title: `Cancel the invitation for ${invitation.email}?`,
			description: 'The invitation link stops working.',
			confirmLabel: 'Cancel invitation',
			tone: 'danger',
			action: '?/cancelInvitation',
			fields: { invitationId: invitation.id }
		});
	}
</script>

<svelte:head>
	<title>Members · Settings · Skiff</title>
</svelte:head>

<SettingsHeader id="members">
	{#snippet actions()}
		{#if data.memberCan.invite}
			<Button onclick={() => (inviteOpen = true)}><UserPlusIcon />Invite member</Button>
		{/if}
	{/snippet}
</SettingsHeader>

<div class="space-y-5">
	{#if data.loadError}
		<Alert.Root variant="warning">
			<TriangleAlertIcon />
			<Alert.Description>{data.loadError}</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<UsersIcon class="size-4 text-muted-foreground" />People
				<Badge variant="secondary" class="tabular-nums">{data.members.length}</Badge>
			</Card.Title>
			<Card.Description>
				Roles are enforced identically by the dashboard, API, CLI and MCP.
			</Card.Description>
		</Card.Header>
		<Card.Content class="px-0">
			{#if data.members.length === 0}
				<div class="p-4">
					<EmptyState icon={UsersIcon} compact title="No members loaded" />
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Member</Table.Head>
							<Table.Head>Role</Table.Head>
							<Table.Head class="hidden md:table-cell">Joined</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.members as member (member.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-3">
										<Avatar.Root class="size-8">
											<Avatar.Fallback class="text-xs">{initials(member.name)}</Avatar.Fallback>
										</Avatar.Root>
										<div class="min-w-0">
											<p class="flex items-center gap-2 font-medium">
												<span class="truncate">{member.name}</span>
												{#if member.self}<Badge variant="success">you</Badge>{/if}
											</p>
											<p class="truncate text-xs text-muted-foreground">
												{member.email ?? 'Email visible to owners and admins'}
											</p>
										</div>
									</div>
								</Table.Cell>
								<Table.Cell>
									{#if canChangeRole(member)}
										<NativeSelect.Root
											size="sm"
											value={member.role}
											aria-label={`Role for ${member.name}`}
											disabled={pendingMember === member.id}
											onchange={(event) =>
												changeRole(member, (event.currentTarget as HTMLSelectElement).value)}
										>
											{#each data.assignableRoles as role (role)}
												<NativeSelect.Option value={role} class="capitalize"
													>{role}</NativeSelect.Option
												>
											{/each}
											{#if !data.assignableRoles.includes(member.role)}
												<NativeSelect.Option value={member.role} disabled
													>{member.role}</NativeSelect.Option
												>
											{/if}
										</NativeSelect.Root>
									{:else}
										<Badge variant={roleBadge(member.role)} class="capitalize">{member.role}</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{formatDate(member.joinedAt)}
								</Table.Cell>
								<Table.Cell class="pr-4">
									{#if canRemove(member)}
										<Button variant="ghost-danger" size="sm" onclick={() => remove(member)}
											>Remove</Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
		{#if data.ownerCount <= 1}
			<Card.Footer class="border-t py-3 text-xs text-muted-foreground">
				The organisation's only owner can't be removed or demoted. Make someone else an owner first.
			</Card.Footer>
		{/if}
	</Card.Root>

	{#if data.memberCan.invite}
		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<Card.Title class="flex items-center gap-2">
					<MailIcon class="size-4 text-muted-foreground" />Pending invitations
					<Badge variant="secondary" class="tabular-nums">{data.invitations.length}</Badge>
				</Card.Title>
				<Card.Description>
					Skiff is invite-only: only invited email addresses can create an account. Invitees sign in
					with that email (GitHub, passkey or an email link) and accept.
				</Card.Description>
			</Card.Header>
			<Card.Content class="px-0">
				{#if data.invitations.length === 0}
					<div class="p-4">
						<EmptyState
							icon={MailIcon}
							compact
							title="No pending invitations"
							description="Invitations you send appear here until they are accepted or expire."
						/>
					</div>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Email</Table.Head>
								<Table.Head>Role</Table.Head>
								<Table.Head class="hidden md:table-cell">Expires</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.invitations as invitation (invitation.id)}
								<Table.Row>
									<Table.Cell class="pl-4 font-medium break-all">{invitation.email}</Table.Cell>
									<Table.Cell>
										<Badge variant={roleBadge(invitation.role)} class="capitalize"
											>{invitation.role}</Badge
										>
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{formatDate(invitation.expiresAt)}
									</Table.Cell>
									<Table.Cell class="pr-4">
										<div class="flex items-center justify-end gap-1">
											<CopyButton value={invitation.url} label="Copy invitation link" iconOnly />
											<Button
												variant="ghost-danger"
												size="sm"
												onclick={() => cancelInvitation(invitation)}>Cancel</Button
											>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<FormDialog
	bind:open={inviteOpen}
	icon={UserPlusIcon}
	title="Invite a member"
	description="They get an email with a link to join. You can also copy the link from the pending list."
	action="?/invite"
	submitLabel="Send invitation"
	size="sm"
>
	<Field.Field data-invalid={result?.fieldErrors?.email ? true : undefined}>
		<Field.Label for="invite-email">Email address</Field.Label>
		<Input
			id="invite-email"
			name="email"
			type="email"
			autocomplete="off"
			placeholder="teammate@example.com"
			required
			aria-invalid={result?.fieldErrors?.email ? 'true' : undefined}
		/>
		{#if result?.fieldErrors?.email}<Field.Error>{result.fieldErrors.email}</Field.Error>{/if}
	</Field.Field>
	<Field.Set>
		<Field.Legend variant="label">Role</Field.Legend>
		<div class="grid gap-2" role="radiogroup" aria-label="Role">
			{#each data.assignableRoles as role (role)}
				<label
					class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/40 has-checked:border-brand/50 has-checked:bg-brand/5 has-checked:ring-2 has-checked:ring-brand/15 has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
				>
					<input
						type="radio"
						name="role"
						value={role}
						checked={role ===
							(data.assignableRoles.includes('deployer') ? 'deployer' : data.assignableRoles[0])}
						class="mt-1 accent-(--brand)"
					/>
					<span class="min-w-0">
						<span class="block text-sm font-medium capitalize">{role}</span>
						<span class="block text-xs text-muted-foreground">{roleDescriptions[role]}</span>
					</span>
				</label>
			{/each}
		</div>
	</Field.Set>
</FormDialog>
