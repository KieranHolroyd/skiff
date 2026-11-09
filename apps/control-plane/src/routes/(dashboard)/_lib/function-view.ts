import {
	FUNCTION_BINDING_IMPLEMENTED,
	FUNCTION_BINDING_PHASE,
	FUNCTION_DEFAULT_IDLE_STOP_SECONDS,
	FUNCTION_STATEFUL_BINDING_TYPES,
	WORKERD_MAX_COMPATIBILITY_DATE,
	WORKERD_PINNED_VERSION,
	functionBindingIsStateful,
	type FunctionBindingType,
	type FunctionView
} from '@skiff/contracts';

/**
 * Pure helpers behind the Functions console (docs/FUNCTIONS.md §4.11). Kept out of the components
 * so the copy and the support matrix are testable without rendering. Which bindings this build
 * serves comes from the contract (`FUNCTION_BINDING_IMPLEMENTED`), never from a UI constant.
 */

export type BindingGroup = 'config' | 'services' | 'data' | 'messaging';

interface BindingInfo {
	label: string;
	group: BindingGroup;
	/** What Skiff backs this binding with (§4.5). */
	backing: string;
	/** Where it goes in wrangler.jsonc; `skif deploy` maps it by binding name. */
	wrangler: string;
	/** What has to exist on Skiff first, when anything does. */
	needs?: string;
}

export const BINDING_INFO: Readonly<Record<FunctionBindingType, BindingInfo>> = {
	text: {
		label: 'Text variable',
		group: 'config',
		backing: 'Inline in the config',
		wrangler: 'vars'
	},
	json: {
		label: 'JSON variable',
		group: 'config',
		backing: 'Inline in the config',
		wrangler: 'vars'
	},
	secret: {
		label: 'Secret',
		group: 'config',
		backing: 'Secret store, delivered at activation',
		wrangler: 'Project secrets, bound automatically',
		needs: 'A secret stored for the function'
	},
	service: {
		label: 'Service',
		group: 'services',
		backing: 'Named entrypoint in the same host',
		wrangler: 'services (this Worker + entrypoint)'
	},
	app: {
		label: 'Skiff app',
		group: 'services',
		backing: "Another app's workload socket, fetch only",
		wrangler: 'services (another project)',
		needs: 'The target app deployed on the same node'
	},
	r2: {
		label: 'R2 bucket',
		group: 'data',
		backing: 'Managed RustFS, signed S3 requests',
		wrangler: 'r2_buckets + skiff.storage',
		needs: 'Storage attached to the function with a grant for the bucket'
	},
	kv: {
		label: 'KV namespace',
		group: 'data',
		backing: 'Durable Object storage on the host',
		wrangler: 'kv_namespaces'
	},
	d1: {
		label: 'D1 database',
		group: 'data',
		backing: 'SQLite in Durable Object storage',
		wrangler: 'd1_databases'
	},
	durable_object: {
		label: 'Durable Object',
		group: 'data',
		backing: "SQLite on the host's storage disk",
		wrangler: 'durable_objects.bindings'
	},
	hyperdrive: {
		label: 'Hyperdrive',
		group: 'data',
		backing: 'Managed Postgres through its pooler',
		wrangler: 'hyperdrive + skiff.hyperdrive',
		needs: 'A Postgres database attached to the function'
	},
	cache: {
		label: 'Cache API',
		group: 'data',
		backing: 'Per-host cache with a size cap',
		wrangler: 'Built in (caches.default)'
	},
	assets: {
		label: 'Static assets',
		group: 'data',
		backing: "Caddy first, then the release's assets directory",
		wrangler: 'assets'
	},
	analytics_engine: {
		label: 'Analytics Engine',
		group: 'messaging',
		backing: 'ClickHouse, queryable in Dashboards',
		wrangler: 'analytics_engine_datasets'
	},
	queue: {
		label: 'Queue',
		group: 'messaging',
		backing: 'Durable Object broker on the host',
		wrangler: 'queues.producers'
	},
	auth: {
		label: 'User pool auth',
		group: 'services',
		backing: "The attached pool's JWKS, verified in a sibling Worker",
		wrangler: 'skiff.auth (added by a pool attachment)',
		needs: 'A user pool attached to the function'
	}
};

export const BINDING_GROUP_LABELS: Readonly<Record<BindingGroup, string>> = {
	config: 'Variables and secrets',
	services: 'Services',
	data: 'Data',
	messaging: 'Events and queues'
};

export function bindingInfo(type: string): BindingInfo {
	return (
		BINDING_INFO[type as FunctionBindingType] ?? {
			label: type,
			group: 'data',
			backing: 'Unknown binding type',
			wrangler: type
		}
	);
}

