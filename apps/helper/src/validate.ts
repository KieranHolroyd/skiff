/**
 * Validation for everything that crosses the helper socket. The helper is the last line of
 * defence for a privileged process: it never trusts the control plane or the agent, never sees a
 * shell string, and rejects anything it cannot render as a fixed systemd unit.
 *
 * This module deliberately does not import `@skiff/contracts`: the helper ships without runtime
 * dependencies and validates the wire shape itself, so a compromised contract package cannot
 * widen the privileged surface.
 */

import { volumePathProblem } from './volumes.ts';

export const WORKLOAD_RUNTIMES = ['process', 'container', 'function'] as const;
export type WorkloadRuntime = (typeof WORKLOAD_RUNTIMES)[number];

/** Module kinds workerd's `Worker.modules` union can load (docs/FUNCTIONS.md §4.3). */
export const FUNCTION_MODULE_TYPES = ['esm', 'cjs', 'text', 'data', 'wasm', 'python'] as const;
export type FunctionModuleType = (typeof FUNCTION_MODULE_TYPES)[number];

/**
 * Binding kinds the helper accepts. Keep in step with `functionBindingTypes` in
 * `@skiff/contracts` (function.ts): a kind missing here makes every deploy that uses it fail on
 * the node with a 400 while the control plane accepted it.
 */
