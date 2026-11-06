import * as z from 'zod';

/**
 * Functions: the fourth runtime tier (docs/FUNCTIONS.md, D110).
 *
 * A function is a Workers-compatible workload served by a pinned workerd process. This module is
 * the shared vocabulary for all of it: the `skiff-function.json` manifest a client uploads, the
 * *resolved* runtime spec the control plane stores in the workload (what a node actually renders)
 * and the view the API, MCP and dashboard read.
 *
 * Nothing here carries a secret value. A `secret` binding names an entry in the project's secret
 * store; the value reaches the node only through the activation endpoint (D18).
 */

/** Manifest file a function bundle must contain at its root (FN8). */
export const FUNCTION_MANIFEST_FILE = 'skiff-function.json';
/** Where the shim answers a health probe. Public, cheap and reveals nothing. */
export const FUNCTION_HEALTH_PATH = '/__skiff/health';
/**
 * Header the shim requires for its internal routes (`scheduled`, `queue`). Caddy always overwrites
 * it with "0" on the public proxy route, so a client can never reach them (FN9).
 */
export const FUNCTION_INTERNAL_HEADER = 'x-skiff-internal';
export const FUNCTION_INTERNAL_VALUE = '1';
export const FUNCTION_INTERNAL_PREFIX = '/__skiff/';
/**
 * Loopback port the node agent serves the Analytics Engine sink on (phase 2). A binding service
 * Worker forwards events here; the agent batches them into the telemetry channel.
 */
export const FUNCTION_ANALYTICS_PORT = 8085;

/**
 * The workerd release Skiff ships (FN1). The version doubles as the maximum compatibility date:
 * workerd refuses a date newer than the build. Bumped deliberately with a Skiff minor.
 */
export const WORKERD_PINNED_VERSION = '1.20261106.1';
export const WORKERD_MAX_COMPATIBILITY_DATE = '2026-11-06';
/**
 * Compatibility date for a manifest-less first deploy of an already-built Worker (the CLI
 * generates a date from wrangler; this is only the fallback). Pinned deliberately rather than
 * "latest" so a workerd bump cannot silently change behaviour behind a bare bundle.
 */
export const FUNCTION_DEFAULT_COMPATIBILITY_DATE = '2026-10-01';
/** Cloudflare's per-isolate memory figure, and the doc's default (FN5). */
export const FUNCTION_DEFAULT_MEMORY_MB = 128;
/** Scale to zero after five idle minutes; 0 means always on (FN4). */
export const FUNCTION_DEFAULT_IDLE_STOP_SECONDS = 300;
export const FUNCTION_MAX_MODULES = 512;
export const FUNCTION_MAX_BINDINGS = 64;
export const FUNCTION_MAX_COMPATIBILITY_FLAGS = 32;
export const FUNCTION_MAX_CRONS = 8;

const moduleNamePattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const bindingNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const compatibilityDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const compatibilityFlagPattern = /^[a-z0-9][a-z0-9_-]*$/;
export const workerdVersionPattern = /^\d+\.\d+\.\d+$/;

/** Module kinds workerd's `Worker.modules` union can load (docs/FUNCTIONS.md §4.3). */
export const functionModuleTypes = ['esm', 'cjs', 'text', 'data', 'wasm'] as const;
export type FunctionModuleType = (typeof functionModuleTypes)[number];

/**
 * A module in the bundle. `name` is the path inside the release and the specifier another module
 * imports; `sha256` is the digest of the uploaded bytes, which the control plane verifies.
 */
export const functionModuleSchema = z.object({
	name: z.string().min(1).max(512),
	type: z.enum(functionModuleTypes),
	sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Module digests are lowercase SHA-256 hex.'),
});
export type FunctionModule = z.infer<typeof functionModuleSchema>;

const bindingName = z
	.string()
	.min(1)
	.max(64)
	.regex(bindingNamePattern, 'Binding names are JavaScript identifiers.');

