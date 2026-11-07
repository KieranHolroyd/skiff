/**
 * Build a Skiff function bundle from a wrangler project (docs/FUNCTIONS.md §4.3, FN8, D113).
 *
 * Skiff's own bundler (`worker-bundler.ts`, esbuild pinned in the CLI) compiles the Worker; this
 * module writes the modules into a fresh directory, generates the internal `skiff-function.json`
 * manifest, and copies the configured assets directory. The manifest never touches the user's
 * project, and Wrangler is never run: the wrangler config is only read.
 *
 * The control plane validates and never bundles (D2), so the manifest is generated here and
 * uploaded alongside the modules.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from './errors.ts';
import { formatBytes } from './output.ts';
import { CLI_LIMITS } from './zip.ts';
import { readWranglerConfig, type WranglerConfig } from './wrangler.ts';
import { bundlePythonWorker, isPythonMain, readPythonBuildSettings } from './python-bundler.ts';
import {
	BUNDLER_DISPLAY,
	bundleWorker,
	readBuildSettings,
	type BuildCommandRunner,
	type WorkerModuleType,
} from './worker-bundler.ts';

export type FunctionModuleType = WorkerModuleType;

export interface FunctionModuleEntry {
	name: string;
	type: FunctionModuleType;
	sha256: string;
}

/** A manifest binding. The control plane validates the exact shape per `type`. */
export type ManifestBinding = { name: string; type: string } & Record<string, unknown>;

/** One `triggers.queues` entry (Wrangler `queues.consumers`, D112). */
export interface QueueConsumerEntry {
	queue: string;
	broker?: string;
	maxBatchSize?: number;
	maxBatchTimeout?: number;
	maxRetries?: number;
	retryDelay?: number;
	deadLetterQueue?: string;
}

export interface FunctionAssets {
	directory: string;
	runWorkerFirst: string[];
}

export interface FunctionManifest {
	version: 1;
	main: string;
	modules: FunctionModuleEntry[];
	compatibilityDate: string;
	compatibilityFlags: string[];
	bindings: ManifestBinding[];
	triggers: { crons: string[]; queues: QueueConsumerEntry[] };
	assets?: FunctionAssets;
	idleStopSeconds?: number;
	memoryMb?: number;
	cpus?: number;
}

export interface BuiltFunctionBundle {
	/** Directory holding the modules, assets and `skiff-function.json`. */
	dir: string;
	/** Temporary parent; remove it with `cleanup()`. */
	tempDir: string;
	config: WranglerConfig;
	manifest: FunctionManifest;
	moduleCount: number;
	assetCount: number;
	assetBytes: number;
	warnings: string[];
	cleanup(): Promise<void>;
}

export interface BuildFunctionBundleOptions {
	config: WranglerConfig;
	log?: (message: string) => void;
	/** Injected runner for the config's `build.command` (tests). */
	runBuildCommand?: BuildCommandRunner;
	/** Project-scoped secret names, auto-bound so users do not declare them twice. */
	projectSecrets?: string[];
}

export interface BindingMapContext {
	label: string;
	/** Wrangler's `name`; a `service` equal to it means "this worker". */
	workerName?: string;
	projectSecrets?: string[];
}

/** Wrangler top-level keys Skiff cannot back; naming them beats silently dropping them. */
const UNSUPPORTED_BINDINGS = [
	'ai',
	'browser',
	'vectorize',
	'images',
	'send_email',
	'containers',
	'mtls_certificates',
	'dispatch_namespaces',
	'workflows',
] as const;

const ASSET_EXCLUDES = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * Bundle the Worker with Skiff's pinned bundler and assemble a deployable directory with a
 * manifest.
 * On success the caller owns the temporary directory and must call `cleanup()`.
 */
