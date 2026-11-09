/**
 * Release-managed Caddy binary.
 *
 * A release ships `caddy/caddy` (CI builds it with `caddy-dns/cloudflare`). The updater installs
 * it at the path the running unit executes, so the edge's proxy is upgraded with the platform and
 * a rollback puts the previous binary back. `yoal-caddy.service` already resolves through
 * `/opt/yoal/current`, so only the restart is needed there; a stock `caddy.service` points at a
 * static path, so the binary is replaced atomically with a backup beside it.
 *
 * Nothing is replaced until the candidate runs and advertises the DNS module. If the restart
 * fails the previous binary is restored and Caddy is restarted again before the error escapes;
 * the updater then reverts the whole release.
 */
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const CADDY_UNIT = 'yoal-caddy.service';
export const STOCK_CADDY_UNIT = 'caddy.service';
export const CADDY_DNS_MODULE = 'dns.providers.cloudflare';

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CaddyCommandOptions {
	allowFailure?: boolean;
}

export interface EnsureCaddyOptions {
	/** The release whose `caddy/caddy` should run. */
	release: string;
	optDir?: string;
	run: (cmd: string[], options?: CaddyCommandOptions) => CommandResult;
	log?: (message: string) => void;
}

/** `path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run …` from `systemctl show -p ExecStart`. */
export function parseExecStartPath(value: string): string | null {
	const path = /(?:^|[;\s])path=([^;\s]+)/.exec(value)?.[1];
	if (path?.startsWith('/')) return path;
	const argv = /argv\[\]=([^\s;]+)/.exec(value)?.[1];
	return argv?.startsWith('/') ? argv : null;
}

/** The Caddy unit this host runs, preferring the release-managed one. */
export function caddyUnit(run: EnsureCaddyOptions['run']): string | null {
	for (const unit of [CADDY_UNIT, STOCK_CADDY_UNIT]) {
		const state = run(['systemctl', 'show', '-p', 'LoadState', '--value', unit], {
			allowFailure: true
		}).stdout.trim();
		if (state && state !== 'not-found' && state !== 'masked') return unit;
	}
	return null;
}

export function caddyExecPath(unit: string, run: EnsureCaddyOptions['run']): string | null {
	const output = run(['systemctl', 'show', '-p', 'ExecStart', '--value', unit], {
		allowFailure: true
	}).stdout;
	return parseExecStartPath(output);
}

/**
 * Copy `source` over `target` atomically, keeping the old file at `<target>.yoal-previous`.
 * Returns false when the bytes are already identical.
 */
export function installCaddyBinary(source: string, target: string): boolean {
	if (existsSync(target)) {
		try {
			if (readFileSync(target).equals(readFileSync(source))) return false;
		} catch {
			// Unreadable target: replace it.
		}
		copyFileSync(target, `${target}.yoal-previous`);
	}
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.yoal-new`;
	rmSync(tmp, { force: true });
	copyFileSync(source, tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, target);
	return true;
}

/** Put `<target>.yoal-previous` back. False when there is no backup. */
export function restoreCaddyBinary(target: string): boolean {
	const backup = `${target}.yoal-previous`;
	if (!existsSync(backup)) return false;
	const tmp = `${target}.yoal-restore`;
	rmSync(tmp, { force: true });
	copyFileSync(backup, tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, target);
	return true;
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readInstalledHash(path: string): string | null {
	try {
		return readFileSync(path, 'utf8').trim() || null;
	} catch {
		return null;
	}
}

/**
 * Make the release's Caddy the running one. False when the release has no Caddy or the host has no
 * Caddy unit; throws when the candidate is unusable or the service does not come back.
 */
export function ensureCaddy(options: EnsureCaddyOptions): boolean {
	const optDir = options.optDir ?? '/opt/yoal';
	const unit = caddyUnit(options.run);
	if (!unit) return false;
	const exec = caddyExecPath(unit, options.run);
	if (!exec) throw new Error(`${unit} has no absolute ExecStart path`);
	const stateFile = join(optDir, 'caddy.sha256');
	const binary = join(options.release, 'caddy', 'caddy');

	if (!existsSync(binary)) {
		// This release predates release-managed Caddy (or was built from source before it could be
		// carried over). Put the binary we replaced back, but only if there is one.
		if (!restoreCaddyBinary(exec)) return false;
		options.run(['systemctl', 'restart', unit]);
		rmSync(stateFile, { force: true });
		options.log?.(`restored the previous Caddy binary for ${unit}`);
		return true;
	}

	const sha = sha256File(binary);
	if (readInstalledHash(stateFile) === sha) return false;

	const version = options.run([binary, 'version'], { allowFailure: true });
	if (version.code !== 0)
		throw new Error(
			`the Caddy binary in ${basename(options.release)} does not run: ${version.stderr || `exit ${version.code}`}`
		);
	const modules = options.run([binary, 'list-modules'], { allowFailure: true });
	if (modules.code !== 0 || !modules.stdout.includes(CADDY_DNS_MODULE))
		throw new Error(
			`the Caddy binary in ${basename(options.release)} lacks ${CADDY_DNS_MODULE}`
		);

	// A path under `current` already resolves to this release after the swap; there is nothing to
	// copy. A stock unit points at a fixed file, which is replaced with a rollback copy.
	const throughCurrent = exec.startsWith(`${optDir}/current/`);
	const changed = throughCurrent ? false : installCaddyBinary(binary, exec);
	const restart = () => {
		const result = options.run(['systemctl', 'restart', unit]);
		if (result.code !== 0)
			throw new Error(`${unit} restart failed: ${result.stderr || `exit ${result.code}`}`);
	};
	try {
		restart();
	} catch (error) {
		if (changed) restoreCaddyBinary(exec);
		options.run(['systemctl', 'restart', unit], { allowFailure: true });
		throw error;
	}
	mkdirSync(optDir, { recursive: true });
	writeFileSync(stateFile, `${sha}\n`, { mode: 0o644 });
	options.log?.(`installed Caddy from ${basename(options.release)} and restarted ${unit}`);
	return true;
}
