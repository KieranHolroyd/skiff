import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainMountError, ShareMounter } from './shares.ts';
import type { CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-shares-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface FakeOptions {
	mountCode?: number;
	mountStderr?: string;
	umountCode?: number;
	/** Paths `mountpoint -q` reports as mounted. Mutated by fake mount/umount calls. */
	mounted?: Set<string>;
	/** Capture the credentials file while the mount call runs. */
	onMount?: (argv: string[]) => void;
}

function runner(calls: string[][], options: FakeOptions = {}): CommandRunner {
	const mounted = options.mounted ?? new Set<string>();
	return async (argv) => {
		calls.push(argv);
		if (argv[0] === 'mountpoint') return { code: mounted.has(argv[2]!) ? 0 : 1, stdout: '', stderr: '' };
		if (argv[0] === 'mount') {
			options.onMount?.(argv);
			const code = options.mountCode ?? 0;
			if (code === 0) mounted.add(argv.at(-1)!);
			return { code, stdout: '', stderr: code ? (options.mountStderr ?? 'permission denied') : '' };
		}
		if (argv[0] === 'umount') {
			const code = options.umountCode ?? 0;
			if (code === 0) mounted.delete(argv[1]!);
			return { code, stdout: '', stderr: code ? 'target is busy' : '' };
		}
		return { code: 0, stdout: '', stderr: '' };
	};
}

function mounter(name: string, calls: string[][], options: FakeOptions = {}) {
	return new ShareMounter({
		root: join(dir, name, 'mnt'),
		credentialsDir: join(dir, name, 'run'),
		runner: runner(calls, options),
	});
}

describe('ShareMounter', () => {
	test('mounts an NFS export read-only with fixed options', async () => {
		const calls: string[][] = [];
		const result = await mounter('nfs', calls).mount({
			id: 'media',
			protocol: 'nfs',
			server: '10.0.0.5',
			exportPath: '/mnt/media',
			readOnly: true,
		});
		expect(result).toMatchObject({ id: 'media', mounted: true, error: null, mountPath: join(dir, 'nfs', 'mnt', 'media') });
		const mount = calls.find((call) => call[0] === 'mount')!;
		expect(mount.slice(0, 3)).toEqual(['mount', '-t', 'nfs']);
		expect(mount[4]!.split(',')).toEqual(['ro', 'hard', 'proto=tcp', 'noatime', 'nosuid', 'nodev']);
		expect(mount[5]).toBe('10.0.0.5:/mnt/media');
	});

	test('mounts SMB as //server/share and removes the credentials file afterwards', async () => {
		const calls: string[][] = [];
		let credentials = '';
		let credentialsPath = '';
		const result = await mounter('smb', calls, {
			onMount: (argv) => {
				credentialsPath = argv[4]!.split(',').find((option) => option.startsWith('credentials='))!.slice(12);
				credentials = readFileSync(credentialsPath, 'utf8');
			},
		}).mount({
			id: 'backups',
			protocol: 'smb',
			server: 'nas.home',
			exportPath: '/backups',
			readOnly: false,
			username: 'yoal',
			password: 'secret',
			domain: 'HOME',
		});
		expect(result.mounted).toBe(true);
		const mount = calls.find((call) => call[0] === 'mount')!;
		expect(mount.slice(0, 3)).toEqual(['mount', '-t', 'cifs']);
		expect(mount[4]!.startsWith('rw,vers=3.0,')).toBe(true);
		expect(mount[5]).toBe('//nas.home/backups');
		expect(credentials).toBe('username=yoal\npassword=secret\ndomain=HOME\n');
		// The credentials live outside the mount root and are gone once the mount returns.
		expect(credentialsPath.startsWith(join(dir, 'smb', 'run'))).toBe(true);
		expect(existsSync(credentialsPath)).toBe(false);
	});

	test('is idempotent: an existing mount is reported without mounting again', async () => {
		const calls: string[][] = [];
		const mountPath = join(dir, 'again', 'mnt', 'media');
		const result = await mounter('again', calls, { mounted: new Set([mountPath]) }).mount({
			id: 'media',
			protocol: 'smb',
			server: 'nas',
			exportPath: '/media',
			readOnly: false,
		});
		expect(result).toMatchObject({ mounted: true, error: null });
		expect(calls.some((call) => call[0] === 'mount')).toBe(false);
	});

	test('reports a failed mount with a hint and removes the empty mount point', async () => {
		const calls: string[][] = [];
		const result = await mounter('bad', calls, { mountCode: 32, mountStderr: 'mount: wrong fs type, bad option' }).mount({
			id: 'broken',
			protocol: 'nfs',
			server: '10.0.0.5',
			exportPath: '/x',
			readOnly: true,
		});
		expect(result.mounted).toBe(false);
		expect(result.error).toContain('nfs-common');
		expect(existsSync(join(dir, 'bad', 'mnt', 'broken'))).toBe(false);
	});

	test('unmount never deletes files: a busy share is reported and left in place', async () => {
		const calls: string[][] = [];
		const mountPath = join(dir, 'busy', 'mnt', 'media');
		mkdirSync(mountPath, { recursive: true });
		writeFileSync(join(mountPath, 'precious.txt'), 'data');
		const result = await mounter('busy', calls, { mounted: new Set([mountPath]), umountCode: 32 }).unmount('media');
		expect(result).toEqual({ id: 'media', mounted: true, error: 'target is busy' });
		expect(existsSync(join(mountPath, 'precious.txt'))).toBe(true);
	});

	test('unmount removes only an empty mount point', async () => {
		const calls: string[][] = [];
		const mountPath = join(dir, 'clean', 'mnt', 'media');
		mkdirSync(mountPath, { recursive: true });
		const result = await mounter('clean', calls, { mounted: new Set([mountPath]) }).unmount('media');
		expect(result).toEqual({ id: 'media', mounted: false, error: null });
		expect(existsSync(mountPath)).toBe(false);

		// Something left in an unmounted directory is not Yoal's to delete.
		const stray = join(dir, 'clean', 'mnt', 'stray');
		mkdirSync(stray, { recursive: true });
		writeFileSync(join(stray, 'file'), 'x');
		await mounter('clean', []).unmount('stray');
		expect(existsSync(join(stray, 'file'))).toBe(true);
	});

	test('status reports each mount point without credentials', async () => {
		const mountPath = join(dir, 'status', 'mnt', 'media');
		const statuses = await mounter('status', [], { mounted: new Set([mountPath]) }).status(['media', 'other']);
		expect(statuses.map((status) => [status.id, status.mounted])).toEqual([
			['media', true],
			['other', false],
		]);
	});

	test('refuses invalid ids, servers, paths and credentials', async () => {
		const m = mounter('invalid', []);
		await expect(m.mount({ id: '../etc', protocol: 'nfs', server: 'x', exportPath: '/x', readOnly: true })).rejects.toThrow(
			/invalid share id/,
		);
		await expect(m.mount({ id: 'okay', protocol: 'nfs', server: 'x;rm', exportPath: '/x', readOnly: true })).rejects.toThrow(
			/invalid share server/,
		);
		await expect(m.mount({ id: 'okay', protocol: 'nfs', server: 'x', exportPath: 'relative', readOnly: true })).rejects.toThrow(
			/invalid export path/,
		);
		await expect(m.mount({ id: 'okay', protocol: 'nfs', server: 'x', exportPath: '/a/../b', readOnly: true })).rejects.toThrow(
			/invalid export path/,
		);
		await expect(
			m.mount({ id: 'okay', protocol: 'smb', server: 'x', exportPath: '/a', readOnly: true, username: 'u', password: 'p\nx=1' }),
		).rejects.toThrow(/invalid SMB password/);
		await expect(
			m.mount({ id: 'okay', protocol: 'nfs', server: 'x', exportPath: '/a', readOnly: true, username: 'u' }),
		).rejects.toThrow(/NFS shares do not take SMB credentials/);
	});
});

describe('explainMountError', () => {
	test('adds an actionable hint for the common failures', () => {
		expect(explainMountError('smb', 'mount error(13): Permission denied')).toContain('username and password');
		expect(explainMountError('nfs', 'mount.nfs: Connection timed out')).toContain('port 2049');
		expect(explainMountError('smb', 'mount: bad option; you might need a /sbin/mount.<type> helper program')).toContain('cifs-utils');
		expect(explainMountError('nfs', 'something odd')).toBe('something odd');
	});
});