export const FUNCTION_BINDING_TYPES = [
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
export type FunctionBindingType = (typeof FUNCTION_BINDING_TYPES)[number];

/**
 * Bindings whose backing service keeps SQLite state on the shared `do-storage` disk service.
 * The helper only needs this to know whether the unit must expose the state directory (FN11).
 * Must match the agent renderers that set `requiresDurableStorage` (function-bindings/*.ts).
 */
export const DURABLE_FUNCTION_BINDING_TYPES = ['durable_object', 'kv', 'cache', 'd1'] as const;

export const WORKLOAD_STATUSES = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type WorkloadStatus = (typeof WORKLOAD_STATUSES)[number];

export const SECRET_DELIVERY_MODES = ['env', 'file'] as const;
export type SecretDeliveryMode = (typeof SECRET_DELIVERY_MODES)[number];

/** `^[A-Za-z0-9_-]+$` — workload ids, project ids and unit-name fragments. */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** The legacy shared network; kept as the fallback for desired state without an org id. */
export const DEFAULT_WORKLOAD_NETWORK = 'skiff-workloads';
export const ORG_NETWORK_PREFIX = 'skiff-org-';
export const NETWORK_NAME_PATTERN = /^skiff-(?:org-[a-z0-9][a-z0-9_-]*|workloads)$/;

/** Derive `skiff-org-<orgId>` exactly like the contract; it is never stored. */
export function orgNetworkName(orgId: string): string {
	const label = orgId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `${ORG_NETWORK_PREFIX}${label}`;
}

/** Resolve the network a workload joins: explicit name, org-derived name, then the legacy shared one. */
export function workloadNetworkName(workload: { orgId?: string; networkName?: string }): string {
	if (workload.networkName) return workload.networkName;
	if (workload.orgId) return orgNetworkName(workload.orgId);
	return DEFAULT_WORKLOAD_NETWORK;
}

const MAX_ID_LENGTH = 100;
const MAX_ENV_VALUE = 16_384;
const MAX_COMMAND_ARG = 1024;
const MAX_COMMAND_ARGS = 64;
const MAX_SECRETS = 128;
const MAX_SECRET_BYTES = 1_048_576;
const MAX_ACTIVATION_BYTES = 4_194_304;
const MAX_FUNCTION_MODULES = 512;
const MAX_FUNCTION_BINDINGS = 64;
const MAX_FUNCTION_FLAGS = 32;
const MAX_FUNCTION_CRONS = 8;
const MAX_FUNCTION_ASSET_GLOBS = 64;
const MAX_FUNCTION_CONFIG_BYTES = 512 * 1024;
const MAX_FUNCTION_SHIM_BYTES = 256 * 1024;
/** Extra embedded worker modules (binding services): bounded so one apply stays small. */
const MAX_FUNCTION_FILES = 16;
const MAX_FUNCTION_FILE_BYTES = 256 * 1024;
const MAX_FUNCTION_FILES_BYTES = 1024 * 1024;
const FUNCTION_FILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** The fixed credentials; a binding file may never shadow them. */
const RESERVED_FUNCTION_FILE_NAMES: ReadonlySet<string> = new Set(['function-config', 'function-shim']);
const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPATIBILITY_FLAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const WORKERD_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const FUNCTION_UNIQUE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const FUNCTION_ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Raised for any malformed or unsafe request. Mapped to HTTP 400 by the server. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

export interface SecretRef {
	name: string;
	version?: number;
	delivery: SecretDeliveryMode;
}

export interface WorkloadVolumeMount {
	id: string;
	mountPath: string;
	readOnly: boolean;
	backing: 'node_volume' | 'state_dir';
	nodeVolumeId?: string;
}

/** One module in a function bundle. `name` is a path relative to the release root. */
export interface WorkloadFunctionModule {
	name: string;
	type: FunctionModuleType;
	sha256: string;
}

/**
 * A resolved binding. The helper only needs the name, the kind and the few identity fields that
 * decide the unit (Durable Object storage). It never reads a secret value, an upstream or any
 * other property out of the wire into a unit.
 */
export interface WorkloadFunctionBinding {
	name: string;
	type: FunctionBindingType;
	/** `durable_object`: the class the user Worker exports. */
	className?: string;
	/** `durable_object`: the stable namespace key rendered into the config. */
	uniqueKey?: string;
	/** `hyperdrive`, `r2`: prefix of the attached resource's activation env variables. */
	envPrefix?: string;
	/** `kv`, `d1`, `queue`: stable namespace id, one per binding. */
	namespaceId?: string;
}

/**
 * The resolved function spec a node runs (docs/FUNCTIONS.md §4.3). It is agent-rendered data,
 * never a command line: every value that reaches a unit has been validated here.
 */
export interface WorkloadFunction {
	main: string;
	modules: WorkloadFunctionModule[];
	compatibilityDate: string;
	compatibilityFlags: string[];
	bindings: WorkloadFunctionBinding[];
	triggers: { crons: string[] };
	assets: { directory: string; runWorkerFirst: string[] } | null;
	idleStopSeconds: number;
	workerdVersion: string;
}

/**
 * Extra worker source modules embedded beside the config (binding services). Keyed by the
 * systemd credential name the capnp config refers to with `embed "<name>"`.
 */
export type WorkloadFunctionExtraFiles = Record<string, string>;

/** The agent-rendered workerd config, shim and optional binding modules. */
export interface WorkloadFunctionFiles {
	config: string;
	shim: string;
	files?: WorkloadFunctionExtraFiles;
}

/** True when a binding needs the shared `do-storage` disk service (FN11). */
export function functionNeedsDurableStorage(fn: WorkloadFunction): boolean {
	return fn.bindings.some((binding) =>
		(DURABLE_FUNCTION_BINDING_TYPES as readonly string[]).includes(binding.type),
	);
}

export interface WorkloadDesired {
	id: string;
	projectId: string;
	projectSlug: string;
	deploymentId: string;
	/** Owning org (plan 04b); when absent the legacy shared network is used. */
	orgId?: string;
	/** Explicit network name; normally derived from `orgId`. */
	networkName?: string;
	runtime: WorkloadRuntime;
	status: WorkloadStatus;
	release: string | null;
	upstream: string;
	memoryMb: number;
	cpus: number;
	port: number;
	healthPath: string;
	socketActivation: boolean;
	activationVersion: string;
	env: Record<string, string>;
	secrets: SecretRef[];
	dataSizeMb: number | null;
	/**
	 * Optional because the current contract does not carry them yet. The agent forwards them when
	 * present; otherwise a process workload defaults to `bun run start` and a container workload
	 * fails with a clear message naming `image`.
	 */
	command?: string[];
	image?: string;
	/**
	 * Managed database profile (D55, D61). When present the helper renders a fixed unit: the image,
	 * user, mounts and container port all come from the helper's own registry, never the wire.
	 */
	database?: WorkloadDatabase;
	/** PgBouncer sidecar host port (managed databases only). */
	pooler?: { port: number };
	/**
	 * Managed object storage profile (S1). Like `database`, only `engine` + `version` matter here:
	 * the image (pinned by digest), user, mounts and container port come from `STORAGE_ENGINES`.
	 * The agent's bucket/user desired state is accepted on the wire but never reaches a unit.
	 */
	objectStorage?: WorkloadObjectStorage;
	/**
	 * Managed queue broker profile (D111). Like `database`, only `engine`, `version` and the store
	 * cap matter: image, user, mounts, config and container port come from `BROKER_ENGINES`.
	 */
	broker?: WorkloadBroker;
	/** Node volume for the data dir (D74); resolved and verified against the helper's registry. */
	volumeId?: string;
	/** App volumes mounted into this workload (plan 07); ids and mount points only, never paths. */
	volumes?: WorkloadVolumeMount[];
	/** Worker (plan 21): no published port. */
	ingress?: 'none';
	/**
	 * Functions only (D110): the resolved manifest the agent rendered. The helper writes the
	 * workerd config from `functionFiles` and starts the pinned binary; this spec never becomes a
	 * command line.
	 */
	function?: WorkloadFunction;
	/**
	 * Ephemeral CI runner profile (plan 21). The helper derives the fixed entrypoint, `Restart=no`,
	 * `Pull=newer` and a writable, throwaway root from it; nothing about it comes from the wire.
	 */
	runner?: { provider: 'github' };
}

/**
 * The helper's own copy of the engine registry (D61). It is deliberately not imported from
 * `@skiff/contracts`: a wider contract must not widen what the privileged helper will run.
 */
/**
 * The helper's own engine registry (D61, D95). It maps `engine` + `version` from the wire to a
 * fixed image, user, port and the env names its verbs read back; nothing here comes from the
 * control plane. The images are each vendor's official ones.
 *
 * - `env` names the owner user / password / database variables in the container env file, which
 *   the control plane writes with the same names (`databaseEngineRegistry.containerEnv`).
 * - `cli` is the in-container client the fixed verbs exec (never a shell).
 */
export const DATABASE_ENGINES = {
	postgres: {
		versions: ['16', '17'],
		/** The official image's `postgres` user and group. */
		uid: 70,
		gid: 70,
		containerPort: 5432,
		image: (version: string) => `docker.io/library/postgres:${version}-alpine`,
		env: { user: 'POSTGRES_USER', password: 'POSTGRES_PASSWORD', database: 'POSTGRES_DB' },
		cli: 'psql',
	},
	mysql: {
		versions: ['8.4', '9.7'],
		/** The official image's `mysql` user and group. */
		uid: 999,
		gid: 999,
		containerPort: 3306,
		image: (version: string) => `docker.io/library/mysql:${version}`,
		env: { user: 'MYSQL_USER', password: 'MYSQL_PASSWORD', database: 'MYSQL_DATABASE' },
		cli: 'mysql',
	},
	mariadb: {
		versions: ['11.4', '11.8'],
		/** The official image's `mysql` user and group. */
		uid: 999,
		gid: 999,
		containerPort: 3306,
		image: (version: string) => `docker.io/library/mariadb:${version}`,
		env: { user: 'MARIADB_USER', password: 'MARIADB_PASSWORD', database: 'MARIADB_DATABASE' },
		cli: 'mariadb',
	},
	mongodb: {
		versions: ['8.0', '9.0'],
		/** The official image's `mongodb` user and group. */
		uid: 999,
		gid: 999,
		containerPort: 27017,
		image: (version: string) => `docker.io/library/mongo:${version}`,
		env: {
			user: 'MONGO_INITDB_ROOT_USERNAME',
			password: 'MONGO_INITDB_ROOT_PASSWORD',
			database: 'MONGO_INITDB_DATABASE',
		},
		cli: 'mongosh',
	},
	valkey: {
		versions: ['8.1', '9.1'],
		/** The alpine image's `valkey` user (999) and group (1000). */
		uid: 999,
		gid: 1000,
		containerPort: 6379,
		image: (version: string) => `docker.io/valkey/valkey:${version}-alpine`,
		env: { user: 'VALKEY_USER', password: 'VALKEY_PASSWORD', database: null },
		cli: 'valkey-cli',
	},
	redis: {
		versions: ['8.8', '8.10'],
		/** The alpine image's `redis` user (999) and group (1000). */
		uid: 999,
		gid: 1000,
		containerPort: 6379,
		image: (version: string) => `docker.io/library/redis:${version}-alpine`,
		env: { user: 'REDIS_USER', password: 'REDIS_PASSWORD', database: null },
		cli: 'redis-cli',
	},
} as const satisfies Record<
	string,
	{
		versions: readonly string[];
		uid: number;
		gid: number;
		containerPort: number;
		image: (version: string) => string;
		env: { user: string; password: string; database: string | null };
		cli: string;
	}
>;
export type DatabaseEngine = keyof typeof DATABASE_ENGINES;

export interface WorkloadDatabase {
	engine: DatabaseEngine;
	version: string;
	/** WAL archiving for PITR (docs/PITR.md); omitted when the feature is off. */
	pitr?: { stanza: string; archiveTimeoutSeconds: number };
	/** Render Postgres with the helper-generated certificate (SKIFF_FEATURE_DB_TLS). */
	tls?: boolean;
}

/** Workload ids of managed databases carry this prefix; `purge` accepts these and `st_` ids. */
export const DATABASE_ID_PREFIX = 'db_';

/** The image the helper runs for a database profile. */
export function databaseImage(database: WorkloadDatabase): string {
	return DATABASE_ENGINES[database.engine].image(database.version);
}

/** `db-<hex>`: DNS alias on the workload's org network (or the legacy shared network); same derivation as the contract. */
export function databaseAlias(id: string): string {
	return `db-${id.replace(/^db_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

export function parseDatabase(value: unknown, label = 'workload.database'): WorkloadDatabase {
	const record = assertRecord(value, label);
	const engine = record.engine;
	if (typeof engine !== 'string' || !Object.hasOwn(DATABASE_ENGINES, engine))
		throw new ValidationError(`${label}.engine must be one of ${Object.keys(DATABASE_ENGINES).join(', ')}`);
	const info = DATABASE_ENGINES[engine as DatabaseEngine];
	const version = record.version;
	if (typeof version !== 'string' || !(info.versions as readonly string[]).includes(version))
		throw new ValidationError(`${label}.version must be one of ${info.versions.join(', ')}`);
	for (const key of Object.keys(record)) {
		if (key !== 'engine' && key !== 'version' && key !== 'pitr' && key !== 'tls')
			throw new ValidationError(`${label}.${key} is not supported`);
	}
	const parsed: WorkloadDatabase = { engine: engine as DatabaseEngine, version };
	// WAL archiving and the helper-generated certificate are Postgres features (docs/DATABASES.md §17).
	if (engine !== 'postgres' && (record.pitr !== undefined || record.tls === true))
		throw new ValidationError(`${label}.pitr and ${label}.tls are only supported for postgres`);
	if (record.pitr !== undefined) {
		const pitr = assertRecord(record.pitr, `${label}.pitr`);
		const stanza = assertString(pitr.stanza, `${label}.pitr.stanza`, { max: 64 });
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(stanza))
			throw new ValidationError(`${label}.pitr.stanza must match ^[A-Za-z0-9_-]{1,64}$`);
		parsed.pitr = {
			stanza,
			archiveTimeoutSeconds:
				pitr.archiveTimeoutSeconds === undefined
					? 60
					: assertInteger(pitr.archiveTimeoutSeconds, `${label}.pitr.archiveTimeoutSeconds`, 1, 3600),
		};
		for (const key of Object.keys(pitr)) {
			if (key !== 'stanza' && key !== 'archiveTimeoutSeconds')
				throw new ValidationError(`${label}.pitr.${key} is not supported`);
		}
	}
	if (record.tls !== undefined) {
		if (typeof record.tls !== 'boolean') throw new ValidationError(`${label}.tls must be a boolean`);
		parsed.tls = record.tls;
	}
	return parsed;
}

/** `db_` ids only, so a purge can never point at an app's data directory. */
export function assertDatabaseId(value: unknown, label = 'database id'): string {
	const id = assertId(value, label);
	if (!id.startsWith(DATABASE_ID_PREFIX) || id.length === DATABASE_ID_PREFIX.length)
		throw new ValidationError(`${label} must start with "${DATABASE_ID_PREFIX}"`);
	return id;
}

/**
 * The helper's own copy of the object-storage registry (S1, same reasoning as D61). Images are
 * pinned by digest: the wire names a tag, the helper runs only the digest it knows.
 */
export const STORAGE_ENGINES = {
	rustfs: {
		versions: ['1.0.4'],
		/** The image's `rustfs` user and group. */
		uid: 10001,
		gid: 10001,
		containerPort: 9000,
		images: {
			'1.0.4': 'docker.io/rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2',
		} as Record<string, string>,
		/** The tag the control plane sends (`storageImage` in the contract). */
		tag: (version: string) => `docker.io/rustfs/rustfs:${version}`,
	},
} as const;
export type StorageEngine = keyof typeof STORAGE_ENGINES;

export interface WorkloadObjectStorage {
	engine: StorageEngine;
	version: string;
}

/** Workload ids of storage instances carry this prefix; `purge` accepts them too. */
export const STORAGE_ID_PREFIX = 'st_';

/**
 * Fixed RustFS settings, forced into the env file whatever the wire says. The empty log directory
 * overrides the image's `/logs` default so logs go to stdout and the journal.
 */
export const STORAGE_ENV: Readonly<Record<string, string>> = {
	RUSTFS_VOLUMES: '/data',
	RUSTFS_ADDRESS: ':9000',
	RUSTFS_CONSOLE_ENABLE: 'false',
	RUSTFS_OBS_LOG_DIRECTORY: '',
};

/** The digest-pinned image the helper runs for a storage profile. */
export function storageImage(storage: WorkloadObjectStorage): string {
	const image = STORAGE_ENGINES[storage.engine].images[storage.version];
	if (!image) throw new ValidationError(`No pinned image for ${storage.engine} ${storage.version}`);
	return image;
}

/** `s3-<hex>`: DNS alias on the workload's org network (or the legacy shared network); same derivation as the contract. */
export function storageAlias(id: string): string {
	return `s3-${id.replace(/^st_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/** Agent-side desired state the helper accepts and ignores (buckets and keys are converged over S3). */
const STORAGE_AGENT_KEYS = new Set(['buckets', 'users', 'deleteBuckets', 'keysVersion']);

export function parseObjectStorage(value: unknown, label = 'workload.objectStorage'): WorkloadObjectStorage {
	const record = assertRecord(value, label);
	const engine = record.engine;
	if (typeof engine !== 'string' || !Object.hasOwn(STORAGE_ENGINES, engine))
		throw new ValidationError(`${label}.engine must be one of ${Object.keys(STORAGE_ENGINES).join(', ')}`);
	const info = STORAGE_ENGINES[engine as StorageEngine];
	const version = record.version;
	if (typeof version !== 'string' || !(info.versions as readonly string[]).includes(version))
		throw new ValidationError(`${label}.version must be one of ${info.versions.join(', ')}`);
	for (const key of Object.keys(record)) {
		if (key !== 'engine' && key !== 'version' && !STORAGE_AGENT_KEYS.has(key))
			throw new ValidationError(`${label}.${key} is not supported`);
	}
	return { engine: engine as StorageEngine, version };
}

/** `st_` ids only. */
export function assertStorageId(value: unknown, label = 'storage id'): string {
	const id = assertId(value, label);
	if (!id.startsWith(STORAGE_ID_PREFIX) || id.length === STORAGE_ID_PREFIX.length)
		throw new ValidationError(`${label} must start with "${STORAGE_ID_PREFIX}"`);
	return id;
}

/**
 * The helper's own copy of the queue-broker registry (D111, same reasoning as D61): a wider
 * contract must not widen what the privileged helper will run. NATS runs as a static binary, so
 * the uid is ours to pick; the data dir and config are chowned to it.
 */
export const BROKER_ENGINES = {
	nats: {
		versions: ['2.11', '2.12'],
		uid: 4222,
		gid: 4222,
		containerPort: 4222,
		image: (version: string) => `docker.io/library/nats:${version}-alpine`,
	},
} as const satisfies Record<
	string,
	{ versions: readonly string[]; uid: number; gid: number; containerPort: number; image: (version: string) => string }
>;
export type BrokerEngine = keyof typeof BROKER_ENGINES;

export interface WorkloadBroker {
	engine: BrokerEngine;
	version: string;
	/** Persistent store cap in MB, written into the engine's config. */
	storageMb: number;
}

/** Workload ids of brokers carry this prefix; `purge` accepts them too. */
export const BROKER_ID_PREFIX = 'mq_';

/** The image the helper runs for a broker profile. */
export function brokerImage(broker: WorkloadBroker): string {
	return BROKER_ENGINES[broker.engine].image(broker.version);
}

/** `mq-<hex>`: DNS alias on the workload's org network; same derivation as the contract. */
export function brokerAlias(id: string): string {
	return `mq-${id.replace(/^mq_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

export function parseBroker(value: unknown, label = 'workload.broker'): WorkloadBroker {
	const record = assertRecord(value, label);
	const engine = record.engine;
	if (typeof engine !== 'string' || !Object.hasOwn(BROKER_ENGINES, engine))
		throw new ValidationError(`${label}.engine must be one of ${Object.keys(BROKER_ENGINES).join(', ')}`);
	const info = BROKER_ENGINES[engine as BrokerEngine];
	const version = record.version;
	if (typeof version !== 'string' || !(info.versions as readonly string[]).includes(version))
		throw new ValidationError(`${label}.version must be one of ${info.versions.join(', ')}`);
	for (const key of Object.keys(record)) {
		if (key !== 'engine' && key !== 'version' && key !== 'storageMb')
			throw new ValidationError(`${label}.${key} is not supported`);
	}
	const storageMb = assertInteger(record.storageMb, `${label}.storageMb`, 256, 1_048_576);
	return { engine: engine as BrokerEngine, version, storageMb };
}

/** `mq_` ids only. */
export function assertBrokerId(value: unknown, label = 'broker id'): string {
	const id = assertId(value, label);
	if (!id.startsWith(BROKER_ID_PREFIX) || id.length === BROKER_ID_PREFIX.length)
		throw new ValidationError(`${label} must start with "${BROKER_ID_PREFIX}"`);
	return id;
}

/** A managed-service id (`db_`, `st_` or `mq_`): the only ids whose data dir `purge` may delete. */
export function assertManagedId(value: unknown, label = 'managed id'): string {
	const id = assertId(value, label);
	for (const prefix of [DATABASE_ID_PREFIX, STORAGE_ID_PREFIX, BROKER_ID_PREFIX]) {
		if (id.startsWith(prefix) && id.length > prefix.length) return id;
	}
	throw new ValidationError(
		`${label} must start with "${DATABASE_ID_PREFIX}", "${STORAGE_ID_PREFIX}" or "${BROKER_ID_PREFIX}"`,
	);
}

export interface WorkloadActivation {
	workloadId: string;
	activationVersion: string;
	env: Record<string, string>;
	files: Record<string, string>;
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new ValidationError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function assertString(
	value: unknown,
	label: string,
	options: { min?: number; max?: number } = {},
): string {
	if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
	const min = options.min ?? 1;
	const max = options.max ?? 4096;
	if (value.length < min) throw new ValidationError(`${label} must be at least ${min} characters`);
	if (value.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
	if (value.includes('\0')) throw new ValidationError(`${label} contains a NUL byte`);
	return value;
}

export function assertId(value: unknown, label = 'id'): string {
	const id = assertString(value, label, { max: MAX_ID_LENGTH });
	if (!ID_PATTERN.test(id)) throw new ValidationError(`${label} must match ${ID_PATTERN}`);
	return id;
}

export function assertSlug(value: unknown, label = 'projectSlug'): string {
	const slug = assertString(value, label, { max: 100 });
	if (!SLUG_PATTERN.test(slug)) throw new ValidationError(`${label} must match ${SLUG_PATTERN}`);
	return slug;
}

/** Network names are helper-owned: an org network or the legacy shared one, nothing else. */
export function assertNetworkName(value: unknown, label = 'networkName'): string {
	const name = assertString(value, label, { max: 100 });
	if (!NETWORK_NAME_PATTERN.test(name))
		throw new ValidationError(`${label} must be "skiff-workloads" or "skiff-org-<id>"`);
	return name;
}

export function assertSha256(value: unknown, label = 'sha256'): string {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value))
		throw new ValidationError(`${label} must be a lowercase SHA-256 hex digest`);
	return value;
}

export function assertEnvName(value: unknown, label = 'environment variable name'): string {
	if (typeof value !== 'string' || !ENV_NAME_PATTERN.test(value) || value.length > 128)
		throw new ValidationError(`${label} must match ${ENV_NAME_PATTERN}`);
	return value;
}

export function assertSecretName(value: unknown, label = 'secret name'): string {
	if (typeof value !== 'string' || !SECRET_NAME_PATTERN.test(value) || value.length > 128)
		throw new ValidationError(`${label} must match ${SECRET_NAME_PATTERN}`);
	return value;
}

/** A Durable Object unique key or KV namespace id: a stable `[A-Za-z0-9._-]` token. */
export function assertFunctionKey(value: unknown, label: string): string {
	if (typeof value !== 'string' || !FUNCTION_UNIQUE_KEY_PATTERN.test(value))
		throw new ValidationError(`${label} must match ${FUNCTION_UNIQUE_KEY_PATTERN}`);
	return value;
}

/** The activation env prefix of an attached database (`DATABASE` → `DATABASE_POOL_HOST`, …). */
export function assertFunctionEnvPrefix(value: unknown, label: string): string {
	if (typeof value !== 'string' || !FUNCTION_ENV_PREFIX_PATTERN.test(value))
		throw new ValidationError(`${label} must match ${FUNCTION_ENV_PREFIX_PATTERN}`);
	return value;
}

/** A positive integer within the inclusive range. */
export function assertInteger(value: unknown, label: string, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
		throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
	return value;
}

export function assertPort(value: unknown, label = 'port'): number {
	return assertInteger(value, label, 1, 65535);
}

export function assertMemoryMb(value: unknown, label = 'memoryMb'): number {
	return assertInteger(value, label, 32, 65_536);
}

export function assertCpus(value: unknown, label = 'cpus'): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 64)
		throw new ValidationError(`${label} must be a number between 0 and 64`);
	return value;
}

export function assertCpuWeight(value: unknown, label = 'cpuWeight'): number {
	return assertInteger(value, label, 1, 10_000);
}

/**
 * A path the helper itself joins under a root-owned directory. Rejects absolute paths, `..`,
 * separators, control characters and anything that could escape a unit/env directory.
 */
export function assertRelativePath(value: unknown, label = 'relative path'): string {
	const path = assertString(value, label, { max: 1024 });
	if (path.startsWith('/')) throw new ValidationError(`${label} must be relative`);
	if (path.includes('\\')) throw new ValidationError(`${label} must not contain backslashes`);
	if (path.includes('..')) throw new ValidationError(`${label} must not contain ".."`);
	for (const segment of path.split('/')) {
		if (segment === '') throw new ValidationError(`${label} must not contain empty segments`);
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(path))
		throw new ValidationError(`${label} contains unsupported characters`);
	return path;
}

/** Absolute host path used for unit/env directories. No whitespace or control characters. */
export function assertAbsolutePath(value: unknown, label = 'path'): string {
	const path = assertString(value, label, { max: 4096 });
	if (!path.startsWith('/')) throw new ValidationError(`${label} must be absolute`);
	if (!/^[A-Za-z0-9._/@+-]+$/.test(path))
		throw new ValidationError(`${label} contains whitespace or unsupported characters`);
	return path;
}

/** Health paths must be HTTP paths; control characters and backslashes are refused. */
export function assertHealthPath(value: unknown, label = 'healthPath'): string {
	const path = assertString(value, label, { max: 512 });
	if (!path.startsWith('/')) throw new ValidationError(`${label} must start with "/"`);
	if (/[\s\\#\0]/.test(path)) throw new ValidationError(`${label} contains whitespace or unsupported characters`);
	return path;
}

/** A fixed argv. Control characters are refused because they cannot appear in a unit safely. */
export function assertCommand(value: unknown, label = 'command'): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS)
		throw new ValidationError(`${label} must be a non-empty array of at most ${MAX_COMMAND_ARGS} strings`);
	return value.map((entry, index) => {
		const arg = assertString(entry, `${label}[${index}]`, { max: MAX_COMMAND_ARG });
		if (/[\r\n\0]/.test(arg)) throw new ValidationError(`${label}[${index}] must not contain newlines`);
		// Tabs and other C0 controls have no safe unit representation.
		for (const char of arg) {
			const code = char.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f)
				throw new ValidationError(`${label}[${index}] must not contain control characters`);
		}
		return arg;
	});
}

/**
 * OCI image reference: lowercase repository, optional registry with port, optional tag, optional
 * digest. Upper case, whitespace, shell metacharacters and `..` are rejected.
 */
export function assertImage(value: unknown, label = 'image'): string {
	const image = assertString(value, label, { max: 512 });
	if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(image))
		throw new ValidationError(`${label} is not a valid OCI image reference`);
	if (image.includes('..') || image.includes('//'))
		throw new ValidationError(`${label} contains an unsafe path fragment`);
	for (const segment of image.split('@')[0]!.split('/')) {
		if (segment === '' || segment === '.' || segment === '..')
			throw new ValidationError(`${label} contains an unsafe path fragment`);
	}
	return image;
}

function parseEnvRecord(value: unknown, label: string): Record<string, string> {
	const record = value === undefined ? {} : assertRecord(value, label);
	const env: Record<string, string> = {};
	for (const [key, raw] of Object.entries(record)) {
		assertEnvName(key, `${label} key`);
		// Empty is a real value (`RUSTFS_OBS_LOG_DIRECTORY=` overrides an image default).
		const value = assertString(raw, `${label}.${key}`, { min: 0, max: MAX_ENV_VALUE });
		env[key] = value;
	}
	return env;
}

function parseSecrets(value: unknown): SecretRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_SECRETS)
		throw new ValidationError(`secrets must be an array of at most ${MAX_SECRETS} entries`);
	const seen = new Set<string>();
	return value.map((entry, index) => {
		const record = assertRecord(entry, `secrets[${index}]`);
		const name = assertSecretName(record.name, `secrets[${index}].name`);
		if (seen.has(name)) throw new ValidationError(`Duplicate secret ${name}`);
		seen.add(name);
		const delivery = record.delivery ?? 'env';
		if (delivery !== 'env' && delivery !== 'file')
			throw new ValidationError(`secrets[${index}].delivery must be "env" or "file"`);
		const ref: SecretRef = { name, delivery };
		if (record.version !== undefined) ref.version = assertInteger(record.version, `secrets[${index}].version`, 1, 2 ** 31 - 1);
		return ref;
	});
}

/** App-volume mounts from desired state. The host path is derived by the helper, never accepted. */
export function parseWorkloadVolumes(value: unknown): WorkloadVolumeMount[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 20)
		throw new ValidationError('workload.volumes must be an array of at most 20 mounts');
	const out: WorkloadVolumeMount[] = [];
	const ids = new Set<string>();
	const mounts = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const record = assertRecord(entry, `workload.volumes[${index}]`);
		const id = assertId(record.id, `workload.volumes[${index}].id`);
		if (ids.has(id)) throw new ValidationError(`Duplicate app volume ${id}`);
		ids.add(id);
		const mountPath = assertString(record.mountPath, `workload.volumes[${index}].mountPath`, {
			max: 200,
		});
		const problem = volumePathProblem(mountPath);
		if (problem) throw new ValidationError(`App volume ${id}: ${problem}`);
		if (mounts.has(mountPath))
			throw new ValidationError(`Two app volumes cannot mount at the same path: ${mountPath}`);
		mounts.add(mountPath);
		if (record.readOnly !== undefined && typeof record.readOnly !== 'boolean')
			throw new ValidationError(`workload.volumes[${index}].readOnly must be a boolean`);
		const backing = record.backing ?? 'state_dir';
		if (backing !== 'node_volume' && backing !== 'state_dir')
			throw new ValidationError(`workload.volumes[${index}].backing must be "node_volume" or "state_dir"`);
		let nodeVolumeId: string | undefined;
		if (backing === 'node_volume') {
			nodeVolumeId = assertId(
				record.nodeVolumeId,
				`workload.volumes[${index}].nodeVolumeId`,
			);
		} else if (record.nodeVolumeId !== undefined) {
			throw new ValidationError('A state-dir app volume cannot name a node volume');
		}
		out.push({
			id,
			mountPath,
			readOnly: record.readOnly === true,
			backing,
			...(nodeVolumeId ? { nodeVolumeId } : {}),
		});
	}
	return out;
}

/**
 * The resolved function spec (docs/FUNCTIONS.md §4, FN8). The helper mirrors the contract shape
 * without importing it and keeps the wire strictly data: paths are relative to the release and
 * checked for traversal, nothing here becomes a shell fragment or an arbitrary unit directive.
 */
export function parseWorkloadFunction(value: unknown, label = 'workload.function'): WorkloadFunction {
	const record = assertRecord(value, label);
	const main = assertRelativePath(record.main, `${label}.main`);

	if (!Array.isArray(record.modules) || record.modules.length < 1 || record.modules.length > MAX_FUNCTION_MODULES)
		throw new ValidationError(`${label}.modules must be an array of 1–${MAX_FUNCTION_MODULES} modules`);
	const modules: WorkloadFunctionModule[] = [];
	const names = new Set<string>();
	for (const [index, entry] of record.modules.entries()) {
		const moduleLabel = `${label}.modules[${index}]`;
		const module = assertRecord(entry, moduleLabel);
		const name = assertRelativePath(module.name, `${moduleLabel}.name`);
		if (names.has(name)) throw new ValidationError(`${label}.modules lists ${name} twice`);
		names.add(name);
		const type = module.type;
		if (typeof type !== 'string' || !(FUNCTION_MODULE_TYPES as readonly string[]).includes(type))
			throw new ValidationError(`${moduleLabel}.type must be one of ${FUNCTION_MODULE_TYPES.join(', ')}`);
		modules.push({ name, type: type as FunctionModuleType, sha256: assertSha256(module.sha256, `${moduleLabel}.sha256`) });
	}
	if (!names.has(main))
		throw new ValidationError(`${label}.main must name one of the modules (${main})`);

	const compatibilityDate = assertString(record.compatibilityDate, `${label}.compatibilityDate`, {
		max: 10,
	});
	if (!COMPATIBILITY_DATE_PATTERN.test(compatibilityDate))
		throw new ValidationError(`${label}.compatibilityDate must match YYYY-MM-DD`);

	const rawFlags = record.compatibilityFlags === undefined ? [] : record.compatibilityFlags;
	if (!Array.isArray(rawFlags) || rawFlags.length > MAX_FUNCTION_FLAGS)
		throw new ValidationError(`${label}.compatibilityFlags must be an array of at most ${MAX_FUNCTION_FLAGS} flags`);
	const compatibilityFlags = rawFlags.map((flag, index) => {
		const flagLabel = `${label}.compatibilityFlags[${index}]`;
		const text = assertString(flag, flagLabel, { max: 64 });
		if (!COMPATIBILITY_FLAG_PATTERN.test(text))
			throw new ValidationError(`${flagLabel} must match ${COMPATIBILITY_FLAG_PATTERN}`);
		return text;
	});

	const rawBindings = record.bindings === undefined ? [] : record.bindings;
	if (!Array.isArray(rawBindings) || rawBindings.length > MAX_FUNCTION_BINDINGS)
		throw new ValidationError(`${label}.bindings must be an array of at most ${MAX_FUNCTION_BINDINGS} bindings`);
	const bindings: WorkloadFunctionBinding[] = [];
	const bindingNames = new Set<string>();
	for (const [index, entry] of rawBindings.entries()) {
		const bindingLabel = `${label}.bindings[${index}]`;
		const binding = assertRecord(entry, bindingLabel);
		// The binding name must be a JavaScript identifier and an environment variable name.
		const name = assertEnvName(binding.name, `${bindingLabel}.name`);
		if (name.length > 64) throw new ValidationError(`${bindingLabel}.name must be at most 64 characters`);
		if (bindingNames.has(name)) throw new ValidationError(`${label}.bindings lists ${name} twice`);
		bindingNames.add(name);
		const type = binding.type;
		if (typeof type !== 'string' || !(FUNCTION_BINDING_TYPES as readonly string[]).includes(type))
			throw new ValidationError(`${bindingLabel}.type must be one of ${FUNCTION_BINDING_TYPES.join(', ')}`);
		// A `secret` binding may name another environment variable. Everything else on the
		// binding (values, upstreams, project slugs) is resolved by the agent and ignored here.
		if (binding.secret !== undefined) assertEnvName(binding.secret, `${bindingLabel}.secret`);
		const parsed: WorkloadFunctionBinding = { name, type: type as FunctionBindingType };
		switch (parsed.type) {
			case 'durable_object':
				// Only the identity of the namespace travels to the unit; values never do.
				parsed.className = assertString(binding.className, `${bindingLabel}.className`, { max: 128 });
				parsed.uniqueKey = assertFunctionKey(binding.uniqueKey, `${bindingLabel}.uniqueKey`);
				break;
			case 'hyperdrive':
			case 'r2':
				parsed.envPrefix = assertFunctionEnvPrefix(binding.envPrefix, `${bindingLabel}.envPrefix`);
				break;
			case 'kv':
			case 'd1':
				parsed.namespaceId = assertFunctionKey(binding.namespaceId, `${bindingLabel}.namespaceId`);
				break;
			case 'queue':
				// D112: queues live on a managed broker; only the attachment prefix reaches the unit.
				// A pre-D112 spec has none, and the agent refuses to render it before it gets here.
				if (binding.envPrefix !== undefined)
					parsed.envPrefix = assertFunctionEnvPrefix(binding.envPrefix, `${bindingLabel}.envPrefix`);
				break;
			default:
				break;
		}
		bindings.push(parsed);
	}

	if (record.triggers !== undefined && (typeof record.triggers !== 'object' || record.triggers === null || Array.isArray(record.triggers)))
		throw new ValidationError(`${label}.triggers must be an object`);
	const triggers = record.triggers === undefined ? {} : (record.triggers as Record<string, unknown>);
	const rawCrons = triggers.crons === undefined ? [] : triggers.crons;
	if (!Array.isArray(rawCrons) || rawCrons.length > MAX_FUNCTION_CRONS)
		throw new ValidationError(`${label}.triggers.crons must be an array of at most ${MAX_FUNCTION_CRONS} entries`);
	const crons = rawCrons.map((cron, index) =>
		assertString(cron, `${label}.triggers.crons[${index}]`, { max: 120 }),
	);

	let assets: WorkloadFunction['assets'] = null;
	if (record.assets !== undefined && record.assets !== null) {
		const assetsRecord = assertRecord(record.assets, `${label}.assets`);
		// `assertRelativePath` refuses '', absolute paths, `..` and empty segments.
		const directory = assertRelativePath(assetsRecord.directory, `${label}.assets.directory`);
		const rawGlobs = assetsRecord.runWorkerFirst === undefined ? [] : assetsRecord.runWorkerFirst;
		if (!Array.isArray(rawGlobs) || rawGlobs.length > MAX_FUNCTION_ASSET_GLOBS)
			throw new ValidationError(
				`${label}.assets.runWorkerFirst must be an array of at most ${MAX_FUNCTION_ASSET_GLOBS} globs`,
			);
		const runWorkerFirst = rawGlobs.map((glob, index) => {
			const globLabel = `${label}.assets.runWorkerFirst[${index}]`;
			const text = assertString(glob, globLabel, { min: 0, max: 256 });
			if (CONTROL_CHARACTER_PATTERN.test(text))
				throw new ValidationError(`${globLabel} must not contain control characters`);
			return text;
		});
		assets = { directory, runWorkerFirst };
	}

	const idleStopSeconds =
		record.idleStopSeconds === undefined
			? 300
			: assertInteger(record.idleStopSeconds, `${label}.idleStopSeconds`, 0, 86_400);

	const workerdVersion = assertString(record.workerdVersion, `${label}.workerdVersion`, { max: 64 });
	if (!WORKERD_VERSION_PATTERN.test(workerdVersion))
		throw new ValidationError(`${label}.workerdVersion must match <major>.<minor>.<patch>`);

	return {
		main,
		modules,
		compatibilityDate,
		compatibilityFlags,
		bindings,
		triggers: { crons },
		assets,
		idleStopSeconds,
		workerdVersion,
	};
}

/** Validate the fixed workload half of `POST /v1/workloads`. */
export function parseWorkload(value: unknown): WorkloadDesired {
	const record = assertRecord(value, 'workload');
	const runtime = record.runtime as WorkloadRuntime;
	if (!(WORKLOAD_RUNTIMES as readonly string[]).includes(runtime))
		throw new ValidationError(
			`workload.runtime must be one of ${WORKLOAD_RUNTIMES.map((entry) => `"${entry}"`).join(', ')}`,
		);
	if (runtime !== 'function' && record.function !== undefined)
		throw new ValidationError('Only function workloads may set workload.function');
	const status = record.status ?? 'pending';
	if (!WORKLOAD_STATUSES.includes(status as WorkloadStatus))
		throw new ValidationError(`workload.status must be one of ${WORKLOAD_STATUSES.join(', ')}`);

	const release = record.release === null || record.release === undefined
		? null
		: assertSha256(record.release, 'workload.release');
	const command = record.command === undefined ? undefined : assertCommand(record.command, 'workload.command');
	const image = record.image === undefined ? undefined : assertImage(record.image, 'workload.image');

	if (runtime === 'process') {
		if (image) throw new ValidationError('Process workloads cannot set an image');
		if (!release)
			throw new ValidationError('Process workloads need a release (release must be a SHA-256)');
	}
	if (runtime === 'container') {
		if (command) throw new ValidationError('Container workloads cannot set a command');
		if (!image)
			throw new ValidationError(
				'Container workloads need an image; the control plane must include workload.image',
			);
	}
	let workloadFunction: WorkloadFunction | undefined;
	if (runtime === 'function') {
		if (!release)
			throw new ValidationError('Function workloads need a release (release must be a SHA-256)');
		if (record.function === undefined)
			throw new ValidationError('Function workloads need workload.function');
		workloadFunction = parseWorkloadFunction(record.function);
		if (record.socketActivation !== true)
			throw new ValidationError('Function workloads must use socket activation');
		// Functions are HTTP-only and run the pinned binary, never an image or a command.
		if (record.ingress !== undefined)
			throw new ValidationError('Function workloads must have HTTP ingress; workload.ingress must be omitted');
		for (const key of ['image', 'command', 'database', 'objectStorage', 'broker', 'runner', 'pooler', 'volumeId'] as const) {
			if (record[key] !== undefined)
				throw new ValidationError(`Function workloads cannot set workload.${key}`);
		}
		if (record.dataSizeMb !== undefined && record.dataSizeMb !== null)
			throw new ValidationError('Function workloads cannot keep a data directory');
		if (record.volumes !== undefined)
			throw new ValidationError('Function workloads cannot mount app volumes');
	}

	const database = record.database === undefined ? undefined : parseDatabase(record.database);
	const objectStorage =
		record.objectStorage === undefined ? undefined : parseObjectStorage(record.objectStorage);
	if (database && objectStorage)
		throw new ValidationError('A workload cannot have both a database and an objectStorage profile');
	const broker = record.broker === undefined ? undefined : parseBroker(record.broker);
	if (broker && (database || objectStorage))
		throw new ValidationError('A workload cannot have a broker profile together with another managed profile');
	const id = assertId(record.id, 'workload.id');
	const orgId = record.orgId === undefined ? undefined : assertId(record.orgId, 'workload.orgId');
	const networkName =
		record.networkName === undefined ? undefined : assertNetworkName(record.networkName, 'workload.networkName');
	if (orgId && networkName && networkName !== orgNetworkName(orgId))
		throw new ValidationError('workload.networkName must match the network derived from workload.orgId');
	const secrets = parseSecrets(record.secrets);
	if (objectStorage) {
		if (runtime !== 'container') throw new ValidationError('Storage workloads must use the container runtime');
		const tag = STORAGE_ENGINES[objectStorage.engine].tag(objectStorage.version);
		const pinned = storageImage(objectStorage);
		if (image !== tag && image !== pinned)
			throw new ValidationError(`workload.image must be ${tag} for ${objectStorage.engine} ${objectStorage.version}`);
		assertStorageId(id, 'workload.id');
		if (secrets.some((secret) => secret.delivery === 'file'))
			throw new ValidationError('Storage workloads cannot mount file secrets');
	} else if (id.startsWith(STORAGE_ID_PREFIX)) {
		throw new ValidationError(`workload.id prefix "${STORAGE_ID_PREFIX}" is reserved for object storage`);
	}
	if (database) {
		if (runtime !== 'container') throw new ValidationError('Database workloads must use the container runtime');
		const expected = databaseImage(database);
		if (image !== expected)
			throw new ValidationError(`workload.image must be ${expected} for ${database.engine} ${database.version}`);
		assertDatabaseId(id, 'workload.id');
		if (secrets.some((secret) => secret.delivery === 'file'))
			throw new ValidationError('Database workloads cannot mount file secrets');
	} else if (id.startsWith(DATABASE_ID_PREFIX)) {
		throw new ValidationError(`workload.id prefix "${DATABASE_ID_PREFIX}" is reserved for databases`);
	}
	if (broker) {
		if (runtime !== 'container') throw new ValidationError('Broker workloads must use the container runtime');
		const expected = brokerImage(broker);
		if (image !== expected)
			throw new ValidationError(`workload.image must be ${expected} for ${broker.engine} ${broker.version}`);
		assertBrokerId(id, 'workload.id');
		if (secrets.some((secret) => secret.delivery === 'file'))
			throw new ValidationError('Broker workloads cannot mount file secrets');
	} else if (id.startsWith(BROKER_ID_PREFIX)) {
		throw new ValidationError(`workload.id prefix "${BROKER_ID_PREFIX}" is reserved for queue brokers`);
	}

	const dataSizeMb =
		record.dataSizeMb === null || record.dataSizeMb === undefined
			? null
			: assertInteger(record.dataSizeMb, 'workload.dataSizeMb', 32, 65_536);

	const workload: WorkloadDesired = {
		id,
		...(orgId ? { orgId } : {}),
		...(networkName ? { networkName } : {}),
		projectId: assertId(record.projectId, 'workload.projectId'),
		projectSlug: assertSlug(record.projectSlug, 'workload.projectSlug'),
		deploymentId: assertId(record.deploymentId, 'workload.deploymentId'),
		runtime,
		status: status as WorkloadStatus,
		release,
		upstream: assertString(record.upstream, 'workload.upstream', { max: 1024 }),
		memoryMb: assertMemoryMb(record.memoryMb, 'workload.memoryMb'),
		cpus: assertCpus(record.cpus, 'workload.cpus'),
		port: assertPort(record.port, 'workload.port'),
		healthPath: assertHealthPath(record.healthPath, 'workload.healthPath'),
		socketActivation: record.socketActivation === true,
		activationVersion: assertSha256(record.activationVersion, 'workload.activationVersion'),
		env: parseEnvRecord(record.env, 'workload.env'),
		secrets,
		dataSizeMb,
	};
	if (command) workload.command = command;
	if (image) workload.image = image;
	if (workloadFunction) workload.function = workloadFunction;
	if (database) workload.database = database;
	if (record.pooler !== undefined) {
		if (!database) throw new ValidationError('workload.pooler is only valid for a database workload');
		if (database.engine !== 'postgres')
			throw new ValidationError('workload.pooler is only valid for a postgres database');
		const pooler = assertRecord(record.pooler, 'workload.pooler');
		workload.pooler = { port: assertPort(pooler.port, 'workload.pooler.port') };
	}
	if (objectStorage) workload.objectStorage = objectStorage;
	if (broker) workload.broker = broker;
	if (record.ingress !== undefined) {
		if (record.ingress !== 'none') throw new ValidationError('workload.ingress must be "none" when present');
		if (database || objectStorage || broker) throw new ValidationError('Managed services cannot be workers');
		workload.ingress = 'none';
	}
	if (record.runner !== undefined) {
		const runner = assertRecord(record.runner, 'workload.runner');
		if (runner.provider !== 'github') throw new ValidationError('workload.runner.provider must be "github"');
		if (runtime !== 'container') throw new ValidationError('Runner workloads must use the container runtime');
		if (workload.ingress !== 'none') throw new ValidationError('Runner workloads must be workers (ingress "none")');
		if (dataSizeMb !== null) throw new ValidationError('Runner workloads cannot keep a data directory');
		workload.runner = { provider: 'github' };
	}
	const volumes = parseWorkloadVolumes(record.volumes);
	if (volumes.length > 0) workload.volumes = volumes;
	const volumeId = record.volumeId === undefined ? undefined : assertId(record.volumeId, 'workload.volumeId');
	if (volumeId) {
		// Volumes hold managed-service data (D74); an app workload never mounts one.
		if (!database && !objectStorage && !broker)
			throw new ValidationError('workload.volumeId is only valid for a database, objectStorage or broker workload');
		workload.volumeId = volumeId;
	}
	return workload;
}

/** Validate and normalize `activation` in the same request. */
export function parseActivation(value: unknown, workload?: WorkloadDesired): WorkloadActivation {
	const record = assertRecord(value, 'activation');
	const workloadId = assertId(record.workloadId, 'activation.workloadId');
	const activationVersion = assertSha256(record.activationVersion, 'activation.activationVersion');
	if (workload) {
		if (workloadId !== workload.id)
			throw new ValidationError('activation.workloadId does not match workload.id');
		if (activationVersion !== workload.activationVersion)
			throw new ValidationError('activation.activationVersion does not match the desired workload');
	}

	const env = parseEnvRecord(record.env, 'activation.env');
	const rawFiles = record.files === undefined ? {} : assertRecord(record.files, 'activation.files');
	const files: Record<string, string> = {};
	let total = 0;
	for (const [rawName, rawValue] of Object.entries(rawFiles)) {
		const name = assertSecretName(rawName, 'activation.files name');
		const value = assertString(rawValue, `activation.files.${name}`, { max: MAX_SECRET_BYTES });
		total += Buffer.byteLength(value);
		if (total > MAX_ACTIVATION_BYTES)
			throw new ValidationError(`activation files exceed ${MAX_ACTIVATION_BYTES} bytes`);
		if (workload && !workload.secrets.some((secret) => secret.name === name && secret.delivery === 'file'))
			throw new ValidationError(`activation file ${name} is not a file secret of this workload`);
		files[name] = value;
	}

	return { workloadId, activationVersion, env, files };
}

/**
 * The agent-rendered workerd config, shim and optional binding-service modules. They are data, not
 * commands: bounded, UTF-8 text with no NUL byte, written by the helper under its own runtime
 * directory. The helper never parses the capnp. Since phase 2 the config may carry Hyperdrive
 * credentials (workerd has no `fromEnvironment` form for that binding), which is why it is written
 * as a 0600 systemd credential and never treated as a release artifact.
 */
export function parseFunctionFiles(value: unknown, label = 'request.function'): WorkloadFunctionFiles {
	const record = assertRecord(value, label);
	for (const key of Object.keys(record)) {
		if (key !== 'config' && key !== 'shim' && key !== 'files')
			throw new ValidationError(`${label}.${key} is not supported`);
	}
	const bounded = (raw: unknown, name: string, limit: number): string => {
		const text = assertString(raw, `${label}.${name}`, { max: limit });
		if (Buffer.byteLength(text) > limit)
			throw new ValidationError(`${label}.${name} must be at most ${limit} bytes`);
		return text;
	};
	const config = bounded(record.config, 'config', MAX_FUNCTION_CONFIG_BYTES);
	const shim = bounded(record.shim, 'shim', MAX_FUNCTION_SHIM_BYTES);
	if (record.files === undefined) return { config, shim };

	// Binding-service modules are written as systemd credentials. Each name is a credential name
	// (the capnp `embed` target), so it is lower-case, hyphenated and never one of the fixed two.
	const rawFiles = assertRecord(record.files, `${label}.files`);
	const names = Object.keys(rawFiles);
	if (names.length > MAX_FUNCTION_FILES)
		throw new ValidationError(`${label}.files must contain at most ${MAX_FUNCTION_FILES} files`);
	const files: WorkloadFunctionExtraFiles = {};
	let total = 0;
	for (const name of names) {
		if (!FUNCTION_FILE_NAME_PATTERN.test(name))
			throw new ValidationError(`${label}.files name "${name}" must match ${FUNCTION_FILE_NAME_PATTERN}`);
		if (RESERVED_FUNCTION_FILE_NAMES.has(name) || /^module-\d+$/.test(name))
			throw new ValidationError(`${label}.files name "${name}" is reserved`);
		const fileLabel = `${label}.files.${name}`;
		const text = assertString(rawFiles[name], fileLabel, { max: MAX_FUNCTION_FILE_BYTES });
		const bytes = Buffer.byteLength(text);
		if (bytes > MAX_FUNCTION_FILE_BYTES)
			throw new ValidationError(`${fileLabel} must be at most ${MAX_FUNCTION_FILE_BYTES} bytes`);
		total += bytes;
		if (total > MAX_FUNCTION_FILES_BYTES)
			throw new ValidationError(`${label}.files must total at most ${MAX_FUNCTION_FILES_BYTES} bytes`);
		files[name] = text;
	}
	return { config, shim, files };
}

export interface ParsedApplyRequest {
	workload: WorkloadDesired;
	activation: WorkloadActivation;
	/** Present iff the workload is a function. */
	function?: WorkloadFunctionFiles;
}

/** Parse the full helper apply body. */
export function parseApplyRequest(value: unknown): ParsedApplyRequest {
	const record = assertRecord(value, 'request');
	const workload = parseWorkload(record.workload);
	let functionFiles: WorkloadFunctionFiles | undefined;
	if (record.function !== undefined) {
		if (workload.runtime !== 'function')
			throw new ValidationError('request.function is only valid for a function workload');
		functionFiles = parseFunctionFiles(record.function);
	} else if (workload.runtime === 'function') {
		throw new ValidationError('Function workloads need request.function.config and request.function.shim');
	}
	const activation = parseActivation(record.activation, workload);
	return functionFiles ? { workload, activation, function: functionFiles } : { workload, activation };
}

/**
 * The studio verbs (`POST /v1/studio/start|stop`, plan 22) take nothing: the unit name is fixed in
 * the helper. Any query string or body, even `{}`, is refused rather than ignored.
 */
export function assertNoVerbInput(input: { search: string; body: string }): void {
	if (input.search !== '') throw new ValidationError('This verb takes no query parameters');
	if (input.body !== '') throw new ValidationError('This verb takes no request body');
}
