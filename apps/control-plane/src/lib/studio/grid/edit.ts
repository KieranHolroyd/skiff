import type { Cell, Column } from '@yoal/studio/protocol';
import { cellPretty, isCell, isTagged } from './cells.js';

/**
 * Inline cell editing rules for `StudioGrid` (plan 22). An edit must be writable back losslessly:
 * a tagged scalar keeps its tag (`bigint`, `decimal`, `date`, `datetime`, `bytes`, `json`,
 * `ejson`), input is validated against what the tag can carry, and a `truncated` preview can't be
 * edited until the full value is loaded.
 */

export type EditorKind = 'text' | 'number' | 'boolean' | 'datetime' | 'json';

export type EditPlan = { ok: true; editor: EditorKind } | { ok: false; reason: string };

export type ParseResult = { ok: true; value: Cell } | { ok: false; error: string };

/** Which editor a cell opens with, or why it can't be edited. */
export function editorFor(column: Column, cell: Cell): EditPlan {
	if (column.editable === false)
		return { ok: false, reason: `${column.name} is generated or computed and can't be edited.` };
	if (isTagged(cell)) {
		switch (cell.$t) {
			case 'truncated':
				return { ok: false, reason: 'Load the full value before editing this cell.' };
			case 'json':
			case 'ejson':
				return { ok: true, editor: 'json' };
			case 'bigint':
			case 'decimal':
				return { ok: true, editor: 'number' };
			case 'date':
			case 'datetime':
				return { ok: true, editor: 'datetime' };
			case 'bytes':
				return { ok: true, editor: 'text' };
		}
	}
	if (Array.isArray(cell)) return { ok: true, editor: 'json' };
	switch (column.kind) {
		case 'boolean':
			return { ok: true, editor: 'boolean' };
		case 'number':
		case 'bigint':
		case 'decimal':
			return { ok: true, editor: 'number' };
		case 'date':
		case 'datetime':
		case 'time':
		case 'interval':
			return { ok: true, editor: 'datetime' };
		case 'json':
		case 'document':
		case 'array':
			return { ok: true, editor: 'json' };
		case 'bytes':
			return { ok: true, editor: 'text' };
		default:
			return { ok: true, editor: 'text' };
	}
}

/** The text an editor starts with. NULL starts empty; JSON is pretty-printed. */
export function editInitial(column: Column, cell: Cell, editor: EditorKind): string | boolean {
	if (editor === 'boolean') return cell === true;
	if (cell === null) return '';
	if (editor === 'json') return cellPretty(cell, column);
	if (isTagged(cell)) return typeof cell.v === 'string' ? cell.v : JSON.stringify(cell.v);
	return String(cell);
}

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Turn editor input back into a cell. `original` is the cell's loaded value: its tag wins over
 * the column kind, so a value always travels back in the form it arrived in.
 */
export function parseEdit(column: Column, original: Cell, input: string | boolean): ParseResult {
	const plan = editorFor(column, original);
	if (!plan.ok) return { ok: false, error: plan.reason };
	if (plan.editor === 'boolean') {
		if (typeof input === 'boolean') return { ok: true, value: input };
		if (/^(true|t|1|yes)$/i.test(input.trim())) return { ok: true, value: true };
		if (/^(false|f|0|no)$/i.test(input.trim())) return { ok: true, value: false };
		return { ok: false, error: 'Enter true or false.' };
	}
	const text = typeof input === 'boolean' ? String(input) : input;

	if (isTagged(original)) {
		switch (original.$t) {
			case 'bigint':
				return integer(text, true);
			case 'decimal':
				return decimal(text);
			case 'date':
			case 'datetime':
				return dateText(text, original.$t);
			case 'bytes':
				return bytes(text);
			case 'json':
			case 'ejson':
				return json(text, original.$t);
			case 'truncated':
				return { ok: false, error: 'Load the full value before editing this cell.' };
		}
	}
	if (Array.isArray(original)) return array(text);

	switch (column.kind) {
		case 'number':
			return number(text);
		case 'bigint':
			return integer(text, false);
		case 'decimal':
			// A plain number arrived as a double; keep it one. NULL/new values use the lossless tag.
			return typeof original === 'number' ? number(text) : decimal(text);
		case 'date':
		case 'datetime':
			// A plain string arrived untagged (e.g. MySQL zero dates); keep it untagged.
			return typeof original === 'string'
				? nonEmpty(text, 'Enter a value.')
				: dateText(text, column.kind);
		case 'json':
			return json(text, 'json');
		case 'document':
			return json(text, 'ejson');
		case 'array':
			return array(text);
		case 'bytes':
			return bytes(text);
		default:
			if (typeof original === 'number') return number(text);
			return { ok: true, value: text };
	}
}

