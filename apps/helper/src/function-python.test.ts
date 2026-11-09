import { describe, expect, test } from 'bun:test';
import { pyodideCacheDir, renderFunctionUnit } from './units.ts';
import { FUNCTION_MODULE_TYPES, parseWorkload } from './validate.ts';
// Test-only drift check: the shipped helper never imports the contracts.
import { functionModuleTypes } from '../../../packages/contracts/src/function.ts';

/** Python Workers on the helper's side (D121): accepted modules and the extra workerd arguments. */
const SHA = 'a'.repeat(64);
const VERSION = '1.20261106.1';
const WORKERD = `/usr/lib/yoal/workerd/${VERSION}/workerd`;

function workload(main: string, modules: Array<{ name: string; type: string }>) {
	return parseWorkload({
		id: 'wld_py',
		projectId: 'prj_py',
		projectSlug: 'py',
		deploymentId: 'dep_py',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/wld_py.sock',
		memoryMb: 384,
		cpus: 1,
		port: 3000,
		healthPath: '/__yoal/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		function: {
			main,
			modules: modules.map((module) => ({ ...module, sha256: SHA })),
			compatibilityDate: '2026-10-01',
			compatibilityFlags: ['python_workers'],
			bindings: [],
			triggers: { crons: [] },
			assets: null,
			idleStopSeconds: 300,
			workerdVersion: VERSION,
		},
	});
}

function unitFor(desired: ReturnType<typeof workload>): string {
	return renderFunctionUnit({
		workload: desired,
		releaseDir: `/srv/yoal/releases/${SHA}`,
		envFile: '/run/yoal-workloads/wld_py/env',
		secrets: [],
		configPath: '/run/yoal-workloads/wld_py/function/config.capnp',
		shimPath: '/run/yoal-workloads/wld_py/function/shim.mjs',
		workerdPath: WORKERD,
		modulePaths: desired.function!.modules.map((module) => `/srv/yoal/releases/${SHA}/${module.name}`),
		durableStorage: false,
	});
}

describe('Python function hosts', () => {
	test('the helper accepts every module type the contract defines', () => {
		expect([...FUNCTION_MODULE_TYPES].sort()).toEqual([...functionModuleTypes].sort());
	});

	test('a Python host runs with --experimental and the read-only Pyodide cache', () => {
		const unit = unitFor(
			workload('entry.py', [
				{ name: 'entry.py', type: 'python' },
				{ name: 'python_modules/workers/__init__.py', type: 'python' },
				{ name: 'python_modules/_loader.pth', type: 'data' },
			]),
		);
		const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
		expect(execStart).toBe(
			`ExecStart=${WORKERD} serve %d/function-config --socket-fd http=3 --experimental --pyodide-bundle-disk-cache-dir /usr/lib/yoal/workerd/${VERSION}/pyodide`,
		);
		expect(unit).toContain('LoadCredential=module-2:');
	});

	test('a JavaScript host keeps its exact command line', () => {
		const unit = unitFor(workload('index.js', [{ name: 'index.js', type: 'esm' }]));
		expect(unit).toContain(`ExecStart=${WORKERD} serve %d/function-config --socket-fd http=3\n`);
		expect(unit).not.toContain('--experimental');
	});

	test('the cache sits next to the pinned binary', () => {
		expect(pyodideCacheDir('/usr/lib/yoal/workerd/1.2.3/workerd')).toBe('/usr/lib/yoal/workerd/1.2.3/pyodide');
	});
});
