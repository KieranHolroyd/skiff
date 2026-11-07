/**
 * Install the pinned FrankenPHP binary, the reference PHP runtime for process apps (D121).
 *
 * PHP apps run as ordinary process apps whose command is `frankenphp run`. FrankenPHP is PHP
 * embedded in Caddy, so it adopts the listen socket systemd passes (`bind fd/3`) and the app can
 * scale to zero like a function. The static Linux build is about 175 MB, over the 25 MB per-file
 * release limit, so it lives on the node like workerd (FN1), never in a release.
 *
 * It is opt-in (`--with-php`, or `SKIFF_INSTALL_PHP=1`), because most nodes never run PHP and the
 * download is large for an edge VPS. Run this file directly to add it to an installed node:
 *
 *   sudo bun scripts/install/frankenphp.ts
 *
 * The binary is fetched from FrankenPHP's GitHub release and checked against the digest pinned
 * here before it is installed; it is never fetched while an app runs.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Pinned release. Bump deliberately, with both digests from the release's assets
 * (`gh api repos/php/frankenphp/releases/tags/<tag>` lists `digest` per asset).
 */
export const FRANKENPHP_PINNED_VERSION = '1.13.2';
export const FRANKENPHP_DIGESTS: Record<FrankenphpArch, string> = {
	amd64: '89fc754cfe308bcf35a8fe5da78b41a811d61877f712734b237756b81faf0ce8',
	arm64: '58905a0734eff332f446b3af5059f6c4b27567bf4ead0deab920a33fce6bc60c',
};

export const FRANKENPHP_DEST = '/usr/lib/skiff/frankenphp';
/** On the default PATH every process unit gets, so an app's command is just `frankenphp …`. */
export const FRANKENPHP_LINK = '/usr/local/bin/frankenphp';

export type FrankenphpArch = 'amd64' | 'arm64';

/** Map Node's `process.arch`/`uname -m` to the release architecture. */
export function frankenphpArch(machine: string): FrankenphpArch | null {
	const value = machine.trim().toLowerCase();
	if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'amd64';
	if (value === 'arm64' || value === 'aarch64') return 'arm64';
	return null;
}

/** Static (musl) release asset for one architecture. */
export function frankenphpAssetUrl(version: string, arch: FrankenphpArch): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid FrankenPHP version: ${version}`);
	const asset = arch === 'arm64' ? 'frankenphp-linux-aarch64' : 'frankenphp-linux-x86_64';
	return `https://github.com/php/frankenphp/releases/download/v${version}/${asset}`;
}

export interface EnsureFrankenphpOptions {
	arch: FrankenphpArch;
	version?: string;
	/** Expected SHA-256 of the asset; defaults to the pinned digest for `arch`. */
	sha256?: string;
	/** Defaults to `/usr/lib/skiff/frankenphp`. */
	destDir?: string;
	/** Defaults to `/usr/local/bin/frankenphp`; null skips the link. */
	linkPath?: string | null;
	dryRun?: boolean;
	/** Download seam for tests. */
	fetch?: typeof fetch;
	/** Process seam for tests; receives argv and returns the exit code. */
	run?: (argv: string[]) => number;
	log?: (message: string) => void;
}

export type EnsureFrankenphpResult = 'present' | 'installed' | 'would-install';

/**
 * Make `<dest>/<version>/frankenphp` exist, verified and executable, and point the PATH link at it.
 * Idempotent: an installed binary that runs short-circuits without touching the network.
 */
export async function ensureFrankenphp(options: EnsureFrankenphpOptions): Promise<EnsureFrankenphpResult> {
	const version = options.version ?? FRANKENPHP_PINNED_VERSION;
	const expected = (options.sha256 ?? (version === FRANKENPHP_PINNED_VERSION ? FRANKENPHP_DIGESTS[options.arch] : '')).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(expected))
		throw new Error(`No pinned digest for FrankenPHP ${version} (${options.arch}); pass sha256 explicitly`);
	const destDir = options.destDir ?? FRANKENPHP_DEST;
	const linkPath = options.linkPath === undefined ? FRANKENPHP_LINK : options.linkPath;
	const target = join(destDir, version, 'frankenphp');
	const log = options.log ?? (() => undefined);
	const run =
		options.run ??
		((argv: string[]) => Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' }).exitCode ?? 1);

	if (existsSync(target) && run([target, 'version']) === 0) {
		if (!options.dryRun) link(target, linkPath);
		return 'present';
	}
	const url = frankenphpAssetUrl(version, options.arch);
	if (options.dryRun) {
		log(`would install FrankenPHP ${version} from ${url} to ${dirname(target)}`);
		return 'would-install';
	}

	log(`downloading FrankenPHP ${version} from ${url}`);
	const response = await (options.fetch ?? fetch)(url);
	if (!response.ok) throw new Error(`FrankenPHP download failed: HTTP ${response.status} from ${url}`);
	const body = new Uint8Array(await response.arrayBuffer());
	const actual = createHash('sha256').update(body).digest('hex');
	if (actual !== expected)
		throw new Error(`FrankenPHP download digest mismatch: expected ${expected}, got ${actual}`);

	mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
	const temporary = `${target}.new`;
	try {
		await Bun.write(temporary, body);
		chmodSync(temporary, 0o755);
		if (run([temporary, 'version']) !== 0) throw new Error('The downloaded FrankenPHP binary does not execute');
		// Atomic replace: a half-written binary must never look installed.
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
	link(target, linkPath);
	return 'installed';
}

/** Point the PATH link at `target`, replacing an older pin atomically. */
function link(target: string, linkPath: string | null): void {
	if (!linkPath) return;
	mkdirSync(dirname(linkPath), { recursive: true });
	const temporary = `${linkPath}.skiff-new`;
	rmSync(temporary, { force: true });
	symlinkSync(target, temporary);
	renameSync(temporary, linkPath);
}

if (import.meta.main) {
	const arch = frankenphpArch(process.arch);
	if (!arch) {
		console.error(`Unsupported architecture for FrankenPHP: ${process.arch}`);
		process.exit(1);
	}
	const result = await ensureFrankenphp({
		arch,
		dryRun: process.argv.includes('--dry-run'),
		log: (message) => console.log(message),
	});
	console.log(`FrankenPHP ${FRANKENPHP_PINNED_VERSION}: ${result} (${FRANKENPHP_LINK})`);
}
