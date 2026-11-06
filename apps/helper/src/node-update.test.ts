import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signManifest } from '../../../scripts/update-self/signing.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import { compareVersions, NodeUpdateError, NodeUpdater, parseNodeUpdateRequest } from './node-update.ts';
import { ValidationError } from './validate.ts';

const REPO = 'owner/skiff';
const COMMIT = 'a'.repeat(40);
const keys = generateKeyPairSync('ed25519');
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const trusted = (): Map<string, KeyObject> =>
	new Map([['test', createPublicKey(keys.publicKey.export({ type: 'spki', format: 'pem' }))]]);

let root: string;
let files: Map<string, Uint8Array>;
let restarts: number;

function paths() {
	return {
		agentBinary: join(root, 'opt/skiff/current/agent/skiff-agent'),
		helperBinary: join(root, 'opt/skiff/helper/skiff-helper'),
		releaseLink: join(root, 'opt/skiff/current'),
		workDir: join(root, 'var/lib/skiff-helper/node-update'),
	};
}

/** Build a node bundle with `members`, sign a manifest for it and serve both from the fake GitHub. */
function publish(input: {
	version?: string;
	members?: Record<string, string>;
	signWith?: string;
	tamper?: boolean;
	noNodeArtifacts?: boolean;
	manifestVersion?: string;
} = {}) {
	const version = input.version ?? '0.8.0';
	const members = input.members ?? { 'skiff-agent': `agent ${version}`, 'skiff-helper': `helper ${version}` };
	const src = mkdtempSync(join(tmpdir(), 'skiff-node-src-'));
	for (const [name, body] of Object.entries(members)) writeFileSync(join(src, name), body);
	const file = `skiff-node-${version}-linux-amd64.tar.gz`;
	const archive = join(src, file);
	execFileSync('tar', ['-czf', archive, '-C', src, ...Object.keys(members)]);
	const bytes = readFileSync(archive);
	const manifest = {
		schema: 1,
		version: input.manifestVersion ?? version,
		commit: COMMIT,
		repo: REPO,
		channel: 'stable',
		createdAt: '2026-11-06T00:00:00.000Z',
		updaterVersion: null,
		minUpdater: null,
		hookProtocol: 1,
		artifacts: {},
		...(input.noNodeArtifacts
			? {}
			: {
					nodeArtifacts: {
						'linux-amd64': {
							file,
							sha256: input.tamper ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
							size: bytes.length,
						},
					},
				}),
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const base = `https://github.com/${REPO}/releases/download/v${version}`;
	files.set(`${base}/manifest.json`, manifestBytes);
	files.set(`${base}/manifest.json.sig`, new TextEncoder().encode(signManifest(manifestBytes, input.signWith ?? privatePem)));
	files.set(`${base}/${file}`, new Uint8Array(bytes));
}

function updater(currentVersion = '0.7.15') {
	return new NodeUpdater({
		paths: paths(),
		currentVersion,
		trustedKeys: trusted,
		platform: () => 'linux-amd64',
		scheduleRestart: () => void (restarts += 1),
		fetch: (async (url: string | URL | Request) => {
			const body = files.get(String(url));
			return body ? new Response(body) : new Response('not found', { status: 404 });
		}) as typeof fetch,
	});
}

const read = (path: string) => readFileSync(path, 'utf8');

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'skiff-node-update-'));
	files = new Map();
	restarts = 0;
	const { agentBinary, helperBinary } = paths();
	await fs.mkdir(join(agentBinary, '..'), { recursive: true });
	await fs.mkdir(join(helperBinary, '..'), { recursive: true });
	writeFileSync(agentBinary, 'agent old');
	writeFileSync(helperBinary, 'helper old');
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('node update (D99)', () => {
	test('installs a verified bundle, keeps the previous binaries and schedules the restart', async () => {
		publish();
		const result = await updater().update({ version: '0.8.0', repo: REPO });
		const { agentBinary, helperBinary, workDir } = paths();
		expect(result).toMatchObject({ version: '0.8.0', previous: '0.7.15' });
		expect(read(agentBinary)).toBe('agent 0.8.0');
		expect(read(helperBinary)).toBe('helper 0.8.0');
		expect(read(`${agentBinary}.previous`)).toBe('agent old');
		expect(read(`${helperBinary}.previous`)).toBe('helper old');
		expect((await fs.stat(agentBinary)).mode & 0o777).toBe(0o755);
		expect(restarts).toBe(1);
		await expect(fs.stat(workDir)).rejects.toThrow();
	});

	test('a manifest signed by an unknown key changes nothing', async () => {
		publish({ signWith: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/not trusted/);
		expect(read(paths().agentBinary)).toBe('agent old');
		expect(restarts).toBe(0);
	});

	test('a bundle that does not match its signed checksum is never unpacked', async () => {
		publish({ tamper: true });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/signed checksum/);
		expect(read(paths().agentBinary)).toBe('agent old');
		expect(read(paths().helperBinary)).toBe('helper old');
	});

	test('a bundle with anything besides the two binaries is refused', async () => {
		publish({ members: { 'skiff-agent': 'a', 'skiff-helper': 'h', 'evil.sh': 'x' } });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/must contain exactly/);
		expect(read(paths().agentBinary)).toBe('agent old');
	});

	test('refuses a downgrade, a mislabelled manifest and a release without node bundles', async () => {
		publish({ version: '0.7.0' });
		await expect(updater().update({ version: '0.7.0', repo: REPO })).rejects.toThrow(/downgrade/);
		publish({ version: '0.8.1', manifestVersion: '0.9.0' });
		await expect(updater().update({ version: '0.8.1', repo: REPO })).rejects.toThrow(/mislabelled/);
		publish({ version: '0.8.2', noNodeArtifacts: true });
		await expect(updater().update({ version: '0.8.2', repo: REPO })).rejects.toThrow(/predates node updates/);
		await expect(updater().update({ version: '0.9.9', repo: REPO })).rejects.toThrow(/no signed manifest/);
		expect(read(paths().agentBinary)).toBe('agent old');
	});

	test('refuses a control-plane release layout (skiff-update-self owns it)', async () => {
		const { releaseLink } = paths();
		const release = join(root, 'opt/skiff/releases/r1');
		await fs.mkdir(join(release, 'agent'), { recursive: true });
		writeFileSync(join(release, 'agent/skiff-agent'), 'agent release');
		await fs.rm(releaseLink, { recursive: true });
		await fs.symlink(release, releaseLink);
		publish();
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/skiff-update-self/);
		expect(read(join(release, 'agent/skiff-agent'))).toBe('agent release');
	});

	test('validates the request strictly', () => {
		expect(parseNodeUpdateRequest({ version: '1.2.3', repo: 'a/b' })).toEqual({ version: '1.2.3', repo: 'a/b' });
		for (const body of [
			{ version: '1.2', repo: 'a/b' },
			{ version: '1.2.3-rc.1', repo: 'a/b' },
			{ version: '1.2.3', repo: 'https://evil/x' },
			{ version: '1.2.3', repo: 'a/b', path: '/bin/sh' },
			[],
		])
			expect(() => parseNodeUpdateRequest(body)).toThrow(ValidationError);
		expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
		expect(compareVersions('0.7.15', '0.7.15')).toBe(0);
	});

	test('is a fixed verb on the helper socket: 404 without an updater, 400 bad input, 409 refusal', async () => {
		const runtime = {} as HelperRuntime;
		const post = (body: unknown) =>
			new Request('http://localhost/v1/node/update', { method: 'POST', body: JSON.stringify(body) });
		expect((await createHandler(runtime, { version: '0.7.15' })(post({ version: '0.8.0', repo: REPO }))).status).toBe(404);
		const handler = createHandler(runtime, {
			version: '0.7.15',
			nodeUpdate: {
				update: async () => {
					throw new NodeUpdateError('refused');
				},
			},
		});
		expect((await handler(post({ version: 'latest', repo: REPO }))).status).toBe(400);
		const refused = await handler(post({ version: '0.8.0', repo: REPO }));
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: 'refused' });
	});
});
