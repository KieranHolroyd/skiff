#!/usr/bin/env bun
/**
 * Yoal recovery kit (DESIGN §2, §10; D25): a passphrase-encrypted export of the master key
 * (and optionally /etc/yoal/yoal.env), so a lost VPS can be rebuilt and existing secrets
 * still decrypt.
 *
 *   sudo yoal-recovery-kit export [--out <file>] [--include-env] [--passphrase-file <file>]
 *   sudo yoal-recovery-kit verify <file> [--passphrase-file <file>]
 *   sudo yoal-recovery-kit import <file> [--restore-env] [--force] [--passphrase-file <file>]
 *
 * The kit is a standard age v1 file (scrypt passphrase recipient, ASCII armored), so it can be
 * opened with stock `age -d kit.age` on any machine. age is implemented here (ChaCha20-Poly1305
 * per RFC 8439 on top of node:crypto's scrypt/HKDF/HMAC) because Bun's node:crypto has no
 * chacha20-poly1305 cipher and the `age` CLI only reads passphrases from a TTY, which rules out
 * non-interactive restores and tests. Only the scrypt recipient type is supported.
 *
 * The master key is read from whichever store the host uses (install/master-key.ts): the
 * systemd-creds sealed `master.key.cred` (decrypted with `systemd-creds decrypt`, root only) or
 * the plaintext `master.key`. `import` writes back into the same kind of store.
 *
 * The passphrase comes from `--passphrase-file`, `$YOAL_RECOVERY_PASSPHRASE_FILE`, or a no-echo
 * prompt on /dev/tty. An empty passphrase on export generates a strong one and prints it once.
 */

import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { detectCredsSupport, locateMasterKey, readMasterKey, sealMasterKey, type MasterKeyStore } from './install/master-key.ts';

// ---------------------------------------------------------------------------------------------
// ChaCha20-Poly1305 (RFC 8439)
// ---------------------------------------------------------------------------------------------

function rotl(v: number, n: number): number {
	return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
	s[a] = (s[a]! + s[b]!) >>> 0;
	s[d] = rotl(s[d]! ^ s[a]!, 16);
	s[c] = (s[c]! + s[d]!) >>> 0;
	s[b] = rotl(s[b]! ^ s[c]!, 12);
	s[a] = (s[a]! + s[b]!) >>> 0;
	s[d] = rotl(s[d]! ^ s[a]!, 8);
	s[c] = (s[c]! + s[d]!) >>> 0;
	s[b] = rotl(s[b]! ^ s[c]!, 7);
}

function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
	const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
	const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
	const init = new Uint32Array(16);
	init[0] = 0x61707865;
	init[1] = 0x3320646e;
	init[2] = 0x79622d32;
	init[3] = 0x6b206574;
	for (let i = 0; i < 8; i++) init[4 + i] = kv.getUint32(i * 4, true);
	init[12] = counter >>> 0;
	for (let i = 0; i < 3; i++) init[13 + i] = nv.getUint32(i * 4, true);
	const s = init.slice();
	for (let i = 0; i < 10; i++) {
		quarterRound(s, 0, 4, 8, 12);
		quarterRound(s, 1, 5, 9, 13);
		quarterRound(s, 2, 6, 10, 14);
		quarterRound(s, 3, 7, 11, 15);
		quarterRound(s, 0, 5, 10, 15);
		quarterRound(s, 1, 6, 11, 12);
		quarterRound(s, 2, 7, 8, 13);
		quarterRound(s, 3, 4, 9, 14);
	}
	const out = new Uint8Array(64);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (s[i]! + init[i]!) >>> 0, true);
	return out;
}

function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length);
	for (let offset = 0, block = counter; offset < data.length; offset += 64, block++) {
		const ks = chachaBlock(key, block, nonce);
		const end = Math.min(64, data.length - offset);
		for (let i = 0; i < end; i++) out[offset + i] = data[offset + i]! ^ ks[i]!;
	}
	return out;
}

function leBigInt(bytes: Uint8Array): bigint {
	let n = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
	return n;
}