export function bindingPhase(type: string): number {
	return FUNCTION_BINDING_PHASE[type as FunctionBindingType] ?? Number.POSITIVE_INFINITY;
}

/** True when this Skiff build can serve the binding type (the contract decides). */
export function bindingAvailable(
	type: string,
	implemented: Readonly<Record<string, boolean>> = FUNCTION_BINDING_IMPLEMENTED
): boolean {
	return implemented[type] === true;
}

/** True when the type keeps data on one host, which caps the function at one replica (FN11). */
export function bindingStateful(type: string): boolean {
	return (FUNCTION_STATEFUL_BINDING_TYPES as readonly string[]).includes(type);
}

export interface MatrixRow {
	type: FunctionBindingType;
	label: string;
	backing: string;
	wrangler: string;
	needs: string | null;
	available: boolean;
	stateful: boolean;
	/** How many of this function's bindings use the type. */
	used: number;
}

const GROUP_ORDER: BindingGroup[] = ['config', 'services', 'data', 'messaging'];

/** Every binding type grouped as the console shows them, with this function's usage. */
export function bindingMatrix(
	view: Pick<FunctionView, 'bindings'> | null,
	implemented: Readonly<Record<string, boolean>> = FUNCTION_BINDING_IMPLEMENTED
): MatrixRow[] {
	const used = new Map<string, number>();
	for (const binding of view?.bindings ?? [])
		used.set(binding.type, (used.get(binding.type) ?? 0) + 1);
	return (Object.keys(BINDING_INFO) as FunctionBindingType[])
		.map((type) => ({
			type,
			label: BINDING_INFO[type].label,
			backing: BINDING_INFO[type].backing,
			wrangler: BINDING_INFO[type].wrangler,
			needs: BINDING_INFO[type].needs ?? null,
			// A function already using a type proves the server serves it.
			available: bindingAvailable(type, implemented) || (used.get(type) ?? 0) > 0,
			stateful: functionBindingIsStateful(type),
			used: used.get(type) ?? 0
		}))
		.sort(
			(a, b) =>
				GROUP_ORDER.indexOf(BINDING_INFO[a.type].group) -
					GROUP_ORDER.indexOf(BINDING_INFO[b.type].group) || a.label.localeCompare(b.label)
		);
}

/** The bindings that pin this function to one host, by name. Empty means it may scale out. */
export function statefulBindings(
	view: Pick<FunctionView, 'bindings'> | null
): Array<{ name: string; type: string }> {
	return (view?.bindings ?? []).filter((binding) => bindingStateful(binding.type));
}

export interface FunctionStatus {
	status: string;
	label: string;
	tone?: 'success' | 'warning' | 'danger' | 'info' | 'brand' | 'neutral';
	/** One line of explanation for a tooltip or caption. */
	hint: string;
}

/**
 * The host state in the console's words. A function that stopped because it was idle reports
 * `stopped`, but its socket is still listening, so it is "Idle", not down (FN4).
 */
export function functionStatus(
	workload: { status: string } | null,
	view: Pick<FunctionView, 'idleStopSeconds'> | null
): FunctionStatus {
	if (!workload)
		return { status: 'inactive', label: 'Not deployed', hint: 'Nothing has been deployed yet.' };
	if (workload.status === 'stopped' && (view?.idleStopSeconds ?? 0) > 0)
		return {
			status: 'idle',
			label: 'Idle',
			tone: 'neutral',
			hint: 'Scaled to zero. The next request starts the host through socket activation.'
		};
	switch (workload.status) {
		case 'running':
			return { status: 'running', label: 'Running', hint: 'The host is serving requests.' };
		case 'starting':
			return { status: 'starting', label: 'Starting', hint: 'The host is starting on its node.' };
		case 'pending':
			return { status: 'pending', label: 'Pending', hint: 'Waiting for the node to apply it.' };
		case 'failed':
			return {
				status: 'failed',
				label: 'Failed',
				hint: 'The host failed to start or was restarted by the watchdog.'
			};
		default:
			return { status: workload.status, label: workload.status, hint: '' };
	}
}

/** Bindings grouped for display, keeping manifest order inside each group. */
export function groupBindings<T extends { type: string }>(
	bindings: readonly T[]
): Array<{ group: BindingGroup; label: string; items: T[] }> {
	const order: BindingGroup[] = ['config', 'services', 'data', 'messaging'];
	return order
		.map((group) => ({
			group,
			label: BINDING_GROUP_LABELS[group],
			items: bindings.filter((binding) => bindingInfo(binding.type).group === group)
		}))
		.filter((entry) => entry.items.length > 0);
}

