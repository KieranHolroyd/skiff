import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { desiredStateSchema } from '@skiff/contracts';
import { extractZip, ReleaseManager, safeEntryPath } from './releases.ts';

interface ZipInput {
	name: string;
	data?: string | Uint8Array;
	mode?: number;
	method?: 0 | 8;
	crcOverride?: number;
}

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-releases-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Tiny zip writer for tests (stored or deflate, Unix modes, CRC). */
function makeZip(entries: ZipInput[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? '');
		const method = entry.method ?? 0;
		const compressed = method === 8 ? deflateRawSync(data) : data;
		const crc = entry.crcOverride ?? crc32(data) >>> 0;
		const name = Buffer.from(entry.name);
		const mode = entry.mode ?? 0o100644;
		const flags = 0x800;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);

		locals.push(local, name, compressed);
		centrals.push(central, name);
		offset += local.length + name.length + compressed.length;
	}

	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, cd, eocd]);
}

describe('safeEntryPath', () => {
	test('normalizes safe paths', () => {
		expect(safeEntryPath('index.html')).toBe('index.html');
		expect(safeEntryPath('assets/app.js')).toBe('assets/app.js');
		expect(safeEntryPath('a\\b.txt')).toBe('a/b.txt');
		expect(safeEntryPath('./a//b')).toBe('a/b');
	});

	test('rejects traversal, absolute paths and drive letters', () => {
		for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:/Windows', '..\\evil', '', './']) {
			expect(() => safeEntryPath(bad)).toThrow();
		}
	});

	test('rejects NUL and overlong names', () => {
		expect(() => safeEntryPath('a\0b')).toThrow();
		expect(() => safeEntryPath('a'.repeat(5000))).toThrow();
	});
});

describe('extractZip', () => {
	test('extracts stored and deflated files', async () => {
		const root = await tempDir();
		const destination = join(root, 'dest');
		const result = await extractZip(
			makeZip([
				{ name: 'dir/', mode: 0o040755 },
				{ name: 'index.html', data: '<h1>hi</h1>' },
				{ name: 'dir/app.js', data: 'console.log(1)', method: 8 },
				{ name: 'index.html.br', data: Buffer.from([1, 2, 3]) },
			]),
			destination,
		);

		expect(result.files).toBe(3);
		expect(result.totalBytes).toBe(11 + 14 + 3);
		expect(await fs.readFile(join(destination, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
		expect(await fs.readFile(join(destination, 'dir/app.js'), 'utf8')).toBe('console.log(1)');
		expect(await fs.readFile(join(destination, 'index.html.br'))).toEqual(Buffer.from([1, 2, 3]));
	});

	test('rejects path traversal before writing outside the destination', async () => {
		const root = await tempDir();
		const destination = join(root, 'dest');
		await expect(
			extractZip(makeZip([{ name: '../escape.txt', data: 'nope' }]), destination),
		).rejects.toThrow(/traversal/i);
		await expect(fs.stat(join(root, 'escape.txt'))).rejects.toThrow();
	});

	test('rejects absolute paths', async () => {
		const root = await tempDir();
		await expect(
			extractZip(makeZip([{ name: '/tmp/evil', data: 'nope' }]), join(root, 'dest')),
		).rejects.toThrow(/Absolute path/i);
	});

	test('rejects symlink entries', async () => {
		const root = await tempDir();
		await expect(
			extractZip(makeZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]), join(root, 'dest')),
		).rejects.toThrow(/Symlink/i);
	});

	test('rejects duplicate entries', async () => {
		const root = await tempDir();
		await expect(
			extractZip(
				makeZip([
					{ name: 'a.txt', data: 'one' },
					{ name: 'a.txt', data: 'two' },
				]),
				join(root, 'dest'),
			),
		).rejects.toThrow(/Duplicate/i);
	});

	test('verifies the CRC of every file', async () => {
		const root = await tempDir();
		const archive = makeZip([{ name: 'a.txt', data: 'hello' }]);
		// Flip a byte in the stored file data; the central directory CRC stays valid.
		archive[30 + 'a.txt'.length] = 0x48;
		await expect(extractZip(archive, join(root, 'dest'))).rejects.toThrow(/CRC mismatch/i);
	});

	test('refuses a non-empty destination', async () => {
		const root = await tempDir();
		const destination = join(root, 'dest');
		await fs.mkdir(destination, { recursive: true });
		await fs.writeFile(join(destination, 'keep.txt'), 'keep');
		await expect(
			extractZip(makeZip([{ name: 'a.txt', data: 'x' }]), destination),
		).rejects.toThrow(/not empty/i);
	});

	test('rejects encrypted entries', async () => {
		const root = await tempDir();
		const archive = makeZip([{ name: 'a.txt', data: 'x' }]);
		archive.writeUInt16LE(0x801, 6);
		// Keep the central-directory copy consistent enough to reach the encryption check.
		const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		archive.writeUInt16LE(0x801, central + 8);
		await expect(extractZip(archive, join(root, 'dest'))).rejects.toThrow(/Encrypted/i);
	});
});

describe('ReleaseManager', () => {
	const PROD = 'd'.repeat(64);
	const PREVIEW = 'e'.repeat(64);

	function route(projectId: string, host: string, release: string, extra: Record<string, unknown> = {}) {
		return {
			projectId,
			slug: projectId,
			host,
			deploymentId: `dep_${release.slice(0, 4)}`,
			release,
			access: { mode: 'public', siteKey: 'site-key-0123456789', loginUrl: 'https://cloud.example.com/login' },
			accessMode: 'public',
			spa: false,
			cleanUrls: false,
			trailingSlash: 'ignore',
			notFound: null,
			...extra,
		};
	}

	test('gc keeps production symlinks and every local release, and drops the rest', async () => {
		const dir = await tempDir();
		const manager = new ReleaseManager(dir);
		await manager.init();
		for (const sha of [PROD, PREVIEW]) await fs.mkdir(join(dir, 'releases', sha), { recursive: true });
		await manager.activate('blog', PROD);
		await manager.activate('gone', PREVIEW);

		const desired = desiredStateSchema.parse({
			version: 1,
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			generatedAt: new Date().toISOString(),
			contentDomain: 'example.com',
			releases: [],
			routes: [
				route('blog', 'blog.example.com', PROD, { production: true }),
				route('blog', 'blog--x1.example.com', PREVIEW, { production: false }),
			],
		});
		await manager.gc(desired);

		expect(await fs.readlink(join(dir, 'sites', 'blog'))).toBe(join(dir, 'releases', PROD));
		await expect(fs.lstat(join(dir, 'sites', 'gone'))).rejects.toThrow();
		expect(await manager.hasRelease(PREVIEW)).toBe(true);
	});
});
