import { describe, expect, test } from 'bun:test';
import {
	FUNCTION_PYTHON_COMPAT_FLAG,
	functionIsPython,
	functionManifestSchema,
	functionRuntimeSpecSchema,
} from './function.ts';
import { workloadSpecSchema } from './workload.ts';

/** Python Workers in the contract (D121). */
const SHA = 'a'.repeat(64);
const pyModules = [
	{ name: 'entry.py', type: 'python', sha256: SHA },
	{ name: 'python_modules/workers/workflows.js', type: 'data', sha256: SHA },
];

describe('Python function contract', () => {
	test('a .py main with Python and data modules is a valid manifest', () => {
		const manifest = functionManifestSchema.parse({ version: 1, main: 'entry.py', modules: pyModules, compatibilityDate: '2026-10-01' });
		expect(functionIsPython(manifest)).toBe(true);
	});

	test('Python and JavaScript modules do not mix', () => {
		const withJs = functionManifestSchema.safeParse({
			version: 1,
			main: 'entry.py',
			modules: [...pyModules, { name: 'helper.js', type: 'esm', sha256: SHA }],
			compatibilityDate: '2026-10-01',
		});
		expect(withJs.error?.issues[0]?.message).toContain('cannot include JavaScript modules');
		const jsMain = functionManifestSchema.safeParse({
			version: 1,
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: SHA }, { name: 'x.py', type: 'python', sha256: SHA }],
			compatibilityDate: '2026-10-01',
		});
		expect(jsMain.error?.issues[0]?.message).toContain('Python entry module');
	});

	test('the resolved spec needs the python_workers flag', () => {
		const base = { main: 'entry.py', modules: pyModules, compatibilityDate: '2026-10-01', workerdVersion: '1.20261106.1' };
		expect(functionRuntimeSpecSchema.safeParse(base).success).toBe(false);
		expect(functionRuntimeSpecSchema.safeParse({ ...base, compatibilityFlags: [FUNCTION_PYTHON_COMPAT_FLAG] }).success).toBe(true);
	});

	test('a Python workload reserves at least 256 MB', () => {
		const fn = { main: 'entry.py', modules: pyModules, compatibilityDate: '2026-10-01', compatibilityFlags: ['python_workers'], workerdVersion: '1.20261106.1' };
		const small = workloadSpecSchema.safeParse({ runtime: 'function', function: fn, memoryMb: 128 });
		expect(small.error?.issues[0]?.path).toEqual(['memoryMb']);
		expect(workloadSpecSchema.safeParse({ runtime: 'function', function: fn, memoryMb: 384 }).success).toBe(true);
	});
});
