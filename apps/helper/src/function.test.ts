import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, type HelperRuntime } from './server.ts';
import { SystemdDriver, type CommandRunner, type RunResult } from './systemd.ts';
import { renderFunctionUnit } from './units.ts';
// Test-only: the shipped helper never imports the contracts, but a drift check against them must.
import { functionBindingTypes } from '../../../packages/contracts/src/function.ts';
import {
	FUNCTION_BINDING_TYPES,
	functionNeedsDurableStorage,
	parseApplyRequest,
	parseWorkload,
	ValidationError,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadFunctionFiles,
} from './validate.ts';

const SHA = 'a'.repeat(64);
const MODULE_SHA = 'c'.repeat(64);
const WORKERD_VERSION = '1.20261106.1';
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function workloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'wld_abc123',
		projectId: 'prj_1',
		projectSlug: 'my-app',
		deploymentId: 'dep_abc123',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/wld_abc123.sock',
		memoryMb: 128,
		cpus: 0.5,
		port: 3000,
		healthPath: '/',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production' },
		secrets: [{ name: 'API_TOKEN', delivery: 'env' }],
		dataSizeMb: null,
		function: {
			main: 'index.js',
			modules: [
				{ name: 'index.js', type: 'esm', sha256: MODULE_SHA },
				{ name: 'lib/util.js', type: 'esm', sha256: SHA },
			],
			compatibilityDate: '2026-11-06',
			compatibilityFlags: ['nodejs_compat'],
			bindings: [
				{ name: 'API_KEY', type: 'secret', secret: 'API_TOKEN' },
				{ name: 'OTHER', type: 'app', project: 'other', upstream: 'unix//run/skiff-workloads/prj_2.sock' },
			],
			triggers: { crons: [] },
			assets: null,
			idleStopSeconds: 300,
			workerdVersion: WORKERD_VERSION,
		},
		...overrides,
	};
}

function functionFiles(overrides: Partial<WorkloadFunctionFiles> = {}): WorkloadFunctionFiles {
	return {
		config: 'using Workerd = import "/workerd/workerd.capnp";\nconst config :Workerd.Config = (services = [], sockets = []);\n',
		shim: 'export default { fetch() { return new Response("ok"); } };\n',
		...overrides,
	};
}

function activation(overrides: Partial<WorkloadActivation> = {}): WorkloadActivation {
	return {
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production' },
		files: {},
		...overrides,
	};
}

function functionWorkload(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return parseWorkload(workloadInput(overrides));
}

