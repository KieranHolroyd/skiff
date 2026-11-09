import { ValidationError } from './validate.ts';

/**
 * pgBackRest data path for PITR (docs/PITR.md). Pure renderers, parsers and validators only; the
 * `SystemdDriver` runs the fixed podman argv. Nothing here accepts a shell string.
 *
 * Everything runs the same image: a PITR-enabled database runs the Yoal-built Postgres image that
 * ships pgBackRest (`docker/postgres-pitr`, `postgresPitrImage`). Postgres itself runs
 * `archive-push` from `archive_command`; base backups, `info` and `pg_stat_archiver` reads are
 * `podman exec` into that running container (pgBackRest must share the host with Postgres and talks
 * to it over the Unix socket); a restore runs one-shot containers of the same image against the
 * target's data dir. pgBackRest therefore always writes and reads its repository with one version.
 */

/** Container paths. The helper mounts the per-database config directory here read-only. */
export const PITR_CONTAINER_CONFIG_DIR = '/etc/pgbackrest';
export const PITR_CONTAINER_CONFIG_PATH = `${PITR_CONTAINER_CONFIG_DIR}/pgbackrest.conf`;
export const PITR_CONTAINER_PGPASS_PATH = `${PITR_CONTAINER_CONFIG_DIR}/pgpass`;
/** Async archive-push/get queue. On the data volume (the root is read-only), beside `pgdata`. */
export const PITR_SPOOL_PATH = '/data/pgbackrest-spool';
/** The image's socket directory; the unit mounts a tmpfs there. */
export const PITR_PG_SOCKET_PATH = '/var/run/postgresql';
export const PITR_PGDATA = '/data/pgdata';
export const PITR_CONFIG_DIRNAME = 'pgbackrest';
export const PITR_CONFIG_FILENAME = 'pgbackrest.conf';
export const PITR_PGPASS_FILENAME = 'pgpass';
export const PITR_ARCHIVE_TIMEOUT_SECONDS = 60;
/** Weekly full and daily differential base backups, at 02:00 UTC. */
export const PITR_FULL_SCHEDULE = '0 2 * * 0';
export const PITR_DIFF_SCHEDULE = '0 2 * * 1-6';
export const PITR_RETENTION_FULL = 4;
export const PITR_RETENTION_DIFF = 7;
/** A temporary superuser the restore creates to rename the owner role, then drops. */
export const PITR_RESTORE_ROLE = 'yoal_pitr_restore';

export interface PitrRepoConfig {
	kind: 's3';
	endpoint: string | null;
	bucket: string;
	region: string;
	pathPrefix: string;
	forcePathStyle: boolean;
	accessKeyId: string;
	secretAccessKey: string;
}

export const PITR_STANZA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]{1,63}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._/-]*$/;
const ACCESS_KEY_PATTERN = /^[^\s\r\n]{3,128}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

export function validatePitrStanza(value: unknown, label = 'pitr.stanza'): string {
	if (typeof value !== 'string' || !PITR_STANZA_PATTERN.test(value))
		throw new ValidationError(`${label} must match ${PITR_STANZA_PATTERN}`);
	return value;
}