function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
	const p = (1n << 130n) - 5n;
	const r = leBigInt(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
	const s = leBigInt(key.subarray(16, 32));
	let acc = 0n;
	for (let i = 0; i < msg.length; i += 16) {
		const block = msg.subarray(i, Math.min(i + 16, msg.length));
		acc = ((acc + leBigInt(block) + (1n << BigInt(8 * block.length))) * r) % p;
	}
	let tag = (acc + s) & ((1n << 128n) - 1n);
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		out[i] = Number(tag & 0xffn);
		tag >>= 8n;
	}
	return out;
}

function polyInput(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
	const pad = (n: number) => (16 - (n % 16)) % 16;
	const buf = new Uint8Array(aad.length + pad(aad.length) + ciphertext.length + pad(ciphertext.length) + 16);
	buf.set(aad, 0);
	const ctOffset = aad.length + pad(aad.length);
	buf.set(ciphertext, ctOffset);
	const lens = new DataView(buf.buffer, ctOffset + ciphertext.length + pad(ciphertext.length), 16);
	lens.setBigUint64(0, BigInt(aad.length), true);
	lens.setBigUint64(8, BigInt(ciphertext.length), true);
	return buf;
}

export function chachaPolySeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad = new Uint8Array(0)): Uint8Array {
	const polyKey = chachaBlock(key, 0, nonce).subarray(0, 32);
	const ct = chacha20(key, nonce, 1, plaintext);
	const tag = poly1305(polyKey, polyInput(aad, ct));
	const out = new Uint8Array(ct.length + 16);
	out.set(ct, 0);
	out.set(tag, ct.length);
	return out;
}

export function chachaPolyOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad = new Uint8Array(0)): Uint8Array | null {
	if (sealed.length < 16) return null;
	const ct = sealed.subarray(0, sealed.length - 16);
	const tag = sealed.subarray(sealed.length - 16);
	const polyKey = chachaBlock(key, 0, nonce).subarray(0, 32);
	const expected = poly1305(polyKey, polyInput(aad, ct));
	if (!timingSafeEqual(Buffer.from(expected), Buffer.from(tag))) return null;
	return chacha20(key, nonce, 1, ct);
}

// ---------------------------------------------------------------------------------------------
// age v1, scrypt recipient only (https://age-encryption.org/v1)
// ---------------------------------------------------------------------------------------------

const AGE_VERSION_LINE = 'age-encryption.org/v1';
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt';
const CHUNK = 64 * 1024;
/** age's default encryption work factor (~1 s); decryption refuses anything above 22, like age. */
export const DEFAULT_WORK_FACTOR = 18;
const MAX_WORK_FACTOR = 22;
const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

const b64raw = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');

function fromB64raw(s: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new Error('invalid base64 in age header');
	const bytes = new Uint8Array(Buffer.from(s, 'base64'));
	if (b64raw(bytes) !== s) throw new Error('non-canonical base64 in age header');
	return bytes;
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
	return new Uint8Array(hkdfSync('sha256', ikm, salt, info, 32));
}

function scryptKey(passphrase: string, salt: Uint8Array, logN: number): Uint8Array {
	const fullSalt = Buffer.concat([Buffer.from(SCRYPT_LABEL), salt]);
	const N = 2 ** logN;
	return new Uint8Array(scryptSync(passphrase, fullSalt, 32, { N, r: 8, p: 1, maxmem: 128 * N * 8 + 32 * 1024 * 1024 }));
}

function streamNonce(counter: number, last: boolean): Uint8Array {
	const nonce = new Uint8Array(12);
	new DataView(nonce.buffer).setBigUint64(3, BigInt(counter), false); // 11-byte big-endian counter
	nonce[11] = last ? 1 : 0;
	return nonce;
}

