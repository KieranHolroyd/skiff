import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface IdentityConfig {
	dataDir: string;
	dbPath: string;
	socketPath: string;
	host: string;
	port: number;
	contentDomain: string;
	platformOrigin: string;
	/** Seals pool signing keys and MFA secrets in the identity database. */
	masterKey: Uint8Array;
	secureCookies: boolean;
}

function requiredKey(value: string | undefined, dataDir: string): Uint8Array {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	if (value) {
		const raw = /^[A-Za-z0-9+/=]{43,44}$/.test(value) ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8');
		if (raw.length !== 32) throw new Error('SKIFF_IDENTITY_MASTER_KEY must be 32 bytes (base64 or raw)');
		return raw;
	}
	// A process-local key is enough for one identity node: no other process verifies these tokens.
	// It lives beside the database so restarts keep the same pool signing keys and sealed secrets.
	const path = join(dataDir, 'master.key');
	if (existsSync(path)) {
		const raw = readFileSync(path);
		if (raw.length === 32) return raw;
	}
	const generated = randomBytes(32);
	writeFileSync(path, generated, { mode: 0o600 });
	return generated;
}

function port(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8788;
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
	const dataDir = env.SKIFF_IDENTITY_DATA_DIR?.trim() || '/var/lib/skiff/identity';
	const dbPath = env.SKIFF_IDENTITY_DB?.trim() || join(dataDir, 'identity.db');
	const socketPath = env.SKIFF_IDENTITY_SOCKET?.trim() || '/run/skiff/identity.sock';
	const contentDomain = (env.SKIFF_IDENTITY_CONTENT_DOMAIN ?? env.SKIFF_CONTENT_DOMAIN ?? 'localhost').trim().toLowerCase();
	const platformOrigin = (env.SKIFF_IDENTITY_ORIGIN ?? `https://auth.${contentDomain}`).replace(/\/+$/, '');
	const masterKey = requiredKey(env.SKIFF_IDENTITY_MASTER_KEY, dataDir);
	return {
		dataDir,
		dbPath,
		socketPath,
		host: env.SKIFF_IDENTITY_HOST?.trim() || '127.0.0.1',
		port: port(env.SKIFF_IDENTITY_PORT),
		contentDomain,
		platformOrigin,
		masterKey,
		secureCookies: /^https:/i.test(platformOrigin),
	};
}

/** A deterministic non-secret sentinel, so config construction never needs another env var. */
export function identityCookieSecret(masterKey: Uint8Array): string {
	return createHash('sha256').update(masterKey).update('identity-cookie').digest('hex');
}
