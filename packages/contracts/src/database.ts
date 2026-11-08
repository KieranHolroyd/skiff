import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import type { DatabaseBackupSummary } from './database-backup.ts';
import { storageTargetSchema, type DiskSummary } from './disk.ts';

/**
 * Managed databases (docs/DATABASES.md, D55–D61).
 *
 * A database is an org resource run as a tier-3 container on one node. This module is the engine
 * registry and the wire shapes shared by the control plane, agent and surfaces. It deliberately
 * imports nothing from `workload.ts` so `workload.ts` can reference the engine enum.
 */

export const databaseEngines = ['postgres', 'mysql', 'mariadb', 'mongodb', 'valkey', 'redis', 'clickhouse'] as const;
export type DatabaseEngine = (typeof databaseEngines)[number];

/** What kind of store an engine is; the dashboard groups engines by it. */
export type DatabaseEngineFamily = 'relational' | 'document' | 'key-value' | 'analytical';

/**
 * Platform features an engine supports (docs/DATABASES.md §17). Everything outside this list
 * (create, run, attach, credentials, logs, restart, delete/restore/purge, volumes) works for every
 * engine. A surface checks a capability before offering a feature; the service refuses the
 * request when it is off.
 */
export interface DatabaseEngineCapabilities {
	/** PgBouncer sidecar and `<PREFIX>_POOL_URL` (D85). */
	pooler: boolean;
	/** The extension allowlist (D84). */
	extensions: boolean;
	/** Helper-generated server certificate under `SKIFF_FEATURE_DB_TLS` (D85). */
	tls: boolean;
	/** WAL archiving and restore-to-time (docs/PITR.md). */
	pitr: boolean;
	/** Monitor role, per-minute metrics, the tables snapshot and slow queries (D57). */
	metrics: boolean;
	/** Logical backups and restore into a new database (D83). */
	backups: boolean;
	/** Owner password rotation (D86). The monitor role exists only where `metrics` is on. */
	rotation: boolean;
	/** Opt-in `app` / `readonly` / `backup` roles (plan 04b). */
	namedCredentials: boolean;
	/** The native database studio (D96). */
	console: boolean;
	/** The major-version upgrade planner (`skif db upgrade`). */
	upgradePlan: boolean;
	/** C7 replication mode; absent means none. */
	replication?: 'streaming' | 'native-cluster';
}

export interface DatabaseEngineInfo {
	engine: DatabaseEngine;
	label: string;
	family: DatabaseEngineFamily;
	/** One line for the create form. */
	description: string;
	/** Newest first. */
	versions: readonly string[];
	defaultVersion: string;
	/** Port inside the container. */
	containerPort: number;
	/** URL scheme for `<PREFIX>_URL`. */
	scheme: string;
	/**
	 * Path segment of the connection URL: `name` uses the database name, anything else is used
	 * verbatim (Valkey/Redis select logical database `0`). ClickHouse clients read the URL path as
	 * the default database.
	 */
	urlDatabase: 'name' | string;
	/** Query string every connection URL carries (MongoDB authenticates against `admin`). */
	urlQuery: string | null;
	/** Env prefix an attachment gets when none is given (`REDIS` → `REDIS_URL`). */
	defaultEnvPrefix: string;
	minMemoryMb: number;
	defaultMemoryMb: number;
	/** Longest database name the engine's user/database identifiers allow. */
	maxNameLength: number;
	/** Names that collide with the engine's own users or databases. */
	reservedNames: readonly string[];
	/**
	 * Env names the control plane uses for the owner credentials in the container env file. The
	 * helper reads the same names back for its fixed verbs and adds the engine's fixed settings.
	 */
	containerEnv: { user: string; password: string; database: string | null };
	/**
	 * Version changes a plain update may make. `forward`: move to a newer listed version in place
	 * (the image upgrades the data dir on start). `never`: refuse; Postgres goes through the
	 * upgrade planner and MongoDB needs feature-compatibility steps, so both use backup + restore.
	 */
	inPlaceUpgrade: 'forward' | 'never';
	capabilities: DatabaseEngineCapabilities;
}

const ALL_CAPABILITIES: DatabaseEngineCapabilities = {
	replication: 'streaming',
	pooler: true,
	extensions: true,
	tls: true,
	pitr: true,
	metrics: true,
	backups: true,
	rotation: true,
	namedCredentials: true,
	console: true,
	upgradePlan: true,
};

/** Engines other than Postgres: core lifecycle, owner rotation and the studio. */
const CORE_CAPABILITIES: DatabaseEngineCapabilities = {
	pooler: false,
	extensions: false,
	tls: false,
	pitr: false,
	metrics: false,
	backups: false,
	rotation: true,
	namedCredentials: false,
	console: true,
	upgradePlan: false,
};

/**
 * The registry (D61, D95). The helper keeps its own copy of the image/user mapping on purpose.
 * Engines and versions are chosen from the most-used self-hostable databases (Stack Overflow
 * 2025, DB-Engines 2026); every image is the vendor's official one.
 */
