import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ageDecrypt,
	ageEncrypt,
	armor,
	buildKit,
	chachaPolyOpen,
	chachaPolySeal,
	decryptKit,
	dearmor,
	encryptKit,
	fingerprint,
	generatePassphrase,
} from './recovery-kit.ts';
import { fakeCredsBinary } from './install/fake-systemd-creds.ts';
import { defaultCredsRunner, sealMasterKey, unsealMasterKey } from './install/master-key.ts';

const WF = 10; // low scrypt work factor keeps tests fast; production uses 18

describe('ChaCha20-Poly1305 (RFC 8439)', () => {
	test('§2.8.2 AEAD test vector', () => {
		const key = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
		const nonce = Uint8Array.from([7, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
		const aad = Uint8Array.from([0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7]);
		const pt = new TextEncoder().encode(
			"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
		);
		const sealed = Buffer.from(chachaPolySeal(key, nonce, pt, aad));
		expect(sealed.subarray(0, 16).toString('hex')).toBe('d31a8d34648e60db7b86afbc53ef7ec2');
		expect(sealed.subarray(sealed.length - 16).toString('hex')).toBe('1ae10b594f09e26a7e902ecbd0600691');
		expect(Buffer.from(chachaPolyOpen(key, nonce, sealed, aad)!).toString()).toBe(Buffer.from(pt).toString());
		sealed[3]! ^= 1;
		expect(chachaPolyOpen(key, nonce, sealed, aad)).toBeNull();
	});
});

describe('age (scrypt recipient)', () => {
	// Produced by the reference JS implementation (age-encryption / typage) with work factor 10.
	const TYPAGE_FIXTURE = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCB4MU1jUWR0eUN6ZEdOUmkx
aDlyZXdBIDEwCmFwT3NXTkpnLzdMbUc3WWhPa212ZlV2bDRvSFRUSWFQZytBWmVL
TU8vSVUKLS0tIHJXcTJUSDlyZmJEemV6V0VIRUkxbzlINXBIMzV2Ri9ScDFOSXJo
TnVENFUK+t4NhaB+tkRYS/ceSTwSeoAL7vJNowG+B6U10XZvTvBHX8oFdF+xwQpS
JaAw0LMtaQL1Tv0DTRg=
-----END AGE ENCRYPTED FILE-----
`;

	test('decrypts a file written by the reference implementation', () => {
		expect(Buffer.from(ageDecrypt(TYPAGE_FIXTURE, 'yoal fixture passphrase')).toString()).toBe('{"hello":"from typage"}\n');
		expect(() => ageDecrypt(TYPAGE_FIXTURE, 'wrong passphrase')).toThrow(/wrong passphrase/);
	});

	test('round-trips across chunk boundaries, binary and armored', () => {
		for (const size of [0, 1, 65_535, 65_536, 65_537, 140_000]) {
			const pt = new Uint8Array(size).map((_, i) => i * 7);
			const file = ageEncrypt(pt, 'a long enough passphrase', WF);
			expect(Buffer.from(file.subarray(0, 21)).toString()).toBe('age-encryption.org/v1');
			expect(Buffer.compare(Buffer.from(ageDecrypt(file, 'a long enough passphrase')), Buffer.from(pt))).toBe(0);
			expect(Buffer.compare(Buffer.from(ageDecrypt(armor(file), 'a long enough passphrase')), Buffer.from(pt))).toBe(0);
		}
	});

	test('detects tampering with the header and the payload', () => {
		const file = ageEncrypt(new TextEncoder().encode('secret'), 'a long enough passphrase', WF);
		const header = Buffer.from(file);
		const macAt = header.indexOf('\n--- ') + 6;
		header[macAt] = header[macAt] === 0x41 ? 0x42 : 0x41;
		expect(() => ageDecrypt(header, 'a long enough passphrase')).toThrow();
		const payload = Buffer.from(file);
		payload[payload.length - 1]! ^= 1;
		expect(() => ageDecrypt(payload, 'a long enough passphrase')).toThrow(/authentication failed/);
		expect(() => ageDecrypt(file.subarray(0, file.length - 20), 'a long enough passphrase')).toThrow();
	});

	test('rejects malformed armor and excessive work factors', () => {
		expect(() => dearmor('-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END NOPE-----')).toThrow();
		const forged = Buffer.from(ageEncrypt(new Uint8Array(1), 'a long enough passphrase', WF))
			.toString('latin1')
			.replace(/ 10\n/, ' 30\n');
		expect(() => ageDecrypt(Buffer.from(forged, 'latin1'), 'a long enough passphrase')).toThrow(/too large/);
	});
});

describe('kit format', () => {
	const env = 'YOAL_PLATFORM_ORIGIN=https://control.example.com\nR2_BUCKET=b\nYOAL_SMTP_FROM="Yoal <noreply@example.com>"\n';

	test('build, encrypt and decrypt with env', () => {
		const kit = buildKit({ masterKey: 'bWFzdGVy\n', env, host: 'edge', now: new Date('2026-11-03T00:00:00Z') });
		expect(kit.masterKey).toBe('bWFzdGVy');
		expect(kit.platformOrigin).toBe('https://control.example.com');
		expect(kit.fingerprint).toBe(fingerprint('bWFzdGVy'));
		expect(kit.fingerprint).toHaveLength(16);
		const armored = encryptKit(kit, 'a long enough passphrase', WF);
		expect(armored.startsWith('-----BEGIN AGE ENCRYPTED FILE-----\n')).toBe(true);
		expect(armored).not.toContain('bWFzdGVy');
		expect(decryptKit(armored, 'a long enough passphrase')).toEqual(kit);
	});

	test('accepts a kit exported before the Skiff -> Yoal rename', () => {
		const kit = { ...buildKit({ masterKey: 'bWFzdGVy' }), format: 'skiff-recovery-kit' as const };
		const armored = encryptKit(kit, 'pw-pw-pw-pw-pw', WF);
		expect(decryptKit(armored, 'pw-pw-pw-pw-pw').format).toBe('skiff-recovery-kit');
	});

	test('rejects a decrypted file that is not a kit, or whose fingerprint was edited', () => {
		expect(() => decryptKit(armor(ageEncrypt(new TextEncoder().encode('{}'), 'pw-pw-pw-pw-pw', WF)), 'pw-pw-pw-pw-pw')).toThrow(/not a Yoal recovery kit/);
		const kit = { ...buildKit({ masterKey: 'k1' }), fingerprint: '0000000000000000' };
		expect(() => decryptKit(armor(ageEncrypt(Buffer.from(JSON.stringify(kit)), 'pw-pw-pw-pw-pw', WF)), 'pw-pw-pw-pw-pw')).toThrow(/fingerprint/);
	});

	test('generated passphrases are long and well-formed', () => {
		const a = generatePassphrase();
		expect(a).toMatch(/^([a-z2-9]{5}-){7}[a-z2-9]{5}$/);
		expect(generatePassphrase()).not.toBe(a);
	});
});

describe('CLI', () => {
	function setup() {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-kit-'));
		writeFileSync(join(dir, 'master.key'), 'b3JpZ2luYWwta2V5\n', { mode: 0o400 });
		writeFileSync(join(dir, 'yoal.env'), 'YOAL_PLATFORM_ORIGIN=https://control.example.com\nR2_BUCKET=bucket\n');
		writeFileSync(join(dir, 'pass'), 'correct horse battery staple\n');
		const run = (...args: string[]) =>
			spawnSync(process.execPath, [join(import.meta.dir, 'recovery-kit.ts'), ...args, '--passphrase-file', join(dir, 'pass'), '--work-factor', String(WF)], {
				env: { ...process.env, YOAL_ETC_DIR: dir, YOAL_RECOVERY_PASSPHRASE_FILE: '' },
				encoding: 'utf8',
			});
		return { dir, run };
	}

	test('export → verify → import onto a host with a different key', () => {
		const { dir, run } = setup();
		const kitPath = join(dir, 'kit.age');
		const exported = run('export', '--out', kitPath, '--include-env');
		expect(exported.status).toBe(0);
		expect(exported.stdout).toContain(fingerprint('b3JpZ2luYWwta2V5'));
		expect(exported.stdout).not.toContain('b3JpZ2luYWwta2V5');
		expect(statSync(kitPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(kitPath, 'utf8')).not.toContain('bucket');

		expect(run('verify', kitPath).status).toBe(0);

		// A fresh install generated a different key: import must refuse without --force.
		rmSync(join(dir, 'master.key'));
		writeFileSync(join(dir, 'master.key'), 'ZnJlc2gta2V5\n', { mode: 0o400 });
		writeFileSync(join(dir, 'yoal.env'), 'R2_BUCKET=other\n');
		const mismatch = run('verify', kitPath);
		expect(mismatch.status).toBe(1);
		expect(mismatch.stderr).toContain('fingerprint is');
		const refused = run('import', kitPath);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('--force');

		const imported = run('import', kitPath, '--force', '--restore-env');
		expect(imported.status).toBe(0);
		expect(readFileSync(join(dir, 'master.key'), 'utf8')).toBe('b3JpZ2luYWwta2V5\n');
		expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o400);
		expect(readFileSync(join(dir, 'yoal.env'), 'utf8')).toContain('R2_BUCKET=bucket');
		const backups = readdirSync(dir).filter((name) => name.includes('.pre-recovery-'));
		expect(backups.some((name) => name.startsWith('master.key.'))).toBe(true);
		expect(backups.some((name) => name.startsWith('yoal.env.'))).toBe(true);
		expect(run('verify', kitPath).status).toBe(0);
	});

	test('wrong passphrase fails without touching the master key', () => {
		const { dir, run } = setup();
		const kitPath = join(dir, 'kit.age');
		expect(run('export', '--out', kitPath).status).toBe(0);
		writeFileSync(join(dir, 'pass'), 'not the right passphrase\n');
		const result = run('import', kitPath, '--force');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('wrong passphrase');
		expect(readFileSync(join(dir, 'master.key'), 'utf8')).toBe('b3JpZ2luYWwta2V5\n');
	});

	test('refuses short passphrases and existing output files', () => {
		const { dir, run } = setup();
		writeFileSync(join(dir, 'pass'), 'short\n');
		expect(run('export', '--out', join(dir, 'a.age')).stderr).toContain('at least 12');
		expect(existsSync(join(dir, 'a.age'))).toBe(false);
		writeFileSync(join(dir, 'pass'), 'correct horse battery staple\n');
		writeFileSync(join(dir, 'b.age'), 'x');
		expect(run('export', '--out', join(dir, 'b.age')).stderr).toContain('already exists');
	});
});

describe('CLI with a key sealed by systemd-creds', () => {
	const ORIGINAL = 'b3JpZ2luYWwta2V5';
	function setup() {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-kit-sealed-'));
		const hostA = fakeCredsBinary(mkdtempSync(join(tmpdir(), 'yoal-creds-a-')));
		const hostB = fakeCredsBinary(mkdtempSync(join(tmpdir(), 'yoal-creds-b-')), { FAKE_CREDS_HOST: 'host-b' });
		const sealed = join(dir, 'master.key.cred');
		sealMasterKey(ORIGINAL, sealed, { tpm2: false, bin: hostA });
		writeFileSync(join(dir, 'pass'), 'correct horse battery staple\n');
		const run = (bin: string, ...args: string[]) =>
			spawnSync(process.execPath, [join(import.meta.dir, 'recovery-kit.ts'), ...args, '--passphrase-file', join(dir, 'pass'), '--work-factor', String(WF)], {
				env: { ...process.env, YOAL_ETC_DIR: dir, YOAL_SYSTEMD_CREDS: bin, YOAL_RECOVERY_PASSPHRASE_FILE: '' },
				encoding: 'utf8',
			});
		return { dir, sealed, hostA, hostB, run };
	}

	test('export reads the sealed key; import re-seals instead of writing a plaintext file', () => {
		const { dir, sealed, hostA, run } = setup();
		const kitPath = join(dir, 'kit.age');
		const exported = run(hostA, 'export', '--out', kitPath);
		expect(exported.status).toBe(0);
		expect(exported.stdout).toContain(fingerprint(ORIGINAL));
		expect(run(hostA, 'verify', kitPath).status).toBe(0);

		// The host now holds another sealed key: refused without --force, re-sealed with it.
		sealMasterKey('ZnJlc2gta2V5', sealed, { tpm2: false, bin: hostA });
		expect(run(hostA, 'verify', kitPath).stderr).toContain('fingerprint is');
		const refused = run(hostA, 'import', kitPath);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('--force');
		const imported = run(hostA, 'import', kitPath, '--force');
		expect(imported.status).toBe(0);
		expect(imported.stdout).toContain(`Sealed the kit's key into ${sealed} (host)`);
		expect(unsealMasterKey(sealed, defaultCredsRunner, hostA)).toBe(ORIGINAL);
		expect(existsSync(join(dir, 'master.key'))).toBe(false);
		expect(readdirSync(dir).some((name) => name.startsWith('master.key.cred.pre-recovery-'))).toBe(true);
		expect(run(hostA, 'verify', kitPath).status).toBe(0);
		expect(run(hostA, 'import', kitPath).stdout).toContain('already matches the kit');
	});

	test('a sealed key that no longer opens (rebuilt host) is replaced only with --force', () => {
		const { dir, sealed, hostA, hostB, run } = setup();
		const kitPath = join(dir, 'kit.age');
		expect(run(hostA, 'export', '--out', kitPath).status).toBe(0);

		const verify = run(hostB, 'verify', kitPath);
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain('cannot be read');
		const refused = run(hostB, 'import', kitPath);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('--force');
		expect(unsealMasterKey(sealed, defaultCredsRunner, hostA)).toBe(ORIGINAL);

		expect(run(hostB, 'import', kitPath, '--force').status).toBe(0);
		expect(unsealMasterKey(sealed, defaultCredsRunner, hostB)).toBe(ORIGINAL);
		expect(run(hostB, 'verify', kitPath).status).toBe(0);
	});
});
