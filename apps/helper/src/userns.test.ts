import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CONTAINERS_SUBID_COUNT,
	CONTAINERS_SUBID_START,
	CONTAINERS_SUBID_USER,
	ensureContainerSubids,
	withContainersSubids
} from './userns.ts';

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function tempFiles(contents: { subuid?: string; subgid?: string } = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'yoal-userns-'));
	directories.push(directory);
	const subuid = join(directory, 'subuid');
	const subgid = join(directory, 'subgid');
	if (contents.subuid !== undefined) await writeFile(subuid, contents.subuid, { mode: 0o644 });
	if (contents.subgid !== undefined) await writeFile(subgid, contents.subgid, { mode: 0o644 });
	return { subuid, subgid };
}

describe('withContainersSubids', () => {
	test('appends the reserved range to an empty file', () => {
		expect(withContainersSubids('', 'subuid')).toBe(
			`${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`
		);
	});

	test('appends on a new line when the file has no trailing newline', () => {
		expect(withContainersSubids('root:1000:65536', 'subuid')).toBe(
			`root:1000:65536\n${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`
		);
	});

	test('keeps an operator-provided containers entry untouched', () => {
		expect(withContainersSubids('containers:100000:65536\n', 'subuid')).toBeNull();
	});

	test('leaves ranges outside the reserved block alone', () => {
		expect(withContainersSubids('# rootless range\nroot:100000:65536\n', 'subuid')).toBe(
			`# rootless range\nroot:100000:65536\n${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`
		);
	});

	test('refuses to append over another account range', () => {
		const clash = `someone:${CONTAINERS_SUBID_START + 10}:65536\n`;
		expect(() => withContainersSubids(clash, 'subuid')).toThrow(/overlap/);
		expect(() => withContainersSubids(`someone:${CONTAINERS_SUBID_START - 1}:2\n`, 'subgid')).toThrow(
			/overlap/
		);
		// A range that ends exactly where the reserved block starts is fine.
		expect(
			withContainersSubids(`someone:${CONTAINERS_SUBID_START - 65536}:65536\n`, 'subgid')
		).toContain(CONTAINERS_SUBID_USER);
	});

	test('ignores comments, blank lines and malformed entries', () => {
		const text = '\n# comment\nbroken\nnot:numbers:here\n';
		expect(withContainersSubids(text, 'subuid')).toBe(
			`${text}${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`
		);
	});
});

describe('ensureContainerSubids', () => {
	test('creates missing files, is idempotent and keeps existing entries', async () => {
		const files = await tempFiles({ subuid: 'root:100000:65536\n' });

		expect(await ensureContainerSubids(files)).toBe(true);
		const subuid = await readFile(files.subuid, 'utf8');
		const subgid = await readFile(files.subgid, 'utf8');
		expect(subuid.startsWith('root:100000:65536\n')).toBe(true);
		expect(subuid).toContain(`${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}`);
		expect(subgid).toBe(`${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`);
		expect((await stat(files.subgid)).mode & 0o777).toBe(0o644);

		// Second start writes nothing.
		expect(await ensureContainerSubids(files)).toBe(false);
		expect(await readFile(files.subuid, 'utf8')).toBe(subuid);
	});

	test('keeps a range an operator added by hand', async () => {
		const files = await tempFiles({
			subuid: 'containers:200000:65536\n',
			subgid: 'containers:300000:65536\n'
		});
		expect(await ensureContainerSubids(files)).toBe(false);
		expect(await readFile(files.subuid, 'utf8')).toBe('containers:200000:65536\n');
		expect(await readFile(files.subgid, 'utf8')).toBe('containers:300000:65536\n');
	});

	test('fails without writing either file when one has an overlapping range', async () => {
		const files = await tempFiles({ subuid: `someone:${CONTAINERS_SUBID_START}:10\n` });
		await expect(ensureContainerSubids(files)).rejects.toThrow(/overlap/);
		expect(await readFile(files.subuid, 'utf8')).toBe(`someone:${CONTAINERS_SUBID_START}:10\n`);

		// The first file is checked before either is written, so a bad subgid cannot leave a new
		// subuid behind.
		const second = await tempFiles({ subgid: `someone:${CONTAINERS_SUBID_START}:10\n` });
		await expect(ensureContainerSubids(second)).rejects.toThrow(/overlap/);
		await expect(readFile(second.subuid, 'utf8')).rejects.toThrow();
	});
});
