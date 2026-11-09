<script lang="ts">
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import UsersIcon from '@lucide/svelte/icons/users';
	import {
		databaseNamedCredentialRoles,
		type DatabaseCredentialReveal,
		type DatabaseCredentialView,
		type DatabaseView
	} from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import { formatDate, formatDateTime } from '../../_lib/format.js';

	/**
	 * Named Postgres credentials (docs/DATABASES.md §16). The list is metadata only; a password
	 * arrives from an audited reveal and lives in component state until hidden.
	 */
	let {
		db,
		credentials,
		can,
		fieldErrors = {}
	}: {
		db: DatabaseView;
		credentials: DatabaseCredentialView[];
		/** From `databaseCan` (page data). */
		can: { credentials: boolean; update: boolean };
		fieldErrors?: Record<string, string>;
	} = $props();

	const ROLE_HINTS: Record<string, string> = {
		owner: 'Owns the database; created with it.',
		monitor: 'Read-only stats role the agent samples metrics with.',
		app: 'Reads and writes tables in the public schema; cannot change roles or the database.',
		readonly: 'SELECT only, for reporting and BI tools.',
		backup: 'Reads everything a dump needs, writes nothing.'
	};

	const deleted = $derived(db.deletedAt !== null);
	const manage = $derived(can.credentials && can.update && !deleted);
	const isNamed = (credential: DatabaseCredentialView) =>
		credential.role !== 'owner' && credential.role !== 'monitor';

	/** Projects attached as each credential; revoke is refused while this is non-empty. */
	const usedBy = $derived(
		db.attachments.reduce<Record<string, string[]>>((acc, attachment) => {
			if (attachment.credentialId)
				(acc[attachment.credentialId] ??= []).push(attachment.projectSlug);
			return acc;
		}, {})
	);

	let createOpen = $state(false);
	let createRole = $state<string>('app');

	let revealed = $state<DatabaseCredentialReveal | null>(null);
	let revealingId = $state<string | null>(null);

	async function reveal(credential: DatabaseCredentialView) {
		revealingId = credential.id;
		const outcome = await runAction('?/credential-reveal', { id: credential.id }, { apply: false });
		revealingId = null;
		if (outcome.type === 'success')
			revealed =
				(outcome.data as { credential?: DatabaseCredentialReveal } | undefined)?.credential ?? null;
	}

	function rotate(credential: DatabaseCredentialView) {
		const apps = usedBy[credential.id] ?? [];
		askConfirm({
			title: `Rotate ${credential.username}?`,
			description: `The node sets a new password and verifies it before Yoal swaps the stored secret.${
				apps.length
					? ` ${apps.join(', ')} then restart${apps.length === 1 ? 's' : ''} with it.`
					: ''
			} Anything else using the old password must be updated.`,
			confirmLabel: 'Rotate password',
			tone: 'danger',
			action: '?/credential-rotate',
			fields: { id: credential.id },
			onResult: () => {
				if (revealed?.id === credential.id) revealed = null;
			}
		});
	}

	function revoke(credential: DatabaseCredentialView) {
		askConfirm({
			title: `Revoke ${credential.username}?`,
			description:
				'The node disables the role’s login on its next pull. Anything still connecting with it is locked out. This cannot be undone; create a new credential instead.',
			confirmLabel: 'Revoke credential',
			tone: 'danger',
			action: '?/credential-revoke',
			fields: { id: credential.id },
			onResult: () => {
				if (revealed?.id === credential.id) revealed = null;
			}
		});
	}

	function revealedUrl(credential: DatabaseCredentialReveal) {
		const user = encodeURIComponent(credential.username);
		const pass = encodeURIComponent(credential.password);
		const tls = db.tls.enabled ? `?sslmode=${db.tls.mode}` : '';
		return {
			value: `postgres://${user}:${pass}@${db.internalHost.process}/${db.databaseName}${tls}`,
			display: `postgres://${user}:••••••••@${db.internalHost.process}/${db.databaseName}${tls}`
		};
	}

	function openCreate() {
		createRole = 'app';
		createOpen = true;
	}
</script>

<Panel
	title="Credentials"
	icon={UsersIcon}
	count={credentials.filter((credential) => credential.status !== 'revoked').length}
	description="Postgres roles an app can connect as. Owner and monitor come with the database; app, readonly and backup are opt-in."
	flush