/** Derive the stanza from a validated database id; never from the wire. */
export function pitrStanzaFor(databaseId: string): string {
	return databaseId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function clean(value: unknown, label: string, max: number): string {
	if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new ValidationError(`${label} must not be empty`);
	if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
	if (/[\r\n\0]/.test(trimmed)) throw new ValidationError(`${label} must not contain line breaks`);
	return trimmed;
}

/** Validate the structured repository config handed to the helper over the privileged socket. */
export function parsePitrRepo(value: unknown, label = 'pitr.repo'): PitrRepoConfig {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new ValidationError(`${label} must be an object`);
	const record = value as Record<string, unknown>;
	if (record.kind !== 's3') throw new ValidationError(`${label}.kind must be "s3"`);

	const bucket = clean(record.bucket, `${label}.bucket`, 63);
	if (!BUCKET_PATTERN.test(bucket)) throw new ValidationError(`${label}.bucket is not a valid bucket name`);
	const region = clean(record.region, `${label}.region`, 63);
	if (!REGION_PATTERN.test(region)) throw new ValidationError(`${label}.region is not a valid region`);

	let endpoint: string | null = null;
	if (record.endpoint !== undefined && record.endpoint !== null) {
		endpoint = clean(record.endpoint, `${label}.endpoint`, 300);
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			throw new ValidationError(`${label}.endpoint must be an https URL`);
		}
		// pgBackRest speaks TLS to S3 only; a plain-HTTP endpoint could never archive a segment.
		if (url.protocol !== 'https:') throw new ValidationError(`${label}.endpoint must use https (pgBackRest has no plain-HTTP S3 client)`);
		if (url.username || url.password)
			throw new ValidationError(`${label}.endpoint must not embed credentials`);
		if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
			throw new ValidationError(`${label}.endpoint must be a bare origin (put the path in pathPrefix)`);
	}

	const rawPrefix = record.pathPrefix === undefined ? '' : record.pathPrefix;
	if (typeof rawPrefix !== 'string') throw new ValidationError(`${label}.pathPrefix must be a string`);
	const pathPrefix = rawPrefix.trim().replace(/^\/+|\/+$/g, '');
	if (!PREFIX_PATTERN.test(pathPrefix))
		throw new ValidationError(`${label}.pathPrefix contains unsupported characters`);
	if (pathPrefix && pathPrefix.split('/').some((part) => part === '.' || part === '..' || part === ''))
		throw new ValidationError(`${label}.pathPrefix must be normalized`);

	if (typeof record.forcePathStyle !== 'boolean')
		throw new ValidationError(`${label}.forcePathStyle must be a boolean`);

	const accessKeyId = clean(record.accessKeyId, `${label}.accessKeyId`, 128);
	if (!ACCESS_KEY_PATTERN.test(accessKeyId))
		throw new ValidationError(`${label}.accessKeyId must not contain whitespace`);
	const secretAccessKey = clean(record.secretAccessKey, `${label}.secretAccessKey`, 512);

	return {
		kind: 's3',
		endpoint,
		bucket,
		region,
		pathPrefix,
		forcePathStyle: record.forcePathStyle,
		accessKeyId,
		secretAccessKey,
	};
}

/**
 * The endpoint host and (non-default) port pgBackRest connects to. AWS S3 has no default in
 * pgBackRest, so a null endpoint becomes the regional AWS host.
 */
export function pitrRepoEndpoint(repo: Pick<PitrRepoConfig, 'endpoint' | 'region'>): { host: string; port: number | null } {
	if (!repo.endpoint) return { host: `s3.${repo.region}.amazonaws.com`, port: null };
	const url = new URL(repo.endpoint);
	return { host: url.hostname, port: url.port ? Number(url.port) : null };
}

/**
 * A restore target cannot be in the future or outside the repository retention window. The helper
 * checks this again even though the control plane validated it: the privileged side trusts no
 * value it did not parse itself.
 */
export function validatePitrTargetTime(
	value: unknown,
	now: number,
	retentionDays = PITR_RETENTION_FULL * 7 + PITR_RETENTION_DIFF,
): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
		throw new ValidationError('pitr.targetTime must be a positive epoch-millisecond timestamp');
	if (value > now) throw new ValidationError('pitr.targetTime is in the future');
	const oldest = now - retentionDays * 86_400_000;
	if (value < oldest)
		throw new ValidationError(`pitr.targetTime is older than the ${retentionDays}-day retention window`);
	return value;
}

/**
 * `--target` for `restore --type=time`. pgBackRest picks the backup set to restore from by parsing
 * this value itself, and its parser only understands `YYYY-MM-DD HH:MM:SS[.mmm][+/-TZ]`; an ISO
 * `T…Z` string silently falls back to the latest backup, which is newer than an older target and
 * makes recovery fail. Postgres accepts the same string for `recovery_target_time`.
 */
export function formatPitrTarget(epochMs: number): string {
	const iso = new Date(epochMs).toISOString(); // 2026-11-05T09:30:00.000Z
	return `${iso.slice(0, 10)} ${iso.slice(11, 23)}+00`;
}

export type PitrBaseBackupType = 'full' | 'diff' | 'incr';

export function parsePitrBackupType(value: unknown): PitrBaseBackupType {
	if (value !== 'full' && value !== 'diff' && value !== 'incr')
		throw new ValidationError('pitr.type must be full, diff or incr');
	return value;
}

