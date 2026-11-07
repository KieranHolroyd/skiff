import { ValidationError } from './validate.ts';

/**
 * Native backup formats for the engines whose dump is a file the server writes itself
 * (docs/DATABASES.md §8, §17): Valkey/Redis RDB snapshots and ClickHouse `BACKUP` archives. Unlike
 * the SQL/BSON dumps, which stream to stdout, these land in a fixed staging directory inside the
 * database's own `/data` mount, so a large dump never goes through the helper's tmpfs. Everything
 * here is pure: the driver runs the argv through its `CommandRunner` and passes passwords in the
 * environment only.
 */

/** Staging directory name under the data dir (host) and under `/data` (container). */
export const DUMP_STAGING_DIRNAME = 'skiff-dumps';
/** The same directory as the container sees it; ClickHouse's `backups.allowed_path`. */
export const DUMP_STAGING_CONTAINER_DIR = `/data/${DUMP_STAGING_DIRNAME}/`;
/** Leftover dump/restore files older than this are removed before the next run. */
export const DUMP_STAGING_MAX_AGE_MS = 60 * 60_000;

/**
 * Valkey/Redis multi-part AOF names (the defaults; the generated config sets neither
 * `appenddirname` nor `appendfilename`). With `appendonly yes` the server loads only the AOF, so a
 * restore installs the RDB snapshot as the AOF base file and writes a manifest naming it. On start
 * the server loads the base, opens a fresh incremental file and keeps appending.
 */
export const KEY_VALUE_AOF_DIRNAME = 'appendonlydir';
export const KEY_VALUE_AOF_BASE = 'appendonly.aof.1.base.rdb';
export const KEY_VALUE_AOF_MANIFEST = 'appendonly.aof.manifest';

export function keyValueAofManifest(): string {
	return `file ${KEY_VALUE_AOF_BASE} seq 1 type b\n`;
}

/** The name ClickHouse backups store the database under, so a restore can rename it. */
export const CLICKHOUSE_BACKUP_DATABASE = 'skiff_backup';
/** Long dumps must not trip clickhouse-client's default 300 s receive timeout. */
const CLICKHOUSE_CLIENT_TIMEOUT_SECONDS = 6 * 60 * 60;

export type KeyValueEngine = 'valkey' | 'redis';

/** A staging file name: `dump-<uuid>.<ext>` or `restore-<uuid>.<ext>`, nothing else. */
export function stagingFileName(kind: 'dump' | 'restore', token: string, extension: 'rdb' | 'zip'): string {
	if (!/^[a-f0-9-]{8,64}$/.test(token)) throw new ValidationError('Invalid staging token');
	return `${kind}-${token}.${extension}`;
}

function assertStagingFile(name: string): string {
	if (!/^(?:dump|restore)-[a-f0-9-]{8,64}\.(?:rdb|zip)$/.test(name)) throw new ValidationError('Invalid staging file');
	return name;
}

function assertIdentifier(value: string, label: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new ValidationError(`Invalid ${label}`);
	return value;
}

interface ExecTarget {
	podmanPath: string;
	/** `skiff-workload-<id>`. */
	container: string;
}

/**
 * `valkey-cli --rdb`: the server forks a snapshot and sends it over the replication protocol; the
 * CLI writes it to the staging file. Needs `REDISCLI_AUTH` in the environment (podman `-e`).
 */
export function keyValueRdbDumpArgv(input: ExecTarget & { engine: KeyValueEngine; user: string; file: string }): string[] {
	return [
		input.podmanPath,
		'exec',
		'-e',
		'REDISCLI_AUTH',
		input.container,
		`${input.engine}-cli`,
		'--no-auth-warning',
		'--user',
		assertIdentifier(input.user, 'Valkey/Redis user'),
		'--rdb',
		`${DUMP_STAGING_CONTAINER_DIR}${assertStagingFile(input.file)}`,
	];
}

/** `valkey-check-rdb`: parses every key of a snapshot; non-zero exit on any corruption. */
export function keyValueCheckRdbArgv(input: ExecTarget & { engine: KeyValueEngine; file: string }): string[] {
	return [
		input.podmanPath,
		'exec',
		input.container,
		`${input.engine}-check-rdb`,
		`${DUMP_STAGING_CONTAINER_DIR}${assertStagingFile(input.file)}`,
	];
}

/** `PING` as the owner; `PONG` only once the dataset has finished loading. */
export function keyValuePingArgv(input: ExecTarget & { engine: KeyValueEngine; user: string }): string[] {
	return [
		input.podmanPath,
		'exec',
		'-e',
		'REDISCLI_AUTH',
		input.container,
		`${input.engine}-cli`,
		'--no-auth-warning',
		'--user',
		assertIdentifier(input.user, 'Valkey/Redis user'),
		'PING',
	];
}

/** `valkey-cli` exits 0 on a command error; its reply is on stdout. */
export function keyValueReplyFailed(stdout: string): boolean {
	return /^\(error\)|^ERR|^WRONGPASS|^NOAUTH|^LOADING/m.test(stdout);
}

/**
 * `BACKUP DATABASE <db> AS skiff_backup TO File(...)`: ClickHouse's native backup (schema, parts and
 * checksums) as one zip archive. Storing it under a fixed name lets any target database restore it.
 */
export function clickhouseBackupQuery(database: string, file: string): string {
	const name = assertIdentifier(database, 'ClickHouse database');
	return `BACKUP DATABASE \`${name}\` AS \`${CLICKHOUSE_BACKUP_DATABASE}\` TO File('${DUMP_STAGING_CONTAINER_DIR}${assertStagingFile(file)}')`;
}

/**
 * Restore into the target's own (empty, entrypoint-created) database. `RESTORE` re-checks every
 * part's checksum; the existing database's definition may differ only in its name.
 */
export function clickhouseRestoreQuery(database: string, file: string): string {
	const name = assertIdentifier(database, 'ClickHouse database');
	return (
		`RESTORE DATABASE \`${CLICKHOUSE_BACKUP_DATABASE}\` AS \`${name}\` ` +
		`FROM File('${DUMP_STAGING_CONTAINER_DIR}${assertStagingFile(file)}') ` +
		'SETTINGS allow_different_database_def = 1'
	);
}

/** `clickhouse-client` as the owner over in-container TCP; the password is `CLICKHOUSE_PASSWORD`. */
export function clickhouseClientArgv(input: ExecTarget & { user: string; query: string }): string[] {
	return [
		input.podmanPath,
		'exec',
		'-e',
		'CLICKHOUSE_PASSWORD',
		input.container,
		'clickhouse-client',
		'--host',
		'127.0.0.1',
		'--user',
		assertIdentifier(input.user, 'ClickHouse user'),
		`--receive_timeout=${CLICKHOUSE_CLIENT_TIMEOUT_SECONDS}`,
		`--send_timeout=${CLICKHOUSE_CLIENT_TIMEOUT_SECONDS}`,
		'--query',
		input.query,
	];
}

/** Whether a staging file name is stale enough to delete (helper restarts lose the cleanup timer). */
export function isStaleStagingFile(name: string, mtimeMs: number, now: number): boolean {
	return /^(?:dump|restore)-[a-f0-9-]{8,64}\.(?:rdb|zip)$/.test(name) && now - mtimeMs > DUMP_STAGING_MAX_AGE_MS;
}
