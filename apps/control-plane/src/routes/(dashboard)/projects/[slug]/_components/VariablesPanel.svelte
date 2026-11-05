<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import type { ProjectView, SecretView } from '@skiff/core';
	import {
		databasePrefixesFromEnvNames,
		formatEnvFile,
		nextEnvPrefix,
		parseEnvFile,
		secretRefEnvName,
		storagePrefixesFromEnvNames,
		type DatabaseAttachmentView,
		type EnvSuggestion,
		type StorageAttachmentView,
		type WorkloadSpec,
		type WorkloadView
	} from '@skiff/contracts';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import VariableIcon from '@lucide/svelte/icons/variable';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime } from '../../../_lib/format.js';

	interface AttachableDatabase {
		name: string;
		version: string;
		engineLabel: string;
		nodeName: string;
	}

	interface AttachableStorage {
		name: string;
		engineLabel: string;
		version: string;
		nodeName: string;
		public: boolean;
		buckets: string[];
	}

	interface LinkTarget {
		kind: 'database' | 'storage';
		name: string;
		label: string;
		prefix: string;
		buckets: string[];
	}

	/** A plain variable in the draft. `uid` keeps row identity stable while names are edited. */
	interface PlainRow {
		uid: number;
		key: string;
		value: string;
	}

	/** A secret reference in the draft. `newValue` is a value to save as a new project secret. */
	interface SecretRow {
		uid: number;
		name: string;
		delivery: 'env' | 'file';
		version: string;
		newValue: string | null;
	}

	interface Issue {
		tone: 'error' | 'warning';
		text: string;
	}

	let {
		project,
		spec,
		workload,
		secrets,
		databaseAttachments = [],
		storageAttachments = [],
		attachableDatabases = [],
		attachableStorage = [],
		canAttachDatabase = false,
		canAttachStorage = false,
		can
	}: {
		project: ProjectView;
		spec: WorkloadSpec | null;
		workload: WorkloadView | null;
		/** Secrets this project can reference: its own and the organisation's. */
		secrets: SecretView[];
		databaseAttachments?: DatabaseAttachmentView[];
		storageAttachments?: StorageAttachmentView[];
		attachableDatabases?: AttachableDatabase[];
		attachableStorage?: AttachableStorage[];
		canAttachDatabase?: boolean;
		canAttachStorage?: boolean;
		can: { edit: boolean; createSecret: boolean; deleteSecret: boolean };
	} = $props();

	const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
	const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

	let nextUid = 0;
	const uid = () => ++nextUid;

	let plainRows = $state<PlainRow[]>([]);
	let secretRows = $state<SecretRow[]>([]);
	let saving = $state(false);
	let query = $state('');

	let rawMode = $state(false);
	let rawText = $state('');
	let rawError = $state<string | null>(null);

	let newName = $state('');
	let newValue = $state('');
	let newSecret = $state(false);
	let newError = $state<string | null>(null);

	let replacing = $state<number | null>(null);
	let replaceValue = $state('');

	let suggestions = $state<EnvSuggestion[]>([]);
	let suggestionState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let linking = $state<string | null>(null);

	// --- baseline and draft --------------------------------------------------------------

	const baseline = $derived({ env: spec?.env ?? {}, secrets: spec?.secrets ?? [] });
	const baselineKey = $derived(JSON.stringify(baseline));

	function resetDraft() {
		plainRows = Object.entries(baseline.env).map(([key, value]) => ({ uid: uid(), key, value }));
		secretRows = baseline.secrets.map((ref) => ({
			uid: uid(),
			name: ref.name,
			delivery: ref.delivery,
			version: ref.version ? String(ref.version) : '',
			newValue: null
		}));
		rawMode = false;
		rawError = null;
		replacing = null;
	}

	/** What a save would send; rows with no name are dropped. */
	const payload = $derived.by(() => {
		const env: Record<string, string> = {};
		for (const row of plainRows) if (row.key.trim()) env[row.key.trim()] = row.value;
		return {
			env,
			secrets: secretRows.map((row) => ({
				name: row.name,
				delivery: row.delivery,
				...(row.version && row.newValue === null ? { version: Number(row.version) } : {})
			})),
			newSecrets: secretRows
				.filter((row) => row.newValue !== null)
				.map((row) => ({ name: row.name, value: row.newValue as string }))
		};
	});

	/** Changes against the saved spec, counted per variable. */
	const changes = $derived.by(() => {
		let count = 0;
		const before = baseline.env;
		for (const [key, value] of Object.entries(payload.env)) {
			if (!(key in before) || before[key] !== value) count++;
		}
		for (const key of Object.keys(before)) if (!(key in payload.env)) count++;
		const savedRefs = new Map(baseline.secrets.map((ref) => [ref.name, ref]));
		for (const row of secretRows) {
			const saved = savedRefs.get(row.name);
			if (
				!saved ||
				saved.delivery !== row.delivery ||
				String(saved.version ?? '') !== (row.newValue === null ? row.version : '') ||
				row.newValue !== null
			)
				count++;
		}
		for (const name of savedRefs.keys()) if (!secretRows.some((row) => row.name === name)) count++;
		return count;
	});

	const dirty = $derived(changes > 0);

	// Adopt the saved state on first load and after a save, but never drop unsaved edits because
	// some unrelated page data refreshed.
	let adoptedKey = '';
	$effect(() => {
		const key = baselineKey;
		untrack(() => {
			if (key === adoptedKey) return;
			if (adoptedKey === '' || !dirty || saving) resetDraft();
			adoptedKey = key;
		});
	});

	// --- secrets: what each name resolves to --------------------------------------------------

	/** Latest row per name and scope; a project secret wins over the organisation's. */
	const secretIndex = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder inside a derived, not state
		const byScope = new Map<string, { latest: SecretView; versions: number[] }>();
		for (const secret of secrets) {
			const key = `${secret.projectId === null ? 'org' : 'project'}:${secret.name}`;
			const entry = byScope.get(key);
			if (!entry) byScope.set(key, { latest: secret, versions: [secret.version] });
			else {
				entry.versions.push(secret.version);
				if (entry.latest.version < secret.version) entry.latest = secret;
			}
		}
		return byScope;
	});

	function resolveSecret(name: string) {
		const own = secretIndex.get(`project:${name}`);
		if (own) return { scope: 'project' as const, ...own };
		const org = secretIndex.get(`org:${name}`);
		if (org) return { scope: 'org' as const, ...org };
		return null;
	}

	const secretList = $derived(
		[...secretIndex.values()]
			.map((entry) => entry.latest)
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					Number(a.projectId === null) - Number(b.projectId === null)
			)
	);

	const referencedNames = $derived(new Set(secretRows.map((row) => row.name)));

	// --- linked services ---------------------------------------------------------------

	const injected = $derived([
		...databaseAttachments.flatMap((item) =>
			item.envNames.map((name) => ({ name, source: item.databaseName, kind: 'database' as const }))
		),
		...storageAttachments.flatMap((item) =>
			item.envNames.map((name) => ({ name, source: item.storageName, kind: 'storage' as const }))
		)
	]);
	const injectedBy = $derived(new Map(injected.map((item) => [item.name, item.source])));

	// --- validation ----------------------------------------------------------------------

	const plainIssues = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder inside a derived, not state
		const counts = new Map<string, number>();
		for (const row of plainRows) {
			const key = row.key.trim();
			if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const fromSecrets = new Map(
			secretRows.map((row) => [secretRefEnvName(row), row.name] as const)
		);
		return new Map(
			plainRows.map((row): [number, Issue | null] => {
				const key = row.key.trim();
				if (!key)
					return [
						row.uid,
						row.value ? { tone: 'error', text: 'Add a name or remove the row.' } : null
					];
				if (!NAME.test(key))
					return [
						row.uid,
						{ tone: 'error', text: 'Letters, digits and underscores; not starting with a digit.' }
					];
				if ((counts.get(key) ?? 0) > 1)
					return [row.uid, { tone: 'error', text: 'Defined more than once.' }];
				const secret = fromSecrets.get(key);
				if (secret)
					return [row.uid, { tone: 'error', text: `Also set by secret ${secret}. Keep one.` }];
				const source = injectedBy.get(key);
				if (source)
					return [row.uid, { tone: 'warning', text: `Overrides the value linked from ${source}.` }];
				return [row.uid, null];
			})
		);
	});

	const secretIssues = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder inside a derived, not state
		const seen = new Set<string>();
		return new Map(
			secretRows.map((row): [number, Issue | null] => {
				const envName = secretRefEnvName(row);
				if (seen.has(envName))
					return [row.uid, { tone: 'error', text: 'Referenced more than once.' }];
				seen.add(envName);
				if (row.newValue !== null) return [row.uid, null];
				const resolved = resolveSecret(row.name);
				if (!resolved)
					return [
						row.uid,
						{ tone: 'error', text: 'This secret no longer exists. Set a value or remove it.' }
					];
				if (row.version && !resolved.versions.includes(Number(row.version)))
					return [row.uid, { tone: 'error', text: `Version ${row.version} does not exist.` }];
				return [row.uid, null];
			})
		);
	});

	const errorCount = $derived(
		[...plainIssues.values(), ...secretIssues.values()].filter((issue) => issue?.tone === 'error')
			.length
	);

	// --- filtering -------------------------------------------------------------------------

	const needle = $derived(query.trim().toUpperCase());
	const matches = (name: string) => !needle || name.toUpperCase().includes(needle);
	const visiblePlain = $derived(plainRows.filter((row) => matches(row.key) || !row.key.trim()));
	const visibleSecrets = $derived(secretRows.filter((row) => matches(row.name)));
	const visibleInjected = $derived(injected.filter((item) => matches(item.name)));
	const total = $derived(plainRows.length + secretRows.length + injected.length);

	// --- editing -------------------------------------------------------------------------

	function usedName(name: string): boolean {
		return (
			plainRows.some((row) => row.key.trim() === name) ||
			secretRows.some((row) => secretRefEnvName(row) === name)
		);
	}

	function addVariable(event: SubmitEvent) {
		event.preventDefault();
		const name = (newSecret ? newName.trim().toUpperCase() : newName.trim()) || '';
		newError = null;
		if (newSecret ? !SECRET_NAME.test(name) : !NAME.test(name)) {
			newError = newSecret
				? 'Secret names are UPPER_SNAKE_CASE, starting with a letter.'
				: 'Use letters, digits and underscores, not starting with a digit.';
			return;
		}
		if (usedName(name)) {
			newError = `${name} is already set. Edit it in the list.`;
			return;
		}
		if (newSecret) {
			if (!newValue) {
				newError = 'Enter the secret value.';
				return;
			}
			secretRows = [
				...secretRows,
				{ uid: uid(), name, delivery: 'env', version: '', newValue: newValue }
			];
		} else {
			plainRows = [...plainRows, { uid: uid(), key: name, value: newValue }];
		}
		newName = '';
		newValue = '';
	}

	function removePlain(row: PlainRow) {
		plainRows = plainRows.filter((item) => item.uid !== row.uid);
	}

	function removeSecretRow(row: SecretRow) {
		secretRows = secretRows.filter((item) => item.uid !== row.uid);
		if (replacing === row.uid) replacing = null;
	}

	function startReplace(row: SecretRow) {
		replacing = row.uid;
		replaceValue = '';
	}

	function confirmReplace(row: SecretRow) {
		if (!replaceValue) return;
		row.newValue = replaceValue;
		row.version = '';
		replacing = null;
		replaceValue = '';
	}

	/** Undo a pending value: a reference to an existing secret goes back to it, a new one is dropped. */
	function revertValue(row: SecretRow) {
		if (resolveSecret(row.name)) {
			row.newValue = null;
			const saved = baseline.secrets.find((ref) => ref.name === row.name);
			row.version = saved?.version ? String(saved.version) : '';
		} else removeSecretRow(row);
	}

	function referenceSecret(secret: SecretView) {
		if (referencedNames.has(secret.name)) return;
		if (plainRows.some((row) => row.key.trim() === secret.name)) {
			newError = `${secret.name} is set as a plain variable. Remove it first.`;
			return;
		}
		secretRows = [
			...secretRows,
			{ uid: uid(), name: secret.name, delivery: 'env', version: '', newValue: null }
		];
	}

	/** Merge `.env` text: existing names take the pasted value, new names are appended. */
	function mergeEnv(text: string): { added: number; updated: number; skipped: number } {
		const parsed = parseEnvFile(text);
		const rows = plainRows.filter((row) => row.key.trim() || row.value);
		let added = 0;
		let updated = 0;
		for (const entry of parsed.entries) {
			if (secretRows.some((row) => secretRefEnvName(row) === entry.key)) continue;
			const existing = rows.find((row) => row.key.trim() === entry.key);
			if (existing) {
				if (existing.value !== entry.value) updated++;
				existing.value = entry.value;
			} else {
				rows.push({ uid: uid(), key: entry.key, value: entry.value });
				added++;
			}
		}
		plainRows = rows;
		return { added, updated, skipped: parsed.invalidLines.length };
	}

	/** Pasting `KEY=value` lines into the name field imports them all at once. */
	function onNamePaste(event: ClipboardEvent) {
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(text)) return;
		event.preventDefault();
		const result = mergeEnv(text);
		newError = null;
		newName = '';
		newValue = '';
		if (result.skipped > 0)
			newError = `Imported ${result.added + result.updated}; ${result.skipped} line${result.skipped === 1 ? ' was' : 's were'} not KEY=value.`;
	}

	function openRaw() {
		rawText = formatEnvFile(
			plainRows
				.filter((row) => row.key.trim())
				.map((row) => ({ key: row.key.trim(), value: row.value }))
		);
		rawError = null;
		rawMode = true;
	}

	/** The raw editor owns the full plain list: names missing from the text are removed. */
	function applyRaw() {
		const parsed = parseEnvFile(rawText);
		if (parsed.invalidLines.length > 0) {
			rawError = `Line${parsed.invalidLines.length === 1 ? '' : 's'} ${parsed.invalidLines.join(', ')} ${parsed.invalidLines.length === 1 ? 'is' : 'are'} not KEY=value.`;
			return;
		}
		const fromSecrets = new Set(secretRows.map((row) => secretRefEnvName(row)));
		const clash = parsed.entries.find((entry) => fromSecrets.has(entry.key));
		if (clash) {
			rawError = `${clash.key} is a secret reference. Remove it from the text or from the secrets below.`;
			return;
		}
		const existing = new Map(plainRows.map((row) => [row.key.trim(), row.uid]));
		plainRows = parsed.entries.map((entry) => ({
			uid: existing.get(entry.key) ?? uid(),
			key: entry.key,
			value: entry.value
		}));
		rawMode = false;
		rawError = null;
	}

	async function save() {
		if (saving || errorCount > 0) return;
		saving = true;
		try {
			const result = await runAction('?/saveVariables', { variables: JSON.stringify(payload) });
			if (result.type === 'success') resetDraft();
		} finally {
			saving = false;
		}
	}

	function deleteSecret(secret: SecretView) {
		askConfirm({
			title: `Delete secret ${secret.name} (v${secret.version})?`,
			description: secret.projectId
				? 'This removes the latest version. The previous version, or an organisation secret with the same name, is used from the next restart.'
				: 'This removes the latest version of an organisation-wide secret. Other projects that reference it restart without it.',
			confirmLabel: 'Delete secret',
			tone: 'danger',
			action: '?/deleteSecret',
			fields: { secretId: secret.id }
		});
	}

	// --- suggestions ---------------------------------------------------------------------

	$effect(() => {
		if (project.runtime !== 'static' && can.edit) untrack(() => void loadSuggestions());
	});

	async function loadSuggestions(): Promise<void> {
		if (suggestionState === 'loading') return;
		suggestionState = 'loading';
		try {
			const endpoint = `${resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}/env-suggestions`;
			const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { suggestions?: unknown };
			suggestions = Array.isArray(body.suggestions) ? (body.suggestions as EnvSuggestion[]) : [];
			suggestionState = 'ready';
		} catch {
			suggestionState = 'error';
		}
	}

	const openSuggestions = $derived(
		suggestions.filter(
			(item) =>
				!item.injected &&
				item.source !== 'secret' &&
				!usedName(item.name) &&
				!injectedBy.has(item.name)
		)
	);
	const detected = $derived(
		openSuggestions.filter((item) => item.source === 'env-file' || item.source === 'code')
	);

	function suggestionValue(name: string): string {
		if (name === 'NODE_ENV') return 'production';
		if (name === 'PORT' && spec) return String(spec.port);
		return '';
	}

	function addSuggestion(item: EnvSuggestion) {
		if (usedName(item.name)) return;
		plainRows = [...plainRows, { uid: uid(), key: item.name, value: suggestionValue(item.name) }];
	}

	function sourceLabel(source: EnvSuggestion['source']): string {
		if (source === 'env-file') return 'dotenv';
		return source;
	}

	/**
	 * A detected name such as DATABASE_URL or S3_BUCKET means the app expects a managed service.
	 * Offer to link an unattached one, inferring the env prefix from the names the code uses.
	 */
	const linkTargets = $derived.by(() => {
		const targets: LinkTarget[] = [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder inside a derived, not state
		const used = new Set([
			...databaseAttachments.map((item) => item.envPrefix),
			...storageAttachments.map((item) => item.envPrefix)
		]);
		const names = suggestions.filter((item) => !item.injected).map((item) => item.name);
		const databasePrefixes = databasePrefixesFromEnvNames(names);
		const storagePrefixes = storagePrefixesFromEnvNames(names);
		if (canAttachDatabase && databasePrefixes.length > 0) {
			for (const database of attachableDatabases) {
				const preferred =
					databasePrefixes.find((prefix) => !used.has(prefix)) ?? nextEnvPrefix('DATABASE', used);
				used.add(preferred);
				targets.push({
					kind: 'database',
					name: database.name,
					label: `${database.name} · ${database.engineLabel} ${database.version}`,
					prefix: preferred,
					buckets: []
				});
			}
		}
		if (canAttachStorage && storagePrefixes.length > 0) {
			for (const instance of attachableStorage) {
				const preferred =
					storagePrefixes.find((prefix) => !used.has(prefix)) ?? nextEnvPrefix('S3', used);
				used.add(preferred);
				targets.push({
					kind: 'storage',
					name: instance.name,
					label: `${instance.name} · ${instance.public ? 'public' : 'private'}`,
					prefix: preferred,
					buckets: instance.buckets
				});
			}
		}
		return targets;
	});

	async function linkService(target: LinkTarget): Promise<void> {
		if (linking) return;
		linking = `${target.kind}:${target.name}`;
		const fields: Record<string, string> =
			target.kind === 'database'
				? { database: target.name, envPrefix: target.prefix }
				: { storage: target.name, envPrefix: target.prefix };
		if (target.kind === 'storage') {
			for (const bucket of target.buckets) fields[`grant:${bucket}`] = 'read-write';
		}
		try {
			await runAction(target.kind === 'database' ? '?/attachDatabase' : '?/attachStorage', fields);
			await loadSuggestions();
		} finally {
			linking = null;
		}
	}

	function beforeUnload(event: BeforeUnloadEvent) {
		if (dirty) event.preventDefault();
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if project.runtime === 'static'}
	<EmptyState
		icon={VariableIcon}
		title="Static sites have no variables"
		description="A static project serves files from a release. Create a project with runtime “process” or “container” to run an app that reads environment variables."
	/>
{:else}
	<div class="space-y-6">
		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						<VariableIcon class="size-4" />
					</span>
					<div class="space-y-1">
						<Card.Title>Variables</Card.Title>
						<Card.Description>
							Set in the app's environment at start-up. Saving restarts a running app with the new
							values. Secrets are encrypted and can never be read back.
						</Card.Description>
					</div>
				</div>
				{#if can.edit && !rawMode}
					<Card.Action class="self-center">
						<Button variant="outline" size="sm" onclick={openRaw}><FileTextIcon />Raw editor</Button
						>
					</Card.Action>
				{/if}
			</Card.Header>

			<Card.Content class="space-y-4 px-4 py-4">
				{#if can.edit && !rawMode}
					<form class="space-y-2" onsubmit={addVariable}>
						<div class="flex flex-wrap items-start gap-2">
							<Input
								bind:value={newName}
								placeholder="NAME"
								aria-label="New variable name"
								spellcheck="false"
								autocapitalize="characters"
								list="variable-suggestions"
								onpaste={onNamePaste}
								class="min-w-36 flex-1 font-mono text-xs sm:max-w-56"
							/>
							<Input
								bind:value={newValue}
								type={newSecret ? 'password' : 'text'}
								autocomplete={newSecret ? 'new-password' : 'off'}
								placeholder={newSecret ? 'secret value' : 'value'}
								aria-label="New variable value"
								spellcheck="false"
								class="min-w-40 flex-[2] font-mono text-xs"
							/>
							<Button type="submit" size="sm" variant="outline" class="h-8"><PlusIcon />Add</Button>
						</div>
						<div class="flex flex-wrap items-center justify-between gap-2">
							{#if can.createSecret}
								<label class="flex items-center gap-2 text-xs">
									<Checkbox bind:checked={newSecret} aria-label="Store as a secret" />
									<span
										>Secret <span class="text-muted-foreground">(encrypted, write-only)</span></span
									>
								</label>
							{/if}
							<p class="text-xs text-muted-foreground">
								Tip: paste a whole <code class="font-mono">.env</code> file into the name field.
							</p>
						</div>
						{#if newError}
							<p class="text-xs text-destructive" role="alert">{newError}</p>
						{/if}
						<datalist id="variable-suggestions">
							{#each openSuggestions as item (item.name)}
								<option value={item.name}>{item.detail}</option>
							{/each}
						</datalist>
					</form>

					{#if suggestionState === 'ready' && openSuggestions.length > 0}
						<div class="space-y-2 rounded-lg border bg-muted/30 p-3">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="text-xs text-muted-foreground">
									Suggested from your <code class="font-mono">.env</code> files and code.
								</p>
								{#if detected.length > 0}
									<Button
										type="button"
										variant="outline"
										size="xs"
										onclick={() => detected.forEach(addSuggestion)}
									>
										Add {detected.length} detected
									</Button>
								{/if}
							</div>
							<div class="flex flex-wrap gap-1">
								{#each openSuggestions as item (item.name)}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-[11px] transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
										title={item.detail}
										onclick={() => addSuggestion(item)}
									>
										{item.name}<span class="font-sans text-muted-foreground"
											>{sourceLabel(item.source)}</span
										>
									</button>
								{/each}
							</div>
						</div>
					{/if}

					{#if linkTargets.length > 0}
						<div class="space-y-2 rounded-lg border border-dashed p-3">
							<p class="text-xs text-muted-foreground">
								Your code expects a managed service. Linking attaches it and injects its variables
								at the next start.
							</p>
							{#each linkTargets as target (target.kind + ':' + target.name)}
								<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
									<span class="min-w-0" title={target.label}>
										<span class="font-medium">{target.name}</span>
										<span class="text-muted-foreground"> → {target.prefix}_*</span>
									</span>
									<Button
										type="button"
										size="xs"
										variant="outline"
										disabled={linking !== null}
										onclick={() => linkService(target)}
									>
										{linking === `${target.kind}:${target.name}` ? 'Linking…' : 'Link'}
									</Button>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if rawMode}
					<div class="space-y-2">
						<Textarea
							bind:value={rawText}
							rows={Math.min(24, Math.max(8, rawText.split('\n').length + 1))}
							spellcheck="false"
							aria-label="Plain variables as .env"
							placeholder="NODE_ENV=production&#10;LOG_LEVEL=info"
							class="font-mono text-xs"
						/>
						{#if rawError}
							<p class="text-xs text-destructive" role="alert">{rawError}</p>
						{/if}
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="text-xs text-muted-foreground">
								Plain variables only, one <code class="font-mono">KEY=value</code> per line. Names
								left out are removed. Secrets and linked variables stay as they are. No
								<code class="font-mono">$&#123;VAR&#125;</code> expansion.
							</p>
							<div class="flex gap-2">
								<Button variant="ghost" size="sm" onclick={() => (rawMode = false)}>Cancel</Button>
								<Button size="sm" onclick={applyRaw}>Apply</Button>
							</div>
						</div>
					</div>
				{:else if total > 0}
					<div class="relative">
						<SearchIcon
							class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							bind:value={query}
							type="search"
							placeholder="Filter variables"
							aria-label="Filter variables"
							class="pl-8 text-xs"
						/>
					</div>
				{/if}
			</Card.Content>

			{#if !rawMode}
				{#if total === 0}
					<div class="border-t p-4">
						<EmptyState
							icon={VariableIcon}
							compact
							title="No variables yet"
							description="Add one above, paste a .env file, or link a database or storage to inject its connection variables."
						/>
					</div>
				{:else}
					<Table.Root class="border-t">
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Name</Table.Head>
								<Table.Head>Value</Table.Head>
								<Table.Head class="hidden sm:table-cell">Type</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each visiblePlain as row (row.uid)}
								{@const issue = plainIssues.get(row.uid)}
								<Table.Row>
									<Table.Cell class="pl-4 align-top">
										{#if can.edit}
											<Input
												bind:value={row.key}
												aria-label="Variable name"
												aria-invalid={issue?.tone === 'error' ? true : undefined}
												spellcheck="false"
												class="h-7 min-w-32 font-mono text-xs"
											/>
										{:else}
											<span class="font-mono text-xs">{row.key}</span>
										{/if}
										{#if issue}
											<p
												class={[
													'mt-1 text-xs whitespace-normal',
													issue.tone === 'error' ? 'text-destructive' : 'text-warning'
												]}
											>
												{issue.text}
											</p>
										{/if}
									</Table.Cell>
									<Table.Cell class="align-top">
										{#if can.edit}
											<Input
												bind:value={row.value}
												aria-label={`Value of ${row.key || 'variable'}`}
												spellcheck="false"
												class="h-7 min-w-40 font-mono text-xs"
											/>
										{:else}
											<span class="font-mono text-xs break-all">{row.value}</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden align-top sm:table-cell">
										<Badge variant="outline" class="font-normal">plain</Badge>
									</Table.Cell>
									<Table.Cell class="pr-4 text-right align-top">
										{#if can.edit}
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label={`Remove ${row.key || 'variable'}`}
												onclick={() => removePlain(row)}
											>
												<TrashIcon />
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}

							{#each visibleSecrets as row (row.uid)}
								{@const issue = secretIssues.get(row.uid)}
								{@const resolved = resolveSecret(row.name)}
								<Table.Row>
									<Table.Cell class="pl-4 align-top">
										<span class="inline-flex items-center gap-1.5 font-mono text-xs">
											<LockIcon class="size-3 text-muted-foreground" />{secretRefEnvName(row)}
										</span>
										{#if issue}
											<p
												class={[
													'mt-1 text-xs whitespace-normal',
													issue.tone === 'error' ? 'text-destructive' : 'text-warning'
												]}
											>
												{issue.text}
											</p>
										{/if}
									</Table.Cell>
									<Table.Cell class="align-top">
										{#if replacing === row.uid}
											<form
												class="flex items-center gap-2"
												onsubmit={(event) => {
													event.preventDefault();
													confirmReplace(row);
												}}
											>
												<Input
													bind:value={replaceValue}
													type="password"
													autocomplete="new-password"
													placeholder="new value"
													aria-label={`New value for ${row.name}`}
													class="h-7 min-w-40 font-mono text-xs"
												/>
												<Button type="submit" size="xs" disabled={!replaceValue}>Set</Button>
												<Button
													type="button"
													size="xs"
													variant="ghost"
													onclick={() => (replacing = null)}>Cancel</Button
												>
											</form>
										{:else}
											<div class="flex flex-wrap items-center gap-2 text-xs">
												<span class="font-mono text-muted-foreground">••••••••</span>
												{#if row.newValue !== null}
													<Badge variant="warning" class="font-normal">new value on save</Badge>
													{#if can.edit}
														<Button
															size="xs"
															variant="ghost"
															aria-label={`Undo the new value for ${row.name}`}
															onclick={() => revertValue(row)}><Undo2Icon />Undo</Button
														>
													{/if}
												{:else if resolved}
													<span class="text-muted-foreground">
														{resolved.scope === 'project' ? 'project' : 'organisation'} · v{row.version ||
															resolved.latest.version}{row.version ? ' (pinned)' : ''}
													</span>
												{/if}
												{#if can.edit && can.createSecret && row.newValue === null}
													<Button size="xs" variant="ghost" onclick={() => startReplace(row)}
														>Replace value</Button
													>
												{/if}
											</div>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden align-top sm:table-cell">
										{#if can.edit}
											<NativeSelect.Root
												bind:value={row.delivery}
												aria-label={`How ${row.name} is delivered`}
												class="h-7 text-xs"
											>
												<NativeSelect.Option value="env">secret · env</NativeSelect.Option>
												<NativeSelect.Option value="file">secret · file</NativeSelect.Option>
											</NativeSelect.Root>
										{:else}
											<Badge variant="brand" class="font-normal">secret · {row.delivery}</Badge>
										{/if}
									</Table.Cell>
									<Table.Cell class="pr-4 text-right align-top">
										{#if can.edit}
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label={`Stop using ${row.name}`}
												title="Stop using this secret (the secret itself is kept)"
												onclick={() => removeSecretRow(row)}
											>
												<TrashIcon />
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}

							{#each visibleInjected as item (item.name)}
								<Table.Row class="text-muted-foreground">
									<Table.Cell class="pl-4 align-top">
										<span class="inline-flex items-center gap-1.5 font-mono text-xs">
											<PlugIcon class="size-3" />{item.name}
										</span>
									</Table.Cell>
									<Table.Cell class="align-top text-xs">
										Linked from <span class="font-medium text-foreground">{item.source}</span>
									</Table.Cell>
									<Table.Cell class="hidden align-top sm:table-cell">
										<Badge variant="neutral" class="font-normal">{item.kind}</Badge>
									</Table.Cell>
									<Table.Cell class="pr-4"></Table.Cell>
								</Table.Row>
							{/each}

							{#if visiblePlain.length + visibleSecrets.length + visibleInjected.length === 0}
								<Table.Row>
									<Table.Cell colspan={4} class="py-6 text-center text-xs text-muted-foreground">
										No variables match “{query}”.
									</Table.Cell>
								</Table.Row>
							{/if}
						</Table.Body>
					</Table.Root>
				{/if}
			{/if}

			{#if can.edit && (dirty || saving)}
				<Card.Footer
					class="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t bg-card/95 py-3 backdrop-blur"
				>
					<p class="text-xs">
						<span class="font-medium">{changes} unsaved change{changes === 1 ? '' : 's'}</span>
						{#if errorCount > 0}
							<span class="text-destructive">
								· fix {errorCount} problem{errorCount === 1 ? '' : 's'} to save</span
							>
						{:else}
							<span class="text-muted-foreground">
								· {workload ? 'saving restarts the app' : 'applies at the next deploy'}</span
							>
						{/if}
					</p>
					<div class="flex gap-2">
						<Button variant="ghost" size="sm" disabled={saving} onclick={resetDraft}>Discard</Button
						>
						<Button size="sm" disabled={saving || errorCount > 0} onclick={save}>
							{saving ? 'Saving…' : workload ? 'Save and restart' : 'Save'}
						</Button>
					</div>
				</Card.Footer>
			{/if}
		</Card.Root>

		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						<ShieldCheckIcon class="size-4" />
					</span>
					<div class="space-y-1">
						<Card.Title>Secrets</Card.Title>
						<Card.Description>
							Encrypted values this project can use: its own, and the organisation's. A project
							secret overrides an organisation secret with the same name.
						</Card.Description>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="px-0">
				{#if secretList.length === 0}
					<p class="px-4 py-4 text-xs text-muted-foreground">
						No secrets yet. Tick “Secret” when you add a variable to store it encrypted.
					</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Name</Table.Head>
								<Table.Head class="hidden sm:table-cell">Scope</Table.Head>
								<Table.Head>Version</Table.Head>
								<Table.Head class="hidden lg:table-cell">Updated</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each secretList as secret (secret.id)}
								{@const overridden =
									secret.projectId === null && secretIndex.has(`project:${secret.name}`)}
								<Table.Row>
									<Table.Cell class="max-w-48 truncate pl-4 font-mono text-xs" title={secret.name}>
										{secret.name}
										{#if !overridden && referencedNames.has(secret.name)}
											<Badge variant="success" class="ml-1 font-sans font-normal">in use</Badge>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
										{secret.projectId ? 'This project' : 'Organisation'}
										{#if overridden}
											<Badge
												variant="outline"
												class="ml-1 font-normal"
												title="This project has its own {secret.name}, which is used instead."
												>overridden</Badge
											>
										{/if}
									</Table.Cell>
									<Table.Cell class="font-mono text-xs">v{secret.version}</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
										<time datetime={secret.createdAt}>{formatDateTime(secret.createdAt)}</time>
									</Table.Cell>
									<Table.Cell class="pr-4 text-right whitespace-nowrap">
										{#if can.edit && !overridden && !referencedNames.has(secret.name)}
											<Button size="xs" variant="outline" onclick={() => referenceSecret(secret)}
												>Use</Button
											>
										{/if}
										{#if can.deleteSecret && secret.projectId === project.id}
											<Button
												variant="ghost-danger"
												size="icon-sm"
												aria-label={`Delete secret ${secret.name} version ${secret.version}`}
												onclick={() => deleteSecret(secret)}
											>
												<TrashIcon />
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
			<Card.Footer class="py-3 text-xs text-muted-foreground">
				Values are fetched by the node only when the app starts and never enter desired state or the
				on-disk cache. Changing or deleting a secret restarts the apps that use it.
			</Card.Footer>
		</Card.Root>
	</div>
{/if}
