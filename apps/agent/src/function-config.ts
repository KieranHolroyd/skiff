import {
	FUNCTION_BINDING_PHASE,
	type FunctionModule,
	type FunctionRuntimeBinding,
	type FunctionRuntimeSpec,
	type WorkloadDesired,
} from '@skiff/contracts';
import { PHASE_ONE_BINDING_TYPES, bindingRenderer } from './function-bindings/index.ts';
import { renderTailWorker } from './function-bindings/tail.ts';

/**
 * Renderer for the workerd Cap'n Proto config of a function workload (docs/FUNCTIONS.md §4.1,
 * §4.6). The agent renders this fresh from desired state on every apply and hands it to the helper,
 * which writes it verbatim and starts the pinned workerd binary. Nothing here touches the disk:
 * the output is a pure function of the workload, so two applies of the same desired state produce
 * byte-identical configs.
 *
 * The module *contents* are not inlined. The helper writes each module to a systemd credential and
 * workerd resolves `embed` relative to the config's own directory in the credentials directory, so
 * the embed names below (`function-shim`, `module-<i>`) are a hard cross-package contract.
 */

export interface RenderWorkerdConfigInput {
	/** A desired workload with `runtime === 'function'` and a resolved `function` spec. */
	workload: WorkloadDesired;
	/** Absolute release directory. Only used for the explanatory header; modules are embedded. */
	releaseDir: string;
	/**
	 * Activation env for this apply, secret values included. Hyperdrive renders its credentials
	 * from it (workerd has no `fromEnvironment` form for that binding); every other backend uses
	 * `fromEnvironment` and ignores this.
	 */
	env?: Record<string, string>;
}

export interface RenderedWorkerdConfig {
	config: string;
	/**
	 * Extra worker modules a binding backend needs embedded (KV/R2/queue services later), keyed by
	 * the systemd credential name the config's `embed` refers to. The helper writes each one 0600.
	 */
	files: Record<string, string>;
}

/** Module name (and credential/embed name) of the generated shim. Fixed contract with the helper. */
const SHIM_MODULE_NAME = 'function-shim';

/** `Worker.modules` union member for each manifest module type (workerd.capnp). */
const MODULE_KINDS: Record<FunctionModule['type'], string> = {
	esm: 'esModule',
	cjs: 'commonJsModule',
	text: 'text',
	data: 'data',
	wasm: 'wasm',
};

/**
 * Embed names of the manifest's modules, in manifest order: `['module-0', 'module-1', …]`.
 *
 * The helper writes `LoadCredential=module-<i>:<releaseDir>/<modules[i].name>`, so the index is the
 * contract: a renderer that reordered or renamed these would make workerd load the wrong bytes.
 */
export function functionModuleEmbedNames(modules: FunctionModule[]): string[] {
	return modules.map((_, index) => `module-${index}`);
}

/**
 * Render the Cap'n Proto text config for a function host.
 *
 * Throws a plain `Error` when the workload is not a function, has no resolved spec, or references
 * something this build cannot render (a binding with no renderer yet, a non-loopback app upstream). It
 * deliberately does not re-validate the manifest: the control plane and the helper do that, and a
 * renderer that second-guesses them drifts out of sync.
 */
export function renderWorkerdConfig(input: RenderWorkerdConfigInput): string {
	return renderWorkerdConfigParts(input).config;
}

/**
 * Render the Cap'n Proto text config plus the extra worker modules a backend needs embedded.
 *
 * The composer dispatches every binding through `function-bindings/index.ts`: phase-2 renderers
 * return config fragments and files, while the five phase-1 kinds keep their original inline
 * rendering so their output stays byte-identical. Every function host also gets the phase-3 tail
 * Worker (it is not a binding), merged after the binding fragments. Durable Object namespaces are
 * merged into the one list workerd accepts, and the shared `do-storage` service is emitted once
 * when any backend needs it.
 */
