/**
 * The Variables tab's unsaved draft: plain variables and secret references edited locally, then
 * saved together. Everything here mutates the draft in place so it works on Svelte `$state`
 * proxies and on plain objects in tests alike.
 */
import { formatEnvFile, parseEnvFile, secretRefEnvName, type WorkloadSpec } from '@yoal/contracts';

type WorkloadSecretRef = WorkloadSpec['secrets'][number];

/** Names a process can read: letters, digits and underscores, not starting with a digit. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Secret names are stricter: UPPER_SNAKE_CASE. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export type RowStatus = 'added' | 'modified' | 'removed' | 'unchanged';

export interface PlainRow {
	uid: number;
	key: string;
	value: string;
	/** The saved state, or null for a row added in this draft. */
	original: { key: string; value: string } | null;
	/** A saved row marked for removal; it stays listed so the removal can be undone. */
	removed: boolean;
}

export interface SecretRow {
	uid: number;
	name: string;
	delivery: 'env' | 'file';
	/** A pinned version, or '' for the latest. */
	version: string;
	/** A value to store as a new project secret version on save. */
	newValue: string | null;
	original: WorkloadSecretRef | null;
	removed: boolean;
}

export interface Draft {
	plain: PlainRow[];
	secrets: SecretRow[];
}

/** A row in the add form, before it joins the draft. */
export interface StagedEntry {
	uid: number;
	key: string;
	value: string;
	secret: boolean;
}

export interface Issue {
	tone: 'error' | 'warning' | 'info';
	text: string;
}

let counter = 0;
export const nextUid = (): number => ++counter;

export function blankEntry(secret = false): StagedEntry {
	return { uid: nextUid(), key: '', value: '', secret };
}

export function draftFromSpec(spec: Pick<WorkloadSpec, 'env' | 'secrets'> | null): Draft {
	return {
		plain: Object.entries(spec?.env ?? {}).map(([key, value]) => ({
			uid: nextUid(),
			key,
			value,
			original: { key, value },
			removed: false
		})),
		secrets: (spec?.secrets ?? []).map((ref) => ({
			uid: nextUid(),
			name: ref.name,
			delivery: ref.delivery,
			version: ref.version ? String(ref.version) : '',
			newValue: null,
			original: { ...ref },
			removed: false
		}))
	};
}

export function plainStatus(row: PlainRow): RowStatus {
	if (row.removed) return 'removed';
	if (!row.original) return 'added';
	return row.original.key === row.key && row.original.value === row.value
		? 'unchanged'
		: 'modified';
}

export function secretStatus(row: SecretRow): RowStatus {
	if (row.removed) return 'removed';
	if (!row.original) return 'added';
	return row.newValue !== null ||
		row.original.delivery !== row.delivery ||
		String(row.original.version ?? '') !== row.version
		? 'modified'
		: 'unchanged';
}

export function countChanges(draft: Draft): {
	added: number;
	modified: number;
	removed: number;
	total: number;
} {
	const counts = { added: 0, modified: 0, removed: 0, total: 0 };
	for (const status of [...draft.plain.map(plainStatus), ...draft.secrets.map(secretStatus)]) {
		if (status === 'unchanged') continue;
		counts[status]++;
		counts.total++;
	}
	return counts;
}

export const livePlain = (draft: Draft): PlainRow[] => draft.plain.filter((row) => !row.removed);
export const liveSecrets = (draft: Draft): SecretRow[] =>
	draft.secrets.filter((row) => !row.removed);

/** What a save sends. Rows with no name are dropped. */
export function payloadOf(draft: Draft) {
	const env: Record<string, string> = {};
	for (const row of livePlain(draft)) if (row.key.trim()) env[row.key.trim()] = row.value;
	const secrets = liveSecrets(draft);
	return {
		env,
		secrets: secrets.map((row) => ({
			name: row.name,
			delivery: row.delivery,
			...(row.version && row.newValue === null ? { version: Number(row.version) } : {})
		})),
		newSecrets: secrets
			.filter((row) => row.newValue !== null)
			.map((row) => ({ name: row.name, value: row.newValue as string }))
	};
}

