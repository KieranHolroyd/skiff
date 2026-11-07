import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ContainerFilesystem, SECRETS_DESTINATION, type ContainerMountView, type FdView, procFdView } from './container-files.ts';
import { containerUnitName, serviceUnitName } from './units.ts';
import type { CommandRunner } from './systemd.ts';
import { ValidationError } from './validate.ts';

/**
 * Container console verbs (D127): inspect, read-only files and interactive shells for a
 * project's own container workload. These are the only helper verbs that run a program the
 * request picks, and the choice is bounded: one of four shells, inside the tenant's own container,
 * which keeps every restriction its unit gives it (no capabilities, no new privileges, read-only
 * root). Nothing runs on the host but `podman` and `systemctl` with fixed argv.
 *
 * Only `wld_…` ids with a rendered `.container` unit qualify: managed databases, storage and
 * brokers (`db_`, `st_`, `mq_`) hold platform credentials and are never opened here.
 */

export const CONSOLE_WORKLOAD_ID = /^wld_[A-Za-z0-9]{1,64}(?:-r\d{1,3})?$/;
export const EXEC_ID = /^cx_[A-Za-z0-9]{24}$/;
export const CONSOLE_SHELLS = ['auto', '/bin/bash', '/bin/sh', '/bin/ash'] as const;
export type ConsoleShell = (typeof CONSOLE_SHELLS)[number];

export interface ContainerConsoleLimits {
	execPerContainer: number;
	execPerNode: number;
	execIdleMs: number;
	execMaxMs: number;
	execReplayBytes: number;
	execInputBytes: number;
	listEntries: number;
	previewBytes: number;
}

export const DEFAULT_CONSOLE_LIMITS: ContainerConsoleLimits = {
	execPerContainer: 4,
	execPerNode: 32,
	execIdleMs: 15 * 60_000,
	execMaxMs: 8 * 60 * 60_000,
	execReplayBytes: 256 * 1024,
	execInputBytes: 64 * 1024,
	listEntries: 2_000,
	previewBytes: 1024 * 1024,
};

export interface ExecOpenRequest {
	shell: ConsoleShell;
	user: 'default' | 'root';
	cols: number;
	rows: number;
}

/** The PTY-backed process a shell runs in; `Bun.spawn` with `terminal` in production. */
export interface PtyProcess {
	write(data: Uint8Array): void;
	resize(cols: number, rows: number): void;
	kill(signal?: NodeJS.Signals): void;
	readonly exited: Promise<number>;
}

export type SpawnPty = (
	argv: string[],
	options: { cols: number; rows: number; env: Record<string, string>; onData: (data: Uint8Array) => void },
) => PtyProcess;

export const bunSpawnPty: SpawnPty = (argv, options) => {
	const child = Bun.spawn(argv, {
		env: options.env,
		terminal: {
			cols: options.cols,
			rows: options.rows,
			name: 'xterm-256color',
			data: (_terminal, data) => options.onData(data),
		},
	});
	const terminal = child.terminal!;
	return {
		write: (data) => {
			if (!terminal.closed) terminal.write(data);
		},
		resize: (cols, rows) => {
			if (!terminal.closed) terminal.resize(cols, rows);
		},
		kill: (signal) => {
			try {
				child.kill(signal);
			} catch {
				// Already gone.
			}
			if (!terminal.closed) terminal.close();
		},
		exited: child.exited,
	};
};

export interface ContainerConsoleOptions {
	podmanPath: string;
	systemctlPath: string;
	quadletDir: string;
	runner: CommandRunner;
	spawnPty?: SpawnPty;
	limits?: Partial<ContainerConsoleLimits>;
	fdView?: FdView;
	/** Root of `/proc` and `/sys/fs/cgroup`; injectable for tests. */
	procRoot?: string;
	cgroupRoot?: string;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class ConsoleError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409 | 429 = 409,
	) {
		super(message);
	}
}

