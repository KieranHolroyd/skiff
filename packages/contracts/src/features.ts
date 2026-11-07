/**
 * Runtime feature flags (docs/OPS.md §2.5).
 *
 * Every flag is read once from the environment as `SKIFF_FEATURE_<NAME>` and resolved here. The
 * registry is the single source of truth: a flag that is not in it cannot be switched on.
 * Every flag defaults on and acts as a kill switch: set `SKIFF_FEATURE_<NAME>=0` to turn a feature
 * off. Turning one off must be reversible without a migration.
 */

export type FeatureArea =
	| 'agents'
	| 'automation'
	| 'backups'
	| 'databases'
	| 'email'
	| 'networking'
	| 'platform'
	| 'queues'
	| 'storage'
	| 'workloads';

export interface FeatureFlagDefinition {
	/** `SKIFF_FEATURE_<name>`. */
	readonly name: string;
	readonly default: boolean;
	readonly area: FeatureArea;
	readonly description: string;
}

/** Prefix for the environment variable that controls a flag. */
export const FEATURE_ENV_PREFIX = 'SKIFF_FEATURE_';

export const FEATURE_FLAGS = {
	FUNCTIONS: {
		name: 'FUNCTIONS',
		// Shipped: Functions is enabled by default (D110). Set SKIFF_FEATURE_FUNCTIONS=0 to turn the
		// tier off without removing already-deployed functions.
		default: true,
		area: 'workloads',
		description:
			'Deploy Workers-compatible functions on the pinned workerd runtime (docs/FUNCTIONS.md).'
	},
	BROKERS: {
		name: 'BROKERS',
		// D111: managed queue brokers. Purely additive (nothing runs until someone creates a broker),
		// so it ships on; set SKIFF_FEATURE_BROKERS=0 to hide the surfaces and refuse new brokers.
		default: true,
		area: 'queues',
		description: 'Create managed queue brokers (NATS with JetStream) and attach them to apps (docs/BROKERS.md).'
	},
	EMAIL: {
		name: 'EMAIL',
		// docs/EMAIL.md: purely additive. Nothing listens on 25/587/465 until a platform admin picks a
		// mail node in Settings → Email, so the flag ships on; 0 hides the surfaces and refuses sends.
		default: true,
		area: 'email',
		description: 'Send and receive email on verified domains through Skiff\'s own MTA (docs/EMAIL.md).'
	},
	BACKUPS_RESTORE: {
		name: 'BACKUPS_RESTORE',
		// Shipped: logical backups and restore-to-new are live. Default on preserves behaviour.
		default: true,
		area: 'backups',
		description: 'Create, restore and delete managed database backups from the dashboard and API.'
	},
	PITR: {
		name: 'PITR',
		default: true,
		area: 'backups',
		description: 'Point-in-time recovery for managed databases (WAL archiving and replay).'
	},
	OBJECT_BROWSER: {
		name: 'OBJECT_BROWSER',
		// Shipped: list/upload/download/delete/presign are live. Default on preserves behaviour.
		default: true,
		area: 'storage',
		description: 'Browse, upload, download and delete objects in managed storage buckets.'
	},
	POOLER: {
		name: 'POOLER',
		// Shipped: the per-database PgBouncer sidecar is live. Default on preserves behaviour.
		default: true,
		area: 'databases',
		description: 'Run a PgBouncer sidecar and publish the pooled connection port for a database.'
	},
	DB_STUDIO: {
		name: 'DB_STUDIO',
		// Plan 22 / D96: the native studio replaced the D60 console. Default on; kept as a kill switch.
		default: true,
		area: 'databases',
		description:
			'Open the native database studio (per-engine plugins in the on-demand skiff-studio process, D96). Set 0 to hide it.'
	},
	CONTAINER_CONSOLE: {
		name: 'CONTAINER_CONSOLE',
		// D127: inspect, read-only files and shells for project containers. A kill switch.
		default: true,
		area: 'workloads',
		description:
			'Container console for container projects: live stats and processes, a read-only file browser and an interactive shell (D127). Set 0 to hide it.'
	},
	DB_TLS: {
		name: 'DB_TLS',
		default: true,
		area: 'databases',
		description: 'Accept TLS connections to managed databases and publish sslmode=require URLs.'
	},
	ORG_NETWORKS: {
		name: 'ORG_NETWORKS',
		default: true,
		area: 'networking',
		description: 'Private per-org networks that connect workloads and databases across nodes.'
	},
	MULTI_NODE_REPLICAS: {
		name: 'MULTI_NODE_REPLICAS',
		default: true,
		area: 'workloads',
		description: 'Spread HTTP workload replicas across nodes with a load-balanced route (CLUSTERING C4).'
	},
	SERVICE_ENDPOINTS: {
		name: 'SERVICE_ENDPOINTS',
		default: true,
		area: 'networking',
		description: 'Cross-node database attachments through loopback service endpoints (CLUSTERING C2).'
	},
	APP_VOLUMES: {
		name: 'APP_VOLUMES',
		default: true,
		area: 'workloads',
		description: 'Attach persistent application volumes to deployed workloads.'
	},
	JOBS: {
		name: 'JOBS',
		// Plan 09: jobs run only on nodes whose agent advertises `jobs`; turning it off stops the scheduler.
		default: true,
		area: 'automation',
		description: 'Scheduled one-off and cron jobs with concurrency and timeout limits.'
	},
	PREVIEW_DATA: {
		name: 'PREVIEW_DATA',
		default: true,
		area: 'automation',
		description: 'Clone database and bucket data into preview environments (can copy production data).'
	},
	AGENT_DATA_WRITE: {
		name: 'AGENT_DATA_WRITE',
		default: true,
		area: 'agents',
		description: 'Allow MCP/agent tools to mutate user data (writes, deletes) instead of read-only access.'
	},
	QUOTAS: {
		name: 'QUOTAS',
		default: true,
		area: 'platform',
		description: 'Enforce per-org project, storage and upload quotas. Set 0 to temporarily lift limits.'
	},
	UPGRADE_ROLLBACK: {
		name: 'UPGRADE_ROLLBACK',
		default: true,
		area: 'platform',
		description: 'Reserved for dashboard-triggered automatic rollback after /readyz fails; CLI rollback is the tested path.'
	},
	BLUEPRINTS: {
		name: 'BLUEPRINTS',
		default: true,
		area: 'automation',
		description: 'Plan and apply blueprint files (skiff.blueprint.yaml) that declare a stack, including pruning what they manage.'
	},
	MEDIA: {
		name: 'MEDIA',
		default: true,
		area: 'storage',
		description: 'Image and video uploads, transforms and delivery through the platform.'
	},
	DB_AUTO_PROMOTE: {
		name: 'DB_AUTO_PROMOTE',
		// C7/C8: lets the failover controller (with `failover.enabled`) promote a Postgres read
		// replica when its primary's node goes silent. Off until the object-store lease self-fences
		// a partitioned primary (CLUSTERING §9.3): without it, a primary cut off from the control
		// plane keeps accepting writes from apps on its own node. Manual promotion needs no flag.
		default: true,
		area: 'databases',
		description: 'Let the failover controller promote a Postgres read replica automatically (CLUSTERING C8).'
	}
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureName = keyof typeof FEATURE_FLAGS;

export type FeatureFlags = {
	readonly [Name in FeatureName]: boolean;
};

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as FeatureName[];

/** Resolved defaults, useful for tests and for services that were built without a config. */
export const DEFAULT_FEATURES: FeatureFlags = Object.freeze(
	Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, FEATURE_FLAGS[name].default])) as {
		[Name in FeatureName]: boolean;
	}
);

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no']);

