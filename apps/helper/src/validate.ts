/**
 * Validation for everything that crosses the helper socket. The helper is the last line of
 * defence for a privileged process: it never trusts the control plane or the agent, never sees a
 * shell string, and rejects anything it cannot render as a fixed systemd unit.
 *
 * This module deliberately does not import `@skiff/contracts`: the helper ships without runtime
 * dependencies and validates the wire shape itself, so a compromised contract package cannot
 * widen the privileged surface.
 */

export const WORKLOAD_RUNTIMES = ['process', 'container'] as const;
export type WorkloadRuntime = (typeof WORKLOAD_RUNTIMES)[number];

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

const MAX_ID_LENGTH = 100;
const MAX_ENV_VALUE = 16_384;
const MAX_COMMAND_ARG = 1024;
const MAX_COMMAND_ARGS = 64;
const MAX_SECRETS = 128;
const MAX_SECRET_BYTES = 1_048_576;
const MAX_ACTIVATION_BYTES = 4_194_304;

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

export interface WorkloadDesired {
	id: string;
	projectId: string;
	projectSlug: string;
	deploymentId: string;
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
	/** Node volume for the data dir (D74); resolved and verified against the helper's registry. */
	volumeId?: string;
}

/**
 * The helper's own copy of the engine registry (D61). It is deliberately not imported from
 * `@skiff/contracts`: a wider contract must not widen what the privileged helper will run.
 */
export const DATABASE_ENGINES = {
	postgres: {
		versions: ['16', '17'],
		/** The official image's `postgres` user and group. */
		uid: 70,
		gid: 70,
		containerPort: 5432,
		image: (version: string) => `docker.io/library/postgres:${version}-alpine`,
	},
} as const;
export type DatabaseEngine = keyof typeof DATABASE_ENGINES;

export interface WorkloadDatabase {
	engine: DatabaseEngine;
	version: string;
	/** WAL archiving for PITR (docs/PITR.md); omitted when the feature is off. */
	pitr?: { stanza: string; archiveTimeoutSeconds: number };
}

/** Workload ids of managed databases carry this prefix; `purge` accepts these and `st_` ids. */
export const DATABASE_ID_PREFIX = 'db_';

/** The image the helper runs for a database profile. */
export function databaseImage(database: WorkloadDatabase): string {
	return DATABASE_ENGINES[database.engine].image(database.version);
}

/** `db-<hex>`: DNS alias on the `skiff-workloads` network (same derivation as the contract). */
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
		if (key !== 'engine' && key !== 'version' && key !== 'pitr')
			throw new ValidationError(`${label}.${key} is not supported`);
	}
	const parsed: WorkloadDatabase = { engine: engine as DatabaseEngine, version };
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

/** `s3-<hex>`: DNS alias on the `skiff-workloads` network (same derivation as the contract). */
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

/** A managed-service id (`db_` or `st_`): the only ids whose data dir `purge` may delete. */
export function assertManagedId(value: unknown, label = 'managed id'): string {
	const id = assertId(value, label);
	for (const prefix of [DATABASE_ID_PREFIX, STORAGE_ID_PREFIX]) {
		if (id.startsWith(prefix) && id.length > prefix.length) return id;
	}
	throw new ValidationError(`${label} must start with "${DATABASE_ID_PREFIX}" or "${STORAGE_ID_PREFIX}"`);
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

/** Validate and normalize the workload half of `POST /v1/workloads`. */
export function parseWorkload(value: unknown): WorkloadDesired {
	const record = assertRecord(value, 'workload');
	const runtime = record.runtime;
	if (runtime !== 'process' && runtime !== 'container')
		throw new ValidationError('workload.runtime must be "process" or "container"');
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

	const database = record.database === undefined ? undefined : parseDatabase(record.database);
	const objectStorage =
		record.objectStorage === undefined ? undefined : parseObjectStorage(record.objectStorage);
	if (database && objectStorage)
		throw new ValidationError('A workload cannot have both a database and an objectStorage profile');
	const id = assertId(record.id, 'workload.id');
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

	const dataSizeMb =
		record.dataSizeMb === null || record.dataSizeMb === undefined
			? null
			: assertInteger(record.dataSizeMb, 'workload.dataSizeMb', 32, 65_536);

	const workload: WorkloadDesired = {
		id,
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
	if (database) workload.database = database;
	if (record.pooler !== undefined) {
		if (!database) throw new ValidationError('workload.pooler is only valid for a database workload');
		const pooler = assertRecord(record.pooler, 'workload.pooler');
		workload.pooler = { port: assertPort(pooler.port, 'workload.pooler.port') };
	}
	if (objectStorage) workload.objectStorage = objectStorage;
	const volumeId = record.volumeId === undefined ? undefined : assertId(record.volumeId, 'workload.volumeId');
	if (volumeId) {
		// Volumes hold managed-service data (D74); an app workload never mounts one.
		if (!database && !objectStorage)
			throw new ValidationError('workload.volumeId is only valid for a database or objectStorage workload');
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

/** Parse the full helper apply body. */
export function parseApplyRequest(value: unknown): {
	workload: WorkloadDesired;
	activation: WorkloadActivation;
} {
	const record = assertRecord(value, 'request');
	const workload = parseWorkload(record.workload);
	const activation = parseActivation(record.activation, workload);
	return { workload, activation };
}
