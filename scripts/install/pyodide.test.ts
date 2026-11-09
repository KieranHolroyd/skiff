import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pyodideBundles, pythonBundleEras, warmConfig, warmedEras, warmPyodideCache } from './pyodide.ts';

/** The Pyodide cache warmer (D121). Verified for real against workerd 1.20261106.1 (two bundles). */
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-pyodide-test-'));
	dirs.push(dir);
	return dir;
}

describe('Pyodide cache warmer', () => {
	test('reads the eras from contracts, ending at the pinned maximum date', async () => {
		const eras = await pythonBundleEras(resolve(import.meta.dir, '../..'));
		expect(eras.slice(0, 2)).toEqual(['2024-12-01', '2025-06-01']);
		expect(eras[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('the probe config is one Python Worker on an ephemeral loopback port', () => {
		const config = warmConfig('2026-10-01');
		expect(config).toContain('address = "127.0.0.1:0"');
		expect(config).toContain('compatibilityDate = "2026-10-01"');
		expect(config).toContain('"python_workers"');
		expect(() => warmConfig('2026-10-01"; evil')).toThrow();
	});

	test('warms one era at a time into fresh scratch caches, merges and marks the result', async () => {
		const root = temp();
		const workerd = join(root, 'workerd');
		writeFileSync(workerd, '');
		const cacheDir = join(root, 'pyodide');
		const spawned: string[][] = [];
		const result = await warmPyodideCache({
			workerdPath: workerd,
			cacheDir,
			eras: ['2024-12-01', '2026-10-01', '2024-12-01'],
			sleep: async () => {},
			// Fake workerd: writes the era's bundle into the scratch cache it was given.
			spawn: (argv) => {
				spawned.push(argv);
				const scratch = argv[argv.length - 1]!;
				const name = argv.includes('--pyodide-bundle-disk-cache-dir') && spawned.length === 1 ? 'old' : 'new';
				writeFileSync(join(scratch, `pyodide_${name}.capnp.bin`), 'bundle');
				return { stop: () => {}, exited: () => false };
			},
		});
		expect(result).toBe('warmed');
		expect(spawned).toHaveLength(2);
		expect(pyodideBundles(cacheDir)).toEqual(['pyodide_new.capnp.bin', 'pyodide_old.capnp.bin']);
		expect(warmedEras(cacheDir)).toEqual(['2024-12-01', '2026-10-01']);

		const again = await warmPyodideCache({
			workerdPath: workerd,
			cacheDir,
			eras: ['2026-10-01', '2024-12-01'],
			spawn: () => {
				throw new Error('must not start workerd');
			},
		});
		expect(again).toBe('present');
	});

	test('a workerd that never produces a bundle fails without writing the marker', async () => {
		const root = temp();
		writeFileSync(join(root, 'workerd'), '');
		await expect(
			warmPyodideCache({
				workerdPath: join(root, 'workerd'),
				cacheDir: join(root, 'pyodide'),
				eras: ['2026-10-01'],
				sleep: async () => {},
				spawn: () => ({ stop: () => {}, exited: () => true }),
			}),
		).rejects.toThrow(/no Pyodide bundle/);
		expect(warmedEras(join(root, 'pyodide'))).toEqual([]);
	});
});
