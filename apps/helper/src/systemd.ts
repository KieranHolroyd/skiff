import { randomUUID } from 'node:crypto';
import { VolumeProfiler } from './volume-profile.ts';
import { pruneNodeImages, type ImagePruneResult } from './images.ts';
import { applyMirror, type MirrorRequest } from './registry-mirror.ts';
import {
	REGISTRY_ADMIN_HTPASSWD_ENV,
	REGISTRY_CACHE_URL_ENV,
	REGISTRY_CERT_ENV,
	REGISTRY_ENGINES,
	REGISTRY_EVENTS_ENV,
	REGISTRY_S3_ACCESS_KEY_ENV,
	REGISTRY_S3_SECRET_KEY_ENV,
	assertAdminHtpasswd,
	assertCertificatePem,
	assertEventsUrl,
	renderZotConfig,
	type RegistrySecrets,
} from './registry.ts';
import { copyMailTls, MAIL_UNIT } from './mail.ts';
import { IDENTITY_LITESTREAM_UNIT, IDENTITY_UNIT } from './identity.ts';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
	DEFAULT_VOLUMES_FILE,
	parseWorkloadVolumes,
	readInventory,
	readVolumeRegistry,
	verifyMount,
	type HelperInventory,
	type VerifyResult,
	type VolumeRegistry,
} from './volumes.ts';
import {
	DATABASE_PGDATA,
	containerUnitName,
	networkUnitName,
	poolerServiceName,
	poolerUnitName,
	renderContainerEnvFile,
	renderContainerUnit,
	renderEnvFile,
	renderFunctionUnit,
	renderKeyValueConfig,
	renderNatsConfig,
	renderNetworkUnit,
	renderPoolerConfig,
	renderPoolerUnit,
	renderPoolerUserlist,
	renderProcessUnit,
	renderSliceUnit,
	renderSocketUnit,
	serviceUnitName,
	socketUnitName,
	IDENTITY_TOKEN_ENV,
	type UnitSecretFile,
	type UnitVolumeMount,
} from './units.ts';
import { NODE_LISTEN_CREDENTIAL, NODE_LISTEN_SOURCE } from './node-listen.ts';
import {
	REPLICATION_STATUS_SQL,
	assertPrimaryDatabaseId,
	assertReplicaWorkloadId,
	parseReplicationPassword,
	parseReplicationStatus,
	parseSlots,
	renderPromoteArgs,
	renderReplicaStartScript,
	renderReplicationConfigureSql,
	renderReplicationTeardownSql,
	withReplicationHba,
	type ReplicationSlotStatus,
} from './replication.ts';
import { ensureContainerSubids, type SubidFiles } from './userns.ts';
import { AppVolumeData, type AppVolumeDataOptions } from './app-volumes.ts';
import {
	BROKER_ENGINES,
	DATABASE_ENGINES,
	STORAGE_ENGINES,
	STORAGE_ENV,
	ValidationError,
	assertAbsolutePath,
	assertDatabaseId,
	assertManagedId,
	assertMemoryMb,
	assertCommand,
	assertCpuWeight,
	assertId,
	assertRelativePath,
	databaseAlias,
	functionNeedsDurableStorage,
	postgresPitrImage,
	renderRegistryAuthFile,
	workloadNetworkName,
	type DatabaseEngine,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadFunction,
	type WorkloadFunctionFiles,
	type WorkloadStatus,
} from './validate.ts';
import {
	computePitrWindow,
	parseArchiverStats,
	parsePgBackRestInfo,
	parsePitrBackupType,
	parsePitrRepo,
	pitrContainerName,
	pitrPaths,
	pitrRecoveryContainerName,
	pitrRestoreContainerName,
	pitrStanzaFor,
	renderPgBackRestConfig,
	renderPgPass,
	renderPitrArchiverArgs,
	renderPitrBackupArgs,
	renderPitrExecArgs,
	renderPitrRecoveryArgs,
	renderPitrRecoveryPsqlArgs,
	renderPitrRenameSql,
	renderPitrRestoreArgs,
	validatePitrTargetTime,
	type HelperPitrStatus,
	type PitrBaseBackupType,
	type PitrWindow,
} from './pitr.ts';
import {
	databaseTlsPaths,
	disableDatabaseTls,
	generateDatabaseTls,
	readDatabaseTlsState,
	type DatabaseTlsGenerator,
	type DatabaseTlsState,
} from './tls.ts';
import {
	applyStudioPrincipal,
	assertStudioPrincipalPassword,
	containerExec,
	keyValueStudioPassword,
	takeStudioPrincipalEnv,
	withKeyValueStudioUser,
} from './studio-principal.ts';
import {
	CLICKHOUSE_CONFIG_DIR,
	CLICKHOUSE_CONFIG_DIRNAME,
	CLICKHOUSE_CONFIG_FILE,
	CLICKHOUSE_USERS_FILE,
	renderClickHouseServerConfig,
	renderClickHouseUsers,
} from './clickhouse-config.ts';
import {
	clickhouseBackupQuery,
	clickhouseClientArgv,
	clickhouseRestoreQuery,
	DUMP_STAGING_DIRNAME,
	isStaleStagingFile,
	KEY_VALUE_AOF_BASE,
	KEY_VALUE_AOF_DIRNAME,
	KEY_VALUE_AOF_MANIFEST,
	keyValueAofManifest,
	keyValueCheckRdbArgv,
	keyValuePingArgv,
	keyValueRdbDumpArgv,
	keyValueReplyFailed,
	stagingFileName,
	type KeyValueEngine,
} from './database-dumps.ts';

/**
 * systemd is the primary runtime driver. This module owns *all* privileges: it writes unit files,
 * env/secret files and calls systemctl. Every child process goes through an injected
 * `CommandRunner` with an argv array — never a shell string — so the whole module is unit-testable
 * without root or systemd.
 */

/**
 * The on-demand database studio process (plan 22). A static unit the installer and updater ship
 * beside the agent unit; the helper only ever starts or stops it, by this fixed name.
 */
export const STUDIO_UNIT = 'skiff-studio.service';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandRunOptions {
	/**
	 * Extra environment for the child, merged over the helper's own. This is how a secret reaches
	 * `podman exec -e NAME` without ever appearing in argv.
	 */
	env?: Record<string, string>;
	/**
	 * Written to the child's stdin, which is otherwise closed. How SQL that carries a password
	 * reaches `podman exec -i … psql` without ever appearing in argv.
	 */
	stdin?: string;
}

export interface CommandRunner {
	run(argv: string[], options?: CommandRunOptions): Promise<RunResult>;
}

/** Default runner: argv only, stdin closed unless `options.stdin` is given, no shell. */
export function spawnRunner(): CommandRunner {
	return {
		async run(argv: string[], options: CommandRunOptions = {}): Promise<RunResult> {
			if (argv.length === 0) throw new Error('Refusing to run an empty command');
			const child = Bun.spawn(argv, {
				stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				...(options.env ? { env: { ...process.env, ...options.env } } : {}),
			});
			if (options.stdin !== undefined && child.stdin && typeof child.stdin !== 'number') {
				child.stdin.write(options.stdin);
				await child.stdin.end();
			}
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		},
	};
}

export interface HelperWorkloadStatus {
	id: string;
	status: WorkloadStatus;
	restarts: number;
	memoryBytes?: number;
	/** Managed databases only: TLS state derived from the node's certificate files. */
	tls?: DatabaseTlsState;
}

export interface HelperLogEntry {
	cursor: string;
	/** Epoch milliseconds. */
	ts: number;
	priority: number;
	message: string;
}

export interface HelperLogResult {
	entries: HelperLogEntry[];
	nextCursor: string | null;
}

export interface LogReadOptions {
	cursor?: string;
	lines?: number;
}

export interface SliceOptions {
	memoryMb: number;
	cpuWeight?: number;
}

export interface SystemdDriverOptions {
	runner: CommandRunner;
	/** Where generated units live, normally /etc/systemd/system. */
	unitDir: string;
	/** Quadlet source directory, normally /etc/containers/systemd. Defaults to `unitDir` (tests). */
	quadletDir?: string;
	/** Podman's registries.conf drop-in dir (G4 mirror), normally /etc/containers/registries.conf.d. */
	registriesConfDir?: string;
	/** Root's default Podman auth file (G4 node login), normally /run/containers/0/auth.json. */
	rootAuthFile?: string;
	/** Root-owned runtime directory for env files and sockets, normally /run/skiff-workloads. */
	runtimeDir: string;
	/** Root for per-workload identity tokens, normally /run/skiff/identity (IAM.md I18). */
	identityDir?: string;
	/** Persistent container data root, normally /var/lib/skiff-workloads. */
	stateDir: string;
	/** Disk registry written by the root applier, normally /etc/skiff/volumes.json (D76). */
	volumeRegistryFile?: string;
	/**
	 * Injectable registry for tests, used instead of `volumeRegistryFile`. Production always reads
	 * the file; the override exists because a test temp directory (for example under `/tmp`) is
	 * not a legal volume mount path.
	 */
	volumeRegistry?: VolumeRegistry;
	/** Where the agent extracts content-addressed releases, in probe order. */
	releaseDirs: string[];
	/** Absolute bun binary used for the default process command. */
	bunPath: string;
	/** Absolute node; its directory leads PATH for a Node.js app's start script (D125). */
	nodePath?: string;
	/**
	 * Root of the pinned workerd installations: `<workerdDir>/<version>/workerd` (FN1). Defaults to
	 * the production path so tests and older callers keep working; `main.ts` passes the config value.
	 */
	workerdDir?: string;
	systemctlPath?: string;
	journalctlPath?: string;
	/** Absolute podman binary used by the fixed database dump/restore verbs. */
	podmanPath?: string;
	/** Absolute openssl used to generate per-database certificates (DB_TLS). */
	opensslPath?: string;
	/** AppArmor profile for container workloads; null keeps the runtime default. */
	apparmorProfile?: string | null;
	/**
	 * /etc/subuid and /etc/subgid, given the `containers` range before an app container starts
	 * (its Quadlet sets `UserNS=auto`, see userns.ts). Null (tests) leaves the host files alone.
	 */
	containerSubids?: SubidFiles | null;
	/** Injectable certificate generator for tests; defaults to the fixed openssl argv sequence. */
	databaseTlsGenerator?: DatabaseTlsGenerator;
	socketMode?: string;
	socketGroup?: string | null;
	/**
	 * Hands a database data dir to the engine's user. Defaults to `fs.chown` when running as root
	 * and to a no-op otherwise, so tests (and dev) run unprivileged.
	 */
	chown?: (path: string, uid: number, gid: number) => Promise<void>;
	/** Delay between readiness polls after a Valkey/Redis restore restarts the unit (tests: 0). */
	restorePollMs?: number;
	/**
	 * The agent's replica link root (C7): `<dir>/<replica id>/.s.PGSQL.5432` is the socket the
	 * agent serves; the helper mounts that one directory into the replica container, read-only.
	 */
	replicationDir?: string;
}

export function defaultChown(): (path: string, uid: number, gid: number) => Promise<void> {
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	return isRoot ? (path, uid, gid) => fs.chown(path, uid, gid) : async () => undefined;
}

interface UnitPaths {
	service: string;
	socket: string;
	container: string;
	pooler: string;
}

export class SystemdDriver {
	private readonly runner: CommandRunner;
	private readonly unitDir: string;
	private readonly quadletDir: string;
	private readonly registriesConfDir: string;
	private readonly rootAuthFile: string;
	private readonly runtimeDir: string;
	private readonly identityDir: string;
	private readonly stateDir: string;
	private readonly volumeRegistryFile: string;
	private readonly volumeRegistryOverride: VolumeRegistry | null;
	private readonly releaseDirs: string[];
	private readonly bunPath: string;
	private readonly nodePath: string;
	private readonly workerdDir: string;
	private readonly systemctlPath: string;
	private readonly journalctlPath: string;
	private readonly podmanPath: string;
	private readonly opensslPath: string;
	private readonly apparmorProfile: string | null;
	private readonly containerSubids: SubidFiles | null;
	private readonly databaseTlsGenerator: DatabaseTlsGenerator;
	private readonly socketMode: string;
	private readonly socketGroup: string | null;
	private readonly chown: (path: string, uid: number, gid: number) => Promise<void>;
	private readonly restorePollMs: number;
	private readonly replicationDir: string;
	/**
	 * Databases a PITR restore is writing into. `apply` refuses them until the restore ends, so the
	 * agent's reconcile cannot restart a target whose data dir is being replaced.
	 */
	private readonly pitrRestoring = new Set<string>();

	constructor(options: SystemdDriverOptions) {
		this.runner = options.runner;
		this.restorePollMs = options.restorePollMs ?? 1_000;
		this.unitDir = assertAbsolutePath(options.unitDir, 'unitDir');
		this.quadletDir = assertAbsolutePath(options.quadletDir ?? options.unitDir, 'quadletDir');
		this.registriesConfDir = assertAbsolutePath(options.registriesConfDir ?? '/etc/containers/registries.conf.d', 'registriesConfDir');
		this.rootAuthFile = assertAbsolutePath(options.rootAuthFile ?? '/run/containers/0/auth.json', 'rootAuthFile');
		this.runtimeDir = assertAbsolutePath(options.runtimeDir, 'runtimeDir');
		this.identityDir = assertAbsolutePath(options.identityDir ?? '/run/skiff/identity', 'identityDir');
		this.stateDir = assertAbsolutePath(options.stateDir, 'stateDir');
		this.volumeRegistryFile = assertAbsolutePath(
			options.volumeRegistryFile ?? DEFAULT_VOLUMES_FILE,
			'volumeRegistryFile',
		);
		this.volumeRegistryOverride = options.volumeRegistry ?? null;
		if (options.releaseDirs.length === 0)
			throw new ValidationError('releaseDirs must contain at least one directory');
		this.releaseDirs = options.releaseDirs.map((dir) => assertAbsolutePath(dir, 'releaseDir'));
		this.bunPath = assertAbsolutePath(options.bunPath, 'bunPath');
		this.nodePath = assertAbsolutePath(options.nodePath ?? '/usr/local/bin/node', 'nodePath');
		this.workerdDir = assertAbsolutePath(options.workerdDir ?? '/usr/lib/skiff/workerd', 'workerdDir');
		this.systemctlPath = assertAbsolutePath(options.systemctlPath ?? '/usr/bin/systemctl', 'systemctlPath');
		this.journalctlPath = assertAbsolutePath(
			options.journalctlPath ?? '/usr/bin/journalctl',
			'journalctlPath',
		);
		this.podmanPath = assertAbsolutePath(options.podmanPath ?? '/usr/bin/podman', 'podmanPath');
		this.opensslPath = assertAbsolutePath(options.opensslPath ?? '/usr/bin/openssl', 'opensslPath');
		this.apparmorProfile = options.apparmorProfile ?? null;
		this.containerSubids = options.containerSubids ?? null;
		this.databaseTlsGenerator = options.databaseTlsGenerator ?? generateDatabaseTls;
		this.socketMode = validateSocketMode(options.socketMode ?? '0666');
		this.socketGroup = options.socketGroup ?? null;
		this.chown = options.chown ?? defaultChown();
		this.replicationDir = assertAbsolutePath(
			options.replicationDir ?? '/var/lib/skiff/agent/replication',
			'replicationDir',
		);
	}

	unitPaths(id: string): UnitPaths {
		assertId(id, 'workload id');
		return {
			service: join(this.unitDir, serviceUnitName(id)),
			socket: join(this.unitDir, socketUnitName(id)),
			container: join(this.quadletDir, containerUnitName(id)),
			pooler: join(this.quadletDir, poolerUnitName(id)),
		};
	}

	/** Write and apply the node's workload slice budget. */
	async ensureSlice(options: SliceOptions): Promise<void> {
		const memoryMb = assertMemoryMb(options.memoryMb, 'slice memoryMb');
		const cpuWeight = assertCpuWeight(options.cpuWeight ?? 200, 'cpuWeight');
		const path = join(this.unitDir, 'skiff-workloads.slice');
		const changed = await this.writeIfChanged(path, renderSliceUnit(memoryMb, cpuWeight), 0o644);
		if (changed) await this.daemonReload();
		await this.systemctl(['start', 'skiff-workloads.slice']);
	}

