import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { HelperConfig } from './config.ts';
import {
	assertCpuWeight,
	assertId,
	assertMemoryMb,
	assertRecord,
	parseApplyRequest,
	ValidationError,
	type WorkloadActivation,
	type WorkloadDesired,
} from './validate.ts';
import type { HelperWorkloadStatus } from './systemd.ts';

/**
 * The helper's entire network surface: four fixed verbs on a root-owned, group-restricted unix
 * socket. There is no passthrough, no command parameter and no shell. Malformed input is a 400,
 * never a best-effort attempt.
 */

export interface HelperRuntime {
	ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void>;
	apply(workload: WorkloadDesired, activation: WorkloadActivation): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
}

export interface HandlerOptions {
	version: string;
	maxBodyBytes?: number;
}

class BodyTooLargeError extends Error {}

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function createHandler(
	runtime: HelperRuntime,
	options: HandlerOptions,
): (request: Request) => Promise<Response> {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

	return async (request: Request): Promise<Response> => {
		try {
			const path = new URL(request.url).pathname;
			const method = request.method;

			if (path === '/healthz') {
				if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET');
				return json({ ok: true, version: options.version });
			}

			if (path === '/v1/slice') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const memoryMb = assertMemoryMb(body.memoryMb, 'memoryMb');
				const cpuWeight = body.cpuWeight === undefined ? 200 : assertCpuWeight(body.cpuWeight, 'cpuWeight');
				await runtime.ensureSlice({ memoryMb, cpuWeight });
				return json({ ok: true, memoryMb, cpuWeight });
			}

			if (path === '/v1/workloads') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const { workload, activation } = parseApplyRequest(await readJson(request, maxBodyBytes));
				const status = await runtime.apply(workload, activation);
				return json({ ok: true, workload: status });
			}

			const match = /^\/v1\/workloads\/([^/]+)$/.exec(path);
			if (match) {
				const raw = match[1]!;
				let id: string;
				try {
					id = assertId(decodeURIComponent(raw), 'workload id');
				} catch (error) {
					if (error instanceof ValidationError) throw error;
					throw new ValidationError('workload id is not valid URL encoding');
				}
				if (method === 'GET') return json({ ok: true, workload: await runtime.status(id) });
				if (method === 'DELETE') {
					await runtime.remove(id);
					return json({ ok: true });
				}
				return methodNotAllowed('GET, DELETE');
			}

			return json({ error: 'not_found', path }, 404);
		} catch (error) {
			if (error instanceof BodyTooLargeError) return json({ error: error.message }, 413);
			if (error instanceof ValidationError) return json({ error: error.message }, 400);
			// Never include request bodies or secret values here; runtime errors name units only.
			return json({ error: error instanceof Error ? error.message : 'internal helper error' }, 500);
		}
	};
}

export interface RunningHelper {
	server: ReturnType<typeof Bun.serve>;
	socketPath: string;
	stop(): Promise<void>;
}

/** Bind the root-owned control socket. The agent connects through its group, never "other". */
export async function startHelperServer(
	config: HelperConfig,
	runtime: HelperRuntime,
): Promise<RunningHelper> {
	const directory = dirname(config.socketPath);
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	let groupId: number | null = null;
	if (config.controlSocketGroup) {
		groupId = await resolveGroupId(config.controlSocketGroup);
		if (isRoot && groupId === null) {
			throw new Error(
				`Helper socket group "${config.controlSocketGroup}" does not exist; set SKIFF_HELPER_CONTROL_SOCKET_GROUP`,
			);
		}
	}

	await fs.mkdir(directory, { recursive: true, mode: config.socketDirMode });
	await fs.chmod(directory, config.socketDirMode).catch(() => undefined);
	if (isRoot && groupId !== null) await fs.chown(directory, 0, groupId);
	await fs.rm(config.socketPath, { force: true }).catch(() => undefined);

	const server = Bun.serve({
		unix: config.socketPath,
		fetch: createHandler(runtime, { version: config.version }),
	});
	await fs.chmod(config.socketPath, Number.parseInt(config.controlSocketMode, 8));
	if (isRoot && groupId !== null) await fs.chown(config.socketPath, 0, groupId);

	return {
		server,
		socketPath: config.socketPath,
		async stop(): Promise<void> {
			server.stop(true);
			await fs.rm(config.socketPath, { force: true }).catch(() => undefined);
		},
	};
}

/** `/etc/group` lookup without a subprocess or shell. */
async function resolveGroupId(name: string): Promise<number | null> {
	try {
		const text = await fs.readFile('/etc/group', 'utf8');
		for (const line of text.split('\n')) {
			const fields = line.split(':');
			if (fields[0] !== name) continue;
			const gid = Number(fields[2]);
			return Number.isInteger(gid) && gid >= 0 ? gid : null;
		}
	} catch {
		// Group lookup is best effort outside a normal Linux host.
	}
	return null;
}

async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > maxBodyBytes)
		throw new BodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`);
	const text = await request.text();
	if (Buffer.byteLength(text) > maxBodyBytes)
		throw new BodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`);
	if (!text.trim()) throw new ValidationError('Request body is required');
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ValidationError('Request body must be valid JSON');
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { 'cache-control': 'no-store' },
	});
}

function methodNotAllowed(allow: string): Response {
	return Response.json(
		{ error: 'method_not_allowed' },
		{ status: 405, headers: { allow, 'cache-control': 'no-store' } },
	);
}
