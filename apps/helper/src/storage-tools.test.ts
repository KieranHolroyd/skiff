import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStorageTools, missingStorageTools } from './storage-tools.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-storage-tools-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function host(present: string[], options: { installs?: boolean } = {}) {
	const files = new Set(present);
	const calls: string[][] = [];
	return {
		calls,
		exists: async (path: string) => files.has(path),
		run: async (argv: string[]) => {
			calls.push(argv);
			if (options.installs !== false && argv.includes('install')) {
				if (argv.includes('fio')) files.add('/usr/bin/fio');
				if (argv.includes('nfs-common')) files.add('/sbin/mount.nfs');
				if (argv.includes('cifs-utils')) files.add('/sbin/mount.cifs');
			}
			return { code: options.installs === false && argv.includes('install') ? 100 : 0, stdout: '', stderr: '' };
		},
	};
}

const log = () => undefined;

describe('storage tools', () => {
	test('does nothing when every tool is present', async () => {
		const fake = host(['/usr/bin/fio', '/usr/sbin/mount.nfs', '/sbin/mount.cifs', '/usr/bin/apt-get']);
		expect(await ensureStorageTools({ stateDir: join(dir, 'a'), version: '1.0.0', ...fake, log })).toEqual({ status: 'present' });
		expect(fake.calls).toEqual([]);
	});

	test('installs only the missing packages, once per helper version', async () => {
		const fake = host(['/sbin/mount.nfs', '/usr/bin/apt-get']);
		expect(await missingStorageTools(fake.exists)).toEqual(['fio', 'cifs-utils']);
		const first = await ensureStorageTools({ stateDir: join(dir, 'b'), version: '1.0.0', ...fake, log });
		expect(first).toEqual({ status: 'installed', missing: ['fio', 'cifs-utils'] });
		const install = fake.calls.find((call) => call.includes('install'))!;
		expect(install.slice(-2)).toEqual(['fio', 'cifs-utils']);
		expect(install).toContain('DPkg::Lock::Timeout=120');
	});

	test('a failed install is not retried until the helper version changes', async () => {
		const fake = host(['/usr/bin/apt-get'], { installs: false });
		const options = { stateDir: join(dir, 'c'), ...fake, log };
		expect((await ensureStorageTools({ ...options, version: '1.0.0' })).status).toBe('failed');
		const calls = fake.calls.length;
		expect(await ensureStorageTools({ ...options, version: '1.0.0' })).toMatchObject({ status: 'skipped', reason: 'already tried for 1.0.0' });
		expect(fake.calls.length).toBe(calls);
		expect((await ensureStorageTools({ ...options, version: '1.0.1' })).status).toBe('failed');
		expect(fake.calls.length).toBeGreaterThan(calls);
	});

	test('skips hosts without apt-get', async () => {
		const fake = host([]);
		expect(await ensureStorageTools({ stateDir: join(dir, 'd'), version: '1.0.0', ...fake, log })).toMatchObject({
			status: 'skipped',
			reason: 'apt-get is not available',
		});
	});
});
