/**
 * Container console (D127) for the CLI: inspect, files and an interactive shell for a container
 * project. The wire types mirror `packages/contracts/src/container-console.ts`; the CLI bundle
 * stays free of runtime dependencies (D40), so keep them in sync. The server validates every input.
 */
import type { ApiClient } from './api.ts';
import { CliError } from './errors.ts';
import { formatBytes, formatTime, renderTable, truncate } from './output.ts';
import { SseParser } from './sse.ts';

/** Mirrors `containerShells`. */
export const CONTAINER_SHELLS = ['auto', '/bin/bash', '/bin/sh', '/bin/ash'] as const;
export type ContainerShell = (typeof CONTAINER_SHELLS)[number];

export interface ContainerTarget {
	replica: number | null;
	nodeId: string;
	nodeName: string;
	desiredId: string;
}

export interface ContainerStats {
	sampledAt: string;
	cpuMicros: number | null;
	memoryBytes: number | null;
	memoryPeakBytes: number | null;
	memoryLimitBytes: number | null;
	oomKills: number | null;
	pids: number | null;
	pidsLimit: number | null;
	netRxBytes: number | null;
	netTxBytes: number | null;
	blockReadBytes: number | null;
	blockWriteBytes: number | null;
}

export interface ContainerProcess {
	pid: number;
	ppid: number;
	uid: number;
	state: string;
	rssBytes: number;
	cpuMicros: number;
	startedAt: string | null;
	command: string;
}

export interface ContainerInspect {
	id: string;
	name: string;
	exists: boolean;
	state: {
		status: string;
		running: boolean;
		paused: boolean;
		restarting: boolean;
		oomKilled: boolean;
		exitCode: number | null;
		error: string | null;
		startedAt: string | null;
		finishedAt: string | null;
		health: string | null;
	};
	unit: { activeState: string; subState: string; restarts: number };
	image: { name: string | null; id: string | null; digest: string | null };
	config: {
		entrypoint: string[];
		command: string[];
		workingDir: string | null;
		user: string | null;
		hostname: string | null;
		envNames: string[];
		labels: Record<string, string>;
	};
	security: { readOnlyRootfs: boolean; capAdd: string[]; capDrop: string[]; noNewPrivileges: boolean };
	network: {
		ports: Array<{ container: string; host: string }>;
		networks: Array<{ name: string; ip: string | null; aliases: string[] }>;
	};
	mounts: Array<{ destination: string; type: string; readOnly: boolean; browsable: boolean; note: string | null }>;
	stats: ContainerStats | null;
	processes: ContainerProcess[];
}

export interface ContainerFileEntry {
	name: string;
	kind: 'file' | 'directory' | 'symlink' | 'socket' | 'fifo' | 'block' | 'char' | 'other';
	sizeBytes: number;
	mode: string;
	uid: number;
	gid: number;
	modifiedAt: string;
	linkTarget: string | null;
}

export interface ContainerDirListing {
	path: string;
	entries: ContainerFileEntry[];
	truncated: boolean;
	mount: string;
	readOnly: boolean;
}

export interface ContainerFilePreview {
	path: string;
	sizeBytes: number;
	modifiedAt: string;
	content: string | null;
	reason: 'binary' | 'too-large' | null;
}

// --- requests ----------------------------------------------------------------------------------

function base(project: string): string {
	return `/api/v1/projects/${encodeURIComponent(project)}/container`;
}

function query(params: Record<string, string | number | null | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) search.set(key, String(value));
	const text = search.toString();
	return text ? `?${text}` : '';
}

async function json<T>(response: Response): Promise<T> {
	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new CliError('The platform returned an unexpected container console response.', { code: 'protocol', cause: error });
	}
}

export class ContainerConsoleClient {
	constructor(
		private readonly client: ApiClient,
		private readonly project: string,
		private readonly replica: number | null = null,
	) {}

	async inspect(): Promise<{ targets: ContainerTarget[]; container: ContainerInspect | null; raw: unknown }> {
		const raw = await json<{ targets: ContainerTarget[]; container: ContainerInspect | null }>(
			await this.client.raw('GET', `${base(this.project)}/inspect${query({ replica: this.replica })}`),
		);
		return { ...raw, raw };
	}