/**
 * Binding kinds in a manifest, and the runtime spec alike. `text`, `json`, `secret`, `service`
 * and `app` are phase 1; the rest are modelled now so a deploy fails with "not supported yet"
 * rather than a schema error, and so phases 2–3 add a backend without redefining the format.
 */
export const functionBindingTypes = [
	'text',
	'json',
	'secret',
	'service',
	'app',
	'r2',
	'kv',
	'd1',
	'durable_object',
	'hyperdrive',
	'analytics_engine',
	'queue',
	'cache',
	'assets',
] as const;
export type FunctionBindingType = (typeof functionBindingTypes)[number];

/**
 * Bindings whose data lives on one host, so a function that declares any of them runs exactly one
 * workerd process (FN11). Everything else — text/json/secret/service/app/hyperdrive/r2/
 * analytics_engine/assets — is stateless and may run `replicas > 1` (phase 4).
 */
export const FUNCTION_STATEFUL_BINDING_TYPES = [
	'durable_object',
	'kv',
	'cache',
	'queue',
	'd1',
] as const;
export type FunctionStatefulBindingType = (typeof FUNCTION_STATEFUL_BINDING_TYPES)[number];

const STATEFUL_BINDINGS: ReadonlySet<string> = new Set(FUNCTION_STATEFUL_BINDING_TYPES);

/** True when a binding type pins a function to one host until workerd cluster mode lands (FN11). */
export function functionBindingIsStateful(type: FunctionBindingType): boolean {
	return STATEFUL_BINDINGS.has(type);
}

/**
 * The one refusal both the workload contract and the deploy path use when a stateful function
 * asks for replicas. Kept here so docs, control plane and tests quote the same sentence.
 */
export const FUNCTION_STATEFUL_REPLICA_MESSAGE =
	'Functions with stateful bindings (durable_object, kv, cache, queue, d1) run one host until workerd cluster mode lands (phase 4).';

/** The phase that first serves each binding (docs/FUNCTIONS.md §4.5). */
export const FUNCTION_BINDING_PHASE: Readonly<Record<FunctionBindingType, number>> = Object.freeze({
	text: 1,
	json: 1,
	secret: 1,
	service: 1,
	app: 1,
	r2: 2,
	kv: 2,
	d1: 2,
	durable_object: 2,
	hyperdrive: 2,
	analytics_engine: 2,
	cache: 2,
	queue: 3,
	assets: 2,
});

/**
 * Which bindings this Skiff build can actually serve. A type may have a phase (the design's
 * roadmap) while remaining unimplemented here; the deploy validator refuses those with a clear
 * message instead of handing the node a binding it cannot back.
 */
export const FUNCTION_BINDING_IMPLEMENTED: Readonly<Record<FunctionBindingType, boolean>> = Object.freeze({
	text: true,
	json: true,
	secret: true,
	service: true,
	app: true,
	durable_object: true,
	hyperdrive: true,
	kv: true,
	// Cache is served by a binding service on the node; enabled with KV in phase 2.
	cache: true,
	// Deferred: no workerd build config can back these yet (D1 needs an upstream wrapped binding;
	// Analytics and queues need their node-side services and ClickHouse ingestion).
	r2: true,
	d1: true,
	analytics_engine: true,
	queue: true,
	assets: true,
});

