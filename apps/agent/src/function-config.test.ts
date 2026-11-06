import { describe, expect, test } from 'bun:test';
import {
	workloadDesiredSchema,
	type FunctionModule,
	type FunctionRuntimeBinding,
	type WorkloadDesired,
} from '@skiff/contracts';
import {
	capnpText,
	functionModuleEmbedNames,
	renderWorkerdConfig,
	renderWorkerdConfigParts,
} from './function-config.ts';

const SHA = 'c'.repeat(64);
const RELEASE_DIR = `/srv/skiff/releases/${SHA}`;

interface WorkloadOptions {
	main?: string;
	modules?: { name: string; type: FunctionModule['type'] }[];
	compatibilityFlags?: string[];
	bindings?: unknown[];
	memoryMb?: number;
}

/** A valid desired workload, parsed through the contract so the renderer sees exactly what a node sees. */
function functionWorkload(options: WorkloadOptions = {}): WorkloadDesired {
	const modules = options.modules ?? [{ name: 'index.js', type: 'esm' as const }];
	return workloadDesiredSchema.parse({
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/prj_1.sock',
		memoryMb: options.memoryMb ?? 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
		socketActivation: true,
		activationVersion: SHA,
		function: {
			main: options.main ?? 'index.js',
			modules: modules.map((module) => ({ ...module, sha256: SHA })),
			compatibilityDate: '2026-10-01',
			compatibilityFlags: options.compatibilityFlags ?? [],
			bindings: (options.bindings ?? []) as FunctionRuntimeBinding[],
			workerdVersion: '1.20261106.1',
		},
	});
}

function render(
	workload: WorkloadDesired,
	releaseDir = RELEASE_DIR,
	env: Record<string, string> = {},
): string {
	return renderWorkerdConfig({ workload, releaseDir, env });
}

function parts(workload: WorkloadDesired, env: Record<string, string> = {}) {
	return renderWorkerdConfigParts({ workload, releaseDir: RELEASE_DIR, env });
}

const HYPERDRIVE_ENV = {
	DATABASE_POOL_HOST: '127.0.0.1',
	DATABASE_POOL_PORT: '16432',
	DATABASE_USER: 'app',
	DATABASE_PASSWORD: 'hunter2',
	DATABASE_NAME: 'app_db',
};

function withHyperdrive(binding: Record<string, unknown> = {}) {
	return withBindings([
		{ name: 'DB', type: 'hyperdrive', database: 'app-db', envPrefix: 'DATABASE', ...binding },
	]);
}

/**
 * The contract schema only admits phase-1 bindings, so a phase-2/3 binding has to be smuggled in
 * through a cast: this is the "the control plane already refused it, the renderer must not" case.
 */
function withBindings(bindings: unknown[]): WorkloadDesired {
	const workload = functionWorkload();
	return { ...workload, function: { ...workload.function!, bindings: bindings as FunctionRuntimeBinding[] } };
}

/** Everything from the `main` Worker service onwards: binding services declare their own modules. */
function mainWorker(config: string): string {
	const start = config.indexOf('    ( name = "main",');
	return start === -1 ? config : config.slice(start);
}

function moduleLines(config: string): string[] {
	return mainWorker(config)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.includes('= embed "'));
}

function bindingLines(config: string): string[] {
	return mainWorker(config)
		.split('\n')
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.startsWith('( name = "') &&
				line.endsWith('),') &&
				!line.includes('= embed "') &&
				// The single-line `do-storage` service also looks like a binding line.
				!line.includes('disk = '),
		);
}

/** External services other than the always-present `tail-sink` (the agent's analytics/tail port). */
function externalLines(config: string): string[] {
	return config
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('external = (') && !line.includes(TAIL_SINK_ADDRESS));
}

/** The tail sink's fixed loopback address; binding-service tests filter it out. */
const TAIL_SINK_ADDRESS = '127.0.0.1:8085';

/** Every `"…"` literal in a rendered config, escapes included. */
function stringLiterals(source: string): string[] {
	return source.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
}