	async list(path: string): Promise<ContainerDirListing> {
		const body = await json<{ listing: ContainerDirListing }>(
			await this.client.raw('GET', `${base(this.project)}/files${query({ path, replica: this.replica })}`),
		);
		return body.listing;
	}

	async preview(path: string): Promise<ContainerFilePreview> {
		const body = await json<{ preview: ContainerFilePreview }>(
			await this.client.raw('GET', `${base(this.project)}/files/preview${query({ path, replica: this.replica })}`),
		);
		return body.preview;
	}

	/** The file's bytes, streamed; `size` from the response when the node sent it. */
	async download(path: string): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }> {
		const response = await this.client.raw('GET', `${base(this.project)}/files/download${query({ path, replica: this.replica })}`, {
			headers: { accept: 'application/octet-stream' },
		});
		if (!response.body) throw new CliError('The download had no body.', { code: 'protocol' });
		const size = Number(response.headers.get('content-length'));
		return { body: response.body, size: Number.isFinite(size) ? size : null };
	}

	async restart(): Promise<{ generation: number; message: string }> {
		return json(await this.client.raw('POST', `${base(this.project)}/restart`));
	}

	async openShell(input: { shell: ContainerShell; user: 'default' | 'root'; cols: number; rows: number }): Promise<string> {
		const body = await json<{ exec?: { execId?: string } }>(
			await this.client.raw('POST', `${base(this.project)}/exec${query({ replica: this.replica })}`, {
				body: JSON.stringify(input),
				headers: { 'content-type': 'application/json' },
			}),
		);
		const execId = body.exec?.execId;
		if (typeof execId !== 'string') throw new CliError('The node did not open a shell.', { code: 'protocol', details: body });
		return execId;
	}

	async shellStream(execId: string, options: { after?: number; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
		const response = await this.client.raw('GET', `${base(this.project)}/exec/${execId}/stream${query({ replica: this.replica })}`, {
			headers: {
				accept: 'text/event-stream',
				...(options.after ? { 'last-event-id': String(options.after) } : {}),
			},
			signal: options.signal,
		});
		if (!response.body) throw new CliError('The shell stream had no body.', { code: 'protocol' });
		return response.body;
	}

	async shellInput(execId: string, bytes: Uint8Array): Promise<void> {
		const response = await this.client.raw('POST', `${base(this.project)}/exec/${execId}/input${query({ replica: this.replica })}`, {
			body: bytes,
			headers: { 'content-type': 'application/octet-stream' },
		});
		await response.body?.cancel().catch(() => undefined);
	}

	async shellResize(execId: string, cols: number, rows: number): Promise<void> {
		const response = await this.client.raw('POST', `${base(this.project)}/exec/${execId}/resize${query({ replica: this.replica })}`, {
			body: JSON.stringify({ cols: clamp(cols, 10, 500), rows: clamp(rows, 4, 200) }),
			headers: { 'content-type': 'application/json' },
		});
		await response.body?.cancel().catch(() => undefined);
	}

	async closeShell(execId: string): Promise<void> {
		const response = await this.client.raw('DELETE', `${base(this.project)}/exec/${execId}${query({ replica: this.replica })}`);
		await response.body?.cancel().catch(() => undefined);
	}
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

// --- the interactive shell ---------------------------------------------------------------------

/** What the shell session needs from the terminal; the process's stdio in production. */
export interface ShellIo {
	cols(): number;
	rows(): number;
	write(bytes: Uint8Array): void;
	/** Start delivering keystrokes (raw mode on a TTY); returns the function that stops it. */
	onInput(listener: (bytes: Uint8Array) => void): () => void;
	onResize(listener: () => void): () => void;
	notice(message: string): void;
}

export interface ShellSessionOptions {
	shell: ContainerShell;
	user: 'default' | 'root';
	/** Reconnects allowed after a dropped stream, resuming from the last byte offset. */
	reconnects?: number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run one interactive shell to its end and return the shell's exit code (`-1` when the session
 * was lost). Output resumes from the last byte offset after a dropped connection; input is
 * batched for a few milliseconds and sent in order.
 */
export async function runShell(remote: ContainerConsoleClient, io: ShellIo, options: ShellSessionOptions): Promise<number> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const execId = await remote.openShell({
		shell: options.shell,
		user: options.user,
		cols: clamp(io.cols(), 10, 500),
		rows: clamp(io.rows(), 4, 200),
	});
	let offset = 0;
	let exitCode: number | null = null;
	let sending: Promise<void> = Promise.resolve();
	let pending: Uint8Array[] = [];
	let flush: ReturnType<typeof setTimeout> | null = null;
	const controller = new AbortController();

	const stopInput = io.onInput((bytes) => {
		pending.push(bytes);
		if (flush) return;
		flush = setTimeout(() => {
			flush = null;
			const chunk = concat(pending);
			pending = [];
			sending = sending.then(() => remote.shellInput(execId, chunk).catch(() => undefined));
		}, 5);
	});
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	const stopResize = io.onResize(() => {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => void remote.shellResize(execId, io.cols(), io.rows()).catch(() => undefined), 100);
	});

	try {
		let attempts = 0;
		const maxReconnects = options.reconnects ?? 5;
		while (exitCode === null) {
			let stream: ReadableStream<Uint8Array>;
			try {
				stream = await remote.shellStream(execId, { after: offset, signal: controller.signal });
			} catch (error) {
				// A 404 means the node no longer holds the shell: nothing to resume.
				if ((error as { status?: number }).status === 404) throw new CliError('The shell session is gone.', { code: 'shell_gone' });
				if (attempts >= maxReconnects) throw error;
				attempts += 1;
				io.notice(`connection lost, reconnecting (${attempts}/${maxReconnects})…`);
				await sleep(Math.min(5_000, 500 * attempts));
				continue;
			}
			const parser = new SseParser();
			const decoder = new TextDecoder();
			const reader = stream.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					for (const event of parser.push(decoder.decode(value, { stream: true }))) {
						if (event.event === 'data') {
							io.write(Buffer.from(event.data, 'base64'));
							if (event.id && /^\d+$/.test(event.id)) offset = Number(event.id);
							attempts = 0;
						} else if (event.event === 'exit') {
							exitCode = Number((JSON.parse(event.data) as { code?: unknown }).code ?? -1);
						}
					}
					if (exitCode !== null) break;
				}
			} catch {
				// Dropped mid-stream: fall through to a resume.
			} finally {
				await reader.cancel().catch(() => undefined);
			}
			if (exitCode === null) {
				if (attempts >= maxReconnects) {
					io.notice('the connection did not come back; the shell keeps running on the node for 15 minutes.');
					return -1;
				}
				attempts += 1;
				io.notice(`connection lost, reconnecting (${attempts}/${maxReconnects})…`);
				await sleep(Math.min(5_000, 500 * attempts));
			}
		}
		return exitCode;
	} finally {
		stopInput();
		stopResize();
		if (flush) clearTimeout(flush);
		if (resizeTimer) clearTimeout(resizeTimer);
		controller.abort();
		await sending.catch(() => undefined);
		// Hang up when we leave for any reason other than the shell ending on its own.
		if (exitCode === null) await remote.closeShell(execId).catch(() => undefined);
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

// --- output ------------------------------------------------------------------------------------

function cpuTime(micros: number): string {
	const seconds = micros / 1_000_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${Math.round(seconds % 60)}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function bytes(value: number | null | undefined): string {
	return value === null || value === undefined ? '-' : formatBytes(value);
}

/** The status block `yoal container inspect` prints. */
export function inspectReport(container: ContainerInspect, target: ContainerTarget | undefined): string[] {
	const status = !container.exists
		? `${container.state.status} (unit ${container.unit.activeState}/${container.unit.subState})`
		: container.state.restarting
			? 'restarting'
			: container.state.running
				? 'running'
				: container.state.status;
	const stats = container.stats;
	const lines = [
		`${container.name}  ${status}${container.state.health ? ` (${container.state.health})` : ''}`,
		`  Image       ${container.image.name ?? '-'}${container.image.digest ? `  ${container.image.digest.slice(0, 19)}…` : ''}`,
		`  Node        ${target?.nodeName ?? '-'}${target && target.replica !== null ? `  replica ${target.replica}` : ''}`,
		`  Started     ${container.state.startedAt ? formatTime(container.state.startedAt) : '-'}`,
		`  Restarts    ${container.unit.restarts}${container.state.finishedAt ? `  last exit ${container.state.exitCode ?? '-'} at ${formatTime(container.state.finishedAt)}` : ''}`,
	];
	if (container.state.oomKilled || (stats?.oomKills ?? 0) > 0)
		lines.push(`  OOM         killed for memory${stats?.oomKills ? ` (${stats.oomKills}× since start)` : ''}`);
	if (container.state.error) lines.push(`  Error       ${container.state.error}`);
	if (stats) {
		lines.push(
			`  Memory      ${bytes(stats.memoryBytes)} of ${stats.memoryLimitBytes ? bytes(stats.memoryLimitBytes) : 'no limit'}  (peak ${bytes(stats.memoryPeakBytes)})`,
			`  CPU time    ${stats.cpuMicros === null ? '-' : cpuTime(stats.cpuMicros)}`,
			`  Network     ${bytes(stats.netRxBytes)} in, ${bytes(stats.netTxBytes)} out`,
			`  Disk I/O    ${bytes(stats.blockReadBytes)} read, ${bytes(stats.blockWriteBytes)} written`,
			`  PIDs        ${stats.pids ?? '-'}${stats.pidsLimit ? ` of ${stats.pidsLimit}` : ''}`,
		);
	}
	lines.push(
		`  Command     ${[...container.config.entrypoint, ...container.config.command].join(' ') || '-'}`,
		`  User        ${container.config.user ?? 'image default'}   Workdir ${container.config.workingDir ?? '/'}`,
		`  Env         ${container.config.envNames.length ? container.config.envNames.join(', ') : '-'}  (values stay on the node)`,
	);
	for (const port of container.network.ports) lines.push(`  Port        ${port.container} → ${port.host}`);
	for (const mount of container.mounts)
		lines.push(`  Mount       ${mount.destination}  ${mount.type}${mount.readOnly ? ' ro' : ' rw'}${mount.note ? ` (${mount.note})` : ''}`);
	lines.push(
		`  Sandbox     ${container.security.readOnlyRootfs ? 'read-only root' : 'writable root'}, ${container.security.noNewPrivileges ? 'no new privileges' : 'new privileges allowed'}`,
	);
	if (container.processes.length > 0) {
		lines.push('', renderTable(
			['PID', 'PPID', 'UID', 'S', 'CPU', 'RSS', 'COMMAND'],
			container.processes.map((process) => [
				String(process.pid),
				String(process.ppid),
				String(process.uid),
				process.state,
				cpuTime(process.cpuMicros),
				formatBytes(process.rssBytes),
				truncate(process.command, 80),
			]),
		));
	}
	return lines;
}

/** `ls -l`-style listing. */
export function listingTable(listing: ContainerDirListing): string {
	if (listing.entries.length === 0) return `${listing.path} is empty.`;
	const table = renderTable(
		['MODE', 'OWNER', 'SIZE', 'MODIFIED', 'NAME'],
		listing.entries.map((entry) => [
			`${kindLetter(entry.kind)}${entry.mode}`,
			`${entry.uid}:${entry.gid}`,
			entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '',
			formatTime(entry.modifiedAt),
			`${entry.name}${entry.kind === 'directory' ? '/' : ''}${entry.linkTarget ? ` -> ${entry.linkTarget}` : ''}`,
		]),
	);
	return listing.truncated ? `${table}\n(first ${listing.entries.length} entries; use the shell for the rest)` : table;
}

function kindLetter(kind: ContainerFileEntry['kind']): string {
	return { file: '-', directory: 'd', symlink: 'l', socket: 's', fifo: 'p', block: 'b', char: 'c', other: '?' }[kind];
}

/** `project:/path` → its parts, or null when the argument is a plain local path. */
export function parseRemote(value: string): { project: string; path: string } | null {
	const match = /^([a-z0-9][a-z0-9-]{1,62}):(\/.*)$/.exec(value);
	return match ? { project: match[1]!, path: match[2]! } : null;
}
