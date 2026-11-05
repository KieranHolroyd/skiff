import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { HelperConfig } from './config.ts';
import {
	assertCpuWeight,
	assertDatabaseId,
	assertId,
	assertManagedId,
	assertMemoryMb,
	assertRecord,
	assertString,
	parseApplyRequest,
	ValidationError,
	type WorkloadActivation,
	type WorkloadDesired,
} from './validate.ts';
import type { HelperLogResult, HelperWorkloadStatus, LogReadOptions } from './systemd.ts';
import type { HelperInventory, VerifyResult } from './volumes.ts';

/**
 * The helper's entire network surface: six fixed verbs (slice, apply, status, remove, logs and
 * purge) plus `/healthz` on a root-owned, group-restricted unix socket. There is no passthrough, no command parameter and no shell. Malformed input is a 400,
 * never a best-effort attempt.
 */

export interface HelperRuntime {
	ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void>;
	apply(workload: WorkloadDesired, activation: WorkloadActivation): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
	logs(id: string, options?: LogReadOptions): Promise<HelperLogResult>;
	/** Remove a purged database's or storage instance's unit and `<stateDir>/<id>` data dir (D59, S8). */
	purge(id: string): Promise<void>;
	/** Dump a managed database with the fixed `pg_dump -Fc` profile (docs/DATABASES.md §9). */
	dumpDatabase(id: string): Promise<{ path: string; sizeBytes: number; filename: string }>;
	/** Apply a new password to the owner or monitor role (docs/DATABASES.md §4). */
	rotateDatabaseRole(id: string, role: 'owner' | 'monitor', newPassword: string): Promise<void>;
	/** Restart only the PgBouncer sidecar. */
	restartPooler(id: string): Promise<void>;
	/** Restore a custom-format dump into a managed database. */
	restoreDatabase(id: string, body: ReadableStream<Uint8Array> | null): Promise<void>;
	/** Write the 0400 pgBackRest config for PITR (docs/PITR.md). */
	pitrConfigure(id: string, repo: unknown): Promise<{ stanza: string; configPath: string }>;
	/** Run a full or differential pgBackRest base backup. */
	pitrBaseBackup(id: string, type: unknown): Promise<{ stanza: string; type: 'full' | 'diff' | 'incr' }>;
	/** Restore a stanza to a timestamp into a new database and verify it. */
	pitrRestore(
		id: string,
		input: { targetDatabaseId: unknown; targetTime: unknown },
	): Promise<{ targetDatabaseId: string; targetTime: number; verified: true }>;
	/** Credential-free archive/repository status. */
	pitrStatus(id: string): Promise<{
		configured: boolean;
		stanza: string;
		repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
		archiveStatus: 'ok' | 'failing' | 'unknown';
	}>;
	/** Mounts and free block devices for the volume wizard (D72). */
	volumesInventory(): Promise<HelperInventory>;
	/** Replace the volume registry from desired state (D74). */
	syncVolumes(volumes: unknown): Promise<number>;
	/** Prove that a registered volume is really mounted before a workload starts (D76). */
	verifyVolume(input: { mountPath: string; sourceKey: string }): Promise<VerifyResult>;
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
			const url = new URL(request.url);
			const path = url.pathname;
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

