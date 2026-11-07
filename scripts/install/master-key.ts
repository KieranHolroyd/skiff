/**
 * Where the master key (D18, the KEK that wraps every org data key) lives on a control-plane host,
 * and how it gets there. Shared by the installer, `skiff-recovery-kit`, `skiff-rotate-master-key`,
 * the update canary and the control-plane unit drop-ins.
 *
 * Two stores, the sealed one preferred:
 *
 *   /etc/skiff/master.key.cred  `systemd-creds encrypt --name=master-key` output, bound to the
 *                               TPM2 chip (no PCR policy) plus the host key when the machine has a
 *                               TPM2, the host key (/var/lib/systemd/credential.secret) otherwise.
 *                               The control plane gets it via `LoadCredentialEncrypted=` (a unit
 *                               drop-in, see systemd/control-plane.ts).
 *   /etc/skiff/master.key       root 0400 plaintext, loaded with `LoadCredential=`. Only used when
 *                               systemd-creds is unavailable (systemd < 250).
 *
 * Either way the service reads the plaintext from `%d/master-key`; nothing else changes for it.
 * The sealed file cannot be read off another machine, which is why the recovery kit (plaintext key,
 * age-encrypted with a passphrase) is the only way back after losing the host.
 */
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Credential id: the file the service reads is `%d/master-key`. */
export const MASTER_KEY_CREDENTIAL = 'master-key';

/** The sealed store sits next to the plain path with a `.cred` suffix. */
export function sealedPathFor(plainPath: string): string {
	return `${plainPath}.cred`;
}

/** Where a migration parks the old plaintext file until the sealed key has served once. */
export function migrationBackupFor(plainPath: string): string {
	return `${plainPath}.pre-seal`;
}

export type MasterKeyStore = { kind: 'sealed'; path: string } | { kind: 'plain'; path: string };

/** The store in force: the sealed file wins when both exist. Null when neither does. */
export function locateMasterKey(plainPath: string, exists: (path: string) => boolean = existsSync): MasterKeyStore | null {
	const sealed = sealedPathFor(plainPath);
	if (exists(sealed)) return { kind: 'sealed', path: sealed };
	if (exists(plainPath)) return { kind: 'plain', path: plainPath };
	return null;
}

/** The unit directive that hands `store` to a service as the `master-key` credential. */
export function credentialDirective(store: MasterKeyStore): string {
	return store.kind === 'sealed'
		? `LoadCredentialEncrypted=${MASTER_KEY_CREDENTIAL}:${store.path}`
		: `LoadCredential=${MASTER_KEY_CREDENTIAL}:${store.path}`;
}

/**
 * Directive for a caller that only knows the plain path (old stage-0 updaters pass
 * `/etc/skiff/master.key` to the canary hook): a `.cred` path, or a sealed file beside the plain
 * one, means `LoadCredentialEncrypted=`.
 */
export function credentialDirectiveFor(path: string, exists: (path: string) => boolean = existsSync): string {
	if (path.endsWith('.cred')) return credentialDirective({ kind: 'sealed', path });
	return credentialDirective(locateMasterKey(path, exists) ?? { kind: 'plain', path });
}

// ---------------------------------------------------------------------------------------------
// systemd-creds
// ---------------------------------------------------------------------------------------------

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}
/** Runs a command, feeding `stdin` when given. Never throws on a non-zero exit. */
export type CredsRunner = (cmd: string[], stdin?: string) => CommandResult;

/** Tests point this at a fake; production uses the system binary. */
export function systemdCredsBin(env: Record<string, string | undefined> = process.env): string {
	return env.SKIFF_SYSTEMD_CREDS || 'systemd-creds';
}

export const defaultCredsRunner: CredsRunner = (cmd, stdin) => {
	try {
		const result = Bun.spawnSync({
			cmd,
			stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			code: result.exitCode ?? 1,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr).trim(),
		};
	} catch (error) {
		// ENOENT: the binary does not exist (systemd too old, or not a systemd host).
		return { code: 127, stdout: '', stderr: (error as Error).message };
	}
};

export interface CredsSupport {
	available: boolean;
	tpm2: boolean;
	/** systemd major version, when `systemd-creds --version` printed one. */
	version: number | null;
}

