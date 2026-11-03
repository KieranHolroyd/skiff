import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	containerUnitName,
	renderContainerUnit,
	renderEnvFile,
	renderProcessUnit,
	renderSliceUnit,
	renderSocketUnit,
	serviceUnitName,
	socketUnitName,
	type UnitSecretFile,
} from './units.ts';
import {
	ValidationError,
	assertAbsolutePath,
	assertMemoryMb,
	assertCpuWeight,
	assertId,
	assertRelativePath,
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

export interface SliceOptions {
	memoryMb: number;
	cpuWeight?: number;
}

export interface SystemdDriverOptions {
	runner: CommandRunner;
	/** Where generated units live, normally /etc/systemd/system. */
	unitDir: string;
	/** Root-owned runtime directory for env files and sockets, normally /run/skiff-workloads. */
	runtimeDir: string;
	/** Persistent container data root, normally /var/lib/skiff-workloads. */
	stateDir: string;
	/** Where the agent extracts content-addressed releases, in probe order. */
	releaseDirs: string[];
	/** Absolute bun binary used for the default process command. */
	bunPath: string;
	systemctlPath?: string;
	socketMode?: string;
	socketGroup?: string | null;
}

interface UnitPaths {
	service: string;
	socket: string;
	container: string;
}

export class SystemdDriver {
	private readonly runner: CommandRunner;
	private readonly unitDir: string;
	private readonly runtimeDir: string;
	private readonly stateDir: string;
	private readonly releaseDirs: string[];
	private readonly bunPath: string;
	private readonly systemctlPath: string;
	private readonly socketMode: string;
	private readonly socketGroup: string | null;

	constructor(options: SystemdDriverOptions) {
		this.runner = options.runner;
		this.unitDir = assertAbsolutePath(options.unitDir, 'unitDir');
		this.runtimeDir = assertAbsolutePath(options.runtimeDir, 'runtimeDir');
		this.stateDir = assertAbsolutePath(options.stateDir, 'stateDir');
		if (options.releaseDirs.length === 0)
			throw new ValidationError('releaseDirs must contain at least one directory');
		this.releaseDirs = options.releaseDirs.map((dir) => assertAbsolutePath(dir, 'releaseDir'));
		this.bunPath = assertAbsolutePath(options.bunPath, 'bunPath');
		this.systemctlPath = assertAbsolutePath(options.systemctlPath ?? '/usr/bin/systemctl', 'systemctlPath');
		this.socketMode = validateSocketMode(options.socketMode ?? '0666');
		this.socketGroup = options.socketGroup ?? null;
	}

	unitPaths(id: string): UnitPaths {
		assertId(id, 'workload id');
		return {
			service: join(this.unitDir, serviceUnitName(id)),
			socket: join(this.unitDir, socketUnitName(id)),
			container: join(this.unitDir, containerUnitName(id)),
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
		await this.writeAtomic(envFile, renderEnvFile(env), 0o400);

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
			const dataDir = join(this.stateDir, workload.id);
			await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
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
			if (changed) await this.daemonReload();
			// Switching drivers must stop the process units first; Quadlet generates the service.
			await this.systemctl(['disable', '--now', serviceUnitName(workload.id)], {
				allowFailure: true,
			});
			await this.systemctl(['disable', '--now', socketUnitName(workload.id)], {
				allowFailure: true,
			});
			await this.systemctl(['restart', serviceUnitName(workload.id)]);
		}

		return this.status(workload.id);
	}

	/** Stop both drivers, remove generated units and scrub the runtime secret directory. */
	async remove(id: string): Promise<void> {
		assertId(id, 'workload id');
		const paths = this.unitPaths(id);
		// Best effort: units may not exist or systemd may be unavailable (dev).
		await this.systemctl(['disable', '--now', serviceUnitName(id)], { allowFailure: true });
		await this.systemctl(['disable', '--now', socketUnitName(id)], { allowFailure: true });

		let changed = false;
		for (const path of [paths.service, paths.socket, paths.container]) {
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
