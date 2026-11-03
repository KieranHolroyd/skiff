/** Plain-text output helpers. No colour and no dependencies, so logs stay pipe-friendly. */

export function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, column) => pad(cell ?? '', widths[column] ?? 0))
			.join('  ')
			.replace(/\s+$/, '');
	const out = [line(headers), widths.map((width) => '-'.repeat(width)).join('  ')];
	for (const row of rows) out.push(line(row));
	return out.join('\n');
}

function pad(value: string, width: number): string {
	if (value.length >= width) return value;
	return value + ' '.repeat(width - value.length);
}

export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatTime(value: string | number | undefined): string {
	if (value === undefined || value === null || value === '') return '-';
	const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

export function formatNumber(value: number | undefined): string {
	return value === undefined ? '-' : value.toLocaleString('en-US');
}

export function printJson(value: unknown): void {
	console.log(JSON.stringify(value ?? null, null, 2));
}

/** Show enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
	if (value.length <= 8) return '********';
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB'];
	let value = bytes / 1024;
	let unit = units[0]!;
	for (let i = 1; i < units.length && value >= 1024; i++) {
		value /= 1024;
		unit = units[i]!;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function indent(lines: string[]): string {
	return lines.map((line) => `  ${line}`).join('\n');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}
