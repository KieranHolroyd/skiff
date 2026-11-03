#!/usr/bin/env bun
/**
 * Platform version (repository-root VERSION, semver). Bumping it on main is what releases an
 * update to installed hosts (docs/OPS.md §4.1), so:
 *
 *   bun run version:minor | version:major   deliberate bumps, run by a human for features / breaking changes
 *   bun run version:patch                   manual patch bump (rarely needed: see `auto`)
 *   bun run version:show                    current, released (origin/main) and pending versions
 *   bun scripts/version.ts auto             the pre-commit hook (.githooks/pre-commit)
 *
 * `auto` only ever bumps the patch number, and only once per release: if VERSION is already
 * ahead of origin/main (an earlier commit, or a manual minor/major bump), it leaves it alone.
 * Commits that only touch docs, tests, CI or the separately versioned CLI never bump.
 * Skip it with `git commit --no-verify` or SKIFF_NO_VERSION_BUMP=1.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	type SemverBump,
	bumpSemver,
	compareSemver,
	parseSemver,
} from '../packages/contracts/src/semver.ts';

// ------------------------------------------------------------------ pure rules

/** Paths whose changes never reach an installed host, so they never need a release. */
const NOT_SHIPPED: RegExp[] = [
	/^docs\//,
	/^\.github\//,
	/^\.githooks\//,
	/^apps\/cli\//, // versioned separately (Release CLI workflow, cli-v* tags)
	/^spikes\//,
	/(^|\/)tests?\//,
	/\.test\.ts$/,
	/\.md$/,
	/^(VERSION|LICENSE|\.gitignore|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
	/^scripts\/version\.ts$/,
];

export function isShipped(path: string): boolean {
	return !NOT_SHIPPED.some((pattern) => pattern.test(path));
}

export type AutoDecision =
	| { action: 'none'; reason: string }
	| { action: 'stage'; version: string; reason: string }
	| { action: 'bump'; from: string; version: string; reason: string }
	| { action: 'error'; reason: string };

/**
 * What the pre-commit hook does, given the staged paths, the working-tree VERSION, the VERSION in
 * the index, and the released VERSION on origin/main (null when unknown).
 */
export function decideAutoBump(input: {
	staged: string[];
	working: string | null;
	indexed: string | null;
	released: string | null;
}): AutoDecision {
	const shipped = input.staged.filter(isShipped);
	if (shipped.length === 0) return { action: 'none', reason: 'no shipped files staged' };
	const working = parseSemver(input.working);
	if (!working) return { action: 'error', reason: `VERSION is not a semantic version: "${(input.working ?? '').trim()}"` };
	const released = parseSemver(input.released);
	if (!released) return { action: 'none', reason: 'origin/main has no VERSION to compare with' };
	if (compareSemver(working, released) > 0) {
		// Already bumped for this release; make sure the bump is part of the commit.
		return parseSemver(input.indexed)?.version === working.version
			? { action: 'none', reason: `${working.version} is already ahead of the released ${released.version}` }
			: { action: 'stage', version: working.version, reason: `staging the pending ${working.version}` };
	}
	// Never go below what is released, even if this checkout is behind origin/main.
	const base = compareSemver(working, released) < 0 ? released : working;
	const version = bumpSemver(base.version, 'patch');
	return {
		action: 'bump',
		from: working.version,
		version,
		reason: `${shipped.length} shipped file${shipped.length === 1 ? '' : 's'} changed since ${released.version}`,
	};
}

/**
 * Manual bumps start from the released version when one exists, so running `minor` twice (or
 * after an automatic patch) gives the next minor, not two releases ahead. Null = nothing to do.
 */
export function manualBump(kind: SemverBump, working: string, released: string | null): string | null {
	const current = parseSemver(working);
	if (!current) throw new TypeError(`VERSION is not a semantic version: "${working.trim()}"`);
	const base = parseSemver(released);
	if (!base || compareSemver(current, base) <= 0) {
		const from = base && compareSemver(base, current) > 0 ? base.version : current.version;
		return bumpSemver(from, kind);
	}
	const next = bumpSemver(base.version, kind);
	return compareSemver(next, current) > 0 ? next : null;
}

// ------------------------------------------------------------------- git + files

function git(args: string[], cwd: string): { ok: boolean; out: string } {
	const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
	return { ok: result.exitCode === 0, out: new TextDecoder().decode(result.stdout).trim() };
}

function repoRoot(): string {
	const top = git(['rev-parse', '--show-toplevel'], process.cwd());
	return top.ok && top.out ? top.out : resolve(import.meta.dir, '..');
}

/** origin's default branch (origin/HEAD), else origin/main. */
function releaseRef(root: string): string | null {
	const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
	if (head.ok && head.out) return head.out;
	return git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], root).ok
		? 'refs/remotes/origin/main'
		: null;
}

