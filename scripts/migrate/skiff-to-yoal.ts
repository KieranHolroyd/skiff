#!/usr/bin/env bun
/**
 * Convert a host installed under the pre-rename `skiff` names to `yoal`.
 *
 * The Yoal rebrand changed more than labels: it moved every host path, systemd unit,
 * system account, environment key and the SQLite filename. A host that was installed
 * before the rename keeps running until it restarts, then services look for `/opt/yoal`
 * while the data is still in `/opt/skiff`.
 *
 * This tool performs that one-way conversion in place. It is deliberately conservative:
 *
 *   - dry-run by default; `--apply` is required to touch the host
 *   - every rename is recorded in a manifest, and `--rollback <manifest>` reverses it
 *   - a copy of `/etc/skiff`, the database and the Caddy/systemd configuration is kept
 *     under `/var/backups/yoal-skiff-<timestamp>` before anything changes
 *   - services are stopped, never started: the conversion leaves the host ready for the
 *     current installer to build and activate a Yoal release
 *
 * Usage (run as root on the Skiff host):
 *
 *   sudo bun skiff-to-yoal.ts --dry-run
 *   sudo bun skiff-to-yoal.ts --apply --yes
 *   sudo bun skiff-to-yoal.ts --rollback /var/backups/yoal-skiff-<timestamp>/manifest.json
 *
 * Then install the current Yoal release:
 *
 *   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh \
 *     | sudo env YOAL_YES=1 sh -s -- --upgrade
 *
 * The script is self-contained (node builtins + bun:sqlite) so it also runs from a
 * downloaded copy using the Bun binary the old install already carries.
 */
import { Database } from 'bun:sqlite';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const MANIFEST_VERSION = 1;

/** Absolute paths owned by Skiff, longest prefixes first (order matters). */
export const PATH_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['/var/lib/skiff-update', '/var/lib/yoal-update'],
	['/var/lib/skiff-builder', '/var/lib/yoal-builder'],
	['/var/lib/skiff-config', '/var/lib/yoal-config'],
	['/var/lib/skiff-helper', '/var/lib/yoal-helper'],
	['/var/lib/skiff-agent2', '/var/lib/yoal-agent2'],
	['/var/lib/skiff-agent', '/var/lib/yoal-agent'],
	['/var/lib/skiff-workloads', '/var/lib/yoal-workloads'],
	['/var/lib/skiff', '/var/lib/yoal'],
	['/run/skiff-helper', '/run/yoal-helper'],
	['/run/skiff-agent', '/run/yoal-agent'],
	['/run/skiff-workloads', '/run/yoal-workloads'],
	['/run/skiff-shares', '/run/yoal-shares'],
	['/run/skiff-upstream', '/run/yoal-upstream'],
	['/run/skiff-secrets', '/run/yoal-secrets'],
	['/run/skiff-tls', '/run/yoal-tls'],
	['/run/skiff', '/run/yoal'],
	['/opt/skiff', '/opt/yoal'],
	['/etc/skiff', '/etc/yoal'],
	['/etc/tmpfiles.d/skiff.conf', '/etc/tmpfiles.d/yoal.conf'],
	['/srv/skiff-cache', '/srv/yoal-cache'],
	['/srv/skiff', '/srv/yoal'],
	['/usr/lib/skiff', '/usr/lib/yoal'],
	['/usr/local/lib/skiff-updater', '/usr/local/lib/yoal-updater'],
	['/usr/local/sbin/skiff-', '/usr/local/sbin/yoal-'],
	['/usr/local/sbin/skiff', '/usr/local/sbin/yoal'],
	['/usr/local/bin/skiff-', '/usr/local/bin/yoal-'],
	['/usr/local/bin/skiff', '/usr/local/bin/yoal'],
	['/usr/local/bin/skif', '/usr/local/bin/yoal'],
	['/var/log/caddy/skiff-access', '/var/log/caddy/yoal-access'],
	['/etc/caddy/Caddyfile.pre-skiff', '/etc/caddy/Caddyfile.pre-yoal'],
	['/etc/caddy/skiff.Caddyfile', '/etc/caddy/yoal.Caddyfile'],
	['/etc/systemd/system/caddy.service.d/skiff-', '/etc/systemd/system/caddy.service.d/yoal-'],
	['/etc/systemd/system/skiff-', '/etc/systemd/system/yoal-'],
	['/etc/containers/systemd/skiff-', '/etc/containers/systemd/yoal-'],
	['/mnt/skiff-shares', '/mnt/yoal-shares'],
	['/root/skiff-recovery-kit-', '/root/yoal-recovery-kit-'],
];

/** Bare filenames that appear without a leading slash (e.g. `${YOAL_DATA_DIR}/skiff.db`). */
const BARE_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bskiff\.db\b/g, 'yoal.db'],
	[/\bskiff\.env\b/g, 'yoal.env'],
	[/\bskiff-updated\b/g, 'yoal-updated'],
	[/\bskiff-agent\b/g, 'yoal-agent'],
	[/\bskiff-helper\b/g, 'yoal-helper'],
	[/\bskiff-builder\b/g, 'yoal-builder'],
	[/\bskiff-storage\b/g, 'yoal-storage'],
	[/\bskiff-migrate\.ts\b/g, 'yoal-migrate.ts'],
	[/\bskiff-db-fingerprint\.ts\b/g, 'yoal-db-fingerprint.ts'],
	[/\bskiff-recover\.sh\b/g, 'yoal-recover.sh'],
	[/\bskiff-restore-drill\b/g, 'yoal-restore-drill'],
	[/\bskiff-restore\b/g, 'yoal-restore'],
	[/\bskiff-recovery-kit\b/g, 'yoal-recovery-kit'],
	[/\bskiff-rotate-master-key\b/g, 'yoal-rotate-master-key'],
	[/\bskiff-uninstall\b/g, 'yoal-uninstall'],
	[/\bskiff-platform-config\b/g, 'yoal-platform-config'],
	[/\bskiff-alert\b/g, 'yoal-alert'],
	[/\bskiff\.js\b/g, 'yoal.js'],
	[/\bskif\.js\b/g, 'yoal.js'],
	[/\bskiff_migrations\b/g, 'yoal_migrations'],
	[/\bskiff-access\.log\b/g, 'yoal-access.log'],
	[/\bskiff-access-/g, 'yoal-access-'],
	[/\bskiff-dumps\b/g, 'yoal-dumps'],
	[/\bskiff_backup\b/g, 'yoal_backup'],
];

const REPO_PAIRS: ReadonlyArray<readonly [RegExp, string]> = [
	[/KieranHolroyd\/skiff\b/gi, 'KieranHolroyd/yoal'],
	[/github\.com\/KieranHolroyd\/skiff\b/gi, 'github.com/KieranHolroyd/yoal'],
];

/** Map one absolute path from a Skiff prefix to its Yoal equivalent. */
export function migratePath(path: string): string {
	for (const [from, to] of PATH_PAIRS) {
		if (path === from) return to;
		// Prefixes ending in `-` are unit/command stems, not directories (e.g. `skiff-agent`).
		if (from.endsWith('-') && path.startsWith(from)) return `${to}${path.slice(from.length)}`;
		if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
	}
	return path;
}

