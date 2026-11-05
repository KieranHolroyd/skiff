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
	containerUnitName,
	networkUnitName,
	poolerServiceName,
	poolerUnitName,
	renderContainerEnvFile,
	renderContainerUnit,
	renderEnvFile,
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
	assertRelativePath,
	databaseAlias,
	workloadNetworkName,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from './validate.ts';

/**
 * systemd is the primary runtime driver. This module owns *all* privileges: it writes unit files,
 * env/secret files and calls systemctl. Every child process goes through an injected
 * `CommandRunner` with an argv array — never a shell string — so the whole module is unit-testable
 * without root or systemd.
 */

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
	/** Where the agent extracts content-addressed releases, in probe order. */
	releaseDirs: string[];
	/** Absolute bun binary used for the default process command. */
	bunPath: string;
	systemctlPath?: string;
	journalctlPath?: string;
	/** Absolute podman binary used by the fixed database dump/restore verbs. */
	podmanPath?: string;
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
}

export class SystemdDriver {
	private readonly runner: CommandRunner;
	private readonly unitDir: string;
	private readonly quadletDir: string;
	private readonly runtimeDir: string;
	private readonly stateDir: string;
	private readonly volumeRegistryFile: string;
	private readonly releaseDirs: string[];
	private readonly bunPath: string;
	private readonly systemctlPath: string;
	private readonly journalctlPath: string;
	private readonly podmanPath: string;
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

	/**
	 * Where one container's data lives (D74). A volume-backed workload is resolved through the
	 * root applier's registry and verified *before* anything is written: if the mount is gone the
	 * start fails, because the alternative is silently filling the root disk (D76). The helper
	 * never accepts a path from the wire.
	 */
	async resolveDataDir(workload: WorkloadDesired): Promise<string> {
		if (!workload.volumeId) return join(this.stateDir, workload.id);
		const registry = await readVolumeRegistry(this.volumeRegistryFile);
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

		await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o755 });
		// The runtime dir holds secret files: owner-only.
		const workloadRuntimeDir = join(this.runtimeDir, workload.id);
		await fs.mkdir(workloadRuntimeDir, { recursive: true, mode: 0o700 });
		await fs.chmod(workloadRuntimeDir, 0o700).catch(() => undefined);

		const envFile = join(workloadRuntimeDir, 'env');
		const env = { ...workload.env, ...activation.env };
		// The database profile pins its cluster inside the /data mount; never the image's VOLUME.
		if (workload.database) env.PGDATA = DATABASE_PGDATA;
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
			const container = renderContainerUnit({
				workload,
				image,
				envFile,
				dataDir,
				secretsDir: Object.keys(activation.files).length > 0 ? secretsDir : null,
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
				});
				const userlist = renderPoolerUserlist(user, password);
				changed = (await this.writeIfChanged(configPath, config, 0o600)) || changed;
				changed = (await this.writeIfChanged(userlistPath, userlist, 0o600)) || changed;
				await this.chown(configPath, 70, 70).catch(() => undefined);
				await this.chown(userlistPath, 70, 70).catch(() => undefined);
				changed =
					(await this.writeIfChanged(
						paths.pooler,
						renderPoolerUnit({ workload, configPath, userlistPath }),
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
				owner
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
	 * Fixed `ALTER ROLE` verb for credential rotation (docs/DATABASES.md §4). The SQL goes over
	 * stdin, never argv, and the new password is verified with a fresh connection.
	 */
	async rotateDatabaseRole(id: string, role: 'owner' | 'monitor', newPassword: string): Promise<void> {
		assertDatabaseId(id, 'database id');
		if (role !== 'owner' && role !== 'monitor') throw new ValidationError('role must be owner or monitor');
		if (!/^[A-Za-z0-9_-]{16,200}$/.test(newPassword))
			throw new ValidationError('The rotated password must be base64url (16–200 characters)');
		const env = await this.readDatabaseEnv(id);
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
		const env = await this.readDatabaseEnv(id);
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

	private async readDatabaseEnv(id: string): Promise<{ user: string; password: string; database: string }> {
		const text = await fs.readFile(join(this.runtimeDir, id, 'env'), 'utf8').catch(() => null);
		if (text === null) throw new ValidationError(`Database ${id} has no runtime env file; start it first.`);
		const values = new Map<string, string>();
		for (const line of text.split('\n')) {
			const eq = line.indexOf('=');
			if (eq <= 0) continue;
			values.set(line.slice(0, eq), line.slice(eq + 1));
		}
		const user = values.get('POSTGRES_USER') ?? '';
		const password = values.get('POSTGRES_PASSWORD') ?? '';
		const database = values.get('POSTGRES_DB') ?? '';
		if (!identifier(user) || !identifier(database) || !password)
			throw new ValidationError(`Database ${id} is missing valid Postgres credentials in its env file.`);
		return { user, password, database };
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
		const registry = await readVolumeRegistry(this.volumeRegistryFile);
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

		let changed = false;
		for (const path of [paths.service, paths.socket, paths.container, paths.pooler]) {
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
		return { id, status, restarts, ...(memoryBytes !== null ? { memoryBytes } : {}) };
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
		if (cursor) args.splice(2, 0, '--after-cursor', cursor);
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