export function renderWorkerdConfigParts(input: RenderWorkerdConfigInput): RenderedWorkerdConfig {
	const { workload, releaseDir } = input;
	if (workload.runtime !== 'function')
		throw new Error(
			`Cannot render a workerd config for workload ${workload.id}: its runtime is "${workload.runtime}", not "function".`,
		);
	const spec = workload.function;
	if (!spec)
		throw new Error(`Cannot render a workerd config for workload ${workload.id}: it has no resolved function spec.`);

	const fragments = collectBindingFragments(workload, spec, input.env ?? {}, releaseDir);
	mergeTailWorker(workload, fragments);

	// The embed names come from the exported helper so the config and the helper's
	// `LoadCredential=module-<i>:…` lines can never drift apart.
	const embedNames = functionModuleEmbedNames(spec.modules);
	const moduleLines = [
		`          ( name = ${capnpText(SHIM_MODULE_NAME)}, esModule = embed ${capnpText(SHIM_MODULE_NAME)} ),`,
		...spec.modules.map(
			(module, index) =>
				`          ( name = ${capnpText(module.name)}, ${moduleKind(module)} = embed ${capnpText(embedNames[index]!)} ),`,
		),
	];

	const flags =
		spec.compatibilityFlags.length === 0
			? '[]'
			: `[ ${spec.compatibilityFlags.map((flag) => capnpText(flag)).join(', ')} ]`;
	const bindings =
		fragments.mainBindings.length === 0
			? '        bindings = [],'
			: `        bindings = [\n${fragments.mainBindings.join('\n')}\n        ],`;
	// One `durableObjectNamespaces` list, emitted only when the *main* Worker declares a class.
	// A service-backed binding (KV later) owns its namespace inside its own service instead.
	const durableFields =
		fragments.namespaces.length === 0
			? []
			: [
					'        durableObjectStorage = ( localDisk = "do-storage" ),',
					'        durableObjectNamespaces = [',
					...fragments.namespaces.map(
						(namespace) =>
							`          ( className = ${capnpText(namespace.className)}, uniqueKey = ${capnpText(namespace.uniqueKey)}, enableSql = ${namespace.enableSql} ),`,
					),
					'        ],',
				];

	// Service blocks carry no trailing comma: `serviceBlocks.join(',\n')` supplies the separators.
	const serviceBlocks = [
		// FN7: the egress first line. Global fetch()/connect() can reach public addresses only;
		// every intentional private target is an explicit `external` service below, which is a
		// capability the user declared and the control plane validated.
		'    ( name = "internet",\n      network = ( allow = ["public"], deny = ["private"] ) )',
		...fragments.services,
		// One shared disk service for every Durable Object/KV/cache backend (FN11). The helper
		// passes its directory with `--directory-path`; the main Worker points at it above.
		...(fragments.requiresDurableStorage
			? ['    ( name = "do-storage", disk = ( writable = true ) )']
			: []),
		[
			'    ( name = "main",',
			'      worker = (',
			'        modules = [',
			...moduleLines,
			'        ],',
			`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
			`        compatibilityFlags = ${flags},`,
			'        globalOutbound = "internet",',
			...fragments.mainFields,
			...durableFields,
			bindings,
			'      ) )',
		].join('\n'),
	];

	const header = [
		`# Skiff function host for workload ${commentText(workload.id)} (project ${commentText(workload.projectSlug)}).`,
		'# Rendered by the agent from desired state on every apply; local edits are overwritten.',
		`# Module sources are embedded as helper credentials from the release at ${commentText(releaseDir)}.`,
		// Hyperdrive credentials are literals in this file; say so where a reader will see it.
		...(fragments.carriesCredentials
			? [
					'# This config carries Hyperdrive credentials. The helper writes it as a 0600 systemd credential;',
					'# it is never cached as a release artifact and never stored in desired state.',
				]
			: []),
		'',
		'using Workerd = import "/workerd/workerd.capnp";',
		'',
		'const config :Workerd.Config = (',
		`  v8Flags = [${capnpText(`--max-old-space-size=${heapMegabytes(workload.memoryMb)}`)}],`,
		'  structuredLogging = true,',
		'  services = [',
		serviceBlocks.join(',\n'),
		'  ],',
		...((fragments.extensions ?? []).length > 0
			? [
					'  extensions = [',
					fragments.extensions.join(',\n'),
					'  ],',
				]
			: []),
		'  sockets = [ ( name = "http", http = (), service = "main" ) ],',
		')',
		'',
	];

	return { config: header.join('\n'), files: fragments.files };
}

interface CollectedFragments {
	/** Complete `Worker.bindings` entries, in manifest order, each ending in a comma. */
	mainBindings: string[];
	/** Merged `durableObjectNamespaces` entries, first declaration order. */
	namespaces: Array<{ className: string; uniqueKey: string; enableSql: boolean }>;
	/** Other `Worker` fields from renderers, already indented eight spaces. */
	mainFields: string[];
	/** Complete top-level service blocks after `internet`, in binding order. */
	services: string[];
	extensions: string[];
	files: Record<string, string>;
	requiresDurableStorage: boolean;
	/** True when a backend embedded a credential in the config (Hyperdrive). */
	carriesCredentials: boolean;
}

/**
 * Walk the bindings once, in manifest order, and collect everything the config needs. App bindings
 * keep their phase-1 external-service treatment; phase-2 types go through the renderer registry.
 */
function collectBindingFragments(
	workload: WorkloadDesired,
	spec: FunctionRuntimeSpec,
	env: Record<string, string>,
	releaseDir: string,
): CollectedFragments {
	const mainBindings: string[] = [];
	const namespaces: CollectedFragments['namespaces'] = [];
	const namespacesByClass = new Map<string, CollectedFragments['namespaces'][number]>();
	const mainFields: string[] = [];
	const services: string[] = [];
	const extensions: string[] = [];
	const files: Record<string, string> = {};
	const byAddress = new Map<string, string>();
	let externalCount = 0;
	let renderIndex = 0;
	let requiresDurableStorage = false;
	let carriesCredentials = false;
	let cacheBindings = 0;

	for (const binding of spec.bindings) {
		if (binding.type === 'cache') {
			cacheBindings += 1;
			if (cacheBindings > 1)
				throw new Error(
					'A function host can declare at most one cache binding: workerd has a single `cacheApiOutbound` per Worker.',
				);
		}

		// Phase 1: one external service per distinct app upstream, named `app-0`, … in binding order.
		if (binding.type === 'app') {
			const address = normalizeUpstream(binding.upstream, binding.name);
			if (!byAddress.has(address)) {
				const name = `app-${externalCount}`;
				externalCount += 1;
				byAddress.set(address, name);
				services.push(externalServiceBlock(name, address));
			}
		}

		const renderer = bindingRenderer(binding.type);
		if (renderer) {
			// `index` is the ordinal among *service-backed* rendered bindings, not among all
			// bindings: adding a text binding or a native-only Durable Object must not rename a KV
			// service or credential. Hyperdrive (an external service) does consume one.
			const rendered = renderer({ workload, env, binding, index: renderIndex, releaseDir });
			if (rendered.services.length > 0 || Object.keys(rendered.files).length > 0) renderIndex += 1;
			for (const [name, content] of Object.entries(rendered.files))
				mergeBindingFile(files, name, content, binding.name);
			// Renderers return whole service blocks; accept either with or without the list comma and
			// let the join own separators (`serviceBlocks.join(',\n')`).
			services.push(...rendered.services.map((block) => block.replace(/,\s*$/, '')));
			for (const line of rendered.mainBindings ?? []) mainBindings.push(`${line},`);
			for (const namespace of rendered.namespaces ?? [])
				mergeNamespace(namespaces, namespacesByClass, namespace, binding.name, binding.type);
			mainFields.push(...(rendered.mainFields ?? []));
			extensions.push(...(rendered.extensions ?? []));
			if (rendered.requiresDurableStorage) requiresDurableStorage = true;
			if (binding.type === 'hyperdrive') carriesCredentials = true;
			continue;
		}

		if (PHASE_ONE_BINDING_TYPES.has(binding.type)) {
			mainBindings.push(renderBinding(binding, byAddress));
			continue;
		}

		// Defence in depth: the control plane refuses unsupported bindings before a node sees them.
		throw new Error(
			`Binding "${binding.name}" uses type "${binding.type}", which has no node renderer in this Skiff build yet; ` +
				'this build renders Durable Objects, Hyperdrive, KV, Cache, R2, D1, queues, assets and Analytics Engine on the node.',
		);
	}

	return {
		mainBindings,
		namespaces,
		mainFields,
		services,
		extensions,
		files,
		requiresDurableStorage,
		carriesCredentials,
	};
}

/**
 * Merge the phase-3 tail Worker into the collected fragments.
 *
 * The tail Worker is part of the host, not a user binding: every function gets one so workerd can
 * deliver invocation outcomes and logs to the node's telemetry pipeline (docs/FUNCTIONS.md §4.5).
 * It is rendered last, which keeps binding service order (and therefore the config) stable. Service
 * names are de-duplicated in case a future binding backend also emits `tail-api` or `tail-sink`;
 * emitting either twice would make workerd refuse the whole config.
 */
function mergeTailWorker(workload: WorkloadDesired, fragments: CollectedFragments): void {
	const tail = renderTailWorker(workload);
	for (const [name, content] of Object.entries(tail.files))
		mergeBindingFile(fragments.files, name, content, 'the tail worker');

	const emitted = new Set(
		fragments.services
			.map(renderedServiceName)
			.filter((name): name is string => name !== null),
	);
	for (const block of tail.services) {
		const name = renderedServiceName(block);
		if (name !== null) {
			if (emitted.has(name)) continue;
			emitted.add(name);
		}
		fragments.services.push(block.replace(/,\s*$/, ''));
	}
	fragments.mainFields.push(...(tail.mainFields ?? []));
	if (tail.requiresDurableStorage) fragments.requiresDurableStorage = true;
	fragments.extensions.push(...(tail.extensions ?? []));
}

/** The `name` of a rendered top-level service block, for de-duplication. */
function renderedServiceName(block: string): string | null {
	const match = /^\s*\(\s*name\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block);
	return match ? match[1]! : null;
}

function externalServiceBlock(name: string, address: string): string {
	return `    ( name = ${capnpText(name)},\n      external = ( address = ${capnpText(address)}, http = () ) )`;
}

const BINDING_FILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_BINDING_FILES: ReadonlySet<string> = new Set(['function-config', 'function-shim']);

/** Worker modules are systemd credentials: names are unique and never shadow the fixed two. */
function mergeBindingFile(
	files: Record<string, string>,
	name: string,
	content: string,
	bindingName: string,
): void {
	if (!BINDING_FILE_NAME.test(name))
		throw new Error(
			`Binding "${bindingName}" wants to embed worker file "${name}", which must match ${BINDING_FILE_NAME}.`,
		);
	if (RESERVED_BINDING_FILES.has(name) || /^module-\d+$/.test(name))
		throw new Error(
			`Binding "${bindingName}" wants to embed worker file "${name}", which is reserved for the fixed helper credentials.`,
		);
	if (Object.hasOwn(files, name)) {
		// Two bindings of the same kind share one embedded service module; that is the same file,
		// not a conflict. Different content under one name would be ambiguous.
		if (files[name] === content) return;
		throw new Error(
			`Binding "${bindingName}" wants to embed worker file "${name}", which another binding already declared with different content.`,
		);
	}
	files[name] = content;
}

/** workerd allows one namespace per class name; reject a second, conflicting declaration. */
function mergeNamespace(
	namespaces: CollectedFragments['namespaces'],
	byClass: Map<string, CollectedFragments['namespaces'][number]>,
	namespace: CollectedFragments['namespaces'][number],
	bindingName: string,
	bindingType: string,
): void {
	const existing = byClass.get(namespace.className);
	if (!existing) {
		byClass.set(namespace.className, namespace);
		namespaces.push(namespace);
		return;
	}
	if (existing.uniqueKey !== namespace.uniqueKey || existing.enableSql !== namespace.enableSql)
		throw new Error(
			`Binding "${bindingName}" (${bindingType}) declares Durable Object class "${namespace.className}" with unique key ` +
				`"${namespace.uniqueKey}", but it is already declared with "${existing.uniqueKey}"; ` +
				'a Worker can only declare one namespace per class.',
		);
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * Cap'n Proto text-format escaping of a string, including the surrounding quotes.
 *
 * Cap'n Proto text strings are byte strings with C-style escapes, so this walks the **UTF-8 bytes**
 * of the value: ASCII printable bytes pass through, the escapes with a short form are used, and
 * every other byte (control, DEL, and all of UTF-8's high bytes) becomes `\xNN`. That keeps the
 * output one line per field — no raw newline can ever escape a literal — and `%d`, `$` and friends
 * stay inert.
 */
export function capnpText(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let out = '"';
	for (const byte of bytes) {
		switch (byte) {
			case 0x22:
				out += '\\"';
				break;
			case 0x5c:
				out += '\\\\';
				break;
			case 0x0a:
				out += '\\n';
				break;
			case 0x0d:
				out += '\\r';
				break;
			case 0x09:
				out += '\\t';
				break;
			default:
				if (byte < 0x20 || byte >= 0x7f) {
					out += `\\x${HEX_DIGITS.charAt(byte >> 4)}${HEX_DIGITS.charAt(byte & 0x0f)}`;
				} else {
					out += String.fromCharCode(byte);
				}
		}
	}
	return `${out}"`;
}

/**
 * Map the contract's upstream spelling to workerd's `ExternalServer.address`.
 *
 * The control plane stores what Caddy uses: `unix//run/skiff-workloads/<id>.sock` (Caddy's network
 * `unix` plus the absolute path) or `127.0.0.1:<port>` (optionally with an `http(s)://` scheme).
 * workerd wants `unix:/path` or `host:port`, so normalise the former and strip the scheme from the
 * latter. Anything that is neither a unix socket nor a loopback host:port is a capability we did
 * not validate, so refuse to render it rather than hand workerd a private address.
 */
function normalizeUpstream(upstream: string, bindingName: string): string {
	const fail = (why: string): Error =>
		new Error(`App binding "${bindingName}" has upstream "${upstream}": ${why}`);
	const value = upstream.trim();
	if (value.length === 0) throw fail('the upstream is empty.');

	// Caddy writes a unix address as `unix//run/x.sock` (network `unix`, address `/run/x.sock`);
	// `unix:/run/x.sock` and `unix://run/x.sock` mean the same thing. workerd wants `unix:/run/x.sock`.
	let unixPath: string | null = null;
	if (value.startsWith('unix:')) {
		const rest = value.slice('unix:'.length);
		if (!rest.startsWith('/')) throw fail('a unix socket address must be an absolute path.');
		unixPath = `/${rest.replace(/^\/+/, '')}`;
	} else if (value.startsWith('unix//')) {
		unixPath = `/${value.slice('unix//'.length).replace(/^\/+/, '')}`;
	}
	if (unixPath !== null) {
		if (unixPath === '/') throw fail('a unix socket address needs a path.');
		if (/[\u0000-\u0020\u007f]/.test(unixPath))
			throw fail('a unix socket path cannot contain whitespace or control characters.');
		if (unixPath.split('/').some((segment) => segment === '.' || segment === '..'))
			throw fail('a unix socket path cannot contain "." or ".." segments.');
		return `unix:${unixPath}`;
	}

	let hostPort = value.replace(/^https?:\/\//i, '');
	const slash = hostPort.indexOf('/');
	if (slash !== -1) hostPort = hostPort.slice(0, slash);
	const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(hostPort);
	if (!match) throw fail('it is neither a unix socket nor a loopback host:port.');
	const host = match[1]!;
	const port = Number(match[2]!);
	if (!LOOPBACK_HOSTS.test(host))
		throw fail('only loopback targets (127.0.0.0/8, localhost, ::1) may be bound as an external service.');
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw fail('the port is out of range.');
	return `${host.toLowerCase()}:${port}`;
}

const LOOPBACK_HOSTS = /^(?:localhost|\[::1\]|::1|127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})$/i;

/** One `Worker.bindings` entry. Phase-1 types only; anything else is a control-plane bug. */
function renderBinding(binding: FunctionRuntimeBinding, byAddress: Map<string, string>): string {
	const name = capnpText(binding.name);
	switch (binding.type) {
		case 'text':
			return `          ( name = ${name}, text = ${capnpText(binding.value)} ),`;
		case 'json': {
			// workerd's `json` binding is Text holding JSON: it parses the string into the value.
			const json: string | undefined = JSON.stringify(binding.value);
			if (json === undefined) throw new Error(`Binding "${binding.name}" is not JSON-serialisable.`);
			return `          ( name = ${name}, json = ${capnpText(json)} ),`;
		}
		case 'secret':
			// The activation env file keys the value by the secret's own name (D18/D88 scoping).
			return `          ( name = ${name}, fromEnvironment = ${capnpText(binding.secret ?? binding.name)} ),`;
		case 'service':
			// Phase 1: named entrypoints live in this same worker, so the designator names "main".
			return binding.entrypoint
				? `          ( name = ${name}, service = ( name = "main", entrypoint = ${capnpText(binding.entrypoint)} ) ),`
				: `          ( name = ${name}, service = "main" ),`;
		case 'app': {
			const address = normalizeUpstream(binding.upstream, binding.name);
			const service = byAddress.get(address);
			if (!service) throw new Error(`Binding "${binding.name}" has an upstream with no rendered service.`);
			// Other projects are reached as an external service over their socket or loopback port,
			// never through global outbound: fetch only (JS RPC across processes is phase 4).
			return `          ( name = ${name}, service = ${capnpText(service)} ),`;
		}
		default: {
			const unsupported = binding as { type: string; name?: string };
			const phases: Record<string, number | undefined> = FUNCTION_BINDING_PHASE;
			const phase = phases[unsupported.type];
			const when = phase === undefined ? 'not supported by Skiff functions' : `served from phase ${phase}`;
			throw new Error(
				`Binding "${unsupported.name ?? 'unnamed'}" uses type "${unsupported.type}", which is ${when}; ` +
					'phase 1 functions support text, json, secret, service and app bindings.',
			);
		}
	}
}

function moduleKind(module: FunctionModule): string {
	const kinds: Record<string, string | undefined> = MODULE_KINDS;
	const kind = kinds[module.type];
	if (!kind) throw new Error(`Module "${module.name}" has unsupported type "${String(module.type)}".`);
	return kind;
}

/**
 * FN5: `--max-old-space-size` is in MiB and bounds V8's old space, not the process. Give the heap
 * 75% of `MemoryMax` and leave the rest for workerd, module memory and request buffers. 32 MiB is
 * the smallest heap worth setting, so a 32 MB workload (24 after the fraction) still gets 32.
 */
function heapMegabytes(memoryMb: number): number {
	return Math.max(32, Math.floor(memoryMb * 0.75));
}

/**
 * Workload ids and paths are trusted, but the header is a comment: a newline in one must never
 * turn the rest of the file into config.
 */
function commentText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}