describe('functionModuleEmbedNames', () => {
	test('names modules module-0… in manifest order, for the helper credentials', () => {
		const modules: FunctionModule[] = [
			{ name: 'index.js', type: 'esm', sha256: SHA },
			{ name: 'lib/strings.js', type: 'esm', sha256: SHA },
			{ name: 'notes.txt', type: 'text', sha256: SHA },
		];
		expect(functionModuleEmbedNames(modules)).toEqual(['module-0', 'module-1', 'module-2']);
		expect(functionModuleEmbedNames([])).toEqual([]);
	});
});

describe('renderWorkerdConfig', () => {
	test('puts the shim first and embeds the manifest modules in order', () => {
		const workload = functionWorkload({
			modules: [
				{ name: 'index.js', type: 'esm' },
				{ name: 'lib/strings.js', type: 'esm' },
				{ name: 'notes.txt', type: 'text' },
				{ name: 'sum.wasm', type: 'wasm' },
			],
		});
		expect(moduleLines(render(workload))).toEqual([
			'( name = "function-shim", esModule = embed "function-shim" ),',
			'( name = "index.js", esModule = embed "module-0" ),',
			'( name = "lib/strings.js", esModule = embed "module-1" ),',
			'( name = "notes.txt", text = embed "module-2" ),',
			'( name = "sum.wasm", wasm = embed "module-3" ),',
		]);
	});

	test('maps every module kind to its workerd union member', () => {
		const workload = functionWorkload({
			modules: [
				{ name: 'index.js', type: 'esm' },
				{ name: 'legacy.cjs', type: 'cjs' },
				{ name: 'greeting.txt', type: 'text' },
				{ name: 'blob.bin', type: 'data' },
				{ name: 'sum.wasm', type: 'wasm' },
			],
		});
		const lines = moduleLines(render(workload));
		expect(lines[1]).toContain('esModule = embed "module-0"');
		expect(lines[2]).toContain('commonJsModule = embed "module-1"');
		expect(lines[3]).toContain('text = embed "module-2"');
		expect(lines[4]).toContain('data = embed "module-3"');
		expect(lines[5]).toContain('wasm = embed "module-4"');
	});

	test('renders the config envelope, the public-only egress and the http socket', () => {
		const config = render(functionWorkload());
		expect(config.startsWith('# Skiff function host for workload wl_1 (project api).\n')).toBe(true);
		expect(config).toContain(`# Module sources are embedded as helper credentials from the release at ${RELEASE_DIR}.`);
		expect(config).toContain('using Workerd = import "/workerd/workerd.capnp";');
		expect(config).toContain('const config :Workerd.Config = (');
		expect(config).toContain('structuredLogging = true,');
		expect(config).toContain('network = ( allow = ["public"], deny = ["private"] ) )');
		expect(config).toContain('compatibilityDate = "2026-10-01",');
		expect(config).toContain('globalOutbound = "internet",');
		expect(config).toContain('sockets = [ ( name = "http", http = (), service = "main" ) ],');
		expect(config.endsWith(')\n')).toBe(true);
		// Phase 4/5 config surface must never appear in a phase-1 host. The phase-3 tail Worker is
		// always present, so `tails` is asserted separately below.
		for (const forbidden of [
			'cluster =',
			'durableObjectStorage',
			'containerEngine',
			'workerLoader',
			'workflowsEngine',
			'serviceWorkerScript',
			'durableObjectNamespaces',
		]) {
			expect(config).not.toContain(forbidden);
		}
	});

	test('renders phase-1 bindings in order', () => {
		const workload = withBindings([
			{ name: 'GREETING', type: 'text', value: 'hello' },
			{ name: 'CONFIG', type: 'json', value: { retries: 3, tags: ['a', 'b'] } },
			{ name: 'API_KEY', type: 'secret' },
			{ name: 'STRIPE', type: 'secret', secret: 'STRIPE_KEY' },
			{ name: 'SELF', type: 'service' },
			{ name: 'ADMIN', type: 'service', entrypoint: 'admin' },
		]);
		expect(bindingLines(render(workload))).toEqual([
			'( name = "GREETING", text = "hello" ),',
			`( name = "CONFIG", json = ${capnpText(JSON.stringify({ retries: 3, tags: ['a', 'b'] }))} ),`,
			'( name = "API_KEY", fromEnvironment = "API_KEY" ),',
			'( name = "STRIPE", fromEnvironment = "STRIPE_KEY" ),',
			'( name = "SELF", service = "main" ),',
			'( name = "ADMIN", service = ( name = "main", entrypoint = "admin" ) ),',
		]);
	});

	test('gives two app bindings with the same upstream one external service', () => {
		const workload = withBindings([
			{ name: 'SHOP', type: 'app', project: 'shop', upstream: 'unix//run/skiff-workloads/prj_shop.sock' },
			{ name: 'SHOP_AGAIN', type: 'app', project: 'shop', upstream: 'unix:/run/skiff-workloads/prj_shop.sock' },
			{ name: 'WEB', type: 'app', project: 'web', upstream: 'http://127.0.0.1:4100' },
		]);
		const config = render(workload);
		expect(externalLines(config)).toEqual([
			'external = ( address = "unix:/run/skiff-workloads/prj_shop.sock", http = () ) ),',
			'external = ( address = "127.0.0.1:4100", http = () ) ),',
		]);
		expect(config).toContain('( name = "app-0",');
		expect(config).toContain('( name = "app-1",');
		expect(bindingLines(config)).toEqual([
			'( name = "SHOP", service = "app-0" ),',
			'( name = "SHOP_AGAIN", service = "app-0" ),',
			'( name = "WEB", service = "app-1" ),',
		]);
	});

	test('converts Caddy unix and loopback upstreams to workerd addresses', () => {
		const cases: [upstream: string, address: string][] = [
			['unix//run/skiff-workloads/prj_a.sock', 'unix:/run/skiff-workloads/prj_a.sock'],
			['unix://run/skiff-workloads/prj_b.sock', 'unix:/run/skiff-workloads/prj_b.sock'],
			['unix:/run/skiff-workloads/prj_c.sock', 'unix:/run/skiff-workloads/prj_c.sock'],
			['unix:///run/skiff-workloads/prj_d.sock', 'unix:/run/skiff-workloads/prj_d.sock'],
			['http://127.0.0.1:3000', '127.0.0.1:3000'],
			['https://127.0.0.1:3443/', '127.0.0.1:3443'],
			['127.0.0.1:8080', '127.0.0.1:8080'],
			['http://127.0.0.2:8081/api', '127.0.0.2:8081'],
			['localhost:9090', 'localhost:9090'],
			['[::1]:9000', '[::1]:9000'],
		];
		for (const [upstream, address] of cases) {
			const config = render(withBindings([{ name: 'TARGET', type: 'app', project: 'target', upstream }]));
			expect(externalLines(config)).toEqual([`external = ( address = "${address}", http = () ) ),`]);
		}
	});

	test('sizes the V8 heap at 75% of memoryMb with a 32 MiB floor', () => {
		const flags = (memoryMb: number): string =>
			render(functionWorkload({ memoryMb }))
				.split('\n')
				.find((line) => line.includes('v8Flags'))!;
		expect(flags(128)).toBe('  v8Flags = ["--max-old-space-size=96"],');
		expect(flags(256)).toBe('  v8Flags = ["--max-old-space-size=192"],');
		expect(flags(64)).toBe('  v8Flags = ["--max-old-space-size=48"],');
		// 32 MB floors to 24 in the fraction; the floor wins so V8 still has a usable heap.
		expect(flags(32)).toBe('  v8Flags = ["--max-old-space-size=32"],');
	});

	test('escapes JSON and text binding values safely', () => {
		const json = { quote: 'he said "hi"', path: 'C:\\tmp', line: 'line 1\nline 2', accent: 'é' };
		const config = render(
			withBindings([
				{ name: 'DATA', type: 'json', value: json },
				{ name: 'TEMPLATE', type: 'text', value: '100% $HOME ${USER} %d' },
			]),
		);
		expect(config).toContain(`json = ${capnpText(JSON.stringify(json))}`);
		expect(config).toContain('text = "100% $HOME ${USER} %d"');
		expect(bindingLines(config)[1]).toBe('( name = "TEMPLATE", text = "100% $HOME ${USER} %d" ),');
	});

	test('escapes capnp text by UTF-8 byte', () => {
		expect(capnpText('')).toBe('""');
		expect(capnpText('plain')).toBe('"plain"');
		expect(capnpText('a"b')).toBe('"a\\"b"');
		expect(capnpText('a\\b')).toBe('"a\\\\b"');
		expect(capnpText('a\nb')).toBe('"a\\nb"');
		expect(capnpText('a\rb')).toBe('"a\\rb"');
		expect(capnpText('a\tb')).toBe('"a\\tb"');
		expect(capnpText('\u0000\u001f\u007f')).toBe('"\\x00\\x1f\\x7f"');
		// Two UTF-8 bytes, each escaped, so the literal is pure ASCII and can never be split.
		expect(capnpText('é')).toBe('"\\xc3\\xa9"');
		expect(capnpText('100% $HOME ${USER} %d')).toBe('"100% $HOME ${USER} %d"');
	});

	test('never puts a raw newline inside a string literal', () => {
		const values = [
			'first\nsecond',
			'crlf\r\nnext',
			'tab\there',
			'quote " and backslash \\',
			'non-ascii é ✓ 日本語',
			'control \u0001\u0002',
			'100% $HOME ${USER} %d',
		];
		const SAFE_LITERAL = /^"(?:[^"\\\u0000-\u001f\u007f]|\\["\\nrt]|\\x[0-9a-f]{2})*"$/;
		for (const value of values) {
			const config = render(withBindings([{ name: 'NOTE', type: 'text', value }]));
			const literals = stringLiterals(config);
			expect(literals.length).toBeGreaterThan(0);
			for (const literal of literals) {
				expect(literal).toMatch(SAFE_LITERAL);
				expect(literal).not.toContain('\n');
			}
			// The escaped value adds no lines: the literal is one line, like a plain value's.
			const plain = render(withBindings([{ name: 'NOTE', type: 'text', value: 'plain' }]));
			expect(config.split('\n').length).toBe(plain.split('\n').length);
		}
	});

	test('refuses an unknown binding type', () => {
		expect(() => render(withBindings([{ name: 'MYSTERY', type: 'teleporter' }]))).toThrow(
			/which has no node renderer in this Skiff build yet/,
		);
	});

	test('refuses a non-loopback app upstream instead of rendering it', () => {
		for (const upstream of [
			'10.1.2.3:5432',
			'http://example.com',
			'0.0.0.0:8080',
			'127.0.0.1',
			'127.0.0.1:99999',
			'127.0.0.1:0',
			'127.999.0.1:80',
			'unix:relative.sock',
			'',
		]) {
			const workload = withBindings([{ name: 'DB', type: 'app', project: 'db', upstream }]);
			expect(() => render(workload)).toThrow(/App binding "DB" has upstream/);
		}
	});

	test('throws for a workload that is not a function', () => {
		const processWorkload = workloadDesiredSchema.parse({
			id: 'wl_2',
			projectId: 'prj_2',
			projectSlug: 'web',
			deploymentId: 'dep_2',
			runtime: 'process',
			status: 'running',
			release: SHA,
			command: ['bun', 'run', 'start'],
			upstream: 'unix//run/skiff-workloads/prj_2.sock',
			memoryMb: 256,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: true,
			activationVersion: SHA,
		});
		expect(() => render(processWorkload)).toThrow(/its runtime is "process", not "function"/);
	});

	test('throws for a function workload with no resolved spec', () => {
		const workload = { ...functionWorkload(), function: undefined };
		expect(() => render(workload)).toThrow(/it has no resolved function spec/);
	});

	test('is deterministic', () => {
		const bindings = [
			{ name: 'GREETING', type: 'text', value: 'hello' },
			{ name: 'SHOP', type: 'app', project: 'shop', upstream: 'unix//run/skiff-workloads/prj_shop.sock' },
		];
		// Two independently built workloads: no clock, no randomness, no module-level state.
		const first = render(withBindings(bindings));
		expect(render(withBindings(bindings))).toBe(first);
	});

	test('matches the full rendered config', () => {
		const workload = functionWorkload({
			memoryMb: 256,
			modules: [
				{ name: 'index.js', type: 'esm' },
				{ name: 'lib/util.js', type: 'esm' },
			],
			compatibilityFlags: ['nodejs_compat'],
			bindings: [
				{ name: 'GREETING', type: 'text', value: 'hello world' },
				{ name: 'API_KEY', type: 'secret' },
				{ name: 'ADMIN', type: 'service', entrypoint: 'admin' },
				{ name: 'SHOP', type: 'app', project: 'shop', upstream: 'unix//run/skiff-workloads/prj_shop.sock' },
			],
		});
		expect(render(workload)).toBe(`# Skiff function host for workload wl_1 (project api).
# Rendered by the agent from desired state on every apply; local edits are overwritten.
# Module sources are embedded as helper credentials from the release at ${RELEASE_DIR}.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  v8Flags = ["--max-old-space-size=192"],
  structuredLogging = true,
  services = [
    ( name = "internet",
      network = ( allow = ["public"], deny = ["private"] ) ),
    ( name = "app-0",
      external = ( address = "unix:/run/skiff-workloads/prj_shop.sock", http = () ) ),
    ( name = "tail-api",
      worker = (
        modules = [
          ( name = "tail.worker", esModule = embed "binding-tail" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [],
        bindings = [
          ( name = "SINK", service = "tail-sink" ),
          ( name = "WORKLOAD_ID", text = "wl_1" ),
          ( name = "PROJECT_ID", text = "prj_1" ),
        ],
      ) ),
    ( name = "tail-sink",
      external = ( address = "127.0.0.1:8085", http = () ) ),
    ( name = "main",
      worker = (
        modules = [
          ( name = "function-shim", esModule = embed "function-shim" ),
          ( name = "index.js", esModule = embed "module-0" ),
          ( name = "lib/util.js", esModule = embed "module-1" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [ "nodejs_compat" ],
        globalOutbound = "internet",
        tails = [ "tail-api" ]
        bindings = [
          ( name = "GREETING", text = "hello world" ),
          ( name = "API_KEY", fromEnvironment = "API_KEY" ),
          ( name = "ADMIN", service = ( name = "main", entrypoint = "admin" ) ),
          ( name = "SHOP", service = "app-0" ),
        ],
      ) )
  ],
  sockets = [ ( name = "http", http = (), service = "main" ) ],
)
`);
	});
});

