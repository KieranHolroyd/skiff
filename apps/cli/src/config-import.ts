/**
 * Helpers for `yoal import` (docs/OPERATIONS.md §14): read a secrets file and render the plan or
 * result the server returns. The server parses the export (YAML or JSON) and does all the work.
 */
import { renderTable, truncate } from './output.ts';

export type ImportStatus = 'planned' | 'done' | 'exists' | 'skipped' | 'failed';

export interface ImportStep {
	key: string;
	section: string;
	kind: string;
	name: string;
	action: 'create' | 'exists' | 'skip';
	status: ImportStatus;
	reason: string | null;
	dependsOn: string[];
}

export interface ImportView {
	mode: 'plan' | 'apply';
	source: { platform: string | null; org: string | null; exportedAt: string | null };
	steps: ImportStep[];
	manual: { section: string; item: string; what: string }[];
	warnings: string[];
	summary: Record<ImportStatus, number>;
}

const SECRET_KEY = /^([a-z0-9][a-z0-9-]*\/)?[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a dotenv-style secrets file: `NAME=value` (org-wide) or `project-slug/NAME=value`.
 * Blank lines and `#` comments are ignored; a value may be wrapped in single or double quotes
 * (double quotes understand `\n`, `\"` and `\\`).
 */
export function parseSecretsFile(text: string): Record<string, string> {
	const secrets: Record<string, string> = {};
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) return;
		const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
		const eq = body.indexOf('=');
		if (eq <= 0) throw new Error(`Line ${index + 1}: expected NAME=value.`);
		const key = body.slice(0, eq).trim();
		if (!SECRET_KEY.test(key)) throw new Error(`Line ${index + 1}: "${key}" is not NAME or project-slug/NAME.`);
		let value = body.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
			value = value.slice(1, -1).replace(/\\(n|"|\\)/g, (_, char: string) => (char === 'n' ? '\n' : char));
		else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		secrets[key] = value;
	});
	return secrets;
}

/** Split `--only a,b --only c` style values. */
export function listFlag(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);
}

const STATUS_LABEL: Record<ImportStatus, string> = {
	planned: 'create',
	done: 'created',
	exists: 'exists',
	skipped: 'skipped',
	failed: 'FAILED',
};

export function renderImport(view: ImportView, options: { all?: boolean } = {}): string {
	const lines: string[] = [];
	const source = [view.source.org, view.source.platform, view.source.exportedAt].filter(Boolean).join(' · ');
	if (source) lines.push(`From ${source}`, '');
	// Unchanged resources are noise in a long plan; show them only with --all.
	const shown = options.all ? view.steps : view.steps.filter((step) => step.status !== 'exists');
	if (shown.length) {
		lines.push(
			renderTable(
				['STATUS', 'KIND', 'NAME', 'NOTE'],
				shown.map((step) => [STATUS_LABEL[step.status], step.kind, step.name, truncate(step.reason ?? '', 90)]),
			),
		);
	} else lines.push('Nothing to create: everything in the file is already here.');
	const hidden = view.steps.length - shown.length;
	if (hidden > 0) lines.push(`(${hidden} already exist; --all lists them)`);
	if (view.warnings.length) lines.push('', 'Warnings:', ...view.warnings.map((warning) => `  - ${warning}`));
	if (view.manual.length) {
		lines.push('', `By hand afterwards (${view.manual.length}):`);
		lines.push(renderTable(['SECTION', 'ITEM', 'WHAT TO DO'], view.manual.map((entry) => [entry.section, entry.item, entry.what])));
	}
	const s = view.summary;
	lines.push(
		'',
		view.mode === 'plan'
			? `Plan: ${s.planned} to create, ${s.exists} already exist, ${s.skipped} skipped.`
			: `Done: ${s.done} created, ${s.exists} already existed, ${s.skipped} skipped, ${s.failed} failed.`,
	);
	return lines.join('\n');
}