const textBindingSchema = z.object({
	type: z.literal('text'),
	value: z.string().max(16_384),
});
const jsonBindingSchema = z.object({
	type: z.literal('json'),
	value: z.json(),
});
/** The binding name is the environment variable; `secret` defaults to it (D88 scoping). */
const secretBindingSchema = z.object({
	type: z.literal('secret'),
	secret: bindingName.optional(),
});
/** A named entrypoint exported by the same bundle (phase 1, in-process JS RPC). */
const serviceBindingSchema = z.object({
	type: z.literal('service'),
	entrypoint: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'Entrypoints are JavaScript identifiers.')
		.optional(),
});
/** Another project on the same node, reached over its socket (phase 1, fetch only). */
const appBindingSchema = z.object({
	type: z.literal('app'),
	project: z
		.string()
		.min(3)
		.max(40)
		.regex(/^[a-z0-9][a-z0-9-]*$/, 'Project slugs are lowercase letters, digits and hyphens.'),
	entrypoint: z.string().min(1).max(128).optional(),
});
const r2BindingSchema = z.object({
	type: z.literal('r2'),
	storage: z.string().min(1).max(100),
	bucket: z.string().min(1).max(255),
	prefix: z.string().max(512).optional(),
});
const kvBindingSchema = z.object({
	type: z.literal('kv'),
	namespace: z.string().min(1).max(100).optional(),
});
const d1BindingSchema = z.object({
	type: z.literal('d1'),
	database: z.string().min(1).max(100),
});
const durableObjectBindingSchema = z.object({
	type: z.literal('durable_object'),
	className: z.string().min(1).max(128),
});
const hyperdriveBindingSchema = z.object({
	type: z.literal('hyperdrive'),
	database: z.string().min(1).max(100),
});
const analyticsEngineBindingSchema = z.object({
	type: z.literal('analytics_engine'),
	dataset: z.string().min(1).max(100).optional(),
});
const queueBindingSchema = z.object({
	type: z.literal('queue'),
	queue: z.string().min(1).max(100),
	producer: z.boolean().default(true),
});
const cacheBindingSchema = z.object({ type: z.literal('cache') });
const assetsBindingSchema = z.object({ type: z.literal('assets') });

/**
 * One manifest binding: a capability the deploy asks the control plane to resolve.
 */
export const functionBindingSchema = z.discriminatedUnion('type', [
	textBindingSchema.extend({ name: bindingName }),
	jsonBindingSchema.extend({ name: bindingName }),
	secretBindingSchema.extend({ name: bindingName }),
	serviceBindingSchema.extend({ name: bindingName }),
	appBindingSchema.extend({ name: bindingName }),
	r2BindingSchema.extend({ name: bindingName }),
	kvBindingSchema.extend({ name: bindingName }),
	d1BindingSchema.extend({ name: bindingName }),
	durableObjectBindingSchema.extend({ name: bindingName }),
	hyperdriveBindingSchema.extend({ name: bindingName }),
	analyticsEngineBindingSchema.extend({ name: bindingName }),
	queueBindingSchema.extend({ name: bindingName }),
	cacheBindingSchema.extend({ name: bindingName }),
	assetsBindingSchema.extend({ name: bindingName }),
]);
export type FunctionBinding = z.infer<typeof functionBindingSchema>;

/**
 * A resolved binding stored in the workload spec. `app` carries the upstream the agent renders as
 * an `external` service, so a node never looks another project's placement up at start time.
 */
