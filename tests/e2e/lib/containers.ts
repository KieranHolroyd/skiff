/**
 * Minimal container-engine driver for the managed-data e2e harness.
 *
 * Prefers rootless Podman, falls back to Docker. It deliberately uses only `run`, `exec`,
 * `inspect`, `logs`, `rm` and `network` so the same code works on a Debian 13 node, a GitHub
 * ubuntu runner and a developer Mac with either engine.
 */
import { connect, createServer } from 'node:net';

export type EngineKind = 'podman' | 'docker';

export interface Engine {
	kind: EngineKind;
	/** `podman --version` / `docker --version`, for the report. */
	version: string;
	/** Binary (or sudo + binary) used for every command. */
	command: string[];
}

export class EngineUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EngineUnavailableError';
	}
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SpawnOptions {
	timeoutMs?: number;
	/** Send these bytes on stdin instead of inheriting the harness's stdin. */
	stdin?: Uint8Array;
	/** Throw on a non-zero exit (default true). */
	check?: boolean;
}

const DEFAULT_TIMEOUT_MS = 180_000;

async function capture(command: string[], options: SpawnOptions = {}): Promise<RunResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const signal = AbortSignal.timeout(timeoutMs);
	const proc = Bun.spawn(command, {
		stdin: options.stdin ? 'pipe' : 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		signal,
	});
	if (options.stdin) {
		const sink = proc.stdin as import('bun').FileSink;
		await sink.write(options.stdin);
		await sink.end();
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	if (signal.aborted)
		throw new Error(`command timed out after ${timeoutMs}ms: ${command.join(' ')}`);
	if (options.check !== false && code !== 0)
		throw new Error(
			`command failed (${code}): ${command.join(' ')}\n${stderr.trim().slice(0, 2_000)}`,
		);
	return { code, stdout, stderr };
}

/** Binary stdout (used for `pg_dump -Fc`). */
async function captureBytes(command: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
	const signal = AbortSignal.timeout(timeoutMs);
	const proc = Bun.spawn(command, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		signal,
	});
	const [body, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).arrayBuffer(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	if (signal.aborted) throw new Error(`command timed out after ${timeoutMs}ms: ${command.join(' ')}`);
	if (code !== 0)
		throw new Error(`command failed (${code}): ${command.join(' ')}\n${stderr.trim().slice(0, 2_000)}`);
	return new Uint8Array(body);
}

async function probe(kind: EngineKind, command: string[]): Promise<Engine | null> {
	try {
		await capture([...command, 'info'], { timeoutMs: 30_000 });
	} catch {
		return null;
	}
	let version = 'unknown';
	try {
		version = (await capture([...command, '--version'], { timeoutMs: 10_000 })).stdout.trim();
	} catch {
		// `info` worked; a missing version string is not fatal.
	}
	return { kind, version, command };
}

/**
 * Resolve an engine.
 *
 * - `YOAL_E2E_ENGINE=none` always skips.
 * - `YOAL_E2E_ENGINE=podman|docker` requires that engine (CI uses this so a missing engine is a
 *   failure, not a silent skip).
 * - Unset tries Podman, then Docker, and returns null when neither is usable.
 */
export async function detectEngine(preferred = process.env.YOAL_E2E_ENGINE): Promise<Engine | null> {
	const normalized = preferred?.trim().toLowerCase();
	if (normalized === 'none') return null;
	if (normalized === 'podman' || normalized === 'docker') {
		const command = normalized === 'podman' && process.env.YOAL_E2E_PODMAN_SUDO === '1'
			? ['sudo', 'podman']
			: [normalized];
		const engine = await probe(normalized, command);
		if (!engine)
			throw new EngineUnavailableError(
				`YOAL_E2E_ENGINE=${normalized} was requested but \`${command.join(' ')} info\` failed.`,
			);
		return engine;
	}

	for (const kind of ['podman', 'docker'] as const) {
		const engine = await probe(kind, [kind]);
		if (engine) return engine;
	}
	return null;
}

