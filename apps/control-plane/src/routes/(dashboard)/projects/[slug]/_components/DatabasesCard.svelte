<script lang="ts">
	import { resolve } from '$app/paths';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { databaseEnvNames, nextEnvPrefix, type DatabaseAttachmentView } from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';

	/** Managed databases attached to a process/container project (D56). */
	let {
		slug,
		attachments,
		databases,
		warning = null,
		fieldErrors = {},
		can
	}: {
		slug: string;
		attachments: DatabaseAttachmentView[];
		databases: Array<{ name: string; version: string; engineLabel: string; nodeName: string }>;
		/** `warning` from the last attach (e.g. the app runs on another node). */
		warning?: string | null;
		fieldErrors?: Record<string, string>;
		can: { readDatabases: boolean; createDatabase: boolean; attachDatabase: boolean };
	} = $props();

	let attachOpen = $state(false);
	let prefix = $state('DATABASE');

	const createHref = $derived(
		`${resolve('/(dashboard)/databases')}?project=${encodeURIComponent(slug)}`
	);

	function openAttach() {
		prefix = nextEnvPrefix(
			'DATABASE',
			attachments.map((item) => item.envPrefix)
		);
		attachOpen = true;
	}

	function detach(item: DatabaseAttachmentView) {
		askConfirm({
			title: `Detach ${item.databaseName}?`,
			description: `${slug} restarts without ${item.envPrefix}_URL and the other ${item.envPrefix}_* variables. The database and its data are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detachDatabase',
			fields: { database: item.databaseName }
		});
	}
</script>

{#if can.readDatabases}
	<Panel
		title="Databases"
		icon={DatabaseIcon}
		count={attachments.length}
		description="Connection details are injected as env vars when the app starts. The app runs on the database's node."
		flush
	>
		{#snippet actions()}
			{#if can.attachDatabase && databases.length > 0}
				<Button size="sm" variant="outline" onclick={openAttach}><PlugIcon />Attach</Button>
			{/if}
			{#if can.createDatabase && can.attachDatabase}
				<Button size="sm" href={createHref}><PlusIcon />New database</Button>
			{/if}
		{/snippet}

		{#if warning}
			<div class="px-4 pt-4"><Notice tone="warning">{warning}</Notice></div>
		{/if}

		{#if attachments.length === 0}
			<div class="p-4">
				<EmptyState
					icon={DatabaseIcon}
					compact
					title="No database attached"
					description="Attach a managed PostgreSQL database and this app receives DATABASE_URL, DATABASE_HOST, DATABASE_PORT and friends at start-up."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Database</Table.Head>
						<Table.Head>Env vars</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each attachments as item (item.databaseId)}
						<Table.Row>
							<Table.Cell class="pl-4 align-top">
								<a
									href={resolve('/(dashboard)/databases/[name]', { name: item.databaseName })}
									class="inline-flex items-center gap-1.5 font-mono text-xs font-medium underline-offset-4 hover:underline"
								>
									<DatabaseIcon class="size-3.5 text-muted-foreground" />
									{item.databaseName}
								</a>
							</Table.Cell>
							<Table.Cell class="whitespace-normal">
								<div class="flex flex-wrap gap-1">
									{#each item.envNames as name (name)}
										<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
									{/each}
								</div>
							</Table.Cell>
							<Table.Cell class="pr-4 text-right align-top">
								{#if can.attachDatabase}
									<Button
										variant="ghost-danger"
										size="icon-sm"
										aria-label="Detach {item.databaseName}"
										onclick={() => detach(item)}
									>
										<UnplugIcon />
									</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	{#if can.attachDatabase && databases.length > 0}
		<FormDialog
			bind:open={attachOpen}
			icon={PlugIcon}
			title="Attach a database"
			description="The app restarts with the connection env. Its next deploy is placed on the database's node."
			action="?/attachDatabase"
			submitLabel="Attach"
		>
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.database ? true : undefined}>
					<Field.Label for="attach-database">Database</Field.Label>
					<NativeSelect.Root id="attach-database" name="database" class="w-full" required>
						{#each databases as database (database.name)}
							<NativeSelect.Option value={database.name}>
								{database.name} · {database.engineLabel}
								{database.version} · {database.nodeName}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if fieldErrors.database}<Field.Error>{fieldErrors.database}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.envPrefix ? true : undefined}>
					<Field.Label for="attach-database-prefix">Env prefix</Field.Label>
					<Input
						id="attach-database-prefix"
						name="envPrefix"
						bind:value={prefix}
						maxlength={64}
						autocapitalize="characters"
						spellcheck="false"
						class="font-mono text-sm uppercase"
						aria-invalid={fieldErrors.envPrefix ? 'true' : undefined}
					/>
					<Field.Description class="font-mono text-xs">
						{databaseEnvNames((prefix || 'DATABASE').toUpperCase()).join(' ')}
					</Field.Description>
					{#if fieldErrors.envPrefix}<Field.Error>{fieldErrors.envPrefix}</Field.Error>{/if}
				</Field.Field>
			</Field.Group>
		</FormDialog>
	{/if}
{/if}
