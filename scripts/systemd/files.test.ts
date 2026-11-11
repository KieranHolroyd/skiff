import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesEqual, sha256File } from './files.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-files-'));

describe('sha256File', () => {
	test('matches a one-shot hash across several chunks', () => {
		const path = join(root, 'binary');
		const body = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
		writeFileSync(path, body);
		expect(sha256File(path)).toBe(createHash('sha256').update(body).digest('hex'));
		rmSync(path, { force: true });
	});
});

describe('filesEqual', () => {
	test('is true for identical files and false when a byte differs', () => {
		const a = join(root, 'a');
		const b = join(root, 'b');
		writeFileSync(a, Buffer.alloc(1024 * 1024 + 3, 1));
		writeFileSync(b, Buffer.alloc(1024 * 1024 + 3, 1));
		expect(filesEqual(a, b)).toBe(true);
		const changed = Buffer.alloc(1024 * 1024 + 3, 1);
		changed[changed.length - 1] = 2;
		writeFileSync(b, changed);
		expect(filesEqual(a, b)).toBe(false);
		rmSync(a, { force: true });
		rmSync(b, { force: true });
	});

	test('short-circuits on different sizes and missing files', () => {
		const a = join(root, 'a-size');
		const b = join(root, 'b-size');
		writeFileSync(a, 'one');
		writeFileSync(b, 'three');
		expect(filesEqual(a, b)).toBe(false);
		expect(filesEqual(join(root, 'missing'), b)).toBe(false);
		expect(filesEqual(a, join(root, 'missing'))).toBe(false);
		rmSync(a, { force: true });
		rmSync(b, { force: true });
	});
});