/** Inverse of {@link migratePath}, used only to record rollback locations. */
export function unmigratePath(path: string): string {
	let out = path;
	for (const [from, to] of PATH_PAIRS) {
		if (out === to) {
			out = from;
			break;
		}
		if (to.endsWith('-') && out.startsWith(to)) {
			out = `${from}${out.slice(to.length)}`;
			break;
		}
		if (out.startsWith(`${to}/`)) {
			out = `${from}${out.slice(to.length)}`;
			break;
		}
	}
	// A basename that the forward pass renames (skiff.env -> yoal.env, skiff.db -> yoal.db).
	return out
		.replace(/\/yoal\.env$/, '/skiff.env')
		.replace(/\/yoal\.db$/, '/skiff.db')
		.replace(/\/yoal-updated$/, '/skiff-updated');
}

/**
 * Rewrite absolute paths and bare Skiff filenames. Safe for Caddyfiles, autosave JSON,
 * Litestream YAML and env values: it never touches a domain or an unrelated word.
 */
export function migratePathText(text: string): string {
	let out = text.replace(/(?:\/[A-Za-z0-9_.@%+-]+)+/g, (path) => migratePath(path));
	for (const [pattern, replacement] of BARE_NAMES) out = out.replace(pattern, replacement);
	for (const [pattern, replacement] of REPO_PAIRS) out = out.replace(pattern, replacement);
	return out;
}

/**
 * Rewrite a generated systemd unit, Quadlet or ClickHouse XML file. These files only
 * reference our own identifiers, so the remaining bare `skiff` words are safe to rename.
 */
export function migrateUnitText(text: string): string {
	let out = migratePathText(text);
	out = out.replace(/\bSKIFF_/g, 'YOAL_');
	out = out.replace(/\bSkiff\b/g, 'Yoal');
	out = out.replace(/\bskiff\b/g, 'yoal');
	return out;
}

/**
 * Rewrite an env file: map `SKIFF_*` keys, rewrite paths in values, and rename the
 * default SMTP display name. Comments and order are preserved.
 */
const ACCOUNT_VALUES: Record<string, Record<string, string>> = {
	YOAL_CLICKHOUSE_DATABASE: { skiff: 'yoal' },
	YOAL_CLICKHOUSE_USER: { skiff: 'yoal' },
	YOAL_CLICKHOUSE_READER_USER: { skiff_reader: 'yoal_reader' },
	YOAL_BUILDER_USER: { skiff_build: 'yoal_build', 'skiff-build': 'yoal-build' },
	YOAL_HELPER_CONTROL_SOCKET_GROUP: { skiff: 'yoal' },
	YOAL_HELPER_WORKLOAD_SOCKET_GROUP: { skiff: 'yoal' },
};

export function migrateEnvText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return line;
			const eq = line.indexOf('=');
			if (eq <= 0) return line;
			const key = line.slice(0, eq).trim();
			const mapped = key.startsWith('SKIFF_') ? `YOAL_${key.slice('SKIFF_'.length)}` : key;
			let value = migratePathText(line.slice(eq + 1).trim());
			value = ACCOUNT_VALUES[mapped]?.[value] ?? value;
			if (mapped === 'YOAL_SMTP_FROM') value = value.replace(/^(["']?)Skiff /, '$1Yoal ');
			return `${mapped}=${value}`;
		})
		.join('\n');
}

export interface Manifest {
	version: number;
	startedAt: string;
	root: string;
	backupDir: string;
	renames: Array<{ from: string; to: string }>;
	rewrites: Array<{ path: string; backup: string }>;
	symlinks: Array<{ path: string; fromPath: string; before: string | null; after: string; restore: string }>;
	users: Array<{ from: string; to: string }>;
	groups: Array<{ from: string; to: string }>;
	createdGroups: string[];
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (cmd: string[]) => CommandResult;

const defaultRunner: Runner = (cmd) => {
	try {
		const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
		return {
			code: result.exitCode ?? 1,
			stdout: new TextDecoder().decode(result.stdout).trim(),
			stderr: new TextDecoder().decode(result.stderr).trim(),
		};
	} catch (error) {
		return { code: 127, stdout: '', stderr: (error as Error).message };
	}
};

export interface MigrateOptions {
	root?: string;
	dryRun?: boolean;
	yes?: boolean;
	backupDir?: string;
	prefer?: 'abort' | 'legacy' | 'current';
	run?: Runner;
	log?: (message: string) => void;
	now?: Date;
}

export interface MigrateResult {
	changed: string[];
	warnings: string[];
	backupDir: string | null;
	alreadyConverted: boolean;
}

const TOP_LEVEL: ReadonlyArray<readonly [string, string]> = [
	['/opt/skiff', '/opt/yoal'],
	['/etc/skiff', '/etc/yoal'],
	['/var/lib/skiff', '/var/lib/yoal'],
	['/var/lib/skiff-update', '/var/lib/yoal-update'],
	['/var/lib/skiff-builder', '/var/lib/yoal-builder'],
	['/var/lib/skiff-config', '/var/lib/yoal-config'],
	['/var/lib/skiff-helper', '/var/lib/yoal-helper'],
	['/var/lib/skiff-agent', '/var/lib/yoal-agent'],
	['/var/lib/skiff-workloads', '/var/lib/yoal-workloads'],
	['/srv/skiff', '/srv/yoal'],
	['/srv/skiff-cache', '/srv/yoal-cache'],
	['/usr/lib/skiff', '/usr/lib/yoal'],
	['/usr/local/lib/skiff-updater', '/usr/local/lib/yoal-updater'],
	['/run/skiff', '/run/yoal'],
	['/run/skiff-helper', '/run/yoal-helper'],
	['/run/skiff-agent', '/run/yoal-agent'],
	['/run/skiff-workloads', '/run/yoal-workloads'],
	['/run/skiff-shares', '/run/yoal-shares'],
	['/run/skiff-upstream', '/run/yoal-upstream'],
	['/run/skiff-secrets', '/run/yoal-secrets'],
	['/run/skiff-tls', '/run/yoal-tls'],
	['/mnt/skiff-shares', '/mnt/yoal-shares'],
];

/** Directories whose contents are disposable runtime state. */
const RUNTIME_PREFIXES = ['/run/skiff'];

const USER_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['skiff-build', 'yoal-build'],
	['skiff-clickhouse', 'yoal-clickhouse'],
	['skiff', 'yoal'],
];

const GROUP_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['skiff-build', 'yoal-build'],
	['skiff-clickhouse', 'yoal-clickhouse'],
	['skiff-caddy', 'yoal-caddy'],
	['skiff', 'yoal'],
];

const ENV_MERGE_FILES = new Set(['skiff.env', 'agent.env', 'identity.env', 'mail.env', 'helper.env']);
const LEGACY_WINS_FILES = new Set(['master.key', 'master.key.cred', 'config.xml', 'users.xml', 'litestream.yml', 'litestream-identity.yml']);

