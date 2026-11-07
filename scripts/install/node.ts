/**
 * Install the pinned Node.js LTS for Node.js process apps (D125).
 *
 * A process app with `engine: "node"` runs `node --run start` (or its own command) in the same
 * sandboxed unit Bun apps use. The official Linux build is extracted whole to
 * `/usr/lib/skiff/node/<version>/` and `node`, `npm` and `npx` are linked into `/usr/local/bin`,
 * which is on every process unit's `PATH` (and the Builder's, so `npm ci && npm run build` works
 * for git builds). The agent advertises `process-node` while `/usr/local/bin/node` exists, and
 * placement refuses Node apps on any other node.
 *
 * Installed by default (about 190 MB on disk); `--no-node` (or `SKIFF_NO_NODE=1`) skips it and
 * leaves a marker so release convergence does not add it later. A `/usr/local/bin/node` that is
 * not Skiff's link (the operator's own Node) is left alone. To add it to an installed node:
 *
 *   sudo bun scripts/install/node.ts
 *
 * The tarball is fetched from nodejs.org and checked against the digest pinned here before it is
 * installed; it is never fetched while an app runs. Old versions stay on disk for rollback.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pinned release: the current Active LTS. Bump deliberately, with both digests from
 * `https://nodejs.org/dist/v<version>/SHASUMS256.txt` (the `linux-<arch>.tar.gz` rows).
 */
export const NODE_PINNED_VERSION = '26.13.0';
export const NODE_DIGESTS: Record<NodeArch, string> = {
	amd64: '5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455',
	arm64: '439e9c438acdf6a6ffe47418da709153d66c4bed812e30a473faacb107dd2791',
};

export const NODE_DEST = '/usr/lib/skiff/node';
/** Directory on every process unit's default PATH. */
export const NODE_BIN_DIR = '/usr/local/bin';
/** The commands linked onto PATH; `node` is the one the agent and helper look for. */
export const NODE_COMMANDS = ['node', 'npm', 'npx'] as const;
/** Written by `--no-node`; convergence never installs Node on a node that has it. */
export const NODE_OPT_OUT_MARKER = '/usr/lib/skiff/node.disabled';

export type NodeArch = 'amd64' | 'arm64';

/** Map Node's `process.arch`/`uname -m` to the release architecture. */
export function nodeArch(machine: string): NodeArch | null {
	const value = machine.trim().toLowerCase();
	if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'amd64';
	if (value === 'arm64' || value === 'aarch64') return 'arm64';
	return null;
}

/** Official glibc tarball for one architecture (Debian 13/Ubuntu LTS, D27). */
export function nodeTarballUrl(version: string, arch: NodeArch): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Node.js version: ${version}`);
	return `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
}

export interface EnsureNodeOptions {
	arch: NodeArch;
	version?: string;
	/** Expected SHA-256 of the tarball; defaults to the pinned digest for `arch`. */
	sha256?: string;
	/** Defaults to `/usr/lib/skiff/node`. */
	destDir?: string;
	/** Defaults to `/usr/local/bin`; null skips the links. */
	binDir?: string | null;
	dryRun?: boolean;
	/** Download seam for tests. */
	fetch?: typeof fetch;
	/** Process seam for tests; receives argv and returns the exit code. */
	run?: (argv: string[]) => number;
	log?: (message: string) => void;
}

export type EnsureNodeResult = 'present' | 'installed' | 'would-install';

/**
 * Make `<dest>/<version>/bin/node` exist, verified and executable, and point the PATH links at it.
 * Idempotent: an installed binary that runs short-circuits without touching the network.
 */