/** One shell: a PTY around `podman exec -it`, with output kept for a reconnecting viewer. */
class ExecSession {
	readonly chunks: Array<{ start: number; bytes: Uint8Array }> = [];
	/** Bytes ever produced; the SSE event id, so `Last-Event-ID` resumes exactly. */
	total = 0;
	kept = 0;
	exitCode: number | null = null;
	exited = false;
	lastActivity: number;
	readonly listeners = new Set<(event: { kind: 'data'; start: number; bytes: Uint8Array } | { kind: 'exit'; code: number }) => void>();
	pty!: PtyProcess;

	constructor(
		readonly id: string,
		readonly workloadId: string,
		readonly shell: string,
		readonly user: string,
		readonly startedAt: number,
		private readonly replayBytes: number,
	) {
		this.lastActivity = startedAt;
	}

	push(bytes: Uint8Array): void {
		const copy = new Uint8Array(bytes);
		const start = this.total;
		this.total += copy.length;
		this.chunks.push({ start, bytes: copy });
		this.kept += copy.length;
		while (this.kept > this.replayBytes && this.chunks.length > 1) this.kept -= this.chunks.shift()!.bytes.length;
		for (const listener of this.listeners) listener({ kind: 'data', start, bytes: copy });
	}

	finish(code: number): void {
		if (this.exited) return;
		this.exited = true;
		this.exitCode = code;
		for (const listener of this.listeners) listener({ kind: 'exit', code });
	}

	/** Output after byte offset `after` that is still kept. */
	replay(after: number): Array<{ start: number; bytes: Uint8Array }> {
		const out: Array<{ start: number; bytes: Uint8Array }> = [];
		for (const chunk of this.chunks) {
			const end = chunk.start + chunk.bytes.length;
			if (end <= after) continue;
			if (chunk.start >= after) out.push(chunk);
			else out.push({ start: after, bytes: chunk.bytes.subarray(after - chunk.start) });
		}
		return out;
	}
}

