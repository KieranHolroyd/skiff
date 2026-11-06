#!/usr/bin/env bun
/**
 * Migration safety check (docs/OPS.md §4.2.2).
 *
 * Enforces the rules that make forward-only migrations safe to roll back to:
 *   1. files are numbered `NNNN_name.sql` and the sequence has no duplicates or gaps;
 *   2. an existing migration is never modified, renamed or deleted (history is append-only);
 *   3. destructive statements are reported for manual review.
 *
 * Exits non-zero for (1) and (2). Destructive statements only fail with `--strict` so a reviewed
 * exception can land, but CI prints them on every run.
 *
 *   bun scripts/check-migrations.ts
 *   SKIFF_MIGRATION_BASE_REF=origin/main bun scripts/check-migrations.ts
 *
 * In CI the base reference should be the PR base SHA (or the previous push SHA), not `HEAD`, so
 * edits committed on the branch are compared with what is already on the target branch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MIGRATIONS_DIR = 'packages/db/migrations';
const MIGRATION_FILE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

export interface MigrationEntry {
	name: string;
	prefix: number;
}

/** One `git diff --name-status` record. `path` is the new path for a rename. */
export interface MigrationChange {
	status: string;
	path: string;
	/** Previous path for a rename (`R…`); equal to `path` otherwise. */
	from?: string;
}

export interface DestructiveStatement {
	file: string;
	line: number;
	statement: string;
}

export interface MigrationCheckInput {
	/** Every `*.sql` file in the migrations directory. */
	names: string[];
	/** Existing migrations changed, renamed or deleted relative to the comparison ref. */
	changed?: MigrationChange[];
	/** File contents keyed by name, used to report destructive statements. */
	contents?: Record<string, string>;
}

export interface MigrationCheckOptions {
	/** Treat destructive statements as errors instead of warnings. */
	strict?: boolean;
	/** Migrations whose destructive statements were reviewed; defaults to the repo's list. */
	reviewed?: Readonly<Record<string, string>>;
}

/**
 * Destructive migrations that passed review, with the decision that allows them. Their statements
 * are reported as notes rather than warnings, and `--strict` does not fail on them. Add an entry
 * only with the migration's decision record (docs/OPS.md §4.2.2).
 */
export const REVIEWED_DESTRUCTIVE_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
	'0033_drop_database_console.sql':
		'D96: drops the retired D60 studio console columns; nothing reads them after the cutover.'
});

export interface MigrationCheckResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
	/** Destructive statements in reviewed migrations, with the reason; never errors. */
	notes: string[];
	migrations: MigrationEntry[];
	destructive: DestructiveStatement[];
}

/** Remove `--` and block comments so a comment mentioning DROP TABLE is not reported. */
export function stripSqlComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

function lineNumberAt(sql: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (sql.charCodeAt(i) === 10) line++;
	return line;
}

const DESTRUCTIVE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/gi },
	{ label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/gi },
	{ label: 'ALTER COLUMN TYPE', pattern: /\bALTER\s+COLUMN\b[\s\S]{0,120}?\bTYPE\b/gi }
];

/** Destructive statements in one migration body, with their source line. */
export function findDestructiveStatements(file: string, sql: string): DestructiveStatement[] {
	const clean = stripSqlComments(sql);
	const found: DestructiveStatement[] = [];
	for (const { label, pattern } of DESTRUCTIVE_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of clean.matchAll(pattern)) {
			found.push({
				file,
				line: lineNumberAt(clean, match.index ?? 0),
				statement: label
			});
		}
	}
	return found.sort((a, b) => a.line - b.line || a.statement.localeCompare(b.statement));
}