export interface PgBackRestConfigOptions {
	stanza: string;
	repo: PitrRepoConfig;
	/** The database owner: a superuser that pgBackRest connects as over the Unix socket. */
	pg1User: string;
}

/**
 * pgBackRest INI. `repo1-path` is scoped by stanza so databases cannot read each other's WAL.
 * Postgres is reached over the container's Unix socket (pgBackRest must run beside Postgres), the
 * async spool lives on the data volume because the root filesystem is read-only, and file logging
 * is off so a busy archive cannot fill the 64 MB `/tmp`: warnings reach the journal via stderr.
 * `repo1-cipher-type=none` is deliberate: the repository lives in an encrypted-at-rest bucket and
 * the control plane does not hold a second key that a restore runbook would have to recover.
 */
export function renderPgBackRestConfig(options: PgBackRestConfigOptions): string {
	const { repo } = options;
	validatePitrStanza(options.stanza);
	if (!IDENTIFIER_PATTERN.test(options.pg1User)) throw new ValidationError('pitr pg1-user must be a plain identifier');
	const repoPath = [repo.pathPrefix, options.stanza].filter(Boolean).join('/');
	const endpoint = pitrRepoEndpoint(repo);
	const lines = [
		'# Generated by yoal-helper (docs/PITR.md). Do not edit; changes are overwritten.',
		'[global]',
		'repo1-type=s3',
		`repo1-s3-bucket=${repo.bucket}`,
		`repo1-s3-endpoint=${endpoint.host}`,
		...(endpoint.port ? [`repo1-storage-port=${endpoint.port}`] : []),
		`repo1-s3-region=${repo.region}`,
		`repo1-s3-key=${repo.accessKeyId}`,
		`repo1-s3-key-secret=${repo.secretAccessKey}`,
		`repo1-s3-uri-style=${repo.forcePathStyle ? 'path' : 'host'}`,
		`repo1-path=/${repoPath}`,
		'repo1-retention-full-type=count',
		`repo1-retention-full=${PITR_RETENTION_FULL}`,
		`repo1-retention-diff=${PITR_RETENTION_DIFF}`,
		'repo1-cipher-type=none',
		'archive-async=y',
		// Past this, pgBackRest drops queued WAL rather than fill the data volume; the archive then
		// reports failing and the next full backup restores a continuous window (docs/PITR.md).
		'archive-push-queue-max=1GiB',
		`spool-path=${PITR_SPOOL_PATH}`,
		'compress-type=zst',
		'compress-level=3',
		'process-max=2',
		'start-fast=y',
		'log-level-console=warn',
		'log-level-stderr=warn',
		'log-level-file=off',
		'lock-path=/tmp/pgbackrest-lock',
		'',
		`[${options.stanza}]`,
		`pg1-path=${PITR_PGDATA}`,
		`pg1-socket-path=${PITR_PG_SOCKET_PATH}`,
		`pg1-user=${options.pg1User}`,
		'',
	];
	return lines.join('\n');
}

/** `~/.pgpass` format: host:port:database:user:password, with `:` and `\` escaped. */
export function renderPgPass(user: string, password: string, host = '*', port = '*', database = '*'): string {
	const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
	return `${escape(host)}:${escape(port)}:${escape(database)}:${escape(user)}:${escape(password)}\n`;
}

/**
 * The per-database config directory, always inside the 0700 runtime dir. The directory (not the
 * files) is bind-mounted, so an atomic rewrite of the config is visible to the running container
 * without a restart.
 */
export function pitrPaths(runtimeDir: string, id: string): { dir: string; config: string; pgpass: string } {
	const dir = `${runtimeDir}/${id}/${PITR_CONFIG_DIRNAME}`;
	return {
		dir,
		config: `${dir}/${PITR_CONFIG_FILENAME}`,
		pgpass: `${dir}/${PITR_PGPASS_FILENAME}`,
	};
}

/** The database's own container, where base backups and status reads run. */
export function pitrContainerName(id: string): string {
	return `yoal-workload-${id}`;
}

