import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_DIGESTS, NODE_PINNED_VERSION, ensureNode, hasSkiffNode, nodeArch, nodeTarballUrl } from './node.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-node-install-'));
	dirs.push(dir);
	return dir;
}

/** A tarball shaped like the official one: `node-v<version>-linux-x64/bin/{node,npm,npx}`. */
function tarball(version: string): Uint8Array {
	const work = temp();
	const top = join(work, `node-v${version}-linux-x64`);
	mkdirSync(join(top, 'bin'), { recursive: true });
	mkdirSync(join(top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
	writeFileSync(join(top, 'bin', 'node'), `#!/bin/sh\necho v${version}\n`);
	chmodSync(join(top, 'bin', 'node'), 0o755);
	writeFileSync(join(top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
	symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(top, 'bin', 'npm'));
	const out = join(work, 'node.tar.gz');
	const result = Bun.spawnSync(['tar', '-czf', out, '-C', work, `node-v${version}-linux-x64`]);
	if (result.exitCode !== 0) throw new Error('tar failed');
	return new Uint8Array(readFileSync(out));
}

const respond = (body: Uint8Array, calls: string[] = []) =>
	(async (url: string) => {
		calls.push(url);
		return new Response(body);
	}) as unknown as typeof fetch;

describe('Node.js installer (D125)', () => {
	test('maps architectures and builds the official tarball URL', () => {
		expect(nodeArch('x86_64')).toBe('amd64');
		expect(nodeArch('aarch64')).toBe('arm64');
		expect(nodeArch('riscv64')).toBeNull();
		expect(nodeTarballUrl('26.13.0', 'amd64')).toBe('https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.gz');
		expect(nodeTarballUrl('26.13.0', 'arm64')).toBe('https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-arm64.tar.gz');
		expect(() => nodeTarballUrl('lts', 'amd64')).toThrow();
	});

	test('the pin carries a digest for every architecture', () => {
		expect(NODE_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		for (const digest of Object.values(NODE_DIGESTS)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
	});

	test('installs a verified tree and links node, npm and npx onto PATH', async () => {
		const dir = temp();
		const body = tarball('9.9.9');
		const calls: string[] = [];
		const options = {
			arch: 'amd64' as const,
			version: '9.9.9',
			sha256: createHash('sha256').update(body).digest('hex'),
			destDir: join(dir, 'lib'),
			binDir: join(dir, 'bin'),
		};
		expect(await ensureNode({ ...options, fetch: respond(body, calls) })).toBe('installed');
		expect(calls).toEqual([nodeTarballUrl('9.9.9', 'amd64')]);
		const home = join(dir, 'lib', '9.9.9');
		expect(readlinkSync(join(dir, 'bin', 'node'))).toBe(join(home, 'bin', 'node'));
		expect(readlinkSync(join(dir, 'bin', 'npm'))).toBe(join(home, 'bin', 'npm'));
		// The tarball has no npx here, so nothing is linked for it.
		expect(existsSync(join(dir, 'bin', 'npx'))).toBe(false);
		expect(existsSync(join(dir, 'lib', '.9.9.9.partial'))).toBe(false);
		expect(hasSkiffNode(join(dir, 'bin'), join(dir, 'lib'))).toBe(true);

		// Second run: present, no download.
		const again = await ensureNode({
			...options,
			fetch: (async () => {
				throw new Error('must not download');
			}) as unknown as typeof fetch,
		});
		expect(again).toBe('present');
	});

	test("keeps the operator's own node", async () => {
		const dir = temp();
		const body = tarball('9.9.9');
		mkdirSync(join(dir, 'bin'), { recursive: true });
		writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\necho mine\n');
		const logs: string[] = [];
		await ensureNode({
			arch: 'amd64',
			version: '9.9.9',
			sha256: createHash('sha256').update(body).digest('hex'),
			destDir: join(dir, 'lib'),
			binDir: join(dir, 'bin'),
			fetch: respond(body),
			log: (message) => logs.push(message),
		});
		expect(readFileSync(join(dir, 'bin', 'node'), 'utf8')).toContain('mine');
		expect(logs.some((line) => line.includes("not Skiff's Node.js link"))).toBe(true);
		expect(hasSkiffNode(join(dir, 'bin'), join(dir, 'lib'))).toBe(false);
	});

	test('refuses a download whose digest does not match and installs nothing', async () => {
		const dir = temp();
		await expect(
			ensureNode({
				arch: 'amd64',
				version: '9.9.9',
				sha256: 'f'.repeat(64),
				destDir: join(dir, 'lib'),
				binDir: join(dir, 'bin'),
				fetch: respond(tarball('9.9.9')),
			}),
		).rejects.toThrow(/digest mismatch/);
		expect(existsSync(join(dir, 'lib', '9.9.9'))).toBe(false);
		expect(existsSync(join(dir, 'bin', 'node'))).toBe(false);
	});

	test('an unpinned version needs an explicit digest', async () => {
		await expect(ensureNode({ arch: 'amd64', version: '1.2.3', dryRun: true })).rejects.toThrow(/No pinned digest/);
		expect(await ensureNode({ arch: 'arm64', dryRun: true, destDir: join(temp(), 'lib') })).toBe('would-install');
	});
});