export const databaseEngineRegistry: Record<DatabaseEngine, DatabaseEngineInfo> = {
	postgres: {
		engine: 'postgres',
		label: 'PostgreSQL',
		family: 'relational',
		description: 'The default. Extensions, pooling, PITR and full metrics.',
		versions: ['18', '17', '16'],
		defaultVersion: '17',
		containerPort: 5432,
		scheme: 'postgres',
		urlDatabase: 'name',
		urlQuery: null,
		defaultEnvPrefix: 'DATABASE',
		minMemoryMb: 128,
		defaultMemoryMb: 256,
		maxNameLength: 40,
		reservedNames: ['postgres', 'template0', 'template1', 'skiff-studio-ro'],
		containerEnv: { user: 'POSTGRES_USER', password: 'POSTGRES_PASSWORD', database: 'POSTGRES_DB' },
		inPlaceUpgrade: 'never',
		capabilities: ALL_CAPABILITIES,
	},
	mysql: {
		engine: 'mysql',
		label: 'MySQL',
		family: 'relational',
		description: 'Oracle MySQL Community Server (LTS releases).',
		versions: ['9.7', '8.4'],
		defaultVersion: '8.4',
		containerPort: 3306,
		scheme: 'mysql',
		urlDatabase: 'name',
		urlQuery: null,
		defaultEnvPrefix: 'DATABASE',
		minMemoryMb: 384,
		defaultMemoryMb: 512,
		// MySQL user names are at most 32 characters.
		maxNameLength: 32,
		reservedNames: ['root', 'mysql', 'sys', 'information-schema', 'performance-schema', 'skiff-studio-ro'],
		containerEnv: { user: 'MYSQL_USER', password: 'MYSQL_PASSWORD', database: 'MYSQL_DATABASE' },
		inPlaceUpgrade: 'forward',
		capabilities: { ...CORE_CAPABILITIES, backups: true, replication: 'streaming' },
	},
	mariadb: {
		engine: 'mariadb',
		label: 'MariaDB',
		family: 'relational',
		description: 'MySQL-compatible, community-developed (LTS releases).',
		versions: ['11.8', '11.4'],
		defaultVersion: '11.8',
		containerPort: 3306,
		scheme: 'mysql',
		urlDatabase: 'name',
		urlQuery: null,
		defaultEnvPrefix: 'DATABASE',
		minMemoryMb: 192,
		defaultMemoryMb: 256,
		maxNameLength: 40,
		reservedNames: ['root', 'mysql', 'sys', 'healthcheck', 'information-schema', 'performance-schema', 'skiff-studio-ro'],
		containerEnv: { user: 'MARIADB_USER', password: 'MARIADB_PASSWORD', database: 'MARIADB_DATABASE' },
		inPlaceUpgrade: 'forward',
		capabilities: { ...CORE_CAPABILITIES, backups: true, replication: 'streaming' },
	},
	mongodb: {
		engine: 'mongodb',
		label: 'MongoDB',
		family: 'document',
		description: 'Document database (MongoDB Community Server).',
		versions: ['9.0', '8.0'],
		defaultVersion: '8.0',
		containerPort: 27017,
		scheme: 'mongodb',
		urlDatabase: 'name',
		// The owner is created in `admin` by the image's init; drivers must authenticate there.
		urlQuery: 'authSource=admin',
		defaultEnvPrefix: 'MONGODB',
		minMemoryMb: 256,
		defaultMemoryMb: 512,
		maxNameLength: 40,
		reservedNames: ['admin', 'local', 'config', 'skiff-studio-ro'],
		containerEnv: {
			user: 'MONGO_INITDB_ROOT_USERNAME',
			password: 'MONGO_INITDB_ROOT_PASSWORD',
			database: 'MONGO_INITDB_DATABASE',
		},
		inPlaceUpgrade: 'never',
		capabilities: { ...CORE_CAPABILITIES, backups: true, replication: 'native-cluster' },
	},
	valkey: {
		engine: 'valkey',
		label: 'Valkey',
		family: 'key-value',
		description: 'Open-source (BSD) Redis fork from the Linux Foundation. Redis-protocol compatible.',
		versions: ['9.1', '8.1'],
		defaultVersion: '9.1',
		containerPort: 6379,
		scheme: 'redis',
		urlDatabase: '0',
		urlQuery: null,
		defaultEnvPrefix: 'REDIS',
		minMemoryMb: 128,
		defaultMemoryMb: 256,
		maxNameLength: 40,
		reservedNames: ['default', 'skiff-studio-ro'],
		containerEnv: { user: 'VALKEY_USER', password: 'VALKEY_PASSWORD', database: null },
		inPlaceUpgrade: 'forward',
		capabilities: { ...CORE_CAPABILITIES, backups: true, replication: 'streaming' },
	},
	redis: {
		engine: 'redis',
		label: 'Redis',
		family: 'key-value',
		description: 'Redis Open Source 8 (AGPLv3). Prefer Valkey unless you need Redis-only modules.',
		versions: ['8.10', '8.8'],
		defaultVersion: '8.10',
		containerPort: 6379,
		scheme: 'redis',
		urlDatabase: '0',
		urlQuery: null,
		defaultEnvPrefix: 'REDIS',
		minMemoryMb: 128,
		defaultMemoryMb: 256,
		maxNameLength: 40,
		reservedNames: ['default', 'skiff-studio-ro'],
		containerEnv: { user: 'REDIS_USER', password: 'REDIS_PASSWORD', database: null },
		inPlaceUpgrade: 'forward',
		capabilities: { ...CORE_CAPABILITIES, backups: true, replication: 'streaming' },
	},
	clickhouse: {
		engine: 'clickhouse',
		label: 'ClickHouse',
		family: 'analytical',
		description: 'Column-oriented OLAP database for events, logs and analytics (LTS releases).',
		versions: ['26.8', '26.3'],
		defaultVersion: '26.8',
		// The HTTP interface: what @clickhouse/client, clickhouse-connect and most tools speak, and
		// the one whose URL every client parses. Native TCP (9000) is reachable on the org network only.
		containerPort: 8123,
		scheme: 'http',
		urlDatabase: 'name',
		urlQuery: null,
		defaultEnvPrefix: 'CLICKHOUSE',
		// The server's own caches and merge buffers need headroom; below 1 GB it OOMs under merges.
		minMemoryMb: 1024,
		defaultMemoryMb: 2048,
		maxNameLength: 40,
		reservedNames: ['default', 'system', 'information-schema', 'skiff-studio-ro'],
		containerEnv: { user: 'CLICKHOUSE_USER', password: 'CLICKHOUSE_PASSWORD', database: 'CLICKHOUSE_DB' },
		// A newer LTS reads the previous LTS's data dir in place; downgrades are refused.
		inPlaceUpgrade: 'forward',
		// Core lifecycle, live owner rotation and native BACKUP/RESTORE backups. No studio plugin yet.
		capabilities: { ...CORE_CAPABILITIES, backups: true, console: false },
	},
};

/** Capabilities of an engine; unknown engines (old rows, future data) get none. */
export function databaseCapabilities(engine: string): DatabaseEngineCapabilities {
	const info = (databaseEngineRegistry as Record<string, DatabaseEngineInfo | undefined>)[engine];
	return info?.capabilities ?? { ...CORE_CAPABILITIES, rotation: false, console: false };
}

/**
 * The image variant a database is created on (D126). `standard` is the engine's own image for
 * the version. `postgis` and `pg_cron` are Skiff-built Postgres images layered on the pinned
 * pgvector image, so each keeps pgvector and adds one extension. Variants do not combine, and a
 * database keeps its variant for life: restores copy it and there is no in-place switch.
 */
export const databaseVariants = ['standard', 'postgis', 'pg_cron'] as const;
export type DatabaseVariant = (typeof databaseVariants)[number];

export interface DatabaseVariantInfo {
	variant: DatabaseVariant;
	label: string;
	/** One line for the create form. */
	description: string;
	/** Postgres versions with an image for this variant; `null` means every engine and version. */
	postgresVersions: readonly string[] | null;
	/** The extension the image adds; created on first start and refused on other variants. */
	extension: 'postgis' | 'pg_cron' | null;
}

export const databaseVariantRegistry: Record<DatabaseVariant, DatabaseVariantInfo> = {
	standard: {
		variant: 'standard',
		label: 'Standard',
		description: 'The engine image. Postgres 18 includes pgvector.',
		postgresVersions: null,
		extension: null,
	},
	postgis: {
		variant: 'postgis',
		label: 'PostGIS',
		description: 'Postgres 18 with PostGIS 3 (and pgvector) for geospatial data.',
		postgresVersions: ['18'],
		extension: 'postgis',
	},
	pg_cron: {
		variant: 'pg_cron',
		label: 'pg_cron',
		description: 'Postgres 18 with pg_cron (and pgvector) for scheduled SQL jobs.',
		postgresVersions: ['18'],
		extension: 'pg_cron',
	},
};

/** Whether an engine version has an image for the variant. */
export function databaseVariantSupported(engine: DatabaseEngine, version: string, variant: DatabaseVariant): boolean {
	const versions = databaseVariantRegistry[variant].postgresVersions;
	if (versions === null) return true;
	return engine === 'postgres' && versions.includes(version);
}

/** Variants offered for an engine version, `standard` first. */
export function databaseVariantsFor(engine: DatabaseEngine, version: string): DatabaseVariant[] {
	return databaseVariants.filter((variant) => databaseVariantSupported(engine, version, variant));
}

/**
 * Why a set of extensions does not fit a variant, or null. `postgis` and `pg_cron` ship only in
 * their own variant's image, so asking for them elsewhere is refused instead of failing softly.
 */
export function databaseVariantExtensionError(variant: DatabaseVariant, extensions: readonly string[]): string | null {
	for (const info of Object.values(databaseVariantRegistry)) {
		if (!info.extension || info.variant === variant || !extensions.includes(info.extension)) continue;
		return `The ${info.extension} extension ships only in the ${info.label} variant (variant "${info.variant}", Postgres ${info.postgresVersions?.join(', ')}), chosen when the database is created.`;
	}
	return null;
}

/**
 * Extensions Skiff can enable on a managed Postgres database (D84). The helper preloads
 * `pg_stat_statements`; the rest are created idempotently by the agent after the monitor role is
 * bootstrapped. Extensions that are not shipped by the pinned official image fail softly (they
 * are reported in the log, not treated as a database failure).
 *
 * The list is the contrib set shipped by `postgres:{16,17}-alpine`, minus anything that reaches
 * outside the container or can destroy data on its own: `dblink`, `postgres_fdw`, `file_fdw`,
 * `adminpack`, the procedural languages (the Alpine image ships `plperl`/`pltcl` control files but
 * not the Perl/Tcl runtimes, and the untrusted variants can escape the database), `pg_surgery`,
 * plus the deprecated `xml2`, `intagg` and `old_snapshot`. Adding one is a contract change and an
 * image check: `CREATE EXTENSION` must succeed on every supported version.
 */