/** First systemd release with `systemd-creds` and `LoadCredentialEncrypted=`. */
export const MIN_SYSTEMD_CREDS_VERSION = 250;

export function detectCredsSupport(run: CredsRunner = defaultCredsRunner, bin = systemdCredsBin()): CredsSupport {
	const version = run([bin, '--version']);
	if (version.code !== 0) return { available: false, tpm2: false, version: null };
	const major = Number(/systemd\s+(\d+)/.exec(version.stdout)?.[1] ?? NaN);
	if (Number.isFinite(major) && major < MIN_SYSTEMD_CREDS_VERSION) return { available: false, tpm2: false, version: major };
	// Exit 0 only when firmware, driver, kernel and userspace all support TPM2 ("partial" is not enough).
	const tpm2 = run([bin, 'has-tpm2']).code === 0;
	return { available: true, tpm2, version: Number.isFinite(major) ? major : null };
}

export type SealBinding = 'host+tpm2' | 'host';

/** Read a sealed master key (root only). Throws with systemd-creds' own reason. */
export function unsealMasterKey(path: string, run: CredsRunner = defaultCredsRunner, bin = systemdCredsBin()): string {
	const result = run([bin, 'decrypt', `--name=${MASTER_KEY_CREDENTIAL}`, path, '-']);
	if (result.code !== 0) throw new Error(`systemd-creds could not decrypt ${path}: ${result.stderr || `exit ${result.code}`}`);
	const key = result.stdout.trim();
	if (!key) throw new Error(`${path} decrypted to an empty key`);
	return key;
}

function setRootOnly(path: string, mode = 0o400): void {
	chmodSync(path, mode);
	if (process.getuid?.() === 0) chownSync(path, 0, 0);
}

/**
 * Seal `key` into `dest` atomically. A TPM2 host binds to the chip with no PCR policy, so a
 * firmware or Secure Boot update cannot lock the control plane out; if that fails the host key
 * alone is used. Every candidate is decrypted again before it replaces anything.
 */
export function sealMasterKey(
	key: string,
	dest: string,
	options: { tpm2: boolean; run?: CredsRunner; bin?: string },
): SealBinding {
	const run = options.run ?? defaultCredsRunner;
	const bin = options.bin ?? systemdCredsBin();
	const candidates: SealBinding[] = options.tpm2 ? ['host+tpm2', 'host'] : ['host'];
	const errors: string[] = [];
	const tmp = `${dest}.tmp-${process.pid}`;
	for (const binding of candidates) {
		rmSync(tmp, { force: true });
		const args = [bin, 'encrypt', `--name=${MASTER_KEY_CREDENTIAL}`, `--with-key=${binding}`];
		if (binding.includes('tpm2')) args.push('--tpm2-pcrs=');
		const result = run([...args, '-', tmp], `${key.trim()}\n`);
		if (result.code !== 0 || !existsSync(tmp)) {
			errors.push(`${binding}: ${result.stderr || `exit ${result.code}`}`);
			continue;
		}
		try {
			if (unsealMasterKey(tmp, run, bin) !== key.trim()) throw new Error('round trip returned a different key');
		} catch (error) {
			errors.push(`${binding}: ${(error as Error).message}`);
			continue;
		}
		setRootOnly(tmp);
		renameSync(tmp, dest);
		return binding;
	}
	rmSync(tmp, { force: true });
	throw new Error(`systemd-creds could not seal the master key (${errors.join('; ')})`);
}

/** Atomic root-only plaintext write (the fallback store). */
export function writePlainMasterKey(path: string, key: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, `${key.trim()}\n`, { mode: 0o400 });
	setRootOnly(tmp);
	renameSync(tmp, path);
}

/** Write `key` into a store of the given kind (sealing with `support` when sealed). */
export function writeMasterKey(
	store: MasterKeyStore,
	key: string,
	options: { tpm2: boolean; run?: CredsRunner; bin?: string },
): SealBinding | 'plain' {
	if (store.kind === 'plain') {
		writePlainMasterKey(store.path, key);
		return 'plain';
	}
	return sealMasterKey(key, store.path, options);
}