function envMap(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of migrateEnvText(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		let value = trimmed.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		map.set(trimmed.slice(0, eq).trim(), value);
	}
	return map;
}

function formatEnv(map: Map<string, string>): string {
	return `${[...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? `${key}=${value}` : `${key}="${value.replace(/["\\`$]/g, (c) => `\\${c}`)}"`))
		.join('\n')}\n`;
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function sameInode(a: string, b: string): boolean {
	try {
		const left = statSync(a);
		const right = statSync(b);
		return left.dev === right.dev && left.ino === right.ino;
	} catch {
		return false;
	}
}

/** True when the path is a mount point (its device differs from its parent's). */
function isMountPoint(path: string): boolean {
	try {
		return statSync(path).dev !== statSync(dirname(path)).dev;
	} catch {
		return false;
	}
}

class Migrator {
	readonly root: string;
	readonly dryRun: boolean;
	readonly yes: boolean;
	readonly prefer: 'abort' | 'legacy' | 'current';
	readonly run: Runner;
	readonly log: (message: string) => void;
	readonly now: Date;
	readonly backupDir: string;
	readonly manifest: Manifest;
	readonly changed: string[] = [];
	readonly warnings: string[] = [];
	readonly backedUp = new Set<string>();
	private stopped = false;

	constructor(options: MigrateOptions = {}) {
		this.root = options.root ?? '/';
		this.dryRun = options.dryRun ?? true;
		this.yes = options.yes ?? false;
		this.prefer = options.prefer ?? 'abort';
		this.run = options.run ?? defaultRunner;
		this.log = options.log ?? ((message) => console.log(message));
		this.now = options.now ?? new Date();
		this.backupDir = options.backupDir ?? `${this.root === '/' ? '' : this.root}/var/backups/yoal-skiff-${timestamp(this.now)}`;
		this.manifest = {
			version: MANIFEST_VERSION,
			startedAt: this.now.toISOString(),
			root: this.root,
			backupDir: this.backupDir,
			renames: [],
			rewrites: [],
			symlinks: [],
			users: [],
			groups: [],
			createdGroups: [],
		};
	}

	/** Host-absolute path -> path under the test/root prefix. */
	p(path: string): string {
		return this.root === '/' ? path : join(this.root, path);
	}

	exists(path: string): boolean {
		return existsSync(this.p(path));
	}

	record(step: string): void {
		this.changed.push(step);
	}

	warn(step: string): void {
		this.warnings.push(step);
		this.log(`warning: ${step}`);
	}

	command(cmd: string[]): CommandResult {
		if (this.root !== '/' || this.dryRun) {
			this.log(`would run: ${cmd.join(' ')}`);
			return { code: 0, stdout: '', stderr: '' };
		}
		// Real runs are already recorded as steps; keep the output for warnings and results.
		return this.run(cmd);
	}

	commandOk(cmd: string[]): boolean {
		const result = this.command(cmd);
		return result.code === 0;
	}

	ensureDir(path: string): void {
		if (!this.dryRun) mkdirSync(this.p(path), { recursive: true });
	}

	backupPath(path: string): string {
		return join(this.backupDir, 'files', path.replace(/^\//, ''));
	}

	backupOnce(path: string): string {
		const destination = this.backupPath(path);
		if (this.backedUp.has(path)) return destination;
		this.backedUp.add(path);
		if (!this.dryRun && this.exists(path)) {
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(this.p(path), destination, { recursive: true, preserveTimestamps: true });
		}
		this.manifest.rewrites.push({ path, backup: destination });
		return destination;
	}

	/** Copy a tree once, without recording individual rewrites. */
	backupTree(path: string, name: string): void {
		if (this.dryRun || !this.exists(path)) return;
		const destination = join(this.backupDir, 'copies', name);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(this.p(path), destination, { recursive: true, preserveTimestamps: true });
	}

	rewriteFile(path: string, transform: (text: string) => string): void {
		const full = this.p(path);
		if (!existsSync(full)) return;
		const before = readFileSync(full, 'utf8');
		const after = transform(before);
		if (after === before) return;
		this.backupOnce(path);
		if (!this.dryRun) writeFileSync(full, after);
		this.record(`${this.dryRun ? 'would rewrite' : 'rewrote'} ${path}`);
	}

	move(from: string, to: string): void {
		if (!this.exists(from)) return;
		this.ensureDir(dirname(to));
		if (this.exists(to)) throw new Error(`refusing to overwrite ${to} while moving ${from}`);
		if (!this.dryRun) {
			try {
				renameSync(this.p(from), this.p(to));
			} catch {
				// Cross-device (e.g. a bind mount): copy then remove.
				cpSync(this.p(from), this.p(to), { recursive: true, preserveTimestamps: true });
				rmSync(this.p(from), { recursive: true, force: true });
			}
		}
		this.manifest.renames.push({ from, to });
		this.record(`${this.dryRun ? 'would move' : 'moved'} ${from} -> ${to}`);
	}

	symlink(path: string, target: string, fromPath: string = path, restore: string = target): void {
		const before = this.exists(path) || isSymlink(this.p(path)) ? readlinkSync(this.p(path)) : null;
		if (!this.dryRun) {
			rmSync(this.p(path), { force: true });
			symlinkSync(target, this.p(path));
		}
		this.manifest.symlinks.push({ path, fromPath, before, after: target, restore });
		this.record(`${this.dryRun ? 'would point' : 'pointed'} ${path} -> ${target}`);
	}

	leftover(path: string): string {
		return join(this.backupDir, 'leftovers', path.replace(/^\//, ''));
	}

	/** Move a conflicting entry aside instead of deleting it. */
	moveAside(path: string): void {
		const destination = this.leftover(path);
		this.log(`keeping existing ${path} at ${destination}`);
		this.move(path, destination);
	}

	mergeEntry(from: string, to: string): void {
		if (!this.exists(from)) return;
		const source = this.p(from);
		const name = basename(from);
		// An explicit destination name wins (unit/binary renames); otherwise `skiff.env` becomes
		// `yoal.env` and every other file keeps its name.
		const destinationName = basename(to) !== name ? basename(to) : name === 'skiff.env' ? 'yoal.env' : name;
		const destination = join(dirname(to), destinationName);
		const target = this.p(destination);
		const sourceIsLink = isSymlink(source);
		const targetExists = existsSync(target) || isSymlink(target);

		if (!targetExists) {
			if (sourceIsLink) {
				const original = readlinkSync(source);
				this.symlink(destination, migratePathText(original), from, original);
				if (!this.dryRun) unlinkSync(source);
				return;
			}
			if (ENV_MERGE_FILES.has(name)) {
				this.rewriteFile(from, migrateEnvText);
				this.move(from, destination);
				return;
			}
			this.move(from, destination);
			return;
		}

		if (sourceIsLink) {
			const original = readlinkSync(source);
			const mapped = migratePathText(original);
			// An existing, working link (a partial Yoal install) wins over the old one.
			if (isSymlink(target) && (readlinkSync(target) === mapped || existsSync(target))) {
				this.moveAside(from);
				return;
			}
			this.symlink(destination, mapped, from, original);
			if (!this.dryRun) unlinkSync(source);
			return;
		}

		if (isDir(source) && isDir(target)) {
			for (const entry of readdirSync(source).sort()) this.mergeEntry(join(from, entry), join(destination, entry));
			if (!this.dryRun) {
				try {
					rmdirSync(source);
				} catch {
					this.warn(`${from} is not empty after the merge; inspect it by hand`);
				}
			}
			return;
		}

		if (isFile(source) && isFile(target)) {
			if (ENV_MERGE_FILES.has(name)) {
				this.mergeEnv(from, destination);
				return;
			}
			if (LEGACY_WINS_FILES.has(name)) {
				this.backupOnce(destination);
				if (!this.dryRun) {
					rmSync(this.p(destination), { force: true });
					renameSync(source, this.p(destination));
				}
				this.manifest.renames.push({ from, to: destination });
				this.record(`${this.dryRun ? 'would prefer' : 'preferred'} the pre-rename ${name}`);
				return;
			}
			if (name === 'skiff.db' || name === 'yoal.db') {
				// Leave both databases in place; migrateDatabase() decides which one wins.
				this.moveAside(from);
				return;
			}
			if (readFileSync(source).equals(readFileSync(target))) {
				this.moveAside(from);
				return;
			}
			this.warn(`${from} conflicts with ${destination}; kept the old file`);
			this.moveAside(from);
			return;
		}

		this.warn(`${from} and ${destination} are different kinds; kept the old entry`);
		this.moveAside(from);
	}

	mergeEnv(from: string, to: string): void {
		const legacy = envMap(readFileSync(this.p(from), 'utf8'));
		if (!this.exists(to)) {
			this.rewriteFile(from, migrateEnvText);
			this.move(from, to);
			return;
		}
		const current = envMap(readFileSync(this.p(to), 'utf8'));
		for (const [key, value] of legacy) current.set(key, value);
		this.backupOnce(to);
		if (!this.dryRun) writeFileSync(this.p(to), formatEnv(current), { mode: 0o640 });
		this.moveAside(from);
		this.record(`${this.dryRun ? 'would merge' : 'merged'} ${from} into ${to}`);
	}

	/** Merge a top-level directory, handling runtime state and mount points specially. */
	mergeTop(from: string, to: string): void {
		if (!this.exists(from)) return;
		if (sameInode(this.p(from), this.p(to))) {
			this.warn(`${from} and ${to} are the same path; skipped`);
			return;
		}
		if (!this.exists(to)) {
			this.move(from, to);
			return;
		}
		if (!isDir(this.p(from)) || !isDir(this.p(to))) {
			this.warn(`${from} cannot be merged into ${to}; kept the old entry`);
			this.moveAside(from);
			return;
		}
		// Runtime sockets are disposable; the new services create them again.
		if (RUNTIME_PREFIXES.some((prefix) => from === prefix || from.startsWith(`${prefix}/`))) {
			if (!this.dryRun) rmSync(this.p(from), { recursive: true, force: true });
			this.record(`${this.dryRun ? 'would discard' : 'discarded'} runtime state ${from}`);
			return;
		}
		for (const entry of readdirSync(this.p(from)).sort()) this.mergeEntry(join(from, entry), join(to, entry));
		if (!this.dryRun) {
			try {
				rmdirSync(this.p(from));
			} catch {
				this.warn(`${from} is not empty after the merge; inspect it by hand`);
			}
		}
	}

	detect(): { hasLegacy: boolean; hasYoal: boolean } {
		const hasLegacy =
			TOP_LEVEL.some(([from]) => this.exists(from)) ||
			this.exists('/etc/systemd/system/skiff-agent.service') ||
			this.exists('/etc/tmpfiles.d/skiff.conf');
		const hasYoal = this.exists('/opt/yoal') || this.exists('/etc/yoal') || this.exists('/var/lib/yoal');
		return { hasLegacy, hasYoal };
	}

	/** Old units currently on disk, plus workload/Quadlet services derived from files. */
	oldUnitNames(): string[] {
		const names = new Set<string>();
		const walk = (dir: string, depth: number): void => {
			if (!this.exists(dir) || depth > 3) return;
			for (const entry of readdirSync(this.p(dir)).sort()) {
				const full = join(dir, entry);
				const stat = lstatSync(this.p(full));
				if (stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					walk(full, depth + 1);
					continue;
				}
				if (!entry.startsWith('skiff')) continue;
				if (/\.(service|socket|path|timer|slice)$/.test(entry)) names.add(entry);
				// Quadlet files become <name>.service when systemd loads them.
				if (/\.(container|network|volume|kube|pod)$/.test(entry)) names.add(entry.replace(/\.(container|network|volume|kube|pod)$/, '.service'));
			}
		};
		walk('/etc/systemd/system', 0);
		walk('/etc/containers/systemd', 0);
		return [...names].sort();
	}

	stopServices(): void {
		if (this.stopped) return;
		this.stopped = true;
		const units = this.oldUnitNames();
		for (const unit of units) this.command(['systemctl', 'disable', '--now', unit]);
		if (units.length) this.record(`${this.dryRun ? 'would stop' : 'stopped'} ${units.length} pre-rename unit(s)`);

		// The stock Caddy unit may be serving the old bootstrap config; the installer restarts it.
		if (this.exists('/etc/caddy/Caddyfile')) {
			const body = readFileSync(this.p('/etc/caddy/Caddyfile'), 'utf8');
			if (/\/run\/skiff|\/opt\/skiff|\/var\/lib\/skiff|skiff\.Caddyfile/.test(body)) {
				this.command(['systemctl', 'stop', 'caddy.service']);
				this.record(`${this.dryRun ? 'would stop' : 'stopped'} caddy.service (old bootstrap config)`);
			}
		}
	}

	renameAccounts(): void {
		// A dry run has no getent/id results to trust: assume the legacy account exists and the
		// Yoal one does not, so the plan shows the renames instead of a page of false warnings.
		const simulated = this.dryRun || this.root !== '/';
		const groupExists = (name: string) =>
			simulated ? name.startsWith('skiff') : this.commandOk(['getent', 'group', name]);
		const userExists = (name: string) => (simulated ? name.startsWith('skiff') : this.commandOk(['id', '-u', name]));

		for (const [from, to] of GROUP_PAIRS) {
			if (!groupExists(from)) continue;
			if (groupExists(to)) {
				this.warn(`group ${to} already exists; left ${from} in place`);
				continue;
			}
			const result = this.command(['groupmod', '-n', to, from]);
			if (result.code !== 0) {
				this.warn(`could not rename group ${from} -> ${to}: ${result.stderr || `exit ${result.code}`}`);
				continue;
			}
			this.manifest.groups.push({ from, to });
			this.record(`${this.dryRun ? 'would rename' : 'renamed'} group ${from} -> ${to}`);
		}

		for (const [from, to] of USER_PAIRS) {
			if (!userExists(from)) continue;
			if (userExists(to)) {
				this.warn(`user ${to} already exists; left ${from} in place`);
				continue;
			}
			const args = ['usermod', '-l', to, from];
			if (from === 'skiff') {
				args.push('-d', '/var/lib/yoal');
				if (groupExists('yoal')) args.push('-g', 'yoal');
			}
			if (from === 'skiff-build') args.push('-d', '/var/lib/yoal-builder');
			const result = this.command(args);
			if (result.code !== 0) {
				this.warn(`could not rename user ${from} -> ${to}: ${result.stderr || `exit ${result.code}`}`);
				continue;
			}
			this.manifest.users.push({ from, to });
			this.record(`${this.dryRun ? 'would rename' : 'renamed'} user ${from} -> ${to}`);
		}

		// Release-managed Caddy runs `Group=yoal-caddy`; older installs may not have the group.
		if (!groupExists('yoal-caddy')) {
			this.command(['groupadd', '--system', 'yoal-caddy']);
			this.manifest.createdGroups.push('yoal-caddy');
			this.record(`${this.dryRun ? 'would create' : 'created'} group yoal-caddy`);
		}
		if (userExists('yoal') && groupExists('caddy')) this.command(['usermod', '-aG', 'caddy', 'yoal']);
	}

	renameDirectories(): void {
		for (const [from, to] of TOP_LEVEL) {
			if (!this.exists(from)) continue;
			if (from === '/mnt/skiff-shares' || to === '/mnt/yoal-shares') {
				if (isMountPoint(this.p(from))) {
					this.warn(`${from} is a mount point; shares stay mounted there until the agent remounts them`);
					continue;
				}
			}
			this.mergeTop(from, to);
		}
		// `/usr/local/sbin/skiff-*` and `/usr/local/bin/skiff*` command wrappers.
		for (const dir of ['/usr/local/sbin', '/usr/local/bin']) {
			if (!this.exists(dir)) continue;
			for (const entry of readdirSync(this.p(dir)).sort()) {
				if (!entry.startsWith('skiff') && entry !== 'skif') continue;
				const to = entry === 'skif' ? 'yoal' : `yoal${entry.slice('skiff'.length)}`;
				this.mergeEntry(join(dir, entry), join(dir, to));
			}
		}
		for (const [from, to] of [
			['/etc/tmpfiles.d/skiff.conf', '/etc/tmpfiles.d/yoal.conf'],
			['/var/log/caddy/skiff-access.log', '/var/log/caddy/yoal-access.log'],
			['/etc/caddy/skiff.Caddyfile', '/etc/caddy/yoal.Caddyfile'],
			['/etc/caddy/Caddyfile.pre-skiff', '/etc/caddy/Caddyfile.pre-yoal'],
		] as const) {
			if (!this.exists(from)) continue;
			if (this.exists(to)) this.moveAside(from);
			else this.rewriteAndMove(from, to, migratePathText);
		}
		// Rotated access logs: skiff-access-2026-11-01.log -> yoal-access-2026-11-01.log.
		if (this.exists('/var/log/caddy')) {
			for (const entry of readdirSync(this.p('/var/log/caddy')).sort()) {
				if (!entry.startsWith('skiff-access')) continue;
				const to = `yoal-access${entry.slice('skiff-access'.length)}`;
				this.mergeEntry(join('/var/log/caddy', entry), join('/var/log/caddy', to));
			}
		}
	}

	/** A whole-directory move keeps `skiff.env` inside; rename it once the directory is in place. */
	renameEnvFiles(): void {
		if (this.exists('/etc/yoal/skiff.env')) this.mergeEntry('/etc/yoal/skiff.env', '/etc/yoal/skiff.env');
		else if (this.exists('/etc/skiff/skiff.env')) this.mergeEntry('/etc/skiff/skiff.env', '/etc/yoal/skiff.env');
	}

	/**
	 * Rename the binaries and links a release/updater directory still calls `skiff-*`.
	 * The next installer replaces the release anyway, but the stage-0 updater is used first.
	 */
	renameRuntimeFiles(): void {
		const rewrites: Array<[string, RegExp, (name: string) => string]> = [
			['/usr/local/lib/yoal-updater', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/agent', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/helper', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/cli', /^skif(\.js)?$/, () => 'yoal.js'],
			['/opt/yoal/updater', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/current/agent', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/current/helper', /^skiff/, (name) => `yoal${name.slice('skiff'.length)}`],
			['/opt/yoal/current/cli', /^skif(\.js)?$/, () => 'yoal.js'],
		];
		for (const [dir, pattern, rename] of rewrites) {
			if (!this.exists(dir)) continue;
			for (const entry of readdirSync(this.p(dir)).sort()) {
				if (!pattern.test(entry)) continue;
				this.mergeEntry(join(dir, entry), join(dir, rename(entry)));
			}
		}
		// Also walk releases directly: `current` may be a dangling symlink until fixAbsoluteSymlinks
		// has run, and a release directory is the real target.
		if (this.exists('/opt/yoal/releases')) {
			for (const release of readdirSync(this.p('/opt/yoal/releases')).sort()) {
				for (const sub of ['agent', 'helper', 'cli']) {
					const dir = join('/opt/yoal/releases', release, sub);
					if (!this.exists(dir)) continue;
					for (const entry of readdirSync(this.p(dir)).sort()) {
						if (!/^skif/.test(entry)) continue;
						const renamed = /^skif(\.js)?$/.test(entry) ? 'yoal.js' : `yoal${entry.slice('skiff'.length)}`;
						this.mergeEntry(join(dir, entry), join(dir, renamed));
					}
				}
			}
		}
		// The updater stores one binary per identity under <dir>/<identity>/.
		const updaterDir = '/usr/local/lib/yoal-updater';
		if (this.exists(updaterDir)) {
			for (const entry of readdirSync(this.p(updaterDir)).sort()) {
				const full = join(updaterDir, entry);
				if (!isDir(this.p(full))) continue;
				for (const file of readdirSync(this.p(full)).sort()) {
					if (/^skiff/.test(file)) this.mergeEntry(join(full, file), join(full, `yoal${file.slice('skiff'.length)}`));
				}
			}
		}
	}

	/** Rewrite absolute symlinks inside moved release/updater trees (e.g. `current`). */
	fixAbsoluteSymlinks(dir: string, depth = 0): void {
		if (!this.exists(dir) || depth > 6) return;
		for (const entry of readdirSync(this.p(dir)).sort()) {
			if (['repo', 'node_modules', 'build', '.git', 'data', 'clickhouse', 'objects', 'caddy'].includes(entry)) continue;
			const full = join(dir, entry);
			if (isSymlink(this.p(full))) {
				const target = readlinkSync(this.p(full));
				// Absolute links get the full path map; relative links such as
				// `skiff-builder -> skiff-agent` only need their basename renamed.
				const base = target.split('/').pop() ?? '';
				const mapped = target.startsWith('/')
					? migratePathText(target)
					: /^skif/.test(base)
						? `${target.slice(0, target.length - base.length)}${base === 'skif' ? 'yoal' : base === 'skif.js' ? 'yoal.js' : `yoal${base.slice('skiff'.length)}`}`
						: target;
				if (mapped !== target) this.symlink(full, mapped, unmigratePath(full), target);
				continue;
			}
			if (isDir(this.p(full))) this.fixAbsoluteSymlinks(full, depth + 1);
		}
	}

	rewriteAndMove(from: string, to: string, transform: (text: string) => string): void {
		this.rewriteFile(from, transform);
		this.move(from, to);
	}

	/** Rename unit files, drop-ins, want-links and Quadlets, deepest entries first. */
	renameUnits(): void {
		for (const dir of ['/etc/systemd/system', '/etc/containers/systemd']) this.renameUnitTree(dir);
	}

	renameUnitTree(dir: string): void {
		if (!this.exists(dir)) return;
		const entries: string[] = [];
		const walk = (current: string, depth: number): void => {
			if (depth > 4) return;
			for (const entry of readdirSync(this.p(current))) {
				const full = join(current, entry);
				const stat = lstatSync(this.p(full));
				if (stat.isDirectory()) {
					walk(full, depth + 1);
					if (/^skiff/.test(entry)) entries.push(full);
					continue;
				}
				if (!/skiff|skif(\.|$)/.test(entry) && !stat.isSymbolicLink()) continue;
				if (stat.isSymbolicLink() && !/skiff/i.test(entry) && !/skiff/i.test(readlinkSync(this.p(full)))) continue;
				entries.push(full);
			}
		};
		walk(dir, 0);
		// Children before the drop-in directory that contains them.
		entries.sort((a, b) => b.length - a.length);
		for (const full of entries) {
			const name = basename(full);
			const renamed = name === 'skif' ? 'yoal' : name.replace(/^skiff/, 'yoal').replace(/^skif$/, 'yoal');
			const destination = join(dirname(full), renamed);
			const source = this.p(full);
			if (isSymlink(source)) {
				const original = readlinkSync(source);
				if (this.exists(destination) && !isSymlink(this.p(destination))) {
					this.warn(`${destination} already exists; kept the old link at ${full}`);
					continue;
				}
				this.symlink(destination, migratePathText(original), full, original);
				if (!this.dryRun) unlinkSync(source);
				continue;
			}
			if (isFile(source)) {
				if (/\.(service|socket|path|timer|slice|conf|container|network|volume|kube|pod)$/.test(name)) {
					const body = readFileSync(source, 'utf8');
					const rewritten = migrateUnitText(body);
					if (rewritten !== body) this.rewriteFile(full, migrateUnitText);
				}
			}
			if (this.exists(destination)) {
				this.warn(`${destination} already exists; kept the old entry at ${full}`);
				continue;
			}
			this.move(full, destination);
		}
	}

	rewriteKnownConfigs(): void {
		// Every env file now lives under /etc/yoal (the merge above handled the old names).
		const etc = this.exists('/etc/yoal') ? '/etc/yoal' : '/etc/skiff';
		if (this.exists(etc)) {
			for (const entry of readdirSync(this.p(etc)).sort()) {
				if (entry.endsWith('.env')) this.rewriteFile(join(etc, entry), migrateEnvText);
			}
		}

		// The /usr/local wrappers embed the old release paths and command names.
		for (const dir of ['/usr/local/sbin', '/usr/local/bin']) {
			if (!this.exists(dir)) continue;
			for (const entry of readdirSync(this.p(dir)).sort()) {
				if (entry === 'yoal' || entry.startsWith('yoal-')) this.rewriteFile(join(dir, entry), migrateUnitText);
			}
		}

		// Caddy bootstrap config and autosave: paths only, so user domains are untouched.
		for (const path of ['/etc/caddy/Caddyfile', '/etc/caddy/yoal.Caddyfile', '/etc/caddy/Caddyfile.pre-yoal']) {
			this.rewriteFile(path, migratePathText);
		}
		if (this.exists('/var/lib/yoal/caddy')) {
			const walk = (dir: string): void => {
				for (const entry of readdirSync(this.p(dir))) {
					const full = join(dir, entry);
					const stat = lstatSync(this.p(full));
					if (stat.isDirectory()) walk(full);
					else if (entry === 'autosave.json') this.rewriteFile(full, migratePathText);
				}
			};
			walk('/var/lib/yoal/caddy');
		}

		// Litestream keeps `skiff/sqlite` as its R2 prefix on purpose: existing snapshots stay
		// restorable. Only local paths and env references are renamed.
		for (const path of ['/etc/yoal/litestream.yml', '/etc/yoal/litestream-identity.yml']) {
			this.rewriteFile(path, (text) => migratePathText(text).replace(/\bSKIFF_/g, 'YOAL_'));
		}

		// ClickHouse files are generated by Yoal; every `skiff` word in them is ours.
		const clickhouseEtc = this.exists('/etc/yoal/clickhouse') ? '/etc/yoal/clickhouse' : '/etc/skiff/clickhouse';
		if (this.exists(clickhouseEtc)) {
			for (const entry of readdirSync(this.p(clickhouseEtc)).sort()) {
				if (entry.endsWith('.xml')) this.rewriteFile(join(clickhouseEtc, entry), migrateUnitText);
			}
		}

		// Update metadata and status: the repository rename matters, otherwise the updater
		// would keep asking the old repo for artifact names that no longer exist.
		for (const path of ['/opt/yoal/update-state.json', '/var/lib/yoal-update/status.json', '/var/lib/yoal-config/status.json', '/etc/yoal/storage.json']) {
			this.rewriteFile(path, migratePathText);
		}
		if (this.exists('/opt/yoal/releases')) {
			for (const release of readdirSync(this.p('/opt/yoal/releases'))) {
				this.rewriteFile(join('/opt/yoal/releases', release, 'meta.json'), (text) => migratePathText(text).replace(/KieranHolroyd\/skiff\b/gi, 'KieranHolroyd/yoal'));
			}
		}
	}

	renameClickHouseData(): void {
		const targetRoot = '/var/lib/yoal/clickhouse';
		// In a dry run the directories have not moved yet; still report what would happen.
		const sourceRoot = this.exists(targetRoot) ? targetRoot : '/var/lib/skiff/clickhouse';
		// ClickHouse keeps its store under `<path>/data`; older layouts may use `<path>` directly.
		const sourceBase = this.exists(join(sourceRoot, 'data')) ? join(sourceRoot, 'data') : sourceRoot;
		const targetBase = this.exists(join(targetRoot, 'data')) ? join(targetRoot, 'data') : targetRoot;
		if (!this.exists(sourceBase)) return;
		for (const [from, to] of [
			['metadata/skiff.sql', 'metadata/yoal.sql'],
			['metadata/skiff', 'metadata/yoal'],
			['metadata_dropped/skiff.sql', 'metadata_dropped/yoal.sql'],
			['metadata_dropped/skiff', 'metadata_dropped/yoal'],
			['data/skiff', 'data/yoal'],
		] as const) {
			const source = join(sourceBase, from);
			const target = join(targetBase, to);
			if (!this.exists(source)) continue;
			if (this.exists(target)) {
				this.warn(`${source} and ${target} both exist; kept ${target}`);
				this.moveAside(source);
			} else {
				this.move(source, target);
			}
		}
	}

	/** Read the setup marker from a SQLite database, if it is readable. */
	private hasSetupUser(path: string): boolean | null {
		try {
			const db = new Database(this.p(path), { readonly: true, create: false, strict: true });
			try {
				const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'").get();
				if (!table) return false;
				return Boolean(db.query('SELECT 1 FROM user LIMIT 1').get());
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	migrateDatabase(): void {
		const dir = '/var/lib/yoal/data';
		const legacy = join(dir, 'skiff.db');
		const current = join(dir, 'yoal.db');
		if (!this.exists(legacy) && !this.exists(current)) return;

		let chosen = current;
		if (this.exists(legacy) && !this.exists(current)) {
			chosen = legacy;
		} else if (this.exists(legacy) && this.exists(current)) {
			const legacyPopulated = this.hasSetupUser(legacy);
			const currentPopulated = this.hasSetupUser(current);
			if (legacyPopulated && currentPopulated) {
				if (this.prefer === 'legacy') chosen = legacy;
				else if (this.prefer === 'current') chosen = current;
				else
					throw new Error(
						`both ${legacy} and ${current} contain a set-up database; re-run with --prefer legacy or --prefer current`,
					);
			} else if (legacyPopulated) chosen = legacy;
			else chosen = current;
		}

		if (chosen === legacy) {
			for (const suffix of ['', '-wal', '-shm']) {
				const existing = `${current}${suffix}`;
				if (!this.exists(existing)) continue;
				if (suffix === '') this.backupOnce(existing);
				this.move(existing, join(this.backupDir, 'leftovers', 'data', `yoal.db.empty${suffix}`));
			}
			for (const suffix of ['', '-wal', '-shm']) {
				const from = `${legacy}${suffix}`;
				const to = `${current}${suffix}`;
				if (!this.exists(from)) continue;
				if (this.exists(to)) this.moveAside(from);
				else this.move(from, to);
			}
			this.record(`${this.dryRun ? 'would adopt' : 'adopted'} the pre-rename database ${legacy}`);
		} else {
			if (this.exists(legacy)) this.moveAside(legacy);
			if (this.exists(`${legacy}-wal`)) this.moveAside(`${legacy}-wal`);
			if (this.exists(`${legacy}-shm`)) this.moveAside(`${legacy}-shm`);
		}

		const dbPath = this.p(current);
		if (this.dryRun || !existsSync(dbPath)) return;
		try {
			const db = new Database(dbPath, { create: false, strict: true });
			try {
				const has = (name: string) =>
					Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
				if (has('skiff_migrations')) {
					if (!has('yoal_migrations')) db.run('ALTER TABLE skiff_migrations RENAME TO yoal_migrations');
					else {
						db.run('CREATE TABLE IF NOT EXISTS yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
						db.run('INSERT OR IGNORE INTO yoal_migrations (id, applied_at) SELECT id, applied_at FROM skiff_migrations');
					}
					this.record('renamed the migration ledger skiff_migrations -> yoal_migrations');
				}
			} finally {
				db.close();
			}
		} catch (error) {
			this.warn(`could not update the migration ledger: ${(error as Error).message}`);
		}
	}

	/** Make a copy of the small, hard-to-rebuild state before touching anything. */
	backup(): void {
		if (this.dryRun) return;
		mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
		chmodSync(this.backupDir, 0o700);
		this.backupTree('/etc/skiff', 'etc-skiff');
		this.backupTree('/etc/yoal', 'etc-yoal');
		this.backupTree('/etc/caddy', 'etc-caddy');
		this.backupTree('/etc/systemd/system', 'systemd');
		this.backupTree('/etc/containers/systemd', 'containers');
		this.backupTree('/var/lib/skiff-update', 'update-state');
		// Only the databases, not the object store or ClickHouse history (which are large and
		// remain recoverable in place).
		const databases = [
			'/var/lib/skiff/data/skiff.db',
			'/var/lib/skiff/data/yoal.db',
			'/var/lib/skiff/identity/identity.db',
			'/var/lib/yoal/data/skiff.db',
			'/var/lib/yoal/data/yoal.db',
			'/var/lib/yoal/identity/identity.db',
		];
		for (const db of databases) {
			for (const suffix of ['', '-wal', '-shm']) {
				const path = `${db}${suffix}`;
				if (!this.exists(path)) continue;
				const destination = join(this.backupDir, 'db', path.replace(/^\//, ''));
				mkdirSync(dirname(destination), { recursive: true });
				copyFileSync(this.p(path), destination);
			}
		}
		this.record(`wrote the pre-migration backup to ${this.backupDir}`);
	}

	runMigration(): MigrateResult {
		const { hasLegacy } = this.detect();
		if (!hasLegacy) {
			const hasYoal = this.exists('/opt/yoal') || this.exists('/etc/yoal');
			if (hasYoal) this.log('This host already uses the Yoal names; nothing to do.');
			else this.log('No Skiff installation was found on this host.');
			return { changed: [], warnings: [], backupDir: null, alreadyConverted: hasYoal };
		}

		if (this.root !== '/' && !this.dryRun) this.log('Testing against a root prefix: system commands are simulated.');
		this.log(this.dryRun ? 'Planning the Skiff -> Yoal conversion (dry run).' : 'Converting this host from Skiff to Yoal.');

		// Stop first so the database and ClickHouse copy made by backup() is quiescent.
		try {
			this.stopServices();
			this.backup();
			this.renameAccounts();
			this.renameDirectories();
			this.renameEnvFiles();
			this.fixAbsoluteSymlinks('/opt/yoal');
			this.fixAbsoluteSymlinks('/usr/local/lib/yoal-updater');
			this.fixAbsoluteSymlinks('/srv/yoal');
			this.renameRuntimeFiles();
			this.renameUnits();
			this.renameClickHouseData();
			this.migrateDatabase();
			this.rewriteKnownConfigs();
		} finally {
			// Even a failed conversion leaves a manifest, so the renames already made can be reversed.
			if (!this.dryRun) {
				mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
				writeFileSync(join(this.backupDir, 'manifest.json'), `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
				chmodSync(join(this.backupDir, 'manifest.json'), 0o600);
			}
		}

		if (!this.dryRun) {
			this.command(['systemctl', 'daemon-reload']);
			this.command(['systemctl', 'reset-failed']);
			this.command(['systemd-tmpfiles', '--create', '/etc/tmpfiles.d/yoal.conf']);
		}

		return { changed: this.changed, warnings: this.warnings, backupDir: this.dryRun ? null : this.backupDir, alreadyConverted: false };
	}
}

