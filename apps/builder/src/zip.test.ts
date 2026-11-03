import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { zipDirectory } from './zip.ts';
import { BuildValidationError } from './command.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-builder-zip-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(): string {
	const dir = mkdtempSync(join(root, 'out-'));
	mkdirSync(join(dir, 'assets'), { recursive: true });
	writeFileSync(join(dir, 'index.html'), '<h1>hello</h1>');
	writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');
	return dir;
}

describe('zipDirectory', () => {
	test('zips nested files with repository-style paths', async () => {
		const dir = fixture();
		const result = await zipDirectory(dir);
		expect(result.fileCount).toBe(2);
		expect(result.sizeBytes).toBe(Buffer.byteLength('<h1>hello</h1>') + Buffer.byteLength('console.log("hi")'));
		const files = unzipSync(result.zip);
		expect(Object.keys(files).sort()).toEqual(['assets/app.js', 'index.html']);
		expect(new TextDecoder().decode(files['index.html']!)).toBe('<h1>hello</h1>');
	});

	test('rejects an empty output directory', async () => {
		const dir = mkdtempSync(join(root, 'empty-'));
		await expect(zipDirectory(dir)).rejects.toThrow(BuildValidationError);
	});

	test('enforces per-file and total limits', async () => {
		const dir = fixture();
		await expect(zipDirectory(dir, { maxFileBytes: 4 })).rejects.toThrow(/larger than 4 bytes/);
		await expect(zipDirectory(dir, { maxFiles: 1 })).rejects.toThrow(/more than 1 files/);
		await expect(zipDirectory(dir, { maxBytes: 5 })).rejects.toThrow(/larger than 5 bytes/);
	});

	test('rejects a missing directory', async () => {
		await expect(zipDirectory(join(root, 'does-not-exist'))).rejects.toThrow(/not a directory/);
	});
});
