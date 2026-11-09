/**
 * Object references, MATCH patterns and the key table's display columns for the key-value
 * workspace. Tree paths look like `['0']` (keyspace), `['0', 'user:', 'user:1:']` (key groups,
 * each segment the full prefix) and `[..., 'user:1:name']` (a key, the full key name last).
 */
import type { Cell, Column, ObjectRef, TreeNode } from '@yoal/studio/protocol';
import { formatTtl, ttlFromCell } from './ttl.js';

/** Escape a literal for a SCAN MATCH glob (the plugin's `globEscape`). */
export function globEscape(literal: string): string {
	return literal.replace(/[*?[\]\\]/g, '\\$&');
}

/** The key prefix a keyspace or key-group object covers ('' for the keyspace). */
export function groupPrefix(object: Pick<TreeNode, 'kind' | 'path'>): string {
	return object.kind === 'key-group' ? (object.path.at(-1) ?? '') : '';
}

/** The MATCH pattern the key list starts with: the group's prefix, then anything. */
export function defaultPattern(object: Pick<TreeNode, 'kind' | 'path'>): string {
	return `${globEscape(groupPrefix(object))}*`;
}

/** The pattern to send as `query.native`; `*` alone (or nothing) means no pattern. */
export function patternQuery(pattern: string): string | undefined {
	const trimmed = pattern.trim();
	return trimmed && trimmed !== '*' ? trimmed : undefined;
}

/** The keyspace object above any key-value node (key edits like TTL and delete go there). */
export function keyspaceRef(object: Pick<TreeNode, 'path'>): ObjectRef {
	return { path: [object.path[0] ?? '0'], kind: 'keyspace' };
}

/** A `key` object for any key name; the plugin resolves a key by the last path segment. */
export function keyRef(db: string, key: string): ObjectRef {
	return { path: [db, key], kind: 'key' };
}

/** The key name of a `key` object. */
export function keyName(object: Pick<TreeNode, 'path'>): string {
	return object.path.at(-1) ?? '';
}

// ---------------------------------------------------------------- key table columns

/** UI-only column: the TTL as human time next to the raw, editable `ttl` (ms). */
export const EXPIRES_COLUMN = 'expires';

/**
 * Add the human `expires` column after `ttl`. The grid edits `ttl` in milliseconds (empty for no
 * expiry); `expires` is read-only and is stripped from changes before `apply`.
 */
export function withExpiresColumn(columns: Column[], rows: Cell[][]): { columns: Column[]; rows: Cell[][] } {
	const ttl = columns.findIndex((column) => column.name === 'ttl');
	if (ttl < 0) return { columns, rows };
	const column: Column = { name: EXPIRES_COLUMN, nativeType: 'ttl', kind: 'text', nullable: false, editable: false };
	return {
		columns: [...columns.slice(0, ttl + 1), column, ...columns.slice(ttl + 1)],
		rows: rows.map((row) => [...row.slice(0, ttl + 1), formatTtl(ttlFromCell(row[ttl] ?? null)), ...row.slice(ttl + 1)]),
	};
}

// ---------------------------------------------------------------- string values

export type StringValueView =
	| { kind: 'text'; text: string; json: boolean }
	| { kind: 'truncated'; preview: string; bytes: number | null }
	| { kind: 'binary'; base64: string }
	| { kind: 'missing' };

/** Text that is a JSON object or array (scalars like `42` stay plain text). */
export function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

/** How a string key's value cell can be shown and edited. */
export function stringValueView(cell: Cell): StringValueView {
	if (cell === null) return { kind: 'missing' };
	if (typeof cell === 'string') return { kind: 'text', text: cell, json: looksLikeJson(cell) };
	if (typeof cell === 'number' || typeof cell === 'boolean') return { kind: 'text', text: String(cell), json: false };
	if (Array.isArray(cell)) return { kind: 'text', text: JSON.stringify(cell), json: true };
	if (cell.$t === 'truncated') return { kind: 'truncated', preview: String(cell.v ?? ''), bytes: cell.bytes ?? null };
	if (cell.$t === 'bytes') return { kind: 'binary', base64: String(cell.v ?? '') };
	const text = typeof cell.v === 'string' ? cell.v : JSON.stringify(cell.v);
	return { kind: 'text', text, json: looksLikeJson(text) };
}

/** Pretty-print JSON text (2 spaces), or compact it; unchanged when it doesn't parse. */
export function reformatJson(text: string, pretty: boolean): string {
	try {
		return JSON.stringify(JSON.parse(text), null, pretty ? 2 : undefined);
	} catch {
		return text;
	}
}

/** Text of a cell for compact previews (stream fields, set members, …). */
export function cellText(cell: Cell): string {
	if (cell === null) return '';
	if (typeof cell !== 'object') return String(cell);
	if (Array.isArray(cell)) return JSON.stringify(cell);
	return typeof cell.v === 'string' ? cell.v : JSON.stringify(cell.v);
}