>
	{#snippet actions()}
		{#if manage}
			<Button size="sm" variant="outline" onclick={openCreate}><PlusIcon />New credential</Button>
		{/if}
	{/snippet}

	{#if revealed}
		{@const url = revealedUrl(revealed)}
		<div class="border-b p-4">
			<div class="mb-2 flex items-center justify-between gap-3">
				<p class="text-sm font-medium">
					<span class="font-mono">{revealed.username}</span>
					<span class="text-muted-foreground">· {revealed.role}</span>
				</p>
				<Button variant="ghost" size="sm" onclick={() => (revealed = null)}>
					<EyeOffIcon />Hide
				</Button>
			</div>
			<DetailList>
				<dt>Password</dt>
				<dd><CopyValue value={revealed.password} label="password" secret /></dd>
				<dt>URL · process apps</dt>
				<dd><CopyValue value={url.value} label="URL" display={url.display} secret /></dd>
			</DetailList>
			<p class="mt-2 text-xs text-muted-foreground">
				This read was audited. Attached apps get the value as env; you rarely need to copy it.
			</p>
		</div>
	{/if}

	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head class="pl-4">Credential</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="hidden md:table-cell">Used by</Table.Head>
				<Table.Head class="hidden lg:table-cell">Expires</Table.Head>
				<Table.Head class="hidden lg:table-cell">Last revealed</Table.Head>
				<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each credentials as credential (credential.id)}
				{@const apps = usedBy[credential.id] ?? []}
				{@const active = credential.status !== 'revoked' && credential.status !== 'revoking'}
				{@const expired =
					credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now()}
				<Table.Row class={active ? undefined : 'opacity-60'}>
					<Table.Cell class="pl-4">
						<span class="font-mono text-xs">{credential.username}</span>
						<div
							class="flex items-center gap-1.5 text-xs text-muted-foreground"
							title={ROLE_HINTS[credential.role]}
						>
							<Badge variant="outline" class="h-4 px-1.5 text-[10px]">{credential.role}</Badge>
							{#if credential.purpose}<span class="truncate">{credential.purpose}</span>{/if}
						</div>
					</Table.Cell>
					<Table.Cell>
						{#if expired && active}
							<StatusBadge status="expired" tone="warning" />
						{:else}
							<StatusBadge status={credential.status} />
						{/if}
					</Table.Cell>
					<Table.Cell class="hidden text-xs md:table-cell">
						{#if credential.role === 'owner'}
							<span class="text-muted-foreground">Default for attached apps</span>
						{:else if apps.length}
							<span class="font-mono">{apps.join(', ')}</span>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					</Table.Cell>
					<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
						{credential.expiresAt ? formatDate(credential.expiresAt) : 'Never'}
					</Table.Cell>
					<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
						{credential.lastUsedAt ? formatDateTime(credential.lastUsedAt) : '—'}
					</Table.Cell>
					<Table.Cell class="pr-4">
						{#if isNamed(credential) && active && (can.credentials || manage)}
							<RowMenu label="Actions for {credential.username}">
								{#if can.credentials && credential.status === 'ready' && !expired}
									<DropdownMenu.Item
										disabled={revealingId === credential.id}
										onSelect={() => reveal(credential)}
									>
										<KeyRoundIcon />Reveal password
									</DropdownMenu.Item>
								{/if}
								{#if manage}
									<DropdownMenu.Item onSelect={() => rotate(credential)}>
										<RefreshCwIcon />Rotate password…
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										variant="destructive"
										disabled={apps.length > 0}
										title={apps.length
											? `Detach ${apps.join(', ')} first; ${apps.length === 1 ? 'it connects' : 'they connect'} as this credential.`
											: undefined}
										onSelect={() => revoke(credential)}
									>
										<ShieldOffIcon />Revoke…
									</DropdownMenu.Item>
								{/if}
							</RowMenu>
						{/if}
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>

	{#snippet footer()}
		<span>
			Owner and monitor rotate from the header menu. Attach a project with a named credential to
			give it less than owner rights.
			{#if !can.credentials}
				Revealing and managing credentials needs <code class="font-mono">database:credentials</code
				>.
			{/if}
		</span>
	{/snippet}
</Panel>

{#if manage}
	<FormDialog
		bind:open={createOpen}
		icon={UsersIcon}
		title="New credential"
		description="Yoal creates a separate Postgres role with its own generated password. The node provisions it on its next pull."
		action="?/credential-create"
		submitLabel="Create credential"
	>
		<Field.Group>
			<Field.Field data-invalid={fieldErrors.role ? true : undefined}>
				<Field.Label for="credential-role">Role</Field.Label>
				<NativeSelect.Root id="credential-role" name="role" class="w-full" bind:value={createRole}>
					{#each databaseNamedCredentialRoles as role (role)}
						<NativeSelect.Option value={role}>{role}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>{ROLE_HINTS[createRole]}</Field.Description>
				{#if fieldErrors.role}<Field.Error>{fieldErrors.role}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.purpose ? true : undefined}>
				<Field.Label for="credential-purpose"
					>Purpose <span class="text-muted-foreground">(optional)</span></Field.Label
				>
				<Input
					id="credential-purpose"
					name="purpose"
					maxlength={120}
					placeholder="Metabase, nightly export…"
					aria-invalid={fieldErrors.purpose ? 'true' : undefined}
				/>
				{#if fieldErrors.purpose}<Field.Error>{fieldErrors.purpose}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.expires || fieldErrors.expiresAt ? true : undefined}>
				<Field.Label for="credential-expires"
					>Expires <span class="text-muted-foreground">(optional)</span></Field.Label
				>
				<Input
					id="credential-expires"
					name="expires"
					type="date"
					aria-invalid={fieldErrors.expires || fieldErrors.expiresAt ? 'true' : undefined}
				/>
				<Field.Description>
					Stops working at the end of that day (UTC). Leave empty to keep it until revoked.
				</Field.Description>
				{#if fieldErrors.expires || fieldErrors.expiresAt}
					<Field.Error>{fieldErrors.expires ?? fieldErrors.expiresAt}</Field.Error>
				{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
