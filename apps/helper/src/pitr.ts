import { ValidationError } from './validate.ts';

/**
 * pgBackRest data path for PITR (docs/PITR.md). Pure renderers and validators only; the
 * `SystemdDriver` runs the fixed podman argv. Nothing here accepts a shell string.
 *
 * The Postgres container performs WAL archiving, which means the pinned Postgres image used for
 * PITR-enabled databases must ship the `pgbackrest` binary. The stock `postgres:*-alpine` image
 * does not; this is an explicit image requirement, not a silent fallback to logical dumps.
 */

/** Community pgBackRest image pinned by digest; the helper chooses it, never the wire. */
export const PITR_PGBACKREST_IMAGE =
	'docker.io/woblerr/pgbackrest:2.59.3@sha256:299eae66d34553ebabe5245365fbcc81acd5c6dc911f5cfcd8a855797e35a08e';

/** Absolute path inside the Postgres container; the helper writes the 0400 host file. */
export const PITR_CONTAINER_CONFIG_PATH = '/etc/pgbackrest/pgbackrest.conf';
export const PITR_CONTAINER_PGPASS_PATH = '/etc/pgbackrest/pgpass';
export const PITR_CONFIG_FILENAME = 'pgbackrest.conf';
export const PITR_PGPASS_FILENAME = 'pgpass';
export const PITR_ARCHIVE_TIMEOUT_SECONDS = 60;
/** Weekly full and daily differential base backups, at 02:00 UTC. */
export const PITR_FULL_SCHEDULE = '0 2 * * 0';
export const PITR_DIFF_SCHEDULE = '0 2 * * 1-6';
export const PITR_RETENTION_FULL = 4;
export const PITR_RETENTION_DIFF = 7;

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
			throw new ValidationError(`${label}.endpoint must be an http(s) URL`);
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:')
			throw new ValidationError(`${label}.endpoint must use http or https`);
		if (url.username || url.password)
			throw new ValidationError(`${label}.endpoint must not embed credentials`);
	}

	const rawPrefix = record.pathPrefix === undefined ? '' : record.pathPrefix;
	if (typeof rawPrefix !== 'string') throw new ValidationError(`${label}.pathPrefix must be a string`);
	const pathPrefix = rawPrefix.trim().replace(/^\/+|\/+$/g, '');
	if (!PREFIX_PATTERN.test(pathPrefix))
		throw new ValidationError(`${label}.pathPrefix contains unsupported characters`);
	if (pathPrefix.split('/').some((part) => part === '.' || part === '..' || part === ''))
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

export type PitrBaseBackupType = 'full' | 'diff' | 'incr';

export function parsePitrBackupType(value: unknown): PitrBaseBackupType {
	if (value !== 'full' && value !== 'diff' && value !== 'incr')
		throw new ValidationError('pitr.type must be full, diff or incr');
	return value;
}

export interface PgBackRestConfigOptions {
	stanza: string;
	repo: PitrRepoConfig;
	/** Absolute path inside the sidecar/Postgres container. */
	pg1Path: string;
	/** DNS alias of the database container on the workload network, when the sidecar needs it. */
	pg1Host?: string | null;
	pg1Port?: number;
	pg1User?: string | null;
}

/**
 * pgBackRest INI. `repo1-path` is scoped by stanza so databases cannot read each other's WAL.
 * `repo1-cipher-type=none` is deliberate: the repository lives in an encrypted-at-rest bucket and
 * the control plane does not hold a second key that a restore runbook would have to recover.
 */
export function renderPgBackRestConfig(options: PgBackRestConfigOptions): string {
	const { repo } = options;
	const repoPath = [repo.pathPrefix, options.stanza].filter(Boolean).join('/');
	const lines = [
		'[global]',
		'repo1-type=s3',
		`repo1-s3-bucket=${repo.bucket}`,
		...(repo.endpoint ? [`repo1-s3-endpoint=${repo.endpoint}`] : []),
		`repo1-s3-region=${repo.region}`,
		`repo1-s3-key=${repo.accessKeyId}`,
		`repo1-s3-key-secret=${repo.secretAccessKey}`,
		...(repo.forcePathStyle ? ['repo1-s3-uri-style=path'] : []),
		`repo1-path=/${repoPath}`,
		`repo1-retention-full=${PITR_RETENTION_FULL}`,
		`repo1-retention-diff=${PITR_RETENTION_DIFF}`,
		'repo1-cipher-type=none',
		'archive-async=y',
		'archive-push-queue-max=1gb',
		'compress-type=zst',
		'compress-level=3',
		'process-max=2',
		'log-level-console=info',
		'log-level-file=detail',
		'log-path=/tmp/pgbackrest-log',
		'lock-path=/tmp/pgbackrest-lock',
		'',
		`[${options.stanza}]`,
		`pg1-path=${options.pg1Path}`,
		// A sidecar reaches Postgres over the shared container network. The archive-push run in the
		// Postgres container does not use these keys.
		...(options.pg1Host ? [`pg1-host=${options.pg1Host}`] : []),
		...(options.pg1Host ? [`pg1-port=${options.pg1Port ?? 5432}`] : []),
		...(options.pg1User ? [`pg1-user=${options.pg1User}`] : []),
		'',
	];
	return lines.join('\n');
}

/** `~/.pgpass` format: host:port:database:user:password, with `:` and `\` escaped. */
export function renderPgPass(user: string, password: string, host = '*', port = '*', database = '*'): string {
	const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
	return `${escape(host)}:${escape(port)}:${escape(database)}:${escape(user)}:${escape(password)}\n`;
}

/** pgBackRest config path for one managed workload; always inside the 0700 runtime dir. */
export function pitrPaths(runtimeDir: string, id: string): { dir: string; config: string; pgpass: string } {
	const dir = `${runtimeDir}/${id}`;
	return {
		dir,
		config: `${dir}/${PITR_CONFIG_FILENAME}`,
		pgpass: `${dir}/${PITR_PGPASS_FILENAME}`,
	};
}

export interface PitrPodmanOptions {
	podmanPath: string;
	image?: string;
	workloadId: string;
	dataDir: string;
	configPath: string;
	pgpassPath: string;
	/** Join the workload network for a base backup, which needs the Postgres connection. */
	network?: boolean;
	args: string[];
}

/**
 * Fixed argv for a one-shot pgBackRest sidecar. The data volume is the only writable mount; config
 * and `.pgpass` are read-only. `--userns=keep-id` is not used because the Postgres data dir is
 * chowned to uid 70 before the container starts.
 */
export function renderPitrPodmanArgs(options: PitrPodmanOptions): string[] {
	const args = [
		options.podmanPath,
		'run',
		'--rm',
		'--name',
		`skiff-pitr-${options.workloadId}`,
		'--user',
		'70:70',
		'--volume',
		`${options.dataDir}:/data:Z`,
		'--volume',
		`${options.configPath}:${PITR_CONTAINER_CONFIG_PATH}:ro,Z`,
		'--volume',
		`${options.pgpassPath}:${PITR_CONTAINER_PGPASS_PATH}:ro,Z`,
		'--env',
		'PGPASSFILE=/etc/pgbackrest/pgpass',
	];
	if (options.network) args.push('--network', 'skiff-workloads');
	args.push(options.image ?? PITR_PGBACKREST_IMAGE, 'pgbackrest');
	args.push(`--config=${PITR_CONTAINER_CONFIG_PATH}`);
	args.push(...options.args);
	return args;
}