/** The one-shot containers a restore runs against the target's data dir. */
export function pitrRestoreContainerName(targetId: string): string {
	return `yoal-pitr-restore-${targetId}`;
}
export function pitrRecoveryContainerName(targetId: string): string {
	return `yoal-pitr-recover-${targetId}`;
}

/**
 * `podman exec` of pgBackRest inside the running database container. `PGPASSFILE` covers a
 * pg_hba that asks for a password on the socket; the image's initdb trusts it.
 */
export function renderPitrExecArgs(options: { podmanPath: string; workloadId: string; args: string[] }): string[] {
	return [
		options.podmanPath,
		'exec',
		'--env',
		`PGPASSFILE=${PITR_CONTAINER_PGPASS_PATH}`,
		pitrContainerName(options.workloadId),
		'pgbackrest',
		`--config=${PITR_CONTAINER_CONFIG_PATH}`,
		...options.args,
	];
}

/** pgBackRest base backup argv (stanza-create first: it is idempotent and checks the cluster). */
export function renderPitrBackupArgs(stanza: string, type: PitrBaseBackupType): string[][] {
	return [
		[`--stanza=${stanza}`, 'stanza-create'],
		[`--stanza=${stanza}`, `--type=${type}`, 'backup'],
	];
}

/** Archive health: the archiver's own counters, as `archived|failed` epoch ms (0 = never). */
export const PITR_ARCHIVER_SQL =
	"SELECT coalesce((extract(epoch FROM last_archived_time) * 1000)::bigint, 0) || '|' || coalesce((extract(epoch FROM last_failed_time) * 1000)::bigint, 0) FROM pg_stat_archiver";

export function renderPitrArchiverArgs(options: { podmanPath: string; workloadId: string; user: string; database: string }): string[] {
	return [
		options.podmanPath,
		'exec',
		pitrContainerName(options.workloadId),
		'psql',
		'-h',
		PITR_PG_SOCKET_PATH,
		'-X',
		'-tA',
		'-U',
		options.user,
		'-d',
		options.database,
		'-c',
		PITR_ARCHIVER_SQL,
	];
}

export interface PitrOneShotOptions {
	podmanPath: string;
	image: string;
	targetId: string;
	/** Host data dir of the NEW database, mounted at /data. */
	targetDataDir: string;
	/** Host config directory of the SOURCE database (its stanza and repository). */
	configDir: string;
}

/**
 * Shared flags of the restore's one-shot containers: the engine uid, a read-only root, the
 * target's data dir and the source's config dir. The config dir is also mounted by the running
 * source, so it is relabelled shared (`z`); the target's data dir is private to this step.
 */
function oneShotMounts(options: PitrOneShotOptions): string[] {
	return [
		'--user',
		'70:70',
		'--read-only',
		'--tmpfs',
		'/tmp:rw,size=64m',
		'--volume',
		`${options.targetDataDir}:/data:Z`,
		'--volume',
		`${options.configDir}:${PITR_CONTAINER_CONFIG_DIR}:ro,z`,
	];
}

/** `pgbackrest restore --type=time` into the empty target data dir. */
export function renderPitrRestoreArgs(options: PitrOneShotOptions & { stanza: string; targetTime: number }): string[] {
	return [
		options.podmanPath,
		'run',
		'--rm',
		'--name',
		pitrRestoreContainerName(options.targetId),
		...oneShotMounts(options),
		'--entrypoint',
		'/usr/local/bin/pgbackrest',
		options.image,
		`--config=${PITR_CONTAINER_CONFIG_PATH}`,
		`--stanza=${options.stanza}`,
		`--pg1-path=${PITR_PGDATA}`,
		'--type=time',
		`--target=${formatPitrTarget(options.targetTime)}`,
		'--target-action=promote',
		'restore',
	];
}

/**
 * Replay WAL to the target in a detached one-shot Postgres (the image's entrypoint, so nss_wrapper
 * maps uid 70). TCP is off; `archive_mode` is off so the restored cluster never pushes WAL into
 * the source's stanza. `restore_command` (written by pgBackRest) reads the repository through the
 * same mounted config. The helper waits for promotion, then stops it cleanly.
 */