	/**
	 * Replace the disk registry from desired state (D76). The agent may ask, but the helper
	 * validates ids, paths and identities itself; a bad entry rejects the whole list. Writes are
	 * atomic and only when the content changed.
	 */
	async syncVolumes(raw: unknown): Promise<number> {
		let volumes;
		try {
			volumes = parseWorkloadVolumes(raw);
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : 'invalid volume list');
		}
		const registry: VolumeRegistry = {};
		for (const volume of volumes)
			registry[volume.id] = {
				mountPath: volume.mountPath,
				sourceKey: volume.sourceKey,
				fsType: volume.fsType,
			};
		const content = `${JSON.stringify(registry, null, 2)}\n`;
		const existing = await fs.readFile(this.volumeRegistryFile, 'utf8').catch(() => null);
		if (existing === content) return volumes.length;
		await fs.mkdir(dirname(this.volumeRegistryFile), { recursive: true, mode: 0o700 });
		const temporary = `${this.volumeRegistryFile}.tmp`;
		await fs.writeFile(temporary, content, { mode: 0o600 });
		await fs.rename(temporary, this.volumeRegistryFile);
		return volumes.length;
	}

	/** Read-only inventory for the volume wizard (D72). */
	async volumesInventory(): Promise<HelperInventory> {
		return readInventory(this.runner);
	}

	/** Verify a registered volume without writing anything (D76). */
	async verifyVolume(input: { mountPath: string; sourceKey: string }): Promise<VerifyResult> {
		return verifyMount(this.runner, input.mountPath, input.sourceKey);
	}

	/** Benchmarks a registered, mounted disk (docs/STORAGE.md §5.1); resolves paths itself. */
	volumeProfiler(): VolumeProfiler {
		return new VolumeProfiler({
			runner: this.runner,
			registry: () => this.registry(),
			verify: (input) => this.verifyVolume(input),
		});
	}

	private async registry(): Promise<VolumeRegistry> {
		return this.volumeRegistryOverride ?? readVolumeRegistry(this.volumeRegistryFile);
	}

	/** App-volume data verbs (docs/VOLUMES.md), resolving paths exactly like the mounts below. */
	appVolumeData(options: Pick<AppVolumeDataOptions, 'log' | 'maxPauseMs'> = {}): AppVolumeData {
		return new AppVolumeData({
			stateDir: this.stateDir,
			registry: () => this.registry(),
			runner: this.runner,
			systemctlPath: this.systemctlPath,
			...options,
		});
	}

	/**
	 * Where one container's data lives (D78, D169). A disk-backed workload is resolved through the
	 * root applier's registry and verified *before* anything is written: if the mount is gone the
	 * start fails, because the alternative is silently filling the root disk (D76). The helper
	 * never accepts a path from the wire.
	 */
	async resolveDataDir(workload: WorkloadDesired): Promise<string> {
		if (!workload.volumeId) return join(this.stateDir, workload.id);
		const registry = await this.registry();
		const entry = registry[workload.volumeId];
		if (!entry)
			throw new ValidationError(
				`Volume "${workload.volumeId}" is not registered on this node; refusing to start ${workload.id}.`,
			);
		const mounted = await verifyMount(this.runner, entry.mountPath, entry.sourceKey);
		if (!mounted.ok)
			throw new ValidationError(
				`Volume "${workload.volumeId}" is not mounted at ${entry.mountPath}: ${mounted.message ?? 'unknown error'}. Refusing to start ${workload.id}.`,
			);
		return join(entry.mountPath, 'skiff', workload.id);
	}

	/**
	 * Resolve app volumes to host directories before anything is written (plan 07).
	 *
	 * A disk backing (`node_volume`) is verified with `findmnt` every start; a missing mount fails the
	 * start rather than creating `/mnt/empty/skiff/apps/...` on the root disk. State-dir volumes
	 * live under the helper's own state directory. Only `<base>/<volumeId>` is created.
	 */
	async resolveAppVolumeMounts(workload: WorkloadDesired): Promise<UnitVolumeMount[]> {
		const mounts = workload.volumes ?? [];
		if (mounts.length === 0) return [];
		const registry = await this.registry();
		const verified = new Set<string>();
		const owner = managedOwner(workload);
		const out: UnitVolumeMount[] = [];
		for (const mount of mounts) {
			let base: string;
			if (mount.backing === 'node_volume') {
				const nodeVolumeId = mount.nodeVolumeId;
				if (!nodeVolumeId)
					throw new ValidationError(
						`App volume "${mount.id}" names no node volume; refusing to start ${workload.id}.`,
					);
				const entry = registry[nodeVolumeId];
				if (!entry)
					throw new ValidationError(
						`App volume "${mount.id}" is backed by node volume "${nodeVolumeId}", which is not registered on this node; refusing to start ${workload.id}.`,
					);
				if (!verified.has(nodeVolumeId)) {
					const mounted = await verifyMount(this.runner, entry.mountPath, entry.sourceKey);
					if (!mounted.ok)
						throw new ValidationError(
							`App volume "${mount.id}" backing is not mounted: ${mounted.message ?? 'unknown error'}. Refusing to start ${workload.id}; the root disk is never used as a fallback.`,
						);
					verified.add(nodeVolumeId);
				}
				base = join(entry.mountPath, 'skiff', 'apps', workload.projectId);
			} else {
				base = join(this.stateDir, 'apps', workload.projectId);
			}
			await fs.mkdir(base, { recursive: true, mode: 0o755 });
			const hostPath = join(base, mount.id);
			await fs.mkdir(hostPath, { recursive: true, mode: 0o700 });
			const info = await fs.lstat(hostPath);
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new ValidationError(
					`App volume "${mount.id}" resolves to something that is not a directory; refusing to start ${workload.id}.`,
				);
			if (owner) {
				await fs.chmod(hostPath, 0o700);
				await this.chown(hostPath, owner.uid, owner.gid);
			} else {
				// Generic images run as their own user and process units use DynamicUser; the
				// dedicated volume directory is writable only by that sandboxed workload in
				// practice. Read-only attachments are not writable at the filesystem level either.
				await fs.chmod(hostPath, mount.readOnly ? 0o555 : 0o777);
			}
			out.push({ hostPath, mountPath: mount.mountPath, readOnly: mount.readOnly });
		}
		return out;
	}

	/** Render, install and (re)start one workload. Idempotent. */
	async apply(
		workload: WorkloadDesired,
		activation: WorkloadActivation,
		functionFiles?: WorkloadFunctionFiles,
	): Promise<HelperWorkloadStatus> {
		assertId(workload.id, 'workload.id');
		if (activation.workloadId !== workload.id)
			throw new ValidationError('activation.workloadId does not match workload.id');
		if (activation.activationVersion !== workload.activationVersion)
			throw new ValidationError('activation.activationVersion does not match the desired workload');
		if (workload.runtime !== 'function' && functionFiles !== undefined)
			throw new ValidationError('function files are only valid for a function workload');
		if (this.pitrRestoring.has(workload.id))
			throw new ValidationError(
				`A point-in-time restore into ${workload.id} is in progress; the helper starts it when the restore ends.`,
			);
		if (workload.runtime === 'compose') return this.applyCompose(workload, activation);

		// Resolve everything that can fail before writing a secret or a unit to disk.
		let releaseDir: string | null = null;
		let command: string[] | null = null;
		let workerdPath: string | null = null;
		let modulePaths: string[] = [];
		if (workload.runtime === 'process') {
			releaseDir = await this.resolveRelease(workload.release!);
			command = workload.command ?? (await this.defaultCommand(releaseDir, workload.engine ?? 'bun'));
		} else if (workload.runtime === 'function') {
			const fn = workload.function;
			if (!fn) throw new ValidationError('Function workloads need workload.function');
			if (!functionFiles)
				throw new ValidationError('Function workloads need request.function.config and request.function.shim');
			if (!workload.release) throw new ValidationError('Function workloads need a release');
			// Resolve the release, every module and the pinned binary before writing anything: a
			// missing piece fails closed instead of leaving a half-installed host behind.
			releaseDir = await this.resolveRelease(workload.release);
			modulePaths = await this.verifyFunctionModules(fn, releaseDir);
			workerdPath = await this.resolveWorkerd(fn.workerdVersion);
		} else if (!workload.image) {
			throw new ValidationError(
				'Container workloads need an image; the control plane must include workload.image',
			);
		}

		// Resolve/verify app-volume backing before writing secrets or units. Fail closed.
		const volumeMounts = await this.resolveAppVolumeMounts(workload);

		await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o755 });
		// The runtime dir holds secret files: owner-only.
		const workloadRuntimeDir = join(this.runtimeDir, workload.id);
		await fs.mkdir(workloadRuntimeDir, { recursive: true, mode: 0o700 });
		await fs.chmod(workloadRuntimeDir, 0o700).catch(() => undefined);

		const envFile = join(workloadRuntimeDir, 'env');
		const env = { ...workload.env, ...activation.env };
		// Workload identity (IAM.md I18): the helper is the only writer of the 0400 file. The token
		// is never in desired state or an env file; the file is the workload's one copy.
		let identityPath: string | null = null;
		let identityDirectory: string | null = null;
		if (workload.identity) {
			if (!activation.identity?.token)
				throw new ValidationError('activation.identity is required for a workload with identity enabled');
			identityDirectory = join(this.identityDir, workload.id);
			identityPath = join(identityDirectory, 'token');
			await this.writeIdentity(identityPath, activation.identity.token);
			// A process app reads the systemd credential path instead of the container mount, and an
			// EnvironmentFile entry would override the unit's Environment= line.
			if (workload.runtime === 'process') delete env[IDENTITY_TOKEN_ENV];
		} else if (activation.identity) {
			throw new ValidationError('activation.identity is only valid for a workload with identity enabled');
		}
		// The studio principal's password (track G) goes only into the Valkey/Redis server config.
		const studioPassword = takeStudioPrincipalEnv(env);
		// The database profile pins its data inside the /data mount; never the image's VOLUME. Each
		// engine's fixed settings win over anything on the wire (D61).
		if (workload.database) Object.assign(env, databaseFixedEnv(workload.database.engine, env));
		// The storage profile's fixed settings win over anything on the wire (S1).
		if (workload.objectStorage) Object.assign(env, STORAGE_ENV);
		// The registry's token certificate and event sink become zot's config files, never env (G1).
		const registryFiles = workload.registry ? takeRegistryFiles(env) : null;
		// The broker's user and password go only into its server config, never the container env (D111).
		const brokerAuth = workload.broker ? takeBrokerAuth(env) : null;
		if (workload.broker) Object.assign(env, brokerFixedEnv(workload.memoryMb));
		// A socket-activated Node app gets the fd-3 preload (D125). Its own NODE_OPTIONS moves from
		// the env file into the unit, after the preload, because the env file would override it.
		let nodeListen: { path: string; userNodeOptions?: string } | undefined;
		if (workload.runtime === 'process' && workload.engine === 'node' && workload.socketActivation) {
			const userNodeOptions = env.NODE_OPTIONS;
			delete env.NODE_OPTIONS;
			const path = join(workloadRuntimeDir, NODE_LISTEN_CREDENTIAL);
			await this.writeAtomic(path, NODE_LISTEN_SOURCE, 0o600);
			nodeListen = { path, ...(userNodeOptions ? { userNodeOptions } : {}) };
		}
		// systemd and Podman parse env files differently; each driver gets its own format.
		const envText = workload.runtime === 'container' ? renderContainerEnvFile(env) : renderEnvFile(env);
		await this.writeAtomic(envFile, envText, 0o400);

		const secretsDir = join(workloadRuntimeDir, 'secrets');
		const secretFiles = await this.writeSecrets(secretsDir, workload, activation);
		const paths = this.unitPaths(workload.id);
		let changed = false;

		if (workload.runtime === 'process') {
			const socketPath = workload.socketActivation
				? join(this.runtimeDir, `${workload.projectId}.sock`)
				: null;
			if (socketPath) {
				const long = Buffer.byteLength(socketPath);
				if (long > 100) throw new ValidationError(`Unix socket path is too long (${long} bytes)`);
				await fs.mkdir(dirname(socketPath), { recursive: true, mode: 0o755 });
			}
			const service = renderProcessUnit({
				workload,
				releaseDir: releaseDir!,
				envFile,
				secrets: secretFiles,
				command: command!,
				envNames: Object.keys(env),
				volumeMounts,
				...(nodeListen ? { nodeListen } : {}),
				...(identityPath ? { identityPath } : {}),
			});
			changed = (await this.writeIfChanged(paths.service, service, 0o644)) || changed;

			// Quadlet and process units must never coexist for the same id.
			changed = (await this.removeIfExists(paths.container)) || changed;

			if (workload.socketActivation && socketPath) {
				const socket = renderSocketUnit({
					workload,
					socketPath,
					socketMode: this.socketMode,
					socketGroup: this.socketGroup,
				});
				changed = (await this.writeIfChanged(paths.socket, socket, 0o644)) || changed;
			} else {
				changed = (await this.removeIfExists(paths.socket)) || changed;
			}

			if (changed) await this.daemonReload();
			if (workload.socketActivation && socketPath) {
				// The socket unit owns activation; a stale service enable would start it without fds.
				await this.systemctl(['disable', serviceUnitName(workload.id)], { allowFailure: true });
				await this.systemctl(['enable', socketUnitName(workload.id)]);
			} else {
				// Remove a socket left over from a previous socket-activated revision.
				await this.systemctl(['disable', '--now', socketUnitName(workload.id)], {
					allowFailure: true,
				});
				await this.systemctl(['enable', serviceUnitName(workload.id)]);
			}
			// `restart` starts an inactive unit too, so env/unit changes take effect immediately.
			await this.systemctl(['restart', serviceUnitName(workload.id)]);
			if (workload.socketActivation) {
				await this.systemctl(['restart', socketUnitName(workload.id)]);
			}
		} else if (workload.runtime === 'function') {
			// The config and shim are helper-owned copies of the agent's rendered files. They live
			// beside the env file and are passed as systemd credentials, never as a path from the
			// wire. Only the helper ever writes here, 0600, atomically.
			const functionDir = join(workloadRuntimeDir, 'function');
			await fs.mkdir(functionDir, { recursive: true, mode: 0o700 });
			await fs.chmod(functionDir, 0o700).catch(() => undefined);
			const configPath = join(functionDir, 'config.capnp');
			const shimPath = join(functionDir, 'shim.mjs');
			await this.writeAtomic(configPath, functionFiles!.config, 0o600);
			await this.writeAtomic(shimPath, functionFiles!.shim, 0o600);
			// Binding-service modules: one credential each, named exactly as the rendered config
			// embeds them. Names were validated (lower-case, no separators) by the request parser,
			// so `join` cannot escape `functionDir`; sort for a deterministic unit file.
			const extraFiles: Array<{ name: string; path: string }> = [];
			const extra = functionFiles!.files ?? {};
			for (const name of Object.keys(extra).sort()) {
				const path = join(functionDir, name);
				await this.writeAtomic(path, extra[name]!, 0o600);
				extraFiles.push({ name, path });
			}

			// A function is socket-activated exactly like a process app: same socket path shape.
			// Functions are per-desired-state-id (`<id>`, `<id>-r<n>`), so replicas and the
			// phase-4 route/agent probe agree on the socket. Process apps keep the project socket.
			const socketPath = join(this.runtimeDir, `${workload.id}.sock`);
			const long = Buffer.byteLength(socketPath);
			if (long > 100) throw new ValidationError(`Unix socket path is too long (${long} bytes)`);
			await fs.mkdir(dirname(socketPath), { recursive: true, mode: 0o755 });

			changed =
				(await this.writeIfChanged(
					paths.service,
					renderFunctionUnit({
						workload,
						releaseDir: releaseDir!,
						envFile,
						secrets: secretFiles,
						volumeMounts,
						configPath,
						shimPath,
						workerdPath: workerdPath!,
						modulePaths,
						files: extraFiles,
						durableStorage: functionNeedsDurableStorage(workload.function!),
					}),
					0o644,
				)) || changed;
			// A function never shares an id with a container or a pooler sidecar.
			changed = (await this.removeIfExists(paths.container)) || changed;
			changed = (await this.removeIfExists(paths.pooler)) || changed;
			changed =
				(await this.writeIfChanged(
					paths.socket,
					renderSocketUnit({
						workload,
						socketPath,
						socketMode: this.socketMode,
						socketGroup: this.socketGroup,
					}),
					0o644,
				)) || changed;

			if (changed) await this.daemonReload();
			// Mirror the process branch: the socket owns activation, so a stale service enable would
			// start workerd without the inherited listener.
			await this.systemctl(['disable', serviceUnitName(workload.id)], { allowFailure: true });
			await this.systemctl(['enable', socketUnitName(workload.id)]);
			await this.systemctl(['restart', serviceUnitName(workload.id)]);
			await this.systemctl(['restart', socketUnitName(workload.id)]);
		} else {
			const image = workload.image!;
			// Each org gets its own network; write it first so Quadlet can resolve it. A workload
			// without an org keeps the legacy shared network, so old desired state still converges.
			const networkName = workloadNetworkName(workload);
			changed = (await this.ensureNetworkUnit(networkName)) || changed;
			const dataDir = await this.resolveDataDir(workload);
			if (workload.volumeId) await fs.mkdir(dirname(dataDir), { recursive: true, mode: 0o755 });
			await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
			const owner = managedOwner(workload);
			if (owner) {
				// chown follows symlinks; the data dir must be a real directory under stateDir.
				if (!(await fs.lstat(dataDir)).isDirectory())
					throw new ValidationError(`${dataDir} is not a directory`);
				await fs.chmod(dataDir, 0o700);
				await this.chown(dataDir, owner.uid, owner.gid);
			}
			const tls = await this.databaseTlsFor(workload);
			// The pgBackRest config directory is a bind-mount source, so it must exist before the
			// unit starts; `pitr/configure` fills it (docs/PITR.md).
			const pitrConfigDir = workload.database?.pitr ? await this.ensurePitrConfigDir(workload.id) : null;
			const serverConfigPath = brokerAuth
				? await this.writeBrokerConfig(workload, brokerAuth, workloadRuntimeDir)
				: registryFiles
					? await this.writeRegistryConfig(workload, registryFiles, workloadRuntimeDir)
					: await this.writeKeyValueConfig(workload, env, workloadRuntimeDir, studioPassword);
			if (serverConfigPath) changed = serverConfigPath.changed || changed;
			// App containers run in their own user namespace; Podman needs the id range first.
			if (this.containerSubids && !workload.database && !workload.objectStorage && !workload.broker && !workload.registry)
				await ensureContainerSubids(this.containerSubids);
			// A read replica (C7) needs its start script and the agent's link directory first.
			const replica = workload.database?.replica ? await this.prepareReplica(workload.id, workloadRuntimeDir) : null;
			if (replica) changed = replica.changed || changed;
			// Registry credentials (R2) live beside the env file, root-only; podman reads them as root.
			const authFile = join(workloadRuntimeDir, 'auth.json');
			// Managed services pull the helper's own pinned images (D61) and never take credentials.
			const appContainer = !workload.database && !workload.objectStorage && !workload.broker && !workload.registry;
			const registryAuth = appContainer ? (activation.registryAuth ?? []) : [];
			if (registryAuth.length > 0) await this.writeAtomic(authFile, renderRegistryAuthFile(registryAuth), 0o400);
			else await this.removeIfExists(authFile);
			const container = renderContainerUnit({
				workload,
				image,
				authFile: registryAuth.length > 0 ? authFile : null,
				envFile,
				dataDir,
				secretsDir: Object.keys(activation.files).length > 0 ? secretsDir : null,
				...(workload.database?.pitr && pitrConfigDir
					? {
							pitr: {
								stanza: workload.database.pitr.stanza,
								configDir: pitrConfigDir,
								archiveTimeoutSeconds: workload.database.pitr.archiveTimeoutSeconds,
							},
						}
					: {}),
				tlsDir: tls?.enabled ? databaseTlsPaths(this.runtimeDir, workload.id).dir : null,
				serverConfigPath: serverConfigPath?.path ?? null,
				volumeMounts,
				apparmorProfile: this.apparmorProfile,
				...(identityDirectory ? { identityDir: identityDirectory } : {}),
				...(replica ? { replica: replica.paths } : {}),
			});
			changed = (await this.writeIfChanged(paths.container, container, 0o644)) || changed;
			changed = (await this.removeIfExists(paths.service)) || changed;
			changed = (await this.removeIfExists(paths.socket)) || changed;

			if (workload.database && workload.pooler) {
				const user = env.POSTGRES_USER;
				const password = env.POSTGRES_PASSWORD;
				if (!user || !password)
					throw new ValidationError('A database pooler needs POSTGRES_USER and POSTGRES_PASSWORD');
				const configPath = join(workloadRuntimeDir, 'pgbouncer.ini');
				const userlistPath = join(workloadRuntimeDir, 'pgbouncer-users.txt');
				const config = renderPoolerConfig({
					databaseAlias: databaseAlias(workload.id),
					authFile: '/etc/pgbouncer/userlist.txt',
					adminUser: user,
					tls: tls?.enabled
						? {
								certFile: '/run/skiff-tls/server.crt',
								keyFile: '/run/skiff-tls/server.key',
							}
						: null,
				});
				const userlist = renderPoolerUserlist(user, password);
				changed = (await this.writeIfChanged(configPath, config, 0o600)) || changed;
				changed = (await this.writeIfChanged(userlistPath, userlist, 0o600)) || changed;
				await this.chown(configPath, 70, 70).catch(() => undefined);
				await this.chown(userlistPath, 70, 70).catch(() => undefined);
				changed =
					(await this.writeIfChanged(
						paths.pooler,
						renderPoolerUnit({
							workload,
							configPath,
							userlistPath,
							tlsDir: tls?.enabled ? databaseTlsPaths(this.runtimeDir, workload.id).dir : null,
							apparmorProfile: this.apparmorProfile,
						}),
						0o644,
					)) || changed;
			} else {
				changed = (await this.removeIfExists(paths.pooler)) || changed;
			}
			if (changed) await this.daemonReload();
			// Switching drivers must stop the process units first; Quadlet generates the service.
			await this.systemctl(['disable', '--now', serviceUnitName(workload.id)], {
				allowFailure: true,
			});
			await this.systemctl(['disable', '--now', socketUnitName(workload.id)], {
				allowFailure: true,
			});
			// A managed service's first start pulls the image (and runs initdb for a database) under
			// TimeoutStartSec=600, which would outlive the agent's apply request. Queue the restart;
			// the agent probes readiness.
			await this.systemctl(
				owner || workload.runner
					? ['restart', '--no-block', serviceUnitName(workload.id)]
					: ['restart', serviceUnitName(workload.id)],
			);
			if (workload.database && workload.pooler) {
				await this.systemctl(['restart', '--no-block', poolerServiceName(workload.id)], {
					allowFailure: true,
				});
			}
			// Quadlet attaches the container, but verify it and repair a missing attachment. This is
			// best effort: a managed service is restarted with --no-block and may not exist yet.
			await this.ensureNetworkMembership(workload, networkName);
		}

		return this.status(workload.id);
	}

	/** Where a compose stack records the service names it rendered, for stale-unit cleanup. */
	private composeManifestPath(id: string): string {
		return join(this.runtimeDir, id, 'compose.json');
	}

	private async readComposeManifest(id: string): Promise<string[] | null> {
		const text = await fs.readFile(this.composeManifestPath(id), 'utf8').catch(() => null);
		if (text === null) return null;
		try {
			const parsed = JSON.parse(text) as { services?: unknown };
			if (!Array.isArray(parsed.services) || !parsed.services.every((entry) => typeof entry === 'string')) return null;
			return parsed.services as string[];
		} catch {
			return null;
		}
	}

	/** One compose service unit id: `<workload id>--<service name>`. */
	private composeServiceId(id: string, service: string): string {
		return `${id}--${service}`;
	}

	/** Topological order for `depends_on`; validation already rejected cycles. */
	private composeOrder(services: WorkloadDesired['compose']): Array<{ name: string }> {
		if (!services) return [];
		const byName = new Map(services.services.map((service) => [service.name, service]));
		const done = new Set<string>();
		const order: Array<{ name: string }> = [];
		const visit = (name: string): void => {
			if (done.has(name)) return;
			done.add(name);
			for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency);
			order.push({ name });
		};
		for (const service of services.services) visit(service.name);
		return order;
	}

	/**
	 * Level 4: render one rootless Quadlet per compose service on the workload network, with the
	 * service name as a DNS alias. Each service has its own env file, resource caps and named
	 * volume mounts; only the primary route's service publishes a loopback port for Caddy.
	 */
	private async applyCompose(workload: WorkloadDesired, activation: WorkloadActivation): Promise<HelperWorkloadStatus> {
		const compose = workload.compose;
		if (!compose) throw new ValidationError('Compose workloads need workload.compose');
		if (compose.services.length === 0) throw new ValidationError('A compose stack needs at least one service');
		if (Object.keys(activation.files).length > 0)
			throw new ValidationError('Compose services take environment secrets; file delivery is not supported');
		const runtimeDir = join(this.runtimeDir, workload.id);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		await fs.chmod(runtimeDir, 0o700).catch(() => undefined);

		const env = { ...workload.env, ...activation.env };
		const authFile = join(runtimeDir, 'auth.json');
		const registryAuth = activation.registryAuth ?? [];
		if (registryAuth.length > 0) await this.writeAtomic(authFile, renderRegistryAuthFile(registryAuth), 0o400);
		else await this.removeIfExists(authFile);

		const composeRoot = join(runtimeDir, 'compose');
		await fs.mkdir(composeRoot, { recursive: true, mode: 0o700 });
		for (const volume of compose.volumes) {
			const directory = join(composeRoot, 'volumes', volume.name);
			await fs.mkdir(directory, { recursive: true, mode: 0o777 });
			// Compose volumes are shared by every container in the stack; each container's userns
			// maps its own root onto a host range, so the directory must be writable by those ids.
			await fs.chmod(directory, 0o777).catch(() => undefined);
		}
		if (this.containerSubids) await ensureContainerSubids(this.containerSubids);

		const networkName = workloadNetworkName(workload);
		let changed = await this.ensureNetworkUnit(networkName);
		const units = new Map<string, string>();
		for (const service of compose.services) units.set(service.name, serviceUnitName(this.composeServiceId(workload.id, service.name)));

		for (const service of compose.services) {
			const serviceId = this.composeServiceId(workload.id, service.name);
			const paths = this.unitPaths(serviceId);
			const serviceRuntimeDir = join(runtimeDir, service.name);
			await fs.mkdir(serviceRuntimeDir, { recursive: true, mode: 0o700 });
			const envFile = join(serviceRuntimeDir, 'env');
			// Activation values (platform attachments and secret values) win over the compose file's
			// plain environment, matching a single workload.
			await this.writeAtomic(envFile, renderContainerEnvFile({ ...service.env, ...env }), 0o400);
			const routes = compose.routes.filter((route) => route.service === service.name);
			const ingress = routes.find((route) => route.primary) ?? routes[0];
			const volumeMounts = service.volumes.map((volume) => ({
				hostPath: join(composeRoot, 'volumes', volume.name),
				mountPath: volume.mountPath,
				readOnly: volume.readOnly,
			}));
			const synthetic: WorkloadDesired = {
				id: serviceId,
				projectId: workload.projectId,
				projectSlug: workload.projectSlug,
				deploymentId: workload.deploymentId,
				...(workload.orgId ? { orgId: workload.orgId } : {}),
				...(workload.networkName ? { networkName: workload.networkName } : {}),
				runtime: 'container',
				status: workload.status,
				release: null,
				upstream: workload.upstream,
				memoryMb: service.memoryMb,
				cpus: service.cpus,
				port: ingress?.hostPort ?? service.ports[0] ?? workload.port,
				healthPath: ingress?.healthPath ?? workload.healthPath,
				socketActivation: false,
				activationVersion: workload.activationVersion,
				env: service.env,
				secrets: [],
				dataSizeMb: null,
			};
			changed =
				(await this.writeIfChanged(
					paths.container,
					renderContainerUnit({
						workload: synthetic,
						image: service.image,
						authFile: registryAuth.length > 0 ? authFile : null,
						envFile,
						dataDir: join(serviceRuntimeDir, 'data'),
						secretsDir: null,
						volumeMounts,
						apparmorProfile: this.apparmorProfile,
						dataMount: false,
						networkAliases: [service.name],
						afterUnits: service.dependsOn.map((name) => units.get(name)!),
						publish: ingress?.hostPort ? { hostPort: ingress.hostPort, containerPort: ingress.port } : null,
						...(service.command ? { exec: service.command } : {}),
					}),
					0o644,
				)) || changed;
			changed = (await this.removeIfExists(paths.service)) || changed;
			changed = (await this.removeIfExists(paths.socket)) || changed;
		}

		// Services removed from the file must stop and lose their Quadlets.
		const previous = (await this.readComposeManifest(workload.id)) ?? [];
		const current = new Set(compose.services.map((service) => service.name));
		for (const service of previous) {
			if (current.has(service)) continue;
			const serviceId = this.composeServiceId(workload.id, service);
			await this.systemctl(['disable', '--now', serviceUnitName(serviceId)], { allowFailure: true });
			const paths = this.unitPaths(serviceId);
			for (const path of [paths.container, paths.service, paths.socket]) changed = (await this.removeIfExists(path)) || changed;
		}
		await this.writeAtomic(
			this.composeManifestPath(workload.id),
			`${JSON.stringify({ services: [...current] })}\n`,
			0o600,
		);
		if (changed) await this.daemonReload();

		// Start in dependency order. Images pull on first start, so do not hold the apply request:
		// the agent probes the primary route and reports `starting` until it answers.
		for (const service of this.composeOrder(compose)) {
			const unit = units.get(service.name)!;
			await this.systemctl(['enable', unit], { allowFailure: true });
			await this.systemctl(['restart', '--no-block', unit]);
		}
		return this.status(workload.id);
	}

	/** Restart only the PgBouncer sidecar, leaving Postgres and its connections untouched. */
	/**
	 * A replica's start script and link directory (C7). The script is fixed text; the link directory
	 * is the agent's, so a missing one is created owned like its parent (the agent's replication
	 * root) for the agent to bind its socket in. Nothing here comes from the wire but the id.
	 */
	private async prepareReplica(
		id: string,
		workloadRuntimeDir: string,
	): Promise<{ paths: { linkDir: string; scriptPath: string }; changed: boolean }> {
		assertReplicaWorkloadId(id, 'workload.id');
		const root = await fs.stat(this.replicationDir).catch(() => null);
		if (!root?.isDirectory())
			throw new ValidationError(
				`The agent's replica link directory ${this.replicationDir} does not exist yet; refusing to start ${id}.`,
			);
		const linkDir = join(this.replicationDir, id);
		const existing = await fs.lstat(linkDir).catch(() => null);
		if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
			throw new ValidationError(`${linkDir} is not a directory; refusing to start ${id}.`);
		if (!existing) {
			await fs.mkdir(linkDir, { mode: 0o755 });
			await this.chown(linkDir, root.uid, root.gid).catch(() => undefined);
		}
		const scriptPath = join(workloadRuntimeDir, 'replica-start.sh');
		const changed = await this.writeIfChanged(scriptPath, renderReplicaStartScript(), 0o755);
		return { paths: { linkDir, scriptPath }, changed };
	}

	/**
	 * Configure a primary for streaming (docs/CLUSTERING.md §9.2): the managed `pg_hba` rule, the
	 * `skiff_repl` role, WAL retention and exactly `slots`. An empty list tears everything down.
	 * Idempotent; the SQL goes over stdin and the owner password through the environment.
	 */
	async replicationConfigure(id: string, raw: { slots?: unknown; password?: unknown }): Promise<{ slots: string[] }> {
		const databaseId = assertPrimaryDatabaseId(id);
		const slots = parseSlots(raw.slots ?? []);
		const password = parseReplicationPassword(raw.password, slots);
		const env = await this.readPostgresEnv(databaseId);
		const hbaPath = join(await this.dataDirFor(databaseId), 'pgdata', 'pg_hba.conf');
		const hba = await fs.readFile(hbaPath, 'utf8').catch(() => null);
		if (hba === null) throw new ValidationError(`Database ${databaseId} has no pg_hba.conf yet; start it first.`);
		const next = withReplicationHba(hba, slots.length > 0);
		if (next !== hba) {
			const info = await fs.stat(hbaPath);
			await this.writeAtomic(hbaPath, next, 0o600);
			await this.chown(hbaPath, info.uid, info.gid).catch(() => undefined);
		}
		const sql = password ? renderReplicationConfigureSql(password, slots) : renderReplicationTeardownSql();
		const result = await this.runner.run(this.psqlArgs(databaseId, env, ['-v', 'ON_ERROR_STOP=1']), {
			env: { PGPASSWORD: env.password },
			stdin: sql,
		});
		if (result.code !== 0)
			throw new Error(`replication configure failed (${result.code}): ${result.stderr.trim().slice(0, 500) || 'no detail'}`);
		return { slots };
	}

	/** Every Skiff slot on a primary, joined to its walsender, as one JSON query. */
	async replicationStatus(id: string): Promise<{ slots: ReplicationSlotStatus[] }> {
		const databaseId = assertPrimaryDatabaseId(id);
		const env = await this.readPostgresEnv(databaseId);
		const result = await this.runner.run(this.psqlArgs(databaseId, env, ['-tA', '-c', REPLICATION_STATUS_SQL]), {
			env: { PGPASSWORD: env.password },
		});
		if (result.code !== 0)
			throw new Error(`replication status failed (${result.code}): ${result.stderr.trim().slice(0, 500) || 'no detail'}`);
		return { slots: parseReplicationStatus(result.stdout) };
	}

	/**
	 * Promote a replica in place and hand its data dir to the database's own id (§9.3). Refuses
	 * before touching anything when the target directory exists; then `pg_ctl promote`, waits for
	 * `pg_is_in_recovery() = false`, checkpoints, stops the replica unit, drops the standby marker
	 * and renames `<root>/<replica id>` to `<root>/<database id>` on the same filesystem. Re-running
	 * it after a partial run finishes the hand-over.
	 */
	async replicaPromote(replicaId: string, raw: { databaseId?: unknown }): Promise<{ databaseId: string; lsn: string | null }> {
		const id = assertReplicaWorkloadId(replicaId);
		const databaseId = assertPrimaryDatabaseId(raw.databaseId, 'databaseId');
		const source = await this.dataDirFor(id);
		const target = join(dirname(source), databaseId);
		const sourceExists = await fs.lstat(source).then((stat) => stat.isDirectory()).catch(() => false);
		const targetExists = await fs.lstat(target).then(() => true).catch(() => false);
		// A previous run already handed the directory over: report success again.
		if (!sourceExists && targetExists) return { databaseId, lsn: null };
		if (!sourceExists) throw new ValidationError(`Replica ${id} has no data directory on this node.`);
		if (targetExists)
			throw new ValidationError(`${target} already exists; refusing to promote ${id} over another copy of ${databaseId}.`);
		const env = await this.readPostgresEnv(id);
		const query = async (sql: string) => {
			const result = await this.runner.run(this.psqlArgs(id, env, ['-tA', '-c', sql]), { env: { PGPASSWORD: env.password } });
			return result.code === 0 ? result.stdout.trim() : null;
		};
		let recovering = await query('SELECT pg_is_in_recovery()');
		if (recovering === null) throw new Error(`Replica ${id} is not answering; it must be running to be promoted.`);
		if (recovering === 't') {
			const promoted = await this.runner.run(renderPromoteArgs(this.podmanPath, id));
			if (promoted.code !== 0)
				throw new Error(`pg_ctl promote failed (${promoted.code}): ${promoted.stderr.trim().slice(0, 500) || 'no detail'}`);
			for (let attempt = 0; attempt < 30 && recovering !== 'f'; attempt += 1) {
				recovering = await query('SELECT pg_is_in_recovery()');
				if (recovering !== 'f') await new Promise((resolve) => setTimeout(resolve, this.restorePollMs));
			}
			if (recovering !== 'f') throw new Error(`Replica ${id} was still in recovery 30 s after pg_ctl promote.`);
		}
		const lsn = await query('SELECT pg_current_wal_lsn()::text');
		await query('CHECKPOINT');
		await this.systemctl(['stop', serviceUnitName(id)]);
		for (const marker of ['standby.signal', 'recovery.signal'])
			await fs.rm(join(source, 'pgdata', marker), { force: true });
		await fs.rename(source, target);
		return { databaseId, lsn: lsn && /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i.test(lsn) ? lsn : null };
	}

	/** `podman exec` psql as the database owner over the container's loopback; no secret in argv. */
	private psqlArgs(id: string, env: { user: string; database: string }, extra: string[]): string[] {
		return [
			this.podmanPath,
			'exec',
			'-i',
			'-e',
			'PGPASSWORD',
			`skiff-workload-${id}`,
			'psql',
			'-X',
			'-h',
			'127.0.0.1',
			'-U',
			env.user,
			'-d',
			env.database,
			...extra,
		];
	}

	async restartPooler(id: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		await this.systemctl(['restart', '--no-block', poolerServiceName(id)]);
	}

	/**
	 * One-off cleanup after the D60 studio console was retired (D96 supersedes D60). A node
	 * upgraded while a console session was open can keep its sidecar Quadlet (`[Install]`-ed, so
	 * it would come back on reboot), its container and its 0600 `console.env`. Runs at helper
	 * start; each step is idempotent and best effort, and `daemon-reload` only runs if a unit file
	 * went away. Returns the database ids whose leftovers were removed.
	 */
	async removeLegacyConsoles(): Promise<string[]> {
		const ids = new Set<string>();
		let unitRemoved = false;
		for (const name of await fs.readdir(this.quadletDir).catch(() => [] as string[])) {
			const id = LEGACY_CONSOLE_UNIT.exec(name)?.[1];
			if (!id || !isDatabaseId(id)) continue;
			await this.systemctl(['disable', '--now', `skiff-workload-${id}-console.service`], {
				allowFailure: true,
			});
			unitRemoved = (await this.removeIfExists(join(this.quadletDir, name))) || unitRemoved;
			ids.add(id);
		}
		if (unitRemoved) await this.daemonReload();

		// A container can outlive its unit (for example after a failed stop); remove it by name.
		const listed = await this.runner
			.run([this.podmanPath, 'ps', '--all', '--format', '{{.Names}}', '--filter', 'name=-console$'])
			.catch(() => null);
		if (listed?.code === 0) {
			for (const container of listed.stdout.split('\n').map((line) => line.trim())) {
				const id = LEGACY_CONSOLE_CONTAINER.exec(container)?.[1];
				if (!id || !isDatabaseId(id)) continue;
				await this.runner.run([this.podmanPath, 'rm', '--force', container]).catch(() => null);
				ids.add(id);
			}
		}

		for (const entry of await fs.readdir(this.runtimeDir).catch(() => [] as string[])) {
			if (!isDatabaseId(entry)) continue;
			if (await this.removeIfExists(join(this.runtimeDir, entry, 'console.env'))) ids.add(entry);
		}
		return [...ids].sort();
	}

	/**
	 * Start the studio process for the agent. Blocking (not `--no-block`): a Type=simple unit is
	 * started once its process is exec'd, so a missing unit or a start-limit hit comes back as the
	 * systemctl error instead of a silent queued job.
	 */
	/** Point Podman's mirrors for the given upstreams at the platform registry (G4); empty removes. */
	async applyRegistryMirror(request: MirrorRequest): Promise<{ upstreams: string[]; changed: boolean }> {
		return applyMirror(request, { confDir: this.registriesConfDir, authFile: this.rootAuthFile });
	}

	/** Remove images no unit or container needs (docs/REGISTRY.md R3); local images are kept. */
	async pruneImages(): Promise<ImagePruneResult> {
		return pruneNodeImages({ runner: this.runner, podmanPath: this.podmanPath, quadletDir: this.quadletDir });
	}

	async startStudio(): Promise<void> {
		await this.systemctl(['start', STUDIO_UNIT]);
	}

	/** Stop the studio process. It normally exits by itself when idle. */
	async stopStudio(): Promise<void> {
		await this.systemctl(['stop', STUDIO_UNIT]);
	}

	/** Start `skiff-mail` on the mail node (docs/EMAIL.md). The unit name is fixed. */
	async startMail(): Promise<void> {
		await this.systemctl(['start', MAIL_UNIT]);
	}

	async stopMail(): Promise<void> {
		await this.systemctl(['stop', MAIL_UNIT]);
	}

	/**
	 * Start the identity process and its Litestream companion (docs/IAM.md §11.2). The companion is
	 * best-effort: an install without R2 or without Litestream still serves sign-in, just without
	 * continuous backup, and the warning is visible through the unit state.
	 */
	async startIdentity(): Promise<void> {
		await this.systemctl(['start', IDENTITY_UNIT]);
		await this.systemctl(['start', IDENTITY_LITESTREAM_UNIT], { allowFailure: true });
	}

	async stopIdentity(): Promise<void> {
		await this.systemctl(['stop', IDENTITY_LITESTREAM_UNIT], { allowFailure: true });
		await this.systemctl(['stop', IDENTITY_UNIT]);
	}

	/** Copy the submission certificate out of Caddy's storage for `skiff-mail`. */
	async copyMailTls(host: string): Promise<{ found: boolean; changed: boolean }> {
		return copyMailTls(host, {
			caddyDataDir: process.env.SKIFF_CADDY_DATA_DIR ?? '/var/lib/caddy/.local/share/caddy',
			outDir: process.env.SKIFF_MAIL_TLS_DIR ?? '/run/skiff/mail-tls',
			ownerFrom: process.env.SKIFF_MAIL_OWNER_PATH ?? '/var/lib/skiff',
			chown: this.chown,
		});
	}

	/**
	 * Fixed read-only studio principal verb (plan 22 track G): create or update `skiff_studio_ro`
	 * with read rights only, then log in as it. The engine and owner come from the helper's own env
	 * file; the statements are fixed (`studio-principal.ts`). Valkey/Redis also get the user written
	 * into the generated server config, so it survives a restart without one now.
	 */
	async ensureStudioPrincipal(id: string, password: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		assertStudioPrincipalPassword(password);
		const env = await this.readDatabaseEnv(id);
		await applyStudioPrincipal(containerExec([this.podmanPath], `skiff-workload-${id}`), env, password);
		if (env.engine !== 'valkey' && env.engine !== 'redis') return;
		const path = join(this.runtimeDir, id, 'server.conf');
		const current = await fs.readFile(path, 'utf8').catch(() => null);
		if (current === null) throw new ValidationError(`Database ${id} has no generated server config; start it first.`);
		await this.writeIfChanged(path, withKeyValueStudioUser(current, password), 0o600);
		await this.chown(path, DATABASE_ENGINES[env.engine].uid, DATABASE_ENGINES[env.engine].gid).catch(() => undefined);
	}

	/**
	 * Fixed `ALTER ROLE` verb for credential rotation (docs/DATABASES.md §4). The SQL goes over
	 * stdin, never argv, and the new password is verified with a fresh connection.
	 */
	async rotateDatabaseRole(id: string, role: 'owner' | 'monitor', newPassword: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		if (role !== 'owner' && role !== 'monitor') throw new ValidationError('role must be owner or monitor');
		if (!/^[A-Za-z0-9_-]{16,200}$/.test(newPassword))
			throw new ValidationError('The rotated password must be base64url (16–200 characters)');
		const env = await this.readDatabaseEnv(id);
		if (env.engine !== 'postgres') {
			if (role !== 'owner') throw new ValidationError(`Only the owner can be rotated on ${env.engine}`);
			return this.rotateEngineOwner(id, env, newPassword);
		}
		const target = role === 'owner' ? env.user : 'skiff_monitor';
		const container = `skiff-workload-${id}`;
		const child = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-i',
				'-e',
				'PGPASSWORD',
				container,
				'psql',
				'-h',
				'127.0.0.1',
				'-v',
				'ON_ERROR_STOP=1',
				'-U',
				env.user,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: env.password },
				stdin: 'pipe',
				stdout: 'ignore',
				stderr: 'pipe',
			},
		);
		child.stdin.write(`ALTER ROLE "${target}" WITH PASSWORD '${newPassword.replace(/'/g, "''")}';\n`);
		child.stdin.end();
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0)
			throw new Error(`ALTER ROLE failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);

		const verify = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-e',
				'PGPASSWORD',
				container,
				'psql',
				'-h',
				'127.0.0.1',
				'-tAc',
				'SELECT 1',
				'-U',
				target,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: newPassword },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [verifyCode, out] = await Promise.all([verify.exited, new Response(verify.stdout).text()]);
		if (verifyCode !== 0 || out.trim() !== '1')
			throw new Error('The rotated credential did not pass the verification query.');
	}

	/**
	 * Named database credential verb (plan 04b). Grants create/update a Postgres role with only the
	 * privileges its role name implies; revoke disables login. The SQL goes over stdin and every
	 * identifier is validated first, so the helper never builds a shell string.
	 */
	async applyDatabaseCredential(
		id: string,
		action: 'grant' | 'revoke',
		role: 'owner' | 'app' | 'monitor' | 'readonly' | 'backup',
		username: string,
		newPassword?: string,
	): Promise<void> {
		assertDatabaseId(id, 'database id');
		if (!identifier(username)) throw new ValidationError('credential username must be a Postgres identifier');
		const env = await this.readPostgresEnv(id);
		const target = role === 'owner' ? env.user : username;
		if (action === 'revoke') {
			if (role === 'owner') throw new ValidationError('The owner role cannot be revoked');
			await this.executeDatabaseSql(
				id,
				env,
				`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${target}') THEN ALTER ROLE "${target}" NOLOGIN; END IF; END $$;\n`,
			);
			return;
		}
		if (!newPassword || !/^[A-Za-z0-9_-]{16,200}$/.test(newPassword))
			throw new ValidationError('The credential password must be base64url (16–200 characters)');

		const password = newPassword.replace(/'/g, "''");
		const statements = [`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${target}') THEN
    CREATE ROLE "${target}" LOGIN PASSWORD '${password}';
  ELSE
    ALTER ROLE "${target}" WITH LOGIN PASSWORD '${password}';
  END IF;
END $$;`];
		if (role === 'owner') {
			// The owner already exists; the DO block above just changes its password.
		} else if (role === 'monitor') {
			statements.push(`GRANT pg_monitor TO "${target}";`);
		} else {
			statements.push(
				`GRANT CONNECT ON DATABASE "${env.database}" TO "${target}";`,
				`GRANT USAGE ON SCHEMA public TO "${target}";`,
			);
			if (role === 'app') {
				statements.push(
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${target}";`,
					`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${target}";`,
					`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${target}";`,
					`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${target}";`,
				);
			} else {
				statements.push(
					`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${target}";`,
					`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO "${target}";`,
					`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${target}";`,
					`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO "${target}";`,
				);
			}
		}
		await this.executeDatabaseSql(id, env, `${statements.join('\n')}\n`);
		await this.verifyDatabaseRole(id, env, target, newPassword);
	}

	private async executeDatabaseSql(
		id: string,
		env: { user: string; password: string; database: string },
		sql: string,
	): Promise<void> {
		const child = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-i',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${id}`,
				'psql',
				'-h',
				'127.0.0.1',
				'-v',
				'ON_ERROR_STOP=1',
				'-U',
				env.user,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: env.password },
				stdin: 'pipe',
				stdout: 'ignore',
				stderr: 'pipe',
			},
		);
		child.stdin.write(sql);
		child.stdin.end();
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0)
			throw new Error(`credential SQL failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);
	}

	private async verifyDatabaseRole(
		id: string,
		env: { user: string; password: string; database: string },
		target: string,
		password: string,
	): Promise<void> {
		const verify = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${id}`,
				'psql',
				'-h',
				'127.0.0.1',
				'-tAc',
				'SELECT 1',
				'-U',
				target,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: password },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [code, out] = await Promise.all([verify.exited, new Response(verify.stdout).text()]);
		if (code !== 0 || out.trim() !== '1')
			throw new Error('The named credential did not pass the verification query.');
	}

	/**
	 * Fixed `pg_dump -Fc` verb for managed backups (docs/DATABASES.md §9). The dump is written to a
	 * 0400 staging file under the workload runtime dir; the caller streams it and removes it.
	 * Credentials are read from the env file the helper itself wrote for the container and passed
	 * to podman through its environment, never through argv.
	 */
	async dumpDatabase(id: string): Promise<{ path: string; sizeBytes: number; filename: string }> {
		assertDatabaseId(id, 'database id');
		const env = await this.readDatabaseEnv(id);
		if (env.engine !== 'postgres') return this.dumpEngine(id, env);
		const runtimeDir = join(this.runtimeDir, id);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const path = join(runtimeDir, `dump-${randomUUID()}.dump`);
		const child = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${id}`,
				'pg_dump',
				'-Fc',
				'--no-owner',
				'-U',
				env.user,
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: env.password },
				stdin: 'ignore',
				stdout: Bun.file(path),
				stderr: 'pipe',
			},
		);
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0) {
			await fs.rm(path, { force: true }).catch(() => undefined);
			throw new Error(`pg_dump failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);
		}
		const info = await fs.stat(path);
		await fs.chmod(path, 0o400);
		return { path, sizeBytes: info.size, filename: `${id}.dump` };
	}

	/**
	 * Fixed `pg_restore` verb. The body is a `pg_dump -Fc` stream from the caller; it is piped
	 * straight into `pg_restore` inside the target container. Only `db_` ids are accepted, the
	 * database name and role are identifier-checked, and a verification query must pass.
	 */
	async restoreDatabase(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
		assertDatabaseId(id, 'database id');
		if (!body) throw new ValidationError('A restore needs a request body');
		const env = await this.readDatabaseEnv(id);
		if (env.engine !== 'postgres') return this.restoreEngine(id, env, body);
		const child = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-i',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${id}`,
				'pg_restore',
				'--clean',
				'--if-exists',
				'--no-owner',
				// GRANTs to named credentials would fail on a fresh instance where those roles do not
				// exist yet; the agent re-grants every credential after a restore or move (D97).
				'--no-acl',
				'--exit-on-error',
				'-U',
				env.user,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: env.password },
				stdin: 'pipe',
				stdout: 'ignore',
				stderr: 'pipe',
			},
		);
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value?.byteLength) {
					child.stdin.write(value);
					await child.stdin.flush();
				}
			}
		} finally {
			child.stdin.end();
		}
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0)
			throw new Error(`pg_restore failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);
		const verify = Bun.spawn(
			[
				this.podmanPath,
				'exec',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${id}`,
				'psql',
				'-tAc',
				'SELECT 1',
				'-U',
				env.user,
				'-d',
				env.database,
			],
			{
				env: { ...process.env, PGPASSWORD: env.password },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [verifyCode, verifyOut] = await Promise.all([
			verify.exited,
			new Response(verify.stdout).text(),
		]);
		if (verifyCode !== 0 || verifyOut.trim() !== '1')
			throw new Error('The restored database did not answer the verification query.');
	}

	/**
	 * Write the pgBackRest repository config and `.pgpass` for one database (docs/PITR.md) into its
	 * config directory, `/run/skiff-workloads/<id>/pgbackrest/`: 0400 files owned by the engine uid;
	 * credentials never enter desired state. The unit mounts the directory, so the running
	 * container sees a rewrite at once and nothing restarts. `/run` is a tmpfs: the agent calls
	 * this before every PITR task, which is what puts the files back after a reboot.
	 */
	async pitrConfigure(id: string, rawRepo: unknown): Promise<{ stanza: string; configPath: string }> {
		assertDatabaseId(id, 'database id');
		const repo = parsePitrRepo(rawRepo);
		const env = await this.readPostgresEnv(id);
		const stanza = pitrStanzaFor(id);
		const paths = pitrPaths(this.runtimeDir, id);
		await this.ensurePitrConfigDir(id);
		const files: Array<[string, string]> = [
			[paths.config, renderPgBackRestConfig({ stanza, repo, pg1User: env.user })],
			// pgBackRest and psql reach Postgres over the container's Unix socket.
			[paths.pgpass, renderPgPass(env.user, env.password)],
		];
		for (const [path, content] of files) {
			// Podman may once have created a directory at a bind-mount source (pre-0070 layout).
			const stat = await fs.lstat(path).catch(() => null);
			if (stat && !stat.isFile()) await fs.rm(path, { recursive: true, force: true });
			await this.writeIfChanged(path, content, 0o400);
			// Postgres (archive-push) and the restore containers run as uid 70: keep 0400, hand over.
			await this.chown(path, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid);
		}
		return { stanza, configPath: paths.config };
	}

	/**
	 * `stanza-create` (idempotent) then a full, differential or incremental base backup, both run by
	 * `podman exec` inside the database's own container: pgBackRest must share the host with
	 * Postgres and talks to it over the Unix socket.
	 */
	async pitrBaseBackup(id: string, rawType: unknown): Promise<{ stanza: string; type: PitrBaseBackupType }> {
		assertDatabaseId(id, 'database id');
		const type = parsePitrBackupType(rawType);
		const stanza = pitrStanzaFor(id);
		await this.requirePitrConfig(id);
		for (const args of renderPitrBackupArgs(stanza, type)) {
			const result = await this.runner.run(renderPitrExecArgs({ podmanPath: this.podmanPath, workloadId: id, args }));
			if (result.code !== 0)
				throw new Error(`pgbackrest ${args.at(-1)} failed (${result.code}): ${commandDetail(result)}`);
		}
		return { stanza, type };
	}

	/**
	 * Repository and archive state for one database, never its credentials: pgBackRest's `info`
	 * (the retained backups) and Postgres' own `pg_stat_archiver`, reduced to the recoverable
	 * window (`computePitrWindow`). Runs inside the database's container like a backup.
	 */
	async pitrStatus(id: string): Promise<HelperPitrStatus> {
		assertDatabaseId(id, 'database id');
		const stanza = pitrStanzaFor(id);
		const paths = pitrPaths(this.runtimeDir, id);
		const configured = await fs
			.lstat(paths.config)
			.then((stat) => stat.isFile())
			.catch(() => false);
		const empty: HelperPitrStatus = {
			configured: false,
			stanza,
			repo: { bucket: null, region: null, endpoint: null, path: null },
			archiveStatus: 'unknown',
			recoverableFrom: null,
			recoverableTo: null,
			backupCount: 0,
			newestBackupAt: null,
			newestBackupType: null,
			lastArchivedAt: null,
			lastFailedAt: null,
			repoMessage: null,
		};
		if (!configured) return empty;
		const text = await fs.readFile(paths.config, 'utf8');
		const value = (key: string) => {
			const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`));
			return line ? line.slice(key.length + 1).trim() || null : null;
		};
		const repo = {
			bucket: value('repo1-s3-bucket'),
			region: value('repo1-s3-region'),
			endpoint: value('repo1-s3-endpoint'),
			path: value('repo1-path'),
		};
		const env = await this.readPostgresEnv(id);
		const info = await this.runner.run(
			renderPitrExecArgs({
				podmanPath: this.podmanPath,
				workloadId: id,
				args: [`--stanza=${stanza}`, '--output=json', 'info'],
			}),
		);
		if (info.code !== 0) throw new Error(`pgbackrest info failed (${info.code}): ${commandDetail(info)}`);
		const summary = parsePgBackRestInfo(info.stdout, stanza);
		const archiverRun = await this.runner.run(
			renderPitrArchiverArgs({ podmanPath: this.podmanPath, workloadId: id, user: env.user, database: env.database }),
		);
		const archiver = archiverRun.code === 0 ? parseArchiverStats(archiverRun.stdout) : null;
		const window: PitrWindow = computePitrWindow(summary, archiver);
		return {
			configured: true,
			stanza,
			repo,
			archiveStatus: window.archiveStatus,
			recoverableFrom: window.recoverableFrom,
			recoverableTo: window.recoverableTo,
			backupCount: summary.backupCount,
			newestBackupAt: summary.newestBackupStopAt,
			newestBackupType: summary.newestBackupType,
			lastArchivedAt: archiver?.lastArchivedAt ?? null,
			lastFailedAt: archiver?.lastFailedAt ?? null,
			// 0 is ok and 2 is "no valid backups" (before the first backup); anything else is a
			// repository problem worth showing.
			repoMessage:
				summary.statusCode !== null && summary.statusCode !== 0 && summary.statusCode !== 2
					? (summary.statusMessage ?? `pgBackRest status ${summary.statusCode}`)
					: null,
		};
	}

	/**
	 * Restore the source's stanza to a timestamp into a NEW database (docs/PITR.md §Restore). The
	 * target must already be applied (env file, data dir, unit). Steps, all fixed argv:
	 *
	 * 1. stop the target and empty its data dir; `apply` refuses it until the restore ends;
	 * 2. `pgbackrest restore --type=time` in a one-shot container of the source's PITR image;
	 * 3. a detached one-shot Postgres replays WAL to the target and promotes;
	 * 4. rename the source's owner role and database to the target's and set the target's
	 *    password (`renderPitrRenameSql`, SQL over stdin), then stop it cleanly;
	 * 5. start the target unit and prove a password login as the target's owner answers.
	 */
	async pitrRestore(
		id: string,
		input: { targetDatabaseId: unknown; targetTime: unknown },
	): Promise<{ targetDatabaseId: string; targetTime: number; verified: true }> {
		assertDatabaseId(id, 'database id');
		const targetDatabaseId = assertDatabaseId(input.targetDatabaseId, 'target database id');
		if (targetDatabaseId === id)
			throw new ValidationError('A PITR restore must target a different database; in-place restore is not supported.');
		const targetTime = validatePitrTargetTime(input.targetTime, Date.now());
		const stanza = pitrStanzaFor(id);
		await this.requirePitrConfig(id);
		const configDir = pitrPaths(this.runtimeDir, id).dir;
		const sourceDir = await this.dataDirFor(id);
		// The one-shots must run the pgBackRest that wrote the repository: the source's PITR image,
		// chosen from the source cluster's own major version, never from the wire.
		const pgVersion = (await fs.readFile(join(sourceDir, 'pgdata', 'PG_VERSION'), 'utf8').catch(() => '')).trim();
		if (!/^\d{1,3}$/.test(pgVersion))
			throw new ValidationError(`Database ${id} has no readable PG_VERSION; a restore needs the source on this node.`);
		const image = postgresPitrImage(pgVersion);
		const sourceEnv = await this.readPostgresEnv(id);
		const targetEnv = await this.readPostgresEnv(targetDatabaseId);
		// Validate the rename before anything is destroyed.
		const renameSteps = renderPitrRenameSql({
			sourceUser: sourceEnv.user,
			sourceDatabase: sourceEnv.database,
			targetUser: targetEnv.user,
			targetDatabase: targetEnv.database,
			targetPassword: targetEnv.password,
		});
		const targetDir = await this.dataDirFor(targetDatabaseId);
		const scrub = (text: string) => text.split(targetEnv.password).join('***');
		const oneShot = { podmanPath: this.podmanPath, image, targetId: targetDatabaseId, targetDataDir: targetDir, configDir };
		const recovery = pitrRecoveryContainerName(targetDatabaseId);
		const removeOneShots = async () => {
			for (const name of [pitrRestoreContainerName(targetDatabaseId), recovery])
				await this.runner.run([this.podmanPath, 'rm', '--force', '--ignore', name]).catch(() => undefined);
		};

		this.pitrRestoring.add(targetDatabaseId);
		try {
			await this.systemctl(['stop', serviceUnitName(targetDatabaseId)], { allowFailure: true });
			await removeOneShots();
			const existing = await fs.lstat(targetDir).catch(() => null);
			if (existing && !existing.isDirectory()) throw new ValidationError(`${targetDir} is not a directory`);
			await fs.rm(targetDir, { recursive: true, force: true });
			// pgBackRest restores into an existing, empty PGDATA; the spool sits beside it.
			for (const dir of [targetDir, join(targetDir, 'pgdata'), join(targetDir, 'pgbackrest-spool')]) {
				await fs.mkdir(dir, { recursive: true, mode: 0o700 });
				await fs.chmod(dir, 0o700);
				await this.chown(dir, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid);
			}

			const restore = await this.runner.run(renderPitrRestoreArgs({ ...oneShot, stanza, targetTime }));
			if (restore.code !== 0)
				throw new Error(`pgbackrest restore failed (${restore.code}): ${commandDetail(restore)}`);

			const started = await this.runner.run(renderPitrRecoveryArgs(oneShot));
			if (started.code !== 0)
				throw new Error(`Could not start the recovery container (${started.code}): ${commandDetail(started)}`);
			await this.waitForPitrPromotion(targetDatabaseId, sourceEnv.user);

			for (const step of renameSteps) {
				const result = await this.runner.run(
					renderPitrRecoveryPsqlArgs({ podmanPath: this.podmanPath, targetId: targetDatabaseId, user: step.user }),
					{ stdin: step.sql },
				);
				if (result.code !== 0)
					throw new Error(`Could not hand the restored cluster to ${targetEnv.user} (${result.code}): ${scrub(commandDetail(result))}`);
			}
			const stopped = await this.runner.run([this.podmanPath, 'stop', '--time', '120', recovery]);
			if (stopped.code !== 0)
				throw new Error(`The recovery container did not stop cleanly (${stopped.code}): ${commandDetail(stopped)}`);
		} finally {
			await removeOneShots();
			this.pitrRestoring.delete(targetDatabaseId);
		}

		await this.systemctl(['start', serviceUnitName(targetDatabaseId)]);
		for (let attempt = 0; attempt < PITR_CANARY_ATTEMPTS; attempt += 1) {
			// A password login over TCP as the target's owner: proves the rename and the new password.
			const verify = await this.runner.run(
				[
					this.podmanPath,
					'exec',
					'-e',
					'PGPASSWORD',
					pitrContainerName(targetDatabaseId),
					'psql',
					'-h',
					'127.0.0.1',
					'-X',
					'-tAc',
					'SELECT 1',
					'-U',
					targetEnv.user,
					'-d',
					targetEnv.database,
				],
				{ env: { PGPASSWORD: targetEnv.password } },
			);
			if (verify.code === 0 && verify.stdout.trim() === '1') return { targetDatabaseId, targetTime, verified: true };
			await Bun.sleep(this.restorePollMs);
		}
		throw new Error(`The restored database did not answer the canary query within ${PITR_CANARY_ATTEMPTS} attempts.`);
	}

	/**
	 * Poll the recovery container until Postgres has replayed to the target and promoted. Recovery
	 * that cannot reach the target (WAL missing, target past the archive) makes Postgres exit; the
	 * container's last log lines are the error.
	 */
	private async waitForPitrPromotion(targetId: string, user: string): Promise<void> {
		const name = pitrRecoveryContainerName(targetId);
		for (let attempt = 0; attempt < PITR_RECOVERY_ATTEMPTS; attempt += 1) {
			const probe = await this.runner.run(
				renderPitrRecoveryPsqlArgs({ podmanPath: this.podmanPath, targetId, user, command: 'SELECT pg_is_in_recovery()' }),
			);
			if (probe.code === 0 && probe.stdout.trim() === 'f') return;
			const state = await this.runner.run([this.podmanPath, 'inspect', '--format', '{{.State.Running}}', name]);
			if (state.code !== 0 || state.stdout.trim() !== 'true') {
				const logs = await this.runner.run([this.podmanPath, 'logs', '--tail', '20', name]).catch(() => null);
				const detail = logs ? (logs.stderr.trim() || logs.stdout.trim()).slice(-800) : '';
				throw new Error(`Recovery stopped before reaching the target time${detail ? `: ${detail}` : '.'}`);
			}
			await Bun.sleep(this.restorePollMs);
		}
		throw new Error('Recovery did not reach the target time in time; the restore was abandoned.');
	}

	/** The per-database pgBackRest config directory: a real 0700 directory owned by uid 70. */
	private async ensurePitrConfigDir(id: string): Promise<string> {
		const { dir } = pitrPaths(this.runtimeDir, id);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(dir)).isDirectory()) throw new ValidationError(`${dir} is not a directory`);
		await fs.chmod(dir, 0o700);
		await this.chown(dir, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid);
		return dir;
	}

	private async requirePitrConfig(id: string): Promise<{ config: string; pgpass: string }> {
		const paths = pitrPaths(this.runtimeDir, id);
		const ready = await fs
			.lstat(paths.config)
			.then((stat) => stat.isFile())
			.catch(() => false);
		if (!ready) throw new ValidationError(`Database ${id} has no pgBackRest config; configure PITR first.`);
		return { config: paths.config, pgpass: paths.pgpass };
	}

	/** Resolve a managed database's data dir from the same roots `purge` uses (D78). */
	private async dataDirFor(id: string): Promise<string> {
		const roots = [resolve(this.stateDir)];
		const registry = await this.registry();
		for (const entry of Object.values(registry)) roots.push(resolve(entry.mountPath, 'skiff'));
		for (const root of roots) {
			const candidate = resolve(root, id);
			if (dirname(candidate) !== root || basename(candidate) !== id) continue;
			const stat = await fs.stat(candidate).catch(() => null);
			if (stat?.isDirectory()) return candidate;
		}
		// A not-yet-started target still gets its default state dir; volume-backed targets must be
		// applied before a restore so the registry can resolve them.
		return resolve(this.stateDir, id);
	}

	/**
	 * Owner credentials from the env file the helper itself wrote for the container. The engine is
	 * the helper's own `SKIFF_DB_ENGINE` marker; files written before D95 have none and are Postgres.
	 */
	private async readDatabaseEnv(id: string): Promise<DatabaseEnv> {
		const text = await fs.readFile(join(this.runtimeDir, id, 'env'), 'utf8').catch(() => null);
		if (text === null) throw new ValidationError(`Database ${id} has no runtime env file; start it first.`);
		const values = new Map<string, string>();
		for (const line of text.split('\n')) {
			const eq = line.indexOf('=');
			if (eq <= 0) continue;
			values.set(line.slice(0, eq), line.slice(eq + 1));
		}
		const marker = values.get('SKIFF_DB_ENGINE') ?? 'postgres';
		if (!Object.hasOwn(DATABASE_ENGINES, marker))
			throw new ValidationError(`Database ${id} has an unknown engine "${marker}" in its env file.`);
		const engine = marker as DatabaseEngine;
		const keys = DATABASE_ENGINES[engine].env;
		const user = values.get(keys.user) ?? '';
		const password = values.get(keys.password) ?? '';
		const database = keys.database ? (values.get(keys.database) ?? '') : '';
		if (!identifier(user) || (keys.database && !identifier(database)) || !password)
			throw new ValidationError(`Database ${id} is missing valid ${engine} credentials in its env file.`);
		return { engine, user, password, database };
	}

	/** The Postgres-only verbs (named roles, PITR) refuse any other engine. */
	private async readPostgresEnv(id: string): Promise<DatabaseEnv> {
		const env = await this.readDatabaseEnv(id);
		if (env.engine !== 'postgres') throw new ValidationError(`This operation is only supported for postgres, not ${env.engine}`);
		return env;
	}

	/**
	 * A broker reads its user, password and store caps from a helper-written config: 0600, owned by
	 * the container's uid, beside the env file (D111).
	 */
	/**
	 * zot's config directory (G1): `config.json` and the token certificate, owned by zot's uid and
	 * mounted read-only at /etc/zot. The events URL carries a secret, so the files are 0400.
	 */
	private async writeRegistryConfig(
		workload: WorkloadDesired,
		files: RegistrySecrets,
		workloadRuntimeDir: string,
	): Promise<{ path: string; changed: boolean }> {
		const registry = workload.registry!;
		const info = REGISTRY_ENGINES[registry.engine];
		const dir = join(workloadRuntimeDir, 'zot');
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		// Writable while the files are replaced, read-only (and zot's) afterwards.
		await fs.chmod(dir, 0o700);
		let config: string;
		try {
			config = renderZotConfig(registry, files);
		} catch (error) {
			throw new ValidationError((error as Error).message);
		}
		let changed = await this.writeIfChanged(join(dir, 'config.json'), config, 0o400);
		changed = (await this.writeIfChanged(join(dir, 'cert.pem'), files.certificatePem, 0o400)) || changed;
		const owned = [dir, join(dir, 'config.json'), join(dir, 'cert.pem')];
		if (files.adminHtpasswd) {
			changed = (await this.writeIfChanged(join(dir, 'htpasswd'), files.adminHtpasswd, 0o400)) || changed;
			owned.push(join(dir, 'htpasswd'));
		} else {
			changed = (await this.removeIfExists(join(dir, 'htpasswd'))) || changed;
		}
		for (const path of owned) await this.chown(path, info.uid, info.gid).catch(() => undefined);
		await fs.chmod(dir, 0o500).catch(() => undefined);
		return { path: dir, changed };
	}

	private async writeBrokerConfig(
		workload: WorkloadDesired,
		auth: { user: string; password: string },
		workloadRuntimeDir: string,
	): Promise<{ path: string; changed: boolean }> {
		const broker = workload.broker!;
		const info = BROKER_ENGINES[broker.engine];
		const path = join(workloadRuntimeDir, 'broker.conf');
		const content = renderNatsConfig({
			id: workload.id,
			user: auth.user,
			password: auth.password,
			memoryMb: workload.memoryMb,
			storageMb: broker.storageMb,
		});
		const changed = await this.writeIfChanged(path, content, 0o600);
		await this.chown(path, info.uid, info.gid).catch(() => undefined);
		return { path, changed };
	}

	/**
	 * Valkey/Redis read their ACL user from a helper-written config (the images take no credential
	 * env). It is 0600, owned by the container's uid, beside the env file. Other engines: null.
	 */
	private async writeKeyValueConfig(
		workload: WorkloadDesired,
		env: Record<string, string>,
		workloadRuntimeDir: string,
		studioPassword: string | null = null,
	): Promise<{ path: string; changed: boolean } | null> {
		const engine = workload.database?.engine;
		if (engine === 'clickhouse') return this.writeClickHouseConfig(workload, env, workloadRuntimeDir);
		if (engine !== 'valkey' && engine !== 'redis') return null;
		const info = DATABASE_ENGINES[engine];
		const path = join(workloadRuntimeDir, 'server.conf');
		let content = renderKeyValueConfig({
			user: env[info.env.user] ?? '',
			password: env[info.env.password] ?? '',
			memoryMb: workload.memoryMb,
		});
		// The read-only studio principal (track G): from the activation, else kept from the current
		// config (an activation fetched before the principal existed must not drop it).
		const studio =
			studioPassword ?? keyValueStudioPassword(await fs.readFile(path, 'utf8').catch(() => ''));
		if (studio) content = withKeyValueStudioUser(content, studio);
		const changed = await this.writeIfChanged(path, content, 0o600);
		await this.chown(path, info.uid, info.gid).catch(() => undefined);
		return { path, changed };
	}

	/**
	 * ClickHouse reads a helper-written standalone config and users file (docs/DATABASES.md §17).
	 * Both live in one 0700 directory owned by the image's uid, mounted read-only: a directory, so
	 * a rotated users file (renamed into place) is visible to the server, which reloads it.
	 */
	private async writeClickHouseConfig(
		workload: WorkloadDesired,
		env: Record<string, string>,
		workloadRuntimeDir: string,
	): Promise<{ path: string; changed: boolean }> {
		const info = DATABASE_ENGINES.clickhouse;
		const dir = join(workloadRuntimeDir, CLICKHOUSE_CONFIG_DIRNAME);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(dir)).isDirectory()) throw new ValidationError(`${dir} is not a directory`);
		await fs.chmod(dir, 0o700);
		await this.chown(dir, info.uid, info.gid).catch(() => undefined);
		const config = renderClickHouseServerConfig({ memoryMb: workload.memoryMb });
		const users = renderClickHouseUsers({ user: env[info.env.user] ?? '', password: env[info.env.password] ?? '' });
		let changed = await this.writeIfChanged(join(dir, CLICKHOUSE_CONFIG_FILE), config, 0o600);
		changed = (await this.writeIfChanged(join(dir, CLICKHOUSE_USERS_FILE), users, 0o600)) || changed;
		for (const name of [CLICKHOUSE_CONFIG_FILE, CLICKHOUSE_USERS_FILE])
			await this.chown(join(dir, name), info.uid, info.gid).catch(() => undefined);
		return { path: dir, changed };
	}

	/**
	 * Fixed dump verbs for MySQL/MariaDB (`mysqldump`/`mariadb-dump`, plain SQL of the one
	 * database, consistent via `--single-transaction`) and MongoDB (`mongodump --archive --gzip`).
	 * Like `pg_dump`, the dump goes to a 0400 staging file and passwords never reach argv: the SQL
	 * clients read `MYSQL_PWD` from podman's environment, and MongoDB tools read a 0600 YAML config
	 * written into the container's tmpfs over stdin.
	 */
	private async dumpEngine(id: string, env: DatabaseEnv): Promise<{ path: string; sizeBytes: number; filename: string }> {
		if (env.engine === 'valkey' || env.engine === 'redis' || env.engine === 'clickhouse') return this.dumpNative(id, env);
		const runtimeDir = join(this.runtimeDir, id);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const container = `skiff-workload-${id}`;
		let argv: string[];
		let extension: string;
		let spawnEnv: Record<string, string | undefined> = process.env;
		switch (env.engine) {
			case 'mysql':
			case 'mariadb': {
				const tool = env.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
				argv = [
					this.podmanPath,
					'exec',
					'-e',
					'MYSQL_PWD',
					container,
					tool,
					'-uroot',
					'--single-transaction',
					'--routines',
					'--triggers',
					'--events',
					...(env.engine === 'mysql' ? ['--no-tablespaces', '--set-gtid-purged=OFF'] : []),
					env.database,
				];
				spawnEnv = { ...process.env, MYSQL_PWD: env.password };
				extension = 'sql';
				break;
			}
			case 'mongodb': {
				await this.writeMongoToolConfig(container, env.password);
				argv = [
					this.podmanPath,
					'exec',
					container,
					'mongodump',
					'--quiet',
					...mongoToolArgs(env.user),
					'--db',
					env.database,
					'--archive',
					'--gzip',
				];
				extension = 'archive.gz';
				break;
			}
			default:
				throw new ValidationError(`Backups are not supported for ${env.engine}`);
		}
		const path = join(runtimeDir, `dump-${randomUUID()}.${extension}`);
		try {
			const child = Bun.spawn(argv, { env: spawnEnv, stdin: 'ignore', stdout: Bun.file(path), stderr: 'pipe' });
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (code !== 0) {
				await fs.rm(path, { force: true }).catch(() => undefined);
				throw new Error(`${argv[argv.indexOf(container) + 1]} failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);
			}
		} finally {
			if (env.engine === 'mongodb') await this.removeMongoToolConfig(container);
		}
		const info = await fs.stat(path);
		await fs.chmod(path, 0o400);
		return { path, sizeBytes: info.size, filename: `${id}.${extension}` };
	}

	/**
	 * Restore a dump into a new MySQL/MariaDB/MongoDB database, then run a verification query. A
	 * MongoDB archive is renamed into the target database (`--nsFrom '$db$.$coll$'`), since a
	 * restore always targets a new database with its own name.
	 */
	private async restoreEngine(id: string, env: DatabaseEnv, body: ReadableStream<Uint8Array>): Promise<void> {
		if (env.engine === 'valkey' || env.engine === 'redis' || env.engine === 'clickhouse')
			return this.restoreNative(id, env, body);
		const container = `skiff-workload-${id}`;
		let argv: string[];
		let spawnEnv: Record<string, string | undefined> = process.env;
		switch (env.engine) {
			case 'mysql':
			case 'mariadb':
				argv = [this.podmanPath, 'exec', '-i', '-e', 'MYSQL_PWD', container, DATABASE_ENGINES[env.engine].cli, '-uroot', env.database];
				spawnEnv = { ...process.env, MYSQL_PWD: env.password };
				break;
			case 'mongodb':
				await this.writeMongoToolConfig(container, env.password);
				argv = [
					this.podmanPath,
					'exec',
					'-i',
					container,
					'mongorestore',
					'--quiet',
					...mongoToolArgs(env.user),
					'--archive',
					'--gzip',
					'--drop',
					'--nsFrom',
					'$db$.$coll$',
					'--nsTo',
					`${env.database}.$coll$`,
				];
				break;
			default:
				throw new ValidationError(`Restores are not supported for ${env.engine}`);
		}
		try {
			const child = Bun.spawn(argv, { env: spawnEnv, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
			const reader = body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value?.byteLength) {
						child.stdin.write(value);
						await child.stdin.flush();
					}
				}
			} finally {
				child.stdin.end();
			}
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (code !== 0)
				throw new Error(`${env.engine} restore failed (${code}): ${stderr.trim().slice(0, 500) || 'no detail'}`);
		} finally {
			if (env.engine === 'mongodb') await this.removeMongoToolConfig(container);
		}
		if (!(await this.verifyEngineLogin(id, env, env.password)))
			throw new Error('The restored database did not answer the verification query.');
	}

	/**
	 * Native file dumps (docs/DATABASES.md §8): a Valkey/Redis RDB snapshot (`--rdb`, then
	 * `check-rdb` over the whole file) or a ClickHouse `BACKUP DATABASE … TO File(…zip)`. The server
	 * writes the file into the data dir's staging directory, so it is returned from there (0400)
	 * instead of being copied into the runtime tmpfs; the server's cleanup timer removes it, and
	 * anything a restart left behind is pruned before the next run.
	 */
	private async dumpNative(id: string, env: DatabaseEnv): Promise<{ path: string; sizeBytes: number; filename: string }> {
		const staging = await this.prepareDumpStaging(id, env.engine);
		const container = `skiff-workload-${id}`;
		const extension = env.engine === 'clickhouse' ? 'zip' : 'rdb';
		const file = stagingFileName('dump', randomUUID(), extension);
		const path = join(staging, file);
		try {
			if (env.engine === 'clickhouse') {
				const result = await this.runner.run(
					clickhouseClientArgv({
						podmanPath: this.podmanPath,
						container,
						user: env.user,
						query: clickhouseBackupQuery(env.database, file),
					}),
					{ env: { CLICKHOUSE_PASSWORD: env.password } },
				);
				if (result.code !== 0)
					throw new Error(`ClickHouse BACKUP failed (${result.code}): ${detailOf(result)}`);
			} else {
				const engine = env.engine as KeyValueEngine;
				const dump = await this.runner.run(
					keyValueRdbDumpArgv({ podmanPath: this.podmanPath, container, engine, user: env.user, file }),
					{ env: { REDISCLI_AUTH: env.password } },
				);
				if (dump.code !== 0 || keyValueReplyFailed(dump.stdout))
					throw new Error(`${engine}-cli --rdb failed (${dump.code}): ${detailOf(dump)}`);
				const check = await this.runner.run(keyValueCheckRdbArgv({ podmanPath: this.podmanPath, container, engine, file }));
				if (check.code !== 0)
					throw new Error(`${engine}-check-rdb rejected the snapshot (${check.code}): ${detailOf(check)}`);
			}
			const info = await fs.lstat(path).catch(() => null);
			if (!info?.isFile() || info.size === 0) throw new Error(`The ${env.engine} dump produced no file.`);
			await fs.chmod(path, 0o400);
			return { path, sizeBytes: info.size, filename: `${id}.${extension}` };
		} catch (error) {
			await fs.rm(path, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Restore a native file dump into a new database. The body is staged in the target's data dir
	 * first (owned by the engine's uid), then:
	 *
	 * - Valkey/Redis: `check-rdb` must accept it while the target still runs; the unit is stopped,
	 *   the snapshot replaces the AOF as its base file (with a fresh manifest), and the unit is
	 *   started. `PING` must answer `PONG`, which it only does once the dataset has loaded.
	 * - ClickHouse: `RESTORE DATABASE skiff_backup AS <target>` into the running server, which
	 *   verifies every part's checksum; the staging archive is removed either way.
	 */
	private async restoreNative(id: string, env: DatabaseEnv, body: ReadableStream<Uint8Array>): Promise<void> {
		const staging = await this.prepareDumpStaging(id, env.engine);
		const owner = DATABASE_ENGINES[env.engine];
		const container = `skiff-workload-${id}`;
		const extension = env.engine === 'clickhouse' ? 'zip' : 'rdb';
		const file = stagingFileName('restore', randomUUID(), extension);
		const path = join(staging, file);
		try {
			await Bun.write(path, new Response(body));
			await fs.chmod(path, 0o600);
			await this.chown(path, owner.uid, owner.gid).catch(() => undefined);
			if ((await fs.stat(path)).size === 0) throw new ValidationError('The backup artifact is empty.');
			if (env.engine === 'clickhouse') {
				const result = await this.runner.run(
					clickhouseClientArgv({
						podmanPath: this.podmanPath,
						container,
						user: env.user,
						query: clickhouseRestoreQuery(env.database, file),
					}),
					{ env: { CLICKHOUSE_PASSWORD: env.password } },
				);
				if (result.code !== 0)
					throw new Error(`ClickHouse RESTORE failed (${result.code}): ${detailOf(result)}`);
				const verify = await this.runner.run(
					clickhouseClientArgv({
						podmanPath: this.podmanPath,
						container,
						user: env.user,
						query: `SELECT 'skiff-ok' FROM system.databases WHERE name = '${env.database}'`,
					}),
					{ env: { CLICKHOUSE_PASSWORD: env.password } },
				);
				if (verify.code !== 0 || verify.stdout.trim() !== 'skiff-ok')
					throw new Error('The restored database did not answer the verification query.');
				return;
			}
			const engine = env.engine as KeyValueEngine;
			const check = await this.runner.run(keyValueCheckRdbArgv({ podmanPath: this.podmanPath, container, engine, file }));
			if (check.code !== 0)
				throw new Error(`${engine}-check-rdb rejected the backup (${check.code}): ${detailOf(check)}`);
			const dataDir = dirname(staging);
			const aofDir = join(dataDir, KEY_VALUE_AOF_DIRNAME);
			await this.systemctl(['stop', serviceUnitName(id)]);
			try {
				await fs.rm(aofDir, { recursive: true, force: true });
				await fs.rm(join(dataDir, 'dump.rdb'), { force: true });
				await fs.mkdir(aofDir, { mode: 0o700 });
				await fs.rename(path, join(aofDir, KEY_VALUE_AOF_BASE));
				await fs.writeFile(join(aofDir, KEY_VALUE_AOF_MANIFEST), keyValueAofManifest(), { mode: 0o600 });
				for (const target of [aofDir, join(aofDir, KEY_VALUE_AOF_BASE), join(aofDir, KEY_VALUE_AOF_MANIFEST)])
					await this.chown(target, owner.uid, owner.gid).catch(() => undefined);
			} finally {
				// Start again even when the swap failed: the target must not be left stopped.
				await this.systemctl(['start', serviceUnitName(id)], { allowFailure: true });
			}
			for (let attempt = 0; attempt < KEY_VALUE_RESTORE_ATTEMPTS; attempt += 1) {
				const ping = await this.runner.run(
					keyValuePingArgv({ podmanPath: this.podmanPath, container, engine, user: env.user }),
					{ env: { REDISCLI_AUTH: env.password } },
				);
				if (ping.code === 0 && ping.stdout.trim() === 'PONG') return;
				await Bun.sleep(this.restorePollMs);
			}
			throw new Error(
				`The restored database did not answer PING within ${Math.round((KEY_VALUE_RESTORE_ATTEMPTS * this.restorePollMs) / 1000)} seconds.`,
			);
		} finally {
			await fs.rm(path, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * The `skiff-dumps` directory in a database's data dir, created 0700 for the engine's uid (the
	 * server writes and reads the files), with stale leftovers from an interrupted run removed.
	 */
	private async prepareDumpStaging(id: string, engine: DatabaseEngine): Promise<string> {
		const dataDir = await this.dataDirFor(id);
		if (!(await fs.lstat(dataDir).catch(() => null))?.isDirectory())
			throw new ValidationError(`Database ${id} has no data directory; start it first.`);
		const staging = join(dataDir, DUMP_STAGING_DIRNAME);
		await fs.mkdir(staging, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(staging)).isDirectory()) throw new ValidationError(`${staging} is not a directory`);
		await fs.chmod(staging, 0o700);
		await this.chown(staging, DATABASE_ENGINES[engine].uid, DATABASE_ENGINES[engine].gid).catch(() => undefined);
		const now = Date.now();
		for (const name of await fs.readdir(staging).catch(() => [] as string[])) {
			const info = await fs.lstat(join(staging, name)).catch(() => null);
			if (info?.isFile() && isStaleStagingFile(name, info.mtimeMs, now))
				await fs.rm(join(staging, name), { force: true }).catch(() => undefined);
		}
		return staging;
	}

	/**
	 * Owner password rotation for engines other than Postgres (D86). The statements go over stdin,
	 * never argv; a fresh login with the new password must then succeed.
	 *
	 * - MySQL/MariaDB: `ALTER USER` for the owner and for `root@localhost`, which the helper keeps
	 *   on the owner's password so its fixed verbs can use the local socket.
	 * - MongoDB: `changeUserPassword` on the owner, who lives in `admin`.
	 * - Valkey/Redis: `ACL SETUSER … resetpass >new` live; the re-activation that follows a
	 *   successful rotation rewrites the server config, so a restart keeps the new password.
	 * - ClickHouse: the owner is a config user, so the helper rewrites `users.xml` with the new
	 *   hash and the server reloads it within a few seconds; the re-activation that follows writes
	 *   the same file from the new env.
	 */
	private async rotateEngineOwner(id: string, env: DatabaseEnv, newPassword: string): Promise<void> {
		if (env.engine === 'clickhouse') return this.rotateClickHouseOwner(id, env, newPassword);
		const container = `skiff-workload-${id}`;
		let argv: string[];
		let spawnEnv: Record<string, string | undefined> = process.env;
		let script: string;
		switch (env.engine) {
			case 'mysql':
			case 'mariadb': {
				const quoted = newPassword.replace(/'/g, "''");
				argv = [this.podmanPath, 'exec', '-i', '-e', 'MYSQL_PWD', container, DATABASE_ENGINES[env.engine].cli, '-uroot'];
				spawnEnv = { ...process.env, MYSQL_PWD: env.password };
				script = `ALTER USER '${env.user}'@'%' IDENTIFIED BY '${quoted}';\nALTER USER 'root'@'localhost' IDENTIFIED BY '${quoted}';\n`;
				break;
			}
			case 'mongodb':
				argv = [this.podmanPath, 'exec', '-i', container, 'mongosh', '--quiet', '--nodb'];
				script =
					`const c = connect('mongodb://127.0.0.1:27017/admin', ${JSON.stringify(env.user)}, ${JSON.stringify(env.password)});\n` +
					`c.changeUserPassword(${JSON.stringify(env.user)}, ${JSON.stringify(newPassword)});\n`;
				break;
			case 'valkey':
			case 'redis':
				argv = [this.podmanPath, 'exec', '-i', '-e', 'REDISCLI_AUTH', container, DATABASE_ENGINES[env.engine].cli, '--no-auth-warning', '--user', env.user];
				spawnEnv = { ...process.env, REDISCLI_AUTH: env.password };
				script = `ACL SETUSER ${env.user} resetpass >${newPassword}\n`;
				break;
			default:
				throw new ValidationError(`Rotation is not supported for ${env.engine}`);
		}
		const child = Bun.spawn(argv, { env: spawnEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		child.stdin.write(script);
		child.stdin.end();
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		// valkey-cli exits 0 on a command error; its reply is on stdout.
		const replyError = (env.engine === 'valkey' || env.engine === 'redis') && /^\(error\)|^ERR|^WRONGPASS|^NOAUTH/m.test(stdout);
		if (code !== 0 || replyError)
			throw new Error(`Password change failed (${code}): ${(stderr.trim() || stdout.trim()).slice(0, 500) || 'no detail'}`);
		if (!(await this.verifyEngineLogin(id, env, newPassword)))
			throw new Error('The rotated credential did not pass the verification query.');
	}

	private async rotateClickHouseOwner(id: string, env: DatabaseEnv, newPassword: string): Promise<void> {
		const info = DATABASE_ENGINES.clickhouse;
		const path = join(this.runtimeDir, id, CLICKHOUSE_CONFIG_DIRNAME, CLICKHOUSE_USERS_FILE);
		if (!(await fs.stat(path).catch(() => null)))
			throw new ValidationError(`Database ${id} has no generated ClickHouse config; start it first.`);
		await this.writeIfChanged(path, renderClickHouseUsers({ user: env.user, password: newPassword }), 0o600);
		await this.chown(path, info.uid, info.gid).catch(() => undefined);
		// The server polls its users file; give the reload a few seconds before giving up.
		for (let attempt = 0; attempt < CLICKHOUSE_RELOAD_ATTEMPTS; attempt += 1) {
			if (await this.verifyEngineLogin(id, env, newPassword)) return;
			await Bun.sleep(CLICKHOUSE_RELOAD_DELAY_MS);
		}
		throw new Error('The rotated credential did not pass the verification query.');
	}

	/** A fresh owner login over TCP with `password`, answered by the engine's smallest query. */
	private async verifyEngineLogin(id: string, env: DatabaseEnv, password: string): Promise<boolean> {
		const container = `skiff-workload-${id}`;
		let argv: string[];
		let spawnEnv: Record<string, string | undefined> = process.env;
		let stdin: string | null = null;
		let expected: string;
		switch (env.engine) {
			case 'mysql':
			case 'mariadb':
				argv = [this.podmanPath, 'exec', '-e', 'MYSQL_PWD', container, DATABASE_ENGINES[env.engine].cli, '-h', '127.0.0.1', '-u', env.user, '-N', '-s', '-e', 'SELECT 1', env.database];
				spawnEnv = { ...process.env, MYSQL_PWD: password };
				expected = '1';
				break;
			case 'mongodb':
				argv = [this.podmanPath, 'exec', '-i', container, 'mongosh', '--quiet', '--nodb'];
				stdin =
					`const c = connect('mongodb://127.0.0.1:27017/admin', ${JSON.stringify(env.user)}, ${JSON.stringify(password)});\n` +
					`print('skiff-ok-' + c.runCommand({ ping: 1 }).ok);\n`;
				expected = 'skiff-ok-1';
				break;
			case 'valkey':
			case 'redis':
				argv = [this.podmanPath, 'exec', '-e', 'REDISCLI_AUTH', container, DATABASE_ENGINES[env.engine].cli, '--no-auth-warning', '--user', env.user, 'PING'];
				spawnEnv = { ...process.env, REDISCLI_AUTH: password };
				expected = 'PONG';
				break;
			case 'clickhouse':
				// clickhouse-client reads CLICKHOUSE_PASSWORD from its environment, overriding the
				// container's (old) value; the native port is not published, only used in-container.
				argv = [this.podmanPath, 'exec', '-e', 'CLICKHOUSE_PASSWORD', container, 'clickhouse-client', '--host', '127.0.0.1', '--user', env.user, '--query', "SELECT 'skiff-ok'"];
				spawnEnv = { ...process.env, CLICKHOUSE_PASSWORD: password };
				expected = 'skiff-ok';
				break;
			default:
				return false;
		}
		const child = Bun.spawn(argv, { env: spawnEnv, stdin: stdin === null ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' });
		if (stdin !== null && child.stdin && typeof child.stdin !== 'number') {
			child.stdin.write(stdin);
			child.stdin.end();
		}
		const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
		// mongosh echoes a `> ` prompt before each line it reads from stdin.
		return code === 0 && out.split('\n').some((line) => line.replace(/^(?:>\s*)+/, '').trim() === expected);
	}

	/**
	 * MongoDB tools read the password from `--config`. It is written over stdin with `tee` (no
	 * shell) into the container's own /tmp tmpfs, where only the image's uid runs, and removed
	 * after the tool exits.
	 */
	private async writeMongoToolConfig(container: string, password: string): Promise<void> {
		const child = Bun.spawn([this.podmanPath, 'exec', '-i', container, 'tee', MONGO_TOOL_CONFIG], {
			stdin: 'pipe',
			stdout: 'ignore',
			stderr: 'pipe',
		});
		child.stdin.write(`password: ${JSON.stringify(password)}\n`);
		child.stdin.end();
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`Could not stage the MongoDB tool config (${code}): ${stderr.trim().slice(0, 300)}`);
	}

	private async removeMongoToolConfig(container: string): Promise<void> {
		await this.runner
			.run([this.podmanPath, 'exec', container, 'rm', '-f', MONGO_TOOL_CONFIG])
			.catch(() => undefined);
	}

	/**
	 * Delete a purged database's or storage instance's data dir (D59, S8). Only `db_`/`st_` ids,
	 * only `<stateDir>/<id>`, and only after the unit is gone. A missing dir is success, so the
	 * verb is idempotent.
	 */
	async purge(id: string): Promise<void> {
		assertManagedId(id, 'managed id');
		await this.remove(id);
		// The data dir is under the state root or, for a disk-backed workload, `<mount>/skiff`
		// (D78). Both are fixed shapes with the id as the basename; nothing else is ever removed.
		const roots = [resolve(this.stateDir)];
		const registry = await this.registry();
		for (const entry of Object.values(registry)) roots.push(resolve(entry.mountPath, 'skiff'));
		for (const root of roots) {
			const target = resolve(root, id);
			if (dirname(target) !== root || basename(target) !== id)
				throw new ValidationError(`Refusing to purge ${target}: not a direct child of ${root}`);
			await fs.rm(target, { recursive: true, force: true });
		}
	}

	/**
	 * Replace one workload's identity token without re-applying its unit (IAM.md I18). The agent
	 * calls this at 50% of the token's lifetime. Ownership is preserved, so a container's `:U`
	 * hand-over survives every rotation.
	 */
	async setIdentity(id: string, token: string): Promise<void> {
		assertId(id, 'workload id');
		await this.writeIdentity(join(this.identityDir, id, 'token'), token);
	}

	private async writeIdentity(path: string, token: string): Promise<void> {
		if (typeof token !== 'string' || token.length === 0 || token.length > 16_384 || token.includes('\0'))
			throw new ValidationError('The workload identity token is malformed');
		const directory = dirname(path);
		await fs.mkdir(directory, { recursive: true, mode: 0o750 });
		await fs.chmod(directory, 0o750).catch(() => undefined);
		const existing = await fs.lstat(path).catch(() => null);
		if (existing && !existing.isFile())
			throw new ValidationError(`The identity path ${path} is not a regular file`);
		await this.writeAtomic(path, token, 0o400);
		if (existing) await this.chown(path, existing.uid, existing.gid);
	}

	/** Stop both drivers, remove generated units and scrub the runtime secret directory. */
	async remove(id: string): Promise<void> {
		assertId(id, 'workload id');
		const paths = this.unitPaths(id);
		// Best effort: units may not exist or systemd may be unavailable (dev).
		await this.systemctl(['disable', '--now', serviceUnitName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', socketUnitName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', poolerServiceName(id)], { allowFailure: true });

		let changed = false;
		// Compose: remove every rendered service unit, using the manifest and a directory scan so a
		// half-written manifest still cannot leave a container behind.
		const services = new Set<string>((await this.readComposeManifest(id)) ?? []);
		const prefix = `skiff-workload-${id}--`;
		for (const name of await fs.readdir(this.quadletDir).catch(() => [] as string[])) {
			if (!name.startsWith(prefix) || !name.endsWith('.container')) continue;
			const service = name.slice(prefix.length, -'.container'.length);
			if (/^[a-z0-9][a-z0-9-]*$/.test(service)) services.add(service);
		}
		for (const service of services) {
			const serviceId = this.composeServiceId(id, service);
			await this.systemctl(['disable', '--now', serviceUnitName(serviceId)], { allowFailure: true });
			const servicePaths = this.unitPaths(serviceId);
			for (const path of [servicePaths.container, servicePaths.service, servicePaths.socket])
				changed = (await this.removeIfExists(path)) || changed;
		}
		for (const path of [paths.service, paths.socket, paths.container, paths.pooler]) {
			changed = (await this.removeIfExists(path)) || changed;
		}
		if (changed) await this.daemonReload();
		await fs.rm(join(this.runtimeDir, id), { recursive: true, force: true });
		await fs.rm(join(this.identityDir, id), { recursive: true, force: true });
	}

	/**
	 * Stop one workload's service (FN4 scale to zero). The `.socket` unit is deliberately left
	 * alone and keeps listening — `RemoveOnStop=yes` is on the socket, not the service — so the next
	 * connection cold-starts the host through socket activation. Idempotent: stopping a stopped or
	 * absent unit is success.
	 */
	async stop(id: string): Promise<void> {
		assertId(id, 'workload id');
		const compose = await this.readComposeManifest(id);
		if (compose) {
			for (const service of compose)
				await this.systemctl(['stop', serviceUnitName(this.composeServiceId(id, service))], { allowFailure: true });
			return;
		}
		await this.systemctl(['stop', serviceUnitName(id)], { allowFailure: true });
	}

	/**
	 * Restart a socket-activated workload the same way `apply` does: the service first, then the
	 * socket that owns the inherited listener (FN5 runaway watchdog). Idempotent: `systemctl
	 * restart` starts an inactive unit rather than failing.
	 */
	async restart(id: string): Promise<void> {
		assertId(id, 'workload id');
		const compose = await this.readComposeManifest(id);
		if (compose) {
			for (const service of compose)
				await this.systemctl(['restart', serviceUnitName(this.composeServiceId(id, service))], { allowFailure: true });
			return;
		}
		await this.systemctl(['restart', serviceUnitName(id)]);
		await this.systemctl(['restart', socketUnitName(id)]);
	}

	/** Actual service state, mapped onto the workload status vocabulary. */
	async status(id: string): Promise<HelperWorkloadStatus> {
		assertId(id, 'workload id');
		const manifest = await this.readComposeManifest(id);
		if (manifest) return this.composeStatus(id, manifest);
		const unit = await this.unitStatus(serviceUnitName(id));
		const tls = id.startsWith('db_') ? await readDatabaseTlsState(this.runtimeDir, id) : null;
		return {
			id,
			status: unit.status,
			restarts: unit.restarts,
			...(unit.memoryBytes !== undefined ? { memoryBytes: unit.memoryBytes } : {}),
			...(tls ? { tls } : {}),
		};
	}

	/** One unit's ActiveState/NRestarts/memory, without the workload envelope. */
	private async unitStatus(unit: string): Promise<{
		status: WorkloadStatus;
		restarts: number;
		memoryBytes?: number;
	}> {
		const result = await this.systemctl(
			[
				'show',
				unit,
				'--no-pager',
				'--property=ActiveState',
				'--property=SubState',
				'--property=NRestarts',
				'--property=MemoryCurrent',
				'--property=Result',
			],
			{ allowFailure: true },
		);
		if (result.code !== 0) return { status: 'stopped', restarts: 0 };
		const properties = parseProperties(result.stdout);
		const active = properties.ActiveState ?? '';
		const restarts = parseRestarts(properties.NRestarts);
		const memoryBytes = parseMemory(properties.MemoryCurrent);
		let status: WorkloadStatus;
		switch (active) {
			case 'active':
			case 'reloading':
				status = 'running';
				break;
			case 'activating':
				status = 'starting';
				break;
			case 'failed':
				status = 'failed';
				break;
			case 'deactivating':
			case 'inactive':
			case '':
				status = 'stopped';
				break;
			default:
				status = 'pending';
		}
		// A systemd restart loop shows up as `failed` only between attempts; NRestarts makes it
		// visible to the control plane even when the unit is momentarily active.
		if (status === 'running' && restarts >= 5) status = 'failed';
		return { status, restarts, ...(memoryBytes !== null ? { memoryBytes } : {}) };
	}

	/** A compose stack is running when every service is; the worst status wins. */
	private async composeStatus(id: string, services: string[]): Promise<HelperWorkloadStatus> {
		const rank: Record<WorkloadStatus, number> = { running: 0, starting: 1, stopped: 2, pending: 3, failed: 4 };
		let status: WorkloadStatus = 'stopped';
		let restarts = 0;
		let memoryBytes = 0;
		let seenMemory = false;
		for (const service of services) {
			const unit = await this.unitStatus(serviceUnitName(this.composeServiceId(id, service)));
			if (rank[unit.status] > rank[status]) status = unit.status;
			restarts += unit.restarts;
			if (unit.memoryBytes !== undefined) {
				memoryBytes += unit.memoryBytes;
				seenMemory = true;
			}
		}
		return { id, status, restarts, ...(seenMemory ? { memoryBytes } : {}) };
	}

	/**
	 * Read new journal entries for one workload unit. This is the helper's only read verb: a
	 * fixed journalctl argv, a bounded line count and JSON output. The agent drains it into the
	 * control plane so logs survive a node reboot or an agent restart.
	 */
	async logs(id: string, options: LogReadOptions = {}): Promise<HelperLogResult> {
		assertId(id, 'workload id');
		const lines = Math.max(1, Math.min(Math.floor(options.lines ?? 200), 1_000));
		// Compose logs are the union of every service unit, oldest first within the requested tail.
		const compose = await this.readComposeManifest(id);
		const units = compose
			? compose.map((service) => serviceUnitName(this.composeServiceId(id, service)))
			: [serviceUnitName(id)];
		const args = [
			this.journalctlPath,
			...units.flatMap((unit) => ['-u', unit]),
			'--no-pager',
			'-o',
			'json',
			'--output-fields=__CURSOR,__REALTIME_TIMESTAMP,MESSAGE,PRIORITY',
			'-n',
			String(lines),
		];
		const cursor = options.cursor?.trim();
		if (cursor) args.push('--after-cursor', cursor);
		const result = await this.runner.run(args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
			throw new Error(`journalctl for ${id} failed (${result.code}): ${detail.slice(0, 500)}`);
		}
		const entries: HelperLogEntry[] = [];
		for (const line of result.stdout.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			const entry = toLogEntry(record);
			if (entry) entries.push(entry);
		}
		entries.sort((a, b) => a.ts - b.ts);
		return {
			entries,
			nextCursor: entries.at(-1)?.cursor ?? cursor ?? null,
		};
	}

	/**
	 * Generate the database certificate when DB_TLS asked for it. A certificate failure is not a
	 * database failure: the unit is rendered without TLS and the error is reported by `status`.
	 */
	private async databaseTlsFor(workload: WorkloadDesired): Promise<DatabaseTlsState | null> {
		if (!workload.database) return null;
		if (!workload.database.tls) {
			await disableDatabaseTls(this.runtimeDir, workload.id);
			return readDatabaseTlsState(this.runtimeDir, workload.id);
		}
		try {
			return await this.databaseTlsGenerator({
				runner: this.runner,
				opensslPath: this.opensslPath,
				runtimeDir: this.runtimeDir,
				id: workload.id,
				alias: databaseAlias(workload.id),
				chown: this.chown,
			});
		} catch {
			// The generator records the detail in tls/error; status surfaces it to the control plane.
			return readDatabaseTlsState(this.runtimeDir, workload.id);
		}
	}

	private async writeSecrets(
		secretsDir: string,
		workload: WorkloadDesired,
		activation: WorkloadActivation,
	): Promise<UnitSecretFile[]> {
		const expected = new Set(
			workload.secrets.filter((secret) => secret.delivery === 'file').map((secret) => secret.name),
		);
		const entries = Object.entries(activation.files);
		for (const name of Object.keys(activation.files)) {
			if (!expected.has(name))
				throw new ValidationError(`activation file ${name} is not a file secret of this workload`);
		}

		if (entries.length === 0) {
			await fs.rm(secretsDir, { recursive: true, force: true });
			return [];
		}

		await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
		await fs.chmod(secretsDir, 0o700).catch(() => undefined);

		// Drop files for secrets that were removed from the spec.
		for (const existing of await fs.readdir(secretsDir)) {
			if (!expected.has(existing)) await fs.rm(join(secretsDir, existing), { force: true });
		}

		const files: UnitSecretFile[] = [];
		for (const [name, value] of entries) {
			assertRelativePath(name, 'secret file name');
			const path = join(secretsDir, name);
			await this.writeAtomic(path, value, 0o400);
			files.push({ name, path });
		}
		return files.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Every module in the resolved function spec must be a regular file inside the release. The
	 * names are validated relative paths (no `..`, no absolute form), so `join` cannot escape.
	 * Fail closed: a host that starts with a missing module would serve a half-broken bundle.
	 */
	private async verifyFunctionModules(fn: WorkloadFunction, releaseDir: string): Promise<string[]> {
		const paths: string[] = [];
		for (const module of fn.modules) {
			const path = join(releaseDir, module.name);
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(path);
			} catch {
				throw new ValidationError(
					`Function module ${module.name} is missing from release ${releaseDir}; refusing to start`,
				);
			}
			if (!stat.isFile())
				throw new ValidationError(
					`Function module ${module.name} is not a regular file in release ${releaseDir}; refusing to start`,
				);
			paths.push(path);
		}
		return paths;
	}

	/**
	 * The pinned workerd binary for one function (FN1). There is no fetch and no fallback: the
	 * version is part of the resolved spec, the installer shipped the binary, and a missing one is a
	 * validation error naming both the version and the path the node expected.
	 */
	private async resolveWorkerd(version: string): Promise<string> {
		if (!/^\d+\.\d+\.\d+$/.test(version))
			throw new ValidationError('workload.function.workerdVersion must match <major>.<minor>.<patch>');
		const directory = assertAbsolutePath(join(this.workerdDir, version), 'workerd directory');
		const binary = join(directory, 'workerd');
		try {
			await fs.access(binary, fsConstants.X_OK);
		} catch {
			throw new ValidationError(
				`workerd ${version} is not installed at ${binary}; the node must ship that pinned build`,
			);
		}
		return binary;
	}

	/** Find the release in any configured root; the agent and helper use different data dirs. */
	private async resolveRelease(sha256: string): Promise<string> {
		for (const root of this.releaseDirs) {
			const candidate = join(root, sha256);
			try {
				const stat = await fs.stat(candidate);
				if (stat.isDirectory()) return candidate;
			} catch {
				// Try the next root.
			}
		}
		throw new ValidationError(
			`Release ${sha256} is not present on this node (looked in ${this.releaseDirs.join(', ')})`,
		);
	}

	/**
	 * The contract documents `bun run start` as the process default when the release ships a
	 * package.json; we use the absolute bun path so the unit does not depend on PATH search. A
	 * Node.js app (D125) runs its `start` script instead, see `nodeStartCommand`.
	 */
	private async defaultCommand(releaseDir: string, engine: 'bun' | 'node'): Promise<string[]> {
		const manifest = join(releaseDir, 'package.json');
		const display = engine === 'node' ? 'the package.json start script' : '"bun run start"';
		let text: string;
		try {
			const stat = await fs.stat(manifest);
			if (!stat.isFile()) throw new ValidationError(`workload.command is required (${manifest} is not a file)`);
			if (stat.size > 1_048_576)
				throw new ValidationError(`workload.command is required (${manifest} is too large)`);
			if (engine === 'bun') return [this.bunPath, 'run', 'start'];
			text = await fs.readFile(manifest, 'utf8');
		} catch (error) {
			if (error instanceof ValidationError) throw error;
			throw new ValidationError(
				`workload.command is required: ${releaseDir} has no package.json to derive ${display} from`,
			);
		}
		return nodeStartCommand(text, releaseDir, dirname(this.nodePath));
	}

	/** Write a Quadlet network; returns true when systemd needs a daemon-reload. */
	private async ensureNetworkUnit(networkName: string): Promise<boolean> {
		return this.writeIfChanged(
			join(this.quadletDir, networkUnitName(networkName)),
			renderNetworkUnit(networkName),
			0o644,
		);
	}

	/**
	 * Confirm the workload container is a member of its network, and attach it if Quadlet did not.
	 * A failed inspect is not fatal: the network or container may still be starting.
	 */
	private async ensureNetworkMembership(workload: WorkloadDesired, networkName: string): Promise<boolean> {
		const inspect = await this.runner
			.run([this.podmanPath, 'network', 'inspect', networkName, '--format', '{{json .Containers}}'])
			.catch(() => null);
		if (!inspect || inspect.code !== 0) return false;
		const container = `skiff-workload-${workload.id}`;
		if (networkHasContainer(inspect.stdout, container)) return true;
		const connect = await this.runner
			.run([this.podmanPath, 'network', 'connect', networkName, container])
			.catch(() => null);
		return connect?.code === 0;
	}

	private async systemctl(args: string[], options: { allowFailure?: boolean } = {}): Promise<RunResult> {
		const result = await this.runner.run([this.systemctlPath, ...args]);
		if (!options.allowFailure && result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
			throw new Error(`systemctl ${args[0] ?? ''} failed (${result.code}): ${detail}`);
		}
		return result;
	}

	private async daemonReload(): Promise<void> {
		await this.systemctl(['daemon-reload']);
	}

	/** Atomic replacement; returns false when the content is unchanged (no daemon-reload needed). */
	private async writeIfChanged(path: string, content: string, mode: number): Promise<boolean> {
		try {
			const current = await fs.readFile(path, 'utf8');
			if (current === content) return false;
		} catch {
			// Missing file: write it below.
		}
		await this.writeAtomic(path, content, mode);
		return true;
	}

	private async writeAtomic(path: string, content: string, mode: number): Promise<void> {
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
		const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			handle = await fs.open(tmp, 'w', mode);
			await handle.writeFile(content);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await fs.chmod(tmp, mode);
			await fs.rename(tmp, path);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async removeIfExists(path: string): Promise<boolean> {
		try {
			await fs.rm(path, { force: false });
			return true;
		} catch (error) {
			if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT')
				return false;
			throw error;
		}
	}
}

/** Names the retired D60 studio console used; only `removeLegacyConsoles` still matches them. */
const LEGACY_CONSOLE_UNIT = /^skiff-workload-(db_[A-Za-z0-9_-]+)-console\.container$/;
const LEGACY_CONSOLE_CONTAINER = /^skiff-workload-(db_[A-Za-z0-9_-]+)-console$/;

function isDatabaseId(value: string): boolean {
	try {
		assertDatabaseId(value);
		return true;
	} catch {
		return false;
	}
}

/** `podman network inspect --format {{json .Containers}}` is a map, but accept a list too. */
function networkHasContainer(stdout: string, container: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return false;
	}
	const matches = (value: unknown): boolean => {
		if (!value || typeof value !== 'object') return false;
		const record = value as Record<string, unknown>;
		return record.Name === container || record.name === container;
	};
	if (Array.isArray(parsed)) return parsed.some(matches);
	if (parsed && typeof parsed === 'object') {
		return Object.entries(parsed as Record<string, unknown>).some(
			([key, value]) => key === container || matches(value),
		);
	}
	return false;
}

/** Journald stores MESSAGE as a string, or as bytes when the unit emitted invalid UTF-8. */
function journalMessage(value: unknown): string {
	if (typeof value === 'string') return value.slice(0, 16_384);
	if (Array.isArray(value)) {
		try {
			return new TextDecoder().decode(Uint8Array.from(value as number[])).slice(0, 16_384);
		} catch {
			return '';
		}
	}
	return '';
}

function toLogEntry(record: Record<string, unknown>): HelperLogEntry | null {
	const cursor = typeof record.__CURSOR === 'string' ? record.__CURSOR : '';
	if (!cursor) return null;
	const micros = Number(record.__REALTIME_TIMESTAMP ?? 0);
	const ts = Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) : Date.now();
	const priorityRaw = Number(record.PRIORITY ?? 6);
	const priority = Number.isInteger(priorityRaw) ? Math.max(0, Math.min(priorityRaw, 7)) : 6;
	const message = journalMessage(record.MESSAGE);
	if (!message) return null;
	return { cursor, ts, priority, message };
}

/** Postgres role/database names are derived from slugs; this keeps podman argv free of syntax. */
/** Owner credentials parsed from a database's helper-written env file. */
interface DatabaseEnv {
	engine: DatabaseEngine;
	user: string;
	password: string;
	/** Empty for Valkey/Redis, which have numbered databases. */
	database: string;
}

/** ClickHouse polls its users file every couple of seconds; rotation waits up to ~15 s. */
const CLICKHOUSE_RELOAD_ATTEMPTS = 15;
const CLICKHOUSE_RELOAD_DELAY_MS = 1000;

/** Valkey/Redis restores poll `PING` until the dataset has loaded (default ~10 minutes). */
const KEY_VALUE_RESTORE_ATTEMPTS = 600;

/** The useful part of a failed command's output, for an error message. */
function detailOf(result: RunResult): string {
	return (result.stderr.trim() || result.stdout.trim()).slice(0, 500) || 'no detail';
}

/** Inside the container's /tmp tmpfs; removed after every MongoDB tool run. */
const MONGO_TOOL_CONFIG = '/tmp/skiff-mongo-tool.yaml';

/** Connection flags shared by `mongodump`/`mongorestore` (the password comes from `--config`). */
function mongoToolArgs(user: string): string[] {
	return ['--host', '127.0.0.1', '--username', user, '--authenticationDatabase', 'admin', `--config=${MONGO_TOOL_CONFIG}`];
}

/** The uid/gid a managed service's data dir and config belong to; null for an app workload. */
function managedOwner(workload: WorkloadDesired): { uid: number; gid: number } | null {
	if (workload.database) return DATABASE_ENGINES[workload.database.engine];
	if (workload.objectStorage) return STORAGE_ENGINES[workload.objectStorage.engine];
	if (workload.broker) return BROKER_ENGINES[workload.broker.engine];
	if (workload.registry) return REGISTRY_ENGINES[workload.registry.engine];
	return null;
}

/** Remove the registry's certificate and event sink from the env and validate them (G1). */
export function takeRegistryFiles(env: Record<string, string>): RegistrySecrets {
	const take = (name: string) => {
		const value = env[name];
		delete env[name];
		return value;
	};
	const cert = take(REGISTRY_CERT_ENV);
	const events = take(REGISTRY_EVENTS_ENV);
	const htpasswd = take(REGISTRY_ADMIN_HTPASSWD_ENV);
	const accessKey = take(REGISTRY_S3_ACCESS_KEY_ENV);
	const secretKey = take(REGISTRY_S3_SECRET_KEY_ENV);
	const cacheUrl = take(REGISTRY_CACHE_URL_ENV);
	try {
		const s3 =
			accessKey || secretKey || cacheUrl
				? (() => {
						if (!accessKey || !secretKey || !cacheUrl) throw new Error('S3 storage needs an access key, a secret key and a cache URL');
						if (!/^rediss?:\/\/\S+$/.test(cacheUrl)) throw new Error(`${REGISTRY_CACHE_URL_ENV} must be a redis:// or rediss:// URL`);
						if (/\s/.test(accessKey + secretKey)) throw new Error('S3 credentials cannot contain whitespace');
						return { accessKey, secretKey, cacheUrl };
					})()
				: null;
		return {
			certificatePem: assertCertificatePem(cert),
			eventsUrl: assertEventsUrl(events),
			adminHtpasswd: assertAdminHtpasswd(htpasswd),
			s3,
		};
	} catch (error) {
		throw new ValidationError((error as Error).message);
	}
}

/** Activation env names that carry the broker's credentials (set by the control plane, D111). */
export const BROKER_USER_ENV = 'SKIFF_BROKER_USER';
export const BROKER_PASSWORD_ENV = 'SKIFF_BROKER_PASSWORD';

/** Remove the broker's credentials from the container env and return them for its config. */
export function takeBrokerAuth(env: Record<string, string>): { user: string; password: string } {
	const user = env[BROKER_USER_ENV] ?? '';
	const password = env[BROKER_PASSWORD_ENV] ?? '';
	delete env[BROKER_USER_ENV];
	delete env[BROKER_PASSWORD_ENV];
	if (!user || !password) throw new ValidationError('A broker needs its user and password in the activation');
	return { user, password };
}

/**
 * Fixed broker env: Go's soft memory limit at 80% of the unit's `MemoryMax`, so the server collects
 * garbage before the cgroup OOM-kills it.
 */
export function brokerFixedEnv(memoryMb: number): Record<string, string> {
	return { GOMEMLIMIT: `${Math.max(32, Math.floor(memoryMb * 0.8))}MiB` };
}

/**
 * Settings the helper fixes for each engine, applied over the wire env (D61). Postgres keeps its
 * original single `PGDATA` so existing env files are unchanged. MySQL/MariaDB keep `root` on the
 * owner's password but bound to the container's own socket (`ROOT_HOST=localhost`), which is how
 * the fixed verbs authenticate; MariaDB upgrades its system tables on a version change.
 */
export function databaseFixedEnv(engine: DatabaseEngine, env: Record<string, string>): Record<string, string> {
	const password = env[DATABASE_ENGINES[engine].env.password] ?? '';
	switch (engine) {
		case 'postgres':
			return { PGDATA: DATABASE_PGDATA };
		case 'mysql':
			return { SKIFF_DB_ENGINE: engine, MYSQL_ROOT_PASSWORD: password, MYSQL_ROOT_HOST: 'localhost' };
		case 'mariadb':
			return {
				SKIFF_DB_ENGINE: engine,
				MARIADB_ROOT_PASSWORD: password,
				MARIADB_ROOT_HOST: 'localhost',
				MARIADB_AUTO_UPGRADE: '1',
			};
		case 'mongodb':
		case 'valkey':
		case 'redis':
			return { SKIFF_DB_ENGINE: engine };
		case 'clickhouse':
			// The entrypoint reads the helper's standalone config and leaves users to it; the owner
			// in CLICKHOUSE_USER/PASSWORD is what its first-start `CREATE DATABASE` logs in as.
			return {
				SKIFF_DB_ENGINE: engine,
				CLICKHOUSE_CONFIG: `${CLICKHOUSE_CONFIG_DIR}/${CLICKHOUSE_CONFIG_FILE}`,
				CLICKHOUSE_SKIP_USER_SETUP: '1',
				CLICKHOUSE_WATCHDOG_ENABLE: '0',
			};
	}
}

/** Poll budget for WAL replay in a restore (× `restorePollMs`, 1 s by default: 90 minutes). */
const PITR_RECOVERY_ATTEMPTS = 90 * 60;
/** Poll budget for the restored target's first password login. */
const PITR_CANARY_ATTEMPTS = 120;

/** The useful part of a failed command's output, for an error message. */
function commandDetail(result: RunResult): string {
	return (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 500);
}

function identifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
}

function validateSocketMode(mode: string): string {
	if (!/^0[0-7]{3}$/.test(mode)) throw new ValidationError('socketMode must be an octal mode like 0660');
	return mode;
}

function parseProperties(stdout: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of stdout.split('\n')) {
		const index = line.indexOf('=');
		if (index <= 0) continue;
		properties[line.slice(0, index)] = line.slice(index + 1);
	}
	return properties;
}

function parseRestarts(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? '0', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** `MemoryCurrent` is `[not set]` (or `infinity`) before a unit has run. */
function parseMemory(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The default Node.js command (D125): the package.json `start` script under `/bin/sh -c`, with
 * the release's `node_modules/.bin` and the pinned Node first on PATH, as `npm start` would set
 * them. Not `npm start` or `node --run start`: both spawn the script with every non-stdio fd
 * closed, so a socket-activated app never sees its listener. A shell passes fd 3 through.
 */
export function nodeStartCommand(packageJson: string, releaseDir: string, nodeBinDir: string): string[] {
	let script: unknown;
	try {
		const parsed = JSON.parse(packageJson) as { scripts?: { start?: unknown } } | null;
		script = parsed?.scripts?.start;
	} catch {
		throw new ValidationError('workload.command is required: package.json is not valid JSON');
	}
	if (typeof script !== 'string' || script.trim() === '')
		throw new ValidationError(
			'workload.command is required: package.json has no "start" script (add one, or set the command)',
		);
	const [start] = assertCommand([script], 'package.json scripts.start');
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const path = `${shellQuote(join(releaseDir, 'node_modules', '.bin'))}:${shellQuote(nodeBinDir)}:"$PATH"`;
	return ['/bin/sh', '-c', `PATH=${path}; export PATH; ${start}`];
}