/** Run the conversion against a host (or a test root). */
export function migrateHost(options: MigrateOptions = {}): MigrateResult {
	return new Migrator(options).runMigration();
}

/** Reverse a previous conversion from its manifest. */
export function rollback(manifest: Manifest, options: { root?: string; run?: Runner; log?: (message: string) => void } = {}): void {
	const root = options.root ?? manifest.root ?? '/';
	const run = options.run ?? defaultRunner;
	const log = options.log ?? ((message) => console.log(message));
	const p = (path: string) => (root === '/' ? path : join(root, path));
	const command = (cmd: string[]) => {
		if (root === '/') run(cmd);
		else log(`would run: ${cmd.join(' ')}`);
	};

	log('Stopping the converted units before restoring the pre-rename host.');
	for (const unit of ['yoal-control-plane.service', 'yoal-agent.service', 'yoal-helper.service', 'yoal-caddy.service', 'yoal-clickhouse.service']) {
		command(['systemctl', 'disable', '--now', unit]);
	}

	// Renames first: rewriting an old path before the file has moved back would be undone by
	// the reverse rename. Then restore original bytes at the restored paths.
	for (const rename of [...manifest.renames].reverse()) {
		if (!existsSync(p(rename.to))) continue;
		mkdirSync(dirname(p(rename.from)), { recursive: true });
		if (existsSync(p(rename.from))) rmSync(p(rename.from), { recursive: true, force: true });
		renameSync(p(rename.to), p(rename.from));
	}
	for (const rewrite of [...manifest.rewrites].reverse()) {
		if (!existsSync(rewrite.backup)) continue;
		// Files rewritten after the directory move have a Yoal path; put the bytes back where
		// the pre-rename host expects them.
		const path = unmigratePath(rewrite.path);
		mkdirSync(dirname(p(path)), { recursive: true });
		cpSync(rewrite.backup, p(path), { recursive: true, preserveTimestamps: true });
	}
	for (const symlink of [...manifest.symlinks].reverse()) {
		rmSync(p(symlink.path), { force: true });
		if (symlink.fromPath !== symlink.path) rmSync(p(symlink.fromPath), { force: true });
		mkdirSync(dirname(p(symlink.fromPath)), { recursive: true });
		symlinkSync(symlink.restore, p(symlink.fromPath));
	}
	for (const user of [...manifest.users].reverse()) {
		const args = ['usermod', '-l', user.from, user.to];
		if (user.from === 'skiff') args.push('-d', '/var/lib/skiff');
		if (user.from === 'skiff-build') args.push('-d', '/var/lib/skiff-builder');
		if (root === '/') run(args);
		else log(`would run: ${args.join(' ')}`);
	}
	for (const group of [...manifest.groups].reverse()) {
		if (root === '/') run(['groupmod', '-n', group.from, group.to]);
		else log(`would run: groupmod -n ${group.from} ${group.to}`);
	}
	for (const group of manifest.createdGroups) {
		if (root === '/') run(['groupdel', group]);
		else log(`would run: groupdel ${group}`);
	}
	command(['systemctl', 'daemon-reload']);
	log('Rollback complete. The pre-rename units and paths are restored but left stopped.');
}