describe('phase-3 tail worker', () => {
	test('every function host gets the tail Worker, its sink service and the tails field', () => {
		const rendered = parts(functionWorkload());
		expect(Object.keys(rendered.files)).toEqual(['binding-tail']);
		expect(rendered.files['binding-tail']).toContain('http://analytics/tail');
		expect(rendered.config).toContain(
			[
				'    ( name = "tail-api",',
				'      worker = (',
				'        modules = [',
				'          ( name = "tail.worker", esModule = embed "binding-tail" ),',
				'        ],',
			].join('\n'),
		);
		expect(rendered.config).toContain('( name = "SINK", service = "tail-sink" )');
		expect(rendered.config).toContain('( name = "WORKLOAD_ID", text = "wl_1" )');
		expect(rendered.config).toContain('( name = "PROJECT_ID", text = "prj_1" )');
		expect(rendered.config).toContain(
			'    ( name = "tail-sink",\n      external = ( address = "127.0.0.1:8085", http = () ) )',
		);
		// The main Worker lists it in `tails`; the tail Worker declares no durable storage.
		expect(rendered.config).toContain('        tails = [ "tail-api" ]');
		expect(rendered.config).not.toContain('durableObjectStorage');
	});

	test('renders the tail Worker beside every phase-2 binding service', () => {
		const rendered = parts(withBindings([{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' }]));
		expect(rendered.config).toContain('( name = "kv-api-0",');
		expect(rendered.config).toContain('( name = "tail-api",');
		expect(rendered.config).toContain('tails = [ "tail-api" ]');
		// Binding modules and the tail module are separate embedded credentials.
		expect(Object.keys(rendered.files).sort()).toEqual(['binding-kv', 'binding-tail']);
	});

	test('is deterministic when the tail Worker is merged', () => {
		expect(parts(functionWorkload())).toEqual(parts(functionWorkload()));
	});
});

describe('phase-2 Durable Objects', () => {
	function withDurableObject(className = 'Room', name = 'ROOMS', uniqueKey = 'prj_1-ROOMS') {
		return withBindings([{ name, type: 'durable_object', className, uniqueKey }]);
	}

	test('declares the class once and points the binding at it', () => {
		const { config, files } = parts(withDurableObject());
		// The phase-3 tail module is always embedded; a binding adds no file of its own.
		expect(Object.keys(files)).toEqual(['binding-tail']);
		expect(serviceLines(config)).toContain('( name = "do-storage", disk = ( writable = true ) ),');
		expect(config).toContain('durableObjectStorage = ( localDisk = "do-storage" ),');
		expect(config).toContain(
			'( className = "Room", uniqueKey = "prj_1-ROOMS", enableSql = true ),',
		);
		expect(bindingLines(config)).toContain(
			'( name = "ROOMS", durableObjectNamespace = "Room" ),',
		);
		// The phase-1 egress line is untouched.
		expect(config).toContain('network = ( allow = ["public"], deny = ["private"] ) )');
	});

	test('two classes get two namespaces but one shared disk service', () => {
		const workload = withBindings([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'COUNTER', type: 'durable_object', className: 'Counter', uniqueKey: 'prj_1-COUNTER' },
		]);
		const config = render(workload);
		expect(serviceLines(config).filter((line) => line.includes('do-storage'))).toHaveLength(1);
		expect(namespaceLines(config)).toEqual([
			'( className = "Room", uniqueKey = "prj_1-ROOMS", enableSql = true ),',
			'( className = "Counter", uniqueKey = "prj_1-COUNTER", enableSql = true ),',
		]);
		expect(bindingLines(config)).toEqual([
			'( name = "ROOMS", durableObjectNamespace = "Room" ),',
			'( name = "COUNTER", durableObjectNamespace = "Counter" ),',
		]);
	});

	test('the same class declared twice is merged, a conflicting key is refused', () => {
		const same = withBindings([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'ROOMS_AGAIN', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
		]);
		const config = render(same);
		expect(namespaceLines(config)).toEqual([
			'( className = "Room", uniqueKey = "prj_1-ROOMS", enableSql = true ),',
		]);
		expect(bindingLines(config)).toHaveLength(2);

		const conflicting = withBindings([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'ROOMS_AGAIN', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS_AGAIN' },
		]);
		expect(() => render(conflicting)).toThrow(
			/declares Durable Object class "Room" with unique key "prj_1-ROOMS_AGAIN"/,
		);
	});

	test('a binding order with no Durable Object emits no namespace or disk service', () => {
		const config = render(functionWorkload());
		expect(config).not.toContain('durableObject');
		expect(config).not.toContain('do-storage');
	});
});

describe('phase-2 Hyperdrive', () => {
	test('points at the pooled loopback port and embeds the credentials', () => {
		const { config, files } = parts(withHyperdrive(), HYPERDRIVE_ENV);
		// The phase-3 tail module is always embedded; a binding adds no file of its own.
		expect(Object.keys(files)).toEqual(['binding-tail']);
		expect(serviceLines(config)).toEqual([
			'( name = "hyperdrive-0",',
			'external = ( address = "127.0.0.1:16432", tcp = () ) ),',
		]);
		expect(bindingLines(config)).toEqual([
			'( name = "DB", hyperdrive = ( designator = "hyperdrive-0", database = "app_db", user = "app", password = "hunter2", scheme = "postgres" ) ),',
		]);
		// The config itself carries credentials; say so, and rely on the helper's 0600 credential.
		expect(config).toContain('# This config carries Hyperdrive credentials.');
		expect(config).toContain('0600 systemd credential');
	});

	test('falls back to the direct host and port when there is no pooler', () => {
		const env = { ...HYPERDRIVE_ENV };
		delete (env as Record<string, string>).DATABASE_POOL_HOST;
		delete (env as Record<string, string>).DATABASE_POOL_PORT;
		(env as Record<string, string>).DATABASE_HOST = '127.0.0.1';
		(env as Record<string, string>).DATABASE_PORT = '15432';
		const config = parts(withHyperdrive(), env).config;
		expect(serviceLines(config)).toContain('external = ( address = "127.0.0.1:15432", tcp = () ) ),');
	});

	test('uses the attachment env prefix and a stable index per rendered binding', () => {
		const workload = withBindings([
			{ name: 'LEDGER', type: 'hyperdrive', database: 'ledger', envPrefix: 'LEDGER' },
			{ name: 'ANALYTICS', type: 'hyperdrive', database: 'analytics', envPrefix: 'ANALYTICS' },
		]);
		const config = renderWorkerdConfigParts({
			workload,
			releaseDir: RELEASE_DIR,
			env: {
				LEDGER_POOL_HOST: '127.0.0.1',
				LEDGER_POOL_PORT: '20001',
				LEDGER_USER: 'ledger',
				LEDGER_PASSWORD: 'one',
				LEDGER_NAME: 'ledger',
				ANALYTICS_POOL_HOST: '127.0.0.1',
				ANALYTICS_POOL_PORT: '20002',
				ANALYTICS_USER: 'analytics',
				ANALYTICS_PASSWORD: 'two',
				ANALYTICS_NAME: 'analytics',
			},
		}).config;
		expect(serviceLines(config)).toEqual([
			'( name = "hyperdrive-0",',
			'external = ( address = "127.0.0.1:20001", tcp = () ) ),',
			'( name = "hyperdrive-1",',
			'external = ( address = "127.0.0.1:20002", tcp = () ) ),',
		]);
		expect(bindingLines(config)).toContain(
			'( name = "ANALYTICS", hyperdrive = ( designator = "hyperdrive-1", database = "analytics", user = "analytics", password = "two", scheme = "postgres" ) ),',
		);
	});

	test('coexists with a Durable Object: Do storage, external and both bindings', () => {
		const workload = withBindings([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			{ name: 'DB', type: 'hyperdrive', database: 'app-db', envPrefix: 'DATABASE' },
		]);
		const config = renderWorkerdConfigParts({ workload, releaseDir: RELEASE_DIR, env: HYPERDRIVE_ENV }).config;
		expect(serviceLines(config)).toContain('( name = "do-storage", disk = ( writable = true ) ),');
		expect(serviceLines(config)).toContain('external = ( address = "127.0.0.1:16432", tcp = () ) ),');
		expect(namespaceLines(config)).toHaveLength(1);
		expect(bindingLines(config)).toHaveLength(2);
	});

	test('refuses to render when the activation env is missing any credential', () => {
		for (const missing of [
			'DATABASE_POOL_HOST',
			'DATABASE_POOL_PORT',
			'DATABASE_USER',
			'DATABASE_PASSWORD',
			'DATABASE_NAME',
		]) {
			const env = { ...HYPERDRIVE_ENV } as Record<string, string>;
			delete env[missing];
			// The host/port pair falls back to the direct variables: remove those too.
			if (missing === 'DATABASE_POOL_HOST') delete env.DATABASE_HOST;
			if (missing === 'DATABASE_POOL_PORT') delete env.DATABASE_PORT;
			expect(() => render(withHyperdrive(), RELEASE_DIR, env)).toThrow(
				new RegExp(`Hyperdrive binding "DB" cannot be rendered: the activation env is missing .*${missing}`),
			);
		}
		// An explicit empty value counts as missing, never as an empty credential.
		for (const key of Object.keys(HYPERDRIVE_ENV)) {
			const env = { ...HYPERDRIVE_ENV, [key]: '' } as Record<string, string>;
			expect(() => render(withHyperdrive(), RELEASE_DIR, env)).toThrow(/activation env is missing/);
		}
	});

	test('refuses an out-of-range port instead of handing workerd a bad address', () => {
		const env = { ...HYPERDRIVE_ENV, DATABASE_POOL_PORT: '70000' };
		expect(() => render(withHyperdrive(), RELEASE_DIR, env)).toThrow(/invalid DATABASE_PORT "70000"/);
		const notANumber = { ...HYPERDRIVE_ENV, DATABASE_POOL_PORT: 'postgres' };
		expect(() => render(withHyperdrive(), RELEASE_DIR, notANumber)).toThrow(/invalid DATABASE_PORT/);
	});

	test('escapes every credential through capnpText', () => {
		const password = 'p"a\\ss\nword';
		const user = 'odd user';
		const env = { ...HYPERDRIVE_ENV, DATABASE_PASSWORD: password, DATABASE_USER: user };
		const config = render(withHyperdrive(), RELEASE_DIR, env);
		expect(config).toContain(`password = ${capnpText(password)}`);
		expect(config).toContain(`user = ${capnpText(user)}`);
		// One line per binding even with an escaped newline inside a value.
		expect(bindingLines(config)).toHaveLength(1);
	});

	test('is deterministic across independent renders', () => {
		const make = () =>
			withBindings([
				{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
				{ name: 'DB', type: 'hyperdrive', database: 'app-db', envPrefix: 'DATABASE' },
			]);
		expect(renderWorkerdConfigParts({ workload: make(), releaseDir: RELEASE_DIR, env: HYPERDRIVE_ENV })).toEqual(
			renderWorkerdConfigParts({ workload: make(), releaseDir: RELEASE_DIR, env: HYPERDRIVE_ENV }),
		);
	});
});

/** Service names, external addresses and the disk service, without the worker or network blocks. */
function serviceLines(config: string): string[] {
	return config
		.split('\n')
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.startsWith('( name = "hyperdrive-') ||
				(line.startsWith('external = ( address = ') && !line.includes(TAIL_SINK_ADDRESS)) ||
				line.startsWith('( name = "do-storage"'),
		);
}

function namespaceLines(config: string): string[] {
	return config
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('( className = '));
}

describe('phase-2 KV and Cache services', () => {
	test('a KV binding adds a service, a DO namespace, the shared disk and the capability binding', () => {
		const rendered = renderWorkerdConfigParts({
			workload: withBindings([{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' }]),
			releaseDir: RELEASE_DIR,
		});
		expect(rendered.config).toContain('( name = "kv-api-0",');
		expect(rendered.config).toContain('( className = "KVNamespaceObject", uniqueKey = "prj_1-CACHE", enableSql = false )');
		expect(rendered.config).toContain('( name = "do-storage", disk = ( writable = true ) )');
		expect(rendered.config).toContain('( name = "CACHE", kvNamespace = "kv-api-0" )');
		// The KV service declares its own namespace; the user Worker has no namespace of its own.
		expect(rendered.config).not.toMatch(/durableObjectNamespaces[\s\S]*durableObjectNamespaces/);
		expect(rendered.files['binding-kv']).toContain('export class KVNamespaceObject');
	});

	test('two KV bindings share one embedded module but get distinct services', () => {
		const rendered = renderWorkerdConfigParts({
			workload: withBindings([
				{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' },
				{ name: 'SESSIONS', type: 'kv', namespaceId: 'prj_1-SESSIONS' },
			]),
			releaseDir: RELEASE_DIR,
		});
		expect(rendered.config).toContain('( name = "CACHE", kvNamespace = "kv-api-0" )');
		expect(rendered.config).toContain('( name = "SESSIONS", kvNamespace = "kv-api-1" )');
		expect(Object.keys(rendered.files).sort()).toEqual(['binding-kv', 'binding-tail']);
	});

	test('a cache binding adds cacheApiOutbound and one service', () => {
		const rendered = renderWorkerdConfigParts({
			workload: withBindings([{ name: 'HTTP', type: 'cache' }]),
			releaseDir: RELEASE_DIR,
		});
		expect(rendered.config).toContain('cacheApiOutbound = "cache-api-0"');
		expect(rendered.config).toContain('( className = "CacheObject", uniqueKey = "prj_1-HTTP", enableSql = false )');
		expect(rendered.files['binding-cache']).toContain('export class CacheObject');
	});

	test('workerd has one cacheApiOutbound per Worker, so a second cache binding is refused', () => {
		expect(() =>
			renderWorkerdConfigParts({
				workload: withBindings([
					{ name: 'HTTP', type: 'cache' },
					{ name: 'EDGE', type: 'cache' },
				]),
				releaseDir: RELEASE_DIR,
			}),
		).toThrow(/at most one cache binding/);
	});

	test('KV and Durable Objects coexist on one shared disk service', () => {
		const rendered = renderWorkerdConfigParts({
			workload: withBindings([
				{ name: 'CACHE', type: 'kv', namespaceId: 'prj_1-CACHE' },
				{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
			]),
			releaseDir: RELEASE_DIR,
		});
		expect(rendered.config.match(/name = "do-storage"/g)).toHaveLength(1);
		expect(rendered.config).toContain('( name = "ROOMS", durableObjectNamespace = "Room" )');
		expect(rendered.config).toContain('( className = "Room", uniqueKey = "prj_1-ROOMS", enableSql = true )');
	});
});
