<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import type { ProjectView, SecretView } from '@skiff/core';
	import {
		databasePrefixesFromEnvNames,
		formatEnvFile,
		nextEnvPrefix,
		secretRefEnvName,
		storagePrefixesFromEnvNames,
		type DatabaseAttachmentView,
		type EnvSuggestion,
		type StorageAttachmentView,
		type WorkloadSpec,
		type WorkloadView
	} from '@skiff/contracts';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import VariableIcon from '@lucide/svelte/icons/variable';
	import XIcon from '@lucide/svelte/icons/x';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../../_lib/format.js';
	import {
		ENV_NAME,
		SECRET_NAME,
		applyStaged,
		blankEntry,
		countChanges,
		draftFromSpec,
		exportEnv,
		findLive,
		livePlain,
		liveSecrets,
		looksLikeEnv,
		payloadOf,
		plainStatus,
		removeRow,
		replacePlainFromText,
		revertRow,
		secretStatus,
		setSecret,
		stageText,
		stagedIssues,
		type Draft,
		type Issue,
		type PlainRow,
		type RowStatus,
		type SecretRow,
		type StagedEntry
	} from './variables-draft.js';

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

	type TypeFilter = 'all' | 'plain' | 'secret' | 'linked';

	type Item =
		| { kind: 'plain'; name: string; row: PlainRow; status: RowStatus }
		| { kind: 'secret'; name: string; row: SecretRow; status: RowStatus }
		| { kind: 'linked'; name: string; source: string; sourceKind: 'database' | 'storage' };

	type EditState =
		| { kind: 'plain'; uid: number; key: string; value: string }
		| { kind: 'secret'; uid: number; value: string; delivery: 'env' | 'file'; version: string };

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

	/** The largest `.env` file accepted for import. */
	const MAX_IMPORT_BYTES = 512 * 1024;

	let draft = $state<Draft>({ plain: [], secrets: [] });
	let saving = $state(false);

	let staged = $state<StagedEntry[]>([blankEntry()]);
	let stageNotice = $state<{ tone: 'info' | 'error'; text: string } | null>(null);

	let query = $state('');
	let typeFilter = $state<TypeFilter>('all');
	let showValues = $state(false);
	const revealed = new SvelteSet<number>();
	const selected = new SvelteSet<number>();

	let editing = $state<EditState | null>(null);
	let editError = $state<string | null>(null);

	let rawMode = $state(false);
	let rawText = $state('');
	let rawError = $state<string | null>(null);

	let dragDepth = $state(0);
	let fileInput = $state<HTMLInputElement | null>(null);

	let suggestions = $state<EnvSuggestion[]>([]);
	let suggestionState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let linking = $state<string | null>(null);

	// --- baseline and draft --------------------------------------------------------------

	const baselineKey = $derived(
		JSON.stringify({ env: spec?.env ?? {}, secrets: spec?.secrets ?? [] })
	);

	function resetDraft() {
		draft = draftFromSpec(spec);
		editing = null;
		editError = null;
		rawMode = false;
		rawError = null;
		selected.clear();
		revealed.clear();
	}

	const changes = $derived(countChanges(draft));
	const dirty = $derived(changes.total > 0);

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

	const referencedNames = $derived(new Set(liveSecrets(draft).map((row) => row.name)));

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
		const rows = livePlain(draft);
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder inside a derived, not state
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
		const fromSecrets = new Map(
			liveSecrets(draft).map((row) => [secretRefEnvName(row), row.name] as const)
		);
		return new Map(
			rows.map((row): [number, Issue | null] => {
				if (!ENV_NAME.test(row.key))
					return [
						row.uid,
						{ tone: 'error', text: 'Letters, digits and underscores; not starting with a digit.' }
					];
				if ((counts.get(row.key) ?? 0) > 1)
					return [row.uid, { tone: 'error', text: 'Defined more than once.' }];
				const secret = fromSecrets.get(row.key);
				if (secret)
					return [row.uid, { tone: 'error', text: `Also set by secret ${secret}. Keep one.` }];
				const source = injectedBy.get(row.key);
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
			liveSecrets(draft).map((row): [number, Issue | null] => {
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

	// --- the list --------------------------------------------------------------------------

	const items = $derived.by((): Item[] =>
		[
			...draft.plain.map((row): Item => ({
				kind: 'plain',
				name: row.key,
				row,
				status: plainStatus(row)
			})),
			...draft.secrets.map((row): Item => ({
				kind: 'secret',
				name: secretRefEnvName(row),
				row,
				status: secretStatus(row)
			})),
			...injected.map((item): Item => ({
				kind: 'linked',
				name: item.name,
				source: item.source,
				sourceKind: item.kind
			}))
		].sort((a, b) => a.name.localeCompare(b.name))
	);

	const typeCounts = $derived({
		all: items.length,
		plain: items.filter((item) => item.kind === 'plain').length,
		secret: items.filter((item) => item.kind === 'secret').length,
		linked: items.filter((item) => item.kind === 'linked').length
	});

	const needle = $derived(query.trim().toUpperCase());
	const visible = $derived(
		items.filter(
			(item) =>
				(typeFilter === 'all' || item.kind === typeFilter) &&
				(!needle || item.name.toUpperCase().includes(needle))
		)
	);

	const selectable = $derived(
		visible
			.filter((item) => item.kind !== 'linked' && item.status !== 'removed')
			.map((item) => (item as Extract<Item, { row: unknown }>).row.uid)
	);
	const selectedCount = $derived(selectable.filter((uid) => selected.has(uid)).length);

	function toggleAll(checked: boolean) {
		for (const uid of selectable) {
			if (checked) selected.add(uid);
			else selected.delete(uid);
		}
	}

	function selectedRows(): { plain: PlainRow[]; secrets: SecretRow[] } {
		return {
			plain: draft.plain.filter((row) => selected.has(row.uid) && !row.removed),
			secrets: draft.secrets.filter((row) => selected.has(row.uid) && !row.removed)
		};
	}

	function removeSelected() {
		const rows = selectedRows();
		for (const row of [...rows.plain, ...rows.secrets]) removeRow(draft, row);
		selected.clear();
	}

	function copySelected() {
		const rows = selectedRows();
		void copyText(
			formatEnvFile(rows.plain.map((row) => ({ key: row.key, value: row.value }))),
			`${rows.plain.length} variable${rows.plain.length === 1 ? '' : 's'}`
		);
	}

	// --- the add form ----------------------------------------------------------------------

	const stageIssueMap = $derived(stagedIssues(draft, staged, injectedBy));
	const stagedCount = $derived(staged.filter((entry) => entry.key.trim() || entry.value).length);
	const stageErrors = $derived(
		[...stageIssueMap.values()].filter((issue) => issue?.tone === 'error').length
	);

	function stageFromText(text: string, targetUid: number | null) {
		const result = stageText(staged, text, targetUid);
		if (result.imported === 0) {
			stageNotice = { tone: 'error', text: 'No KEY=value lines found.' };
			return;
		}
		staged = result.staged;
		const skipped = result.invalidLines.length;
		stageNotice = {
			tone: skipped > 0 ? 'error' : 'info',
			text:
				`Read ${result.imported} variable${result.imported === 1 ? '' : 's'}. Review them, then add.` +
				(skipped > 0
					? ` Skipped line${skipped === 1 ? '' : 's'} ${result.invalidLines.join(', ')}: not KEY=value.`
					: '')
		};
	}

	function onKeyPaste(event: ClipboardEvent, entry: StagedEntry) {
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!looksLikeEnv(text)) return;
		event.preventDefault();
		stageFromText(text, entry.uid);
	}

	function addRow() {
		staged = [...staged, blankEntry(staged.at(-1)?.secret ?? false)];
	}

	function removeStaged(entry: StagedEntry) {
		staged = staged.length > 1 ? staged.filter((item) => item !== entry) : [blankEntry()];
	}

	function setAllSecret(secret: boolean) {
		for (const entry of staged) entry.secret = secret;
	}

	function submitStaged(event: SubmitEvent) {
		event.preventDefault();
		if (stagedCount === 0 || stageErrors > 0) return;
		applyStaged(draft, staged);
		staged = [blankEntry()];
		stageNotice = null;
		query = '';
		typeFilter = 'all';
	}

	async function importFile(file: File | undefined) {
		if (!file) return;
		if (file.size > MAX_IMPORT_BYTES) {
			stageNotice = { tone: 'error', text: `${file.name} is larger than 512 KiB.` };
			return;
		}
		if (rawMode) rawMode = false;
		stageFromText(await file.text(), null);
	}

	function onFileChosen(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void importFile(input.files?.[0]);
		input.value = '';
	}

	const draggingFile = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

	function onDragEnter(event: DragEvent) {
		if (!can.edit || !draggingFile(event)) return;
		event.preventDefault();
		dragDepth++;
	}

	function onDragOver(event: DragEvent) {
		if (!can.edit || !draggingFile(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(event: DragEvent) {
		if (!can.edit || !draggingFile(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function onDrop(event: DragEvent) {
		if (!can.edit || !draggingFile(event)) return;
		event.preventDefault();
		dragDepth = 0;
		void importFile(event.dataTransfer?.files[0]);
	}

	// --- inline editing ----------------------------------------------------------------------

	function startEdit(item: Item) {
		if (!can.edit || item.kind === 'linked' || item.status === 'removed') return;
		editError = null;
		editing =
			item.kind === 'plain'
				? { kind: 'plain', uid: item.row.uid, key: item.row.key, value: item.row.value }
				: {
						kind: 'secret',
						uid: item.row.uid,
						value: '',
						delivery: item.row.delivery,
						version: item.row.newValue === null ? item.row.version : ''
					};
	}

	function cancelEdit() {
		editing = null;
		editError = null;
	}

	function commitEdit() {
		const edit = editing;
		if (!edit) return;
		if (edit.kind === 'plain') {
			const row = draft.plain.find((item) => item.uid === edit.uid);
			if (!row) return cancelEdit();
			const key = edit.key.trim();
			if (!ENV_NAME.test(key)) {
				editError = 'Use letters, digits and underscores, not starting with a digit.';
				return;
			}
			const other = findLive(draft, key);
			if (other && other.row !== row) {
				editError = `${key} is already set.`;
				return;
			}
			row.key = key;
			row.value = edit.value;
		} else {
			const row = draft.secrets.find((item) => item.uid === edit.uid);
			if (!row) return cancelEdit();
			const envName = secretRefEnvName({ name: row.name, delivery: edit.delivery });
			const other = findLive(draft, envName);
			if (other && other.row !== row) {
				editError = `${envName} is already set.`;
				return;
			}
			if (edit.value.length > 65536) {
				editError = 'Secret values are limited to 64 KiB.';
				return;
			}
			row.delivery = edit.delivery;
			if (edit.value) {
				row.newValue = edit.value;
				row.version = '';
			} else if (row.newValue === null) row.version = edit.version;
		}
		cancelEdit();
	}

	function editKeydown(event: KeyboardEvent, multiline = false) {
		if (event.key === 'Escape') {
			event.preventDefault();
			cancelEdit();
		} else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			commitEdit();
		}
	}

	/** Undo a pending new value without touching delivery or pinning. */
	function dropNewValue(row: SecretRow) {
		if (!row.original && !resolveSecret(row.name)) return removeRow(draft, row);
		row.newValue = null;
		row.version = row.original?.version ? String(row.original.version) : '';
	}

	function convertToSecret(row: PlainRow) {
		if (!SECRET_NAME.test(row.key)) {
			toast.error(`${row.key} cannot be a secret: secret names are UPPER_SNAKE_CASE.`);
			return;
		}
		if (!row.value) {
			toast.error('A secret needs a value. Set one first.');
			return;
		}
		setSecret(draft, row.key, row.value);
	}

	function useSecret(secret: SecretView) {
		const live = findLive(draft, secret.name);
		if (live?.kind === 'plain') {
			toast.error(`${secret.name} is set as a plain variable. Remove it first.`);
			return;
		}
		if (live) return;
		setSecret(draft, secret.name, null);
	}

	function toggleReveal(uid: number) {
		if (revealed.has(uid)) revealed.delete(uid);
		else revealed.add(uid);
	}

	// --- raw editor and export ----------------------------------------------------------

	function openRaw() {
		rawText = formatEnvFile(livePlain(draft).map((row) => ({ key: row.key, value: row.value })));
		rawError = null;
		editing = null;
		rawMode = true;
	}

	function applyRaw() {
		rawError = replacePlainFromText(draft, rawText);
		if (!rawError) rawMode = false;
	}

	async function copyText(text: string, label: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`Copied ${label}.`);
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}

	function downloadEnv() {
		const blob = new Blob([exportEnv(draft)], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${project.slug}.env`;
		link.click();
		URL.revokeObjectURL(url);
	}

	// --- saving ---------------------------------------------------------------------------

	async function save() {
		if (saving) return;
		if (editing) commitEdit();
		if (editing) return;
		// Rows typed into the add form but not added yet are part of what the user means to save.
		if (stagedCount > 0) {
			if (stageErrors > 0) {
				toast.error('Fix the rows in the add form, or clear them, before saving.');
				return;
			}
			applyStaged(draft, staged);
			staged = [blankEntry()];
			stageNotice = null;
		}
		if (!dirty || errorCount > 0) return;
		saving = true;
		try {
			const result = await runAction('?/saveVariables', {
				variables: JSON.stringify(payloadOf(draft))
			});
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

	function onWindowKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && can.edit && dirty) {
			event.preventDefault();
			void save();
		}
	}

	function beforeUnload(event: BeforeUnloadEvent) {
		if (dirty) event.preventDefault();
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
				!findLive(draft, item.name) &&
				!injectedBy.has(item.name) &&
				!staged.some((entry) => entry.key.trim() === item.name)
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

	/** Suggestions go to the add form so a value can be filled in before they join the list. */
	function stageSuggestions(list: EnvSuggestion[]) {
		const rows = staged.filter((entry) => entry.key.trim() || entry.value);
		for (const item of list)
			rows.push({ ...blankEntry(), key: item.name, value: suggestionValue(item.name) });
		staged = rows.length > 0 ? rows : [blankEntry()];
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

	const statusBadge: Record<
		Exclude<RowStatus, 'unchanged'>,
		{ label: string; variant: 'success' | 'warning' | 'danger' }
	> = {
		added: { label: 'Added', variant: 'success' },
		modified: { label: 'Edited', variant: 'warning' },
		removed: { label: 'Removed', variant: 'danger' }
	};

	const MASK = '••••••••••••';
</script>

<svelte:window onbeforeunload={beforeUnload} onkeydown={onWindowKeydown} />

{#snippet issueLine(issue: Issue | null | undefined)}
	{#if issue}
		<p
			class={[
				'mt-1 text-xs whitespace-normal',
				issue.tone === 'error' && 'text-destructive',
				issue.tone === 'warning' && 'text-warning',
				issue.tone === 'info' && 'text-muted-foreground'
			]}
		>
			{issue.text}
		</p>
	{/if}
{/snippet}

{#snippet statusTag(status: RowStatus)}
	{#if status !== 'unchanged'}
		<Badge variant={statusBadge[status].variant} class="font-sans font-normal">
			{statusBadge[status].label}
		</Badge>
	{/if}
{/snippet}

{#if project.runtime === 'static'}
	<EmptyState
		icon={VariableIcon}
		title="Static sites have no variables"
		description="A static project serves files from a release. Create a project with runtime “process” or “container” to run an app that reads environment variables."
	/>
{:else}
	<input bind:this={fileInput} type="file" class="hidden" tabindex="-1" onchange={onFileChosen} />

	<div class="space-y-6">
		<Card.Root
			class="relative gap-0 overflow-visible py-0"
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
		>
			{#if dragDepth > 0}
				<div
					class="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/90 text-sm"
				>
					<FileUpIcon class="size-6 text-primary" />
					<p class="font-medium">Drop a .env file to import it</p>
					<p class="text-xs text-muted-foreground">
						You can review the variables before adding them.
					</p>
				</div>
			{/if}

			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						<VariableIcon class="size-4" />
					</span>
					<div class="space-y-1">
						<Card.Title>Environment variables</Card.Title>
						<Card.Description>
							Set in the app's environment at start-up. Saving restarts a running app with the new
							values. Secrets are encrypted and can never be read back.
						</Card.Description>
					</div>
				</div>
				<Card.Action class="flex items-center gap-2 self-center">
					{#if can.edit && !rawMode}
						<Button variant="outline" size="sm" onclick={() => fileInput?.click()}>
							<FileUpIcon />Import .env
						</Button>
						<Button variant="outline" size="sm" onclick={openRaw}>
							<FileTextIcon />Edit as .env
						</Button>
					{/if}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="outline"
									size="icon-sm"
									aria-label="Export variables"
									disabled={typeCounts.plain + typeCounts.secret === 0}
								>
									<DownloadIcon />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-56">
							<DropdownMenu.Item onSelect={() => copyText(exportEnv(draft), 'as .env')}>
								<CopyIcon />Copy as .env
							</DropdownMenu.Item>
							<DropdownMenu.Item onSelect={downloadEnv}>
								<DownloadIcon />Download .env file
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<p class="px-2 py-1.5 text-xs text-muted-foreground">
								Plain values only. Secrets are listed by name.
							</p>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Card.Action>
			</Card.Header>

			{#if rawMode}
				<div class="space-y-2 px-4 py-4">
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
			{:else}
				{#if can.edit}
					<form class="space-y-3 border-b px-4 py-4" onsubmit={submitStaged}>
						<div
							class="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_8rem_1.75rem] gap-2 text-xs font-medium text-muted-foreground sm:grid"
						>
							<span>Key</span>
							<span>Value</span>
							<span>{can.createSecret ? 'Type' : ''}</span>
							<span></span>
						</div>
						{#each staged as entry (entry.uid)}
							{@const issue = stageIssueMap.get(entry.uid)}
							<div>
								<div
									class="grid grid-cols-[minmax(0,1fr)_1.75rem] gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_8rem_1.75rem]"
								>
									<Input
										bind:value={entry.key}
										placeholder="e.g. CLIENT_KEY"
										aria-label="Key"
										aria-invalid={issue?.tone === 'error' ? true : undefined}
										spellcheck="false"
										autocomplete="off"
										list="variable-suggestions"
										onpaste={(event) => onKeyPaste(event, entry)}
										class="font-mono text-xs"
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										class="self-center sm:order-last"
										aria-label="Remove this row"
										disabled={staged.length === 1 && !entry.key && !entry.value}
										onclick={() => removeStaged(entry)}
									>
										<XIcon />
									</Button>
									{#if entry.secret}
										<Input
											bind:value={entry.value}
											type="password"
											autocomplete="new-password"
											placeholder="secret value"
											aria-label={`Value of ${entry.key || 'new variable'}`}
											spellcheck="false"
											class="col-span-2 font-mono text-xs sm:col-span-1"
										/>
									{:else}
										<Textarea
											bind:value={entry.value}
											rows={1}
											placeholder="value"
											aria-label={`Value of ${entry.key || 'new variable'}`}
											spellcheck="false"
											class="col-span-2 min-h-8 resize-none py-1.5 font-mono text-xs sm:col-span-1"
										/>
									{/if}
									{#if can.createSecret}
										<NativeSelect.Root
											bind:value={
												() => (entry.secret ? 'secret' : 'plain'),
												(v) => (entry.secret = v === 'secret')
											}
											aria-label={`Type of ${entry.key || 'new variable'}`}
											class="col-span-2 h-8 text-xs sm:col-span-1"
										>
											<NativeSelect.Option value="plain">Plaintext</NativeSelect.Option>
											<NativeSelect.Option value="secret">Secret</NativeSelect.Option>
										</NativeSelect.Root>
									{/if}
								</div>
								{@render issueLine(issue)}
							</div>
						{/each}

						<div class="flex flex-wrap items-center justify-between gap-2">
							<div class="flex flex-wrap items-center gap-2">
								<Button type="button" variant="outline" size="sm" onclick={addRow}>
									<PlusIcon />Add another
								</Button>
								{#if can.createSecret && staged.length > 1}
									<span class="text-xs text-muted-foreground">
										Mark all as
										<button
											type="button"
											class="underline-offset-2 hover:underline"
											onclick={() => setAllSecret(false)}>plaintext</button
										>
										or
										<button
											type="button"
											class="underline-offset-2 hover:underline"
											onclick={() => setAllSecret(true)}>secret</button
										>
									</span>
								{/if}
							</div>
							<Button type="submit" size="sm" disabled={stagedCount === 0 || stageErrors > 0}>
								{stagedCount > 1 ? `Add ${stagedCount} variables` : 'Add variable'}
							</Button>
						</div>

						{#if stageNotice}
							<p
								class={[
									'text-xs',
									stageNotice.tone === 'error' ? 'text-warning' : 'text-muted-foreground'
								]}
								role="status"
							>
								{stageNotice.text}
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Tip: paste a <code class="font-mono">.env</code> file into a Key field, or drop one anywhere
								on this card, to fill in many at once.
							</p>
						{/if}

						<datalist id="variable-suggestions">
							{#each openSuggestions as item (item.name)}
								<option value={item.name}>{item.detail}</option>
							{/each}
						</datalist>

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
											onclick={() => stageSuggestions(detected)}
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
											onclick={() => stageSuggestions([item])}
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
					</form>
				{/if}

				{#if items.length === 0}
					<div class="p-4">
						<EmptyState
							icon={VariableIcon}
							compact
							title="No variables yet"
							description="Add one above, import a .env file, or link a database or storage to inject its connection variables."
						/>
					</div>
				{:else}
					<div class="flex flex-wrap items-center gap-2 px-4 py-3">
						<div class="relative min-w-48 flex-1">
							<SearchIcon
								class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								bind:value={query}
								type="search"
								placeholder="Search variables"
								aria-label="Search variables"
								class="h-8 pl-8 text-xs"
							/>
						</div>
						<ToggleGroup.Root
							type="single"
							variant="outline"
							size="sm"
							value={typeFilter}
							onValueChange={(value) => (typeFilter = (value || 'all') as TypeFilter)}
							aria-label="Show variables of type"
						>
							{#each [['all', 'All'], ['plain', 'Plaintext'], ['secret', 'Secrets'], ['linked', 'Linked']] as const as [value, label] (value)}
								{#if value === 'all' || typeCounts[value] > 0}
									<ToggleGroup.Item {value} class="px-2.5 text-xs">
										{label}<span class="text-muted-foreground tabular-nums"
											>{typeCounts[value]}</span
										>
									</ToggleGroup.Item>
								{/if}
							{/each}
						</ToggleGroup.Root>
						{#if typeCounts.plain > 0}
							<Button
								variant="outline"
								size="sm"
								aria-pressed={showValues}
								onclick={() => {
									showValues = !showValues;
									revealed.clear();
								}}
							>
								{#if showValues}<EyeOffIcon />Hide values{:else}<EyeIcon />Show values{/if}
							</Button>
						{/if}
					</div>

					{#if can.edit && selectedCount > 0}
						<div
							class="flex flex-wrap items-center justify-between gap-2 border-y bg-muted/40 px-4 py-2 text-xs"
						>
							<span class="font-medium">{selectedCount} selected</span>
							<div class="flex gap-2">
								<Button variant="outline" size="xs" onclick={copySelected}>
									<CopyIcon />Copy as .env
								</Button>
								<Button variant="ghost-danger" size="xs" onclick={removeSelected}>
									<TrashIcon />Remove
								</Button>
								<Button variant="ghost" size="xs" onclick={() => selected.clear()}>Clear</Button>
							</div>
						</div>
					{/if}

					<Table.Root class="border-t">
						<Table.Header>
							<Table.Row>
								{#if can.edit}
									<Table.Head class="w-0 pl-4">
										<Checkbox
											checked={selectable.length > 0 && selectedCount === selectable.length}
											indeterminate={selectedCount > 0 && selectedCount < selectable.length}
											disabled={selectable.length === 0}
											onCheckedChange={(checked) => toggleAll(checked === true)}
											aria-label="Select all shown variables"
										/>
									</Table.Head>
								{/if}
								<Table.Head class={can.edit ? '' : 'pl-4'}>Key</Table.Head>
								<Table.Head>Value</Table.Head>
								<Table.Head class="hidden md:table-cell">Type</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each visible as item (item.kind === 'linked' ? `linked:${item.name}` : item.row.uid)}
								{#if item.kind === 'linked'}
									<Table.Row class="text-muted-foreground">
										{#if can.edit}<Table.Cell class="pl-4"></Table.Cell>{/if}
										<Table.Cell class={['align-top', !can.edit && 'pl-4']}>
											<span class="inline-flex items-center gap-1.5 font-mono text-xs">
												<PlugIcon class="size-3" />{item.name}
											</span>
										</Table.Cell>
										<Table.Cell class="align-top text-xs">
											Linked from
											<a
												href={item.sourceKind === 'database'
													? resolve('/(dashboard)/databases/[name]', { name: item.source })
													: resolve('/(dashboard)/storage/[name]', { name: item.source })}
												class="font-medium text-foreground underline-offset-2 hover:underline"
												>{item.source}</a
											>
										</Table.Cell>
										<Table.Cell class="hidden align-top md:table-cell">
											<Badge variant="neutral" class="font-normal">{item.sourceKind}</Badge>
										</Table.Cell>
										<Table.Cell class="pr-4 text-right align-top">
											<CopyButton value={item.name} label="Copy name" iconOnly />
										</Table.Cell>
									</Table.Row>
								{:else if editing && editing.uid === item.row.uid}
									<Table.Row class="bg-muted/40 hover:bg-muted/40">
										<Table.Cell class="pl-4 align-top"></Table.Cell>
										{#if editing.kind === 'plain'}
											<Table.Cell class="align-top">
												<Input
													bind:value={editing.key}
													aria-label="Key"
													spellcheck="false"
													autofocus
													onkeydown={(event) => editKeydown(event)}
													class="h-8 min-w-36 font-mono text-xs"
												/>
												{#if editError}<p class="mt-1 text-xs text-destructive">{editError}</p>{/if}
											</Table.Cell>
											<Table.Cell class="align-top">
												<Textarea
													bind:value={editing.value}
													rows={1}
													aria-label={`Value of ${editing.key || 'variable'}`}
													spellcheck="false"
													onkeydown={(event) => editKeydown(event, true)}
													class="min-h-8 min-w-48 resize-none py-1.5 font-mono text-xs"
												/>
												<p class="mt-1 text-[11px] text-muted-foreground">
													<Kbd>Enter</Kbd> in the key, or <Kbd>⌘ Enter</Kbd> here, to apply ·
													<Kbd>Esc</Kbd> to cancel
												</p>
											</Table.Cell>
											<Table.Cell class="hidden align-top md:table-cell">
												<Badge variant="outline" class="font-normal">Plaintext</Badge>
											</Table.Cell>
										{:else}
											{@const row = item.row as SecretRow}
											{@const resolved = resolveSecret(row.name)}
											<Table.Cell class="align-top">
												<span class="inline-flex items-center gap-1.5 font-mono text-xs">
													<LockIcon class="size-3 text-muted-foreground" />{row.name}
												</span>
												{#if editError}<p class="mt-1 text-xs text-destructive">{editError}</p>{/if}
											</Table.Cell>
											<Table.Cell class="space-y-2 align-top">
												{#if can.createSecret}
													<Input
														bind:value={editing.value}
														type="password"
														autocomplete="new-password"
														autofocus
														placeholder="New value (leave empty to keep)"
														aria-label={`New value for ${row.name}`}
														onkeydown={(event) => editKeydown(event)}
														class="h-8 min-w-48 font-mono text-xs"
													/>
												{/if}
												{#if resolved && !editing.value && row.newValue === null}
													<NativeSelect.Root
														bind:value={editing.version}
														aria-label={`Version of ${row.name}`}
														class="h-8 text-xs"
													>
														<NativeSelect.Option value="">
															Latest (v{resolved.latest.version})
														</NativeSelect.Option>
														{#each [...resolved.versions].sort((a, b) => b - a) as version (version)}
															<NativeSelect.Option value={String(version)}>
																Pin to v{version}
															</NativeSelect.Option>
														{/each}
													</NativeSelect.Root>
												{/if}
											</Table.Cell>
											<Table.Cell class="hidden align-top md:table-cell">
												<NativeSelect.Root
													bind:value={editing.delivery}
													aria-label={`How ${row.name} is delivered`}
													class="h-8 text-xs"
												>
													<NativeSelect.Option value="env">As a variable</NativeSelect.Option>
													<NativeSelect.Option value="file">As a file (_FILE)</NativeSelect.Option>
												</NativeSelect.Root>
											</Table.Cell>
										{/if}
										<Table.Cell class="pr-4 text-right align-top whitespace-nowrap">
											<Button
												size="icon-sm"
												variant="ghost"
												aria-label="Apply"
												onclick={commitEdit}
											>
												<CheckIcon />
											</Button>
											<Button
												size="icon-sm"
												variant="ghost"
												aria-label="Cancel"
												onclick={cancelEdit}
											>
												<XIcon />
											</Button>
										</Table.Cell>
									</Table.Row>
								{:else}
									{@const removed = item.status === 'removed'}
									{@const issue = removed
										? null
										: item.kind === 'plain'
											? plainIssues.get(item.row.uid)
											: secretIssues.get(item.row.uid)}
									<Table.Row
										class={[removed && 'text-muted-foreground']}
										ondblclick={() => startEdit(item)}
									>
										{#if can.edit}
											<Table.Cell class="pl-4 align-top">
												<Checkbox
													checked={selected.has(item.row.uid)}
													disabled={removed}
													onCheckedChange={(checked) =>
														checked ? selected.add(item.row.uid) : selected.delete(item.row.uid)}
													aria-label={`Select ${item.name}`}
												/>
											</Table.Cell>
										{/if}
										<Table.Cell class={['align-top', !can.edit && 'pl-4']}>
											<div class="flex flex-wrap items-center gap-1.5">
												<span
													class={[
														'inline-flex items-center gap-1.5 font-mono text-xs',
														removed && 'line-through'
													]}
												>
													{#if item.kind === 'secret'}<LockIcon
															class="size-3 text-muted-foreground"
														/>{/if}
													{item.name}
												</span>
												{@render statusTag(item.status)}
											</div>
											{@render issueLine(issue)}
										</Table.Cell>

										<Table.Cell class="max-w-0 align-top sm:w-1/2">
											{#if item.kind === 'plain'}
												{@const row = item.row}
												{@const show = showValues || revealed.has(row.uid)}
												<div class="flex min-w-0 items-center gap-1">
													<Button
														variant="ghost"
														size="icon-xs"
														aria-label={show ? `Hide ${row.key}` : `Show ${row.key}`}
														onclick={() => toggleReveal(row.uid)}
														disabled={showValues}
													>
														{#if show}<EyeOffIcon />{:else}<EyeIcon />{/if}
													</Button>
													{#if show}
														{#if row.value}
															<span
																class={['truncate font-mono text-xs', removed && 'line-through']}
																title={row.value}>{row.value}</span
															>
														{:else}
															<span class="text-xs text-muted-foreground italic">empty</span>
														{/if}
													{:else}
														<button
															type="button"
															class="font-mono text-xs tracking-wider text-muted-foreground"
															aria-label={`Show ${row.key}`}
															onclick={() => toggleReveal(row.uid)}>{MASK}</button
														>
													{/if}
												</div>
											{:else}
												{@const row = item.row}
												{@const resolved = resolveSecret(row.name)}
												<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
													<span class="inline-flex items-center gap-1 text-muted-foreground">
														<LockIcon class="size-3" />Encrypted
													</span>
													{#if row.newValue !== null}
														<Badge variant="warning" class="font-normal">new value on save</Badge>
													{:else if resolved}
														<span class="text-muted-foreground">
															{resolved.scope === 'project' ? 'project' : 'organisation'} · v{row.version ||
																resolved.latest.version}{row.version ? ' (pinned)' : ''}
														</span>
													{/if}
												</div>
											{/if}
										</Table.Cell>

										<Table.Cell class="hidden align-top md:table-cell">
											{#if item.kind === 'plain'}
												<Badge variant="outline" class="font-normal">Plaintext</Badge>
											{:else}
												<Badge variant="brand" class="font-normal">
													Secret{item.row.delivery === 'file' ? ' · file' : ''}
												</Badge>
											{/if}
										</Table.Cell>

										<Table.Cell class="pr-4 text-right align-top whitespace-nowrap">
											{#if removed}
												{#if can.edit}
													<Button size="xs" variant="ghost" onclick={() => revertRow(item.row)}>
														<RotateCcwIcon />Undo
													</Button>
												{/if}
											{:else}
												<div class="flex items-center justify-end gap-0.5">
													{#if item.kind === 'plain'}
														<CopyButton value={item.row.value} label="Copy value" iconOnly />
													{/if}
													{#if can.edit}
														<RowMenu label={`Actions for ${item.name}`}>
															<DropdownMenu.Item onSelect={() => startEdit(item)}>
																<PencilIcon />{item.kind === 'secret'
																	? 'Edit or replace value'
																	: 'Edit'}
															</DropdownMenu.Item>
															{#if item.kind === 'plain'}
																{@const row = item.row}
																<DropdownMenu.Item
																	onSelect={() =>
																		copyText(
																			formatEnvFile([{ key: row.key, value: row.value }]),
																			`${row.key} as KEY=value`
																		)}
																>
																	<CopyIcon />Copy as KEY=value
																</DropdownMenu.Item>
																{#if can.createSecret}
																	<DropdownMenu.Item onSelect={() => convertToSecret(row)}>
																		<LockIcon />Convert to secret
																	</DropdownMenu.Item>
																{/if}
															{:else if item.row.newValue !== null}
																{@const row = item.row}
																<DropdownMenu.Item onSelect={() => dropNewValue(row)}>
																	<RotateCcwIcon />Discard new value
																</DropdownMenu.Item>
															{/if}
															{#if item.status === 'modified'}
																{@const row = item.row}
																<DropdownMenu.Item onSelect={() => revertRow(row)}>
																	<RotateCcwIcon />Revert changes
																</DropdownMenu.Item>
															{/if}
															<DropdownMenu.Separator />
															<DropdownMenu.Item
																variant="destructive"
																onSelect={() => removeRow(draft, item.row)}
															>
																<TrashIcon />{item.kind === 'secret' ? 'Stop using' : 'Remove'}
															</DropdownMenu.Item>
														</RowMenu>
													{/if}
												</div>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/if}
							{:else}
								<Table.Row>
									<Table.Cell
										colspan={can.edit ? 5 : 4}
										class="py-6 text-center text-xs text-muted-foreground"
									>
										No variables match{query ? ` “${query}”` : ' this filter'}.
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			{/if}

			{#if can.edit && (dirty || saving)}
				<Card.Footer
					class="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t bg-card/95 py-3 backdrop-blur"
				>
					<p class="text-xs">
						<span class="font-medium">
							{changes.total} unsaved change{changes.total === 1 ? '' : 's'}
						</span>
						<span class="text-muted-foreground">
							({[
								changes.added && `${changes.added} added`,
								changes.modified && `${changes.modified} edited`,
								changes.removed && `${changes.removed} removed`
							]
								.filter(Boolean)
								.join(', ')})
						</span>
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
					<div class="flex items-center gap-2">
						<Button variant="ghost" size="sm" disabled={saving} onclick={resetDraft}>Discard</Button
						>
						<Button size="sm" disabled={saving || errorCount > 0} onclick={save}>
							{saving ? 'Saving…' : workload ? 'Save and restart' : 'Save'}
							{#if !saving}<Kbd class="ml-1 bg-primary-foreground/15 text-primary-foreground"
									>⌘S</Kbd
								>{/if}
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
						No secrets yet. Choose “Secret” as the type when you add a variable to store it
						encrypted.
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
											<Button size="xs" variant="outline" onclick={() => useSecret(secret)}
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