/** Encrypt `plaintext` to a binary age file with a passphrase (scrypt recipient). */
export function ageEncrypt(plaintext: Uint8Array, passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Uint8Array {
	if (!passphrase) throw new Error('empty passphrase');
	const fileKey = randomBytes(16);
	const salt = randomBytes(16);
	const wrapped = chachaPolySeal(scryptKey(passphrase, salt, workFactor), new Uint8Array(12), fileKey);
	const headerNoMac = `${AGE_VERSION_LINE}\n-> scrypt ${b64raw(salt)} ${workFactor}\n${b64raw(wrapped)}\n---`;
	const mac = createHmac('sha256', hkdf(fileKey, new Uint8Array(0), 'header')).update(headerNoMac).digest();
	const header = Buffer.from(`${headerNoMac} ${b64raw(mac)}\n`);

	const nonce = randomBytes(16);
	const payloadKey = hkdf(fileKey, nonce, 'payload');
	const parts: Uint8Array[] = [header, nonce];
	const chunks = Math.max(1, Math.ceil(plaintext.length / CHUNK));
	for (let i = 0; i < chunks; i++) {
		const chunk = plaintext.subarray(i * CHUNK, (i + 1) * CHUNK);
		parts.push(chachaPolySeal(payloadKey, streamNonce(i, i === chunks - 1), chunk));
	}
	return new Uint8Array(Buffer.concat(parts));
}

/** Decrypt a binary or armored age file encrypted with a passphrase. Throws on any failure. */
export function ageDecrypt(file: Uint8Array | string, passphrase: string): Uint8Array {
	const bytes = typeof file === 'string' || looksArmored(file) ? dearmor(typeof file === 'string' ? file : Buffer.from(file).toString('utf8')) : file;
	const buf = Buffer.from(bytes);

	// Header: version line, stanzas, then `--- <mac>`.
	const macMarker = buf.indexOf('\n--- ');
	if (macMarker < 0) throw new Error('not an age file (no header MAC)');
	const macLineEnd = buf.indexOf('\n', macMarker + 1);
	if (macLineEnd < 0) throw new Error('truncated age header');
	const headerText = buf.subarray(0, macMarker + 4).toString('utf8'); // through "---"
	const macText = buf.subarray(macMarker + 5, macLineEnd).toString('utf8');
	const lines = headerText.split('\n');
	if (lines[0] !== AGE_VERSION_LINE) throw new Error('unsupported age version');

	const stanzas: Array<{ args: string[]; body: Uint8Array }> = [];
	let i = 1;
	while (i < lines.length - 1) {
		const line = lines[i]!;
		if (!line.startsWith('-> ')) throw new Error('malformed age stanza');
		const args = line.slice(3).split(' ');
		i++;
		let body = '';
		for (;;) {
			if (i >= lines.length - 1) throw new Error('truncated age stanza');
			const bodyLine = lines[i++]!;
			if (bodyLine.length > 64) throw new Error('malformed age stanza body');
			body += bodyLine;
			if (bodyLine.length < 64) break;
		}
		stanzas.push({ args, body: fromB64raw(body) });
	}
	if (lines[lines.length - 1] !== '---') throw new Error('malformed age header');
	const scrypt = stanzas.filter((s) => s.args[0] === 'scrypt');
	if (scrypt.length === 0) throw new Error('this age file is not passphrase-encrypted');
	if (stanzas.length !== 1) throw new Error('a passphrase-encrypted age file must have exactly one stanza');
	const [, saltB64, logNText] = scrypt[0]!.args;
	if (scrypt[0]!.args.length !== 3 || !saltB64 || !/^[1-9][0-9]?$/.test(logNText ?? '')) throw new Error('malformed scrypt stanza');
	const salt = fromB64raw(saltB64);
	const logN = Number(logNText);
	if (salt.length !== 16) throw new Error('malformed scrypt salt');
	if (logN > MAX_WORK_FACTOR) throw new Error(`scrypt work factor ${logN} is too large`);
	if (scrypt[0]!.body.length !== 32) throw new Error('malformed scrypt stanza body');

	const fileKey = chachaPolyOpen(scryptKey(passphrase, salt, logN), new Uint8Array(12), scrypt[0]!.body);
	if (!fileKey) throw new Error('wrong passphrase (or the kit is corrupted)');
	const mac = createHmac('sha256', hkdf(fileKey, new Uint8Array(0), 'header')).update(headerText).digest();
	if (!timingSafeEqual(mac, Buffer.from(fromB64raw(macText)))) throw new Error('age header MAC mismatch (file tampered with)');

	const payload = buf.subarray(macLineEnd + 1);
	if (payload.length < 16 + 16) throw new Error('truncated age payload');
	const payloadKey = hkdf(fileKey, payload.subarray(0, 16), 'payload');
	const body = payload.subarray(16);
	const out: Uint8Array[] = [];
	const sealedChunk = CHUNK + 16;
	const chunks = Math.max(1, Math.ceil(body.length / sealedChunk));
	for (let c = 0; c < chunks; c++) {
		const sealed = body.subarray(c * sealedChunk, (c + 1) * sealedChunk);
		const last = c === chunks - 1;
		const plain = chachaPolyOpen(payloadKey, streamNonce(c, last), sealed);
		if (!plain) throw new Error('age payload authentication failed (truncated or tampered)');
		if (last && plain.length === 0 && c > 0) throw new Error('age payload has an empty final chunk');
		out.push(plain);
	}
	return new Uint8Array(Buffer.concat(out));
}

function looksArmored(bytes: Uint8Array): boolean {
	return Buffer.from(bytes.subarray(0, 64)).toString('utf8').trimStart().startsWith(ARMOR_BEGIN);
}

export function armor(file: Uint8Array): string {
	const b64 = Buffer.from(file).toString('base64');
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `${ARMOR_BEGIN}\n${lines.join('\n')}\n${ARMOR_END}\n`;
}

export function dearmor(text: string): Uint8Array {
	const lines = text.trim().split(/\r?\n/);
	if (lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) throw new Error('not an armored age file');
	const body = lines.slice(1, -1);
	body.forEach((line, index) => {
		if (index < body.length - 1 ? line.length !== 64 : line.length === 0 || line.length > 64) throw new Error('malformed age armor');
	});
	return new Uint8Array(Buffer.from(body.join(''), 'base64'));
}

// ---------------------------------------------------------------------------------------------
// Kit format
// ---------------------------------------------------------------------------------------------

export interface RecoveryKit {
	format: 'yoal-recovery-kit';
	version: 1;
	createdAt: string;
	host: string;
	platformOrigin: string | null;
	/** sha256(master key)[0..16] in hex, to match a kit to a host without revealing the key. */
	fingerprint: string;
	masterKey: string;
	/** Raw /etc/yoal/yoal.env, when exported with --include-env. */
	env?: string;
}

export function fingerprint(masterKey: string): string {
	return createHash('sha256').update(masterKey.trim()).digest('hex').slice(0, 16);
}

export function buildKit(input: { masterKey: string; env?: string; host?: string; now?: Date }): RecoveryKit {
	const masterKey = input.masterKey.trim();
	if (!masterKey) throw new Error('master key is empty');
	const origin = input.env ? envValue(input.env, 'YOAL_PLATFORM_ORIGIN') : null;
	return {
		format: 'yoal-recovery-kit',
		version: 1,
		createdAt: (input.now ?? new Date()).toISOString(),
		host: input.host ?? hostname(),
		platformOrigin: origin,
		fingerprint: fingerprint(masterKey),
		masterKey,
		...(input.env !== undefined ? { env: input.env } : {}),
	};
}

export function parseKit(plaintext: Uint8Array): RecoveryKit {
	let kit: RecoveryKit;
	try {
		kit = JSON.parse(Buffer.from(plaintext).toString('utf8')) as RecoveryKit;
	} catch {
		throw new Error('decrypted file is not a Yoal recovery kit');
	}
	if (kit?.format !== 'yoal-recovery-kit' || kit.version !== 1 || typeof kit.masterKey !== 'string' || !kit.masterKey)
		throw new Error('decrypted file is not a Yoal recovery kit (or an unsupported version)');
	if (fingerprint(kit.masterKey) !== kit.fingerprint) throw new Error('recovery kit fingerprint does not match its master key');
	return kit;
}

export function encryptKit(kit: RecoveryKit, passphrase: string, workFactor = DEFAULT_WORK_FACTOR): string {
	return armor(ageEncrypt(Buffer.from(`${JSON.stringify(kit, null, 2)}\n`), passphrase, workFactor));
}

export function decryptKit(file: Uint8Array | string, passphrase: string): RecoveryKit {
	return parseKit(ageDecrypt(file, passphrase));
}

/** Only the plain `KEY=value` lines we need; quoted values are unwrapped (systemd style). */
function envValue(env: string, key: string): string | null {
	for (const line of env.split('\n')) {
		if (!line.startsWith(`${key}=`)) continue;
		let value = line.slice(key.length + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\`$])/g, '$1');
		return value || null;
	}
	return null;
}

/** A generated passphrase: 8 groups of 5 base32 chars (~200 bits), easy to write down. */
export function generatePassphrase(): string {
	const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
	const bytes = randomBytes(40);
	const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]!); // 256 % 32 === 0, unbiased
	return Array.from({ length: 8 }, (_, i) => chars.slice(i * 5, i * 5 + 5).join('')).join('-');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const ETC = process.env.YOAL_ETC_DIR ?? '/etc/yoal';
const MASTER_KEY_FILE = process.env.YOAL_MASTER_KEY_PATH ?? `${ETC}/master.key`;
const ENV_FILE = process.env.YOAL_ENV_FILE ?? `${ETC}/yoal.env`;
const MIN_PASSPHRASE = 12;

class UsageError extends Error {}

function fail(message: string): never {
	process.stderr.write(`yoal-recovery-kit: error: ${message}\n`);
	process.exit(1);
}

/**
 * Read a line from /dev/tty with echo off. `stty sane` first: a caller such as the installer may
 * have left the terminal in raw mode, where Enter sends `\r` (so `read` never returns) and Ctrl-C
 * is not a signal. The caller's mode is restored afterwards. Ctrl-C exits 130 (cancelled) instead
 * of returning an empty line, which export would take as "generate a passphrase".
 */
export const PROMPT_SCRIPT = [
	'exec </dev/tty',
	'saved=$(stty -g)',
	`trap 'stty "$saved"' EXIT`,
	`trap 'stty "$saved"; printf "\\n" >/dev/tty; exit 130' INT TERM`,
	'stty sane -echo',
	'printf "%s" "$1" >/dev/tty',
	'IFS= read -r p || exit 1',
	'printf "\\n" >/dev/tty',
	'printf "%s" "$p"',
].join('\n');

/** Prompt on /dev/tty with echo off. Never reads the passphrase from stdin or argv. */
function promptTty(prompt: string): string {
	if (!existsSync('/dev/tty')) throw new Error('no terminal: pass --passphrase-file');
	const result = spawnSync('sh', ['-c', PROMPT_SCRIPT, 'sh', prompt], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
	if (result.status === 130 || result.signal === 'SIGINT') {
		process.stderr.write('yoal-recovery-kit: cancelled\n');
		process.exit(130);
	}
	if (result.status !== 0) throw new Error('could not read the passphrase from the terminal (pass --passphrase-file)');
	return result.stdout;
}

function readPassphraseFile(path: string): string {
	const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
	if (!value) throw new Error(`passphrase file ${path} is empty`);
	return value;
}

function passphraseFor(mode: 'encrypt' | 'decrypt', file: string | undefined): { passphrase: string; generated: boolean } {
	const path = file ?? process.env.YOAL_RECOVERY_PASSPHRASE_FILE;
	if (path) {
		const passphrase = readPassphraseFile(path);
		if (mode === 'encrypt' && passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
		return { passphrase, generated: false };
	}
	if (mode === 'decrypt') return { passphrase: promptTty('Recovery kit passphrase: '), generated: false };
	const first = promptTty(`New passphrase (empty = generate one; min ${MIN_PASSPHRASE} chars): `);
	if (!first) return { passphrase: generatePassphrase(), generated: true };
	if (first.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
	if (promptTty('Repeat passphrase: ') !== first) throw new Error('passphrases do not match');
	return { passphrase: first, generated: false };
}

interface Args {
	command: string;
	file?: string;
	out?: string;
	passphraseFile?: string;
	includeEnv: boolean;
	restoreEnv: boolean;
	force: boolean;
	workFactor: number;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { command: argv[0] ?? '', includeEnv: false, restoreEnv: false, force: false, workFactor: DEFAULT_WORK_FACTOR };
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]!;
		const value = () => {
			const next = argv[++i];
			if (!next) throw new UsageError(`${arg} needs a value`);
			return next;
		};
		if (arg === '--out') args.out = value();
		else if (arg === '--passphrase-file') args.passphraseFile = value();
		else if (arg === '--include-env') args.includeEnv = true;
		else if (arg === '--restore-env') args.restoreEnv = true;
		else if (arg === '--force') args.force = true;
		// Hidden: tests use a low work factor. Production always uses age's default.
		else if (arg === '--work-factor') args.workFactor = Number(value());
		else if (!arg.startsWith('-') && !args.file) args.file = arg;
		else throw new UsageError(`unknown argument '${arg}'`);
	}
	if (!Number.isInteger(args.workFactor) || args.workFactor < 1 || args.workFactor > MAX_WORK_FACTOR) throw new UsageError('invalid --work-factor');
	return args;
}

const USAGE = `Usage:
  yoal-recovery-kit export [--out <file>] [--include-env] [--passphrase-file <file>]
  yoal-recovery-kit verify <file> [--passphrase-file <file>]
  yoal-recovery-kit import <file> [--restore-env] [--force] [--passphrase-file <file>]

The kit is a standard age file: \`age -d kit.age\` also opens it.
`;

/** Keep a timestamped root-only copy of `path` (when it exists) before it is replaced. */
function backupFile(path: string): string | null {
	if (!existsSync(path)) return null;
	const backup = `${path}.pre-recovery-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z`;
	copyFileSync(path, backup);
	chmodSync(backup, 0o400);
	return backup;
}

/** Atomic write with mode and (when root) ownership; keeps a timestamped copy of what it replaces. */
function installFile(path: string, content: string, mode: number, owner: { uid: number; gid: number } | null): string | null {
	const backup = backupFile(path);
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, { mode });
	chmodSync(tmp, mode);
	if (owner) chownSync(tmp, owner.uid, owner.gid);
	renameSync(tmp, path);
	return backup;
}

function groupId(name: string): number | null {
	const result = spawnSync('getent', ['group', name], { encoding: 'utf8' });
	const gid = result.status === 0 ? Number(result.stdout.split(':')[2]) : NaN;
	return Number.isInteger(gid) ? gid : null;
}

/** The plaintext key behind the host's store; exits with systemd-creds' reason on failure. */
function keyOf(store: MasterKeyStore): string {
	try {
		return readMasterKey(store);
	} catch (error) {
		fail(`${(error as Error).message}${store.kind === 'sealed' ? ' (run as root on the host that sealed it)' : ''}`);
	}
}

export async function main(argv: string[]): Promise<void> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
		process.exit(2);
	}
	if (args.command === '' || args.command === '-h' || args.command === '--help' || args.command === 'help') {
		process.stdout.write(USAGE);
		return;
	}
	const isRoot = process.getuid?.() === 0;

	if (args.command === 'export') {
		const store = locateMasterKey(MASTER_KEY_FILE);
		if (!store) fail(`missing ${MASTER_KEY_FILE} (is Yoal installed?)`);
		const masterKey = keyOf(store);
		const env = args.includeEnv ? readFileSync(ENV_FILE, 'utf8') : undefined;
		const kit = buildKit({ masterKey, env });
		const out = args.out ?? `${isRoot ? '/root' : process.env.HOME ?? '.'}/yoal-recovery-kit-${kit.host}-${kit.createdAt.slice(0, 10)}.age`;
		if (existsSync(out) && !args.force) fail(`${out} already exists (use --force or --out)`);
		const { passphrase, generated } = passphraseFor('encrypt', args.passphraseFile);
		const armored = encryptKit(kit, passphrase, args.workFactor);
		// Prove the kit opens before telling anyone to rely on it.
		if (decryptKit(armored, passphrase).fingerprint !== kit.fingerprint) fail('self-check failed; kit not written');
		writeFileSync(`${out}.tmp`, armored, { mode: 0o600 });
		chmodSync(`${out}.tmp`, 0o600);
		renameSync(`${out}.tmp`, out);
		const lines = [
			'',
			`Recovery kit written to ${out}`,
			`  master key fingerprint: ${kit.fingerprint}`,
			`  contents: master key${env !== undefined ? ' + yoal.env (R2, SMTP and auth secrets)' : ''}`,
		];
		if (generated) lines.push('', 'Generated passphrase (shown once, write it down):', '', `  ${passphrase}`, '');
		lines.push(
			'',
			'Next:',
			`  1. Copy it off this server (e.g. scp root@host:${out} .) and store it offline,`,
			'     with the passphrase kept separately (password manager).',
			`  2. Delete it from the server: shred -u ${out}`,
			'  3. Re-export after every master-key rotation.',
			'Restore on a fresh host: yoal-restore --recovery-kit <file>   (or: age -d <file>)',
			'',
		);
		process.stdout.write(lines.join('\n'));
		return;
	}

	if (args.command === 'verify' || args.command === 'import') {
		if (!args.file) {
			process.stderr.write(USAGE);
			process.exit(2);
		}
		if (!existsSync(args.file)) fail(`no such file: ${args.file}`);
		const { passphrase } = passphraseFor('decrypt', args.passphraseFile);
		let kit: RecoveryKit;
		try {
			kit = decryptKit(readFileSync(args.file), passphrase);
		} catch (error) {
			fail((error as Error).message);
		}
		const store = locateMasterKey(MASTER_KEY_FILE);
		// A sealed key that does not open here (rebuilt host, reset TPM, not root) is "unknown":
		// verify fails, import replaces it only with --force.
		let current: string | null = null;
		let unreadable: string | null = null;
		if (store) {
			try {
				current = fingerprint(readMasterKey(store));
			} catch (error) {
				unreadable = (error as Error).message;
			}
		}
		const keyPath = store?.path ?? MASTER_KEY_FILE;
		process.stdout.write(
			`Recovery kit ${basename(args.file)}: created ${kit.createdAt} on ${kit.host}` +
				`${kit.platformOrigin ? ` (${kit.platformOrigin})` : ''}, fingerprint ${kit.fingerprint}` +
				`${kit.env !== undefined ? ', includes yoal.env' : ''}\n`,
		);

		if (args.command === 'verify') {
			if (unreadable !== null) fail(`kit decrypts, but this host's master key cannot be read: ${unreadable} (run as root on the host that sealed it)`);
			if (current === null) fail(`kit decrypts, but ${MASTER_KEY_FILE} is missing so it cannot be compared`);
			if (current !== kit.fingerprint) fail(`kit decrypts, but this host's master key fingerprint is ${current}`);
			process.stdout.write('OK: the kit decrypts and matches this host\'s master key.\n');
			return;
		}

		if (!isRoot && !process.env.YOAL_ETC_DIR) fail('run as root');
		if (unreadable !== null && !args.force)
			fail(`${unreadable}; pass --force to replace it with the kit's key (a backup copy is kept)`);
		if (current !== null && current !== kit.fingerprint && !args.force)
			fail(`${keyPath} holds a different key (fingerprint ${current}); pass --force to replace it (a backup copy is kept)`);
		if (current === kit.fingerprint) process.stdout.write(`${keyPath} already matches the kit.\n`);
		else if (store?.kind === 'sealed') {
			// Same store as the installer chose: sealed again with this host's systemd-creds keys.
			const backup = backupFile(store.path);
			let binding: string;
			try {
				binding = sealMasterKey(kit.masterKey, store.path, { tpm2: detectCredsSupport().tpm2 });
			} catch (error) {
				fail((error as Error).message);
			}
			process.stdout.write(`Sealed the kit's key into ${store.path} (${binding})${backup ? ` (previous file kept at ${backup})` : ''}\n`);
		} else {
			// Same as the installer without systemd-creds: root-only, read through LoadCredential=.
			const backup = installFile(MASTER_KEY_FILE, `${kit.masterKey}\n`, 0o400, isRoot ? { uid: 0, gid: 0 } : null);
			process.stdout.write(`Wrote ${MASTER_KEY_FILE}${backup ? ` (previous key kept at ${backup})` : ''}\n`);
		}
		if (args.restoreEnv) {
			if (kit.env === undefined) process.stdout.write('The kit has no yoal.env (exported without --include-env); left it unchanged.\n');
			else {
				const gid = isRoot ? groupId('yoal') : null;
				const backup = installFile(ENV_FILE, kit.env, 0o640, isRoot ? { uid: 0, gid: gid ?? 0 } : null);
				process.stdout.write(`Wrote ${ENV_FILE}${backup ? ` (previous file kept at ${backup})` : ''}\n`);
			}
		}
		return;
	}

	process.stderr.write(`unknown command '${args.command}'\n\n${USAGE}`);
	process.exit(2);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: Error) => fail(error.message));
}
