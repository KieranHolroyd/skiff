import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareMounter } from './shares.ts';
import type { CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-shares-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runner(calls: string[][], mountCode = 0): CommandRunner {
	return async (argv) => {
		calls.push(argv);
		if (argv[0] === 'mountpoint') return { code: 1, stdout: '', stderr: '' };
		if (argv[0] === 'mount') return { code: mountCode, stdout: '', stderr: mountCode ? 'permission denied' : '' };
		return { code: 0, stdout: '', stderr: '' };
	};
}

describe('ShareMounter', () => {
	test('mounts an NFS export read-only under the run directory', async () => {
		const calls: string[][] = [];
		const mounter = new ShareMounter({ root: join(dir, 'nfs'), runner: runner(calls) });
		const result = await mounter.mount({
			id: 'media',
			protocol: 'nfs',
			server: '10.0.0.5',
			exportPath: '/mnt/media',
			readOnly: true,
		});
		expect(result).toMatchObject({ id: 'media', mounted: true, error: null });
		expect(calls.some((call) => call[0] === 'mount' && call.includes('nfs') && call.some((arg) => arg.startsWith('ro,')))).toBe(true);
	});

	test('writes and removes an SMB credentials file', async () => {
		const calls: string[][] = [];
		const mounter = new ShareMounter({ root: join(dir, 'smb'), runner: runner(calls) });
		const result = await mounter.mount({
			id: 'backups',
			protocol: 'smb',
			server: 'nas.home',
			exportPath: '/backups',
			readOnly: false,
			username: 'skiff',
			password: 'secret',
		});
		expect(result.mounted).toBe(true);
		expect(calls.some((call) => call[0] === 'mount' && call.some((arg) => arg.includes('credentials=')))).toBe(true);
	});

	test('reports a failed mount and cleans up', async () => {
		const mounter = new ShareMounter({ root: join(dir, 'bad'), runner: runner([], 32) });
		const result = await mounter.mount({
			id: 'broken',
			protocol: 'nfs',
			server: '10.0.0.5',
			exportPath: '/x',
			readOnly: true,
		});
		expect(result).toMatchObject({ mounted: false, error: 'permission denied' });
	});

	test('refuses invalid ids, servers and export paths', async () => {
		const mounter = new ShareMounter({ root: join(dir, 'invalid'), runner: runner([]) });
		await expect(
			mounter.mount({ id: '../etc', protocol: 'nfs', server: 'x', exportPath: '/x', readOnly: true }),
		).rejects.toThrow(/invalid share id/);
		await expect(
			mounter.mount({ id: 'okay', protocol: 'nfs', server: 'x;rm', exportPath: '/x', readOnly: true }),
		).rejects.toThrow(/invalid share server/);
		await expect(
			mounter.mount({ id: 'okay2', protocol: 'nfs', server: 'x', exportPath: 'relative', readOnly: true }),
		).rejects.toThrow(/invalid export path/);
	});
});