export async function buildFunctionBundle(
	options: BuildFunctionBundleOptions,
): Promise<BuiltFunctionBundle> {
	const label = basename(options.config.path);
	const config = await readWranglerConfig(options.config);
	const compatibilityDate = requiredString(
		config.compatibility_date,
		label,
		'compatibility_date is required. Add "compatibility_date": "YYYY-MM-DD" to your wrangler config.',
	);
	const workerName = optionalString(config.name, label, 'name');
	const compatibilityFlags = stringList(config.compatibility_flags, label, 'compatibility_flags');
	const triggers = recordOf(config.triggers, label, 'triggers');
	const crons = stringList(triggers?.crons, label, 'triggers.crons');
	const skiff = parseSkiffSettings(config.skiff, label);
	const queueConsumers = mapQueueConsumers(config, label, skiff.brokers);
	const { bindings, assets } = mapWranglerBindings(config, {
		label,
		workerName,
		projectSecrets: options.projectSecrets,
	});

	// A `.py` main is a Python Worker (D121): no esbuild, just its sources and python_modules/.
	const python = isPythonMain(config);
	const buildSettings = python
		? null
		: readBuildSettings(config, options.config.path, {
				date: compatibilityDate,
				flags: compatibilityFlags,
			});

	const tempDir = await mkdtemp(join(tmpdir(), 'skiff-fn-'));
	const cleanup = async (): Promise<void> => {
		await rm(tempDir, { recursive: true, force: true });
	};

	try {
		const bundleDir = join(tempDir, 'bundle');
		await mkdir(bundleDir, { recursive: true });

		options.log?.(python ? 'Collecting the Python Worker...' : `Bundling with the ${BUNDLER_DISPLAY}...`);
		const worker = buildSettings
			? await bundleWorker(buildSettings, { log: options.log, runCommand: options.runBuildCommand })
			: await bundlePythonWorker(readPythonBuildSettings(config, options.config.path), {
					log: options.log,
					runCommand: options.runBuildCommand,
				});
		const main = worker.main;

		const modules: FunctionModuleEntry[] = [];
		for (const module of worker.modules) {
			const destination = join(bundleDir, ...module.name.split('/'));
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, module.data);
			modules.push({ name: module.name, type: module.type, sha256: sha256(module.data) });
		}

		let assetCount = 0;
		let assetBytes = 0;
		const warnings: string[] = [...worker.warnings];
		if (assets) {
			// Wrangler resolves `main` and `assets.directory` relative to the config file, so do the
			// same even when `--wrangler <path>` points outside the deployed directory.
			const source = resolve(dirname(options.config.path), ...assets.directory.split('/'));
			const destination = join(bundleDir, ...assets.directory.split('/'));
			const copied = await copyAssets(source, destination, assets.directory);
			assetCount = copied.files;
			assetBytes = copied.bytes;
			warnings.push(...copied.warnings);
			options.log?.(`Assets: ${assetCount} files (${formatBytes(assetBytes)}) from ${assets.directory}.`);
		}

		const manifest: FunctionManifest = {
			version: 1,
			main,
			modules,
			compatibilityDate,
			compatibilityFlags,
			bindings,
			triggers: { crons, queues: queueConsumers },
			...(assets ? { assets } : {}),
			...(skiff.idleStopSeconds !== undefined ? { idleStopSeconds: skiff.idleStopSeconds } : {}),
			...(skiff.memoryMb !== undefined ? { memoryMb: skiff.memoryMb } : {}),
			...(skiff.cpus !== undefined ? { cpus: skiff.cpus } : {}),
		};
		await writeFile(join(bundleDir, 'skiff-function.json'), `${JSON.stringify(manifest, null, 2)}\n`);

		return {
			dir: bundleDir,
			tempDir,
			config: options.config,
			manifest,
			moduleCount: modules.length,
			assetCount,
			assetBytes,
			warnings,
			cleanup,
		};
	} catch (error) {
		await cleanup().catch(() => {});
		throw error;
	}
}

/**
 * Map a wrangler config's bindings onto `skiff-function.json`, by binding name. Cloudflare
 * account ids are ignored; the `skiff` section supplies the Skiff-side resource names.
 */