/** A loopback port that was free a moment ago. Containers bind it immediately. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen({ host: '127.0.0.1', port: 0 }, () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('could not allocate a loopback port'));
				return;
			}
			const { port } = address;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

export interface ContainerSpec {
	name: string;
	image: string;
	network: string;
	/** `[hostPort, containerPort]` pairs, always published on 127.0.0.1. */
	ports: Array<[number, number]>;
	env?: Record<string, string>;
	command?: string[];
	labels?: Record<string, string>;
	/** `[hostPath, containerPath]` bind mounts, read-only. */
	volumes?: Array<[string, string]>;
}

export class ContainerRuntime {
	readonly runId: string;
	private readonly containers: string[] = [];
	private readonly networks: string[] = [];

	constructor(
		readonly engine: Engine,
		readonly tempDir: string,
	) {
		this.runId = `${process.pid}-${Date.now().toString(36)}`;
	}

	private args(args: string[]): string[] {
		return [...this.engine.command, ...args];
	}

	async exec(argv: string[], options: SpawnOptions = {}): Promise<RunResult> {
		return capture(this.args(argv), options);
	}

	async execBytes(argv: string[]): Promise<Uint8Array> {
		return captureBytes(this.args(argv));
	}

	async createNetwork(name: string): Promise<void> {
		await this.exec(['network', 'create', name]);
		this.networks.push(name);
	}

	async runContainer(spec: ContainerSpec): Promise<string> {
		const args = [
			'run',
			'-d',
			'--name',
			spec.name,
			'--network',
			spec.network,
			'--label',
			`yoal.e2e.run=${this.runId}`,
			'--label',
			'yoal.e2e=true',
		];
		for (const [key, value] of Object.entries(spec.env ?? {})) args.push('-e', `${key}=${value}`);
		for (const [hostPort, containerPort] of spec.ports)
			args.push('-p', `127.0.0.1:${hostPort}:${containerPort}`);
		for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${key}=${value}`);
		for (const [hostPath, containerPath] of spec.volumes ?? []) args.push('-v', `${hostPath}:${containerPath}:ro`);
		args.push(spec.image, ...(spec.command ?? []));
		await this.exec(args);
		this.containers.push(spec.name);
		return spec.name;
	}

	async inspect(name: string, format: string): Promise<string> {
		return (await this.exec(['inspect', '--format', format, name])).stdout.trim();
	}

	async isRunning(name: string): Promise<boolean> {
		try {
			return (await this.inspect(name, '{{.State.Running}}')) === 'true';
		} catch {
			return false;
		}
	}

	async logs(name: string, tail = 60): Promise<string> {
		try {
			const result = await this.exec(['logs', '--tail', String(tail), name], { check: false });
			return `${result.stdout}${result.stderr}`;
		} catch {
			return '';
		}
	}

	get containerNames(): readonly string[] {
		return [...this.containers];
	}

	/** Best-effort teardown. Never throws: cleanup runs on the failure path too. */
	async cleanup(): Promise<void> {
		for (const name of [...this.containers].reverse()) {
			// `-v`: engine images declare VOLUMEs, whose anonymous volumes otherwise leak per run.
			await this.exec(['rm', '-fv', name], { check: false, timeoutMs: 60_000 }).catch(() => undefined);
		}
		for (const network of [...this.networks].reverse()) {
			await this.exec(['network', 'rm', network], { check: false, timeoutMs: 60_000 }).catch(() => undefined);
		}
		this.containers.length = 0;
		this.networks.length = 0;
	}
}

/** Poll `probe` until it resolves truthy or the deadline passes. */
export async function waitFor(
	label: string,
	probe: () => Promise<boolean> | boolean,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const intervalMs = options.intervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await probe()) return;
			lastError = undefined;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(intervalMs);
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
	throw new Error(`${label} did not become ready within ${timeoutMs}ms${detail}`);
}

/**
 * The agent's database health probe (docs/DATABASES.md §2): open the loopback TCP port and send
 * the 8-byte Postgres SSLRequest. Podman's port forwarder accepts connections before the server
 * is ready, so a bare connect is not enough; a real Postgres answers `S` or `N`.
 */
export async function postgresHealthProbe(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const request = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
		const finish = (result: boolean) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(3_000);
		socket.once('connect', () => socket.write(request));
		socket.once('data', (data) => finish(data[0] === 0x53 || data[0] === 0x4e));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}
