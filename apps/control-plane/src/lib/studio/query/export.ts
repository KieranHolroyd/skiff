import type { Cell, Column } from '@yoal/studio/protocol';

/**
 * Result export (plan 22). Cells go out in their plain form: tagged cells (`bigint`, `decimal`,
 * `date`, `json`, `ejson`, `bytes`, `truncated`) export their `v`.
 */

/** A cell as a plain JSON value. */
export function plainCell(cell: Cell): unknown {
	if (cell === null || typeof cell !== 'object') return cell;
	if (Array.isArray(cell)) return cell.map(plainCell);
	return cell.v;
}

/** A cell as CSV text: `null` is empty, structured values are JSON. */
export function cellText(cell: Cell): string {
	const value = plainCell(cell);
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

function csvField(text: string): string {
	return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns: Column[], rows: Cell[][]): string {
	const lines = [columns.map((column) => csvField(column.name)).join(',')];
	for (const row of rows) lines.push(columns.map((_, index) => csvField(cellText(row[index] ?? null))).join(','));
	return `${lines.join('\r\n')}\r\n`;
}

/** Object keys for the columns; repeated names (`a.id`, `b.id`) become `id`, `id_2`, …. */
export function uniqueNames(columns: Column[]): string[] {
	const seen = new Map<string, number>();
	const taken = new Set(columns.map((column) => column.name));
	return columns.map((column) => {
		const count = (seen.get(column.name) ?? 0) + 1;
		seen.set(column.name, count);
		if (count === 1) return column.name;
		let suffix = count;
		while (taken.has(`${column.name}_${suffix}`)) suffix++;
		const name = `${column.name}_${suffix}`;
		taken.add(name);
		return name;
	});
}

export function toJson(columns: Column[], rows: Cell[][]): string {
	const names = uniqueNames(columns);
	const objects = rows.map((row) =>
		Object.fromEntries(names.map((name, index) => [name, plainCell(row[index] ?? null)]))
	);
	return `${JSON.stringify(objects, null, 2)}\n`;
}

/** Start a browser download of `text`. */
export function download(filename: string, text: string, type: string): void {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = 'noopener';
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
