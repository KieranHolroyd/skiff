<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDate } from '../../../_lib/format.js';

	interface ProjectMember {
		id: string;
		userId: string;
		name: string;
		email: string | null;
		role: string;
		guest: boolean;
		joinedAt: string | null;
	}

	/**
	 * People with a direct binding on this project, including guests (IAM.md §8.2). A guest gets a
	 * `member` row for sign-in plus a project-scope binding; they never hold org permissions.
	 */
	let {
		members,
		can
	}: {
		members: ProjectMember[];
		can: { inviteGuest: boolean; updateGuest: boolean; removeGuest: boolean };
	} = $props();

	let inviteOpen = $state(false);
	let pending = $state<string | null>(null);

	async function changeRole(member: ProjectMember, role: string) {
		if (role === member.role) return;
		pending = member.id;
		await runAction('?/updateGuestRole', { bindingId: member.id, role });
		pending = null;
	}

	function remove(member: ProjectMember) {
		askConfirm({
			title: `Remove ${member.name} from this project?`,
			description:
				'Their project binding is deleted immediately. They keep their account and any other project access.',
			confirmLabel: 'Remove access',
			tone: 'danger',
			action: '?/removeGuest',
			fields: { bindingId: member.id }
		});
	}
</script>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="space-y-1.5">
				<Card.Title class="flex items-center gap-2">
					<UsersIcon class="size-4 text-muted-foreground" />People with access
					<Badge variant="secondary" class="tabular-nums">{members.length}</Badge>
				</Card.Title>
				<Card.Description>
					Direct project bindings. Guests see only the projects they are invited to and have no
					organisation-wide permissions.
				</Card.Description>
			</div>
			{#if can.inviteGuest}
				<Button size="sm" variant="outline" onclick={() => (inviteOpen = true)}
					><UserPlusIcon />Invite guest</Button
				>
			{/if}
		</div>
	</Card.Header>
	<Card.Content class="px-0">
		{#if members.length === 0}
			<div class="p-4">
				<EmptyState
					icon={UsersIcon}
					compact
					title="No direct project members"
					description="Org owners and admins already have access through their org role. Invite a guest to give someone this project only."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Member</Table.Head>
						<Table.Head>Project role</Table.Head>
						<Table.Head class="hidden md:table-cell">Added</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each members as member (member.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-2">
									<div class="min-w-0">
										<p class="flex items-center gap-2 truncate font-medium">
											<span class="truncate">{member.name}</span>
											{#if member.guest}<Badge variant="outline">guest</Badge>{/if}
										</p>
										<p class="truncate text-xs text-muted-foreground">
											{member.email ?? 'Email visible to owners and admins'}
										</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell>
								{#if can.updateGuest}
									<NativeSelect.Root
										size="sm"
										value={member.role}
										aria-label={`Project role for ${member.name}`}
										disabled={pending === member.id}
										onchange={(event) =>
											changeRole(member, (event.currentTarget as HTMLSelectElement).value)}
									>
										<NativeSelect.Option value="deployer">deployer</NativeSelect.Option>
										<NativeSelect.Option value="viewer">viewer</NativeSelect.Option>
										{#if member.role !== 'deployer' && member.role !== 'viewer'}
											<NativeSelect.Option value={member.role} disabled
												>{member.role}</NativeSelect.Option
											>
										{/if}
									</NativeSelect.Root>
								{:else}
									<Badge variant="neutral" class="capitalize">{member.role}</Badge>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
								{formatDate(member.joinedAt)}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if can.removeGuest}
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
</Card.Root>

<FormDialog
	bind:open={inviteOpen}
	icon={UserPlusIcon}
	title="Invite a guest to this project"
	description="They get an email with a link to join. On acceptance they can sign in and see this project only."
	action="?/inviteGuest"
	submitLabel="Send invitation"
	size="sm"
>
	<Field.Field>
		<Field.Label for="guest-email">Email address</Field.Label>
		<Input
			id="guest-email"
			name="email"
			type="email"
			autocomplete="off"
			placeholder="contractor@example.com"
			required
		/>
	</Field.Field>
	<Field.Set>
		<Field.Legend variant="label">Project role</Field.Legend>
		<div class="grid gap-2" role="radiogroup" aria-label="Project role">
			{#each [{ value: 'deployer', label: 'Deployer', hint: 'Deploy, promote, roll back and read logs on this project.' }, { value: 'viewer', label: 'Viewer', hint: 'Read this project, its deployments, environments and logs.' }] as role (role.value)}
				<label
					class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/40 has-checked:border-brand/50 has-checked:bg-brand/5 has-checked:ring-2 has-checked:ring-brand/15 has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
				>
					<input
						type="radio"
						name="role"
						value={role.value}
						checked={role.value === 'deployer'}
						class="mt-1 accent-(--brand)"
					/>
					<span class="min-w-0">
						<span class="block text-sm font-medium">{role.label}</span>
						<span class="block text-xs text-muted-foreground">{role.hint}</span>
					</span>
				</label>
			{/each}
		</div>
	</Field.Set>
	<p class="flex items-start gap-2 text-xs text-muted-foreground">
		<MailIcon class="mt-0.5 size-3.5 shrink-0" />
		The invitation creates a guest membership for sign-in and a binding on this project only.
	</p>
</FormDialog>
