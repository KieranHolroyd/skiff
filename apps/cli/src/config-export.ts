/**
 * Helpers for `skif export` (docs/OPERATIONS.md §13): the server builds the snapshot; the CLI
 * picks a file name, renders YAML or JSON and summarises what was left out. The CLI runs on Node,
 * so YAML is emitted here (the document is plain JSON data: objects, arrays, strings, numbers,
 * booleans and null).
 */

export type ExportFormat = 'yaml' | 'json';

export interface ConfigExportSkip {
	section: string;
	code: string;
	reason: string;
}

/** Mirrors `ConfigExport` in @skiff/core; only the header fields the CLI reads are typed. */
export interface ConfigExportDocument {
	apiVersion: string;
	exportedAt: string;
	platform: { url: string; contentDomain: string; version: string };
	org: { id: string; name: string | null; slug: string | null };
	projectFilter: string[] | null;
	projects: Record<string, unknown>[];
	skipped: ConfigExportSkip[];
	[section: string]: unknown;
}

const HEADER_KEYS = new Set(['apiVersion', 'exportedAt', 'platform', 'org', 'projectFilter', 'skipped']);

/** `skiff-config-<org slug or host>-<YYYY-MM-DD>.<ext>`. */
export function defaultExportFileName(doc: Pick<ConfigExportDocument, 'org' | 'platform' | 'exportedAt'>, format: ExportFormat): string {
	let label = doc.org.slug ?? '';
	if (!label) {
		try {
			label = new URL(doc.platform.url).hostname;
		} catch {
			label = doc.org.id;
		}
	}
	const safe = label.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
	return `skiff-config-${safe}-${doc.exportedAt.slice(0, 10)}.${format === 'json' ? 'json' : 'yaml'}`;
}

/** `--format` wins; otherwise the `--out` extension decides; YAML by default. */
export function exportFormatFor(format: string | undefined, out: string | undefined): ExportFormat {
	if (format !== undefined) {
		const value = format.toLowerCase();
		if (value === 'yaml' || value === 'yml') return 'yaml';
		if (value === 'json') return 'json';
		throw new Error(`--format must be yaml or json, not "${format}".`);
	}
	if (out && /\.json$/i.test(out)) return 'json';
	return 'yaml';
}

export function renderExport(doc: ConfigExportDocument, format: ExportFormat): string {
	if (format === 'json') return `${JSON.stringify(doc, null, 2)}\n`;
	const header = [
		'# Skiff config export: configuration only, no data and no secret values.',
		`# ${doc.platform.url}, org ${doc.org.slug ?? doc.org.id}, exported ${doc.exportedAt}`,
	];
	return `${header.join('\n')}\n${toYaml(doc)}\n`;
}

/** Sections that hold something, with a count where it is a list. */
export function exportSummary(doc: ConfigExportDocument): { section: string; count: string }[] {
	return Object.entries(doc)
		.filter(([key, value]) => !HEADER_KEYS.has(key) && value !== undefined)
		.map(([section, value]) => ({
			section,
			count: Array.isArray(value) ? String(value.length) : value && typeof value === 'object' ? 'yes' : String(value),
		}));
}

// ------------------------------------------------------------------------------------- YAML

const PLAIN = /^[A-Za-z_][A-Za-z0-9_./@+-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

function scalar(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
	const text = String(value);
	// JSON double-quoted strings are valid YAML, so anything that is not obviously plain is quoted.
	return PLAIN.test(text) && !RESERVED.test(text) ? text : JSON.stringify(text);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	return typeof value === 'object' && value !== null;
}

function isEmpty(value: Record<string, unknown> | unknown[]): boolean {
	return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

function inline(value: Record<string, unknown> | unknown[]): string {
	return Array.isArray(value) ? '[]' : '{}';
}

/** Block-style YAML for JSON data; keys whose value is `undefined` are dropped, as JSON does. */
export function toYaml(value: unknown, indent = 0): string {
	const pad = '  '.repeat(indent);
	if (!isContainer(value)) return `${pad}${scalar(value)}`;
	if (isEmpty(value)) return `${pad}${inline(value)}`;
	const lines: string[] = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			if (isContainer(item) && !isEmpty(item)) {
				const nested = toYaml(item, indent + 1);
				// The first line of the nested block sits after the dash.
				lines.push(`${pad}- ${nested.slice((indent + 1) * 2)}`);
			} else lines.push(`${pad}- ${isContainer(item) ? inline(item) : scalar(item)}`);
		}
		return lines.join('\n');
	}
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		const name = scalar(key);
		if (isContainer(item) && !isEmpty(item)) lines.push(`${pad}${name}:\n${toYaml(item, indent + 1)}`);
		else lines.push(`${pad}${name}: ${isContainer(item) ? inline(item) : scalar(item)}`);
	}
	return lines.join('\n');
}
