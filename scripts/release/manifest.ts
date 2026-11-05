#!/usr/bin/env bun
/**
 * CI: write and sign `manifest.json` for the release artifacts in a directory.
 *
 *   SKIFF_RELEASE_SIGNING_KEY=<pkcs8 pem> bun scripts/release/manifest.ts \
 *     --version 0.6.4 --commit <sha> --repo owner/name --dir dist
 *
 * Refuses to publish a manifest the updater could not verify: the signature is checked against
 * the release keys compiled into the updater before anything is written.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import {
	BUILTIN_RELEASE_KEYS,
	MANIFEST_SCHEMA,
	sha256File,
	signManifest,
	verifyManifest,
	type ReleaseManifest,
} from '../update-self/signing.ts';
import { UPDATER_VERSION } from '../update-self/version.ts';
import { HOOK_PROTOCOL } from './canary.ts';

function option(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const version = option('--version').replace(/^v/, '');
const commit = option('--commit');
const repo = option('--repo');
const dir = option('--dir');
const key = process.env.SKIFF_RELEASE_SIGNING_KEY;
if (!key) throw new Error('SKIFF_RELEASE_SIGNING_KEY is not set; refusing to publish an unsigned release');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit sha: ${commit}`);

const artifacts: ReleaseManifest['artifacts'] = {};
const pattern = new RegExp(`^skiff-${version.replace(/\./g, '\\.')}-(linux-[a-z0-9]+)\\.tar\\.gz$`);
for (const file of readdirSync(dir).sort()) {
	const match = pattern.exec(file);
	if (!match) continue;
	const path = join(dir, file);
	artifacts[match[1]!] = { file, sha256: sha256File(path), size: statSync(path).size };
}
if (!Object.keys(artifacts).length) throw new Error(`no skiff-${version}-linux-*.tar.gz in ${dir}`);

const manifest: ReleaseManifest = {
	schema: MANIFEST_SCHEMA,
	version,
	commit,
	repo,
	channel: 'stable',
	createdAt: new Date().toISOString(),
	updaterVersion: UPDATER_VERSION,
	minUpdater: null,
	hookProtocol: HOOK_PROTOCOL,
	artifacts,
};
const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
const signature = signManifest(bytes, key);

// The updater on every host trusts only BUILTIN_RELEASE_KEYS (+ /etc/skiff/updater/keys). A key
// mismatch here would publish a release no host accepts; fail the pipeline instead.
const trusted = new Map(Object.entries(BUILTIN_RELEASE_KEYS).map(([id, pem]) => [id, createPublicKey(pem)]));
verifyManifest(bytes, signature, trusted);

writeFileSync(join(dir, 'manifest.json'), bytes);
writeFileSync(join(dir, 'manifest.json.sig'), `${signature}\n`);
console.log(`signed manifest for ${version} (${Object.keys(artifacts).join(', ')})`);
console.log(readFileSync(join(dir, 'manifest.json'), 'utf8'));