describe('parseWorkload: function spec', () => {
	test('accepts a function workload and normalizes the spec', () => {
		const workload = functionWorkload();
		expect(workload.runtime).toBe('function');
		expect(workload.function).toMatchObject({
			main: 'index.js',
			compatibilityDate: '2026-11-06',
			compatibilityFlags: ['nodejs_compat'],
			idleStopSeconds: 300,
			workerdVersion: WORKERD_VERSION,
			triggers: { crons: [] },
		});
		expect(workload.function?.modules.map((module) => module.name)).toEqual(['index.js', 'lib/util.js']);
		// Binding values, upstreams and project names are agent-resolved: only the name and the
		// phase-1 kind survive validation.
		expect(workload.function?.bindings).toEqual([
			{ name: 'API_KEY', type: 'secret' },
			{ name: 'OTHER', type: 'app' },
		]);
	});

	test('requires a function object, a release and socket activation', () => {
		expect(() => parseWorkload(workloadInput({ function: undefined }))).toThrow(/need workload\.function/);
		expect(() => parseWorkload(workloadInput({ release: null }))).toThrow(/need a release/);
		expect(() => parseWorkload(workloadInput({ socketActivation: false }))).toThrow(/socket activation/);
	});

	test('refuses HTTP-incompatible fields on a function', () => {
		for (const [key, value] of [
			['image', 'ghcr.io/acme/app:1.0'],
			['command', ['bun', 'run', 'start']],
			['database', { engine: 'postgres', version: '16' }],
			['objectStorage', { engine: 'rustfs', version: '1.0.4' }],
			['runner', { provider: 'github' }],
			['pooler', { port: 6432 }],
			['volumeId', 'vol_1'],
			['volumes', [{ id: 'vol_1', mountPath: '/data/app', backing: 'state_dir' }]],
			['dataSizeMb', 256],
			['ingress', 'none'],
		] as const) {
			expect(() => parseWorkload(workloadInput({ [key]: value }))).toThrow(ValidationError);
		}
	});

	test('refuses a function object on a process workload', () => {
		expect(() =>
			parseWorkload(workloadInput({ runtime: 'process', socketActivation: true })),
		).toThrow(/Only function workloads may set workload\.function/);
	});

	test('main must name a module and module names must stay inside the release', () => {
		expect(() => parseWorkload(workloadInput({ function: { ...fnSpec(), main: 'missing.js' } }))).toThrow(
			/main must name one of the modules/,
		);
		for (const name of ['../escape.js', '/etc/passwd', 'a//b', 'a\\b']) {
			expect(() =>
				parseWorkload(
					workloadInput({
						function: {
							...fnSpec(),
							modules: [
								{ name, type: 'esm', sha256: MODULE_SHA },
								{ name: 'index.js', type: 'esm', sha256: SHA },
							],
						},
					}),
				),
			).toThrow(ValidationError);
		}
		expect(() =>
			parseWorkload(
				workloadInput({
					function: {
						...fnSpec(),
						modules: [
							{ name: 'index.js', type: 'esm', sha256: MODULE_SHA },
							{ name: 'index.js', type: 'esm', sha256: SHA },
						],
					},
				}),
			),
		).toThrow(/lists index\.js twice/);
	});

	test('rejects a bad compatibility date, workerd version, flag and binding', () => {
		expect(() => parseWorkload(workloadInput({ function: { ...fnSpec(), compatibilityDate: '2026-1-1' } }))).toThrow(
			/YYYY-MM-DD/,
		);
		for (const version of ['1.20261106', 'v1.2.3', '1.2.3-beta', '']) {
			expect(() => parseWorkload(workloadInput({ function: { ...fnSpec(), workerdVersion: version } }))).toThrow(
				ValidationError,
			);
		}
		expect(() =>
			parseWorkload(workloadInput({ function: { ...fnSpec(), compatibilityFlags: ['Bad Flag'] } })),
		).toThrow(ValidationError);
		expect(() =>
			parseWorkload(workloadInput({ function: { ...fnSpec(), bindings: [{ name: '1BAD', type: 'text' }] } })),
		).toThrow(ValidationError);
		expect(() =>
			parseWorkload(workloadInput({ function: { ...fnSpec(), bindings: [{ name: 'OK', type: 'vectorize' }] } })),
		).toThrow(/bindings\[0\]\.type/);
		expect(() =>
			parseWorkload(
				workloadInput({
					function: {
						...fnSpec(),
						bindings: [
							{ name: 'OK', type: 'text' },
							{ name: 'OK', type: 'json' },
						],
					},
				}),
			),
		).toThrow(/lists OK twice/);
	});

	test('validates assets without accepting traversal or control characters', () => {
		const workload = parseWorkload(
			workloadInput({
				function: {
					...fnSpec(),
					assets: { directory: 'public', runWorkerFirst: ['/api/*', '!/assets/*'] },
				},
			}),
		);
		expect(workload.function?.assets).toEqual({
			directory: 'public',
			runWorkerFirst: ['/api/*', '!/assets/*'],
		});
		for (const directory of ['', '../public', '/public']) {
			expect(() =>
				parseWorkload(
					workloadInput({ function: { ...fnSpec(), assets: { directory, runWorkerFirst: [] } } }),
				),
			).toThrow(ValidationError);
		}
		expect(() =>
			parseWorkload(
				workloadInput({
					function: { ...fnSpec(), assets: { directory: 'public', runWorkerFirst: ['a\nb'] } },
				}),
			),
		).toThrow(/control characters/);
	});

	test('rejects out-of-range function limits', () => {
		expect(() => parseWorkload(workloadInput({ function: { ...fnSpec(), idleStopSeconds: 86_401 } }))).toThrow(
			ValidationError,
		);
		expect(() => parseWorkload(workloadInput({ function: { ...fnSpec(), modules: [] } }))).toThrow(
			ValidationError,
		);
		expect(() =>
			parseWorkload(
				workloadInput({
					function: { ...fnSpec(), compatibilityFlags: Array.from({ length: 33 }, (_, i) => `f${i}`) },
				}),
			),
		).toThrow(ValidationError);
	});
});

