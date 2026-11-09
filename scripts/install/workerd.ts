/**
 * Install the pinned workerd binary for the Functions runtime (docs/FUNCTIONS.md FN1).
 *
 * The version is the one in `packages/contracts/src/function.ts` (`WORKERD_PINNED_VERSION`); the
 * node's helper expects `<dest>/<version>/workerd` and refuses to start a function without it.
 * We install at install/upgrade time from the npm platform package; it is not fetched while a
 * function runs. The package is the same date-versioned build Cloudflare publishes, and the
 * platform package is the one whose `bin/workerd` the `workerd` npm wrapper executes.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKERD_DEST = '/usr/lib/yoal/workerd';

export type WorkerdArch = 'amd64' | 'arm64';

/** npm platform package for a Linux architecture (Debian 13/Ubuntu LTS, D27). */
export function workerdPackageFor(arch: WorkerdArch): string {
	return arch === 'arm64' ? '@cloudflare/workerd-linux-arm64' : '@cloudflare/workerd-linux-64';
}

/** Map Node's `process.arch`/`uname -m` to the package architecture. */
export function workerdArch(machine: string): WorkerdArch | null {
	const value = machine.trim().toLowerCase();
	if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'amd64';
	if (value === 'arm64' || value === 'aarch64') return 'arm64';
	return null;
}

/** Registry tarball URL for one pinned platform package. */
export function workerdTarballUrl(pkg: string, version: string): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid workerd version: ${version}`);
	return `https://registry.npmjs.org/${pkg}/-/${pkg.split('/').pop()}-${version}.tgz`;
}

/**
 * The pin lives in contracts so the control plane, agent and installer agree. The installer runs
 * before `bun install`, so it reads the source file rather than importing the package.
 */
export function pinnedWorkerdVersion(repoRoot: string): string {
	const source = readFileSync(join(repoRoot, 'packages', 'contracts', 'src', 'function.ts'), 'utf8');
	const match = /export const WORKERD_PINNED_VERSION = '([^']+)'/.exec(source);
	if (!match) throw new Error('Could not read WORKERD_PINNED_VERSION from packages/contracts/src/function.ts');
	return match[1]!;
}

export interface EnsureWorkerdOptions {
	version: string;
	arch: WorkerdArch;
	/** Defaults to `/usr/lib/yoal/workerd`. */
	destDir?: string;
	dryRun?: boolean;
	/** Download seam for tests. */
	fetch?: typeof fetch;
	/** Process seam for tests; receives argv and returns the exit code. */
	run?: (argv: string[], options?: { cwd?: string }) => number;
	log?: (message: string) => void;
}

export type EnsureWorkerdResult = 'present' | 'installed' | 'would-install';

/**
 * Make `<dest>/<version>/workerd` exist and be executable. Idempotent: a matching installed
 * binary short-circuits without touching the network.
 */
export async function ensureWorkerd(options: EnsureWorkerdOptions): Promise<EnsureWorkerdResult> {
	if (!/^\d+\.\d+\.\d+$/.test(options.version))
		throw new Error(`Invalid workerd version: ${options.version}`);
	const destDir = options.destDir ?? WORKERD_DEST;
	const targetDir = join(destDir, options.version);
	const target = join(targetDir, 'workerd');
	const log = options.log ?? (() => undefined);
	const run =
		options.run ??
		((argv: string[], runOptions?: { cwd?: string }) => {
			const result = Bun.spawnSync(argv, { cwd: runOptions?.cwd ?? undefined, stdout: 'pipe', stderr: 'pipe' });
			return result.exitCode ?? 1;
		});

	if (existsSync(target) && run([target, '--version']) === 0) return 'present';
	if (options.dryRun) {
		log(`would install workerd ${options.version} (${workerdPackageFor(options.arch)}) to ${targetDir}`);
		return 'would-install';
	}

	const pkg = workerdPackageFor(options.arch);
	const url = workerdTarballUrl(pkg, options.version);
	log(`downloading workerd ${options.version} from ${url}`);
	const response = await (options.fetch ?? fetch)(url);
	if (!response.ok) throw new Error(`workerd download failed: HTTP ${response.status} from ${url}`);
	const body = new Uint8Array(await response.arrayBuffer());
	// A real workerd tarball is tens of MB; reject an HTML error page or a truncated body.
	if (body.byteLength < 1_000_000) throw new Error(`workerd download is too small (${body.byteLength} bytes)`);

	const work = mkdtempSync(join(tmpdir(), 'yoal-workerd-'));
	try {
		const tarball = join(work, 'workerd.tgz');
		await Bun.write(tarball, body);
		const extracted = join(work, 'extract');
		mkdirSync(extracted, { recursive: true });
		if (run(['tar', '-xzf', tarball, '-C', extracted]) !== 0)
			throw new Error('Could not extract the workerd tarball (tar failed)');
		const source = join(extracted, 'package', 'bin', 'workerd');
		if (!existsSync(source)) throw new Error('workerd tarball did not contain package/bin/workerd');
		mkdirSync(targetDir, { recursive: true, mode: 0o755 });
		const temporary = `${target}.new`;
		copyFileSync(source, temporary);
		chmodSync(temporary, 0o755);
		if (run([temporary, '--version']) !== 0) throw new Error('The downloaded workerd binary does not execute');
		// Atomic replace: a half-copied binary must never look installed.
		renameSync(temporary, target);
		return 'installed';
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