export const functionRuntimeBindingSchema = z.discriminatedUnion('type', [
	textBindingSchema.extend({ name: bindingName }),
	jsonBindingSchema.extend({ name: bindingName }),
	secretBindingSchema.extend({ name: bindingName }),
	serviceBindingSchema.extend({ name: bindingName }),
	appBindingSchema.extend({
		name: bindingName,
		/**
		 * Resolved target of a Skiff workload. Restricted to the shapes `upstreamFor` produces, so a
		 * hand-written spec cannot point a function at the agent socket or another local service.
		 */
		upstream: z
			.string()
			.min(1)
			.max(256)
			.regex(
				/^(?:unix\/\/run\/skiff-workloads\/[A-Za-z0-9_-]+\.sock|127\.0\.0\.1:[0-9]{1,5})$/,
				'App binding upstreams are Skiff workload sockets or loopback ports.',
			),
	}),
	durableObjectBindingSchema.extend({
		name: bindingName,
		/** Stable workerd namespace key: project + binding name, never the (renameable) slug. */
		uniqueKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
	}),
	hyperdriveBindingSchema.extend({
		name: bindingName,
		/** Prefix of the attached database's activation env (`<prefix>_POOL_HOST`, `_USER`, …). */
		envPrefix: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
	}),
	kvBindingSchema.extend({
		name: bindingName,
		/** Stable namespace id, one per binding, used to keep keys of different bindings apart. */
		namespaceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
	}),
	cacheBindingSchema.extend({ name: bindingName }),
	r2BindingSchema.extend({
		name: bindingName,
		/** Prefix of the attached storage instance's activation env (`S3_ENDPOINT_URL`, keys, …). */
		envPrefix: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
	}),
	d1BindingSchema.extend({
		name: bindingName,
		/** Stable node-local D1 database id, derived from the project and binding. */
		namespaceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
	}),
	queueBindingSchema.extend({
		name: bindingName,
		/** Stable queue id, derived from the project and binding. */
		namespaceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
	}),
	analyticsEngineBindingSchema.extend({
		name: bindingName,
		dataset: z.string().min(1).max(100),
	}),
	assetsBindingSchema.extend({ name: bindingName }),
]);
export type FunctionRuntimeBinding = z.infer<typeof functionRuntimeBindingSchema>;

/**
 * `run_worker_first` globs from wrangler's `assets`. A leading `!` excludes. Compiled to Caddy
 * matchers by the agent; validated here so a bundle cannot inject a regex.
 */
export const functionAssetGlobSchema = z
	.string()
	.min(2)
	.max(256)
	.regex(/^!?\/?[A-Za-z0-9._*?/[\]-]+$/, 'Asset globs use letters, digits, `*`, `?`, `/`, `.` and `-`.');

export const functionAssetsSchema = z.object({
	/** Directory inside the release that holds the static files, e.g. `public`. */
	directory: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'Asset directories are relative paths.')
		.refine((value) => !value.includes('..'), 'Asset directories cannot contain "..".'),
	runWorkerFirst: z.array(functionAssetGlobSchema).max(64).default([]),
});
export type FunctionAssets = z.infer<typeof functionAssetsSchema>;

export const functionTriggersSchema = z.object({
	/** Five-field UTC cron expressions; validated by the shared parser in core. */
	crons: z.array(z.string().min(1).max(120)).max(FUNCTION_MAX_CRONS).default([]),
});
export type FunctionTriggers = z.infer<typeof functionTriggersSchema>;

/**
 * `skiff-function.json`: what the user's bundler writes next to the modules (FN8). The control
 * plane validates it and never bundles (D2).
 */