function fnSpec(): Record<string, unknown> {
	return workloadInput().function as Record<string, unknown>;
}

describe('parseWorkload: phase-2 binding shapes', () => {
	test('accepts durable_object, hyperdrive, kv and cache and keeps their identity fields', () => {
		const workload = functionWorkload({
			function: {
				...fnSpec(),
				bindings: [
					{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
					{ name: 'DB', type: 'hyperdrive', envPrefix: 'DATABASE' },
					{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' },
					{ name: 'HTTP_CACHE', type: 'cache' },
				],
			},
		});
		expect(workload.function?.bindings).toEqual([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'DB', type: 'hyperdrive', envPrefix: 'DATABASE' },
			{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' },
			{ name: 'HTTP_CACHE', type: 'cache' },
		]);
		expect(functionNeedsDurableStorage(workload.function!)).toBe(true);

		// Hyperdrive alone is stateless: no do-storage, no state directory subdir.
		const stateless = functionWorkload({
			function: { ...fnSpec(), bindings: [{ name: 'DB', type: 'hyperdrive', envPrefix: 'DATABASE' }] },
		});
		expect(functionNeedsDurableStorage(stateless.function!)).toBe(false);
	});

	test('accepts r2, d1, queue, analytics_engine and assets (every contract binding kind)', () => {
		const workload = functionWorkload({
			function: {
				...fnSpec(),
				bindings: [
					{ name: 'BUCKET', type: 'r2', envPrefix: 'STORAGE_MEDIA' },
					{ name: 'DB', type: 'd1', namespaceId: 'prj_1-DB' },
					{ name: 'JOBS', type: 'queue', namespaceId: 'prj_1-JOBS' },
					{ name: 'EVENTS', type: 'analytics_engine', dataset: 'events' },
					{ name: 'ASSETS', type: 'assets' },
				],
			},
		});
		expect(workload.function?.bindings).toEqual([
			{ name: 'BUCKET', type: 'r2', envPrefix: 'STORAGE_MEDIA' },
			{ name: 'DB', type: 'd1', namespaceId: 'prj_1-DB' },
			{ name: 'JOBS', type: 'queue', namespaceId: 'prj_1-JOBS' },
			{ name: 'EVENTS', type: 'analytics_engine' },
			{ name: 'ASSETS', type: 'assets' },
		]);
		// D1 and queues keep SQLite state on do-storage, like the agent renderers say.
		expect(functionNeedsDurableStorage(workload.function!)).toBe(true);
		for (const binding of [
			{ name: 'BUCKET', type: 'r2', envPrefix: 'STORAGE_MEDIA' },
			{ name: 'EVENTS', type: 'analytics_engine', dataset: 'events' },
			{ name: 'ASSETS', type: 'assets' },
		]) {
			const stateless = functionWorkload({ function: { ...fnSpec(), bindings: [binding] } });
			expect(functionNeedsDurableStorage(stateless.function!)).toBe(false);
		}
	});

	test('the helper accepts every binding kind the contract defines', () => {
		expect([...FUNCTION_BINDING_TYPES].sort()).toEqual([...functionBindingTypes].sort());
	});

	test('validates the fields each phase-2 binding needs', () => {
		const bad: Array<Record<string, unknown>> = [
			{ name: 'ROOMS', type: 'durable_object', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'ROOMS', type: 'durable_object', className: 'Room' },
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'bad key' },
			{ name: 'DB', type: 'hyperdrive' },
			{ name: 'DB', type: 'hyperdrive', envPrefix: 'lower' },
			{ name: 'CACHE', type: 'kv' },
			{ name: 'CACHE', type: 'kv', namespaceId: 'has space' },
			{ name: 'BUCKET', type: 'r2' },
			{ name: 'DB', type: 'd1' },
			{ name: 'JOBS', type: 'queue', namespaceId: 'bad id' },
		];
		for (const binding of bad) {
			expect(() =>
				parseWorkload(workloadInput({ function: { ...fnSpec(), bindings: [binding] } })),
			).toThrow(ValidationError);
		}
	});
});

describe('parseApplyRequest: function files', () => {
	test('parses a function workload and returns the rendered files', () => {
		const files = functionFiles();
		const parsed = parseApplyRequest({
			workload: workloadInput(),
			activation: activation(),
			function: files,
		});
		expect(parsed.workload.runtime).toBe('function');
		expect(parsed.function).toEqual(files);
	});

	test('requires config and shim, and refuses extras', () => {
		const body = { workload: workloadInput(), activation: activation() };
		expect(() => parseApplyRequest(body)).toThrow(/need request\.function\.config/);
		expect(() =>
			parseApplyRequest({ ...body, function: { config: 'x' } }),
		).toThrow(ValidationError);
		expect(() =>
			parseApplyRequest({ ...body, function: { config: 'x', shim: 'y', extra: 'z' } }),
		).toThrow(/extra is not supported/);
	});

	test('refuses function files for a process workload and on a function with no files', () => {
		expect(() =>
			parseApplyRequest({
				workload: workloadInput({ runtime: 'process', function: undefined }),
				activation: activation(),
				function: functionFiles(),
			}),
		).toThrow(/only valid for a function workload/);
	});

	test('enforces byte limits, non-empty content and no NUL bytes', () => {
		const body = { workload: workloadInput(), activation: activation() };
		expect(() =>
			parseApplyRequest({ ...body, function: functionFiles({ config: 'a'.repeat(512 * 1024 + 1) }) }),
		).toThrow(/at most 524288/);
		expect(() =>
			parseApplyRequest({ ...body, function: functionFiles({ shim: 'a'.repeat(256 * 1024 + 1) }) }),
		).toThrow(/at most 262144/);
		expect(() => parseApplyRequest({ ...body, function: functionFiles({ config: '' }) })).toThrow(
			ValidationError,
		);
		expect(() => parseApplyRequest({ ...body, function: functionFiles({ shim: 'a\0b' }) })).toThrow(
			/no NUL|NUL byte/,
		);
	});

	test('parses extra binding-service modules and keeps the phase-1 fields', () => {
		const files = functionFiles({
			files: {
				'binding-kv': 'export default { async fetch() { return new Response("kv"); } };\n',
				'binding-cache': 'export default {};\n',
			},
		});
		const parsed = parseApplyRequest({
			workload: workloadInput(),
			activation: activation(),
			function: files,
		});
		expect(parsed.function).toEqual(files);
		// Omitted entirely: a phase-1 request keeps its original two-field body.
		expect(parseApplyRequest({ workload: workloadInput(), activation: activation(), function: functionFiles() }).function).toEqual(
			functionFiles(),
		);
	});

	test('refuses bad, reserved and oversized binding-service modules', () => {
		const body = { workload: workloadInput(), activation: activation() };
		const withFiles = (files: Record<string, string>) =>
			parseApplyRequest({ ...body, function: functionFiles({ files }) });

		for (const name of ['function-config', 'function-shim']) {
			expect(() => withFiles({ [name]: 'x' })).toThrow(/is reserved/);
		}
		for (const name of ['Binding-kv', 'binding_kv', 'a/b', '1kv', 'binding-kv.js']) {
			expect(() => withFiles({ [name]: 'x' })).toThrow(/must match/);
		}
		expect(() => withFiles({ 'binding-kv': '' })).toThrow(ValidationError);
		expect(() => withFiles({ 'binding-kv': 'a\0b' })).toThrow(/NUL byte/);
		expect(() => withFiles({ 'binding-kv': 'a'.repeat(256 * 1024 + 1) })).toThrow(/at most 262144/);

		const seventeen = Object.fromEntries(
			Array.from({ length: 17 }, (_, index) => [`binding-${index}`, 'export default {};']),
		);
		expect(() => withFiles(seventeen)).toThrow(/at most 16 files/);

		// Five files at the per-file cap exceed the 1 MiB total.
		const total = Object.fromEntries(
			Array.from({ length: 5 }, (_, index) => [`binding-${index}`, 'a'.repeat(256 * 1024)]),
		);
		expect(() => withFiles(total)).toThrow(/must total at most 1048576 bytes/);

		// Still only valid on a function workload.
		expect(() =>
			parseApplyRequest({
				workload: workloadInput({ runtime: 'process', function: undefined }),
				activation: activation(),
				function: functionFiles({ files: { 'binding-kv': 'x' } }),
			}),
		).toThrow(/only valid for a function workload/);
	});
});

describe('renderFunctionUnit', () => {
	test('renders the fixed workerd unit with one credential per module', () => {
		const workload = functionWorkload();
		const configPath = '/run/skiff-workloads/wld_abc123/function/config.capnp';
		const shimPath = '/run/skiff-workloads/wld_abc123/function/shim.mjs';
		const workerdPath = `/usr/lib/skiff/workerd/${WORKERD_VERSION}/workerd`;
		const unit = renderFunctionUnit({
			workload,
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [{ name: 'TLS_KEY', path: '/run/skiff-workloads/wld_abc123/secrets/TLS_KEY' }],
			volumeMounts: [
				{ hostPath: '/var/lib/skiff/apps/prj_1/vol_1', mountPath: '/data/app', readOnly: false },
				{ hostPath: '/var/lib/skiff/apps/prj_1/vol_2', mountPath: '/data/ro', readOnly: true },
			],
			configPath,
			shimPath,
			workerdPath,
			modulePaths: ['/srv/skiff/releases/' + SHA + '/index.js', '/srv/skiff/releases/' + SHA + '/lib/util.js'],
			durableStorage: false,
		});
		const lines = unit.split('\n');

		expect(lines).toContain(`ExecStart=${workerdPath} serve %d/function-config --socket-fd http=3`);
		expect(lines).toContain(`LoadCredential=function-config:${configPath}`);
		expect(lines).toContain(`LoadCredential=function-shim:${shimPath}`);
		expect(lines).toContain(
			`LoadCredential=module-0:/srv/skiff/releases/${SHA}/index.js`,
		);
		expect(lines).toContain(
			`LoadCredential=module-1:/srv/skiff/releases/${SHA}/lib/util.js`,
		);
		expect(lines.indexOf(`LoadCredential=module-0:/srv/skiff/releases/${SHA}/index.js`)).toBeLessThan(
			lines.indexOf(`LoadCredential=module-1:/srv/skiff/releases/${SHA}/lib/util.js`),
		);
		expect(lines).toContain('Type=simple');
		expect(lines).toContain('DynamicUser=yes');
		expect(lines).toContain('StateDirectory=skiff-workloads/wld_abc123');
		expect(lines).toContain('StateDirectoryMode=0700');
		expect(lines).toContain(`WorkingDirectory=/srv/skiff/releases/${SHA}`);
		expect(lines).toContain('EnvironmentFile=-/run/skiff-workloads/wld_abc123/env');
		expect(lines).toContain('MemoryMax=128M');
		expect(lines).toContain('CPUQuota=50%');
		expect(lines).toContain('Slice=skiff-workloads.slice');
		expect(lines).toContain('KillSignal=SIGTERM');
		expect(lines).toContain('TimeoutStopSec=30');
		expect(lines).toContain('IPAddressAllow=127.0.0.0/8 ::1/128');
		expect(lines).toContain(
			'IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10',
		);
		expect(lines).toContain('LoadCredential=TLS_KEY:/run/skiff-workloads/wld_abc123/secrets/TLS_KEY');
		expect(lines).toContain('Environment=TLS_KEY_FILE=%d/TLS_KEY');
		expect(lines).toContain('BindPaths=/var/lib/skiff/apps/prj_1/vol_1:/data/app');
		expect(lines).toContain('ReadWritePaths=/data/app');
		expect(lines).toContain('BindReadOnlyPaths=/var/lib/skiff/apps/prj_1/vol_2:/data/ro');

		// Phase 1 has no stateful binding: exactly one writable state dir and no disk service.
		expect(lines.filter((line) => line.startsWith('StateDirectory='))).toEqual([
			'StateDirectory=skiff-workloads/wld_abc123',
		]);
		expect(unit).not.toContain('--directory-path');
		expect(unit).not.toContain('do-storage');

		// V8 needs W^X toggling: the memory write/execute lock must be absent (FN5, S1).
		expect(unit).not.toContain('MemoryDenyWriteExecute');
		expect(unit).not.toContain('ExecStartPre');
		expect(unit).not.toContain('[Install]');
		// Nothing from the wire's function spec leaks into the unit as a command or extra path.
		expect(unit).not.toContain('compatibilityFlags');
		expect(unit).not.toContain('nodejs_compat');
		expect(unit).not.toContain('API_KEY');
	});

	test('durable storage adds the writable do directory and workerd directory path', () => {
		const workload = functionWorkload({
			function: {
				...fnSpec(),
				bindings: [
					{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
				],
			},
		});
		const workerdPath = `/usr/lib/skiff/workerd/${WORKERD_VERSION}/workerd`;
		const unit = renderFunctionUnit({
			workload,
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			configPath: '/run/skiff-workloads/wld_abc123/function/config.capnp',
			shimPath: '/run/skiff-workloads/wld_abc123/function/shim.mjs',
			workerdPath,
			modulePaths: ['/srv/skiff/releases/' + SHA + '/index.js', '/srv/skiff/releases/' + SHA + '/lib/util.js'],
			files: [{ name: 'binding-kv', path: '/run/skiff-workloads/wld_abc123/function/binding-kv' }],
			durableStorage: true,
		});
		const lines = unit.split('\n');

		// Both state dirs are created and owned by the dynamic user; the helper never mkdirs them.
		expect(lines.filter((line) => line.startsWith('StateDirectory='))).toEqual([
			'StateDirectory=skiff-workloads/wld_abc123',
			'StateDirectory=skiff-workloads/wld_abc123/do',
		]);
		expect(lines).toContain(
			`ExecStart=${workerdPath} serve %d/function-config --socket-fd http=3 --directory-path do-storage=/var/lib/skiff-workloads/wld_abc123/do`,
		);
		expect(lines).toContain(
			'LoadCredential=binding-kv:/run/skiff-workloads/wld_abc123/function/binding-kv',
		);
		expect(unit).not.toContain('ExecStartPre');
		expect(unit).not.toContain('[Install]');
	});

	test('requires one module path per module and a function workload', () => {
		const base = {
			workload: functionWorkload(),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			configPath: '/run/skiff-workloads/wld_abc123/function/config.capnp',
			shimPath: '/run/skiff-workloads/wld_abc123/function/shim.mjs',
			workerdPath: `/usr/lib/skiff/workerd/${WORKERD_VERSION}/workerd`,
			durableStorage: false,
		};
		expect(() => renderFunctionUnit({ ...base, modulePaths: ['/srv/skiff/releases/' + SHA + '/index.js'] })).toThrow(
			/one module path per module/,
		);
		const processWorkload = parseWorkload({
			...workloadInput({ runtime: 'process', function: undefined }),
		});
		expect(() =>
			renderFunctionUnit({
				...base,
				workload: processWorkload,
				modulePaths: [],
			}),
		).toThrow(/needs a function workload/);
	});
});

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	show = '';

	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		if (argv[1] === 'show') return { code: 0, stdout: this.show, stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}

	count(verb: string): number {
		return this.calls.filter((argv) => argv[1] === verb).length;
	}
}

interface Fixture {
	root: string;
	releaseDir: string;
	workerdDir: string;
	driver: SystemdDriver;
	runner: FakeRunner;
	unitDir: string;
	quadletDir: string;
	runtimeDir: string;
}

async function fixture(options: { modules?: boolean; workerd?: boolean } = {}): Promise<Fixture> {
	const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-function-'));
	directories.push(root);
	const unitDir = join(root, 'units');
	const quadletDir = join(root, 'quadlet');
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	const releases = join(root, 'releases');
	const releaseDir = join(releases, SHA);
	const workerdDir = join(root, 'workerd');
	await fs.mkdir(join(releaseDir, 'lib'), { recursive: true });
	if (options.modules !== false) {
		await fs.writeFile(join(releaseDir, 'index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
		await fs.writeFile(join(releaseDir, 'lib/util.js'), 'export const helper = true;\n');
	}
	if (options.workerd !== false) {
		const binaryDir = join(workerdDir, WORKERD_VERSION);
		await fs.mkdir(binaryDir, { recursive: true });
		await fs.writeFile(join(binaryDir, 'workerd'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	}
	const runner = new FakeRunner();
	runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\nMemoryCurrent=1048576\nResult=success\n';
	const driver = new SystemdDriver({
		runner,
		unitDir,
		quadletDir,
		runtimeDir,
		stateDir,
		workerdDir,
		releaseDirs: [releases],
		volumeRegistryFile: join(root, 'volumes.json'),
		bunPath: '/usr/local/bin/bun',
		socketMode: '0660',
		socketGroup: 'caddy',
	});
	return { root, releaseDir, workerdDir, driver, runner, unitDir, quadletDir, runtimeDir };
}

describe('SystemdDriver.apply: function', () => {
	test('writes config and shim, renders the unit and socket, and starts the host', async () => {
		const f = await fixture();
		const files = functionFiles();
		const status = await f.driver.apply(functionWorkload(), activation(), files);

		const functionDir = join(f.runtimeDir, 'wld_abc123/function');
		const configPath = join(functionDir, 'config.capnp');
		const shimPath = join(functionDir, 'shim.mjs');
		expect(await fs.readFile(configPath, 'utf8')).toBe(files.config);
		expect(await fs.readFile(shimPath, 'utf8')).toBe(files.shim);
		expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(shimPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(functionDir)).mode & 0o777).toBe(0o700);

		const unit = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.service'), 'utf8');
		const binary = join(f.workerdDir, WORKERD_VERSION, 'workerd');
		expect(unit).toContain(`ExecStart=${binary} serve %d/function-config --socket-fd http=3`);
		expect(unit).toContain(`LoadCredential=function-config:${configPath}`);
		expect(unit).toContain(`LoadCredential=function-shim:${shimPath}`);
		expect(unit).toContain(`LoadCredential=module-0:${join(f.releaseDir, 'index.js')}`);
		expect(unit).toContain(`LoadCredential=module-1:${join(f.releaseDir, 'lib/util.js')}`);
		expect(unit).not.toContain('[Install]');

		const socket = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.socket'), 'utf8');
		expect(socket).toContain(`ListenStream=${join(f.runtimeDir, 'wld_abc123.sock')}`);
		expect(socket).toContain('SocketMode=0660');
		expect(socket).toContain('SocketGroup=caddy');

		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'disable',
			'skiff-workload-wld_abc123.service',
		]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'enable',
			'skiff-workload-wld_abc123.socket',
		]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'skiff-workload-wld_abc123.service',
		]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'skiff-workload-wld_abc123.socket',
		]);
		expect(status.id).toBe('wld_abc123');
	});

	test('removes a stale container and pooler unit for the same id', async () => {
		const f = await fixture();
		await fs.mkdir(f.quadletDir, { recursive: true });
		const container = join(f.quadletDir, 'skiff-workload-wld_abc123.container');
		const pooler = join(f.quadletDir, 'skiff-workload-wld_abc123-pool.container');
		await fs.writeFile(container, 'stale');
		await fs.writeFile(pooler, 'stale');

		await f.driver.apply(functionWorkload(), activation(), functionFiles());
		await expect(fs.stat(container)).rejects.toThrow();
		await expect(fs.stat(pooler)).rejects.toThrow();
	});

	test('writes extra binding-service modules as 0600 credentials and loads each one', async () => {
		const f = await fixture();
		const files = functionFiles({
			files: {
				'binding-kv': 'export default { async fetch() { return new Response("kv"); } };\n',
				'binding-cache': 'export default {};\n',
			},
		});
		await f.driver.apply(functionWorkload(), activation(), files);

		const functionDir = join(f.runtimeDir, 'wld_abc123/function');
		for (const name of ['binding-kv', 'binding-cache']) {
			const path = join(functionDir, name);
			expect(await fs.readFile(path, 'utf8')).toBe(files.files![name]!);
			expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
		}
		const unit = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.service'), 'utf8');
		expect(unit).toContain(`LoadCredential=binding-kv:${join(functionDir, 'binding-kv')}`);
		expect(unit).toContain(`LoadCredential=binding-cache:${join(functionDir, 'binding-cache')}`);
		// Sorted by name, deterministic across applies.
		expect(unit.indexOf('LoadCredential=binding-cache:')).toBeLessThan(
			unit.indexOf('LoadCredential=binding-kv:'),
		);
	});

	test('a durable_object binding makes the do-storage directory writable for the host', async () => {
		const f = await fixture();
		const workload = functionWorkload({
			function: {
				...fnSpec(),
				bindings: [
					{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
				],
			},
		});
		await f.driver.apply(workload, activation(), functionFiles());

		const unit = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.service'), 'utf8');
		expect(unit).toContain('StateDirectory=skiff-workloads/wld_abc123/do');
		expect(unit).toContain(
			'--directory-path do-storage=/var/lib/skiff-workloads/wld_abc123/do',
		);
		// The helper never creates the directory itself; systemd owns it under DynamicUser.
		await expect(fs.stat(join(f.root, 'state/wld_abc123/do'))).rejects.toThrow();
	});

	test('is idempotent: a second apply with the same unit does not reload systemd', async () => {
		const f = await fixture();
		await f.driver.apply(functionWorkload(), activation(), functionFiles());
		const reloads = f.runner.count('daemon-reload');
		await f.driver.apply(functionWorkload(), activation(), functionFiles());
		expect(f.runner.count('daemon-reload')).toBe(reloads);
	});

	test('fails before writing anything when a module is missing', async () => {
		const f = await fixture({ modules: false });
		await expect(f.driver.apply(functionWorkload(), activation(), functionFiles())).rejects.toThrow(
			/Function module index\.js is missing/,
		);
		await expect(fs.stat(join(f.runtimeDir, 'wld_abc123'))).rejects.toThrow();
	});

	test('fails before writing anything when the pinned binary is missing, naming it', async () => {
		const f = await fixture({ workerd: false });
		const expected = join(f.workerdDir, WORKERD_VERSION, 'workerd');
		await expect(f.driver.apply(functionWorkload(), activation(), functionFiles())).rejects.toThrow(
			new RegExp(`${WORKERD_VERSION.replace(/\./g, '\\.')} is not installed at ${expected.replace(/[.]/g, '\\.')}`),
		);
		await expect(fs.stat(join(f.runtimeDir, 'wld_abc123'))).rejects.toThrow();
	});

	test('refuses function files for a process workload and a function without files', async () => {
		const f = await fixture();
		const processWorkload = parseWorkload(workloadInput({ runtime: 'process', function: undefined }));
		await expect(f.driver.apply(processWorkload, activation(), functionFiles())).rejects.toThrow(
			/only valid for a function workload/,
		);
		await expect(f.driver.apply(functionWorkload(), activation())).rejects.toThrow(
			/need request\.function\.config/,
		);
	});
});

