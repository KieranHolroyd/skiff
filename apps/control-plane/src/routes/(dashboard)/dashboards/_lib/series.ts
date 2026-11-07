import type { ObservabilitySchema, QueryColumn, QueryResult } from '@skiff/contracts';

/**
 * Turns a `QueryResult` into what the panels draw.
 *
 * - A `time` column plus numeric columns: one series per numeric column.
 * - A `time` column, string column(s) and numeric column(s): one series per distinct string
 *   value (long → wide), named after the value (`project_id` and friends get display names).
 * - No time column: categorical rows, labelled by their string columns.
 */

export type Names = ObservabilitySchema['names'];

export interface Series {
	name: string;
	/** The numeric column the values came from. */
	field: string;
	values: Array<number | null>;
}

export interface TimeFrame {
	kind: 'time';
	/** Sorted epoch ms, shared by every series. */
	times: number[];
	series: Series[];
}

export interface CategoryFrame {
	kind: 'category';
	categories: string[];
	/** One per numeric column, values aligned with `categories`. */
	series: Series[];
}

export type Frame = TimeFrame | CategoryFrame;

const ID_COLUMNS: Record<string, keyof Names> = {
	project_id: 'project',
	database_id: 'database',
	storage_id: 'storage',
	broker_id: 'broker'
};

/** Which name map a column's values belong to, if any. */
export function idKindOf(column: string): keyof Names | null {
	return ID_COLUMNS[column] ?? null;
}

/** A cell as display text, mapping id columns to names. */
export function labelValue(column: string, value: unknown, names?: Names): string {
	if (value === null || value === undefined || value === '') return '—';
	const text = String(value);
	const kind = idKindOf(column);
	if (kind && names) return names[kind][text] ?? text;
	return text;
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const number = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(number) ? number : null;
}

function isNumeric(column: QueryColumn): boolean {
	return column.kind === 'number';
}

function isLabel(column: QueryColumn): boolean {
	return column.kind === 'string' || column.kind === 'other';
}

export function toFrame(result: QueryResult, names?: Names): Frame {
	const timeIndex = result.columns.findIndex((column) => column.kind === 'time');
	const numeric = result.columns
		.map((column, index) => ({ column, index }))
		.filter(({ column, index }) => index !== timeIndex && isNumeric(column));
	const labels = result.columns
		.map((column, index) => ({ column, index }))
		.filter(({ column, index }) => index !== timeIndex && isLabel(column));

	const labelOf = (row: QueryResult['rows'][number]) =>
		labels.map(({ column, index }) => labelValue(column.name, row[index], names)).join(' · ');

	if (timeIndex < 0) {
		const categories = result.rows.map((row) => labelOf(row) || '');
		return {
			kind: 'category',
			categories: categories.map((label, index) => label || String(index + 1)),
			series: numeric.map(({ column, index }) => ({
				name: column.name,
				field: column.name,
				values: result.rows.map((row) => toNumber(row[index]))
			}))
		};
	}

	const times = [
		...new Set(
			result.rows.map((row) => toNumber(row[timeIndex])).filter((t): t is number => t !== null)
		)
	].sort((a, b) => a - b);
	const position = new Map(times.map((time, index) => [time, index]));

	if (labels.length === 0) {
		const series = numeric.map(({ column }) => ({
			name: column.name,
			field: column.name,
			values: times.map(() => null as number | null)
		}));
		for (const row of result.rows) {
			const at = position.get(toNumber(row[timeIndex]) ?? Number.NaN);
			if (at === undefined) continue;
			numeric.forEach(({ index }, which) => {
				series[which]!.values[at] = toNumber(row[index]);
			});
		}
		return { kind: 'time', times, series };
	}

	// Long → wide: one series per (group, numeric column).
	const byKey = new Map<string, Series>();
	const multi = numeric.length > 1;
	for (const row of result.rows) {
		const at = position.get(toNumber(row[timeIndex]) ?? Number.NaN);
		if (at === undefined) continue;
		const group = labelOf(row) || '—';
		for (const { column, index } of numeric) {
			const key = multi ? `${group} · ${column.name}` : group;
			let series = byKey.get(key);
			if (!series) {
				series = { name: key, field: column.name, values: times.map(() => null) };
				byKey.set(key, series);
			}
			const value = toNumber(row[index]);
			// Several rows for one bucket and group (e.g. an extra label column) add up.
			const current = series.values[at] ?? null;
			series.values[at] = current === null ? value : value === null ? current : current + value;
		}
	}
	return { kind: 'time', times, series: [...byKey.values()] };
}

export type Reducer = 'last' | 'first' | 'mean' | 'max' | 'min' | 'sum';

export const REDUCERS: Array<{ value: Reducer; label: string }> = [
	{ value: 'last', label: 'Last' },
	{ value: 'first', label: 'First' },
	{ value: 'mean', label: 'Mean' },
	{ value: 'max', label: 'Max' },
	{ value: 'min', label: 'Min' },
	{ value: 'sum', label: 'Total' }
];

/** One number from a series; nulls are skipped. */
export function reduce(values: Array<number | null>, how: Reducer = 'last'): number | null {
	const present = values.filter(
		(value): value is number => value !== null && Number.isFinite(value)
	);
	if (present.length === 0) return null;
	switch (how) {
		case 'first':
			return present[0]!;
		case 'last':
			return present.at(-1)!;
		case 'sum':
			return present.reduce((total, value) => total + value, 0);
		case 'mean':
			return present.reduce((total, value) => total + value, 0) / present.length;
		case 'max':
			return Math.max(...present);
		case 'min':
			return Math.min(...present);
	}
}

export interface Item {
	name: string;
	value: number | null;
	/** The raw series, for sparklines. */
	values?: Array<number | null>;
}

/**
 * Named single values for stat, gauge, bar gauge and pie panels. A time frame reduces each
 * series; a category frame with one numeric column gives one item per row; otherwise one item
 * per numeric column (reduced across rows).
 */
export function toItems(frame: Frame, how: Reducer = 'last'): Item[] {
	if (frame.kind === 'time') {
		return frame.series.map((series) => ({
			name: series.name,
			value: reduce(series.values, how),
			values: series.values
		}));
	}
	if (frame.series.length === 1) {
		const only = frame.series[0]!;
		return frame.categories.map((category, index) => ({
			name: frame.categories.length === 1 ? only.name : category,
			value: only.values[index] ?? null
		}));
	}
	return frame.series.map((series) => ({ name: series.name, value: reduce(series.values, how) }));
}

/** Rows ⇄ CSV, for Inspect › Download. */
export function toCsv(result: QueryResult): string {
	const escape = (value: unknown) => {
		if (value === null || value === undefined) return '';
		const text = String(value);
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	const timeColumns = new Set(
		result.columns.flatMap((column, index) => (column.kind === 'time' ? [index] : []))
	);
	const lines = [result.columns.map((column) => escape(column.name)).join(',')];
	for (const row of result.rows) {
		lines.push(
			row
				.map((value, index) =>
					timeColumns.has(index) && typeof value === 'number'
						? new Date(value).toISOString()
						: escape(value)
				)
				.join(',')
		);
	}
	return `${lines.join('\n')}\n`;
}
