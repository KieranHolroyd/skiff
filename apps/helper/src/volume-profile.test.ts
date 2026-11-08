import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fioJobFile, parseDdStats, parseFioOutput, VolumeProfiler } from './volume-profile.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-profile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIO_JSON = JSON.stringify({
	jobs: [
		{ jobname: 'seq-write', write: { bw: 512_000, iops: 500 }, read: { bw: 0, iops: 0 } },
		{ jobname: 'seq-read', read: { bw: 1_024_000, iops: 1000 }, write: { bw: 0, iops: 0 } },
		{ jobname: 'rand-read', read: { bw: 340_000, iops: 85_123.4 }, write: { bw: 0, iops: 0 } },
		{ jobname: 'rand-write', write: { bw: 240_000, iops: 60_456.7 }, read: { bw: 0, iops: 0 } },
		{ jobname: 'sync-write', write: { bw: 8_000, iops: 2_000 }, read: { bw: 0, iops: 0 } },
	],
});

function profiler(name: string, runner: (argv: string[]) => { code: number; stdout?: string; stderr?: string }, fio: boolean) {
	const mount = join(dir, name);
	const fioPath = join(dir, `${name}-fio`);
	if (fio) writeFileSync(fioPath, '');
	const calls: string[][] = [];
	const instance = new VolumeProfiler({
		runner: {
			run: async (argv) => {
				calls.push(argv);
				const result = runner(argv);
				return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
			},
		},
		registry: async () => ({ vol_1: { mountPath: mount, sourceKey: 'fs:abc', fsType: 'ext4' } }),
		verify: async ({ mountPath }) => ({ ok: mountPath === mount, mountPath, sourceKey: 'fs:abc', message: null }),
		fioPath,
		ddPath: '/usr/bin/dd',
		freeBytes: async () => 100 * 1024 * 1024 * 1024,
	});
	return { instance, calls, mount };
}

describe('VolumeProfiler', () => {
	test('runs one fio job file on the registered mount and cleans up the scratch dir', async () => {
		const { instance, calls, mount } = profiler('fio', () => ({ code: 0, stdout: `fio: warning\n${FIO_JSON}` }), true);
		const result = await instance.profile({ volumeId: 'vol_1', sizeMb: 256, runtimeSeconds: 10 });
		expect(result).toEqual({
			method: 'fio',
			seqWriteMBps: 500,
			seqReadMBps: 1000,
			randReadIops: 85123,
			randWriteIops: 60457,
			syncWriteIops: 2000,
			syncWriteLatencyUs: 500,
			direct: true,
			notes: [],
		});
		expect(calls[0]!.slice(1)).toEqual(['--output-format=json', join(mount, 'skiff', '.profile', 'profile.fio')]);
		expect(existsSync(join(mount, 'skiff', '.profile'))).toBe(false);
	});

	test('falls back to dd without fio, and retries without O_DIRECT when the filesystem refuses it', async () => {
		const { instance, calls } = profiler(
			'dd',
			(argv) => {
				if (argv.includes('oflag=direct')) return { code: 1, stderr: 'dd: failed to open: Invalid argument' };
				if (argv.some((arg) => arg.startsWith('of=') && arg.endsWith('sync.dat')))
					return { code: 0, stderr: '2048000 bytes (2.0 MB) copied, 0.5 s, 4.1 MB/s' };
				if (argv.includes('of=/dev/null')) return { code: 0, stderr: '268435456 bytes (268 MB, 256 MiB) copied, 0.5 s, 537 MB/s' };
				return { code: 0, stderr: '268435456 bytes (268 MB, 256 MiB) copied, 1.0 s, 268 MB/s' };
			},
			false,
		);
		const result = await instance.profile({ volumeId: 'vol_1', sizeMb: 256, runtimeSeconds: 10 });
		expect(result).toMatchObject({
			method: 'dd',
			seqWriteMBps: 256,
			seqReadMBps: 512,
			randReadIops: null,
			syncWriteIops: 1000,
			syncWriteLatencyUs: 1000,
			direct: false,
		});
		expect(result.notes.join(' ')).toContain('Install fio');
		// The read pass does not ask for O_DIRECT once the write showed it is unsupported.
		expect(calls.find((call) => call.includes('of=/dev/null'))).not.toContain('iflag=direct');
	});

	test('refuses unregistered or unmounted volumes and bad limits', async () => {
		const { instance } = profiler('refuse', () => ({ code: 0 }), false);
		await expect(instance.profile({ volumeId: 'vol_2', sizeMb: 256, runtimeSeconds: 10 })).rejects.toThrow(/not registered/);
		await expect(instance.profile({ volumeId: '../x', sizeMb: 256, runtimeSeconds: 10 })).rejects.toThrow(/volumeId/);
		await expect(instance.profile({ volumeId: 'vol_1', sizeMb: 10_000, runtimeSeconds: 10 })).rejects.toThrow(/sizeMb/);
	});

	test('job file and parsers', () => {
		const job = fioJobFile('/mnt/x/skiff/.profile/profile.dat', { volumeId: 'v', sizeMb: 128, runtimeSeconds: 5 }, true);
		expect(job).toContain('direct=1');
		expect(job).toContain('[sync-write]\nrw=randwrite\nbs=4k\niodepth=1\nioengine=psync\nfdatasync=1');
		expect(parseFioOutput(FIO_JSON).seqReadMBps).toBe(1000);
		expect(parseDdStats('nothing useful')).toBeNull();
	});
});