function nonEmpty(text: string, error: string): ParseResult {
	return text.trim() === '' ? { ok: false, error } : { ok: true, value: text };
}

function number(text: string): ParseResult {
	const trimmed = text.trim();
	if (trimmed === '' || !DECIMAL.test(trimmed)) return { ok: false, error: 'Enter a number.' };
	const value = Number(trimmed);
	if (!Number.isFinite(value)) return { ok: false, error: 'Enter a finite number.' };
	return { ok: true, value };
}

/** Integers: a safe integer travels as a number unless the original was tagged. */
function integer(text: string, keepTag: boolean): ParseResult {
	const trimmed = text.trim().replace(/^\+/, '');
	if (!INTEGER.test(trimmed)) return { ok: false, error: 'Enter a whole number.' };
	const canonical = BigInt(trimmed).toString();
	const safe =
		BigInt(canonical) <= BigInt(Number.MAX_SAFE_INTEGER) &&
		BigInt(canonical) >= BigInt(Number.MIN_SAFE_INTEGER);
	if (!keepTag && safe) return { ok: true, value: Number(canonical) };
	return { ok: true, value: { $t: 'bigint', v: canonical } };
}

function decimal(text: string): ParseResult {
	const trimmed = text.trim();
	if (!DECIMAL.test(trimmed)) return { ok: false, error: 'Enter a decimal number.' };
	return { ok: true, value: { $t: 'decimal', v: trimmed } };
}

function dateText(text: string, tag: 'date' | 'datetime'): ParseResult {
	const trimmed = text.trim();
	if (trimmed === '') return { ok: false, error: `Enter a ${tag === 'date' ? 'date' : 'date and time'}.` };
	if (tag === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
		return { ok: false, error: 'Enter a date as YYYY-MM-DD.' };
	if (tag === 'datetime' && Number.isNaN(Date.parse(trimmed)))
		return { ok: false, error: 'Enter an ISO 8601 date and time, e.g. 2026-11-06T09:30:00Z.' };
	return { ok: true, value: { $t: tag, v: trimmed } };
}

function bytes(text: string): ParseResult {
	const trimmed = text.trim();
	if (!BASE64.test(trimmed) || trimmed.length % 4 !== 0)
		return { ok: false, error: 'Enter the bytes as base64.' };
	return { ok: true, value: { $t: 'bytes', v: trimmed } };
}

function json(text: string, tag: 'json' | 'ejson'): ParseResult {
	try {
		return { ok: true, value: { $t: tag, v: JSON.parse(text) as unknown } };
	} catch (caught) {
		return { ok: false, error: caught instanceof Error ? `Invalid JSON: ${caught.message}` : 'Invalid JSON.' };
	}
}

/** Arrays are plain JSON arrays of cells; objects inside must be tagged cells. */
function array(text: string): ParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (caught) {
		return { ok: false, error: caught instanceof Error ? `Invalid JSON: ${caught.message}` : 'Invalid JSON.' };
	}
	if (!Array.isArray(value)) return { ok: false, error: 'Enter a JSON array.' };
	if (!isCell(value))
		return { ok: false, error: 'Array items must be plain values or tagged cells like {"$t":"json","v":…}.' };
	return { ok: true, value };
}