export function mapWranglerBindings(
	config: Record<string, unknown>,
	context: BindingMapContext,
): { bindings: ManifestBinding[]; assets: FunctionAssets | null } {
	const { label } = context;
	for (const key of UNSUPPORTED_BINDINGS) {
		if (config[key] !== undefined && config[key] !== null)
			throw new CliError(
				`${label}: "${key}" is not supported by Skiff Functions. Remove the ${key} binding or deploy this Worker to Cloudflare.`,
				{ code: 'unsupported_binding' },
			);
	}

	const skiff = parseSkiffSettings(config.skiff, label);
	const bindings = new Map<string, ManifestBinding>();
	const add = (binding: ManifestBinding): void => {
		bindings.set(binding.name, binding);
	};

	const vars = recordOf(config.vars, label, 'vars');
	if (vars) {
		for (const [name, value] of Object.entries(vars)) {
			add(
				typeof value === 'string'
					? { name, type: 'text', value }
					: { name, type: 'json', value },
			);
		}
	}

	for (const value of arrayOf(config.kv_namespaces, label, 'kv_namespaces')) {
		const entry = entryOf(value, label, 'kv_namespaces');
		add({ name: requiredField(entry, 'binding', label, 'kv_namespaces'), type: 'kv' });
	}

	for (const value of arrayOf(config.d1_databases, label, 'd1_databases')) {
		const entry = entryOf(value, label, 'd1_databases');
		const name = requiredField(entry, 'binding', label, 'd1_databases');
		add({
			name,
			type: 'd1',
			database: optionalField(entry, 'database_name', label, 'd1_databases') ?? name,
		});
	}

	for (const value of arrayOf(config.r2_buckets, label, 'r2_buckets')) {
		const entry = entryOf(value, label, 'r2_buckets');
		const name = requiredField(entry, 'binding', label, 'r2_buckets');
		const bucket = optionalField(entry, 'bucket_name', label, 'r2_buckets') ?? name;
		const prefix = optionalField(entry, 'prefix', label, 'r2_buckets');
		add({
			name,
			type: 'r2',
			storage: skiff.storage[name] ?? bucket,
			bucket,
			...(prefix ? { prefix } : {}),
		});
	}

	const durableObjects = recordOf(config.durable_objects, label, 'durable_objects');
	for (const value of arrayOf(durableObjects?.bindings, label, 'durable_objects.bindings')) {
		const entry = entryOf(value, label, 'durable_objects.bindings');
		add({
			name: requiredField(entry, 'name', label, 'durable_objects.bindings'),
			type: 'durable_object',
			className: requiredField(entry, 'class_name', label, 'durable_objects.bindings'),
		});
	}

	for (const value of arrayOf(config.hyperdrive, label, 'hyperdrive')) {
		const entry = entryOf(value, label, 'hyperdrive');
		const name = requiredField(entry, 'binding', label, 'hyperdrive');
		add({ name, type: 'hyperdrive', database: skiff.hyperdrive[name] ?? name });
	}

	for (const value of arrayOf(config.analytics_engine_datasets, label, 'analytics_engine_datasets')) {
		const entry = entryOf(value, label, 'analytics_engine_datasets');
		const name = requiredField(entry, 'binding', label, 'analytics_engine_datasets');
		add({
			name,
			type: 'analytics_engine',
			dataset: optionalField(entry, 'dataset', label, 'analytics_engine_datasets') ?? name,
		});
	}

	const queues = recordOf(config.queues, label, 'queues');
	for (const value of arrayOf(queues?.producers, label, 'queues.producers')) {
		const entry = entryOf(value, label, 'queues.producers');
		const queue = requiredField(entry, 'queue', label, 'queues.producers');
		add({
			name: requiredField(entry, 'binding', label, 'queues.producers'),
			type: 'queue',
			queue,
			// Queues live on a managed broker (D112); `skiff.brokers` names it per queue, otherwise the
			// project's only attached broker is used.
			...(skiff.brokers[queue] ? { broker: skiff.brokers[queue] } : {}),
		});
	}

	for (const value of arrayOf(config.services, label, 'services')) {
		const entry = entryOf(value, label, 'services');
		const name = requiredField(entry, 'binding', label, 'services');
		const service = requiredField(entry, 'service', label, 'services');
		const entrypoint = optionalField(entry, 'entrypoint', label, 'services');
		if (service === 'self' || (context.workerName !== undefined && service === context.workerName)) {
			if (!entrypoint)
				throw new CliError(
					`${label}: service binding "${name}" targets this Worker but has no entrypoint. Add "entrypoint" to the service binding.`,
					{ code: 'wrangler_config' },
				);
			add({ name, type: 'service', entrypoint });
		} else {
			add({ name, type: 'app', project: service, ...(entrypoint ? { entrypoint } : {}) });
		}
	}

	let assets: FunctionAssets | null = null;
	if (config.assets !== undefined && config.assets !== null && config.assets !== false) {
		const entry = entryOf(config.assets, label, 'assets');
		const directory = normalizeAssetDirectory(
			requiredString(
				entry.directory,
				label,
				'assets.directory is required when the assets block is present.',
			),
			label,
		);
		assets = { directory, runWorkerFirst: parseRunWorkerFirst(entry.run_worker_first, label) };
		add({ name: optionalField(entry, 'binding', label, 'assets') ?? 'ASSETS', type: 'assets' });
	}

	// Project-scoped secrets are bound automatically so a secret exists once, not twice. An
	// organisation-scoped secret is never added: those are not this project's to expose.
	for (const name of context.projectSecrets ?? []) {
		if (typeof name === 'string' && name.length > 0) add({ name, type: 'secret' });
	}

	for (const name of skiff.secrets) add({ name, type: 'secret' });

	// `skiff.bindings` is merged last so it can add secret references or override a mapped name.
	for (const value of skiff.bindings) {
		const entry = entryOf(value, label, 'skiff.bindings');
		add({
			...entry,
			name: requiredField(entry, 'name', label, 'skiff.bindings'),
			type: requiredField(entry, 'type', label, 'skiff.bindings'),
		});
	}

	return { bindings: [...bindings.values()], assets };
}