/** Where an environment name currently comes from in the draft, if anywhere. */
export function findLive(
	draft: Draft,
	envName: string
): { kind: 'plain'; row: PlainRow } | { kind: 'secret'; row: SecretRow } | null {
	const plain = draft.plain.find((row) => !row.removed && row.key.trim() === envName);
	if (plain) return { kind: 'plain', row: plain };
	const secret = draft.secrets.find(
		(row) => !row.removed && (secretRefEnvName(row) === envName || row.name === envName)
	);
	if (secret) return { kind: 'secret', row: secret };
	return null;
}

/** Remove a row: one added in this draft disappears, a saved one is marked for removal. */
export function removeRow(draft: Draft, row: PlainRow | SecretRow): void {
	if ('key' in row) {
		if (row.original) row.removed = true;
		else draft.plain.splice(draft.plain.indexOf(row), 1);
	} else {
		if (row.original) row.removed = true;
		else draft.secrets.splice(draft.secrets.indexOf(row), 1);
	}
}

/** Undo every edit to a saved row. */
export function revertRow(row: PlainRow | SecretRow): void {
	if (!row.original) return;
	row.removed = false;
	if ('key' in row) {
		row.key = row.original.key;
		row.value = row.original.value;
	} else {
		row.delivery = row.original.delivery;
		row.version = row.original.version ? String(row.original.version) : '';
		row.newValue = null;
	}
}

/** Set a plain variable, replacing a secret that set the same name. */
export function setPlain(draft: Draft, key: string, value: string): PlainRow {
	const live = findLive(draft, key);
	if (live?.kind === 'plain') {
		live.row.value = value;
		return live.row;
	}
	if (live?.kind === 'secret') removeRow(draft, live.row);
	const removed = draft.plain.find((row) => row.removed && row.original?.key === key);
	if (removed) {
		removed.removed = false;
		removed.key = key;
		removed.value = value;
		return removed;
	}
	const row: PlainRow = { uid: nextUid(), key, value, original: null, removed: false };
	draft.plain.push(row);
	return row;
}

/**
 * Give a secret a new value (saved as a new project secret version), replacing a plain variable
 * that set the same name. `value` null references the existing secret as it is.
 */
export function setSecret(draft: Draft, name: string, value: string | null): SecretRow {
	const live = findLive(draft, name);
	if (live?.kind === 'secret' && live.row.name === name) {
		if (value !== null) {
			live.row.newValue = value;
			live.row.version = '';
		}
		return live.row;
	}
	if (live) removeRow(draft, live.row);
	const removed = draft.secrets.find((row) => row.removed && row.name === name);
	if (removed) {
		removed.removed = false;
		if (value !== null) {
			removed.newValue = value;
			removed.version = '';
		}
		return removed;
	}
	const row: SecretRow = {
		uid: nextUid(),
		name,
		delivery: 'env',
		version: '',
		newValue: value,
		original: null,
		removed: false
	};
	draft.secrets.push(row);
	return row;
}

/** Whether pasted text looks like `.env` content rather than a single name. */
export function looksLikeEnv(text: string): boolean {
	return /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(text);
}

/**
 * Spread `.env` text over the add form, replacing the row it was pasted into. A name already in
 * the form takes the pasted value; new names inherit the target row's secret flag.
 */
export function stageText(
	staged: StagedEntry[],
	text: string,
	targetUid: number | null = null
): { staged: StagedEntry[]; imported: number; invalidLines: number[] } {
	const parsed = parseEnvFile(text);
	const target = staged.find((entry) => entry.uid === targetUid);
	const rows = staged.filter((entry) => entry !== target && (entry.key.trim() || entry.value));
	for (const item of parsed.entries) {
		const existing = rows.find((entry) => entry.key.trim() === item.key);
		if (existing) existing.value = item.value;
		else
			rows.push({
				uid: nextUid(),
				key: item.key,
				value: item.value,
				secret: target?.secret ?? false
			});
	}
	return {
		staged: rows.length > 0 ? rows : [blankEntry(target?.secret ?? false)],
		imported: parsed.entries.length,
		invalidLines: parsed.invalidLines
	};
}

const isBlank = (entry: StagedEntry) => !entry.key.trim() && !entry.value;

