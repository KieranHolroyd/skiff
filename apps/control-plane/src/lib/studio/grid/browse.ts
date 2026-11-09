import {
	filterOps,
	type BrowseQuery,
	type Cell,
	type CellKind,
	type Column,
	type FilterOp,
	type StudioCapabilities
} from '@yoal/studio/protocol';
import { parseEdit } from './edit.js';

/** Filter-builder and browse helpers for the relational workspace (plan 22). Pure. */

export const filterOpLabels: Record<FilterOp, string> = {
	eq: '=',
	ne: '≠',
	lt: '<',
	lte: '≤',
	gt: '>',
	gte: '≥',
	like: 'like',
	ilike: 'ilike',
	in: 'in',
	'is-null': 'is null',
	'not-null': 'is not null'
};

const ORDERED: ReadonlySet<CellKind> = new Set([
	'text',
	'number',
	'bigint',
	'decimal',
	'date',
	'time',
	'datetime',
	'interval',
	'uuid',
	'enum',
	'objectid'
]);
const PATTERN: ReadonlySet<CellKind> = new Set(['text', 'enum', 'uuid', 'unknown', 'json', 'time', 'interval']);
const OPAQUE: ReadonlySet<CellKind> = new Set(['json', 'document', 'bytes', 'array']);

/** The ops that make sense for a column, in the protocol's order. */
export function filterOpsFor(column: Column): FilterOp[] {
	return filterOps.filter((op) => {
		if (op === 'is-null' || op === 'not-null') return true;
		if (op === 'like' || op === 'ilike') return PATTERN.has(column.kind);
		if (OPAQUE.has(column.kind)) return false;
		if (column.kind === 'boolean') return op === 'eq' || op === 'ne';
		if (op === 'eq' || op === 'ne' || op === 'in') return true;
		return ORDERED.has(column.kind);
	});
}

export function opNeedsValue(op: FilterOp): boolean {
	return op !== 'is-null' && op !== 'not-null';
}

export interface FilterDraft {
	column: string;
	op: FilterOp;
	value: string;
}

export type FilterBuild =
	| { ok: true; filter: BrowseQuery['filter'] }
	| { ok: false; error: string; index: number };

/** One filter value typed by the column's kind (a number stays a number, a date keeps its tag). */
export function filterValue(column: Column, op: FilterOp, text: string): { ok: true; value: Cell } | { ok: false; error: string } {
	if (op === 'like' || op === 'ilike') return { ok: true, value: text };
	if (op === 'in') {
		const parts = text
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		if (parts.length === 0) return { ok: false, error: 'List at least one value, separated by commas.' };
		const values: Cell[] = [];
		for (const part of parts) {
			const one = scalar(column, part);
			if (!one.ok) return one;
			values.push(one.value);
		}
		return { ok: true, value: values };
	}
	return scalar(column, text);
}

function scalar(column: Column, text: string): { ok: true; value: Cell } | { ok: false; error: string } {
	// Filter values aren't edits of an existing cell: parse as a fresh (NULL-original) value.
	const kind: CellKind = column.kind;
	if (kind === 'text' || kind === 'enum' || kind === 'uuid' || kind === 'objectid' || kind === 'unknown')
		return { ok: true, value: text };
	if (kind === 'time' || kind === 'interval') return { ok: true, value: text };
	const parsed = parseEdit({ ...column, editable: true }, null, text);
	return parsed.ok ? parsed : { ok: false, error: parsed.error };
}

/** Turn the builder's rows into the protocol's filter, or the first problem. */
export function buildFilter(columns: Column[], drafts: FilterDraft[]): FilterBuild {
	const filter: BrowseQuery['filter'] = [];
	for (const [index, draft] of drafts.entries()) {
		const column = columns.find((candidate) => candidate.name === draft.column);
		if (!column) return { ok: false, error: 'Choose a column.', index };
		if (!filterOpsFor(column).includes(draft.op))
			return { ok: false, error: `${filterOpLabels[draft.op]} doesn't apply to ${column.name}.`, index };
		if (!opNeedsValue(draft.op)) {
			filter.push({ column: column.name, op: draft.op });
			continue;
		}
		const value = filterValue(column, draft.op, draft.value);
		if (!value.ok) return { ok: false, error: `${column.name}: ${value.error}`, index };
		filter.push({ column: column.name, op: draft.op, value: value.value });
	}
	return { ok: true, filter };
}

export type SortSpec = BrowseQuery['sort'];

/**
 * Header click: plain click sorts by that column alone (asc → desc → off); shift-click adds it
 * to the sort or flips/removes it in place.
 */
export function nextSort(sort: SortSpec, column: string, additive: boolean): SortSpec {
	const current = sort.find((entry) => entry.column === column);
	const flipped = !current ? 'asc' : current.dir === 'asc' ? 'desc' : null;
	if (!additive) return flipped ? [{ column, dir: flipped }] : [];
	if (!current) return [...sort, { column, dir: 'asc' as const }].slice(0, 8);
	if (!flipped) return sort.filter((entry) => entry.column !== column);
	return sort.map((entry) => (entry.column === column ? { column, dir: flipped } : entry));
}

/** Quote one identifier for the session's SQL dialect. */
export function quoteIdent(name: string, dialect: StudioCapabilities['dialect']): string {
	if (dialect === 'mysql' || dialect === 'mariadb') return `\`${name.replaceAll('`', '``')}\``;
	return `"${name.replaceAll('"', '""')}"`;
}

/** `SELECT * FROM "schema"."table" LIMIT 100`, quoted for the dialect. */
export function selectStatement(
	path: string[],
	dialect: StudioCapabilities['dialect'],
	limit = 100
): string {
	return `SELECT * FROM ${path.map((part) => quoteIdent(part, dialect)).join('.')} LIMIT ${limit}`;
}