interface SkiffSettings {
	storage: Record<string, string>;
	/** Queue name → managed broker name (D112). */
	brokers: Record<string, string>;
	hyperdrive: Record<string, string>;
	secrets: string[];
	bindings: unknown[];
	idleStopSeconds?: number;
	memoryMb?: number;
	cpus?: number;
}

/**
 * Read the optional top-level `skiff` object. Wrangler ignores unknown top-level keys, so the
 * same file runs on Cloudflare and Skiff.
 */
export function parseSkiffSettings(value: unknown, label: string): SkiffSettings {
	const record = recordOf(value, label, 'skiff') ?? {};
	return {
		storage: stringMap(record.storage, label, 'skiff.storage'),
		brokers: stringMap(record.brokers, label, 'skiff.brokers'),
		hyperdrive: stringMap(record.hyperdrive, label, 'skiff.hyperdrive'),
		secrets: stringList(record.secrets, label, 'skiff.secrets'),
		bindings: arrayOf(record.bindings, label, 'skiff.bindings'),
		idleStopSeconds: numberField(record.idleStopSeconds, label, 'skiff.idleStopSeconds'),
		memoryMb: numberField(record.memoryMb, label, 'skiff.memoryMb'),
		cpus: numberField(record.cpus, label, 'skiff.cpus'),
	};
}

function normalizeAssetDirectory(value: string, label: string): string {
	const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
	const parts = normalized.split('/');
	if (
		!normalized ||
		normalized.startsWith('/') ||
		/^[A-Za-z]:/.test(normalized) ||
		parts.some((part) => part === '' || part === '.' || part === '..')
	)
		throw new CliError(
			`${label}: assets.directory must be a relative path inside the project (got "${value}").`,
			{ code: 'wrangler_config' },
		);
	return parts.join('/');
}

function parseRunWorkerFirst(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (value === true) return ['/*'];
	if (value === false) return [];
	if (!Array.isArray(value))
		throw new CliError(`${label}: assets.run_worker_first must be an array of globs or a boolean.`, {
			code: 'wrangler_config',
		});
	return value.map((item, index) => {
		if (typeof item !== 'string' || item.length === 0)
			throw new CliError(`${label}: assets.run_worker_first[${index}] must be a non-empty string.`, {
				code: 'wrangler_config',
			});
		return item;
	});
}

