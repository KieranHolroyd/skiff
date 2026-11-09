/**
 * Schema sampling for the document workspace. `describe` infers columns from a 1,000-document
 * `$sample`, but reports only each field's types (`mixed(int, string)`), not how common each one
 * is. The schema tab therefore runs one read-only aggregate through `run` (allowed in read-only
 * sessions) that counts `[field, $type]` pairs over a fresh sample. A sentinel pair per document
 * gives the sample size in the same pass: field names can never contain NUL.
 */
import type { Cell, Column } from '@yoal/studio/protocol';
import { cellToDisplay, type Json } from './ejson.js';

export const SCHEMA_SAMPLE_SIZE = 1_000;
const SENTINEL = '\u0000';

/** The `run` input that samples a collection's field types. */
export function schemaCommand(collection: string, size = SCHEMA_SAMPLE_SIZE): string {
	return JSON.stringify({
		aggregate: collection,
		pipeline: [
			{ $sample: { size } },
			{
				$project: {
					_id: 0,
					f: { $concatArrays: [[{ k: SENTINEL, v: null }], { $objectToArray: '$$ROOT' }] },
				},
			},
			{ $unwind: '$f' },
			{ $group: { _id: { k: '$f.k', t: { $type: '$f.v' } }, n: { $sum: 1 } } },
		],
	});
}

export interface SchemaType {
	type: string;
	count: number;
	/** Share of sampled documents with this field holding this type, 0–1. */
	share: number;
}

export interface SchemaField {
	name: string;
	/** Documents carrying the field (any type, null included). */
	count: number;
	share: number;
	types: SchemaType[];
}

export interface SchemaSummary {
	sampleSize: number;
	fields: SchemaField[];
}

function asNumber(value: Json | undefined): number {
	if (typeof value === 'number') return value;
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const inner = value.$numberInt ?? value.$numberLong ?? value.$numberDouble;
		if (typeof inner === 'string') return Number(inner);
	}
	return Number.NaN;
}

/** Turn the aggregate's rows (`_id: {k, t}`, `n`) into per-field type shares, `_id` first. */
export function summarizeSchema(columns: Column[], rows: Cell[][]): SchemaSummary {
	const idIndex = columns.findIndex((column) => column.name === '_id');
	const countIndex = columns.findIndex((column) => column.name === 'n');
	let sampleSize = 0;
	const byField = new Map<string, Map<string, number>>();
	if (idIndex >= 0 && countIndex >= 0) {
		for (const row of rows) {
			const group = cellToDisplay(row[idIndex] ?? null);
			const count = asNumber(cellToDisplay(row[countIndex] ?? null));
			if (!group || typeof group !== 'object' || Array.isArray(group) || !Number.isFinite(count)) continue;
			const name = group.k;
			const type = typeof group.t === 'string' ? group.t : 'unknown';
			if (typeof name !== 'string') continue;
			if (name === SENTINEL) {
				sampleSize += count;
				continue;
			}
			const types = byField.get(name) ?? new Map<string, number>();
			types.set(type, (types.get(type) ?? 0) + count);
			byField.set(name, types);
		}
	}
	const share = (n: number) => (sampleSize > 0 ? n / sampleSize : 0);
	const fields = [...byField.entries()].map(([name, types]): SchemaField => {
		const list = [...types.entries()]
			.map(([type, count]) => ({ type, count, share: share(count) }))
			.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
		const count = list.reduce((sum, type) => sum + type.count, 0);
		return { name, count, share: share(count), types: list };
	});
	fields.sort((a, b) => {
		if (a.name === '_id') return -1;
		if (b.name === '_id') return 1;
		return b.count - a.count || a.name.localeCompare(b.name);
	});
	return { sampleSize, fields };
}

/** "42%" with one decimal under 10%, "<0.1%" for a sliver. */
export function formatShare(share: number): string {
	if (share <= 0) return '0%';
	const percent = share * 100;
	if (percent < 0.1) return '<0.1%';
	if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
	return `${Math.round(percent)}%`;
}
