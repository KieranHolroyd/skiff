import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Storage tools every node needs (docs/STORAGE.md §5.1, §3): `fio` for disk profiling,
 * `nfs-common` and `cifs-utils` for network share mounts.
 *
 * The installer installs them up front (scripts/install/main.ts, same package list). Nodes that
 * were installed before, or that only ever update through the signed node-update verb, get them
 * here: when a newly started helper finds one missing it runs `apt-get install` once, in the
 * background, and records the attempt per helper version so an unavailable package never turns
 * every restart into an apt run. Debian/Ubuntu only; `YOAL_HELPER_STORAGE_TOOLS=0` turns it off
 * (the installer writes that for `--skip-deps` installs).
 */

/** Keep in step with STORAGE_TOOL_PACKAGES in scripts/install/main.ts. */
export const STORAGE_TOOL_PACKAGES = ['fio', 'nfs-common', 'cifs-utils'] as const;

/** One binary that proves each package is present. */
const PROBES: Record<(typeof STORAGE_TOOL_PACKAGES)[number], string[]> = {
	fio: ['/usr/bin/fio'],
	'nfs-common': ['/sbin/mount.nfs', '/usr/sbin/mount.nfs'],
	'cifs-utils': ['/sbin/mount.cifs', '/usr/sbin/mount.cifs'],
};

export interface StorageToolsOptions {
	/** Where the per-version attempt marker lives (the helper state dir). */
	stateDir: string;
	version: string;
	run: (argv: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
	log: (level: 'info' | 'warn', message: string) => void;
	exists?: (path: string) => Promise<boolean>;
	aptGetPath?: string;
}

export type StorageToolsOutcome =
	| { status: 'present' }
	| { status: 'skipped'; reason: string; missing: string[] }
	| { status: 'installed'; missing: string[] }
	| { status: 'failed'; missing: string[]; error: string };

const MARKER = '.storage-tools';

export async function missingStorageTools(exists: (path: string) => Promise<boolean> = fileExists): Promise<string[]> {
	const missing: string[] = [];
	for (const name of STORAGE_TOOL_PACKAGES) {
		const found = await Promise.all(PROBES[name].map((path) => exists(path)));
		if (!found.some(Boolean)) missing.push(name);
	}
	return missing;
}

/** Install missing storage tools once per helper version. Never throws. */
export async function ensureStorageTools(options: StorageToolsOptions): Promise<StorageToolsOutcome> {
	const exists = options.exists ?? fileExists;
	const aptGet = options.aptGetPath ?? '/usr/bin/apt-get';
	try {
		const missing = await missingStorageTools(exists);
		if (missing.length === 0) return { status: 'present' };
		if (!(await exists(aptGet))) return { status: 'skipped', reason: 'apt-get is not available', missing };
		const marker = join(options.stateDir, MARKER);
		const tried = await fs.readFile(marker, 'utf8').catch(() => '');
		if (tried.trim() === options.version) return { status: 'skipped', reason: `already tried for ${options.version}`, missing };
		await fs.mkdir(options.stateDir, { recursive: true });
		await fs.writeFile(marker, `${options.version}\n`, { mode: 0o644 });

		options.log('info', `installing storage tools: ${missing.join(' ')}`);
		const env = { DEBIAN_FRONTEND: 'noninteractive' };
		// Wait for another apt (unattended-upgrades) instead of failing on the lock.
		const lock = ['-o', 'DPkg::Lock::Timeout=120'];
		await options.run([aptGet, ...lock, 'update', '-q'], env);
		let result = await options.run([aptGet, ...lock, 'install', '-y', '-q', '--no-install-recommends', ...missing], env);
		if (result.code !== 0) {
			// An older release may lack one of them; install what exists.
			for (const name of missing) await options.run([aptGet, ...lock, 'install', '-y', '-q', '--no-install-recommends', name], env);
			result = { code: 0, stdout: '', stderr: '' };
		}
		const still = await missingStorageTools(exists);
		if (still.length > 0) {
			const error = `could not install ${still.join(', ')}`;
			options.log('warn', `${error}; volume profiling or network share mounts may be limited (apt-get install ${still.join(' ')})`);
			return { status: 'failed', missing: still, error };
		}
		options.log('info', `installed ${missing.join(', ')}`);
		return { status: 'installed', missing };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.log('warn', `storage tools check failed: ${message}`);
		return { status: 'failed', missing: [], error: message };
	}
}

async function fileExists(path: string): Promise<boolean> {
	return fs
		.access(path)
		.then(() => true)
		.catch(() => false);
}
