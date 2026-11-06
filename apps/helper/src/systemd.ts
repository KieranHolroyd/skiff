import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
	consoleServiceName,
	consoleUnitName,
	containerUnitName,
	networkUnitName,
	poolerServiceName,
	poolerUnitName,
	renderConsoleEnv,
	renderConsoleUnit,
	renderContainerEnvFile,
	renderContainerUnit,
	renderEnvFile,
	renderKeyValueConfig,
	renderNetworkUnit,
	renderPoolerConfig,
	renderPoolerUnit,
	renderPoolerUserlist,
	renderProcessUnit,
	renderSliceUnit,
	renderSocketUnit,
	serviceUnitName,
	socketUnitName,
	type UnitSecretFile,
	type UnitVolumeMount,
} from './units.ts';
import {
	DATABASE_ENGINES,
	STORAGE_ENGINES,
	STORAGE_ENV,
	ValidationError,
	assertAbsolutePath,
	assertDatabaseId,
	assertManagedId,
	assertMemoryMb,
	assertCpuWeight,
	assertId,
	assertPort,
	assertRelativePath,
	databaseAlias,
	workloadNetworkName,
	type DatabaseEngine,
	type WorkloadActivation,
	type WorkloadConsoleActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from './validate.ts';
import {
	parsePitrBackupType,
	parsePitrRepo,
	pitrPaths,
	pitrStanzaFor,
	renderPgBackRestConfig,
	renderPgPass,
	renderPitrPodmanArgs,
	validatePitrTargetTime,
} from './pitr.ts';
import {
	databaseTlsPaths,
	disableDatabaseTls,
	generateDatabaseTls,
	readDatabaseTlsState,
	type DatabaseTlsGenerator,
	type DatabaseTlsState,
} from './tls.ts';

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

export interface CommandRunner {
	run(argv: string[]): Promise<RunResult>;
}

/** Default runner: argv only, stdin closed, no shell. */
export function spawnRunner(): CommandRunner {
	return {
		async run(argv: string[]): Promise<RunResult> {
			if (argv.length === 0) throw new Error('Refusing to run an empty command');
			const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
	/** Root-owned runtime directory for env files and sockets, normally /run/skiff-workloads. */
	runtimeDir: string;
	/** Persistent container data root, normally /var/lib/skiff-workloads. */
	stateDir: string;
	/** Volume registry written by the root applier, normally /etc/skiff/volumes.json (D74). */
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
	systemctlPath?: string;
	journalctlPath?: string;
	/** Absolute podman binary used by the fixed database dump/restore verbs. */
	podmanPath?: string;
	/** Absolute openssl used to generate per-database certificates (DB_TLS). */
	opensslPath?: string;
	/** AppArmor profile for container workloads; null keeps the runtime default. */
	apparmorProfile?: string | null;
	/** Injectable certificate generator for tests; defaults to the fixed openssl argv sequence. */
	databaseTlsGenerator?: DatabaseTlsGenerator;
	socketMode?: string;
	socketGroup?: string | null;
	/**
	 * Hands a database data dir to the engine's user. Defaults to `fs.chown` when running as root
	 * and to a no-op otherwise, so tests (and dev) run unprivileged.
	 */
	chown?: (path: string, uid: number, gid: number) => Promise<void>;
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
	console: string;
}

export class SystemdDriver {
	private readonly runner: CommandRunner;
	private readonly unitDir: string;
	private readonly quadletDir: string;
	private readonly runtimeDir: string;
	private readonly stateDir: string;
	private readonly volumeRegistryFile: string;
	private readonly volumeRegistryOverride: VolumeRegistry | null;
	private readonly releaseDirs: string[];
	private readonly bunPath: string;
	private readonly systemctlPath: string;
	private readonly journalctlPath: string;
	private readonly podmanPath: string;
	private readonly opensslPath: string;
	private readonly apparmorProfile: string | null;
	private readonly databaseTlsGenerator: DatabaseTlsGenerator;
	private readonly socketMode: string;
	private readonly socketGroup: string | null;
	private readonly chown: (path: string, uid: number, gid: number) => Promise<void>;

	constructor(options: SystemdDriverOptions) {
		this.runner = options.runner;
		this.unitDir = assertAbsolutePath(options.unitDir, 'unitDir');
		this.quadletDir = assertAbsolutePath(options.quadletDir ?? options.unitDir, 'quadletDir');
		this.runtimeDir = assertAbsolutePath(options.runtimeDir, 'runtimeDir');
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
		this.systemctlPath = assertAbsolutePath(options.systemctlPath ?? '/usr/bin/systemctl', 'systemctlPath');
		this.journalctlPath = assertAbsolutePath(
			options.journalctlPath ?? '/usr/bin/journalctl',
			'journalctlPath',
		);
		this.podmanPath = assertAbsolutePath(options.podmanPath ?? '/usr/bin/podman', 'podmanPath');
		this.opensslPath = assertAbsolutePath(options.opensslPath ?? '/usr/bin/openssl', 'opensslPath');
		this.apparmorProfile = options.apparmorProfile ?? null;
		this.databaseTlsGenerator = options.databaseTlsGenerator ?? generateDatabaseTls;
		this.socketMode = validateSocketMode(options.socketMode ?? '0666');
		this.socketGroup = options.socketGroup ?? null;
		this.chown = options.chown ?? defaultChown();
	}

	unitPaths(id: string): UnitPaths {
		assertId(id, 'workload id');
		return {
			service: join(this.unitDir, serviceUnitName(id)),
			socket: join(this.unitDir, socketUnitName(id)),
			container: join(this.quadletDir, containerUnitName(id)),
			pooler: join(this.quadletDir, poolerUnitName(id)),
			console: join(this.quadletDir, consoleUnitName(id)),
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
	 * Replace the volume registry from desired state (D74). The agent may ask, but the helper
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

	private async registry(): Promise<VolumeRegistry> {
		return this.volumeRegistryOverride ?? readVolumeRegistry(this.volumeRegistryFile);
	}

	/**
	 * Where one container's data lives (D74). A volume-backed workload is resolved through the
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
	 * A node-volume backing is verified with `findmnt` every start; a missing mount fails the
	 * start rather than creating `/mnt/empty/skiff/apps/...` on the root disk. State-dir volumes
	 * live under the helper's own state directory. Only `<base>/<volumeId>` is created.
	 */
	async resolveAppVolumeMounts(workload: WorkloadDesired): Promise<UnitVolumeMount[]> {
		const mounts = workload.volumes ?? [];
		if (mounts.length === 0) return [];
		const registry = await this.registry();
		const verified = new Set<string>();
		const owner = workload.database
			? DATABASE_ENGINES[workload.database.engine]
			: workload.objectStorage
				? STORAGE_ENGINES[workload.objectStorage.engine]
				: null;
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
	): Promise<HelperWorkloadStatus> {
		assertId(workload.id, 'workload.id');
		if (activation.workloadId !== workload.id)
			throw new ValidationError('activation.workloadId does not match workload.id');
		if (activation.activationVersion !== workload.activationVersion)
			throw new ValidationError('activation.activationVersion does not match the desired workload');

		// Resolve everything that can fail before writing a secret to disk.
		let releaseDir: string | null = null;
		let command: string[] | null = null;
		if (workload.runtime === 'process') {
			releaseDir = await this.resolveRelease(workload.release!);
			command = workload.command ?? (await this.defaultCommand(releaseDir));
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
		// The database profile pins its data inside the /data mount; never the image's VOLUME. Each
		// engine's fixed settings win over anything on the wire (D61).
		if (workload.database) Object.assign(env, databaseFixedEnv(workload.database.engine, env));
		// The storage profile's fixed settings win over anything on the wire (S1).
		if (workload.objectStorage) Object.assign(env, STORAGE_ENV);
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
		} else {
			const image = workload.image!;
			// Each org gets its own network; write it first so Quadlet can resolve it. A workload
			// without an org keeps the legacy shared network, so old desired state still converges.
			const networkName = workloadNetworkName(workload);
			changed = (await this.ensureNetworkUnit(networkName)) || changed;
			const dataDir = await this.resolveDataDir(workload);
			if (workload.volumeId) await fs.mkdir(dirname(dataDir), { recursive: true, mode: 0o755 });
			await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
			const owner = workload.database
				? DATABASE_ENGINES[workload.database.engine]
				: workload.objectStorage
					? STORAGE_ENGINES[workload.objectStorage.engine]
					: null;
			if (owner) {
				// chown follows symlinks; the data dir must be a real directory under stateDir.
				if (!(await fs.lstat(dataDir)).isDirectory())
					throw new ValidationError(`${dataDir} is not a directory`);
				await fs.chmod(dataDir, 0o700);
				await this.chown(dataDir, owner.uid, owner.gid);
			}
			const tls = await this.databaseTlsFor(workload);
			const serverConfigPath = await this.writeKeyValueConfig(workload, env, workloadRuntimeDir);
			if (serverConfigPath) changed = serverConfigPath.changed || changed;
			const container = renderContainerUnit({
				workload,
				image,
				envFile,
				dataDir,
				secretsDir: Object.keys(activation.files).length > 0 ? secretsDir : null,
				...(workload.database?.pitr
					? {
							pitr: {
								stanza: workload.database.pitr.stanza,
								configPath: pitrPaths(this.runtimeDir, workload.id).config,
								pgpassPath: pitrPaths(this.runtimeDir, workload.id).pgpass,
								archiveTimeoutSeconds: workload.database.pitr.archiveTimeoutSeconds,
							},
						}
					: {}),
				tlsDir: tls?.enabled ? databaseTlsPaths(this.runtimeDir, workload.id).dir : null,
				serverConfigPath: serverConfigPath?.path ?? null,
				volumeMounts,
				apparmorProfile: this.apparmorProfile,
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

	/** Restart only the PgBouncer sidecar, leaving Postgres and its connections untouched. */
	async restartPooler(id: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		await this.systemctl(['restart', '--no-block', poolerServiceName(id)]);
	}

	/**
	 * Start (or replace) an on-demand DBGate studio sidecar (D60). The Postgres container is never
	 * re-applied or restarted: the console is a separate Quadlet on the same network. Credentials
	 * come from the database's own helper-written env file; the session password only reaches the
	 * 0600 console env file.
	 */
	async startConsole(
		workload: WorkloadDesired,
		activation: WorkloadConsoleActivation,
	): Promise<void> {
		const id = assertDatabaseId(workload.id, 'database id');
		if (!workload.database)
			throw new ValidationError('A studio console needs a database workload');
		if (activation.databaseId !== id)
			throw new ValidationError('activation.databaseId does not match workload.id');
		const port = assertPort(activation.port, 'console port');
		const env = await this.readDatabaseEnv(id);

		const runtimeDir = join(this.runtimeDir, id);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		await fs.chmod(runtimeDir, 0o700).catch(() => undefined);
		const envFile = join(runtimeDir, 'console.env');
		await this.writeAtomic(
			envFile,
			renderConsoleEnv({
				id,
				database: env,
				engine: env.engine,
				webRoot: activation.webRoot,
				authUser: activation.authUser,
				authPassword: activation.authPassword,
				readOnly: activation.readOnly,
				...(activation.tls ? { tls: true } : {}),
			}),
			0o600,
		);

		const paths = this.unitPaths(id);
		await this.writeIfChanged(
			paths.console,
			renderConsoleUnit({
				workload,
				envFile,
				port,
				apparmorProfile: this.apparmorProfile,
			}),
			0o644,
		);
		await this.daemonReload();
		// The unit may be disabled after a previous stop; enabling is best effort because the
		// start below is explicit and does not depend on it.
		await this.systemctl(['enable', consoleServiceName(id)], { allowFailure: true });
		// The first start pulls the image under TimeoutStartSec=120; queue it like a database.
		await this.systemctl(['restart', '--no-block', consoleServiceName(id)]);
	}

	/** Stop a studio sidecar and remove its generated unit and env file. Never touches Postgres. */
	async stopConsole(id: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		await this.systemctl(['disable', '--now', consoleServiceName(id)], { allowFailure: true });
		const paths = this.unitPaths(id);
		await this.removeIfExists(paths.console);
		await this.removeIfExists(join(this.runtimeDir, id, 'console.env'));
		await this.daemonReload();
	}

	/**
	 * Start the studio process for the agent. Blocking (not `--no-block`): a Type=simple unit is
	 * started once its process is exec'd, so a missing unit or a start-limit hit comes back as the
	 * systemctl error instead of a silent queued job.
	 */
	async startStudio(): Promise<void> {
		await this.systemctl(['start', STUDIO_UNIT]);
	}

	/** Stop the studio process. It normally exits by itself when idle. */
	async stopStudio(): Promise<void> {
		await this.systemctl(['stop', STUDIO_UNIT]);
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
	 * Write the pgBackRest repository config and `.pgpass` for one database (docs/PITR.md). Both
	 * files are 0400 under `/run/skiff-workloads/<id>/`; credentials never enter desired state.
	 * Writing them also restarts the database unit so `archive_command` becomes usable.
	 */
	async pitrConfigure(id: string, rawRepo: unknown): Promise<{ stanza: string; configPath: string }> {
		assertDatabaseId(id, 'database id');
		const repo = parsePitrRepo(rawRepo);
		const env = await this.readPostgresEnv(id);
		const stanza = pitrStanzaFor(id);
		const paths = pitrPaths(this.runtimeDir, id);
		await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		await fs.chmod(paths.dir, 0o700).catch(() => undefined);
		const config = renderPgBackRestConfig({
			stanza,
			repo,
			pg1Path: DATABASE_PGDATA,
			pg1Host: databaseAlias(id),
			pg1Port: DATABASE_ENGINES.postgres.containerPort,
			pg1User: env.user,
		});
		const pgpass = renderPgPass(env.user, env.password, databaseAlias(id), '5432');
		// Podman may have created a directory at a bind-mount source before the file existed.
		for (const path of [paths.config, paths.pgpass]) {
			const stat = await fs.lstat(path).catch(() => null);
			if (stat?.isDirectory()) await fs.rm(path, { recursive: true, force: true });
		}
		await this.writeAtomic(paths.config, config, 0o400);
		await this.writeAtomic(paths.pgpass, pgpass, 0o400);
		// The Postgres container and the sidecar run as uid/gid 70; a root-owned 0400 file would be
		// unreadable to both. Keep the mode 0400 but hand ownership to the engine user.
		await this.chown(paths.config, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid);
		await this.chown(paths.pgpass, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid);
		await this.systemctl(['restart', '--no-block', serviceUnitName(id)], { allowFailure: true });
		return { stanza, configPath: paths.config };
	}

	/** Create the stanza if needed, then run a full or differential pgBackRest base backup. */
	async pitrBaseBackup(
		id: string,
		rawType: unknown,
	): Promise<{ stanza: string; type: 'full' | 'diff' | 'incr' }> {
		assertDatabaseId(id, 'database id');
		const type = parsePitrBackupType(rawType);
		const stanza = pitrStanzaFor(id);
		const paths = await this.requirePitrConfig(id);
		const dataDir = await this.dataDirFor(id);
		const run = (args: string[], network: boolean) =>
			this.runner.run(
				renderPitrPodmanArgs({
					podmanPath: this.podmanPath,
					workloadId: id,
					dataDir,
					configPath: paths.config,
					pgpassPath: paths.pgpass,
					network,
					args: [`--stanza=${stanza}`, ...args],
				}),
			);
		const created = await run(['stanza-create'], true);
		if (created.code !== 0) throw new Error(`pgbackrest stanza-create failed (${created.code}): ${created.stderr.trim().slice(0, 500)}`);
		const backup = await run(['backup', `--type=${type}`], true);
		if (backup.code !== 0) throw new Error(`pgbackrest backup failed (${backup.code}): ${backup.stderr.trim().slice(0, 500)}`);
		return { stanza, type };
	}

	/** Archive/repository status for one database. Never returns repository credentials. */
	async pitrStatus(id: string): Promise<{
		configured: boolean;
		stanza: string;
		repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
		archiveStatus: 'ok' | 'failing' | 'unknown';
	}> {
		assertDatabaseId(id, 'database id');
		const stanza = pitrStanzaFor(id);
		const paths = pitrPaths(this.runtimeDir, id);
		const configured = await fs.lstat(paths.config).then((stat) => stat.isFile()).catch(() => false);
		if (!configured) {
			return { configured: false, stanza, repo: { bucket: null, region: null, endpoint: null, path: null }, archiveStatus: 'unknown' };
		}
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
		const dataDir = await this.dataDirFor(id);
		const info = await this.runner.run(
			renderPitrPodmanArgs({
				podmanPath: this.podmanPath,
				workloadId: id,
				dataDir,
				configPath: paths.config,
				pgpassPath: paths.pgpass,
				args: [`--stanza=${stanza}`, 'info', '--output=json'],
			}),
		);
		let archiveStatus: 'ok' | 'failing' | 'unknown' = 'unknown';
		if (info.code === 0) {
			try {
				const parsed = JSON.parse(info.stdout) as Array<{ archive?: Array<{ status?: string }> }>;
				const statuses = parsed.flatMap((entry) => entry.archive ?? []).map((entry) => entry.status);
				if (statuses.length > 0) archiveStatus = statuses.every((status) => status === 'ok') ? 'ok' : 'failing';
			} catch {
				archiveStatus = 'unknown';
			}
		} else if (/archive|error/i.test(info.stderr)) {
			archiveStatus = 'failing';
		}
		return { configured: true, stanza, repo, archiveStatus };
	}

	/**
	 * Restore one stanza to a timestamp into a NEW database's data dir (docs/PITR.md). The target
	 * unit is stopped, its cluster is replaced from the repository, the container is started and a
	 * canary query must answer before the helper reports success.
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
		const paths = await this.requirePitrConfig(id);
		const targetDir = await this.dataDirFor(targetDatabaseId);
		const targetEnv = await this.readPostgresEnv(targetDatabaseId);

		await this.systemctl(['stop', serviceUnitName(targetDatabaseId)], { allowFailure: true });
		await fs.rm(targetDir, { recursive: true, force: true });
		await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
		await fs.chmod(targetDir, 0o700).catch(() => undefined);
		await this.chown(targetDir, DATABASE_ENGINES.postgres.uid, DATABASE_ENGINES.postgres.gid).catch(() => undefined);

		const restore = await this.runner.run(
			renderPitrPodmanArgs({
				podmanPath: this.podmanPath,
				workloadId: id,
				dataDir: targetDir,
				configPath: paths.config,
				pgpassPath: paths.pgpass,
				args: [
					`--stanza=${stanza}`,
					'--pg1-path=/data/pgdata',
					'--type=time',
					`--target=${new Date(targetTime).toISOString()}`,
					'--target-action=promote',
					'restore',
				],
			}),
		);
		if (restore.code !== 0)
			throw new Error(`pgbackrest restore failed (${restore.code}): ${restore.stderr.trim().slice(0, 500)}`);

		await this.systemctl(['start', serviceUnitName(targetDatabaseId)], { allowFailure: true });
		for (let attempt = 0; attempt < 60; attempt += 1) {
			const verify = await this.runner.run([
				this.podmanPath,
				'exec',
				'-e',
				'PGPASSWORD',
				`skiff-workload-${targetDatabaseId}`,
				'psql',
				'-tAc',
				'SELECT 1',
				'-U',
				targetEnv.user,
				'-d',
				targetEnv.database,
			]);
			if (verify.code === 0 && verify.stdout.trim() === '1')
				return { targetDatabaseId, targetTime, verified: true };
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		throw new Error('The restored database did not answer the canary query within 60 seconds.');
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

	/** Resolve a managed database's data dir from the same roots `purge` uses (D74). */
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
	 * Valkey/Redis read their ACL user from a helper-written config (the images take no credential
	 * env). It is 0600, owned by the container's uid, beside the env file. Other engines: null.
	 */
	private async writeKeyValueConfig(
		workload: WorkloadDesired,
		env: Record<string, string>,
		workloadRuntimeDir: string,
	): Promise<{ path: string; changed: boolean } | null> {
		const engine = workload.database?.engine;
		if (engine !== 'valkey' && engine !== 'redis') return null;
		const info = DATABASE_ENGINES[engine];
		const path = join(workloadRuntimeDir, 'server.conf');
		const content = renderKeyValueConfig({
			user: env[info.env.user] ?? '',
			password: env[info.env.password] ?? '',
			memoryMb: workload.memoryMb,
		});
		const changed = await this.writeIfChanged(path, content, 0o600);
		await this.chown(path, info.uid, info.gid).catch(() => undefined);
		return { path, changed };
	}

	/**
	 * Fixed dump verbs for MySQL/MariaDB (`mysqldump`/`mariadb-dump`, plain SQL of the one
	 * database, consistent via `--single-transaction`) and MongoDB (`mongodump --archive --gzip`).
	 * Like `pg_dump`, the dump goes to a 0400 staging file and passwords never reach argv: the SQL
	 * clients read `MYSQL_PWD` from podman's environment, and MongoDB tools read a 0600 YAML config
	 * written into the container's tmpfs over stdin.
	 */
	private async dumpEngine(id: string, env: DatabaseEnv): Promise<{ path: string; sizeBytes: number; filename: string }> {
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
	 * Owner password rotation for engines other than Postgres (D86). The statements go over stdin,
	 * never argv; a fresh login with the new password must then succeed.
	 *
	 * - MySQL/MariaDB: `ALTER USER` for the owner and for `root@localhost`, which the helper keeps
	 *   on the owner's password so its fixed verbs can use the local socket.
	 * - MongoDB: `changeUserPassword` on the owner, who lives in `admin`.
	 * - Valkey/Redis: `ACL SETUSER … resetpass >new` live; the re-activation that follows a
	 *   successful rotation rewrites the server config, so a restart keeps the new password.
	 */
	private async rotateEngineOwner(id: string, env: DatabaseEnv, newPassword: string): Promise<void> {
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
		// The data dir is under the state root or, for a volume-backed workload, `<mount>/skiff`
		// (D74). Both are fixed shapes with the id as the basename; nothing else is ever removed.
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

	/** Stop both drivers, remove generated units and scrub the runtime secret directory. */
	async remove(id: string): Promise<void> {
		assertId(id, 'workload id');
		const paths = this.unitPaths(id);
		// Best effort: units may not exist or systemd may be unavailable (dev).
		await this.systemctl(['disable', '--now', serviceUnitName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', socketUnitName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', poolerServiceName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', consoleServiceName(id)], { allowFailure: true });

		let changed = false;
		for (const path of [paths.service, paths.socket, paths.container, paths.pooler, paths.console]) {
			changed = (await this.removeIfExists(path)) || changed;
		}
		if (changed) await this.daemonReload();
		await fs.rm(join(this.runtimeDir, id), { recursive: true, force: true });
	}

	/** Actual service state, mapped onto the workload status vocabulary. */
	async status(id: string): Promise<HelperWorkloadStatus> {
		assertId(id, 'workload id');
		const result = await this.systemctl(
			[
				'show',
				serviceUnitName(id),
				'--no-pager',
				'--property=ActiveState',
				'--property=SubState',
				'--property=NRestarts',
				'--property=MemoryCurrent',
				'--property=Result',
			],
			{ allowFailure: true },
		);
		if (result.code !== 0) return { id, status: 'stopped', restarts: 0 };
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
		const tls = id.startsWith('db_') ? await readDatabaseTlsState(this.runtimeDir, id) : null;
		return {
			id,
			status,
			restarts,
			...(memoryBytes !== null ? { memoryBytes } : {}),
			...(tls ? { tls } : {}),
		};
	}

	/**
	 * Read new journal entries for one workload unit. This is the helper's only read verb: a
	 * fixed journalctl argv, a bounded line count and JSON output. The agent drains it into the
	 * control plane so logs survive a node reboot or an agent restart.
	 */
	async logs(id: string, options: LogReadOptions = {}): Promise<HelperLogResult> {
		assertId(id, 'workload id');
		const lines = Math.max(1, Math.min(Math.floor(options.lines ?? 200), 1_000));
		const args = [
			this.journalctlPath,
			'-u',
			serviceUnitName(id),
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
	 * package.json. We use the absolute bun path so the unit does not depend on PATH search.
	 */
	private async defaultCommand(releaseDir: string): Promise<string[]> {
		const manifest = join(releaseDir, 'package.json');
		try {
			const stat = await fs.stat(manifest);
			if (!stat.isFile()) throw new ValidationError(`workload.command is required (${manifest} is not a file)`);
			if (stat.size > 1_048_576)
				throw new ValidationError(`workload.command is required (${manifest} is too large)`);
			return [this.bunPath, 'run', 'start'];
		} catch (error) {
			if (error instanceof ValidationError) throw error;
			throw new ValidationError(
				`workload.command is required: ${releaseDir} has no package.json to derive "bun run start" from`,
			);
		}
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

/** Inside the container's /tmp tmpfs; removed after every MongoDB tool run. */
const MONGO_TOOL_CONFIG = '/tmp/skiff-mongo-tool.yaml';

/** Connection flags shared by `mongodump`/`mongorestore` (the password comes from `--config`). */
function mongoToolArgs(user: string): string[] {
	return ['--host', '127.0.0.1', '--username', user, '--authenticationDatabase', 'admin', `--config=${MONGO_TOOL_CONFIG}`];
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
	}
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
