/**
 * `RowChange` builders matching the key-value plugin's `apply` contract exactly
 * (packages/studio/src/plugins/keyvalue/index.ts):
 *
 * Key table (a keyspace or key-group object, `applyKeys`):
 * - insert `{ key, value, ttl?, type: 'string' }` → `SET key value NX [PX ttl]`;
 * - update `key: { key }` with `values.value` (strings only, `KEEPTTL`) and/or `values.ttl`
 *   (ms → `PEXPIRE`, null → `PERSIST`), guarded by `original.value`/`original.ttl`/`original.type`;
 * - delete `key: { key }` → `UNLINK`, guarded by `original.type`.
 *
 * Inside one key (a `key` object, `applyInKey`), rows are identified by the type's row key:
 * - string: update `key: {}` with `values.value`, guarded by `original.value`;
 * - hash: insert `{ field, value }`, update/delete `key: { field }` guarded by `original.value`;
 * - list: insert `{ value }` (RPUSH), update/delete `key: { index }` guarded by `original.value`;
 * - set: insert `{ member }`, delete `key: { member }`;
 * - zset: insert `{ member, score }`, update/delete `key: { member }` guarded by `original.score`;
 * - stream: delete `key: { id }` (entries cannot be changed).
 *
 * TTL changes and key deletes always go to the key table (the keyspace object), because the
 * in-key contract has no TTL column.
 */
import type { Cell, RowChange } from '@yoal/studio/protocol';

export const KEY_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export function isKeyType(type: string): type is KeyType {
	return (KEY_TYPES as readonly string[]).includes(type);
}

/** The column identifying a row inside a key of this type (mirrors the plugin's `ROW_KEY`). */
export const ROW_KEY: Record<KeyType, string | null> = {
	string: null,
	hash: 'field',
	list: 'index',
	set: 'member',
	zset: 'member',
	stream: 'id',
};

function isTruncated(cell: Cell | undefined): boolean {
	return typeof cell === 'object' && cell !== null && !Array.isArray(cell) && cell.$t === 'truncated';
}

/** An original guard, left out when the loaded value is only a preview (it can't be compared). */
function guard(column: string, cell: Cell | undefined): Record<string, Cell> {
	return cell === undefined || isTruncated(cell) ? {} : { [column]: cell };
}

// ---------------------------------------------------------------- key table

export function addStringKey(input: { key: string; value: string; ttlMs: number | null }): RowChange {
	return {
		op: 'insert',
		values: { key: input.key, type: 'string', value: input.value, ...(input.ttlMs === null ? {} : { ttl: input.ttlMs }) },
	};
}

/** Set or clear a key's TTL. `currentTtl` is the loaded TTL cell (ms, or null for no expiry). */
export function setKeyTtl(key: string, ttlMs: number | null, currentTtl: Cell): RowChange {
	return { op: 'update', key: { key }, values: { ttl: ttlMs }, original: { ttl: currentTtl } };
}

export function deleteKey(key: string, type?: string): RowChange {
	return { op: 'delete', key: { key }, ...(type ? { original: { type } } : {}) };
}

// ---------------------------------------------------------------- inside one key

export function setStringValue(value: string, original: Cell): RowChange {
	return { op: 'update', key: {}, values: { value }, original: guard('value', original) };
}

export function addHashField(field: string, value: string): RowChange {
	return { op: 'insert', values: { field, value } };
}

export function setHashField(field: string, value: string, original: Cell): RowChange {
	return { op: 'update', key: { field }, values: { value }, original: guard('value', original) };
}

export function deleteHashField(field: string, original?: Cell): RowChange {
	return { op: 'delete', key: { field }, original: guard('value', original) };
}

export function appendListItem(value: string): RowChange {
	return { op: 'insert', values: { value } };
}

export function setListItem(index: number, value: string, original: Cell): RowChange {
	return { op: 'update', key: { index }, values: { value }, original: guard('value', original) };
}

export function deleteListItem(index: number, original?: Cell): RowChange {
	return { op: 'delete', key: { index }, original: guard('value', original) };
}

export function addSetMember(member: string): RowChange {
	return { op: 'insert', values: { member } };
}

export function removeSetMember(member: string): RowChange {
	return { op: 'delete', key: { member } };
}

export function addZsetMember(member: string, score: number): RowChange {
	return { op: 'insert', values: { member, score } };
}

export function setZsetScore(member: string, score: number, original: Cell): RowChange {
	return { op: 'update', key: { member }, values: { score }, original: guard('score', original) };
}

export function removeZsetMember(member: string, original?: Cell): RowChange {
	return { op: 'delete', key: { member }, original: guard('score', original) };
}

export function deleteStreamEntry(id: string): RowChange {
	return { op: 'delete', key: { id } };
}

/** Parse a zset score as the plugin accepts it (any finite number, `inf` is refused). */
export function parseScore(text: string): { ok: true; score: number } | { ok: false; error: string } {
	const trimmed = text.trim();
	const score = trimmed === '' ? Number.NaN : Number(trimmed);
	if (!Number.isFinite(score)) return { ok: false, error: 'A score is a finite number, like 1, -2.5 or 1e3.' };
	return { ok: true, score };
}

/**
 * Drop UI-only columns (e.g. the human `expires` column) from changes the grid built, so the
 * plugin only sees its own columns.
 */
export function withoutColumns(changes: RowChange[], names: readonly string[]): RowChange[] {
	const strip = (record: Record<string, Cell>) =>
		Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));
	return changes.map((change): RowChange => {
		if (change.op === 'insert') return { op: 'insert', values: strip(change.values) };
		if (change.op === 'update')
			return { op: 'update', key: strip(change.key), values: strip(change.values), original: strip(change.original) };
		return { op: 'delete', key: strip(change.key), ...(change.original ? { original: strip(change.original) } : {}) };
	});
}
