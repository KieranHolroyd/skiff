import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCredsBinary } from './fake-systemd-creds.ts';
import {
	credentialDirective,
	credentialDirectiveFor,
	defaultCredsRunner,
	destroyKeyFile,
	detectCredsSupport,
	ensureMasterKey,
	finishMasterKeyMigration,
	generateMasterKey,
	locateMasterKey,
	migrationBackupFor,
	planMasterKey,
	readMasterKey,
	revertMasterKeyMigration,
	sealedPathFor,
	sealMasterKey,
	unsealMasterKey,
	writeMasterKey,
	type MasterKeyAction,
} from './master-key.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-master-key-'));
let counter = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh /etc/yoal stand-in plus a fake systemd-creds configured with `env`. */
function host(env: Record<string, string> = {}) {
	const dir = join(root, `host-${++counter}`);
	mkdirSync(dir, { recursive: true });
	const log = join(dir, 'creds.log');
	const bin = fakeCredsBinary(dir, { FAKE_CREDS_LOG: log, ...env });
	const plainPath = join(dir, 'master.key');
	return {
		dir,
		bin,
		plainPath,
		sealedPath: sealedPathFor(plainPath),
		/** argv of every fake systemd-creds call. */
		calls: (): string[][] =>
			existsSync(log)
				? readFileSync(log, 'utf8')
						.trim()
						.split('\n')
						.map((line) => JSON.parse(line) as string[])
				: [],
	};
}

const missingBin = join(root, 'no-such-systemd-creds');
const mode = (path: string) => statSync(path).mode & 0o777;

describe('stores and directives', () => {
	test('the sealed store wins when both exist', () => {
		const files = new Set<string>();
		const exists = (path: string) => files.has(path);
		expect(locateMasterKey('/etc/yoal/master.key', exists)).toBeNull();
		files.add('/etc/yoal/master.key');
		expect(locateMasterKey('/etc/yoal/master.key', exists)).toEqual({ kind: 'plain', path: '/etc/yoal/master.key' });
		files.add('/etc/yoal/master.key.cred');
		expect(locateMasterKey('/etc/yoal/master.key', exists)).toEqual({ kind: 'sealed', path: '/etc/yoal/master.key.cred' });
	});

	test('unit directives', () => {
		expect(credentialDirective({ kind: 'sealed', path: '/etc/yoal/master.key.cred' })).toBe(
			'LoadCredentialEncrypted=master-key:/etc/yoal/master.key.cred',
		);
		expect(credentialDirective({ kind: 'plain', path: '/etc/yoal/master.key' })).toBe('LoadCredential=master-key:/etc/yoal/master.key');
		// An old stage-0 passes the plain path; a sealed file beside it switches to the encrypted form.
		expect(credentialDirectiveFor('/etc/yoal/master.key', () => false)).toBe('LoadCredential=master-key:/etc/yoal/master.key');
		expect(credentialDirectiveFor('/etc/yoal/master.key', (path) => path.endsWith('.cred'))).toBe(
			'LoadCredentialEncrypted=master-key:/etc/yoal/master.key.cred',
		);
		expect(credentialDirectiveFor('/x/master.key.cred', () => false)).toBe('LoadCredentialEncrypted=master-key:/x/master.key.cred');
	});

	test('generated keys are 32 random bytes in base64', () => {
		const a = generateMasterKey();
		expect(Buffer.from(a, 'base64').byteLength).toBe(32);
		expect(a).not.toBe(generateMasterKey());
	});
});

describe('detectCredsSupport', () => {
	test('missing binary, systemd < 250, host key only, TPM2', () => {
		expect(detectCredsSupport(defaultCredsRunner, missingBin)).toEqual({ available: false, tpm2: false, version: null });
		expect(detectCredsSupport(defaultCredsRunner, host({ FAKE_CREDS_VERSION: '249' }).bin)).toEqual({ available: false, tpm2: false, version: 249 });
		expect(detectCredsSupport(defaultCredsRunner, host().bin)).toEqual({ available: true, tpm2: false, version: 257 });
		expect(detectCredsSupport(defaultCredsRunner, host({ FAKE_CREDS_TPM2: '1' }).bin)).toEqual({ available: true, tpm2: true, version: 257 });
	});
});

