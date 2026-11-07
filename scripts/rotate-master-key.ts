#!/usr/bin/env bun
/**
 * skiff-rotate-master-key: replace the master key (D18, the KEK) without re-encrypting any
 * secret. The master key only wraps values directly in two places, and both are re-wrapped:
 *
 *   org_keys.wrapped_key        each organisation's data key (DEK); every secret, database,
 *                               storage, broker, email and backup-target credential is sealed
 *                               with a DEK, so none of those change
 *   git_sources.webhook_secret  GitHub webhook secrets (sealed with the KEK itself)
 *
 *   sudo skiff-rotate-master-key --dry-run      # check the current key opens everything; change nothing
 *   sudo skiff-rotate-master-key [--yes]
 *
 * Order, chosen so that every crash point leaves a key that opens the database:
 *
 *   1. prove the current key unwraps every row (refuse otherwise)
 *   2. snapshot the database to /var/lib/skiff/backups/pre-key-rotation-<UTC>.db
 *   3. generate the new key and stage it beside the live one (`<store>.new`, sealed with
 *      systemd-creds when the live key is), read it back
 *   4. stop the control plane (it holds the old key in memory and would wrap new DEKs with it)
 *   5. re-wrap in one SQLite transaction that also re-opens every row with the new key before
 *      it commits
 *   6. copy the live key to `<store>.old`, rename the staged key over the live one
 *   7. start the control plane, wait for /readyz, read the key back the way the unit does and
 *      unwrap every row again
 *   8. only then destroy `<store>.old`; on any failure in 6–7 the database is re-wrapped back
 *      and the old key restored
 *
 * Re-running after a crash finishes or discards a half-done rotation (whichever key opens the
 * database decides). The previous recovery kit holds the old key, which older Litestream
 * snapshots and pre-update bundles still need: re-export the kit, keep the old one until those
 * have aged out.
 */
import { Database } from 'bun:sqlite';
import { chownSync, copyFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decrypt, encrypt } from '../packages/core/src/util.ts';
import { readEnvFile } from './install/env-file.ts';
import {
	defaultCredsRunner,
	destroyKeyFile,
	detectCredsSupport,
	generateMasterKey,
	locateMasterKey,
	readMasterKey,
	systemdCredsBin,
	writeMasterKey,
	type CredsRunner,
	type MasterKeyStore,
} from './install/master-key.ts';
import { PRIMARY_UNIT, STANDBY_UNIT } from './systemd/control-plane.ts';
import { TRIGGER_SERVICE_UNIT } from './update-self/units.ts';

// ---------------------------------------------------------------------------------------------
// Database: unwrap / re-wrap / verify
// ---------------------------------------------------------------------------------------------

export interface WrappedCounts {
	orgKeys: number;
	webhookSecrets: number;
}

/** The base64 text in the key file as the 32 bytes the control plane uses. */
export function keyBytes(key: string): Uint8Array {
	const bytes = Buffer.from(key.trim(), 'base64');
	if (bytes.byteLength !== 32) throw new Error('master key must be 32 bytes (base64)');
	return new Uint8Array(bytes);
}

/** org_keys.wrapped_key: base64(nonce ‖ ciphertext ‖ tag), as SecretService writes it. */
function unwrapOrgKey(master: Uint8Array, wrapped: string): Uint8Array {
	const buffer = Buffer.from(wrapped, 'base64');
	return decrypt(master, buffer.subarray(12).toString('base64'), buffer.subarray(0, 12).toString('base64'));
}

function wrapOrgKey(master: Uint8Array, dek: Uint8Array): string {
	const sealed = encrypt(master, dek);
	return Buffer.concat([Buffer.from(sealed.nonce, 'base64'), Buffer.from(sealed.ciphertext, 'base64')]).toString('base64');
}

/** git_sources.webhook_secret: `nonce:ciphertext`, as BuildService writes it. */
function openWebhookSecret(master: Uint8Array, sealed: string): Uint8Array {
	const [nonce, ciphertext] = sealed.split(':');
	if (!nonce || !ciphertext) throw new Error('malformed');
	return decrypt(master, ciphertext, nonce);
}

function sealWebhookSecret(master: Uint8Array, value: Uint8Array): string {
	const sealed = encrypt(master, value);
	return `${sealed.nonce}:${sealed.ciphertext}`;
}

