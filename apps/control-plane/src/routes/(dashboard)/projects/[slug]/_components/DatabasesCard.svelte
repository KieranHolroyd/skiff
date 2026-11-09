<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import {
		databaseEngineRegistry,
		databaseEnvNames,
		nextEnvPrefix,
		type DatabaseAttachmentView,
		type DatabaseEngine
	} from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatDate } from '../../../_lib/format.js';
	import EnvNames from '../../../_lib/service/EnvNames.svelte';

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
		databases: Array<{
			name: string;
			engine: DatabaseEngine;
			version: string;
			engineLabel: string;
			nodeName: string;
		}>;
		/** `warning` from the last attach (e.g. the app runs on another node). */
		warning?: string | null;
		fieldErrors?: Record<string, string>;
		can: { readDatabases: boolean; createDatabase: boolean; attachDatabase: boolean };
	} = $props();

	let attachOpen = $state(false);
	let prefix = $state('DATABASE');
	let selected = $state('');
	const selectedEngine = $derived(
		databases.find((item) => item.name === selected)?.engine ?? databases[0]?.engine ?? 'postgres'
	);

	/** The engine's prefix (`REDIS`, `MONGODB`, `DATABASE`), numbered if the project already uses it. */
	function suggestPrefix(engine: DatabaseEngine): string {
		return nextEnvPrefix(
			databaseEngineRegistry[engine].defaultEnvPrefix,
			attachments.map((item) => item.envPrefix)
		);
	}

	function selectDatabase(name: string) {
		const before = suggestPrefix(selectedEngine);
		selected = name;
		// Follow the engine only while the user has not typed their own prefix.
		if (!prefix || prefix === before) prefix = suggestPrefix(selectedEngine);
	}

	const createHref = $derived(
		`${resolve('/(dashboard)/databases')}?project=${encodeURIComponent(slug)}`
	);

	function openAttach() {
		selected = databases[0]?.name ?? '';
		prefix = suggestPrefix(selectedEngine);
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
				>
					{#if can.attachDatabase && databases.length > 0}
						<Button size="sm" onclick={openAttach}><PlugIcon />Attach a database</Button>
					{:else if can.createDatabase && can.attachDatabase}
						<Button size="sm" variant="outline" href={createHref}>
							<PlusIcon />Create a database
						</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<ul class="divide-y">
				{#each attachments as item (item.databaseId)}
					{@const href = resolve('/(dashboard)/databases/[name]', { name: item.databaseName })}
					<li class="flex items-start gap-3 px-4 py-3">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							aria-hidden="true"
						>
							<DatabaseIcon class="size-4" />
						</span>
						<div class="min-w-0 flex-1 space-y-1.5">
							<div>
								<a {href} class="font-mono text-sm font-medium underline-offset-4 hover:underline">
									{item.databaseName}
								</a>
								<p class="text-xs text-muted-foreground">
									Injected as <span class="font-mono">{item.envPrefix}_*</span> · attached
									{formatDate(item.createdAt)}
								</p>
							</div>
							<EnvNames names={item.envNames} />
						</div>
						<RowMenu label="Actions for {item.databaseName}">
							<DropdownMenu.Item onSelect={() => goto(href)}>
								<ArrowUpRightIcon />Open database
							</DropdownMenu.Item>
							{#if can.attachDatabase}
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onSelect={() => detach(item)}>
									<UnplugIcon />Detach
								</DropdownMenu.Item>
							{/if}
						</RowMenu>
					</li>
				{/each}
			</ul>
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
					<NativeSelect.Root
						id="attach-database"
						name="database"
						class="w-full"
						required
						bind:value={() => selected, selectDatabase}
					>
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
						{databaseEnvNames((prefix || suggestPrefix(selectedEngine)).toUpperCase(), {
							engine: selectedEngine
						}).join(' ')}
					</Field.Description>
					{#if fieldErrors.envPrefix}<Field.Error>{fieldErrors.envPrefix}</Field.Error>{/if}
				</Field.Field>
			</Field.Group>
		</FormDialog>
	{/if}
{/if}