export const databaseExtensionAllowlist = [
	// Observability
	'pg_stat_statements',
	'pg_buffercache',
	'pgstattuple',
	'pgrowlocks',
	'pg_freespacemap',
	'pg_visibility',
	'pg_walinspect',
	'pageinspect',
	'amcheck',
	'pg_prewarm',
	'sslinfo',
	// Text search
	'pg_trgm',
	'unaccent',
	'fuzzystrmatch',
	'dict_int',
	'dict_xsyn',
	// Data types
	'citext',
	'hstore',
	'ltree',
	'isn',
	'cube',
	'seg',
	'lo',
	// Indexing
	'btree_gin',
	'btree_gist',
	'bloom',
	// Functions
	'pgcrypto',
	'uuid-ossp',
	'tablefunc',
	'intarray',
	'earthdistance',
	'tsm_system_rows',
	'tsm_system_time',
	// Triggers
	'moddatetime',
	'autoinc',
	'insert_username',
	'refint',
	'tcn',
	// Not in the stock image
	'pg_cron',
	'pgvector',
	'postgis',
] as const;
export type DatabaseExtension = (typeof databaseExtensionAllowlist)[number];
export const databaseExtensionSchema = z.enum(databaseExtensionAllowlist);

export const databaseExtensionCategories = [
	'observability',
	'search',
	'types',
	'indexing',
	'functions',
	'triggers',
	'external',
] as const;
export type DatabaseExtensionCategory = (typeof databaseExtensionCategories)[number];

export const databaseExtensionCategoryLabels: Record<DatabaseExtensionCategory, string> = {
	observability: 'Observability',
	search: 'Text search',
	types: 'Data types',
	indexing: 'Indexing',
	functions: 'Functions',
	triggers: 'Triggers',
	external: 'Needs a custom image',
};

export interface DatabaseExtensionInfo {
	/** The name passed to `CREATE EXTENSION` (differs from the allowlist key for `pgvector`). */
	sqlName: string;
	category: DatabaseExtensionCategory;
	description: string;
	/** Shipped by the pinned `postgres:*-alpine` image; others are skipped with a node warning. */
	bundled: boolean;
}

/** One entry per allowlisted extension; the `Record` type keeps the two in step. */
export const databaseExtensionCatalog: Record<DatabaseExtension, DatabaseExtensionInfo> = {
	pg_stat_statements: {
		sqlName: 'pg_stat_statements',
		category: 'observability',
		description: 'Planning and execution stats for every statement; powers the slow-query panel.',
		bundled: true,
	},
	pg_buffercache: {
		sqlName: 'pg_buffercache',
		category: 'observability',
		description: 'Inspect what is in the shared buffer cache.',
		bundled: true,
	},
	pgstattuple: {
		sqlName: 'pgstattuple',
		category: 'observability',
		description: 'Tuple-level statistics: bloat, dead tuples and free space per table or index.',
		bundled: true,
	},
	pgrowlocks: {
		sqlName: 'pgrowlocks',
		category: 'observability',
		description: 'Show row-level locking information for a table.',
		bundled: true,
	},
	pg_freespacemap: {
		sqlName: 'pg_freespacemap',
		category: 'observability',
		description: 'Examine the free space map of a relation.',
		bundled: true,
	},
	pg_visibility: {
		sqlName: 'pg_visibility',
		category: 'observability',
		description: 'Examine the visibility map and page-level visibility info.',
		bundled: true,
	},
	pg_walinspect: {
		sqlName: 'pg_walinspect',
		category: 'observability',
		description: 'Inspect the contents of the write-ahead log.',
		bundled: true,
	},
	pageinspect: {
		sqlName: 'pageinspect',
		category: 'observability',
		description: 'Read raw page contents for low-level debugging.',
		bundled: true,
	},
	amcheck: {
		sqlName: 'amcheck',
		category: 'observability',
		description: 'Verify the logical consistency of tables and B-tree indexes.',
		bundled: true,
	},
	pg_prewarm: {
		sqlName: 'pg_prewarm',
		category: 'observability',
		description: 'Load relation data into the buffer cache ahead of traffic.',
		bundled: true,
	},
	sslinfo: {
		sqlName: 'sslinfo',
		category: 'observability',
		description: 'Information about the current client TLS connection.',
		bundled: true,
	},
	pg_trgm: {
		sqlName: 'pg_trgm',
		category: 'search',
		description: 'Trigram similarity and GIN/GiST indexes for fast LIKE/ILIKE and fuzzy search.',
		bundled: true,
	},
	unaccent: {
		sqlName: 'unaccent',
		category: 'search',
		description: 'Text search dictionary that strips accents.',
		bundled: true,
	},
	fuzzystrmatch: {
		sqlName: 'fuzzystrmatch',
		category: 'search',
		description: 'Levenshtein distance, Soundex and Metaphone string matching.',
		bundled: true,
	},
	dict_int: {
		sqlName: 'dict_int',
		category: 'search',
		description: 'Text search dictionary template for integers.',
		bundled: true,
	},
	dict_xsyn: {
		sqlName: 'dict_xsyn',
		category: 'search',
		description: 'Text search dictionary for extended synonym processing.',
		bundled: true,
	},
	citext: {
		sqlName: 'citext',
		category: 'types',
		description: 'Case-insensitive text type; handy for emails and usernames.',
		bundled: true,
	},
	hstore: {
		sqlName: 'hstore',
		category: 'types',
		description: 'Key/value pairs in a single column.',
		bundled: true,
	},
	ltree: {
		sqlName: 'ltree',
		category: 'types',
		description: 'Hierarchical tree-like labels (materialized paths) with indexed queries.',
		bundled: true,
	},
	isn: {
		sqlName: 'isn',
		category: 'types',
		description: 'Types for ISBN, ISSN, EAN13, UPC and other product numbers.',
		bundled: true,
	},
	cube: {
		sqlName: 'cube',
		category: 'types',
		description: 'Multi-dimensional cubes and points.',
		bundled: true,
	},
	seg: {
		sqlName: 'seg',
		category: 'types',
		description: 'Line segments and floating-point intervals.',
		bundled: true,
	},
	lo: {
		sqlName: 'lo',
		category: 'types',
		description: 'Large object maintenance helpers.',
		bundled: true,
	},
	btree_gin: {
		sqlName: 'btree_gin',
		category: 'indexing',
		description: 'GIN operator classes for B-tree types, for multi-column GIN indexes.',
		bundled: true,
	},
	btree_gist: {
		sqlName: 'btree_gist',
		category: 'indexing',
		description: 'GiST operator classes for B-tree types; enables exclusion constraints on scalars.',
		bundled: true,
	},
	bloom: {
		sqlName: 'bloom',
		category: 'indexing',
		description: 'Bloom filter index access method.',
		bundled: true,
	},
	pgcrypto: {
		sqlName: 'pgcrypto',
		category: 'functions',
		description: 'Hashing, encryption and random bytes.',
		bundled: true,
	},
	'uuid-ossp': {
		sqlName: 'uuid-ossp',
		category: 'functions',
		description: 'UUID generators (v1, v3, v4, v5).',
		bundled: true,
	},
	tablefunc: {
		sqlName: 'tablefunc',
		category: 'functions',
		description: 'crosstab() pivots, connectby() and normal_rand().',
		bundled: true,
	},
	intarray: {
		sqlName: 'intarray',
		category: 'functions',
		description: 'Functions, operators and indexes for integer arrays.',
		bundled: true,
	},
	earthdistance: {
		sqlName: 'earthdistance',
		category: 'functions',
		description: 'Great-circle distances on the Earth (installs cube).',
		bundled: true,
	},
	tsm_system_rows: {
		sqlName: 'tsm_system_rows',
		category: 'functions',
		description: 'TABLESAMPLE method that takes a fixed number of rows.',
		bundled: true,
	},
	tsm_system_time: {
		sqlName: 'tsm_system_time',
		category: 'functions',
		description: 'TABLESAMPLE method bounded by time.',
		bundled: true,
	},
	moddatetime: {
		sqlName: 'moddatetime',
		category: 'triggers',
		description: 'Trigger that keeps an updated_at column current.',
		bundled: true,
	},
	autoinc: {
		sqlName: 'autoinc',
		category: 'triggers',
		description: 'Trigger that fills a column from a sequence.',
		bundled: true,
	},
	insert_username: {
		sqlName: 'insert_username',
		category: 'triggers',
		description: 'Trigger that records the current user in a column.',
		bundled: true,
	},
	refint: {
		sqlName: 'refint',
		category: 'triggers',
		description: 'Triggers for referential integrity without foreign keys.',
		bundled: true,
	},
	tcn: {
		sqlName: 'tcn',
		category: 'triggers',
		description: 'Trigger that sends NOTIFY events on table changes.',
		bundled: true,
	},
	pg_cron: {
		sqlName: 'pg_cron',
		category: 'external',
		description: 'Cron-style scheduled SQL jobs. Needs the pg_cron variant (Postgres 18).',
		bundled: false,
	},
	pgvector: {
		sqlName: 'vector',
		category: 'external',
		description: 'Vector embeddings with HNSW/IVFFlat indexes. Shipped by the Postgres 18 image; 16 and 17 lack it.',
		bundled: false,
	},
	postgis: {
		sqlName: 'postgis',
		category: 'external',
		description: 'Geospatial types, functions and indexes. Needs the PostGIS variant (Postgres 18).',
		bundled: false,
	},
};

