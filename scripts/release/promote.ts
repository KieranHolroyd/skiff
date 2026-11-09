#!/usr/bin/env bun
/**
 * Promote a canary release to stable (docs/OPS.md §4.1, *Release channels*). Run by
 * `.github/workflows/promote.yml`; works locally too with an authenticated `gh`:
 *
 *   bun scripts/release/promote.ts --repo owner/name [--version 0.7.4] [--allow-older] [--dry-run]
 *
 * Every `VERSION` bump on main is published as a signed GitHub prerelease: the canary channel.
 * Promotion flips that release to a full one and marks it Latest. The artifacts and the signed
 * manifest are not rebuilt or re-signed, so stable hosts install exactly the bits canary hosts
 * have been running. Before flipping, the manifest is downloaded and verified against the release
 * keys compiled into the updater, so a release no host would accept is never promoted.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver } from '../../packages/contracts/src/semver.ts';
import { loadTrustedKeys, verifyManifest } from '../update-self/signing.ts';

export interface ListedRelease {
	tag: string;
	draft: boolean;
	prerelease: boolean;
	assets: string[];
	createdAt: string;
}

export type Promotion =
	| { ok: true; tag: string; version: string; stable: string | null; skipped: string[] }
	| { ok: false; reason: string };

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const signed = (release: ListedRelease) =>
	release.assets.includes('manifest.json') && release.assets.includes('manifest.json.sig');

/**
 * Which release to promote: `requested`, or else the newest signed canary. Refuses a release
 * that is not a signed canary, and one older than the current stable unless `allowOlder` (stable
 * hosts never downgrade, so promoting it would change nothing for them).
 */
export function choosePromotion(
	releases: ListedRelease[],
	requested: string | null,
	{ allowOlder = false }: { allowOlder?: boolean } = {},
): Promotion {
	const platform = releases.filter((release) => !release.draft && RELEASE_TAG.test(release.tag));
	const newestFirst = (a: ListedRelease, b: ListedRelease) => compareSemver(b.tag.slice(1), a.tag.slice(1));
	const stable = platform.filter((release) => !release.prerelease).sort(newestFirst)[0] ?? null;
	const canaries = platform.filter((release) => release.prerelease && signed(release)).sort(newestFirst);
	const stableVersion = stable ? stable.tag.slice(1) : null;

	let target: ListedRelease | undefined;
	if (requested) {
		const tag = requested.startsWith('v') ? requested : `v${requested}`;
		if (!RELEASE_TAG.test(tag)) return { ok: false, reason: `"${requested}" is not a platform version (x.y.z)` };
		const release = platform.find((entry) => entry.tag === tag);
		if (!release) return { ok: false, reason: `${tag} is not a published release` };
		if (!release.prerelease) return { ok: false, reason: `${tag} is already stable` };
		if (!signed(release)) return { ok: false, reason: `${tag} has no signed manifest; hosts could not install it` };
		target = release;
	} else {
		target = canaries[0];
		if (!target) return { ok: false, reason: 'there is no signed canary to promote' };
	}

	const version = target.tag.slice(1);
	if (stableVersion && compareSemver(version, stableVersion) <= 0 && !allowOlder)
		return {
			ok: false,
			reason: `${target.tag} is not newer than the current stable v${stableVersion}; stable hosts would not install it (pass allow-older to promote anyway)`,
		};
	// Canaries between the old stable and the target that stable hosts will never see.
	const skipped = canaries
		.filter(
			(release) =>
				compareSemver(release.tag.slice(1), version) < 0 &&
				(!stableVersion || compareSemver(release.tag.slice(1), stableVersion) > 0),
		)
		.map((release) => release.tag);
	return { ok: true, tag: target.tag, version, stable: stableVersion, skipped };
}

// ------------------------------------------------------------------------------- CLI

function gh(args: string[], { capture = true }: { capture?: boolean } = {}): string {
	const result = Bun.spawnSync(['gh', ...args], { stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' });
	if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode})`);
	return capture ? (result.stdout?.toString() ?? '') : '';
}

function listReleases(repo: string): ListedRelease[] {
	const raw = gh([
		'api',
		'--paginate',
		`repos/${repo}/releases?per_page=100`,
		'--jq',
		'.[] | {tag: .tag_name, draft, prerelease, createdAt: .created_at, assets: [.assets[].name]}',
	]);
	return raw
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as ListedRelease);
}

/** Download and verify the signed manifest exactly as a host would. */
function verifyRelease(repo: string, tag: string, version: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-promote-'));
	try {
		gh(['release', 'download', tag, '--repo', repo, '--dir', dir, '--pattern', 'manifest.json', '--pattern', 'manifest.json.sig']);
		const manifest = verifyManifest(
			readFileSync(join(dir, 'manifest.json')),
			readFileSync(join(dir, 'manifest.json.sig'), 'utf8'),
			loadTrustedKeys(join(dir, 'no-extra-keys')),
		);
		if (manifest.version !== version) throw new Error(`${tag}'s signed manifest describes ${manifest.version}`);
		if (manifest.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`${tag}'s signed manifest is for ${manifest.repo}`);
		return manifest.commit;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function summary(markdown: string): void {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (path) Bun.write(path, `${readFileSafe(path)}${markdown}\n`);
	console.log(markdown);
}

function readFileSafe(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

function argument(name: string): string | null {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value && !value.startsWith('--') && value.trim() ? value.trim() : null;
}

if (import.meta.main) {
	const repo = argument('--repo') ?? process.env.GITHUB_REPOSITORY;
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		console.error('promote: --repo owner/name is required');
		process.exit(64);
	}
	const choice = choosePromotion(listReleases(repo), argument('--version'), {
		allowOlder: process.argv.includes('--allow-older'),
	});
	if (!choice.ok) {
		summary(`### Not promoted\n\n${choice.reason}.`);
		process.exit(1);
	}
	const commit = verifyRelease(repo, choice.tag, choice.version);
	const lines = [
		`### ${process.argv.includes('--dry-run') ? 'Would promote' : 'Promoted'} ${choice.tag} to stable`,
		'',
		`- Stable: ${choice.stable ? `v${choice.stable}` : 'none'} → **v${choice.version}** (commit \`${commit.slice(0, 12)}\`)`,
		'- Same signed artifacts canary hosts installed; nothing was rebuilt or re-signed.',
		...(choice.skipped.length ? [`- Canaries stable hosts skip: ${choice.skipped.join(', ')}`] : []),
	];
	if (!process.argv.includes('--dry-run'))
		gh(['release', 'edit', choice.tag, '--repo', repo, '--prerelease=false', '--latest'], { capture: false });
	summary(lines.join('\n'));
}