export function renderPitrRecoveryArgs(options: PitrOneShotOptions): string[] {
	return [
		options.podmanPath,
		'run',
		'--detach',
		'--name',
		pitrRecoveryContainerName(options.targetId),
		...oneShotMounts(options),
		'--tmpfs',
		`${PITR_PG_SOCKET_PATH}:rw,size=8m,mode=1777`,
		'--env',
		`PGDATA=${PITR_PGDATA}`,
		'--entrypoint',
		'/usr/local/bin/docker-entrypoint.sh',
		options.image,
		'postgres',
		'-c',
		'listen_addresses=',
		'-c',
		'archive_mode=off',
	];
}

/** `psql` over the recovery container's socket; SQL arrives on stdin or as a fixed `-c`. */
export function renderPitrRecoveryPsqlArgs(options: {
	podmanPath: string;
	targetId: string;
	user: string;
	command?: string;
}): string[] {
	return [
		options.podmanPath,
		'exec',
		...(options.command ? [] : ['-i']),
		pitrRecoveryContainerName(options.targetId),
		'psql',
		'-h',
		PITR_PG_SOCKET_PATH,
		'-X',
		'-v',
		'ON_ERROR_STOP=1',
		'-tA',
		'-U',
		options.user,
		'-d',
		'postgres',
		...(options.command ? ['-c', options.command] : []),
	];
}

export interface PitrRenameInput {
	/** The source's owner role and database, carried over by the physical restore. */
	sourceUser: string;
	sourceDatabase: string;
	/** The new database's own credentials (its env file). */
	targetUser: string;
	targetDatabase: string;
	targetPassword: string;
}

/**
 * A physical restore brings the SOURCE's owner role, password and database name. The new database
 * was created with its own; make the cluster match them. Three steps because the connected session
 * user cannot be renamed: (1) as the source owner create a temporary superuser, (2) as that role
 * rename the owner and its database, set the target's password and clear the recovery settings
 * pgBackRest wrote to postgresql.auto.conf, (3) as the renamed owner drop the temporary role.
 * Every value is validated first, so nothing can break out of a quoted identifier or literal.
 */
export function renderPitrRenameSql(input: PitrRenameInput): Array<{ user: string; sql: string }> {
	for (const [label, value] of [
		['source user', input.sourceUser],
		['source database', input.sourceDatabase],
		['target user', input.targetUser],
		['target database', input.targetDatabase],
	] as const)
		if (!IDENTIFIER_PATTERN.test(value)) throw new ValidationError(`pitr ${label} must be a plain identifier`);
	if (!PASSWORD_PATTERN.test(input.targetPassword))
		throw new ValidationError('pitr target password must be base64url (16–200 characters)');
	if (input.targetUser === PITR_RESTORE_ROLE || input.sourceUser === PITR_RESTORE_ROLE)
		throw new ValidationError(`${PITR_RESTORE_ROLE} is reserved`);
	const ident = (value: string) => `"${value}"`;
	const rename: string[] = [];
	if (input.sourceUser !== input.targetUser)
		rename.push(`ALTER ROLE ${ident(input.sourceUser)} RENAME TO ${ident(input.targetUser)};`);
	rename.push(`ALTER ROLE ${ident(input.targetUser)} WITH PASSWORD '${input.targetPassword}';`);
	if (input.sourceDatabase !== input.targetDatabase)
		rename.push(`ALTER DATABASE ${ident(input.sourceDatabase)} RENAME TO ${ident(input.targetDatabase)};`);
	rename.push(
		'ALTER SYSTEM RESET restore_command;',
		'ALTER SYSTEM RESET recovery_target_time;',
		'ALTER SYSTEM RESET recovery_target_action;',
	);
	return [
		{ user: input.sourceUser, sql: `CREATE ROLE ${ident(PITR_RESTORE_ROLE)} WITH LOGIN SUPERUSER;\n` },
		{ user: PITR_RESTORE_ROLE, sql: `${rename.join('\n')}\n` },
		{ user: input.targetUser, sql: `DROP ROLE ${ident(PITR_RESTORE_ROLE)};\n` },
	];
}

// ------------------------------------------------------------------ recoverable window

export interface PgBackRestInfoSummary {
	/** pgBackRest's stanza status: 0 ok, 2 no valid backups; anything else is a repository problem. */
	statusCode: number | null;
	statusMessage: string | null;
	backupCount: number;
	/** Stop time (epoch ms) of the oldest retained backup: the earliest consistent restore point. */
	oldestBackupStopAt: number | null;
	newestBackupStopAt: number | null;
	newestBackupType: PitrBaseBackupType | null;
}