function usage(): never {
	console.error(`Skiff -> Yoal host converter

Usage:
  bun skiff-to-yoal.ts [--dry-run] [--apply] [--yes] [options]

  --dry-run             print what would change (default)
  --apply               perform the conversion
  --yes                 do not ask for confirmation
  --backup-dir <path>   where to keep backups (default /var/backups/yoal-skiff-<timestamp>)
  --prefer <mode>       when both skiff.db and yoal.db are set up: abort (default), legacy, current
  --root <path>         test against a directory prefix (system commands are simulated)
  --rollback <manifest> reverse a previous --apply using its manifest.json
  -h, --help            show this help

Run as root on the host. Services are stopped and left stopped; afterwards install or
upgrade the current Yoal release with install.sh --upgrade.
`);
	process.exit(64);
}

function parse(argv: string[]): { options: MigrateOptions; apply: boolean; rollbackPath: string | null } {
	const options: MigrateOptions = { dryRun: true };
	let apply = false;
	let rollbackPath: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--apply':
				apply = true;
				options.dryRun = false;
				break;
			case '--yes':
			case '-y':
				options.yes = true;
				break;
			case '--backup-dir': {
				const value = argv[++i];
				if (!value) usage();
				options.backupDir = value;
				break;
			}
			case '--prefer': {
				const value = argv[++i];
				if (value !== 'abort' && value !== 'legacy' && value !== 'current') usage();
				options.prefer = value;
				break;
			}
			case '--root': {
				const value = argv[++i];
				if (!value) usage();
				options.root = value;
				break;
			}
			case '--rollback': {
				const value = argv[++i];
				if (!value) usage();
				rollbackPath = value;
				break;
			}
			case '-h':
			case '--help':
				usage();
				break;
			default:
				console.error(`unknown option: ${arg}`);
				usage();
		}
	}
	if (apply && rollbackPath) usage();
	return { options, apply, rollbackPath };
}