async function copyAssets(
	source: string,
	destination: string,
	label: string,
): Promise<{ files: number; bytes: number; warnings: string[] }> {
	let info;
	try {
		info = await stat(source);
	} catch (error) {
		throw new CliError(`assets.directory "${label}" was not found in the project directory.`, {
			code: 'wrangler_config',
			cause: error,
		});
	}
	if (!info.isDirectory())
		throw new CliError(`assets.directory "${label}" is not a directory.`, { code: 'wrangler_config' });

	const warnings: string[] = [];
	let files = 0;
	let bytes = 0;

	const walk = async (dir: string, relativeDir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (ASSET_EXCLUDES.has(entry.name)) continue;
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symlink ${label}/${relativePath}`);
				continue;
			}
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), relativePath);
				continue;
			}
			if (!entry.isFile()) {
				warnings.push(`Skipped special file ${label}/${relativePath}`);
				continue;
			}
			const statInfo = await stat(join(dir, entry.name));
			if (statInfo.size > CLI_LIMITS.fileBytes)
				throw new CliError(
					`"${label}/${relativePath}" is ${formatBytes(statInfo.size)}; the per-file limit is ${formatBytes(CLI_LIMITS.fileBytes)}.`,
				);
			bytes += statInfo.size;
			if (bytes > CLI_LIMITS.artifactBytes)
				throw new CliError(
					`The assets in "${label}" are larger than ${formatBytes(CLI_LIMITS.artifactBytes)} (the artifact limit).`,
				);
			files++;
			if (files > CLI_LIMITS.files)
				throw new CliError(
					`Too many asset files in "${label}"; the limit is ${CLI_LIMITS.files.toLocaleString('en-US')}.`,
				);
			const target = join(destination, ...relativePath.split('/'));
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(dir, entry.name), target);
		}
	};

	await walk(source, '');
	if (files === 0)
		throw new CliError(`assets.directory "${label}" is empty; there is nothing to upload.`, {
			code: 'wrangler_config',
		});
	return { files, bytes, warnings };
}

function sha256(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

function recordOf(value: unknown, label: string, what: string): Record<string, unknown> | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value))
		throw new CliError(`${label}: ${what} must be an object.`, { code: 'wrangler_config' });
	return value as Record<string, unknown>;
}

function entryOf(value: unknown, label: string, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new CliError(`${label}: ${what} entries must be objects.`, { code: 'wrangler_config' });
	return value as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string, what: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new CliError(`${label}: ${what} must be an array.`, { code: 'wrangler_config' });
	return value;
}

function stringList(value: unknown, label: string, what: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new CliError(`${label}: ${what} must be an array of strings.`, { code: 'wrangler_config' });
	return value.map((item, index) => {
		if (typeof item !== 'string' || item.length === 0)
			throw new CliError(`${label}: ${what}[${index}] must be a non-empty string.`, {
				code: 'wrangler_config',
			});
		return item;
	});
}

function stringMap(value: unknown, label: string, what: string): Record<string, string> {
	const record = recordOf(value, label, what);
	if (!record) return {};
	for (const [key, item] of Object.entries(record)) {
		if (typeof item !== 'string' || item.length === 0)
			throw new CliError(`${label}: ${what}.${key} must be a non-empty string.`, {
				code: 'wrangler_config',
			});
	}
	return record as Record<string, string>;
}

function optionalField(
	entry: Record<string, unknown>,
	key: string,
	label: string,
	what: string,
): string | undefined {
	const value = entry[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length === 0)
		throw new CliError(`${label}: ${what}.${key} must be a non-empty string.`, {
			code: 'wrangler_config',
		});
	return value;
}

function requiredField(
	entry: Record<string, unknown>,
	key: string,
	label: string,
	what: string,
): string {
	const value = optionalField(entry, key, label, what);
	if (value === undefined)
		throw new CliError(`${label}: ${what} entries need a "${key}".`, { code: 'wrangler_config' });
	return value;
}

function requiredString(value: unknown, label: string, message: string): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new CliError(`${label}: ${message}`, { code: 'wrangler_config' });
	return value;
}

function optionalString(value: unknown, label: string, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length === 0)
		throw new CliError(`${label}: ${what} must be a non-empty string.`, { code: 'wrangler_config' });
	return value;
}

function numberField(value: unknown, label: string, what: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new CliError(`${label}: ${what} must be a number.`, { code: 'wrangler_config' });
	return value;
}

/**
 * Wrangler `queues.consumers` → `triggers.queues` (D112). Cloudflare's names map one to one;
 * `max_concurrency` and `visibility_timeout_ms` have no Skiff equivalent and are refused rather
 * than silently ignored.
 */
export function mapQueueConsumers(
	config: Record<string, unknown>,
	label: string,
	brokers: Record<string, string>,
): QueueConsumerEntry[] {
	const queues = recordOf(config.queues, label, 'queues');
	return arrayOf(queues?.consumers, label, 'queues.consumers').map((value) => {
		const entry = entryOf(value, label, 'queues.consumers');
		for (const key of ['max_concurrency', 'visibility_timeout_ms'])
			if (entry[key] !== undefined)
				throw new CliError(`${label}: queues.consumers.${key} is not supported by Skiff queues; remove it.`, {
					code: 'unsupported_binding',
				});
		const queue = requiredField(entry, 'queue', label, 'queues.consumers');
		const number = (key: string) => numberField(entry[key], label, `queues.consumers.${key}`);
		const consumer: QueueConsumerEntry = { queue };
		if (brokers[queue]) consumer.broker = brokers[queue];
		const maxBatchSize = number('max_batch_size');
		if (maxBatchSize !== undefined) consumer.maxBatchSize = maxBatchSize;
		const maxBatchTimeout = number('max_batch_timeout');
		if (maxBatchTimeout !== undefined) consumer.maxBatchTimeout = maxBatchTimeout;
		const maxRetries = number('max_retries');
		if (maxRetries !== undefined) consumer.maxRetries = maxRetries;
		const retryDelay = number('retry_delay');
		if (retryDelay !== undefined) consumer.retryDelay = retryDelay;
		const deadLetterQueue = optionalField(entry, 'dead_letter_queue', label, 'queues.consumers');
		if (deadLetterQueue) consumer.deadLetterQueue = deadLetterQueue;
		return consumer;
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