describe('sealMasterKey', () => {
	test('a TPM2 host binds to the chip and the host key with no PCR policy', () => {
		const h = host({ FAKE_CREDS_TPM2: '1' });
		const key = generateMasterKey();
		expect(sealMasterKey(key, h.sealedPath, { tpm2: true, bin: h.bin })).toBe('host+tpm2');
		expect(unsealMasterKey(h.sealedPath, defaultCredsRunner, h.bin)).toBe(key);
		expect(readFileSync(h.sealedPath, 'utf8')).toContain('key=host+tpm2');
		expect(mode(h.sealedPath)).toBe(0o400);
		const encrypt = h.calls().find((argv) => argv[0] === 'encrypt')!;
		expect(encrypt).toEqual(['encrypt', '--name=master-key', '--with-key=host+tpm2', '--tpm2-pcrs=', '-', expect.stringContaining('.tmp-')]);
	});

	test('falls back to the host key when the TPM2 refuses', () => {
		const h = host({ FAKE_CREDS_TPM2: '1', FAKE_CREDS_TPM2_FAIL: '1' });
		const key = generateMasterKey();
		expect(sealMasterKey(key, h.sealedPath, { tpm2: true, bin: h.bin })).toBe('host');
		expect(readFileSync(h.sealedPath, 'utf8')).toContain('key=host ');
		expect(unsealMasterKey(h.sealedPath, defaultCredsRunner, h.bin)).toBe(key);
		expect(h.calls().filter((argv) => argv[0] === 'encrypt').map((argv) => argv[2])).toEqual(['--with-key=host+tpm2', '--with-key=host']);
	});

	test('without a TPM2 only the host key is tried, without --tpm2-pcrs', () => {
		const h = host();
		expect(sealMasterKey(generateMasterKey(), h.sealedPath, { tpm2: false, bin: h.bin })).toBe('host');
		const encrypts = h.calls().filter((argv) => argv[0] === 'encrypt');
		expect(encrypts).toHaveLength(1);
		expect(encrypts[0]).not.toContain('--tpm2-pcrs=');
	});

	test('refuses when nothing seals or the round trip differs, leaving no file behind', () => {
		for (const env of [{ FAKE_CREDS_FAIL: '1' }, { FAKE_CREDS_CORRUPT: '1' }] as Array<Record<string, string>>) {
			const h = host(env);
			expect(() => sealMasterKey(generateMasterKey(), h.sealedPath, { tpm2: false, bin: h.bin })).toThrow('could not seal the master key');
			expect(existsSync(h.sealedPath)).toBe(false);
			expect(readdirSync(h.dir).some((name) => name.includes('.tmp-'))).toBe(false);
		}
	});

	test('a sealed key does not open on another host', () => {
		const h = host();
		sealMasterKey(generateMasterKey(), h.sealedPath, { tpm2: false, bin: h.bin });
		const other = fakeCredsBinary(mkdtempSync(join(root, 'other-')), { FAKE_CREDS_HOST: 'host-b' });
		expect(() => unsealMasterKey(h.sealedPath, defaultCredsRunner, other)).toThrow('could not decrypt');
	});

	test('writeMasterKey and readMasterKey for both stores', () => {
		const h = host();
		const key = generateMasterKey();
		expect(writeMasterKey({ kind: 'plain', path: h.plainPath }, key, { tpm2: false, bin: h.bin })).toBe('plain');
		expect(readFileSync(h.plainPath, 'utf8')).toBe(`${key}\n`);
		expect(mode(h.plainPath)).toBe(0o400);
		expect(readMasterKey({ kind: 'plain', path: h.plainPath })).toBe(key);
		expect(writeMasterKey({ kind: 'sealed', path: h.sealedPath }, key, { tpm2: false, bin: h.bin })).toBe('host');
		expect(readMasterKey({ kind: 'sealed', path: h.sealedPath }, defaultCredsRunner, h.bin)).toBe(key);
	});
});

