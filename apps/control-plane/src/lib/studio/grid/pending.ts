import type { ApplyResult, Cell, Column, RowChange } from '@skiff/studio/protocol';
import { cellsEqual, isTruncated } from './cells.js';

/**
 * The grid's pending-changes tray (plan 22): edits collect here until the user applies them, and
 * `buildChanges` turns them into the protocol's `RowChange[]` with optimistic-concurrency
 * originals. Every function returns a new value; the component keeps one in `$state`.
 */
export interface Pending {
	/** Loaded row index → column name → new value. Only columns that differ are kept. */
	updates: Record<number, Record<string, Cell>>;
	/** Loaded row indexes marked for deletion. */
	deletes: number[];
	/** New rows, column name → value. Columns left out take the database default. */
	inserts: Record<string, Cell>[];
}

/** Which grid row a built change came from, so conflicts can be shown on it. */
export type ChangeTarget = { op: 'update' | 'delete'; row: number } | { op: 'insert'; insert: number };

export function emptyPending(): Pending {
	return { updates: {}, deletes: [], inserts: [] };
}

export function targetId(target: ChangeTarget): string {
	return target.op === 'insert' ? `i:${target.insert}` : `${target.op[0]}:${target.row}`;
}

/** Number of row changes in the tray (an edited row counts once, however many cells changed). */
export function pendingCount(pending: Pending): number {
	const deleted = new Set(pending.deletes);
	const updated = Object.keys(pending.updates).filter((row) => !deleted.has(Number(row))).length;
	return updated + pending.deletes.length + pending.inserts.length;
}

/** The pending value of a loaded cell, or `undefined` when it is unchanged. */
export function editedValue(pending: Pending, row: number, column: string): Cell | undefined {
	const values = pending.updates[row];
	return values && Object.hasOwn(values, column) ? values[column] : undefined;
}

/** Record an edit of a loaded cell. Editing back to the original drops it from the tray. */
export function setCellEdit(
	pending: Pending,
	row: number,
	column: string,
	value: Cell,
	original: Cell
): Pending {
	const values = { ...(pending.updates[row] ?? {}) };
	if (cellsEqual(value, original)) delete values[column];
	else values[column] = value;
	const updates = { ...pending.updates };
	if (Object.keys(values).length === 0) delete updates[row];
	else updates[row] = values;
	return { ...pending, updates };
}

export function toggleDelete(pending: Pending, row: number): Pending {
	const deletes = pending.deletes.includes(row)
		? pending.deletes.filter((index) => index !== row)
		: [...pending.deletes, row].sort((a, b) => a - b);
	return { ...pending, deletes };
}

export function addInsert(pending: Pending): Pending {
	return { ...pending, inserts: [...pending.inserts, {}] };
}

export function removeInsert(pending: Pending, insert: number): Pending {
	return { ...pending, inserts: pending.inserts.filter((_, index) => index !== insert) };
}

export function setInsertValue(pending: Pending, insert: number, column: string, value: Cell): Pending {
	return {
		...pending,
		inserts: pending.inserts.map((values, index) =>
			index === insert ? { ...values, [column]: value } : values
		)
	};
}

export interface BuildInput {
	columns: Column[];
	/** Loaded rows, with any full values loaded in place of `truncated` previews. */
	rows: Cell[][];
	keyColumns: string[];
	pending: Pending;
}

export interface BuildOutput {
	changes: RowChange[];
	/** `targets[i]` is the grid row `changes[i]` came from. */
	targets: ChangeTarget[];
	/** Reasons the tray can't be applied as it stands; empty when it can. */
	problems: string[];
}

/**
 * Build the `apply` batch: deletes first (so a re-insert of the same key works), then updates,
 * then inserts, each in grid order.
 *
 * - `update`: `key` from `keyColumns` (the loaded values, so editing a key column works),
 *   `values` only the changed columns, `original` those columns' loaded values.
 * - `insert`: the values the user set.
 * - `delete`: the key and the original row (minus `truncated` previews, which can't be compared).
 */
export function buildChanges({ columns, rows, keyColumns, pending }: BuildInput): BuildOutput {
	const changes: RowChange[] = [];
	const targets: ChangeTarget[] = [];
	const problems: string[] = [];
	const indexOf = new Map(columns.map((column, index) => [column.name, index]));

	const missing = keyColumns.filter((name) => !indexOf.has(name));
	const canKey = keyColumns.length > 0 && missing.length === 0;
	if (keyColumns.length === 0 && (pending.deletes.length > 0 || Object.keys(pending.updates).length > 0))
		problems.push('This object has no key, so rows can only be inserted.');
	if (missing.length > 0) problems.push(`The key column ${missing.join(', ')} is not in the result.`);

	const keyOf = (row: number): Record<string, Cell> | null => {
		const cells = rows[row];
		if (!cells || !canKey) return null;
		const key: Record<string, Cell> = {};
		for (const name of keyColumns) {
			const cell = cells[indexOf.get(name)!] ?? null;
			if (cell === null) {
				problems.push(`Row ${row + 1} has a NULL ${name}, so it can't be identified.`);
				return null;
			}
			if (isTruncated(cell)) {
				problems.push(`Row ${row + 1}'s key ${name} is truncated; load it first.`);
				return null;
			}
			key[name] = cell;
		}
		return key;
	};

	for (const row of pending.deletes) {
		const key = keyOf(row);
		if (!key) continue;
		const original: Record<string, Cell> = {};
		columns.forEach((column, index) => {
			const cell = rows[row]?.[index] ?? null;
			if (!isTruncated(cell)) original[column.name] = cell;
		});
		changes.push({ op: 'delete', key, original });
		targets.push({ op: 'delete', row });
	}

	const deleted = new Set(pending.deletes);
	const updatedRows = Object.keys(pending.updates)
		.map(Number)
		.filter((row) => !deleted.has(row))
		.sort((a, b) => a - b);
	for (const row of updatedRows) {
		const edits = pending.updates[row]!;
		const key = keyOf(row);
		if (!key) continue;
		const values: Record<string, Cell> = {};
		const original: Record<string, Cell> = {};
		for (const [name, value] of Object.entries(edits)) {
			const index = indexOf.get(name);
			if (index === undefined) {
				problems.push(`Unknown column ${name}.`);
				continue;
			}
			const before = rows[row]?.[index] ?? null;
			if (isTruncated(before)) {
				problems.push(`Row ${row + 1}'s ${name} is truncated; load it before editing.`);
				continue;
			}
			if (cellsEqual(value, before)) continue;
			values[name] = value;
			original[name] = before;
		}
		if (Object.keys(values).length === 0) continue;
		changes.push({ op: 'update', key, values, original });
		targets.push({ op: 'update', row });
	}

	pending.inserts.forEach((values, insert) => {
		changes.push({ op: 'insert', values: { ...values } });
		targets.push({ op: 'insert', insert });
	});

	return { changes, targets, problems };
}

/** Map an apply result's conflicts onto grid rows: target id → reason. */
export function conflictsByTarget(result: ApplyResult, targets: ChangeTarget[]): Record<string, string> {
	const byTarget: Record<string, string> = {};
	for (const conflict of result.conflicts) {
		const target = targets[conflict.index];
		if (target) byTarget[targetId(target)] = conflict.reason;
	}
	return byTarget;
}