/** Host ports allocated per node for database containers (loopback only, D56). */
export const DATABASE_PORT_MIN = 15432;
export const DATABASE_PORT_MAX = 16431;

/** Host ports for per-database PgBouncer sidecars (loopback only). */
export const DATABASE_POOLER_PORT_MIN = 16432;
export const DATABASE_POOLER_PORT_MAX = 17431;
/** PgBouncer's `max_client_conn`; the helper renders the same value (D85). */
export const DATABASE_POOLER_MAX_CLIENTS = 200;

/**
 * Studio session lifetime and inactivity window, in minutes. The native studio (D96,
 * `database-studio.ts`) uses these; the names predate it (D60's studio console).
 */
export const DATABASE_CONSOLE_DEFAULT_TTL_MINUTES = 60;
export const DATABASE_CONSOLE_DEFAULT_IDLE_MINUTES = 15;
export const DATABASE_CONSOLE_MIN_TTL_MINUTES = 5;
export const DATABASE_CONSOLE_MAX_TTL_MINUTES = 480;
export const DATABASE_CONSOLE_MIN_IDLE_MINUTES = 5;
export const DATABASE_CONSOLE_MAX_IDLE_MINUTES = 240;

/** TLS modes a managed database connection can use. `require` encrypts; `verify-full` pins the CA. */
export const databaseSslModes = ['disable', 'require', 'verify-full'] as const;
export type DatabaseSslMode = (typeof databaseSslModes)[number];

export const databaseStatuses = ['pending', 'starting', 'running', 'failed', 'stopped'] as const;
export type DatabaseStatus = (typeof databaseStatuses)[number];

export const databaseNameSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Prefix for injected env vars: `DATABASE` → `DATABASE_URL`, `DATABASE_HOST`, … */
export const databaseEnvPrefixSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Env prefixes must be UPPER_SNAKE_CASE')
	.refine((prefix) => !prefix.endsWith('_'), 'Env prefixes must not end with "_"');

export const databaseCreateSchema = z
	.object({
		name: databaseNameSchema,
		engine: z.enum(databaseEngines).default('postgres'),
		version: z.string().max(16).optional(),
		/** Image variant (D126): `postgis` and `pg_cron` are Postgres 18 only. Fixed for life. */
		variant: z.enum(databaseVariants).default('standard'),
		/** `auto`, `edge`, or a node id. Resolved once at create time (D41). */
		placement: z.string().min(1).max(64).default('auto'),
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).default(1),
		/** Storage budget used for alerts and the dashboard gauge, in MB. */
		storageMb: z.number().int().min(256).max(1_048_576).default(10_240),
		/** `system`, `fast`, `bulk` or a disk name; omitted uses the default from Settings → Storage (docs/STORAGE.md). */
		storage: storageTargetSchema.optional(),
		/** Attach to this project right away (placement then follows the project's workload node). */
		project: z.string().min(1).max(64).optional(),
		envPrefix: databaseEnvPrefixSchema.optional(),
		/** Extensions to create on first start (allowlist only). */
		extensions: z.array(databaseExtensionSchema).max(databaseExtensionAllowlist.length).default([]),
		/**
		 * Run a transaction-mode PgBouncer sidecar and inject <PREFIX>_POOL_URL. PostgreSQL only;
		 * other engines ignore the default.
		 */
		pooler: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		const info = databaseEngineRegistry[input.engine];
		if (input.version && !info.versions.includes(input.version))
			ctx.addIssue({
				code: 'custom',
				path: ['version'],
				message: `${info.label} versions: ${info.versions.join(', ')}.`,
			});
		if (input.memoryMb !== undefined && input.memoryMb < info.minMemoryMb)
			ctx.addIssue({
				code: 'custom',
				path: ['memoryMb'],
				message: `${info.label} needs at least ${info.minMemoryMb} MB.`,
			});
		if (input.name.length > info.maxNameLength)
			ctx.addIssue({
				code: 'custom',
				path: ['name'],
				message: `${info.label} database names are at most ${info.maxNameLength} characters.`,
			});
		if (info.reservedNames.includes(input.name))
			ctx.addIssue({
				code: 'custom',
				path: ['name'],
				message: `"${input.name}" is reserved by ${info.label}; pick another name.`,
			});
		if (input.extensions.length > 0 && !info.capabilities.extensions)
			ctx.addIssue({
				code: 'custom',
				path: ['extensions'],
				message: `Extensions are only available for PostgreSQL.`,
			});
		const version = input.version ?? info.defaultVersion;
		if (!databaseVariantSupported(input.engine, version, input.variant)) {
			const variant = databaseVariantRegistry[input.variant];
			ctx.addIssue({
				code: 'custom',
				path: ['variant'],
				message: `The ${variant.label} variant needs PostgreSQL ${variant.postgresVersions?.join(', ')}.`,
			});
		}
		const extensionError = databaseVariantExtensionError(input.variant, input.extensions);
		if (extensionError) ctx.addIssue({ code: 'custom', path: ['extensions'], message: extensionError });
	});
export type DatabaseCreate = z.input<typeof databaseCreateSchema>;

export const databaseUpdateSchema = z
	.object({
		memoryMb: z.number().int().min(128).max(16_384).optional(),
		cpus: z.number().positive().max(8).optional(),
		storageMb: z.number().int().min(256).max(1_048_576).optional(),
		/**
		 * Target major version. Same-major changes are accepted; crossing a major is refused here
		 * and must go through the explicit `skif db upgrade` plan/apply flow.
		 */
		version: z.string().max(16).optional(),
		/** Adding installs on the next activation. Removing never drops an extension automatically. */
		extensions: z.array(databaseExtensionSchema).max(databaseExtensionAllowlist.length).optional(),
		/** Enable or disable the PgBouncer sidecar. */
		pooler: z.boolean().optional(),
	})
	.superRefine((input, ctx) => {
		// The version is checked against the database's own engine by the service; here it only
		// has to be a version some engine ships.
		if (
			input.version &&
			!Object.values(databaseEngineRegistry).some((info) => info.versions.includes(input.version!))
		)
			ctx.addIssue({
				code: 'custom',
				path: ['version'],
				message: `Unknown version "${input.version}".`
			});
		if (Object.keys(input).length === 0) ctx.addIssue({ code: 'custom', message: 'Nothing to update.' });
	});
export type DatabaseUpdate = z.infer<typeof databaseUpdateSchema>;

export const databaseUpgradeSchema = z.object({
	targetVersion: z.string().min(1).max(16),
	/** Create the verified backup and return the manual runbook; never switches the major itself. */
	apply: z.boolean().default(false),
});
export type DatabaseUpgradeInput = z.input<typeof databaseUpgradeSchema>;

export interface DatabaseUpgradeStep {
	id: string;
	title: string;
	detail: string;
	automatic: boolean;
}