describe('planMasterKey', () => {
	test('every combination', () => {
		const cases: Array<[{ sealed: boolean; plain: boolean; credsAvailable: boolean }, MasterKeyAction]> = [
			[{ sealed: true, plain: false, credsAvailable: true }, 'keep-sealed'],
			[{ sealed: true, plain: true, credsAvailable: true }, 'keep-sealed'],
			[{ sealed: true, plain: false, credsAvailable: false }, 'keep-sealed'],
			[{ sealed: false, plain: true, credsAvailable: true }, 'seal-existing'],
			[{ sealed: false, plain: true, credsAvailable: false }, 'keep-plain'],
			[{ sealed: false, plain: false, credsAvailable: true }, 'create-sealed'],
			[{ sealed: false, plain: false, credsAvailable: false }, 'create-plain'],
		];
		for (const [input, action] of cases) expect(planMasterKey(input)).toBe(action);
	});
});

describe('ensureMasterKey', () => {
	test('create-sealed: a new host never has the plaintext on disk', () => {
		const h = host({ FAKE_CREDS_TPM2: '1' });
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin });
		expect(result).toMatchObject({ action: 'create-sealed', store: { kind: 'sealed', path: h.sealedPath }, binding: 'host+tpm2', backup: null });
		expect(existsSync(h.plainPath)).toBe(false);
		expect(unsealMasterKey(h.sealedPath, defaultCredsRunner, h.bin)).toBe(result.key);
	});

	test('create-sealed falls back to a plaintext file when sealing fails', () => {
		const h = host({ FAKE_CREDS_FAIL: '1' });
		const logs: string[] = [];
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin, log: (line) => logs.push(line) });
		expect(result).toMatchObject({ action: 'create-plain', store: { kind: 'plain' }, binding: 'plain' });
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(result.key);
		expect(existsSync(h.sealedPath)).toBe(false);
		expect(logs.join('\n')).toContain('root-only file');
	});

	test('create-plain without systemd-creds', () => {
		const h = host();
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: missingBin, log: () => {} });
		expect(result).toMatchObject({ action: 'create-plain', binding: 'plain' });
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(result.key);
		expect(mode(h.plainPath)).toBe(0o400);
	});

	test('keep-plain without systemd-creds (systemd 249) leaves the key alone', () => {
		const h = host({ FAKE_CREDS_VERSION: '249' });
		const key = generateMasterKey();
		writeFileSync(h.plainPath, `${key}\n`, { mode: 0o600 });
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin, log: () => {} });
		expect(result).toMatchObject({ action: 'keep-plain', key, binding: 'plain' });
		expect(mode(h.plainPath)).toBe(0o400);
		expect(existsSync(h.sealedPath)).toBe(false);
	});

	test('seal-existing seals the same key and parks the plaintext; finish destroys it', () => {
		const h = host();
		const key = generateMasterKey();
		writeFileSync(h.plainPath, `${key}\n`, { mode: 0o400 });
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin });
		const backup = migrationBackupFor(h.plainPath);
		expect(result).toMatchObject({ action: 'seal-existing', key, store: { kind: 'sealed' }, binding: 'host', backup });
		expect(existsSync(h.plainPath)).toBe(false);
		expect(readFileSync(backup, 'utf8').trim()).toBe(key);
		expect(unsealMasterKey(h.sealedPath, defaultCredsRunner, h.bin)).toBe(key);

		// A different key in the backup is never deleted.
		expect(finishMasterKeyMigration(h.plainPath, generateMasterKey())).toBeNull();
		expect(existsSync(backup)).toBe(true);
		expect(finishMasterKeyMigration(h.plainPath, key)).toBe(backup);
		expect(existsSync(backup)).toBe(false);
		expect(finishMasterKeyMigration(h.plainPath, key)).toBeNull();

		// The next run keeps the sealed key.
		const again = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin });
		expect(again).toMatchObject({ action: 'keep-sealed', key, binding: null, backup: null });
	});

	test('seal-existing then revert puts the plaintext back and drops the sealed file', () => {
		const h = host();
		const key = generateMasterKey();
		writeFileSync(h.plainPath, `${key}\n`, { mode: 0o400 });
		ensureMasterKey({ plainPath: h.plainPath, bin: h.bin });
		expect(revertMasterKeyMigration(h.plainPath)).toBe(true);
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(key);
		expect(existsSync(h.sealedPath)).toBe(false);
		expect(existsSync(migrationBackupFor(h.plainPath))).toBe(false);
		// Nothing to revert the second time (and nothing to finish).
		expect(revertMasterKeyMigration(h.plainPath)).toBe(false);
		expect(finishMasterKeyMigration(h.plainPath, key)).toBeNull();
	});

	test('seal-existing keeps the plaintext store when sealing fails', () => {
		const h = host({ FAKE_CREDS_FAIL: '1' });
		const key = generateMasterKey();
		writeFileSync(h.plainPath, `${key}\n`, { mode: 0o400 });
		const result = ensureMasterKey({ plainPath: h.plainPath, bin: h.bin, log: () => {} });
		expect(result).toMatchObject({ action: 'keep-plain', key, store: { kind: 'plain', path: h.plainPath }, backup: null });
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(key);
		expect(existsSync(h.sealedPath)).toBe(false);
		expect(existsSync(migrationBackupFor(h.plainPath))).toBe(false);
	});

	test('dry runs change nothing', () => {
		const empty = host();
		expect(ensureMasterKey({ plainPath: empty.plainPath, bin: empty.bin, dryRun: true })).toMatchObject({ action: 'create-sealed', key: '' });
		expect(ensureMasterKey({ plainPath: empty.plainPath, bin: missingBin, dryRun: true, log: () => {} })).toMatchObject({ action: 'create-plain', key: '' });
		expect(existsSync(empty.plainPath) || existsSync(empty.sealedPath)).toBe(false);

		const plain = host();
		const key = generateMasterKey();
		writeFileSync(plain.plainPath, `${key}\n`, { mode: 0o400 });
		const logs: string[] = [];
		expect(ensureMasterKey({ plainPath: plain.plainPath, bin: plain.bin, dryRun: true, log: (line) => logs.push(line) })).toMatchObject({
			action: 'seal-existing',
			key,
			store: { kind: 'plain' },
		});
		expect(logs[0]).toContain('would seal');
		expect(existsSync(plain.sealedPath)).toBe(false);
		expect(existsSync(migrationBackupFor(plain.plainPath))).toBe(false);
	});

	test('keep-sealed explains how to recover when the key does not open here', () => {
		const h = host();
		sealMasterKey(generateMasterKey(), h.sealedPath, { tpm2: false, bin: h.bin });
		const rebuilt = fakeCredsBinary(mkdtempSync(join(root, 'rebuilt-')), { FAKE_CREDS_HOST: 'host-b' });
		expect(() => ensureMasterKey({ plainPath: h.plainPath, bin: rebuilt })).toThrow('yoal-recovery-kit import');
	});

	test('keep-sealed warns about a stray plaintext file beside it', () => {
		const h = host();
		const key = generateMasterKey();
		sealMasterKey(key, h.sealedPath, { tpm2: false, bin: h.bin });
		writeFileSync(h.plainPath, `${generateMasterKey()}\n`);
		const logs: string[] = [];
		expect(ensureMasterKey({ plainPath: h.plainPath, bin: h.bin, log: (line) => logs.push(line) }).key).toBe(key);
		expect(logs.join('\n')).toContain('the sealed key is in use');
	});
});

describe('destroyKeyFile', () => {
	test('overwrites and unlinks; a missing file is fine', () => {
		const h = host();
		writeFileSync(h.plainPath, 'secret\n', { mode: 0o400 });
		destroyKeyFile(h.plainPath);
		expect(existsSync(h.plainPath)).toBe(false);
		expect(() => destroyKeyFile(h.plainPath)).not.toThrow();
	});
});