function hasTable(db: Database, name: string): boolean {
	return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

interface Unwrapped {
	orgKeys: Array<{ orgId: string; dek: Uint8Array }>;
	webhookSecrets: Array<{ id: string; value: Uint8Array }>;
}

/** Open every value wrapped by `master`. Throws naming the first row that does not open. */
function unwrapAll(db: Database, master: Uint8Array): Unwrapped {
	const out: Unwrapped = { orgKeys: [], webhookSecrets: [] };
	if (hasTable(db, 'org_keys')) {
		for (const row of db.query<{ org_id: string; wrapped_key: string }, []>('SELECT org_id, wrapped_key FROM org_keys ORDER BY org_id').all()) {
			try {
				out.orgKeys.push({ orgId: row.org_id, dek: unwrapOrgKey(master, row.wrapped_key) });
			} catch {
				throw new Error(`the data key of organisation ${row.org_id} does not open with this master key`);
			}
		}
	}
	if (hasTable(db, 'git_sources')) {
		const rows = db
			.query<{ id: string; webhook_secret: string }, []>('SELECT id, webhook_secret FROM git_sources WHERE webhook_secret IS NOT NULL ORDER BY id')
			.all();
		for (const row of rows) {
			try {
				out.webhookSecrets.push({ id: row.id, value: openWebhookSecret(master, row.webhook_secret) });
			} catch {
				throw new Error(`the webhook secret of git source ${row.id} does not open with this master key`);
			}
		}
	}
	return out;
}

function counts(unwrapped: Unwrapped): WrappedCounts {
	return { orgKeys: unwrapped.orgKeys.length, webhookSecrets: unwrapped.webhookSecrets.length };
}

/** Every master-key-wrapped value opens with `master`. Throws otherwise. */
export function verifyDatabase(db: Database, master: Uint8Array): WrappedCounts {
	return counts(unwrapAll(db, master));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/**
 * Re-wrap every value from `oldKey` to `newKey` in one write transaction, which only commits
 * after every row re-opens with `newKey` to the same bytes. Nothing changes on any error.
 */
export function rewrapDatabase(db: Database, oldKey: Uint8Array, newKey: Uint8Array): WrappedCounts {
	db.run('PRAGMA busy_timeout = 10000');
	db.run('BEGIN IMMEDIATE');
	try {
		const before = unwrapAll(db, oldKey);
		const updateOrg = db.prepare('UPDATE org_keys SET wrapped_key = ? WHERE org_id = ?');
		for (const row of before.orgKeys) updateOrg.run(wrapOrgKey(newKey, row.dek), row.orgId);
		const updateHook = db.prepare('UPDATE git_sources SET webhook_secret = ? WHERE id = ?');
		for (const row of before.webhookSecrets) updateHook.run(sealWebhookSecret(newKey, row.value), row.id);
		const after = unwrapAll(db, newKey);
		const same =
			after.orgKeys.length === before.orgKeys.length &&
			after.webhookSecrets.length === before.webhookSecrets.length &&
			after.orgKeys.every((row, i) => row.orgId === before.orgKeys[i]!.orgId && sameBytes(row.dek, before.orgKeys[i]!.dek)) &&
			after.webhookSecrets.every((row, i) => row.id === before.webhookSecrets[i]!.id && sameBytes(row.value, before.webhookSecrets[i]!.value));
		if (!same) throw new Error('re-wrapped values do not match the originals');
		db.run('COMMIT');
		return counts(before);
	} catch (error) {
		db.run('ROLLBACK');
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------------------------

export interface RotateHost {
	log(message: string): void;
	isActive(unit: string): boolean;
	stop(unit: string): void;
	start(unit: string): void;
	/** The control plane answers /readyz. */
	healthy(): boolean;
	confirm(question: string): Promise<boolean>;
}

export interface RotateOptions {
	/** `/etc/skiff/master.key` (the sealed store is `master.key.cred` beside it). */
	plainPath: string;
	dbPath: string;
	backupsDir: string;
	dryRun?: boolean;
	yes?: boolean;
	credsRun?: CredsRunner;
	credsBin?: string;
	now?: () => Date;
}

export interface RotateResult {
	status: 'dry-run' | 'rotated';
	store: MasterKeyStore;
	counts: WrappedCounts;
	snapshot: string | null;
	/** True when this run finished a rotation an earlier run had committed. */
	resumed: boolean;
}

export class RotationError extends Error {}

const CONTROL_UNITS = [PRIMARY_UNIT, STANDBY_UNIT];

/**
 * Always opened read-write: a WAL database needs its -shm even to read, and a read-only open
 * fails when the sidecars are absent (control plane stopped). `query_only` guards the reads.
 */
function withDb<T>(path: string, fn: (db: Database) => T, queryOnly = false): T {
	const db = new Database(path, { readwrite: true, create: false });
	try {
		db.run('PRAGMA busy_timeout = 10000');
		if (queryOnly) db.run('PRAGMA query_only = ON');
		return fn(db);
	} finally {
		db.close();
		restoreOwnership(path);
	}
}

function opens(dbPath: string, key: string | null): WrappedCounts | null {
	if (!key) return null;
	try {
		return withDb(dbPath, (db) => verifyDatabase(db, keyBytes(key)), true);
	} catch {
		return null;
	}
}

/** Root writing a WAL database may create its -wal/-shm; hand them back to the database's owner. */
function restoreOwnership(dbPath: string): void {
	if (process.getuid?.() !== 0 || !existsSync(dbPath)) return;
	const { uid, gid } = statSync(dbPath);
	for (const suffix of ['-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) chownSync(`${dbPath}${suffix}`, uid, gid);
}

function stamp(now: Date): string {
	return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export async function rotateMasterKey(options: RotateOptions, host: RotateHost): Promise<RotateResult> {
	const run = options.credsRun ?? defaultCredsRunner;
	const bin = options.credsBin ?? systemdCredsBin();
	const now = options.now ?? (() => new Date());
	const read = (store: MasterKeyStore) => readMasterKey(store, run, bin);
	const tryRead = (store: MasterKeyStore) => {
		try {
			return existsSync(store.path) ? read(store) : null;
		} catch {
			return null;
		}
	};

	const store = locateMasterKey(options.plainPath);
	if (!store) throw new RotationError(`no master key at ${options.plainPath} or ${options.plainPath}.cred (is Skiff installed?)`);
	if (!existsSync(options.dbPath)) throw new RotationError(`no database at ${options.dbPath}`);
	const staged: MasterKeyStore = { kind: store.kind, path: `${store.path}.new` };
	const previous: MasterKeyStore = { kind: store.kind, path: `${store.path}.old` };
	const live = read(store);
	host.log(`master key: ${store.kind === 'sealed' ? 'sealed with systemd-creds' : 'root-only file'} at ${store.path}`);

	// A half-done earlier run: whichever key opens the database decides what it left behind.
	let resumeKey: string | null = null;
	if (existsSync(staged.path)) {
		const stagedKey = tryRead(staged);
		if (stagedKey && opens(options.dbPath, stagedKey)) {
			host.log(`an earlier rotation committed the database to the key staged at ${staged.path}; finishing it`);
			resumeKey = stagedKey;
		} else if (opens(options.dbPath, live)) {
			host.log(`discarding ${staged.path} left by an earlier rotation that did not commit`);
			if (!options.dryRun) destroyKeyFile(staged.path);
		} else {
			throw new RotationError(`neither ${store.path} nor ${staged.path} opens the database; restore from the recovery kit (docs/OPS.md §11)`);
		}
	}
	const current = resumeKey ?? live;
	let found: WrappedCounts;
	try {
		found = withDb(options.dbPath, (db) => verifyDatabase(db, keyBytes(current)), true);
	} catch (error) {
		throw new RotationError(`${(error as Error).message}; refusing to rotate (is ${store.path} this database's key?)`);
	}
	if (!resumeKey && existsSync(previous.path)) {
		host.log(`removing ${previous.path} left by an earlier rotation (the database already uses ${store.path})`);
		if (!options.dryRun) destroyKeyFile(previous.path);
	}
	host.log(`${found.orgKeys} organisation data key(s) and ${found.webhookSecrets} webhook secret(s) open with the current key`);

	if (options.dryRun) {
		const plan = resumeKey
			? [`would switch ${store.path} to the staged key, restart the control plane and verify`]
			: [
					`would snapshot ${options.dbPath} into ${options.backupsDir}`,
					`would stage a new key at ${staged.path}${store.kind === 'sealed' ? ' (sealed with systemd-creds)' : ''}`,
					`would stop ${CONTROL_UNITS.join(' and ')} and re-wrap ${found.orgKeys + found.webhookSecrets} value(s) in one transaction`,
					`would switch ${store.path}, start the control plane, verify, then destroy the old key file`,
				];
		for (const line of plan) host.log(line);
		return { status: 'dry-run', store, counts: found, snapshot: null, resumed: !!resumeKey };
	}

	if (host.isActive(TRIGGER_SERVICE_UNIT)) throw new RotationError(`an update is running (${TRIGGER_SERVICE_UNIT}); retry when it has finished`);
	if (!options.yes && !resumeKey) {
		const ok = await host.confirm(
			`Rotate the master key? The control plane stops for a few seconds (sites keep serving) and every org data key is re-wrapped.`,
		);
		if (!ok) throw new RotationError('aborted');
	}

	const active = CONTROL_UNITS.filter((unit) => host.isActive(unit));
	const startAgain = active.length ? [PRIMARY_UNIT] : [];
	let snapshot: string | null = null;
	let newKey: string;
	if (resumeKey) newKey = resumeKey;
	else {
		mkdirSync(options.backupsDir, { recursive: true });
		snapshot = join(options.backupsDir, `pre-key-rotation-${stamp(now())}.db`);
		rmSync(snapshot, { force: true });
		withDb(options.dbPath, (db) => db.run('VACUUM INTO ?', [snapshot!]));
		chmodSync(snapshot, 0o600);
		host.log(`snapshot: ${snapshot}`);

		newKey = generateMasterKey();
		const binding = writeMasterKey(staged, newKey, {
			tpm2: store.kind === 'sealed' && detectCredsSupport(run, bin).tpm2,
			run,
			bin,
		});
		if (read(staged) !== newKey) throw new RotationError(`the staged key at ${staged.path} does not read back`);
		host.log(`new key staged at ${staged.path} (${binding})`);
	}

	for (const unit of CONTROL_UNITS) if (host.isActive(unit)) host.stop(unit);
	if (!resumeKey) {
		try {
			const rewrapped = withDb(options.dbPath, (db) => rewrapDatabase(db, keyBytes(live), keyBytes(newKey)));
			host.log(`re-wrapped ${rewrapped.orgKeys} data key(s) and ${rewrapped.webhookSecrets} webhook secret(s)`);
		} catch (error) {
			destroyKeyFile(staged.path);
			for (const unit of startAgain) host.start(unit);
			throw new RotationError(`re-wrap failed, nothing changed: ${(error as Error).message}`);
		}
	}

	// Switch: the live path always holds a key (copy, then one rename over it).
	copyFileSync(store.path, previous.path);
	chmodSync(previous.path, 0o400);
	renameSync(staged.path, store.path);

	const problem = (() => {
		for (const unit of startAgain) host.start(unit);
		if (startAgain.length && !host.healthy()) return 'the control plane did not become ready with the new key';
		let served: string;
		try {
			served = read(store);
		} catch (error) {
			return (error as Error).message;
		}
		if (served !== newKey) return `${store.path} does not hold the new key`;
		if (!opens(options.dbPath, served)) return 'the database does not open with the new key';
		return null;
	})();

	if (problem) {
		host.log(`verification failed (${problem}); rolling back to the old key`);
		for (const unit of CONTROL_UNITS) if (host.isActive(unit)) host.stop(unit);
		const oldKey = read(previous);
		try {
			withDb(options.dbPath, (db) => rewrapDatabase(db, keyBytes(newKey), keyBytes(oldKey)));
		} catch (error) {
			throw new RotationError(
				`${problem}; rolling the database back also failed (${(error as Error).message}). ` +
					`Both keys are kept: new ${store.path}, old ${previous.path}. See docs/OPS.md §11.`,
			);
		}
		renameSync(previous.path, store.path);
		for (const unit of startAgain) host.start(unit);
		throw new RotationError(`${problem}; rolled back, the old key is in use again`);
	}

	destroyKeyFile(previous.path);
	host.log(`verified; destroyed the old key file ${previous.path}`);
	return { status: 'rotated', store, counts: found, snapshot, resumed: !!resumeKey };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: skiff-rotate-master-key [--dry-run] [--yes]

Replaces the master key and re-wraps every organisation data key and webhook secret with it in
one transaction. The control plane restarts once; sites keep serving.

  --dry-run  check that the current key opens every wrapped value and print the plan
  --yes      do not ask for confirmation
`;

function systemctl(args: string[]): { code: number; stderr: string } {
	const result = Bun.spawnSync({ cmd: ['systemctl', ...args], stdout: 'ignore', stderr: 'pipe' });
	return { code: result.exitCode ?? 1, stderr: new TextDecoder().decode(result.stderr).trim() };
}

function controlPlaneReady(socket: string, timeoutSeconds: number): boolean {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const result = Bun.spawnSync({
			cmd: ['curl', '-fsS', '--max-time', '5', '--unix-socket', socket, '-H', 'Host: localhost', 'http://localhost/readyz'],
			stdout: 'ignore',
			stderr: 'ignore',
		});
		if (result.exitCode === 0) return true;
		Bun.sleepSync(1000);
	}
	return false;
}

async function ask(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	process.stdout.write(`${question}\nType "rotate" to continue: `);
	for await (const line of console) return line.trim() === 'rotate';
	return false;
}

export async function main(argv: string[]): Promise<number> {
	const flags = new Set(argv);
	if (flags.has('-h') || flags.has('--help')) {
		process.stdout.write(USAGE);
		return 0;
	}
	for (const flag of flags) {
		if (flag !== '--dry-run' && flag !== '--yes' && flag !== '-y') {
			process.stderr.write(`unknown argument '${flag}'\n\n${USAGE}`);
			return 2;
		}
	}
	if (process.getuid?.() !== 0 && !flags.has('--dry-run')) {
		process.stderr.write('skiff-rotate-master-key: error: run as root\n');
		return 1;
	}
	const etc = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
	const env = readEnvFile(process.env.SKIFF_ENV_FILE ?? join(etc, 'skiff.env'));
	const dataDir = env.get('SKIFF_DATA_DIR') || '/var/lib/skiff/data';
	const dbPath = join(dataDir, 'skiff.db');
	const socket = join(process.env.SKIFF_RUN_DIR ?? '/run/skiff', 'control.sock');
	const host: RotateHost = {
		log: (message) => console.log(`  • ${message}`),
		isActive: (unit) => systemctl(['is-active', '--quiet', unit]).code === 0,
		stop: (unit) => {
			const result = systemctl(['stop', unit]);
			if (result.code !== 0) throw new RotationError(`systemctl stop ${unit}: ${result.stderr}`);
		},
		start: (unit) => void systemctl(['start', unit]),
		healthy: () => controlPlaneReady(socket, Number(process.env.SKIFF_HEALTH_TIMEOUT ?? 90)),
		confirm: ask,
	};
	try {
		const result = await rotateMasterKey(
			{
				plainPath: process.env.SKIFF_MASTER_KEY_PATH ?? join(etc, 'master.key'),
				dbPath,
				backupsDir: join(dirname(dataDir), 'backups'),
				dryRun: flags.has('--dry-run'),
				yes: flags.has('--yes') || flags.has('-y'),
			},
			host,
		);
		if (result.status === 'dry-run') {
			console.log('\nDry run: nothing changed.');
			return 0;
		}
		console.log(
			[
				'',
				`Master key rotated (${result.store.path}).`,
				'',
				'Next:',
				'  1. Export a new recovery kit now; the old kit no longer matches this host:',
				'       sudo skiff-recovery-kit export --include-env',
				'  2. Keep the previous kit (it holds the old key) until Litestream snapshots and',
				`     ${result.snapshot ? `${result.snapshot} and ` : ''}pre-update bundles from before today have aged out.`,
				'  3. Storage instances with bucket event rules get a new notification token and restart',
				'     once on the next reconcile.',
				'',
			].join('\n'),
		);
		return 0;
	} catch (error) {
		process.stderr.write(`skiff-rotate-master-key: error: ${(error as Error).message}\n`);
		return 1;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
