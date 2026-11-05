/**
 * Signed release manifests.
 *
 * CI publishes `manifest.json` plus `manifest.json.sig` (base64 Ed25519 over the exact manifest
 * bytes) with every GitHub release. The updater refuses an artifact unless the manifest
 * verifies against a trusted key and the artifact's sha256 and size match the manifest.
 *
 * Trust anchors: the keys compiled in below, plus any `*.pub` (SPKI PEM) in
 * /etc/skiff/updater/keys/. Rotation: publish a release signed by the old key that ships the
 * new key here, then retire the old one.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_SCHEMA = 1;

/** Release-signing public keys (SPKI PEM). The private half lives only in CI secrets. */
export const BUILTIN_RELEASE_KEYS: Record<string, string> = {
	'skiff-release-2026-11': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAajsmEHd30hWuS8HEOXBApIBJSJGrZboNxHSP/qinb/k=
-----END PUBLIC KEY-----
`,
};

export interface ManifestArtifact {
	file: string;
	sha256: string;
	size: number;
}

export interface ReleaseManifest {
	schema: number;
	/** Semantic version, without the `v`. */
	version: string;
	/** Commit the artifacts were built from. */
	commit: string;
	repo: string;
	channel: 'stable' | 'edge';
	createdAt: string;
	/** Version of the stage-0 updater bundled in the artifacts (`updater/skiff-updated`). */
	updaterVersion: string | null;
	/** Oldest stage-0 updater that can install this release. */
	minUpdater: string | null;
	/** Release-hook protocol shipped (`repo/scripts/release/hooks.ts`). */
	hookProtocol: number;
	/** Keyed by platform, e.g. `linux-amd64`. */
	artifacts: Record<string, ManifestArtifact>;
}

export class SignatureError extends Error {}

export function loadTrustedKeys(dir = '/etc/skiff/updater/keys'): Map<string, KeyObject> {
	const keys = new Map<string, KeyObject>();
	for (const [id, pem] of Object.entries(BUILTIN_RELEASE_KEYS)) keys.set(id, createPublicKey(pem));
	if (existsSync(dir))
		for (const file of readdirSync(dir).filter((name) => name.endsWith('.pub')).sort()) {
			try {
				keys.set(`file:${file}`, createPublicKey(readFileSync(join(dir, file), 'utf8')));
			} catch {
				// An unreadable extra key is ignored; it can only add trust, never remove it.
			}
		}
	return keys;
}

/** Sign manifest bytes with a PKCS8 PEM Ed25519 private key; returns base64. */
export function signManifest(bytes: Uint8Array, privateKeyPem: string): string {
	return sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64');
}

/** Verify and parse. Throws {@link SignatureError} unless some trusted key signed these bytes. */
export function verifyManifest(bytes: Uint8Array, signatureB64: string, keys: Map<string, KeyObject>): ReleaseManifest {
	if (keys.size === 0) throw new SignatureError('no release-signing keys are trusted on this host');
	let signature: Buffer;
	try {
		signature = Buffer.from(signatureB64.trim(), 'base64');
	} catch {
		throw new SignatureError('manifest signature is not base64');
	}
	if (signature.length !== 64) throw new SignatureError('manifest signature has the wrong length');
	const trusted = [...keys.values()].some((key) => {
		try {
			return verify(null, bytes, key, signature);
		} catch {
			return false;
		}
	});
	if (!trusted) throw new SignatureError('manifest signature does not match any trusted release key');
	let manifest: ReleaseManifest;
	try {
		manifest = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
	} catch {
		throw new SignatureError('signed manifest is not valid JSON');
	}
	if (manifest.schema !== MANIFEST_SCHEMA) throw new SignatureError(`unsupported manifest schema ${String(manifest.schema)}`);
	if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '') || !/^[0-9a-f]{40}$/.test(manifest.commit ?? ''))
		throw new SignatureError('signed manifest is missing its version or commit');
	return manifest;
}

export function sha256File(path: string): string {
	const hash = createHash('sha256');
	hash.update(readFileSync(path));
	return hash.digest('hex');
}

/** The platform key used in manifests for this machine, e.g. linux-amd64. */
export function hostPlatform(): string {
	const arch = process.arch === 'x64' ? 'amd64' : process.arch;
	return `${process.platform}-${arch}`;
}