/** `SKIFF_FEATURE_<NAME>` for a registered flag. */
export function featureEnvKey(name: FeatureName): string {
	return `${FEATURE_ENV_PREFIX}${name}`;
}

/**
 * Parse one flag value. `undefined` means unset; unknown values are treated as unset (the caller
 * keeps the registry default) rather than failing the control plane at startup.
 */
export function parseFeatureFlagValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
}

/**
 * Flags that existed in an earlier release and were removed. Setting one is harmless: it is
 * ignored like any unknown `SKIFF_FEATURE_*`, and `retiredFeatureFlagsSet` lets startup warn.
 */
export const RETIRED_FEATURE_FLAGS: Readonly<Record<string, string>> = Object.freeze({
	DB_CONSOLE: 'The D60 studio console was replaced by the native studio (D96); use SKIFF_FEATURE_DB_STUDIO.'
});

/** Retired flags that are still set in `env`, with the reason each was removed. */
export function retiredFeatureFlagsSet(
	env: Record<string, string | undefined> = process.env
): { name: string; env: string; reason: string }[] {
	return Object.entries(RETIRED_FEATURE_FLAGS)
		.filter(([name]) => env[`${FEATURE_ENV_PREFIX}${name}`] !== undefined)
		.map(([name, reason]) => ({ name, env: `${FEATURE_ENV_PREFIX}${name}`, reason }));
}

/**
 * Resolve every registered flag from an env map. Unset or malformed values keep the registry
 * default, so a typo never turns a destructive feature on.
 */
export function parseFeatureFlags(
	env: Record<string, string | undefined> = process.env
): FeatureFlags {
	const flags = {} as Record<FeatureName, boolean>;
	for (const name of FEATURE_FLAG_NAMES) {
		flags[name] = parseFeatureFlagValue(env[featureEnvKey(name)]) ?? FEATURE_FLAGS[name].default;
	}
	return flags;
}