export const functionManifestSchema = z
	.object({
		version: z.literal(1).default(1),
		/** Module name of the entrypoint; must be an `esm` or `cjs` module in `modules`. */
		main: z.string().min(1).max(512),
		modules: z.array(functionModuleSchema).min(1).max(FUNCTION_MAX_MODULES),
		compatibilityDate: z
			.string()
			.regex(compatibilityDatePattern, 'Compatibility dates are `YYYY-MM-DD`.'),
		compatibilityFlags: z
			.array(z.string().min(1).max(64).regex(compatibilityFlagPattern))
			.max(FUNCTION_MAX_COMPATIBILITY_FLAGS)
			.default([]),
		bindings: z.array(functionBindingSchema).max(FUNCTION_MAX_BINDINGS).default([]),
		triggers: functionTriggersSchema.default({ crons: [] }),
		assets: functionAssetsSchema.optional(),
		/** Overrides the default 300 s idle stop; 0 keeps the host always on. */
		idleStopSeconds: z.number().int().min(0).max(86_400).optional(),
		/** Overrides the default 128 MB admission for this project. */
		memoryMb: z.number().int().min(32).max(2048).optional(),
		cpus: z.number().positive().max(4).optional(),
	})
	.superRefine((manifest, ctx) => {
		const names = new Set<string>();
		for (const [index, module] of manifest.modules.entries()) {
			const problem = functionModuleNameProblem(module.name);
			if (problem) ctx.addIssue({ code: 'custom', path: ['modules', index, 'name'], message: problem });
			if (names.has(module.name))
				ctx.addIssue({ code: 'custom', path: ['modules', index, 'name'], message: `Module ${module.name} is listed twice.` });
			names.add(module.name);
		}
		const mainProblem = functionModuleNameProblem(manifest.main);
		if (mainProblem) ctx.addIssue({ code: 'custom', path: ['main'], message: mainProblem });
		if (!names.has(manifest.main))
			ctx.addIssue({ code: 'custom', path: ['main'], message: '`main` must name one of the modules.' });
		const main = manifest.modules.find((module) => module.name === manifest.main);
		if (main && main.type !== 'esm' && main.type !== 'cjs')
			ctx.addIssue({ code: 'custom', path: ['main'], message: '`main` must be an esm or cjs module.' });
		const bindingNames = new Set<string>();
		for (const [index, binding] of manifest.bindings.entries()) {
			if (bindingNames.has(binding.name))
				ctx.addIssue({ code: 'custom', path: ['bindings', index, 'name'], message: `Binding ${binding.name} is declared twice.` });
			bindingNames.add(binding.name);
		}
		const dateProblem = compatibilityDateProblem(manifest.compatibilityDate);
		if (dateProblem) ctx.addIssue({ code: 'custom', path: ['compatibilityDate'], message: dateProblem });
	});
export type FunctionManifest = z.infer<typeof functionManifestSchema>;
export type FunctionManifestInput = z.input<typeof functionManifestSchema>;

/**
 * The resolved function spec stored in `WorkloadSpec.function` and `WorkloadDesired.function`,
 * snapshotted per deployment so a rollback restores code *and* bindings (D17).
 */
export const functionRuntimeSpecSchema = z
	.object({
		main: z.string().min(1).max(512),
		modules: z.array(functionModuleSchema).min(1).max(FUNCTION_MAX_MODULES),
		compatibilityDate: z.string().regex(compatibilityDatePattern),
		compatibilityFlags: z.array(z.string().min(1).max(64)).max(FUNCTION_MAX_COMPATIBILITY_FLAGS).default([]),
		bindings: z.array(functionRuntimeBindingSchema).max(FUNCTION_MAX_BINDINGS).default([]),
		triggers: functionTriggersSchema.default({ crons: [] }),
		assets: functionAssetsSchema.nullable().default(null),
		idleStopSeconds: z.number().int().min(0).max(86_400).default(FUNCTION_DEFAULT_IDLE_STOP_SECONDS),
		/** The pinned workerd build the node must run (FN1). */
		workerdVersion: z.string().regex(workerdVersionPattern),
	})
	.superRefine((spec, ctx) => {
		const names = new Set<string>();
		for (const [index, module] of spec.modules.entries()) {
			const problem = functionModuleNameProblem(module.name);
			if (problem) ctx.addIssue({ code: 'custom', path: ['modules', index, 'name'], message: problem });
			if (names.has(module.name))
				ctx.addIssue({ code: 'custom', path: ['modules', index, 'name'], message: `Module ${module.name} is listed twice.` });
			names.add(module.name);
		}
		if (!names.has(spec.main))
			ctx.addIssue({ code: 'custom', path: ['main'], message: '`main` must name one of the modules.' });
		const bindingNames = new Set<string>();
		for (const [index, binding] of spec.bindings.entries()) {
			if (bindingNames.has(binding.name))
				ctx.addIssue({ code: 'custom', path: ['bindings', index, 'name'], message: `Binding ${binding.name} is declared twice.` });
			bindingNames.add(binding.name);
		}
	});
export type FunctionRuntimeSpec = z.infer<typeof functionRuntimeSpecSchema>;