export class ContainerConsole {
	private readonly limits: ContainerConsoleLimits;
	private readonly spawnPty: SpawnPty;
	private readonly fdView: FdView;
	private readonly procRoot: string;
	private readonly cgroupRoot: string;
	private readonly now: () => number;
	private readonly log: NonNullable<ContainerConsoleOptions['log']>;
	private readonly sessions = new Map<string, ExecSession>();
	private sweeper: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: ContainerConsoleOptions) {
		this.limits = { ...DEFAULT_CONSOLE_LIMITS, ...options.limits };
		this.spawnPty = options.spawnPty ?? bunSpawnPty;
		this.fdView = options.fdView ?? procFdView;
		this.procRoot = options.procRoot ?? '/proc';
		this.cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
	}

	/** Refuse anything but a project container this helper rendered. */
	assertWorkload(raw: string): string {
		let id: string;
		try {
			id = decodeURIComponent(raw);
		} catch {
			throw new ValidationError('workload id is not valid URL encoding');
		}
		if (!CONSOLE_WORKLOAD_ID.test(id)) throw new ValidationError('the console only opens project containers (wld_…)');
		if (!existsSync(`${this.options.quadletDir}/${containerUnitName(id)}`))
			throw new ConsoleError('This workload is not a container on this node.', 404);
		return id;
	}

	// --- inspect ---------------------------------------------------------------------------

	async inspect(id: string): Promise<Record<string, unknown>> {
		const [raw, unit] = await Promise.all([this.podmanInspect(id), this.unitState(id)]);
		const name = containerName(id);
		if (!raw) {
			return {
				id,
				name,
				exists: false,
				state: {
					status: unit.activeState === 'activating' ? 'starting' : 'not running',
					running: false,
					paused: false,
					restarting: false,
					oomKilled: false,
					exitCode: null,
					error: null,
					startedAt: null,
					finishedAt: null,
					health: null,
				},
				unit: { activeState: unit.activeState, subState: unit.subState, restarts: unit.restarts },
				image: { name: null, id: null, digest: null },
				config: { entrypoint: [], command: [], workingDir: null, user: null, hostname: null, envNames: [], labels: {} },
				security: { readOnlyRootfs: true, capAdd: [], capDrop: [], noNewPrivileges: true },
				network: { ports: [], networks: [] },
				mounts: [],
				stats: null,
				processes: [],
			};
		}
		const state = record(raw.State);
		const config = record(raw.Config);
		const host = record(raw.HostConfig);
		const pid = number(state.Pid);
		const cgroup = this.cgroupDir(string(state.CgroupPath), unit.controlGroup);
		const mounts = mountViews(raw).map((mount) => ({
			destination: mount.destination,
			type: mount.type,
			readOnly: mount.readOnly,
			browsable: mount.source !== null,
			note: mount.note,
		}));
		return {
			id,
			name,
			exists: true,
			state: {
				status: string(state.Status) ?? 'unknown',
				running: state.Running === true,
				paused: state.Paused === true,
				restarting: state.Restarting === true,
				oomKilled: state.OOMKilled === true,
				exitCode: number(state.ExitCode),
				error: string(state.Error) || null,
				startedAt: timestamp(state.StartedAt),
				finishedAt: timestamp(state.FinishedAt),
				health: string(record(state.Health).Status) ?? string(state.Healthcheck) ?? null,
			},
			unit: { activeState: unit.activeState, subState: unit.subState, restarts: unit.restarts },
			image: {
				name: string(raw.ImageName) ?? string(config.Image) ?? null,
				id: string(raw.Image)?.slice(0, 64) ?? null,
				digest: string(raw.ImageDigest) ?? null,
			},
			config: {
				entrypoint: argv(config.Entrypoint),
				command: argv(config.Cmd),
				workingDir: string(config.WorkingDir) || null,
				user: string(config.User) || null,
				hostname: string(config.Hostname) || null,
				// Values carry the activation's secrets: only names leave the helper.
				envNames: (Array.isArray(config.Env) ? config.Env : [])
					.filter((item): item is string => typeof item === 'string')
					.map((item) => item.split('=', 1)[0]!)
					.filter(Boolean)
					.sort(),
				labels: stringRecord(config.Labels),
			},
			security: {
				readOnlyRootfs: host.ReadonlyRootfs === true,
				capAdd: stringArray(host.CapAdd),
				capDrop: stringArray(host.CapDrop),
				noNewPrivileges: stringArray(host.SecurityOpt).some((opt) => opt.includes('no-new-privileges')),
			},
			network: networkView(raw),
			mounts,
			stats: state.Running === true ? this.stats(cgroup, pid) : null,
			processes: state.Running === true && cgroup ? this.processes(cgroup) : [],
		};
	}

	// --- files -----------------------------------------------------------------------------

	/** The container's filesystem view, or a 409 when it is not running. */
	async filesystem(id: string): Promise<ContainerFilesystem> {
		const raw = await this.podmanInspect(id);
		if (!raw || record(raw.State).Running !== true)
			throw new ConsoleError('The container is not running, so its filesystem cannot be shown.', 409);
		return new ContainerFilesystem(mountViews(raw), this.fdView);
	}

	get fileLimits(): { listEntries: number; previewBytes: number } {
		return { listEntries: this.limits.listEntries, previewBytes: this.limits.previewBytes };
	}

	// --- exec ------------------------------------------------------------------------------

	async execOpen(id: string, request: ExecOpenRequest): Promise<{ execId: string; shell: string; user: string; startedAt: string }> {
		this.sweep();
		const open = [...this.sessions.values()].filter((session) => !session.exited);
		if (open.length >= this.limits.execPerNode) throw new ConsoleError('This node has too many open shells.', 429);
		if (open.filter((session) => session.workloadId === id).length >= this.limits.execPerContainer)
			throw new ConsoleError(`A container can have at most ${this.limits.execPerContainer} shells open. Close one first.`, 429);
		const raw = await this.podmanInspect(id);
		if (!raw || record(raw.State).Running !== true) throw new ConsoleError('The container is not running.', 409);

		const execId = newExecId();
		const argvList = [
			this.options.podmanPath,
			'exec',
			'--interactive',
			'--tty',
			// Ctrl-P Ctrl-Q would otherwise detach instead of reaching the shell.
			'--detach-keys=',
			'--env',
			'TERM=xterm-256color',
			// Lets `close` find every process this shell started, however it was orphaned.
			'--env',
			`SKIFF_EXEC_ID=${execId}`,
			...(request.user === 'root' ? ['--user', '0:0'] : []),
			containerName(id),
			...shellArgv(request.shell),
		];
		const session = new ExecSession(execId, id, request.shell, request.user, this.now(), this.limits.execReplayBytes);
		session.pty = this.spawnPty(argvList, {
			cols: request.cols,
			rows: request.rows,
			env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color' },
			onData: (data) => session.push(data),
		});
		this.sessions.set(execId, session);
		void session.pty.exited.then(
			(code) => {
				session.finish(code);
				this.reap(session);
			},
			() => session.finish(-1),
		);
		this.ensureSweeper();
		this.log('info', `Shell ${execId} opened in ${containerName(id)} (${request.shell}, ${request.user})`);
		return { execId, shell: request.shell, user: request.user, startedAt: new Date(session.startedAt).toISOString() };
	}

	/**
	 * Server-sent events: `data` events carry base64 output with the byte offset as their id;
	 * one `exit` event ends the stream. `after` replays what is still kept past that offset.
	 */
	execStream(id: string, execId: string, after: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
		const session = this.session(id, execId);
		const encoder = new TextEncoder();
		let cleanup = () => undefined as void;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				const send = (text: string) => {
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						cleanup();
					}
				};
				const data = (start: number, bytes: Uint8Array) =>
					send(`id: ${start + bytes.length}\nevent: data\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`);
				const exit = (code: number) => {
					send(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`);
					cleanup();
					try {
						controller.close();
					} catch {
						// Already closed.
					}
				};
				send(`retry: 2000\n: ${execId}\n\n`);
				for (const chunk of session.replay(after)) data(chunk.start, chunk.bytes);
				if (session.exited) {
					exit(session.exitCode ?? -1);
					return;
				}
				const listener = (event: { kind: 'data'; start: number; bytes: Uint8Array } | { kind: 'exit'; code: number }) => {
					if (event.kind === 'data') data(event.start, event.bytes);
					else exit(event.code);
				};
				const ping = setInterval(() => send(': ping\n\n'), 15_000);
				session.listeners.add(listener);
				session.lastActivity = this.now();
				cleanup = () => {
					clearInterval(ping);
					session.listeners.delete(listener);
					session.lastActivity = this.now();
				};
				signal?.addEventListener('abort', () => cleanup(), { once: true });
			},
			cancel: () => cleanup(),
		});
	}

	execInput(id: string, execId: string, bytes: Uint8Array): void {
		if (bytes.length > this.limits.execInputBytes) throw new ValidationError('input is too large');
		const session = this.session(id, execId);
		if (session.exited) throw new ConsoleError('The shell has exited.', 409);
		session.lastActivity = this.now();
		session.pty.write(bytes);
	}

	execResize(id: string, execId: string, cols: number, rows: number): void {
		const session = this.session(id, execId);
		if (!session.exited) session.pty.resize(cols, rows);
	}

	async execClose(id: string, execId: string): Promise<void> {
		const session = this.session(id, execId);
		await this.terminate(session, 'closed');
	}

	/** Open shells, for `/healthz`-style diagnostics and tests. */
	get openShells(): number {
		return [...this.sessions.values()].filter((session) => !session.exited).length;
	}

	/** Close every shell (helper shutdown). */
	async closeAll(): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		this.sweeper = null;
		await Promise.all([...this.sessions.values()].map((session) => this.terminate(session, 'shutdown')));
	}

	/** Idle and over-age shells are closed; exited ones are forgotten once nobody watches. */
	sweep(): void {
		const now = this.now();
		for (const session of this.sessions.values()) {
			if (session.exited) {
				if (session.listeners.size === 0 && now - session.lastActivity > 60_000) this.sessions.delete(session.id);
				continue;
			}
			if (now - session.startedAt > this.limits.execMaxMs) void this.terminate(session, 'max-age');
			else if (session.listeners.size === 0 && now - session.lastActivity > this.limits.execIdleMs)
				void this.terminate(session, 'idle');
		}
	}

	// --- internals -------------------------------------------------------------------------

	private session(id: string, execId: string): ExecSession {
		if (!EXEC_ID.test(execId)) throw new ValidationError('exec id is malformed');
		const session = this.sessions.get(execId);
		if (!session || session.workloadId !== id) throw new ConsoleError('No such shell session.', 404);
		return session;
	}

	private ensureSweeper(): void {
		if (this.sweeper) return;
		this.sweeper = setInterval(() => this.sweep(), 30_000);
		(this.sweeper as { unref?: () => void }).unref?.();
	}

	private reap(session: ExecSession): void {
		// The `podman exec` client is gone; make sure nothing it started lingers in the container.
		this.killTagged(session.id, 'SIGKILL');
		session.lastActivity = this.now();
	}

	private async terminate(session: ExecSession, reason: string): Promise<void> {
		if (!session.exited) {
			this.log('info', `Shell ${session.id} closing (${reason})`);
			// Hang up the shell inside the container first, then the client; a process the
			// shell started (even one that ignored the hangup) is found by its tag.
			this.killTagged(session.id, 'SIGHUP');
			session.pty.kill('SIGHUP');
			const done = await Promise.race([session.pty.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
			if (!done) session.pty.kill('SIGKILL');
			this.killTagged(session.id, 'SIGKILL');
			session.finish(done ? (session.exitCode ?? 0) : -1);
		}
		this.sessions.delete(session.id);
	}

	/** Signal every process on the host whose environment carries this shell's tag. */
	private killTagged(execId: string, signal: NodeJS.Signals): number {
		const needle = Buffer.from(`SKIFF_EXEC_ID=${execId}\0`);
		let killed = 0;
		let pids: string[];
		try {
			pids = readdirSync(this.procRoot).filter((name) => /^\d+$/.test(name));
		} catch {
			return 0;
		}
		for (const pid of pids) {
			try {
				const environ = readFileSync(`${this.procRoot}/${pid}/environ`);
				if (environ.indexOf(needle) === -1) continue;
				process.kill(Number(pid), signal);
				killed += 1;
			} catch {
				// Gone, or not ours to read.
			}
		}
		return killed;
	}

	private async podmanInspect(id: string): Promise<Record<string, unknown> | null> {
		const result = await this.options.runner.run([
			this.options.podmanPath,
			'container',
			'inspect',
			'--format',
			'json',
			containerName(id),
		]);
		if (result.code !== 0) return null;
		try {
			const parsed = JSON.parse(result.stdout) as unknown;
			const first = Array.isArray(parsed) ? parsed[0] : null;
			return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	private async unitState(id: string): Promise<{ activeState: string; subState: string; restarts: number; controlGroup: string | null }> {
		const result = await this.options.runner.run([
			this.options.systemctlPath,
			'show',
			serviceUnitName(id),
			'--property=ActiveState,SubState,NRestarts,ControlGroup',
		]);
		const values: Record<string, string> = {};
		for (const line of result.stdout.split('\n')) {
			const index = line.indexOf('=');
			if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
		}
		return {
			activeState: values.ActiveState || 'unknown',
			subState: values.SubState || 'unknown',
			restarts: Number(values.NRestarts) || 0,
			controlGroup: values.ControlGroup || null,
		};
	}

	/** The container's own cgroup (Podman's `CgroupPath`), else the service's, if it exists. */
	private cgroupDir(cgroupPath: string | null, controlGroup: string | null): string | null {
		for (const candidate of [cgroupPath, controlGroup]) {
			if (!candidate || !candidate.startsWith('/') || candidate.includes('..')) continue;
			const dir = `${this.cgroupRoot}${candidate}`;
			if (existsSync(`${dir}/cgroup.procs`)) return dir;
		}
		return null;
	}

	private stats(cgroup: string | null, pid: number | null): Record<string, unknown> {
		const read = (file: string) => (cgroup ? readText(`${cgroup}/${file}`) : null);
		const flat = (file: string) => keyed(read(file));
		const cpu = flat('cpu.stat');
		const events = flat('memory.events');
		const io = (read('io.stat') ?? '').split('\n').reduce(
			(sum, line) => {
				for (const field of line.split(' ').slice(1)) {
					const [key, value] = field.split('=');
					if (key === 'rbytes') sum.read += Number(value) || 0;
					if (key === 'wbytes') sum.write += Number(value) || 0;
				}
				return sum;
			},
			{ read: 0, write: 0 },
		);
		const net = pid ? netCounters(readText(`${this.procRoot}/${pid}/net/dev`)) : null;
		return {
			sampledAt: new Date(this.now()).toISOString(),
			cpuMicros: cpu.usage_usec ?? null,
			memoryBytes: numeric(read('memory.current')),
			memoryPeakBytes: numeric(read('memory.peak')),
			memoryLimitBytes: numeric(read('memory.max')),
			oomKills: events.oom_kill ?? null,
			pids: numeric(read('pids.current')),
			pidsLimit: numeric(read('pids.max')),
			netRxBytes: net?.rx ?? null,
			netTxBytes: net?.tx ?? null,
			blockReadBytes: cgroup && read('io.stat') !== null ? io.read : null,
			blockWriteBytes: cgroup && read('io.stat') !== null ? io.write : null,
		};
	}

	/** Processes in the container's cgroup tree, read from `/proc` (conmon left out). */
	private processes(cgroup: string): Array<Record<string, unknown>> {
		const pids = new Set<number>();
		const walk = (dir: string, depth: number) => {
			for (const line of (readText(`${dir}/cgroup.procs`) ?? '').split('\n')) {
				const pid = Number(line.trim());
				if (pid > 0) pids.add(pid);
			}
			if (depth >= 4) return;
			let children: string[] = [];
			try {
				children = readdirSync(dir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				return;
			}
			for (const child of children) walk(`${dir}/${child}`, depth + 1);
		};
		walk(cgroup, 0);
		const bootSeconds = keyed(readText(`${this.procRoot}/stat`), ' ').btime ?? null;
		const hz = 100;
		const rows: Array<{ hostPid: number; nsPid: number; hostPpid: number; row: Record<string, unknown> }> = [];
		for (const hostPid of [...pids].sort((a, b) => a - b).slice(0, 300)) {
			const stat = readText(`${this.procRoot}/${hostPid}/stat`);
			const status = keyedText(readText(`${this.procRoot}/${hostPid}/status`), ':');
			if (!stat) continue;
			// `comm` may contain spaces and parentheses: split after the last `)`.
			const close = stat.lastIndexOf(')');
			const comm = stat.slice(stat.indexOf('(') + 1, close);
			if (comm === 'conmon') continue;
			const fields = stat.slice(close + 2).split(' ');
			const ticks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0);
			const startTicks = Number(fields[19]) || 0;
			const nsPids = (status.NSpid ?? String(hostPid)).split(/\s+/).map(Number);
			const cmdline = readBuffer(`${this.procRoot}/${hostPid}/cmdline`);
			const command = cmdline && cmdline.length > 0
				? cmdline.toString('utf8').replace(/\0+$/, '').split('\0').join(' ').slice(0, 500)
				: `[${comm}]`;
			rows.push({
				hostPid,
				nsPid: nsPids[nsPids.length - 1] || hostPid,
				hostPpid: Number(fields[1]) || 0,
				row: {
					uid: Number((status.Uid ?? '0').split(/\s+/)[0]) || 0,
					state: fields[0] ?? '?',
					rssBytes: (Number((status.VmRSS ?? '0').split(/\s+/)[0]) || 0) * 1024,
					cpuMicros: Math.round((ticks / hz) * 1_000_000),
					startedAt: bootSeconds !== null ? new Date((bootSeconds + startTicks / hz) * 1000).toISOString() : null,
					command,
				},
			});
		}
		const nsOf = new Map(rows.map((row) => [row.hostPid, row.nsPid]));
		return rows.map(({ nsPid, hostPpid, row }) => ({ pid: nsPid, ppid: nsOf.get(hostPpid) ?? 0, ...row }));
	}
}

export function containerName(id: string): string {
	return `skiff-workload-${id}`;
}

function newExecId(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = 'cx_';
	for (const byte of randomBytes(24)) out += alphabet[byte % alphabet.length];
	return out;
}

/** The fixed argv for each shell choice; `auto` prefers bash and falls back to sh. */
export function shellArgv(shell: ConsoleShell): string[] {
	if (shell === 'auto')
		return ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
	return [shell];
}

/** What the file browser can reach: the merged root plus bind mounts, minus secrets and tmpfs. */
export function mountViews(raw: Record<string, unknown>): ContainerMountView[] {
	const host = record(raw.HostConfig);
	const merged = string(record(record(raw.GraphDriver).Data).MergedDir) ?? string(raw.Mountpoint) ?? null;
	const views: ContainerMountView[] = [
		{ destination: '/', source: merged, type: 'rootfs', readOnly: host.ReadonlyRootfs === true, note: merged ? null : 'unavailable' },
	];
	for (const item of Array.isArray(raw.Mounts) ? raw.Mounts : []) {
		const mount = record(item);
		const destination = string(mount.Destination);
		if (!destination || !destination.startsWith('/') || destination === '/') continue;
		const type = string(mount.Type) ?? 'bind';
		const readOnly = mount.RW === false;
		const secrets = destination === SECRETS_DESTINATION || destination.startsWith(`${SECRETS_DESTINATION}/`);
		const source = type === 'bind' || type === 'volume' ? string(mount.Source) : null;
		views.push({
			destination,
			source: secrets ? null : source,
			type,
			readOnly,
			note: secrets ? 'secrets' : source ? null : type,
		});
	}
	// Tmpfs mounts (`Tmpfs=/tmp`) live in the container's mount namespace only.
	for (const destination of Object.keys(record(host.Tmpfs))) {
		if (!views.some((view) => view.destination === destination))
			views.push({ destination, source: null, type: 'tmpfs', readOnly: false, note: 'tmpfs' });
	}
	return views;
}

function networkView(raw: Record<string, unknown>): { ports: Array<{ container: string; host: string }>; networks: Array<{ name: string; ip: string | null; aliases: string[] }> } {
	const settings = record(raw.NetworkSettings);
	const ports: Array<{ container: string; host: string }> = [];
	for (const [container, bindings] of Object.entries(record(settings.Ports))) {
		for (const binding of Array.isArray(bindings) ? bindings : []) {
			const item = record(binding);
			ports.push({ container, host: `${string(item.HostIp) || '0.0.0.0'}:${string(item.HostPort) ?? ''}` });
		}
	}
	const networks = Object.entries(record(settings.Networks)).map(([name, value]) => {
		const network = record(value);
		return { name, ip: string(network.IPAddress) || null, aliases: stringArray(network.Aliases) };
	});
	return { ports, networks };
}

function netCounters(text: string | null): { rx: number; tx: number } | null {
	if (!text) return null;
	let rx = 0;
	let tx = 0;
	for (const line of text.split('\n').slice(2)) {
		const [name, rest] = line.split(':');
		if (!rest || name!.trim() === 'lo') continue;
		const fields = rest.trim().split(/\s+/).map(Number);
		rx += fields[0] || 0;
		tx += fields[8] || 0;
	}
	return { rx, tx };
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

function readBuffer(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

function numeric(text: string | null): number | null {
	if (text === null) return null;
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : null; // `max` (no limit) is null.
}

function keyed(text: string | null, separator = ' '): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(keyedText(text, separator))) out[key] = Number(value);
	return out;
}

function keyedText(text: string | null, separator = ' '): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of (text ?? '').split('\n')) {
		const index = line.indexOf(separator);
		if (index <= 0) continue;
		out[line.slice(0, index).trim()] = line.slice(index + separator.length).trim();
	}
	return out;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(record(value))) if (typeof item === 'string') out[key] = item;
	return out;
}

function argv(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	return stringArray(value);
}

/** Podman's zero time is year 1; show it as unknown. */
function timestamp(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) || ms <= 0 ? null : new Date(ms).toISOString();
}
