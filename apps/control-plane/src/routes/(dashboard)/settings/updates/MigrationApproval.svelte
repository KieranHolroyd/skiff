<script lang="ts">
	import { enhance } from '$app/forms';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DatabaseZapIcon from '@lucide/svelte/icons/database-zap';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import type { SelfUpdateApproval, SelfUpdateMethod } from '@skiff/contracts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import Panel from '../../_lib/Panel.svelte';

	/**
	 * The updater refused a release because it ships destructive migrations (it never runs those
	 * unattended). Show what each one does and its SQL, and let an admin approve exactly these
	 * migrations: the approval carries each one's SQL hash, so the updater accepts it only for the
	 * SQL shown here.
	 */
	let {
		approval,
		currentVersion,
		method,
		channel,
		disabled = false,
		previousUpdatedAt = null,
		onrequested
	}: {
		approval: SelfUpdateApproval;
		currentVersion: string;
		method: SelfUpdateMethod;
		channel: string;
		disabled?: boolean;
		/** Called with the status timestamp from before the request, once it is queued. */
		onrequested: (previousUpdatedAt: string | null) => void;
		previousUpdatedAt?: string | null;
	} = $props();

	let open = $state(false);
	let reviewed = $state(false);
	let requesting = $state(false);
	let form = $state<HTMLFormElement | null>(null);

	const one = $derived(approval.migrations.length === 1);
	const statementCount = $derived(
		approval.migrations.reduce((total, migration) => total + migration.statements.length, 0)
	);

	function openDialog() {
		reviewed = false;
		open = true;
	}
</script>

<Panel
	title="v{approval.version} needs your approval"
	icon={ShieldAlertIcon}
	description="It ships {one
		? 'a database migration that changes or removes existing data'
		: `${approval.migrations.length} database migrations that change or remove existing data`}. Skiff never runs these unattended. Review the SQL, then approve it to install the update."
>
	<div class="space-y-3">
		{#each approval.migrations as migration (migration.id)}
			<Collapsible.Root class="rounded-lg border">
				<Collapsible.Trigger
					class="group flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40"
				>
					<ChevronRightIcon
						class="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
					/>
					<DatabaseZapIcon class="size-4 shrink-0 text-warning" />
					<span class="min-w-0 flex-1 truncate font-mono text-xs font-medium">{migration.id}</span>
					<span class="flex flex-wrap justify-end gap-1">
						{#each migration.statements as statement (`${statement.line}-${statement.statement}`)}
							<Badge variant="warning" class="font-mono font-normal">
								{statement.statement} · line {statement.line}
							</Badge>
						{/each}
					</span>
				</Collapsible.Trigger>
				<Collapsible.Content class="border-t p-3">
					<CodeBlock
						code={migration.sql}
						label={migration.id}
						lang="sql"
						class="max-h-96 overflow-y-auto"
					/>
					{#if migration.truncated}
						<p class="mt-2 text-xs text-muted-foreground">
							Showing the first 64 KB. Read the full file in the release's packages/db/migrations.
						</p>
					{/if}
				</Collapsible.Content>
			</Collapsible.Root>
		{/each}
	</div>

	{#snippet footer()}
		<div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<span>
				The control database is snapshotted before the update and restored if it rolls back. Managed
				databases and storage are not touched.
			</span>
			<Button class="shrink-0" variant="destructive" {disabled} onclick={openDialog}>
				<ShieldAlertIcon />Review and approve…
			</Button>
		</div>
	{/snippet}
</Panel>

<AlertDialog.Root bind:open>
	<AlertDialog.Content class="sm:max-w-lg">
		<AlertDialog.Header>
			<AlertDialog.Media class="bg-destructive/10 text-destructive">
				<ShieldAlertIcon />
			</AlertDialog.Media>
			<AlertDialog.Title>Approve and update to v{approval.version}?</AlertDialog.Title>
			<AlertDialog.Description>
				{one ? 'This migration' : 'These migrations'} will run against the control database ({statementCount}
				destructive {statementCount === 1 ? 'statement' : 'statements'}). v{currentVersion} keeps serving
				until the new version passes its test boot.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<form
			bind:this={form}
			method="POST"
			action="?/update"
			class="space-y-4"
			use:enhance={({ formData }) => {
				// The status timestamp from before the request: a later one proves the run started.
				const previous = previousUpdatedAt;
				requesting = true;
				formData.set('method', method);
				formData.set('channel', channel);
				return async ({ result, update }) => {
					await update();
					requesting = false;
					open = false;
					if (result.type === 'success') onrequested(previous);
				};
			}}
		>
			<ul class="space-y-1.5 rounded-lg border bg-muted/30 p-3">
				{#each approval.migrations as migration (migration.id)}
					<li class="flex items-center justify-between gap-3 text-xs">
						<span class="truncate font-mono">{migration.id}</span>
						<span class="shrink-0 font-mono text-muted-foreground" title={migration.sha256}>
							sha256 {migration.sha256.slice(0, 12)}
						</span>
						<input type="hidden" name="approve" value="{migration.id} {migration.sha256}" />
					</li>
				{/each}
			</ul>
			<Field.Field orientation="horizontal">
				<Checkbox id="approve-reviewed" bind:checked={reviewed} />
				<Field.Content>
					<Field.Label for="approve-reviewed">I've reviewed the SQL and want it applied</Field.Label
					>
					<Field.Description>
						The approval covers exactly this SQL. If the release changes it, Skiff asks again.
					</Field.Description>
				</Field.Content>
			</Field.Field>
		</form>

		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={requesting}>Cancel</AlertDialog.Cancel>
			<Button
				variant="destructive"
				disabled={!reviewed || requesting}
				onclick={() => form?.requestSubmit()}
			>
				{#if requesting}<LoaderCircleIcon class="animate-spin" aria-hidden="true" />{/if}
				Approve and update
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
