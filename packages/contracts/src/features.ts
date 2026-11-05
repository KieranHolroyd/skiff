/**
 * Runtime feature flags (docs/OPS.md §2.5).
 *
 * Every flag is read once from the environment as `SKIFF_FEATURE_<NAME>` and resolved here. The
 * registry is the single source of truth: a flag that is not in it cannot be switched on.
 * Defaults are deliberately conservative. Features that destroy data, change connectivity or have
 * not passed a restore drill default to `false`. Flags are additive: leaving one unset must keep
 * the previous release's behaviour, and enabling one must be reversible without a migration.
 */

export type FeatureArea =
	| 'agents'
	| 'automation'
	| 'backups'
	| 'databases'
	| 'networking'
	| 'platform'
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
	BACKUPS_RESTORE: {
		name: 'BACKUPS_RESTORE',
		default: false,
		area: 'backups',
		description: 'Create, restore and delete managed database backups from the dashboard and API.'
	},
	PITR: {
		name: 'PITR',
		default: false,
		area: 'backups',
		description: 'Point-in-time recovery for managed databases (WAL archiving and replay).'
	},
	OBJECT_BROWSER: {
		name: 'OBJECT_BROWSER',
		default: false,
		area: 'storage',
		description: 'Browse, upload, download and delete objects in managed storage buckets.'
	},
	POOLER: {
		name: 'POOLER',
		default: false,
		area: 'databases',
		description: 'Run a PgBouncer sidecar and publish the pooled connection port for a database.'
	},
	DB_TLS: {
		name: 'DB_TLS',
		default: false,
		area: 'databases',
		description: 'Accept TLS connections to managed databases and publish sslmode=require URLs.'
	},
	ORG_NETWORKS: {
		name: 'ORG_NETWORKS',
		default: false,
		area: 'networking',
		description: 'Private per-org networks that connect workloads and databases across nodes.'
	},
	APP_VOLUMES: {
		name: 'APP_VOLUMES',
		default: false,
		area: 'workloads',
		description: 'Attach persistent application volumes to deployed workloads.'
	},
	JOBS: {
		name: 'JOBS',
		default: false,
		area: 'automation',
		description: 'Scheduled one-off and cron jobs with concurrency and timeout limits.'
	},
	PREVIEW_DATA: {
		name: 'PREVIEW_DATA',
		default: false,
		area: 'automation',
		description: 'Clone database and bucket data into preview environments (can copy production data).'
	},
	AGENT_DATA_WRITE: {
		name: 'AGENT_DATA_WRITE',
		default: false,
		area: 'agents',
		description: 'Allow MCP/agent tools to mutate user data (writes, deletes) instead of read-only access.'
	},
	QUOTAS: {
		name: 'QUOTAS',
		default: true,
		area: 'platform',
		description: 'Enforce per-org project, storage and upload quotas. Set 0 to temporarily lift limits.'
	},
	BLUEPRINTS: {
		name: 'BLUEPRINTS',
		default: false,
		area: 'automation',
		description: 'Plan and apply skiff.yaml blueprints, including pruning resources they own.'
	},
	MEDIA: {
		name: 'MEDIA',
		default: false,
		area: 'storage',
		description: 'Image and video uploads, transforms and delivery through the platform.'
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
