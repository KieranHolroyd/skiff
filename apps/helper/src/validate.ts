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
		const value = assertString(raw, `${label}.${key}`, { max: MAX_ENV_VALUE });
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

	const dataSizeMb =
		record.dataSizeMb === null || record.dataSizeMb === undefined
			? null
			: assertInteger(record.dataSizeMb, 'workload.dataSizeMb', 32, 65_536);

	const workload: WorkloadDesired = {
		id: assertId(record.id, 'workload.id'),
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
		secrets: parseSecrets(record.secrets),
		dataSizeMb,
	};
	if (command) workload.command = command;
	if (image) workload.image = image;
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
