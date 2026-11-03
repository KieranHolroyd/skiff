import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { applySpaConfig, buildZip, collectFiles, crc32, readEntries } from './zip.ts';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-zip-'));
	await mkdir(join(dir, 'src'), { recursive: true });
	await mkdir(join(dir, 'assets', 'nested'), { recursive: true });
	await mkdir(join(dir, 'sub'), { recursive: true });
	await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
	await mkdir(join(dir, '.git'), { recursive: true });

	await writeFile(
		join(dir, '.gitignore'),
		['*.log', '!important.log', 'node_modules', 'sub/*.tmp', '!node_modules/keep.txt'].join('\n'),
	);
	await writeFile(join(dir, '.DS_Store'), 'junk');
	await writeFile(join(dir, '.git', 'config'), 'secret');
	await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
	await writeFile(join(dir, 'node_modules', 'keep.txt'), 'should stay excluded');
	await writeFile(join(dir, 'src', 'index.html'), '<h1>Hello</h1>');
	await writeFile(join(dir, 'assets', 'nested', 'app.js'), 'console.log("hi")');
	await writeFile(join(dir, 'keep.txt'), 'keep');
	await writeFile(join(dir, 'ignored.log'), 'ignored');
	await writeFile(join(dir, 'important.log'), 'important');
	await writeFile(join(dir, 'sub', '.gitignore'), 'secret.txt');
	await writeFile(join(dir, 'sub', 'secret.txt'), 'secret');
	await writeFile(join(dir, 'sub', 'keep.txt'), 'sub keep');
	await writeFile(join(dir, 'sub', 'drop.tmp'), 'drop');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('collectFiles', () => {
	test('excludes VCS metadata, node_modules and .gitignore matches', async () => {
		const collected = await collectFiles(dir);
		expect(collected.files.map((file) => file.path)).toEqual([
			'.gitignore',
			'assets/nested/app.js',
			'important.log',
			'keep.txt',
			'src/index.html',
			'sub/.gitignore',
			'sub/keep.txt',
		]);
		expect(collected.files.every((file) => !file.path.includes('node_modules'))).toBe(true);
		expect(collected.totalBytes).toBeGreaterThan(0);
	});

	test('rejects an empty deployment', async () => {
		const empty = await mkdtemp(join(tmpdir(), 'skiff-cli-empty-'));
		try {
			await expect(collectFiles(empty)).rejects.toThrow('No files to deploy');
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});

describe('crc32', () => {
	test('matches the standard check value', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});
});

describe('buildZip', () => {
	test('writes a valid archive with the expected entries and contents', async () => {
		const collected = await collectFiles(dir);
		const zip = buildZip(await readEntries(collected.files));
		const entries = readZip(zip);

		expect([...entries.keys()]).toEqual([
			'.gitignore',
			'assets/nested/app.js',
			'important.log',
			'keep.txt',
			'src/index.html',
			'sub/.gitignore',
			'sub/keep.txt',
		]);
		expect(entries.get('src/index.html')).toBe('<h1>Hello</h1>');
		expect(entries.get('assets/nested/app.js')).toBe('console.log("hi")');
	});

	test('--spa merges into an existing skiff.json', () => {
		const entries = applySpaConfig([
			{
				path: 'skiff.json',
				data: new TextEncoder().encode('{"cleanUrls":true,"spa":false}'),
			},
			{ path: 'index.html', data: new TextEncoder().encode('<html></html>') },
		]);
		const skiffJson = entries.find((entry) => entry.path === 'skiff.json');
		expect(skiffJson).toBeDefined();
		const parsed = JSON.parse(new TextDecoder().decode(skiffJson!.data)) as Record<string, unknown>;
		expect(parsed).toEqual({ cleanUrls: true, spa: true });
	});
});

/** Read names and (inflated) contents from a zip produced by `buildZip`. */
function readZip(zip: Uint8Array): Map<string, string> {
	const buffer = Buffer.from(zip);
	let eocd = -1;
	for (let offset = buffer.length - 22; offset >= 0; offset--) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd === -1) throw new Error('No end-of-central-directory record');

	const count = buffer.readUInt16LE(eocd + 10);
	let central = buffer.readUInt32LE(eocd + 16);
	const out = new Map<string, string>();

	for (let index = 0; index < count; index++) {
		if (buffer.readUInt32LE(central) !== 0x02014b50) throw new Error('Bad central directory record');
		const method = buffer.readUInt16LE(central + 10);
		const compressedSize = buffer.readUInt32LE(central + 20);
		const nameLength = buffer.readUInt16LE(central + 28);
		const extraLength = buffer.readUInt16LE(central + 30);
		const commentLength = buffer.readUInt16LE(central + 32);
		const localOffset = buffer.readUInt32LE(central + 42);
		const name = buffer.toString('utf8', central + 46, central + 46 + nameLength);

		if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bad local header');
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const payload = buffer.subarray(dataStart, dataStart + compressedSize);
		const data = method === 8 ? inflateRawSync(payload) : payload;
		out.set(name, data.toString('utf8'));

		central += 46 + nameLength + extraLength + commentLength;
	}
	return out;
}