export interface DatabaseUpgradePlan {
	databaseId: string;
	name: string;
	fromVersion: string;
	toVersion: string;
	majorChange: boolean;
	/** `manual`: the platform provides the plan and backup; an operator runs pg_upgrade/dump-restore. */
	status: 'planned' | 'blocked' | 'manual';
	mode: 'dump-restore' | 'pg-upgrade';
	blockers: string[];
	warnings: string[];
	steps: DatabaseUpgradeStep[];
	/** Set when `apply` queued the pre-upgrade backup. */
	backupId: string | null;
	docs: string;
	message: string;
}

export const databaseAttachSchema = z.object({
	database: databaseNameSchema,
	/** Defaults to the engine's prefix (`DATABASE`, `MONGODB`, `REDIS`, `CLICKHOUSE`). */
	envPrefix: databaseEnvPrefixSchema.optional(),
	/**
	 * Connect as a named credential instead of the owner: its id (`dbc_…`), or a role
	 * (`app`, `readonly`, `backup`) when exactly one ready credential has it. Postgres only.
	 */
	credential: z.string().min(1).max(100).optional(),
});
export type DatabaseAttach = z.input<typeof databaseAttachSchema>;

export interface DatabaseAttachmentView {
	databaseId: string;
	databaseName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	/** Env var names the project receives at activation. */
	envNames: string[];
	/** The named credential the app connects as; null for the built-in owner. */
	credentialId?: string | null;
	credentialRole?: DatabaseCredentialRole | null;
	createdAt: string;
}

export const databaseRotationRoles = ['owner', 'monitor'] as const;
export type DatabaseRotationRole = (typeof databaseRotationRoles)[number];

/**
 * Named database credentials (plan 04b). `owner` and `monitor` are created with the database;
 * `app`, `readonly` and `backup` are opt-in and provisioned as separate Postgres roles.
 */
export const databaseCredentialRoles = ['owner', 'app', 'monitor', 'readonly', 'backup'] as const;
export type DatabaseCredentialRole = (typeof databaseCredentialRoles)[number];

/** The roles a human can add after create. Owner/monitor are managed by the database itself. */
export const databaseNamedCredentialRoles = ['app', 'readonly', 'backup'] as const;
export type DatabaseNamedCredentialRole = (typeof databaseNamedCredentialRoles)[number];

export const databaseCredentialStatuses = ['pending', 'ready', 'failed', 'revoking', 'revoked'] as const;
export type DatabaseCredentialStatus = (typeof databaseCredentialStatuses)[number];

export const databaseCredentialCreateSchema = z.object({
	role: z.enum(databaseNamedCredentialRoles).default('app'),
	purpose: z.string().min(1).max(120).optional(),
	expiresAt: z.string().datetime().optional(),
});
export type DatabaseCredentialCreate = z.input<typeof databaseCredentialCreateSchema>;

export interface DatabaseCredentialView {
	id: string;
	databaseId: string;
	role: DatabaseCredentialRole;
	username: string;
	purpose: string | null;
	status: DatabaseCredentialStatus;
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	revokedAt: string | null;
}

/** A credential plus its secret. Only an interactive reveal returns this shape. */
export interface DatabaseCredentialReveal extends DatabaseCredentialView {
	password: string;
}

export const databaseCredentialTaskSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	action: z.enum(['grant', 'revoke']),
	role: z.enum(databaseCredentialRoles),
	username: z.string().min(1).max(63),
});
export type DatabaseCredentialTask = z.infer<typeof databaseCredentialTaskSchema>;

export const databaseCredentialActivationSchema = z.object({
	id: z.string(),
	databaseId: z.string(),
	action: z.enum(['grant', 'revoke']),
	role: z.enum(databaseCredentialRoles),
	username: z.string(),
	password: z.string().optional(),
});
export type DatabaseCredentialActivation = z.infer<typeof databaseCredentialActivationSchema>;