/** "Always on", "After 5 min idle", "After 90 s idle". */
export function formatIdleStop(seconds: number): string {
	if (seconds <= 0) return 'Always on';
	if (seconds < 60) return `After ${seconds} s idle`;
	if (seconds % 3600 === 0) return `After ${seconds / 3600} h idle`;
	if (seconds % 60 === 0) return `After ${seconds / 60} min idle`;
	return `After ${Math.floor(seconds / 60)} min ${seconds % 60} s idle`;
}

export function isDefaultIdleStop(seconds: number): boolean {
	return seconds === FUNCTION_DEFAULT_IDLE_STOP_SECONDS;
}

/**
 * Whole days between a compatibility date and the pinned workerd's maximum. Zero or less means
 * the function is on the newest behaviour this platform runs.
 */
export function compatibilityLagDays(date: string, max = WORKERD_MAX_COMPATIBILITY_DATE): number {
	const from = Date.parse(`${date}T00:00:00Z`);
	const to = Date.parse(`${max}T00:00:00Z`);
	if (Number.isNaN(from) || Number.isNaN(to)) return 0;
	return Math.round((to - from) / 86_400_000);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: string): string {
	return value.padStart(2, '0');
}

/**
 * A plain-English reading of the common five-field shapes. Anything else returns null and the
 * panel shows the expression on its own; it is always UTC (FN9).
 */
export function describeCron(expression: string): string | null {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
	const isNum = (value: string) => /^\d+$/.test(value);
	const everyStep = (value: string) => /^\*\/(\d+)$/.exec(value)?.[1];

	if (day !== '*' || month !== '*') return null;
	if (minute === '*' && hour === '*' && weekday === '*') return 'Every minute';
	const minuteStep = everyStep(minute);
	if (minuteStep && hour === '*' && weekday === '*')
		return minuteStep === '1' ? 'Every minute' : `Every ${minuteStep} minutes`;
	if (isNum(minute) && hour === '*' && weekday === '*')
		return minute === '0' ? 'Every hour, on the hour' : `Every hour at :${pad(minute)}`;
	const hourStep = everyStep(hour);
	if (isNum(minute) && hourStep && weekday === '*')
		return `Every ${hourStep} hours at :${pad(minute)}`;
	if (isNum(minute) && isNum(hour)) {
		const time = `${pad(hour)}:${pad(minute)} UTC`;
		if (weekday === '*') return `Daily at ${time}`;
		if (weekday === '1-5') return `Weekdays at ${time}`;
		if (isNum(weekday) && Number(weekday) <= 7)
			return `${WEEKDAYS[Number(weekday) % 7]}s at ${time}`;
	}
	return null;
}

/**
 * A starting `wrangler.jsonc`: plain Workers config plus the `skiff` section Wrangler ignores
 * (FN8). `skif deploy` maps bindings by name; the `skiff` section names the Skiff resources behind
 * Hyperdrive and R2 and tunes the host. No Cloudflare account IDs are needed.
 */
export function starterWrangler(slug: string): string {
	return `{
  "name": "${slug}",
  "main": "src/index.ts",
  "compatibility_date": "${WORKERD_MAX_COMPATIBILITY_DATE}",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "GREETING": "hello" },
  "assets": { "directory": "public", "run_worker_first": ["/api/*"] },
  "triggers": { "crons": ["*/15 * * * *"] },

  // Read by Skiff only; Wrangler ignores it.
  "skiff": {
    "idleStopSeconds": 300,
    "memoryMb": 128
  }
}`;
}

export function starterWorker(): string {
	return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return Response.json({ message: env.GREETING, path: url.pathname });
  },

  async scheduled(controller, env, ctx) {
    console.log("cron", controller.cron);
  },
};`;
}

/** An upper-snake binding name for a Skiff resource name ("app-db" → "APP_DB"). */
export function bindingNameFor(resource: string): string {
	const name = resource
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return /^[A-Z_]/.test(name) ? name : `R_${name}`;
}

/**
 * The wrangler.jsonc lines that bind attached resources: Hyperdrive per attached database, R2 per
 * granted bucket, and the `skiff` section naming the Skiff resource behind each binding.
 */
export function dataBindingSnippet(
	databases: readonly string[],
	storage: ReadonlyArray<{ name: string; buckets: readonly string[] }>
): string {
	const db = databases.length > 0 ? databases : ['app-db'];
	const buckets =
		storage.length > 0
			? storage.flatMap((item) => item.buckets.map((bucket) => ({ storage: item.name, bucket })))
			: [{ storage: 'media', bucket: 'uploads' }];
	const hyperdrive = db.map(
		(name) => `    { "binding": "${bindingNameFor(name)}", "id": "ignored-by-skiff" }`
	);
	const r2 = buckets.map(
		(item) => `    { "binding": "${bindingNameFor(item.bucket)}", "bucket_name": "${item.bucket}" }`
	);
	const skiffDb = db.map((name) => `      "${bindingNameFor(name)}": "${name}"`);
	const skiffStorage = buckets.map(
		(item) => `      "${bindingNameFor(item.bucket)}": "${item.storage}"`
	);
	return `  "hyperdrive": [
${hyperdrive.join(',\n')}
  ],
  "r2_buckets": [
${r2.join(',\n')}
  ],
  "skiff": {
    "hyperdrive": {
${skiffDb.join(',\n')}
    },
    "storage": {
${skiffStorage.join(',\n')}
    }
  }`;
}

/** Develop locally, then deploy from the Wrangler project; the CLI builds the bundle. */
export function deployCommands(slug: string): string {
	return `skif wrangler dev            # the same workerd runtime, locally