/** Validate names/prefixes and changed history, then collect destructive statements. */
export function checkMigrations(
	input: MigrationCheckInput,
	options: MigrationCheckOptions = {}
): MigrationCheckResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const notes: string[] = [];
	const reviewed = options.reviewed ?? REVIEWED_DESTRUCTIVE_MIGRATIONS;
	const migrations: MigrationEntry[] = [];
	const seen = new Map<number, string>();

	for (const name of [...input.names].sort()) {
		const match = MIGRATION_FILE.exec(name);
		if (!match) {
			errors.push(
				`${MIGRATIONS_DIR}/${name}: expected NNNN_lowercase_name.sql (for example 0015_add_feature.sql)`
			);
			continue;
		}
		const prefix = Number(match[1]);
		const previous = seen.get(prefix);
		if (previous) {
			errors.push(
				`${MIGRATIONS_DIR}: duplicate migration prefix ${match[1]} (${previous} and ${name})`
			);
			continue;
		}
		seen.set(prefix, name);
		migrations.push({ name, prefix });
	}

	migrations.sort((a, b) => a.prefix - b.prefix);
	let expected = 1;
	for (const migration of migrations) {
		if (migration.prefix !== expected) {
			const expectedLabel = String(expected).padStart(4, '0');
			const actualLabel = String(migration.prefix).padStart(4, '0');
			errors.push(
				`${MIGRATIONS_DIR}: expected migration ${expectedLabel}, found ${actualLabel} (${migration.name}); numbering must be sequential`
			);
			expected = migration.prefix;
		}
		expected++;
	}

	for (const change of input.changed ?? []) {
		const status = change.status.toUpperCase();
		// New files are the only supported way to change the schema.
		if (status.startsWith('A')) continue;
		const verb = status.startsWith('D')
			? 'deleted'
			: status.startsWith('R')
				? 'renamed'
				: status.startsWith('M')
					? 'modified'
					: 'changed';
		const from = change.from && change.from !== change.path ? `${change.from} -> ` : '';
		errors.push(
			`${MIGRATIONS_DIR}/${from}${change.path}: existing migration was ${verb}; migrations are append-only (add a new file instead)`
		);
	}

	const destructive: DestructiveStatement[] = [];
	for (const [name, sql] of Object.entries(input.contents ?? {})) {
		if (!name.endsWith('.sql')) continue;
		destructive.push(...findDestructiveStatements(name, sql));
	}
	for (const statement of destructive) {
		const reason = reviewed[statement.file];
		if (reason) {
			notes.push(
				`${MIGRATIONS_DIR}/${statement.file}:${statement.line}: ${statement.statement} (reviewed: ${reason})`
			);
			continue;
		}
		const message = `${MIGRATIONS_DIR}/${statement.file}:${statement.line}: ${statement.statement} needs manual review (additive migrations only)`;
		if (options.strict) errors.push(message);
		else warnings.push(message);
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		notes,
		migrations,
		destructive
	};
}

/** Parse `git diff --name-status` output, including renames (`R100\told\tnew`). */
export function parseNameStatus(output: string): MigrationChange[] {
	const changes: MigrationChange[] = [];
	for (const line of output.trim().split('\n')) {
		if (!line.trim()) continue;
		const [status = '', first = '', second] = line.split('\t');
		if (!status) continue;
		changes.push(
			second === undefined
				? { status, path: first }
				: { status, from: first, path: second }
		);
	}
	return changes;
}

/**
 * Existing migrations changed relative to `baseRef`. A zero SHA (a new branch's first push) falls
 * back to `HEAD`, which still catches uncommitted edits in a local run.
 */
export function gitChangedMigrations(baseRef: string, cwd = process.cwd()): MigrationChange[] {
	const ref = !baseRef || /^0+$/.test(baseRef) ? 'HEAD' : baseRef;
	const result = Bun.spawnSync(
		['git', 'diff', '--name-status', '--diff-filter=MDR', ref, '--', MIGRATIONS_DIR],
		{ cwd, stdout: 'pipe', stderr: 'pipe' }
	);
	if (result.exitCode !== 0) {
		const detail = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`git diff against ${ref} failed${detail ? `: ${detail}` : ''}`);
	}
	return parseNameStatus(new TextDecoder().decode(result.stdout));
}

export function readMigrations(root: string): MigrationCheckInput {
	const dir = join(root, MIGRATIONS_DIR);
	const names = readdirSync(dir).filter((name) => name.endsWith('.sql'));
	const contents: Record<string, string> = {};
	for (const name of names) contents[name] = readFileSync(join(dir, name), 'utf8');
	return { names, contents };
}

function main(): void {
	const root = resolve(import.meta.dir, '..');
	const strict = process.argv.includes('--strict');
	const baseRef = process.env.SKIFF_MIGRATION_BASE_REF ?? 'HEAD';
	const input = readMigrations(root);

	let changed: MigrationChange[] = [];
	try {
		changed = gitChangedMigrations(baseRef, root);
	} catch (error) {
		console.error(`check-migrations: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return;
	}

	const result = checkMigrations({ ...input, changed }, { strict });
	console.log(
		`check-migrations: ${result.migrations.length} migration(s), compared with ${baseRef}`
	);
	for (const note of result.notes) console.log(`note: ${note}`);
	for (const warning of result.warnings) console.warn(`warning: ${warning}`);
	for (const error of result.errors) console.error(`error: ${error}`);
	if (!result.ok) {
		console.error(`check-migrations: FAILED (${result.errors.length} error(s))`);
		process.exitCode = 1;
		return;
	}
	console.log('check-migrations: ok');
}

if (import.meta.main) main();