export const databaseCredentialResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	status: z.enum(['ok', 'failed']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseCredentialResult = z.infer<typeof databaseCredentialResultSchema>;

export const databaseRestartTargets = ['database', 'pooler'] as const;
export type DatabaseRestartTarget = (typeof databaseRestartTargets)[number];

export const databaseRestartSchema = z.object({
	target: z.enum(databaseRestartTargets).default('database'),
});
export type DatabaseRestart = z.input<typeof databaseRestartSchema>;

export const databaseRotateSchema = z.object({
	role: z.enum(databaseRotationRoles).default('owner'),
});
export type DatabaseRotate = z.input<typeof databaseRotateSchema>;

export interface DatabaseRotationView {
	id: string;
	databaseId: string;
	role: DatabaseRotationRole;
	status: 'pending' | 'running' | 'ok' | 'failed';
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export const databaseRotationTaskSchema = z.object({
	id: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	role: z.enum(databaseRotationRoles),
});
export type DatabaseRotationTask = z.infer<typeof databaseRotationTaskSchema>;

export const databaseRotationActivationSchema = z.object({
	id: z.string(),
	databaseId: z.string(),
	role: z.enum(databaseRotationRoles),
	password: z.string(),
});
export type DatabaseRotationActivation = z.infer<typeof databaseRotationActivationSchema>;

export const databaseRotationResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	databaseId: z.string().min(1).max(100),
	role: z.enum(databaseRotationRoles),
	status: z.enum(['ok', 'failed']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseRotationResult = z.infer<typeof databaseRotationResultSchema>;

export interface DatabaseSlowQuery {
	/** `pg_stat_statements.queryid` (stable for the same normalized query). */
	queryId: string;
	/** Normalized SQL; literals are placeholders, never values. */
	query: string;
	calls: number;
	totalMs: number;
	meanMs: number;
	rows: number;
	sharedBlocks: number;
	tempBlocks: number;
}

export interface DatabaseTableStat {
	schema: string;
	name: string;
	/** `n_live_tup`, an estimate. */
	rows: number;
	totalBytes: number;
	seqScans: number;
	idxScans: number;
	lastAutovacuum: string | null;
	lastAutoanalyze: string | null;
}

export interface DatabaseView {
	id: string;
	name: string;
	engine: DatabaseEngine;
	engineLabel: string;
	/** What this engine supports; surfaces hide the rest (docs/DATABASES.md §17). */
	capabilities: DatabaseEngineCapabilities;
	version: string;
	/** Image variant chosen at create (D126). */
	variant: DatabaseVariant;
	status: DatabaseStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	/** Promotions so far (C7); `POST …/replicas/:id/promote` takes it as `If-Match`. */
	primaryGeneration: number;
	/** Read replicas not being removed (docs/CLUSTERING.md §9.2). */
	replicaCount: number;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	/** Latest sampled size, if the agent has reported one. */
	sizeBytes: number | null;
	/** Engine database / owner names (not secret). */
	databaseName: string;
	username: string;
	/** What an attached app on the same node connects to (no password). */
	internalHost: { process: string; container: string };
	/** Optional PgBouncer sidecar and the addresses an app uses for it. */
	pooler: {
		enabled: boolean;
		host: { process: string; container: string };
		port: number | null;
		/** Transaction pooling; session-only features need the direct URL. */
		mode: 'transaction';
		/** Template for the pooled URL (`{user}`, `{password}`, `{host}`, `{port}`, `{database}`). */
		urlTemplate: string | null;
	};
	/** TLS state derived from the node's certificate files (no private key leaves the node). */
	tls: {
		enabled: boolean;
		mode: DatabaseSslMode;
		caPem: string | null;
		/** Last certificate-generation / startup warning from the node, if any. */
		error: string | null;
	};
	/** Where the data dir lives; null keeps the helper state dir (D74). */
	/** The disk the data lives on; null is the system disk. */
	disk: DiskSummary | null;
	attachments: DatabaseAttachmentView[];
	tables: DatabaseTableStat[];
	statsAt: string | null;
	/** Requested extensions (the node installs them best-effort on first start). */
	extensions: DatabaseExtension[];
	/** Latest top-50 slow-query snapshot from `pg_stat_statements`. */
	slowQueries: DatabaseSlowQuery[];
	slowQueriesAt: string | null;
	/** Backup policy and last known result (docs/DATABASES.md §9). */
	backup: DatabaseBackupSummary;
	/** Public URL metadata only; the URL itself needs `revealPublicUrl` (and `database:credentials`). */
	publicUrl: DatabasePublicUrlView;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

/**
 * A public connection URL for a database (for example, the address of an operator-managed TCP
 * proxy or tunnel in front of the node). It is a secret: sealed with the org key and only
 * decrypted by an explicit reveal. Skiff itself keeps Postgres loopback-only (D56).
 */
/** Schemes a stored public URL may use; the service also checks it matches the engine. */
export const DATABASE_PUBLIC_URL_PATTERN = /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|https?|clickhouse):\/\/[^\s]+$/i;

/** Public URL schemes that fit an engine. */
export function databasePublicUrlSchemes(engine: DatabaseEngine): readonly string[] {
	switch (engine) {
		case 'postgres':
			return ['postgres', 'postgresql'];
		case 'mysql':
		case 'mariadb':
			return ['mysql', 'mariadb'];
		case 'mongodb':
			return ['mongodb', 'mongodb+srv'];
		case 'valkey':
		case 'redis':
			return ['redis', 'rediss'];
		case 'clickhouse':
			return ['http', 'https', 'clickhouse'];
	}
}

export const databasePublicUrlSchema = z
	.string()
	.trim()
	.min(8)
	.max(4096)
	.refine(
		(value) => DATABASE_PUBLIC_URL_PATTERN.test(value),
		'Use a postgres://, mysql://, mariadb://, mongodb://, mongodb+srv://, redis://, rediss://, http(s):// or clickhouse:// URL.'
	);

export const databasePublicUrlUpdateSchema = z.object({ url: databasePublicUrlSchema });
export type DatabasePublicUrlUpdate = z.infer<typeof databasePublicUrlUpdateSchema>;

export interface DatabasePublicUrlView {
	configured: boolean;
	updatedAt: string | null;
	updatedBy: string | null;
}

/** Returned only by an audited reveal; never in a list/get view. */
export interface DatabasePublicUrlReveal extends DatabasePublicUrlView {
	url: string;
}

export interface DatabaseCredentials {
	databaseId: string;
	name: string;
	username: string;
	password: string;
	databaseName: string;
	/** Same-node direct URL for a process app (loopback). */
	url: string;
	/** Direct URL; use this for migrations and session-only features. */
	directUrl: string;
	/** Pooled URL when the pooler is enabled; null otherwise. */
	poolerUrl: string | null;
	host: string;
	port: number;
	sslmode: DatabaseSslMode;
	tlsEnabled: boolean;
	/** PEM of the per-database CA; public material, never a private key. */
	caPem: string | null;
	/** Copy-paste snippets keyed by client (`psql`, `prisma`, `drizzle`, …). */
	connectionSnippets: Record<string, string>;
	note: string;
}

/** The `database` profile on a workload sent to the helper (D61): engine + version only. */
export const workloadDatabaseSchema = z.object({
	engine: z.enum(databaseEngines),
	version: z.string().min(1).max(16),
	/**
	 * Skiff-built Postgres image variant (D126); absent means `standard`, so older helpers keep
	 * accepting every database that does not use one.
	 */
	variant: z.enum(['postgis', 'pg_cron']).optional(),
	/** Render Postgres with a helper-generated server certificate (SKIFF_FEATURE_DB_TLS). */
	tls: z.boolean().optional(),
	/**
	 * WAL archiving for PITR (docs/PITR.md). Present only while the `PITR` flag is on and the
	 * database has PITR enabled; the helper renders `archive_mode`/`archive_command` from it.
	 */
	pitr: z
		.object({
			stanza: z.string().min(1).max(64),
			archiveTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
		})
		.optional(),
	/**
	 * Streaming read replica (docs/CLUSTERING.md §9.2, C7). Present only on a replica workload
	 * (`db_dbr_<hex>`): the helper renders the standby variant of the Postgres unit, which runs
	 * `pg_basebackup` through the agent's link socket on first start and then streams from `slot`.
	 */
	replica: z
		.object({
			slot: z.string().regex(/^skiff_[a-z0-9_]{1,56}$/),
		})
		.optional(),
});
export type WorkloadDatabase = z.infer<typeof workloadDatabaseSchema>;

/** Extra activation data for the agent's stats sampler; stripped before the helper sees it. */
export const databaseMonitorSchema = z.object({
	databaseName: z.string(),
	ownerUser: z.string(),
	ownerPassword: z.string(),
	monitorUser: z.string(),
	monitorPassword: z.string(),
	port: z.number().int().positive(),
});
export type DatabaseMonitor = z.infer<typeof databaseMonitorSchema>;

/** One database's 1-minute sample (D57). Counters are per-minute deltas. */
export const databaseMetricBucketSchema = z.object({
	databaseId: z.string().max(100),
	bucket: z.string(),
	up: z.boolean(),
	sizeBytes: z.number().int().nonnegative().default(0),
	connectionsActive: z.number().int().nonnegative().default(0),
	connectionsIdle: z.number().int().nonnegative().default(0),
	connectionsTotal: z.number().int().nonnegative().default(0),
	maxConnections: z.number().int().nonnegative().default(0),
	memoryBytes: z.number().int().nonnegative().default(0),
	/** PgBouncer `SHOW POOLS`/`SHOW STATS` gauges; zero when the pooler is disabled or down. */
	poolerUp: z.number().int().min(0).max(1).default(0),
	poolActive: z.number().int().nonnegative().default(0),
	poolIdle: z.number().int().nonnegative().default(0),
	poolWaiting: z.number().int().nonnegative().default(0),
	poolSaturation: z.number().min(0).max(1).default(0),
	poolAvgWaitMs: z.number().nonnegative().default(0),
	xactCommit: z.number().int().nonnegative().default(0),
	xactRollback: z.number().int().nonnegative().default(0),
	tupReturned: z.number().int().nonnegative().default(0),
	tupFetched: z.number().int().nonnegative().default(0),
	tupInserted: z.number().int().nonnegative().default(0),
	tupUpdated: z.number().int().nonnegative().default(0),
	tupDeleted: z.number().int().nonnegative().default(0),
	blksHit: z.number().int().nonnegative().default(0),
	blksRead: z.number().int().nonnegative().default(0),
	deadlocks: z.number().int().nonnegative().default(0),
	tempBytes: z.number().int().nonnegative().default(0),
});
export type DatabaseMetricBucket = z.infer<typeof databaseMetricBucketSchema>;

export const databaseTableStatSchema = z.object({
	schema: z.string().max(128),
	name: z.string().max(128),
	rows: z.number().nonnegative(),
	totalBytes: z.number().nonnegative(),
	seqScans: z.number().nonnegative(),
	idxScans: z.number().nonnegative(),
	lastAutovacuum: z.string().max(40).nullable(),
	lastAutoanalyze: z.string().max(40).nullable(),
});

export const databaseSlowQuerySchema = z.object({
	queryId: z.string().max(40),
	query: z.string().max(2_000),
	calls: z.number().nonnegative(),
	totalMs: z.number().nonnegative(),
	meanMs: z.number().nonnegative(),
	rows: z.number().nonnegative(),
	sharedBlocks: z.number().nonnegative(),
	tempBlocks: z.number().nonnegative(),
});

export const databaseSnapshotSchema = z.object({
	databaseId: z.string().max(100),
	at: z.string(),
	tables: z.array(databaseTableStatSchema).max(50),
	/** Top slow queries when `pg_stat_statements` is enabled; omitted otherwise. */
	slowQueries: z.array(databaseSlowQuerySchema).max(50).optional(),
});
export type DatabaseSnapshot = z.infer<typeof databaseSnapshotSchema>;

/** Point returned by `GET /databases/:name/metrics`. Rates are per minute or per hour bucket. */
export interface DatabaseMetricPoint {
	bucket: string;
	up: number;
	sizeBytes: number;
	connectionsActive: number;
	connectionsIdle: number;
	connectionsTotal: number;
	maxConnections: number;
	memoryBytes: number;
	poolerUp: number;
	poolActive: number;
	poolIdle: number;
	poolWaiting: number;
	poolSaturation: number;
	poolAvgWaitMs: number;
	xactCommit: number;
	xactRollback: number;
	tupReturned: number;
	tupFetched: number;
	tupInserted: number;
	tupUpdated: number;
	tupDeleted: number;
	blksHit: number;
	blksRead: number;
	deadlocks: number;
	tempBytes: number;
}

/** `db-<hex>`: the container's DNS alias on the workload's org network (or the legacy shared network). */
export function databaseAlias(id: string): string {
	return `db-${id.replace(/^db_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

/**
 * Engine identifier for a database name: `my-app` → `my_app` (Postgres roles, MySQL users and
 * databases, MongoDB databases, Valkey ACL users and ClickHouse users and databases all accept it).
 */
export function databaseIdentifier(name: string): string {
	return name.replace(/-/g, '_');
}

/** Env var names a project receives for one attachment. */
export function databaseEnvNames(
	prefix: string,
	options: { pooler?: boolean; tls?: boolean; engine?: DatabaseEngine; replicas?: boolean } = {},
): string[] {
	const names = ['URL', 'HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'];
	// MongoDB drivers and docs say "connection string URI"; most apps read `<PREFIX>_URI`.
	if (options.engine === 'mongodb') names.push('URI');
	if (options.tls) names.push('SSL_MODE', 'CA_CERT');
	if (options.pooler) names.push('POOL_URL', 'POOL_HOST', 'POOL_PORT');
	// Read replicas (C7): set only while a replica the app can reach is streaming or lagging.
	if (options.replicas) names.push('READ_URL', 'READ_URLS', 'READ_HOST', 'READ_PORT');
	return names.map((suffix) => `${prefix}_${suffix}`);
}

export interface DatabaseUrlOptions {
	scheme: string;
	user: string;
	pass: string;
	host: string;
	port: number;
	database: string;
	sslmode?: DatabaseSslMode;
	/** Extra query string from the engine registry (`authSource=admin`). */
	query?: string | null;
}

/** A connection string; `sslmode` is appended only when TLS is in use. */
export function databaseConnectionUrl(options: DatabaseUrlOptions): string {
	const user = encodeURIComponent(options.user);
	const pass = encodeURIComponent(options.pass);
	const database = encodeURIComponent(options.database);
	const base = `${options.scheme}://${user}:${pass}@${options.host}:${options.port}/${database}`;
	const query: string[] = [];
	if (options.query) query.push(options.query);
	if (options.sslmode && options.sslmode !== 'disable') query.push(`sslmode=${options.sslmode}`);
	return query.length > 0 ? `${base}?${query.join('&')}` : base;
}

/** The URL path segment for a database: its name, or the engine's fixed value (`0`). */
export function databaseUrlDatabase(engine: DatabaseEngine, databaseName: string): string {
	const info = databaseEngineRegistry[engine];
	return info.urlDatabase === 'name' ? databaseName : info.urlDatabase;
}

export interface DatabaseSnippetInput {
	/** Direct URL. */
	directUrl: string;
	/** Pooled URL when enabled. */
	poolerUrl: string | null;
	sslmode: DatabaseSslMode;
	caPem: string | null;
	/** Env prefix the attached app receives (default `DATABASE`). */
	envPrefix?: string;
	/** Defaults to `postgres` so existing callers keep their snippets. */
	engine?: DatabaseEngine;
}

/**
 * Copy-paste connection snippets for the credentials response (docs/DATABASES.md §10). The
 * default `url` is pooled when available; `direct` is explicit because migrations, logical
 * replication, `LISTEN`, advisory locks and session state need a direct connection.
 */
export function databaseConnectionSnippets(input: DatabaseSnippetInput): Record<string, string> {
	const engine = input.engine ?? 'postgres';
	if (engine !== 'postgres') return engineSnippets(engine, input);
	const prefix = input.envPrefix ?? databaseEngineRegistry.postgres.defaultEnvPrefix;
	const url = input.poolerUrl ?? input.directUrl;
	const direct = input.directUrl;
	const ca = input.caPem ? `\n-- ${prefix}_CA_CERT holds the PEM CA certificate.` : '';
	const pooledEnv = input.poolerUrl ? `${prefix}_POOL_URL` : `${prefix}_URL`;
	const caEnv = input.caPem ? `\n${prefix}_CA_CERT="$(cat ca.pem)"` : '';
	const ssl = input.sslmode === 'disable' ? '' : '?sslmode=require';
	return {
		psql: `psql "${url}"`,
		direct: `psql "${direct}"  # migrations, pg_dump, LISTEN/NOTIFY, advisory locks, session state`,
		prisma: `# schema.prisma (run migrations against directUrl)\ndatasource db {\n  provider  = "postgresql"\n  url       = env("${pooledEnv}")\n  directUrl = env("${prefix}_URL")\n}${ca}`,
		drizzle: `import { drizzle } from 'drizzle-orm/postgres-js';\nimport postgres from 'postgres';\n\nconst sql = postgres(process.env.${prefix}_URL!, { ssl: 'require' });\nexport const db = drizzle(sql);${ca}`,
		kysely: `import { Kysely, PostgresDialect } from 'kysely';\nimport { Pool } from 'pg';\n\nexport const db = new Kysely({\n  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.${prefix}_URL }) }),\n});${ca}`,
		django: `# settings.py\nimport os, dj_database_url\nDATABASES = {'default': dj_database_url.parse(os.environ['${prefix}_URL'])}${ca}`,
		rails: `# config/database.yml\nproduction:\n  url: <%= ENV.fetch('${prefix}_URL') %>${ca}`,
		pgx: `pool, err := pgxpool.New(ctx, os.Getenv("${prefix}_URL"))\nif err != nil { log.Fatal(err) }${ca}`,
		nodePostgres: `import fs from 'node:fs';\nimport { Pool } from 'pg';\n\nconst pool = new Pool({\n  connectionString: process.env.${prefix}_URL,\n${input.caPem ? `  ssl: { ca: fs.readFileSync(process.env.${prefix}_CA_CERT || 'ca.pem') },\n` : ''}});${ca}`,
		verifyFull: input.caPem
			? `# Verify the server certificate against the per-database CA (host must be in the SAN):\npsql "${direct.replace(ssl, '?sslmode=verify-full')}"  # also set sslrootcert=ca.pem${caEnv}`
			: '# TLS is disabled; enable SKIFF_FEATURE_DB_TLS to encrypt connections.',
	};
}

function engineSnippets(engine: Exclude<DatabaseEngine, 'postgres'>, input: DatabaseSnippetInput): Record<string, string> {
	const prefix = input.envPrefix ?? databaseEngineRegistry[engine].defaultEnvPrefix;
	const url = input.directUrl;
	switch (engine) {
		case 'mysql':
		case 'mariadb': {
			const cli = engine === 'mysql' ? 'mysql' : 'mariadb';
			return {
				[cli]: `${cli} "${url}"`,
				prisma: `# schema.prisma\ndatasource db {\n  provider = "mysql"\n  url      = env("${prefix}_URL")\n}`,
				drizzle: `import { drizzle } from 'drizzle-orm/mysql2';\nimport mysql from 'mysql2/promise';\n\nconst pool = mysql.createPool(process.env.${prefix}_URL!);\nexport const db = drizzle(pool);`,
				kysely: `import { Kysely, MysqlDialect } from 'kysely';\nimport { createPool } from 'mysql2';\n\nexport const db = new Kysely({\n  dialect: new MysqlDialect({ pool: createPool(process.env.${prefix}_URL!) }),\n});`,
				django: `# settings.py\nimport os, dj_database_url\nDATABASES = {'default': dj_database_url.parse(os.environ['${prefix}_URL'])}`,
				rails: `# config/database.yml (mysql2 adapter)\nproduction:\n  url: <%= ENV.fetch('${prefix}_URL').sub('mysql://', 'mysql2://') %>`,
				go: `// github.com/go-sql-driver/mysql takes a DSN, not a URL\ndsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true",\n  os.Getenv("${prefix}_USER"), os.Getenv("${prefix}_PASSWORD"),\n  os.Getenv("${prefix}_HOST"), os.Getenv("${prefix}_PORT"), os.Getenv("${prefix}_NAME"))\ndb, err := sql.Open("mysql", dsn)`,
			};
		}
		case 'mongodb':
			return {
				mongosh: `mongosh "${url}"`,
				node: `import { MongoClient } from 'mongodb';\n\nconst client = new MongoClient(process.env.${prefix}_URI!);\nexport const db = client.db();`,
				mongoose: `import mongoose from 'mongoose';\n\nawait mongoose.connect(process.env.${prefix}_URI!);`,
				prisma: `# schema.prisma\ndatasource db {\n  provider = "mongodb"\n  url      = env("${prefix}_URI")\n}`,
				python: `from pymongo import MongoClient\nimport os\n\nclient = MongoClient(os.environ['${prefix}_URI'])\ndb = client.get_default_database()`,
				go: `client, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("${prefix}_URI")))`,
			};
		case 'valkey':
		case 'redis': {
			const cli = engine === 'valkey' ? 'valkey-cli' : 'redis-cli';
			return {
				[engine === 'valkey' ? 'valkeyCli' : 'redisCli']: `${cli} -u "${url}"`,
				ioredis: `import Redis from 'ioredis';\n\nexport const redis = new Redis(process.env.${prefix}_URL!);`,
				nodeRedis: `import { createClient } from 'redis';\n\nexport const redis = await createClient({ url: process.env.${prefix}_URL }).connect();`,
				bullmq: `import { Queue } from 'bullmq';\nimport Redis from 'ioredis';\n\nconst connection = new Redis(process.env.${prefix}_URL!, { maxRetriesPerRequest: null });\nexport const queue = new Queue('jobs', { connection });`,
				python: `import os, redis\n\nr = redis.from_url(os.environ['${prefix}_URL'])`,
				rails: `# config/environments/production.rb\nconfig.cache_store = :redis_cache_store, { url: ENV.fetch('${prefix}_URL') }`,
				go: `opt, _ := redis.ParseURL(os.Getenv("${prefix}_URL"))\nrdb := redis.NewClient(opt)`,
			};
		}
		case 'clickhouse': {
			// The HTTP interface answers queries at `/`; the URL path is only the client's default
			// database, so curl gets it as `?database=` instead.
			const parsed = new URL(url);
			const auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
			const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
			return {
				curl: `curl --user '${auth}' '${parsed.protocol}//${parsed.host}/?database=${encodeURIComponent(database)}' --data-binary 'SELECT version()'`,
				clickhouseJs: `import { createClient } from '@clickhouse/client';\n\nexport const clickhouse = createClient({ url: process.env.${prefix}_URL });`,
				python: `import os, clickhouse_connect\n\nclient = clickhouse_connect.get_client(dsn=os.environ['${prefix}_URL'])`,
				go: `conn, err := clickhouse.Open(&clickhouse.Options{\n  Protocol: clickhouse.HTTP,\n  Addr:     []string{os.Getenv("${prefix}_HOST") + ":" + os.Getenv("${prefix}_PORT")},\n  Auth: clickhouse.Auth{\n    Database: os.Getenv("${prefix}_NAME"),\n    Username: os.Getenv("${prefix}_USER"),\n    Password: os.Getenv("${prefix}_PASSWORD"),\n  },\n})`,
			};
		}
	}
}

/**
 * The pgvector build of the official Postgres image, pinned for Postgres 18 and later (D124).
 * 16 and 17 stay on the alpine image: moving a cluster from musl to glibc changes collation
 * order under existing text indexes. The helper has its own copy.
 */
export const POSTGRES_PGVECTOR_IMAGE_TAG = '0.8.7-pg18-trixie';

/**
 * Skiff-built Postgres variant images (D126), built from `docker/postgres/Dockerfile` on the pinned
 * pgvector image and published by CI. Bump the revision whenever the Dockerfile or its base
 * changes, so a published tag never moves. The helper has its own copy.
 */
export const SKIFF_POSTGRES_IMAGE = 'ghcr.io/kieranholroyd/skiff-postgres';
export const SKIFF_POSTGRES_IMAGE_REVISION = '1';

/**
 * The Postgres image a PITR-enabled database runs (docs/PITR.md): the pinned pgvector image plus
 * pgBackRest, built from `docker/postgres-pitr/Dockerfile` and published by
 * `.github/workflows/postgres-pitr-image.yml` as `skiff-postgres-pitr:<major>-<revision>`.
 * Postgres runs `archive_command` in its own container, so only this image can archive WAL. Only
 * the standard 18 image has a build; 16/17 (alpine) and the D126 variants do not. A published tag
 * is never overwritten: bump the revision (here, in the helper's copy in
 * `apps/helper/src/validate.ts` and in the workflow) and pin the new digest in all three.
 */
export const POSTGRES_PITR_VERSIONS = ['18'] as const;
export const POSTGRES_PITR_IMAGE = 'ghcr.io/kieranholroyd/skiff-postgres-pitr';
export const POSTGRES_PITR_IMAGE_REVISION = '1';
/** `sha256:…` once the tag is published; the helper's copy must match. */
export const POSTGRES_PITR_IMAGE_DIGEST: string | null = null;

/** Why PITR cannot run on this engine/version/variant, or null when it can. */
export function pitrUnsupportedReason(engine: DatabaseEngine, version: string, variant: DatabaseVariant): string | null {
	if (engine !== 'postgres') return 'Point-in-time recovery is only available for PostgreSQL.';
	if (variant !== 'standard')
		return `Point-in-time recovery is not available for the ${variant} image; it needs the standard PostgreSQL image.`;
	if (!(POSTGRES_PITR_VERSIONS as readonly string[]).includes(version))
		return `Point-in-time recovery needs PostgreSQL ${POSTGRES_PITR_VERSIONS.join(', ')}; ${version} has no pgBackRest image. Upgrade first.`;
	return null;
}

/** The PITR image for a Postgres major version. The helper has its own copy and rejects a mismatch. */
export function postgresPitrImage(version: string): string {
	if (!(POSTGRES_PITR_VERSIONS as readonly string[]).includes(version))
		throw new Error(`PITR needs Postgres ${POSTGRES_PITR_VERSIONS.join(', ')}; ${version} has no pgBackRest image`);
	const tag = `${POSTGRES_PITR_IMAGE}:${version}-${POSTGRES_PITR_IMAGE_REVISION}`;
	return POSTGRES_PITR_IMAGE_DIGEST ? `${tag}@${POSTGRES_PITR_IMAGE_DIGEST}` : tag;
}

/**
 * Postgres image for a major version and variant: alpine for 16/17, the pgvector (Debian) image
 * from 18, and a Skiff-built image for the `postgis` and `pg_cron` variants (D126).
 */
export function postgresImage(version: string, variant: DatabaseVariant = 'standard'): string {
	if (variant !== 'standard') return `${SKIFF_POSTGRES_IMAGE}:${version}-${variant}-${SKIFF_POSTGRES_IMAGE_REVISION}`;
	return Number(version) >= 18
		? `docker.io/pgvector/pgvector:${POSTGRES_PGVECTOR_IMAGE_TAG}`
		: `docker.io/library/postgres:${version}-alpine`;
}

/** OCI image for an engine version. The helper has its own copy and rejects any mismatch (D61). */
export function databaseImage(engine: DatabaseEngine, version: string, variant: DatabaseVariant = 'standard'): string {
	switch (engine) {
		case 'postgres':
			return postgresImage(version, variant);
		case 'mysql':
			return `docker.io/library/mysql:${version}`;
		case 'mariadb':
			return `docker.io/library/mariadb:${version}`;
		case 'mongodb':
			return `docker.io/library/mongo:${version}`;
		case 'valkey':
			return `docker.io/valkey/valkey:${version}-alpine`;
		case 'redis':
			return `docker.io/library/redis:${version}-alpine`;
		case 'clickhouse':
			return `docker.io/clickhouse/clickhouse-server:${version}`;
	}
}

/** Role the agent's stats sampler uses (`pg_monitor` only, D57). */
export const DATABASE_MONITOR_USER = 'skiff_monitor';