skif deploy --project ${slug}  # bundles with wrangler and deploys`;
}

export interface SecretBindingRow {
	binding: string;
	secret: string;
}

/**
 * The store secret each `secret` binding names. FunctionView carries only the summary that
 * `functionBindingSummary` renders ("secret NAME"), so this reads it back from there.
 */
export function secretBindings(
	bindings: ReadonlyArray<{ name: string; type: string; summary: string }>
): SecretBindingRow[] {
	return bindings
		.filter((binding) => binding.type === 'secret')
		.map((binding) => ({
			binding: binding.name,
			secret: binding.summary.startsWith('secret ') ? binding.summary.slice(7).trim() : binding.name
		}));
}

/** Secret names the store accepts (SecretService.set). */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Secrets visible to a project by name; a project secret shadows an org one with the same name. */
export function secretIndex<S extends { name: string; projectId: string | null }>(
	secrets: readonly S[],
	projectId: string
): Map<string, S> {
	const index = new Map<string, S>();
	for (const secret of secrets) {
		const current = index.get(secret.name);
		if (!current || (secret.projectId === projectId && current.projectId !== projectId))
			index.set(secret.name, secret);
	}
	return index;
}

/** Store secret name → the bindings that read it. */
export function bindingsBySecret(rows: readonly SecretBindingRow[]): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const row of rows) index.set(row.secret, [...(index.get(row.secret) ?? []), row.binding]);
	return index;
}

/** A compatibility date this far behind the pinned workerd gets a nudge. */
export const COMPATIBILITY_LAG_WARN_DAYS = 90;

export interface Attention {
	kind: 'failed' | 'missing-secret' | 'not-deployed' | 'compat-behind' | 'older-pin';
	tone: 'danger' | 'warning' | 'info';
	message: string;
}

/**
 * What an operator should look at for one function, worst first. Pure, so the overview and its
 * tests agree on the rules.
 */
export function functionAttention(
	item: {
		view: Pick<FunctionView, 'compatibilityDate' | 'workerdVersion'> | null;
		workload: { status: string; message: string | null } | null;
		missingSecrets: readonly string[];
	},
	pinned: { version: string; maxDate: string } = {
		version: WORKERD_PINNED_VERSION,
		maxDate: WORKERD_MAX_COMPATIBILITY_DATE
	}
): Attention[] {
	const out: Attention[] = [];
	if (item.workload?.status === 'failed')
		out.push({
			kind: 'failed',
			tone: 'danger',
			message: item.workload.message
				? `Host failed: ${item.workload.message}`
				: 'Host failed to start.'
		});
	if (item.missingSecrets.length > 0)
		out.push({
			kind: 'missing-secret',
			tone: 'danger',
			message: `Bound ${item.missingSecrets.length === 1 ? 'secret' : 'secrets'} missing: ${item.missingSecrets.join(', ')}. The next deploy will fail.`
		});
	if (!item.view) {
		out.push({ kind: 'not-deployed', tone: 'info', message: 'No bundle deployed yet.' });
		return out;
	}
	const lag = compatibilityLagDays(item.view.compatibilityDate, pinned.maxDate);
	if (lag > COMPATIBILITY_LAG_WARN_DAYS)
		out.push({
			kind: 'compat-behind',
			tone: 'warning',
			message: `Compatibility date ${item.view.compatibilityDate} is ${lag} days behind the pinned workerd.`
		});
	if (item.view.workerdVersion !== pinned.version)
		out.push({
			kind: 'older-pin',
			tone: 'info',
			message: `Resolved against workerd ${item.view.workerdVersion}; the next deploy uses ${pinned.version}.`
		});
	return out;
}