/** Parse `pgbackrest info --output=json` for one stanza. Unknown shapes yield an empty summary. */
export function parsePgBackRestInfo(stdout: string, stanza: string): PgBackRestInfoSummary {
	const empty: PgBackRestInfoSummary = {
		statusCode: null,
		statusMessage: null,
		backupCount: 0,
		oldestBackupStopAt: null,
		newestBackupStopAt: null,
		newestBackupType: null,
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return empty;
	}
	if (!Array.isArray(parsed)) return empty;
	const entry = parsed.find(
		(item): item is Record<string, unknown> =>
			typeof item === 'object' && item !== null && (item as Record<string, unknown>).name === stanza,
	);
	if (!entry) return empty;
	const status = (entry.status ?? {}) as Record<string, unknown>;
	const backups = (Array.isArray(entry.backup) ? entry.backup : [])
		.map((backup) => {
			const record = (backup ?? {}) as Record<string, unknown>;
			const timestamp = (record.timestamp ?? {}) as Record<string, unknown>;
			const stop = typeof timestamp.stop === 'number' ? timestamp.stop * 1000 : null;
			const type = record.type === 'full' || record.type === 'diff' || record.type === 'incr' ? record.type : null;
			return { stop, type };
		})
		.filter((backup): backup is { stop: number; type: PitrBaseBackupType | null } => backup.stop !== null)
		.sort((a, b) => a.stop - b.stop);
	return {
		statusCode: typeof status.code === 'number' ? status.code : null,
		statusMessage: typeof status.message === 'string' ? status.message : null,
		backupCount: backups.length,
		oldestBackupStopAt: backups[0]?.stop ?? null,
		newestBackupStopAt: backups.at(-1)?.stop ?? null,
		newestBackupType: backups.at(-1)?.type ?? null,
	};
}

export interface PitrArchiverStats {
	lastArchivedAt: number | null;
	lastFailedAt: number | null;
}

/** Parse `PITR_ARCHIVER_SQL` output (`archived|failed`, 0 meaning never). */
export function parseArchiverStats(stdout: string): PitrArchiverStats | null {
	const match = /^(\d+)\|(\d+)$/.exec(stdout.trim());
	if (!match) return null;
	const archived = Number(match[1]);
	const failed = Number(match[2]);
	return { lastArchivedAt: archived > 0 ? archived : null, lastFailedAt: failed > 0 ? failed : null };
}

export interface PitrWindow {
	/** Earliest restorable instant (epoch ms), or null when the repository holds no backup yet. */
	recoverableFrom: number | null;
	/** Latest restorable instant: the last archived WAL, never earlier than the newest backup. */
	recoverableTo: number | null;
	archiveStatus: 'ok' | 'failing' | 'unknown';
}

/**
 * The recoverable window. A time restore needs a backup that finished before the target and every
 * WAL segment from that backup to the target: the window opens at the oldest retained backup's
 * stop and closes at the archiver's last success (pgBackRest's `backup` waits for its own WAL, so
 * the newest backup's stop is always covered). The archive is `failing` when its last failure is
 * newer than its last success; a failing archive still reports the window up to the last success.
 */
export function computePitrWindow(info: PgBackRestInfoSummary, archiver: PitrArchiverStats | null): PitrWindow {
	let archiveStatus: PitrWindow['archiveStatus'] = 'unknown';
	if (archiver) {
		if (archiver.lastFailedAt !== null && archiver.lastFailedAt >= (archiver.lastArchivedAt ?? 0)) archiveStatus = 'failing';
		else if (archiver.lastArchivedAt !== null) archiveStatus = 'ok';
	}
	if (info.oldestBackupStopAt === null || info.newestBackupStopAt === null)
		return { recoverableFrom: null, recoverableTo: null, archiveStatus };
	const archivedTo = archiver?.lastArchivedAt ?? null;
	return {
		recoverableFrom: info.oldestBackupStopAt,
		recoverableTo: Math.max(info.newestBackupStopAt, archivedTo ?? 0),
		archiveStatus,
	};
}