export async function ensureNode(options: EnsureNodeOptions): Promise<EnsureNodeResult> {
	const version = options.version ?? NODE_PINNED_VERSION;
	const expected = (options.sha256 ?? (version === NODE_PINNED_VERSION ? NODE_DIGESTS[options.arch] : '')).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(expected))
		throw new Error(`No pinned digest for Node.js ${version} (${options.arch}); pass sha256 explicitly`);
	const destDir = options.destDir ?? NODE_DEST;
	const binDir = options.binDir === undefined ? NODE_BIN_DIR : options.binDir;
	const home = join(destDir, version);
	const target = join(home, 'bin', 'node');
	const log = options.log ?? (() => undefined);
	const run =
		options.run ??
		((argv: string[]) => Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' }).exitCode ?? 1);

	if (existsSync(target) && run([target, '--version']) === 0) {
		if (!options.dryRun) linkCommands(home, destDir, binDir, log);
		return 'present';
	}
	const url = nodeTarballUrl(version, options.arch);
	if (options.dryRun) {
		log(`would install Node.js ${version} from ${url} to ${home}`);
		return 'would-install';
	}

	log(`downloading Node.js ${version} from ${url}`);
	const response = await (options.fetch ?? fetch)(url);
	if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status} from ${url}`);
	const body = new Uint8Array(await response.arrayBuffer());
	const actual = createHash('sha256').update(body).digest('hex');
	if (actual !== expected) throw new Error(`Node.js download digest mismatch: expected ${expected}, got ${actual}`);

	mkdirSync(destDir, { recursive: true, mode: 0o755 });
	const tarball = join(tmpdir(), `skiff-node-${version}-${process.pid}.tar.gz`);
	// Extract next to the destination so the final rename stays on one filesystem.
	const partial = join(destDir, `.${version}.partial`);
	rmSync(partial, { recursive: true, force: true });
	try {
		await Bun.write(tarball, body);
		mkdirSync(partial, { recursive: true, mode: 0o755 });
		if (run(['tar', '-xzf', tarball, '-C', partial, '--strip-components=1', '--no-same-owner']) !== 0)
			throw new Error('Could not extract the Node.js tarball (tar failed)');
		if (run([join(partial, 'bin', 'node'), '--version']) !== 0)
			throw new Error('The downloaded Node.js binary does not execute');
		// Atomic replace: a half-extracted tree must never look installed.
		rmSync(home, { recursive: true, force: true });
		renameSync(partial, home);
	} finally {
		rmSync(tarball, { force: true });
		rmSync(partial, { recursive: true, force: true });
	}
	linkCommands(home, destDir, binDir, log);
	return 'installed';
}

/**
 * Point `node`, `npm` and `npx` in `binDir` at `home`, replacing an older pin atomically. A
 * command that exists and is not a link into `destDir` belongs to the operator and is kept.
 */
function linkCommands(home: string, destDir: string, binDir: string | null, log: (message: string) => void): void {
	if (!binDir) return;
	mkdirSync(binDir, { recursive: true });
	for (const command of NODE_COMMANDS) {
		const source = join(home, 'bin', command);
		if (!existsSync(source)) continue;
		const linkPath = join(binDir, command);
		if (!isOursOrMissing(linkPath, destDir)) {
			log(`keeping ${linkPath}: it is not Skiff's Node.js link`);
			continue;
		}
		const temporary = `${linkPath}.skiff-new`;
		rmSync(temporary, { force: true });
		symlinkSync(source, temporary);
		renameSync(temporary, linkPath);
	}
}

function isOursOrMissing(path: string, destDir: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isSymbolicLink() && readlinkSync(path).startsWith(`${destDir}/`);
	} catch {
		return true;
	}
}

/** True when `/usr/local/bin/node` is Skiff's link, i.e. this node follows Node.js pin bumps. */
export function hasSkiffNode(binDir: string = NODE_BIN_DIR, destDir: string = NODE_DEST): boolean {
	try {
		const path = join(binDir, 'node');
		return lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(`${destDir}/`);
	} catch {
		return false;
	}
}

if (import.meta.main) {
	const arch = nodeArch(process.arch);
	if (!arch) {
		console.error(`Unsupported architecture for Node.js: ${process.arch}`);
		process.exit(1);
	}
	// Running this by hand is an explicit opt-in, so it clears an earlier `--no-node`.
	if (!process.argv.includes('--dry-run')) rmSync(NODE_OPT_OUT_MARKER, { force: true });
	const result = await ensureNode({
		arch,
		dryRun: process.argv.includes('--dry-run'),
		log: (message) => console.log(message),
	});
	console.log(`Node.js ${NODE_PINNED_VERSION}: ${result} (${join(NODE_BIN_DIR, 'node')})`);
	if (result === 'installed') console.log('No restart needed: the agent advertises process-node on its next heartbeat.');
}
