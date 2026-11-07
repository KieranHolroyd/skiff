import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FUNCTIONS_PYTHON_CAPABILITY, nodeCapabilities } from '@skiff/contracts';
import { advertisedCapabilities } from './main.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `functions-python` follows the Pyodide cache on disk (D121). */
describe('advertisedCapabilities', () => {
	test('static capabilities only, until a Pyodide bundle is in the cache', () => {
		const dir = mkdtempSync(join(tmpdir(), 'skiff-pyodide-cap-'));
		dirs.push(dir);
		expect(advertisedCapabilities(join(dir, 'missing'))).toEqual([...nodeCapabilities]);
		writeFileSync(join(dir, 'skiff-eras.json'), '{}');
		expect(advertisedCapabilities(dir)).not.toContain(FUNCTIONS_PYTHON_CAPABILITY);
		writeFileSync(join(dir, 'pyodide_314.0.6_2026-08-17_8.capnp.bin'), 'bundle');
		expect(advertisedCapabilities(dir)).toEqual([...nodeCapabilities, FUNCTIONS_PYTHON_CAPABILITY]);
	});
});