/** The plaintext key behind a store. */
export function readMasterKey(store: MasterKeyStore, run: CredsRunner = defaultCredsRunner, bin = systemdCredsBin()): string {
	if (store.kind === 'sealed') return unsealMasterKey(store.path, run, bin);
	const key = readFileSync(store.path, 'utf8').trim();
	if (!key) throw new Error(`${store.path} is empty`);
	return key;
}

/** 32 random bytes, base64: what the control plane expects in `%d/master-key`. */
export function generateMasterKey(): string {
	return randomBytes(32).toString('base64');
}

/**
 * Best-effort destruction of a key file: overwrite with random bytes, then unlink. Journaling
 * filesystems may keep old blocks; this only stops the file from lingering in plain sight.
 */
export function destroyKeyFile(path: string): void {
	if (!existsSync(path)) return;
	try {
		chmodSync(path, 0o600);
		writeFileSync(path, randomBytes(Math.max(64, statSync(path).size)));
	} catch {
		// Unlink anyway.
	}
	rmSync(path, { force: true });
}

// ---------------------------------------------------------------------------------------------
// Installer: ensure / migrate / revert
// ---------------------------------------------------------------------------------------------

export type MasterKeyAction =
	| 'keep-sealed' // .cred exists: use it
	| 'seal-existing' // plaintext only + systemd-creds: seal it, keep the plaintext as a backup until the service starts
	| 'create-sealed' // nothing yet + systemd-creds: generate and seal (no plaintext ever on disk)
	| 'keep-plain' // plaintext only, no systemd-creds
	| 'create-plain'; // nothing yet, no systemd-creds

export function planMasterKey(input: { sealed: boolean; plain: boolean; credsAvailable: boolean }): MasterKeyAction {
	if (input.sealed) return 'keep-sealed';
	if (input.plain) return input.credsAvailable ? 'seal-existing' : 'keep-plain';
	return input.credsAvailable ? 'create-sealed' : 'create-plain';
}

export interface EnsureMasterKeyInput {
	/** `/etc/skiff/master.key`. */
	plainPath: string;
	run?: CredsRunner;
	bin?: string;
	dryRun?: boolean;
	log?: (message: string) => void;
	/** Override detection (tests). */
	support?: CredsSupport;
}

export interface EnsureMasterKeyResult {
	action: MasterKeyAction;
	/** The plaintext key (callers that need it in-process, e.g. node enrolment). Empty on a dry run that would create one. */
	key: string;
	store: MasterKeyStore;
	binding: SealBinding | 'plain' | null;
	/** Plaintext kept by `seal-existing` until the sealed key has served once. */
	backup: string | null;
}

/**
 * Make sure a master key exists, sealed with systemd-creds when the host can. An existing key is
 * never replaced: a migration seals the same bytes and proves the round trip before it moves the
 * plaintext aside (`master.key.pre-seal`, removed by `finishMasterKeyMigration` once the service
 * starts, put back by `revertMasterKeyMigration` if the install fails).
 */