function releasedVersion(root: string): { ref: string | null; version: string | null } {
	const ref = releaseRef(root);
	if (!ref) return { ref, version: null };
	const shown = git(['show', `${ref}:VERSION`], root);
	return { ref, version: shown.ok ? shown.out : null };
}

function readVersion(root: string): string | null {
	const path = join(root, 'VERSION');
	return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function writeVersion(root: string, version: string): void {
	const path = join(root, 'VERSION');
	writeFileSync(`${path}.tmp`, `${version}\n`);
	renameSync(`${path}.tmp`, path);
}

const short = (ref: string | null) => (ref ?? 'origin/main').replace(/^refs\/remotes\//, '');

// ------------------------------------------------------------------------- CLI

function auto(root: string): number {
	if (process.env.SKIFF_NO_VERSION_BUMP === '1') return 0;
	const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], root);
	if (!staged.ok) return 0;
	const released = releasedVersion(root);
	if (!released.ref) {
		console.warn('version: no origin/main to compare with; skipping the automatic VERSION bump');
		return 0;
	}
	const indexed = git(['show', ':VERSION'], root);
	const decision = decideAutoBump({
		staged: staged.out ? staged.out.split('\n') : [],
		working: readVersion(root),
		indexed: indexed.ok ? indexed.out : null,
		released: released.version,
	});
	switch (decision.action) {
		case 'none':
			return 0;
		case 'error':
			console.error(`version: ${decision.reason}. Fix VERSION or commit with --no-verify.`);
			return 1;
		case 'stage':
			git(['add', 'VERSION'], root);
			console.log(`version: ${decision.reason}`);
			return 0;
		case 'bump':
			writeVersion(root, decision.version);
			if (!git(['add', 'VERSION'], root).ok) {
				console.error('version: bumped VERSION but could not stage it');
				return 1;
			}
			console.log(
				`version: ${decision.from} → ${decision.version} (automatic patch; ${decision.reason}).\n` +
					'         For features or breaking changes run `bun run version:minor` / `version:major` instead.',
			);
			return 0;
	}
}

function main(): number {
	const [command = 'show', ...rest] = process.argv.slice(2);
	const dryRun = rest.includes('--dry-run');
	const root = repoRoot();
	const working = readVersion(root);

	if (command === 'auto') {
		try {
			return auto(root);
		} catch (error) {
			// The hook must never be the reason a commit fails, except for an invalid VERSION.
			console.warn(`version: automatic bump skipped (${(error as Error).message})`);
			return 0;
		}
	}

	const released = releasedVersion(root);
	if (command === 'show') {
		const current = parseSemver(working)?.version ?? `invalid (${(working ?? 'missing').trim()})`;
		console.log(`VERSION   ${current}`);
		console.log(`released  ${released.version?.trim() ?? 'unknown'} (${short(released.ref)})`);
		if (released.version && parseSemver(working) && compareSemver(working!, released.version) > 0)
			console.log(`pending   ${parseSemver(working)!.version} ships when it reaches ${short(released.ref)}`);
		return 0;
	}

	if (command === 'patch' || command === 'minor' || command === 'major') {
		if (!working) {
			console.error(`version: ${join(root, 'VERSION')} does not exist`);
			return 1;
		}
		const next = manualBump(command, working, released.version);
		const from = parseSemver(working)!.version;
		if (!next) {
			console.log(`version: ${from} already includes a ${command} bump over the released ${parseSemver(released.version)!.version}; nothing to do`);
			return 0;
		}
		if (!dryRun) writeVersion(root, next);
		console.log(`version: ${from} → ${next}${dryRun ? ' (dry run)' : ''}`);
		if (!dryRun) console.log('         Commit it with the change it releases; it ships when it reaches main.');
		return 0;
	}

	console.error('usage: bun scripts/version.ts show | patch | minor | major [--dry-run] | auto');
	return 64;
}

if (import.meta.main) process.exit(main());
