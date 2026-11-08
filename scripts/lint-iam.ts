#!/usr/bin/env bun
/**
 * IAM migration guard (IAM.md I0/I4).
 *
 * Authorization must not branch on a role name or a principal kind: both are replaced by a
 * permission check (`iam.require(principal, permission, resource)`), so custom roles, guests and
 * machine principals all go through one path. This linter stops new checks appearing while the
 * existing ones are migrated module by module.
 *
 * It counts two patterns outside `packages/core/src/iam/` and `packages/contracts/src/iam/`:
 *   - `.role === 'owner' | 'admin' | …`
 *   - `.kind === 'user' | 'system' | …`
 *
 * Existing counts are recorded in `scripts/iam-lint-baseline.json`. `bun run check` fails when a
 * file gains a check or a file with checks disappears without the baseline being updated. Burn the
 * baseline down; never raise it. Tests are exempt: they exercise pure role functions directly.
 *
 *   bun scripts/lint-iam.ts            check against the baseline
 *   bun scripts/lint-iam.ts --update   rewrite the baseline (only after a real reduction)
 *   bun scripts/lint-iam.ts --list     print every finding
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOTS = ['packages', 'apps'];
const BASELINE = 'scripts/iam-lint-baseline.json';
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'dist', 'build', '.output', 'generated', 'coverage']);
const SKIP_FILES = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\.d\.ts$/];
const EXEMPT_DIRS = ['packages/core/src/iam/', 'packages/contracts/src/iam/'];
/** The definition site: `principal.ts` may inspect its own kind. */
const EXEMPT_FILES = new Set(['packages/contracts/src/principal.ts']);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.svelte']);

const RULES = {
	role: /principal\s*[?!]?\s*\.\s*role\s*===?\s*['"`]/g,
	kind: /principal\s*[?!]?\s*\.\s*kind\s*===?\s*['"`]/g,
} as const;

type Rule = keyof typeof RULES;
type Baseline = Record<string, Partial<Record<Rule, number>>>;

export interface Finding {
	file: string;
	line: number;
	rule: Rule;
	text: string;
}

function walk(directory: string, out: string[]): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith('.') && entry.name !== '.svelte-kit') continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(path, out);
			continue;
		}
		if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue;
		if (SKIP_FILES.some((pattern) => pattern.test(entry.name))) continue;
		out.push(path);
	}
}

export function scan(root = process.cwd()): Finding[] {
	const files: string[] = [];
	for (const directory of ROOTS) {
		try {
			walk(join(root, directory), files);
		} catch {
			// A workspace without this root (docs-only checkout).
		}
	}
	const findings: Finding[] = [];
	for (const path of files) {
		const file = relative(root, path).split('\\').join('/');
		if (EXEMPT_DIRS.some((prefix) => file.startsWith(prefix))) continue;
		if (EXEMPT_FILES.has(file)) continue;
		const lines = readFileSync(path, 'utf8').split('\n');
		for (const [index, line] of lines.entries()) {
			for (const rule of Object.keys(RULES) as Rule[]) {
				RULES[rule].lastIndex = 0;
				if (RULES[rule].test(line))
					findings.push({ file, line: index + 1, rule, text: line.trim().slice(0, 160) });
			}
		}
	}
	return findings;
}

export function toBaseline(findings: Finding[]): Baseline {
	const baseline: Baseline = {};
	for (const finding of findings) {
		const counts = (baseline[finding.file] ??= {});
		counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
	}
	return baseline;
}

function readBaseline(root: string): Baseline {
	try {
		return JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as Baseline;
	} catch {
		return {};
	}
}

/** Findings that exceed the recorded counts, per file and rule. */
export function newViolations(findings: Finding[], baseline: Baseline): Finding[] {
	const seen: Baseline = {};
	return findings.filter((finding) => {
		const counts = (seen[finding.file] ??= {});
		const used = (counts[finding.rule] = (counts[finding.rule] ?? 0) + 1);
		return used > (baseline[finding.file]?.[finding.rule] ?? 0);
	});
}

function main(): void {
	const root = process.cwd();
	const findings = scan(root);
	const update = process.argv.includes('--update');
	const list = process.argv.includes('--list');

	if (list) for (const finding of findings) console.log(`${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}`);

	if (update) {
		writeFileSync(join(root, BASELINE), `${JSON.stringify(toBaseline(findings), null, '\t')}\n`);
		console.log(`iam lint: baseline updated with ${findings.length} finding(s).`);
		return;
	}

	const extra = newViolations(findings, readBaseline(root));
	const total = Object.values(readBaseline(root)).reduce(
		(sum, counts) => sum + Object.values(counts).reduce((fileSum, count) => fileSum + (count ?? 0), 0),
		0,
	);
	if (extra.length === 0) {
		console.log(`iam lint: no new role/kind checks (baseline ${total}).`);
		return;
	}
	for (const finding of extra) console.error(`${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}`);
	console.error(
		`iam lint: ${extra.length} new role/kind check(s). Use a permission from the catalog instead (IAM.md I4).`,
	);
	process.exit(1);
}

if (import.meta.main) main();