async function main(): Promise<void> {
	const { options, apply, rollbackPath } = parse(process.argv.slice(2));
	if (rollbackPath) {
		const manifest = JSON.parse(readFileSync(rollbackPath, 'utf8')) as Manifest;
		if (manifest.version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version ${manifest.version}`);
		rollback(manifest, { root: options.root, log: options.log });
		return;
	}
	if (!options.dryRun && (options.root ?? '/') === '/') {
		if (process.platform !== 'linux') {
			console.error('The converter applies to a Linux host; use --dry-run --root <dir> for a preview elsewhere.');
			process.exit(1);
		}
		if (process.getuid?.() !== 0) {
			console.error('Run as root: sudo bun skiff-to-yoal.ts --apply');
			process.exit(1);
		}
	}
	if (!options.dryRun && !options.yes) {
		const readline = await import('node:readline/promises');
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question('Convert this host from Skiff to Yoal now? [y/N] ');
		rl.close();
		if (!/^y(es)?$/i.test(answer.trim())) {
			console.log('Nothing changed.');
			return;
		}
	}

	const migrator = new Migrator(options);
	const result = migrator.runMigration();
	console.log('');
	if (options.dryRun) {
		for (const step of result.changed) console.log(`  ${step}`);
		console.log('');
	}
	console.log(`${result.changed.length} step(s), ${result.warnings.length} warning(s).`);
	if (result.backupDir) console.log(`Backup and manifest: ${result.backupDir}/manifest.json`);
	if (result.alreadyConverted) return;

	console.log('');
	if (options.dryRun) {
		console.log('Dry run only: nothing was changed. Re-run with --apply --yes to convert.');
		return;
	}
	const root = options.root ?? '/';
	const hasControlPlane = existsSync(join(root, 'var/lib/yoal/data/yoal.db')) || existsSync(join(root, 'var/lib/yoal/data/skiff.db'));
	if (hasControlPlane) {
		console.log('Services are stopped. Activate the current Yoal release:');
		console.log('  curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh \\');
		console.log('    | sudo env YOAL_YES=1 sh -s -- --upgrade');
		console.log('');
		console.log('Add --canary after --upgrade if this host follows the canary channel.');
	} else {
		console.log('Services are stopped. This looks like a worker node (no control-plane database).');
		console.log('Install the current yoal-agent and yoal-helper for this node, then start');
		console.log('yoal-agent: see docs/OPS.md §4.1.2 or Nodes -> Add worker.');
	}
	if (result.backupDir) console.log(`To undo the file renames: sudo bun ${process.argv[1]} --rollback ${result.backupDir}/manifest.json`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(`skiff-to-yoal: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
