import type { PipelineContainerRuntime } from '@skiff/contracts';

/**
 * The Builder's client for skiff-helper's pipeline verbs (docs/PIPELINES.md W5/W6,
 * `apps/helper/src/pipeline-jobs.ts`). The Builder runs as root but without the capabilities
 * Podman needs (D151), so in `container` isolation every container lifecycle step is a fixed
 * helper verb over the root-only unix socket: the Builder sends validated values, never paths.
 *
 *   GET  /v1/pipeline/capabilities        Podman version, runtimes, userns, buildsRoot
 *   POST /v1/pipeline/jobs/start          { jobId, image, memoryMb, cpus, runtime, profile, env[], services[], buildkit, buildkitCacheScope }
 *   GET  /v1/pipeline/jobs/:id            { state, exitCode, oomKilled, error, events[] }
 *   POST /v1/pipeline/jobs/:id/stop       { force? }  SIGTERM to the step runner, or SIGKILL
 *   POST /v1/pipeline/jobs/:id/cleanup    containers, network, env files (never the workspace)
 *   GET  /v1/pipeline/jobs                job ids with containers on this node (orphan reaping)
 */

export const DEFAULT_HELPER_SOCKET = '/run/skiff-helper/helper.sock';

export interface HelperPipelineCapabilities {
	podman: string | null;
	runtimes: PipelineContainerRuntime[];
	userns: boolean;
	fuse: boolean;
	kvm: boolean;
	stepBinary: boolean;
	buildsRoot: string;
	buildkit: { version: string; image: string };
}

export interface HelperPipelineService {
	name: string;
	image: string;
	/** `NAME=VALUE`; the helper writes them to a 0400 env file. */
	env: string[];
	healthCmd: string | null;
	aliases?: string[];
}

export interface HelperPipelineStart {
	jobId: string;
	image: string;
	memoryMb: number;
	cpus: number;
	runtime: PipelineContainerRuntime;
	profile: 'default' | 'oci-build';
	env: string[];
	services: HelperPipelineService[];
	buildkit: boolean;
	buildkitCacheScope: string | null;
}

export interface HelperPipelineStatus {
	jobId: string;
	state: 'starting' | 'running' | 'exited' | 'failed' | 'not-found';
	exitCode: number | null;
	oomKilled: boolean;
	error: string | null;
	events: string[];
}

export class HelperError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'HelperError';
	}
}

/** The verbs the executor needs; a fake in tests. */
export interface PipelineHelper {
	capabilities(): Promise<HelperPipelineCapabilities>;
	start(request: HelperPipelineStart): Promise<HelperPipelineStatus>;
	status(jobId: string): Promise<HelperPipelineStatus>;
	stop(jobId: string, force?: boolean): Promise<void>;
	cleanup(jobId: string): Promise<void>;
	list(): Promise<string[]>;
}

export class PipelineHelperClient implements PipelineHelper {
	constructor(readonly socketPath: string = DEFAULT_HELPER_SOCKET) {}

	private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`http://skiff-helper${path}`, {
				method,
				unix: this.socketPath,
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			} as RequestInit);
		} catch (error) {
			throw new HelperError(`skiff-helper at ${this.socketPath} is not reachable: ${error instanceof Error ? error.message : String(error)}`, 0);
		}
		const text = await response.text();
		let parsed: Record<string, unknown> = {};
		try {
			parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		} catch {
			// Fall through with the raw text in the error.
		}
		if (!response.ok) {
			const message = typeof parsed.error === 'string' ? parsed.error : text.slice(0, 500);
			throw new HelperError(`skiff-helper ${method} ${path}: ${response.status} ${message}`.trim(), response.status);
		}
		return parsed as T;
	}

	async capabilities(): Promise<HelperPipelineCapabilities> {
		return (await this.request<{ capabilities: HelperPipelineCapabilities }>('GET', '/v1/pipeline/capabilities', undefined, 15_000)).capabilities;
	}

	async start(request: HelperPipelineStart): Promise<HelperPipelineStatus> {
		return (await this.request<{ job: HelperPipelineStatus }>('POST', '/v1/pipeline/jobs/start', request, 60_000)).job;
	}

	async status(jobId: string): Promise<HelperPipelineStatus> {
		return (await this.request<{ job: HelperPipelineStatus }>('GET', `/v1/pipeline/jobs/${encodeURIComponent(jobId)}`)).job;
	}

	async stop(jobId: string, force = false): Promise<void> {
		await this.request('POST', `/v1/pipeline/jobs/${encodeURIComponent(jobId)}/stop`, { force });
	}

	async cleanup(jobId: string): Promise<void> {
		await this.request('POST', `/v1/pipeline/jobs/${encodeURIComponent(jobId)}/cleanup`, {}, 90_000);
	}

	async list(): Promise<string[]> {
		return (await this.request<{ jobs: string[] }>('GET', '/v1/pipeline/jobs')).jobs;
	}
}

/**
 * Lines from a Podman `k8s-file` log (`<RFC3339Nano> <stdout|stderr> <F|P> <text>`), read from a
 * byte offset. Partial (`P`) records are joined with the next one. Returns the new offset; a file
 * shorter than the offset was rotated (conmon truncates at max-size), so reading restarts at 0.
 */
export async function readK8sLog(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
	const file = Bun.file(path);
	if (!(await file.exists())) return { lines: [], offset };
	const size = file.size;
	const start = size < offset ? 0 : offset;
	if (size === start) return { lines: [], offset: start };
	const text = await file.slice(start, size).text();
	const end = text.lastIndexOf('\n');
	if (end < 0) return { lines: [], offset: start };
	const lines: string[] = [];
	let partial = '';
	for (const record of text.slice(0, end).split('\n')) {
		const match = /^\S+ (?:stdout|stderr) ([FP]) ?(.*)$/.exec(record);
		if (!match) continue;
		partial += match[2];
		if (match[1] === 'F') {
			lines.push(partial);
			partial = '';
		}
	}
	return { lines, offset: start + Buffer.byteLength(text.slice(0, end + 1)) };
}