export function ensureMasterKey(input: EnsureMasterKeyInput): EnsureMasterKeyResult {
	const run = input.run ?? defaultCredsRunner;
	const bin = input.bin ?? systemdCredsBin();
	const log = input.log ?? (() => {});
	const sealedPath = sealedPathFor(input.plainPath);
	const sealedExists = existsSync(sealedPath);
	const plainExists = existsSync(input.plainPath);
	const support = input.support ?? (sealedExists ? { available: true, tpm2: false, version: null } : detectCredsSupport(run, bin));
	const action = planMasterKey({ sealed: sealedExists, plain: plainExists, credsAvailable: support.available });
	const sealedStore: MasterKeyStore = { kind: 'sealed', path: sealedPath };
	const plainStore: MasterKeyStore = { kind: 'plain', path: input.plainPath };
	const binding = support.tpm2 ? 'TPM2 + host key' : 'host key';

	switch (action) {
		case 'keep-sealed': {
			let key: string;
			try {
				key = unsealMasterKey(sealedPath, run, bin);
			} catch (error) {
				throw new Error(
					`${(error as Error).message}. The sealed master key only opens on the machine that sealed it; ` +
						'if this host was rebuilt or its TPM was reset, import the recovery kit (skiff-recovery-kit import <kit> --force).',
				);
			}
			if (plainExists) log(`warning: ${input.plainPath} exists beside ${sealedPath}; the sealed key is in use`);
			log(`master key: sealed with systemd-creds (${sealedPath})`);
			return { action, key, store: sealedStore, binding: null, backup: null };
		}
		case 'seal-existing': {
			const key = readMasterKey(plainStore);
			if (input.dryRun) {
				log(`would seal ${input.plainPath} with systemd-creds (${binding}) into ${sealedPath} and keep the plaintext until the control plane starts`);
				return { action, key, store: plainStore, binding: null, backup: null };
			}
			let sealedWith: SealBinding;
			try {
				sealedWith = sealMasterKey(key, sealedPath, { tpm2: support.tpm2, run, bin });
			} catch (error) {
				log(`warning: ${(error as Error).message}; the master key stays a root-only file at ${input.plainPath}`);
				return { action: 'keep-plain', key, store: plainStore, binding: 'plain', backup: null };
			}
			const backup = migrationBackupFor(input.plainPath);
			rmSync(backup, { force: true });
			renameSync(input.plainPath, backup);
			log(`master key: sealed with systemd-creds (${sealedWith}) into ${sealedPath}; plaintext kept at ${backup} until the control plane starts`);
			return { action, key, store: sealedStore, binding: sealedWith, backup };
		}
		case 'create-sealed': {
			if (input.dryRun) {
				log(`would generate a master key sealed with systemd-creds (${binding}) at ${sealedPath}`);
				return { action, key: '', store: sealedStore, binding: null, backup: null };
			}
			const key = generateMasterKey();
			let sealedWith: SealBinding;
			try {
				sealedWith = sealMasterKey(key, sealedPath, { tpm2: support.tpm2, run, bin });
			} catch (error) {
				log(`warning: ${(error as Error).message}; writing the master key as a root-only file at ${input.plainPath}`);
				writePlainMasterKey(input.plainPath, key);
				return { action: 'create-plain', key, store: plainStore, binding: 'plain', backup: null };
			}
			log(`master key: generated and sealed with systemd-creds (${sealedWith}) at ${sealedPath}`);
			return { action, key, store: sealedStore, binding: sealedWith, backup: null };
		}
		case 'keep-plain': {
			log(`warning: systemd-creds is unavailable (needs systemd ${MIN_SYSTEMD_CREDS_VERSION}+); the master key stays a root-only file at ${input.plainPath}`);
			const key = readMasterKey(plainStore);
			if (!input.dryRun) {
				chmodSync(input.plainPath, 0o400);
				if (process.getuid?.() === 0) chownSync(input.plainPath, 0, 0);
			}
			return { action, key, store: plainStore, binding: 'plain', backup: null };
		}
		case 'create-plain': {
			log(`warning: systemd-creds is unavailable (needs systemd ${MIN_SYSTEMD_CREDS_VERSION}+); writing the master key as a root-only file at ${input.plainPath}`);
			if (input.dryRun) return { action, key: '', store: plainStore, binding: null, backup: null };
			const key = generateMasterKey();
			writePlainMasterKey(input.plainPath, key);
			return { action, key, store: plainStore, binding: 'plain', backup: null };
		}
	}
}

/**
 * After the control plane served with the sealed key: drop the plaintext a migration kept. Also
 * removes one left by an interrupted earlier run, but only when it holds the same key.
 */
export function finishMasterKeyMigration(plainPath: string, key: string): string | null {
	const backup = migrationBackupFor(plainPath);
	if (!existsSync(backup) || !existsSync(sealedPathFor(plainPath))) return null;
	if (readFileSync(backup, 'utf8').trim() !== key.trim()) return null;
	destroyKeyFile(backup);
	return backup;
}

/** Undo `seal-existing`: the plaintext goes back and the sealed file goes away. */
export function revertMasterKeyMigration(plainPath: string): boolean {
	const backup = migrationBackupFor(plainPath);
	if (!existsSync(backup)) return false;
	renameSync(backup, plainPath);
	rmSync(sealedPathFor(plainPath), { force: true });
	return true;
}