/** Problems and effects of each add-form row, keyed by uid. */
export function stagedIssues(
	draft: Draft,
	staged: StagedEntry[],
	linkedFrom: ReadonlyMap<string, string>
): Map<number, Issue | null> {
	const counts = new Map<string, number>();
	for (const entry of staged) {
		const key = entry.key.trim();
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Map(
		staged.map((entry): [number, Issue | null] => {
			const key = entry.key.trim();
			if (isBlank(entry)) return [entry.uid, null];
			if (!key) return [entry.uid, { tone: 'error', text: 'Add a name.' }];
			if (!ENV_NAME.test(key))
				return [
					entry.uid,
					{ tone: 'error', text: 'Letters, digits and underscores; not starting with a digit.' }
				];
			if (entry.secret && !SECRET_NAME.test(key))
				return [
					entry.uid,
					{ tone: 'error', text: 'Secret names are UPPER_SNAKE_CASE, starting with a letter.' }
				];
			if (entry.secret && !entry.value)
				return [entry.uid, { tone: 'error', text: 'A secret needs a value.' }];
			if (entry.secret && entry.value.length > 65536)
				return [entry.uid, { tone: 'error', text: 'Secret values are limited to 64 KiB.' }];
			if ((counts.get(key) ?? 0) > 1)
				return [entry.uid, { tone: 'error', text: 'Listed more than once.' }];
			const live = findLive(draft, key);
			if (live?.kind === 'plain')
				return [
					entry.uid,
					{
						tone: 'info',
						text: entry.secret
							? 'Replaces the plain variable with a secret.'
							: 'Overwrites the current value.'
					}
				];
			if (live?.kind === 'secret')
				return [
					entry.uid,
					{
						tone: 'info',
						text: entry.secret
							? 'Stores a new secret version.'
							: 'Replaces the secret with a plain value.'
					}
				];
			const source = linkedFrom.get(key);
			if (source)
				return [entry.uid, { tone: 'warning', text: `Overrides the value linked from ${source}.` }];
			return [entry.uid, null];
		})
	);
}

/** Move the add form's rows into the draft; returns how many were applied. */
export function applyStaged(draft: Draft, staged: StagedEntry[]): number {
	let applied = 0;
	for (const entry of staged) {
		if (isBlank(entry)) continue;
		const key = entry.key.trim();
		if (entry.secret) setSecret(draft, key, entry.value);
		else setPlain(draft, key, entry.value);
		applied++;
	}
	return applied;
}

/**
 * Replace every plain variable with the contents of `.env` text: names left out are removed.
 * Returns a message when the text cannot be applied.
 */
export function replacePlainFromText(draft: Draft, text: string): string | null {
	const parsed = parseEnvFile(text);
	if (parsed.invalidLines.length > 0) {
		const lines = parsed.invalidLines;
		return `Line${lines.length === 1 ? '' : 's'} ${lines.join(', ')} ${lines.length === 1 ? 'is' : 'are'} not KEY=value.`;
	}
	const fromSecrets = new Set(liveSecrets(draft).map((row) => secretRefEnvName(row)));
	const clash = parsed.entries.find((entry) => fromSecrets.has(entry.key));
	if (clash) return `${clash.key} is set by a secret. Remove it from the text or from the list.`;
	const keep = new Set(parsed.entries.map((entry) => entry.key));
	for (const row of [...livePlain(draft)]) if (!keep.has(row.key.trim())) removeRow(draft, row);
	for (const entry of parsed.entries) setPlain(draft, entry.key, entry.value);
	return null;
}

/** The draft as a `.env` file. Secrets are write-only, so they are listed as comments. */
export function exportEnv(draft: Draft, rows: PlainRow[] = livePlain(draft)): string {
	const plain = formatEnvFile(
		rows.filter((row) => row.key.trim()).map((row) => ({ key: row.key.trim(), value: row.value }))
	);
	const secrets = liveSecrets(draft);
	if (secrets.length === 0) return plain;
	const lines = secrets.map((row) => `# ${secretRefEnvName(row)}=`);
	return `${plain}${plain ? '\n' : ''}# Secrets are encrypted and cannot be exported:\n${lines.join('\n')}\n`;
}