/** A module name that is safe to join under a release root and to embed in a workerd config. */
export function functionModuleNameProblem(name: string): string | null {
	if (name.length === 0 || name.length > 512) return 'Module names are 1–512 characters.';
	if (name.startsWith('/')) return 'Module names are relative to the bundle root.';
	if (name.includes('\\')) return 'Module names use forward slashes.';
	if (!moduleNamePattern.test(name)) return `Module name "${name}" contains unsupported characters.`;
	if (name.includes('..')) return 'Module names cannot contain "..".';
	if (name.split('/').some((segment) => segment === '.')) return 'Module names cannot contain "." segments.';
	return null;
}

/** A binding name usable as an environment variable and a JavaScript identifier. */
export function functionBindingNameProblem(name: string): string | null {
	if (!bindingNamePattern.test(name) || name.length > 64)
		return 'Binding names must be JavaScript identifiers of at most 64 characters.';
	return null;
}

/**
 * A compatibility date must be a real calendar date, no earlier than workerd's first public
 * release line, and no later than the pinned build. Returns a message or null.
 */
export function compatibilityDateProblem(
	date: string,
	max: string = WORKERD_MAX_COMPATIBILITY_DATE,
): string | null {
	if (!compatibilityDatePattern.test(date)) return 'Compatibility dates are `YYYY-MM-DD`.';
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
		return `"${date}" is not a calendar date.`;
	if (date < '2022-01-01') return 'Compatibility dates before 2022-01-01 are not supported.';
	if (date > max)
		return `Compatibility date ${date} is newer than the pinned workerd build (${max}). Pick ${max} or earlier.`;
	return null;
}

/** Human-readable binding description for the API, dashboard and MCP (never a secret value). */
export function functionBindingSummary(binding: FunctionRuntimeBinding): string {
	switch (binding.type) {
		case 'text':
			return 'text';
		case 'json':
			return 'json';
		case 'secret':
			return `secret ${binding.secret ?? binding.name}`;
		case 'service':
			return binding.entrypoint ? `service ${binding.entrypoint}` : 'service (default entrypoint)';
		case 'app':
			return `app ${binding.project}${binding.entrypoint ? `#${binding.entrypoint}` : ''}`;
		case 'durable_object':
			return `Durable Object ${binding.className}`;
		case 'hyperdrive':
			return `Hyperdrive database ${binding.database}`;
		case 'kv':
			return `KV namespace ${binding.namespaceId}`;
		case 'cache':
			return 'cache';
		case 'r2':
			return `R2 ${binding.storage}/${binding.bucket}`;
		case 'd1':
			return `D1 database ${binding.database}`;
		case 'queue':
			return `queue ${binding.queue}`;
		case 'analytics_engine':
			return `Analytics Engine ${binding.dataset}`;
		case 'assets':
			return 'assets (the project\'s static files)';
	}
}

/** What the API, MCP and dashboard show for a function project. No secret values. */
export const functionViewSchema = z.object({
	projectId: z.string(),
	projectSlug: z.string(),
	runtime: z.literal('function'),
	deploymentId: z.string().nullable(),
	main: z.string(),
	moduleCount: z.number().int().nonnegative(),
	compatibilityDate: z.string(),
	compatibilityFlags: z.array(z.string()),
	bindings: z.array(
		z.object({
			name: z.string(),
			type: z.enum(functionBindingTypes),
			summary: z.string(),
		}),
	),
	triggers: z.object({ crons: z.array(z.string()) }),
	assets: functionAssetsSchema.nullable(),
	idleStopSeconds: z.number().int().nonnegative(),
	workerdVersion: z.string(),
});
export type FunctionView = z.infer<typeof functionViewSchema>;

/** One function module as the dashboard lists it. */
export const functionModuleViewSchema = z.object({
	name: z.string(),
	type: z.enum(functionModuleTypes),
	sha256: z.string(),
});
export type FunctionModuleView = z.infer<typeof functionModuleViewSchema>;
