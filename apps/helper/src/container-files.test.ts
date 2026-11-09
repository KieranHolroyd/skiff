import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerFileError, ContainerFilesystem, looksBinary, normalizeContainerPath, type FdView } from './container-files.ts';

/** `/proc/self/fd` does not exist on every dev machine; the real path of the opened name is equivalent here. */
const testFdView: FdView = {
	realPath: (_fd, opened) => realpathSync(opened),
	dirPath: (_fd, opened) => opened,
};

let base: string;
let rootfs: string;
let data: string;
let host: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), 'yoal-ctr-files-')));
	rootfs = join(base, 'merged');
	data = join(base, 'data');
	host = join(base, 'host');
	for (const dir of [rootfs, data, host, join(rootfs, 'etc'), join(rootfs, 'app'), join(rootfs, 'usr/lib'), join(rootfs, 'data'), join(rootfs, 'tmp')])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(rootfs, 'etc/hostname'), 'container\n');
	writeFileSync(join(rootfs, 'usr/lib/libc.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
	writeFileSync(join(data, 'notes.txt'), 'kept on the volume');
	writeFileSync(join(host, 'shadow'), 'root:host-secret');
	symlinkSync('usr/lib', join(rootfs, 'lib'));
	symlinkSync('/etc/hostname', join(rootfs, 'app/hostname-link'));
	symlinkSync('../../etc', join(rootfs, 'app/up'));
	// Absolute and relative escapes towards the host file next to the rootfs.
	symlinkSync(join(host, 'shadow'), join(rootfs, 'app/host-abs'));
	symlinkSync('../../host/shadow', join(rootfs, 'app/host-rel'));
	symlinkSync('loop-b', join(rootfs, 'app/loop-a'));
	symlinkSync('loop-a', join(rootfs, 'app/loop-b'));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function filesystem(): ContainerFilesystem {
	return new ContainerFilesystem(
		[
			{ destination: '/', source: rootfs, type: 'rootfs', readOnly: true, note: null },
			{ destination: '/data', source: data, type: 'bind', readOnly: false, note: null },
			{ destination: '/run/yoal-secrets', source: null, type: 'bind', readOnly: true, note: 'secrets' },
			{ destination: '/tmp', source: null, type: 'tmpfs', readOnly: false, note: 'tmpfs' },
		],
		testFdView,
	);
}

describe('normalizeContainerPath', () => {
	test('collapses dots and refuses relative or NUL paths', () => {
		expect(normalizeContainerPath('/a/./b/../c/')).toBe('/a/c');
		expect(normalizeContainerPath('/../..')).toBe('/');
		expect(() => normalizeContainerPath('etc')).toThrow('absolute');
		expect(() => normalizeContainerPath('/etc\0x')).toThrow('NUL');
	});
});

describe('ContainerFilesystem', () => {
	test('lists the root with mount points and links', () => {
		const listing = filesystem().list('/', 100);
		const names = listing.entries.map((entry) => entry.name);
		expect(names).toContain('etc');
		expect(names).toContain('data');
		expect(listing.entries.find((entry) => entry.name === 'lib')).toMatchObject({ kind: 'symlink', linkTarget: 'usr/lib' });
		expect(listing.mount).toBe('/');
		expect(listing.readOnly).toBe(true);
	});

	test('follows in-container symlinks relative to the container root', () => {
		const fs = filesystem();
		expect(fs.resolve('/lib/libc.so')).toBe('/usr/lib/libc.so');
		expect(fs.resolve('/app/hostname-link')).toBe('/etc/hostname');
		expect(fs.resolve('/app/up/hostname')).toBe('/etc/hostname');
		expect(fs.preview('/app/hostname-link', 1024).content).toBe('container\n');
	});

	test('reads through bind mounts', () => {
		const fs = filesystem();
		const listing = fs.list('/data', 100);
		expect(listing.mount).toBe('/data');
		expect(listing.readOnly).toBe(false);
		expect(listing.entries.map((entry) => entry.name)).toEqual(['notes.txt']);
		expect(fs.preview('/data/notes.txt', 1024).content).toBe('kept on the volume');
	});

	test('an absolute link to a host path is resolved inside the container, never on the host', () => {
		const fs = filesystem();
		// Inside the container that path does not exist.
		expect(() => fs.preview('/app/host-abs', 1024)).toThrow(ContainerFileError);
	});

	test('a relative link cannot climb out of the root', () => {
		const fs = filesystem();
		// `../../host/shadow` from /app is /host/shadow inside the container, which does not exist.
		expect(() => fs.resolve('/app/host-rel')).toThrow('/host');
		expect(() => fs.preview('/app/host-rel', 1024)).toThrow(ContainerFileError);
	});

	test('a descriptor that lands outside the root is refused after open', () => {
		// Simulate a link swapped in between resolution and open: the descriptor check catches it.
		const swapped: FdView = { realPath: () => join(host, 'shadow'), dirPath: (_fd, opened) => opened };
		const fs = new ContainerFilesystem([{ destination: '/', source: rootfs, type: 'rootfs', readOnly: true, note: null }], swapped);
		expect(() => fs.preview('/etc/hostname', 1024)).toThrow('leaves the container');
	});

	test('refuses secrets and tmpfs mounts', () => {
		const fs = filesystem();
		expect(() => fs.list('/run/yoal-secrets', 10)).toThrow('Secret files are not shown');
		expect(() => fs.list('/tmp', 10)).toThrow('tmpfs');
	});

	test('symlink loops end with an error', () => {
		expect(() => filesystem().resolve('/app/loop-a')).toThrow('Too many levels');
	});

	test('previews flag binary and oversized files', () => {
		const fs = filesystem();
		expect(fs.preview('/usr/lib/libc.so', 1024)).toMatchObject({ content: null, reason: 'binary' });
		expect(fs.preview('/etc/hostname', 3)).toMatchObject({ content: null, reason: 'too-large' });
	});

	test('open returns a descriptor only for regular files', () => {
		const fs = filesystem();
		const file = fs.open('/etc/hostname');
		expect(file.sizeBytes).toBe(10);
		expect(file.name).toBe('hostname');
		closeSync(file.fd);
		expect(() => fs.open('/etc')).toThrow('regular files');
	});

	test('truncates long listings', () => {
		for (let index = 0; index < 5; index++) writeFileSync(join(data, `f${index}`), '');
		const listing = filesystem().list('/data', 3);
		expect(listing.entries).toHaveLength(3);
		expect(listing.truncated).toBe(true);
	});
});

test('looksBinary', () => {
	expect(looksBinary(new TextEncoder().encode('plain text ✓'))).toBe(false);
	expect(looksBinary(new Uint8Array([0x41, 0, 0x42]))).toBe(true);
	expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(true);
});
