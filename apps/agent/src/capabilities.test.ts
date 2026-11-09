import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FUNCTIONS_PYTHON_CAPABILITY, PROCESS_NODE_CAPABILITY, nodeCapabilities } from '@yoal/contracts';
import { advertisedCapabilities } from './main.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `functions-python` follows the Pyodide cache on disk (D121). */
describe('advertisedCapabilities', () => {
	test('static capabilities only, until a Pyodide bundle is in the cache', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-pyodide-cap-'));
		dirs.push(dir);
		const noNode = join(dir, 'no-node');
		expect(advertisedCapabilities(join(dir, 'missing'), noNode)).toEqual([...nodeCapabilities]);
		writeFileSync(join(dir, 'yoal-eras.json'), '{}');
		expect(advertisedCapabilities(dir, noNode)).not.toContain(FUNCTIONS_PYTHON_CAPABILITY);
		writeFileSync(join(dir, 'pyodide_314.0.6_2026-08-17_8.capnp.bin'), 'bundle');
		expect(advertisedCapabilities(dir, noNode)).toEqual([...nodeCapabilities, FUNCTIONS_PYTHON_CAPABILITY]);
	});

	/** `process-node` follows the pinned Node.js on PATH (D125). */
	test('process-node only while the node binary exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-node-cap-'));
		dirs.push(dir);
		const binary = join(dir, 'node');
		expect(advertisedCapabilities(join(dir, 'missing'), binary)).not.toContain(PROCESS_NODE_CAPABILITY);
		writeFileSync(binary, '#!/bin/sh\n');
		expect(advertisedCapabilities(join(dir, 'missing'), binary)).toEqual([...nodeCapabilities, PROCESS_NODE_CAPABILITY]);
	});
});