describe('POST /v1/workloads: function files', () => {
	test('forwards the rendered files to the runtime', async () => {
		let forwarded: WorkloadFunctionFiles | undefined;
		const runtime = {
			async apply(
				workload: WorkloadDesired,
				_activation: WorkloadActivation,
				files?: WorkloadFunctionFiles,
			) {
				forwarded = files;
				return { id: workload.id, status: 'running' as const, restarts: 0 };
			},
		} as unknown as HelperRuntime;
		const handler = createHandler(runtime, { version: '0.1.0' });
		const files = functionFiles();
		const response = await handler(
			new Request('http://localhost/v1/workloads', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workload: workloadInput(), activation: activation(), function: files }),
			}),
		);
		expect(response.status).toBe(200);
		expect(forwarded).toEqual(files);
	});

	test('rejects a function workload with no files before calling the runtime', async () => {
		let called = false;
		const runtime = {
			async apply() {
				called = true;
				return { id: 'wld_abc123', status: 'running' as const, restarts: 0 };
			},
		} as unknown as HelperRuntime;
		const handler = createHandler(runtime, { version: '0.1.0' });
		const response = await handler(
			new Request('http://localhost/v1/workloads', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workload: workloadInput(), activation: activation() }),
			}),
		);
		expect(response.status).toBe(400);
		expect(called).toBe(false);
	});
});