			// --- volumes (D72, D76): read-only inventory and mount verification -----------------
			if (path === '/v1/volumes') {
				if (method !== 'GET') return methodNotAllowed('GET');
				return json({ ok: true, inventory: await runtime.volumesInventory() });
			}
			if (path === '/v1/volumes/registry') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				if (!Array.isArray(body.volumes)) throw new ValidationError('volumes must be an array');
				const count = await runtime.syncVolumes(body.volumes);
				return json({ ok: true, count });
			}
			if (path === '/v1/volumes/verify') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const mountPath = assertString(body.mountPath, 'mountPath', { max: 200 });
				if (!mountPath.startsWith('/') || mountPath.includes('/../') || mountPath.endsWith('/..'))
					throw new ValidationError('mountPath must be an absolute, normalized path');
				const sourceKey = assertString(body.sourceKey, 'sourceKey', { max: 300 });
				return json(await runtime.verifyVolume({ mountPath, sourceKey }));
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

			const dumpMatch = /^\/v1\/workloads\/([^/]+)\/dump$/.exec(path);
			if (dumpMatch) {
				if (method !== 'GET') return methodNotAllowed('GET');
				let id: string;
				try {
					id = assertDatabaseId(decodeURIComponent(dumpMatch[1]!), 'database id');
				} catch (error) {
					if (error instanceof ValidationError) throw error;
					throw new ValidationError('database id is not valid URL encoding');
				}
				const dump = await runtime.dumpDatabase(id);
				setTimeout(() => {
					void fs.rm(dump.path, { force: true }).catch(() => undefined);
				}, 10 * 60_000);
				const file = Bun.file(dump.path);
				return new Response(file.stream(), {
					headers: {
						'content-type': 'application/octet-stream',
						'content-length': String(dump.sizeBytes),
						'content-disposition': `attachment; filename="${dump.filename}"`,
						'cache-control': 'no-store',
					},
				});
			}

			const restoreMatch = /^\/v1\/workloads\/([^/]+)\/restore$/.exec(path);
			if (restoreMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				let id: string;
				try {
					id = assertDatabaseId(decodeURIComponent(restoreMatch[1]!), 'database id');
				} catch (error) {
					if (error instanceof ValidationError) throw error;
					throw new ValidationError('database id is not valid URL encoding');
				}
				await runtime.restoreDatabase(id, request.body);
				return json({ ok: true, restored: id });
			}

			const poolerRestartMatch = /^\/v1\/workloads\/([^/]+)\/pooler\/restart$/.exec(path);
			if (poolerRestartMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = assertDatabaseId(decodeURIComponent(poolerRestartMatch[1]!), 'database id');
				await runtime.restartPooler(id);
				return json({ ok: true, restarted: id });
			}

			const rotateMatch = /^\/v1\/workloads\/([^/]+)\/rotate$/.exec(path);
			if (rotateMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = assertDatabaseId(decodeURIComponent(rotateMatch[1]!), 'database id');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const role = body.role === 'owner' || body.role === 'monitor' ? body.role : null;
				if (!role) throw new ValidationError('role must be owner or monitor');
				const password = assertString(body.password, 'password', { max: 200 });
				await runtime.rotateDatabaseRole(id, role, password);
				return json({ ok: true, rotated: role });
			}

			// --- PITR (docs/PITR.md): fixed pgBackRest verbs, no command passthrough ------------
			const pitrMatch = /^\/v1\/workloads\/([^/]+)\/pitr\/(configure|basebackup|restore|status)$/.exec(path);
			if (pitrMatch) {
				const id = assertDatabaseId(decodeURIComponent(pitrMatch[1]!), 'database id');
				const verb = pitrMatch[2]!;
				if (verb === 'status') {
					if (method !== 'GET') return methodNotAllowed('GET');
					return json({ ok: true, ...(await runtime.pitrStatus(id)) });
				}
				if (method !== 'POST') return methodNotAllowed('POST');
				if (verb === 'configure') {
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					return json({ ok: true, ...(await runtime.pitrConfigure(id, body.repo)) });
				}
				if (verb === 'basebackup') {
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					return json({ ok: true, ...(await runtime.pitrBaseBackup(id, body.type)) });
				}
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				return json({
					ok: true,
					...(await runtime.pitrRestore(id, {
						targetDatabaseId: body.targetDatabaseId,
						targetTime: body.targetTime,
					})),
				});
			}

			const purgeMatch = /^\/v1\/workloads\/([^/]+)\/purge$/.exec(path);
			if (purgeMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				let id: string;
				try {
					id = assertManagedId(decodeURIComponent(purgeMatch[1]!), 'managed id');
				} catch (error) {
					if (error instanceof ValidationError) throw error;
					throw new ValidationError('managed id is not valid URL encoding');
				}
				await runtime.purge(id);
				return json({ ok: true, purged: id });
			}

			const logMatch = /^\/v1\/workloads\/([^/]+)\/logs$/.exec(path);
			if (logMatch) {
				if (method !== 'GET') return methodNotAllowed('GET');
				let id: string;
				try {
					id = assertId(decodeURIComponent(logMatch[1]!), 'workload id');
				} catch (error) {
					if (error instanceof ValidationError) throw error;
					throw new ValidationError('workload id is not valid URL encoding');
				}
				const lines = Number(url.searchParams.get('lines') ?? 200);
				if (!Number.isFinite(lines) || lines < 1 || lines > 1_000)
					throw new ValidationError('lines must be between 1 and 1000');
				const cursor = url.searchParams.get('cursor')?.trim() || undefined;
				if (cursor && cursor.length > 512)
					throw new ValidationError('cursor must be 512 characters or fewer');
				const result = await runtime.logs(id, { cursor, lines: Math.floor(lines) });
				return json({ ok: true, ...result });
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
