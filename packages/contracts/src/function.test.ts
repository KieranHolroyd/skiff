import { describe, expect, test } from 'bun:test';
import {
	FUNCTION_MANIFEST_FILE,
	FUNCTION_STATEFUL_REPLICA_MESSAGE,
	compatibilityDateProblem,
	functionBindingSchema,
	functionManifestSchema,
	functionModuleNameProblem,
	functionRuntimeSpecSchema,
	workloadSpecSchema,
	WORKERD_MAX_COMPATIBILITY_DATE,
} from './index.ts';

const esmSha = 'a'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}) {
	return {
		main: 'index.js',
		modules: [{ name: 'index.js', type: 'esm', sha256: esmSha }],
		compatibilityDate: '2026-10-01',
		...overrides,
	};
}

describe('function manifest', () => {
	test('accepts a minimal Workers bundle', () => {
		const parsed = functionManifestSchema.parse(manifest());
		expect(parsed.version).toBe(1);
		expect(parsed.compatibilityFlags).toEqual([]);
		expect(parsed.bindings).toEqual([]);
		expect(parsed.triggers.crons).toEqual([]);
	});

	test('main must be a listed esm/cjs module', () => {
		const missing = functionManifestSchema.safeParse(manifest({ main: 'other.js' }));
		expect(missing.success).toBe(false);
		const text = functionManifestSchema.safeParse(
			manifest({
				main: 'notes.txt',
				modules: [
					{ name: 'index.js', type: 'esm', sha256: esmSha },
					{ name: 'notes.txt', type: 'text', sha256: esmSha },
				],
			}),
		);
		expect(text.success).toBe(false);
	});

	test('rejects duplicate modules and unsafe names', () => {
		expect(
			functionManifestSchema.safeParse(
				manifest({
					modules: [
						{ name: 'index.js', type: 'esm', sha256: esmSha },
						{ name: 'index.js', type: 'esm', sha256: esmSha },
					],
				}),
			).success,
		).toBe(false);
		expect(functionModuleNameProblem('../secrets')).not.toBeNull();
		expect(functionModuleNameProblem('/etc/passwd')).not.toBeNull();
		expect(functionModuleNameProblem('nested/index.js')).toBeNull();
	});

	test('caps the compatibility date at the pinned workerd build', () => {
		expect(compatibilityDateProblem('2026-10-01')).toBeNull();
		expect(compatibilityDateProblem(WORKERD_MAX_COMPATIBILITY_DATE)).toBeNull();
		expect(compatibilityDateProblem('2099-01-01')).not.toBeNull();
		expect(compatibilityDateProblem('2026-02-31')).not.toBeNull();
		expect(functionManifestSchema.safeParse(manifest({ compatibilityDate: '2099-01-01' })).success).toBe(false);
	});

	test('resolved runtime spec keeps app bindings pinned to an upstream', () => {
		const spec = functionRuntimeSpecSchema.parse({
			...manifest(),
			bindings: [{ name: 'WEB', type: 'app', project: 'web', upstream: 'unix//run/yoal-workloads/prj_1.sock' }],
			assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
			workerdVersion: '1.20261106.1',
		});
		expect(spec.bindings[0]).toMatchObject({ type: 'app', upstream: 'unix//run/yoal-workloads/prj_1.sock' });
		expect(spec.assets?.runWorkerFirst).toEqual(['/api/*']);
		expect(spec.idleStopSeconds).toBe(300);
	});

	test('rejects a plain app binding in a resolved spec', () => {
		expect(
			functionRuntimeSpecSchema.safeParse({
				...manifest(),
				bindings: [{ name: 'WEB', type: 'app', project: 'web' }],
				workerdVersion: '1.20261106.1',
			}).success,
		).toBe(false);
	});

	test('app bindings can only name a Yoal workload target', () => {
		const base = { ...manifest(), workerdVersion: '1.20261106.1' };
		const ok = functionRuntimeSpecSchema.safeParse({
			...base,
			bindings: [{ name: 'WEB', type: 'app', project: 'web', upstream: 'unix//run/yoal-workloads/prj_1.sock' }],
		});
		expect(ok.success).toBe(true);
		for (const upstream of [
			'unix//run/yoal/agent.sock',
			'/run/yoal-workloads/prj_1.sock',
			'http://169.254.169.254/latest/meta-data',
			'127.0.0.1',
		]) {
			expect(
				functionRuntimeSpecSchema.safeParse({
					...base,
					bindings: [{ name: 'WEB', type: 'app', project: 'web', upstream }],
				}).success,
			).toBe(false);
		}
	});

	test('binding names are JavaScript identifiers and unique', () => {
		expect(functionBindingSchema.safeParse({ name: 'API-KEY', type: 'text', value: 'x' }).success).toBe(false);
		expect(
			functionManifestSchema.safeParse(
				manifest({
					bindings: [
						{ name: 'CACHE', type: 'cache' },
						{ name: 'CACHE', type: 'cache' },
					],
				}),
			).success,
		).toBe(false);
	});

	test('the manifest file name is stable', () => {
		expect(FUNCTION_MANIFEST_FILE).toBe('yoal-function.json');
	});
});

describe('function workloads', () => {
	const fn = (overrides: Record<string, unknown> = {}) =>
		functionRuntimeSpecSchema.parse({
			...manifest(),
			workerdVersion: '1.20261106.1',
			...overrides,
		});

	test('a function workload needs a function spec and forbids process fields', () => {
		expect(workloadSpecSchema.safeParse({ runtime: 'function' }).success).toBe(false);
		expect(
			workloadSpecSchema.safeParse({ runtime: 'function', function: fn(), command: ['bun', 'run', 'start'] }).success,
		).toBe(false);
		expect(workloadSpecSchema.safeParse({ runtime: 'function', function: fn(), image: 'x' }).success).toBe(false);
		expect(workloadSpecSchema.safeParse({ runtime: 'process', function: fn() }).success).toBe(false);
	});

	test('a valid function spec parses with HTTP ingress and one copy', () => {
		const spec = workloadSpecSchema.parse({
			runtime: 'function',
			memoryMb: 128,
			function: fn(),
			healthPath: '/__yoal/health',
		});
		expect(spec.runtime).toBe('function');
		expect(spec.ingress).toBe('http');
		expect(spec.replicas).toBe(1);
		expect(spec.function?.main).toBe('index.js');
	});

	test('functions cannot keep a data directory, and stateful ones stay one host', () => {
		expect(
			workloadSpecSchema.safeParse({ runtime: 'function', function: fn(), data: { sizeMb: 128 } }).success,
		).toBe(false);
		// Phase 4: a stateful binding pins the function to one host until workerd cluster mode.
		const stateful = workloadSpecSchema.safeParse({
			runtime: 'function',
			function: fn({
				bindings: [{ name: 'ROOM', type: 'durable_object', className: 'Room', uniqueKey: 'prj_room' }],
			}),
			replicas: 2,
		});
		expect(stateful.success).toBe(false);
		expect(stateful.error?.issues.map((issue) => issue.message)).toContain(FUNCTION_STATEFUL_REPLICA_MESSAGE);
		// A stateless function has no state to place, so several hosts are allowed.
		expect(workloadSpecSchema.safeParse({ runtime: 'function', function: fn(), replicas: 3 }).success).toBe(true);
	});
});
