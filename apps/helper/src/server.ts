import type { ImagePruneResult } from './images.ts';
import { MirrorValidationError, parseMirrorRequest, type MirrorRequest } from './registry-mirror.ts';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { assertMailHost } from './mail.ts';
import { dirname } from 'node:path';
import type { HelperConfig } from './config.ts';
import {
	assertCpuWeight,
	assertDatabaseId,
	assertId,
	assertManagedId,
	assertMemoryMb,
	assertNoVerbInput,
	assertRecord,
	assertString,
	parseApplyRequest,
	ValidationError,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadFunctionFiles,
} from './validate.ts';
import type { HelperLogResult, HelperWorkloadStatus, LogReadOptions } from './systemd.ts';
import type { HelperPitrStatus } from './pitr.ts';
import type { ReplicationSlotStatus } from './replication.ts';
import { parseStudioPrincipalRequest, STUDIO_PRINCIPAL_USER } from './studio-principal.ts';
import type { HelperInventory, VerifyResult } from './volumes.ts';
import { NodeUpdateError, parseNodeUpdateRequest, type NodeUpdateRequest, type NodeUpdateResult } from './node-update.ts';
import type { WireguardStatus } from './wireguard.ts';
import type { ShareMount, ShareMountStatus } from './shares.ts';
import type { DiskMountRequest, DiskMountStatus } from './disks.ts';
import type { VolumeProfileRequest, VolumeProfileResult } from './volume-profile.ts';
import { CONSOLE_SHELLS, ConsoleError, type ConsoleShell, type ContainerConsole } from './container-console.ts';
import { ContainerFileError } from './container-files.ts';
import {
	parseAppVolumeRef,
	parseAppVolumeRefQuery,
	parseAppVolumeRefs,
	parseSnapshotRequest,
	type AppVolumeData,
} from './app-volumes.ts';
import { assertRunId, parseJobRequest, type JobApi } from './jobs.ts';
import { routePipelineRequest, type PipelineJobApi } from './pipeline-jobs.ts';

/**
 * The helper's entire network surface is a fixed set of verbs (slice, apply, status, remove, logs,
 * purge, dump/restore, rotation, credentials, PITR and the studio process)
 * plus `/healthz` on a root-owned, group-restricted unix socket. There is no passthrough, no
 * command parameter and no shell. Malformed input is a 400, never a best-effort attempt.
 */

export interface HelperRuntime {
	ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void>;
	apply(
		workload: WorkloadDesired,
		activation: WorkloadActivation,
		functionFiles?: WorkloadFunctionFiles,
	): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
	/** Stop one workload's service; the `.socket` unit keeps listening (FN4). Idempotent. */
	stop(id: string): Promise<void>;
	/** Restart a socket-activated workload's service, then its socket (FN5). Idempotent. */
	restart(id: string): Promise<void>;
	logs(id: string, options?: LogReadOptions): Promise<HelperLogResult>;
	/** Remove a purged database's or storage instance's unit and `<stateDir>/<id>` data dir (D59, S8). */
	purge(id: string): Promise<void>;
	/** Dump a managed database with the fixed `pg_dump -Fc` profile (docs/DATABASES.md §9). */
	dumpDatabase(id: string): Promise<{ path: string; sizeBytes: number; filename: string }>;
	/** Apply a new password to the owner or monitor role (docs/DATABASES.md §4). */
	rotateDatabaseRole(id: string, role: 'owner' | 'monitor', newPassword: string): Promise<void>;
	/** Grant or revoke a named database role (plan 04b). */
	applyDatabaseCredential(
		id: string,
		action: 'grant' | 'revoke',
		role: 'owner' | 'app' | 'monitor' | 'readonly' | 'backup',
		username: string,
		password?: string,
	): Promise<void>;
	/** Create or update the fixed read-only `skiff_studio_ro` principal (plan 22 track G). */
	ensureStudioPrincipal(id: string, password: string): Promise<void>;
	/** Restart only the PgBouncer sidecar. */
	restartPooler(id: string): Promise<void>;
	/**
	 * Streaming replication (docs/CLUSTERING.md §9.2, C7): keep a primary's role, `pg_hba` rule and
	 * exactly these slots; sample its slots; promote a replica and hand over its data dir.
	 * Optional: an older runtime answers 404.
	 */
	replicationConfigure?(id: string, input: { slots?: unknown; password?: unknown }): Promise<{ slots: string[] }>;
	replicationStatus?(id: string): Promise<{ slots: ReplicationSlotStatus[] }>;
	replicaPromote?(id: string, input: { databaseId?: unknown }): Promise<{ databaseId: string; lsn: string | null }>;
	/** `systemctl start skiff-studio.service` (plan 22). The unit name is fixed; no arguments. */
	/** Remove images no unit or container needs (docs/REGISTRY.md R3). Optional for test fakes. */
	pruneImages?(): Promise<ImagePruneResult>;
	/** The platform registry's pull-through mirror (docs/REGISTRY.md G4). Optional for test fakes. */
	applyRegistryMirror?(request: MirrorRequest): Promise<{ upstreams: string[]; changed: boolean }>;
	startStudio(): Promise<void>;
	/** `systemctl stop skiff-studio.service`. */
	stopStudio(): Promise<void>;
	/** `systemctl start skiff-mail.service` (docs/EMAIL.md). Optional: older runtimes answer 501. */
	startMail?(): Promise<void>;
	/** `systemctl stop skiff-mail.service`. */
	stopMail?(): Promise<void>;
	/** Copy the submission host's certificate from Caddy's storage for `skiff-mail`. */
	copyMailTls?(host: string): Promise<{ found: boolean; changed: boolean }>;
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
	/** Credential-free archive/repository status and the recoverable window. */
	pitrStatus(id: string): Promise<HelperPitrStatus>;
	/** Mounts and block devices, from which Settings → Storage lists disk candidates (D72). */
	volumesInventory(): Promise<HelperInventory>;
	/** Replace the disk registry from desired state (D76). */
	syncVolumes(volumes: unknown): Promise<number>;
	/** Prove that a registered disk is really mounted before a workload starts (D76). */
	verifyVolume(input: { mountPath: string; sourceKey: string }): Promise<VerifyResult>;
}

export interface WireguardApi {
	keygen(): Promise<{ publicKey: string }>;
	apply(state: unknown): Promise<{ peers: number }>;
	status(): Promise<WireguardStatus>;
}

export interface HandlerOptions {
	version: string;
	maxBodyBytes?: number;
	/** The signed-release installer behind `POST /v1/node/update` (D99); absent = 404. */
	nodeUpdate?: { update(request: NodeUpdateRequest): Promise<NodeUpdateResult> };
	/** Managed overlay verbs (C1); absent on a helper that predates the overlay. */
	wireguard?: WireguardApi;
	/** Profiling of a registered disk (docs/STORAGE.md §5.1); absent = 404. */
	volumeProfiler?: { profile(request: VolumeProfileRequest): Promise<VolumeProfileResult> };
	/** Share mount verbs (C3); absent on a helper that predates cluster shares. */
	shares?: {
		mount(share: ShareMount): Promise<ShareMountStatus>;
		unmount(id: string): Promise<{ id: string; mounted: boolean; error: string | null }>;
		status(ids: string[]): Promise<ShareMountStatus[]>;
	};
	/** Disk mount verbs (docs/STORAGE.md §3.1); absent on a helper that predates them. */
	disks?: {
		mount(request: DiskMountRequest): Promise<DiskMountStatus>;
		unmount(id: string): Promise<{ id: string; mounted: boolean; error: string | null }>;
		status(ids: string[]): Promise<DiskMountStatus[]>;
	};
	/** Container console verbs (D127); absent on a helper that predates them. */
	containers?: ContainerConsole;
	/** App-volume usage, purge, snapshot and restore (docs/VOLUMES.md); absent = 404. */
	appVolumes?: Pick<AppVolumeData, 'usage' | 'purge' | 'snapshot' | 'restore'>;
	/** Job runs as transient units (plan 09); absent on a helper that predates jobs. */
	jobs?: JobApi;
	/** Pipeline job containers (docs/PIPELINES.md W5/W6); absent on a helper that predates them. */
	pipelineJobs?: PipelineJobApi;
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

			if (path === '/v1/registry/mirror') {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (!runtime.applyRegistryMirror) return json({ error: 'not_found', path }, 404);
				let mirror: MirrorRequest;
				try {
					mirror = parseMirrorRequest(await readJson(request, maxBodyBytes));
				} catch (error) {
					if (error instanceof MirrorValidationError) throw new ValidationError(error.message);
					throw error;
				}
				return json({ ok: true, ...(await runtime.applyRegistryMirror(mirror)) });
			}

			if (path === '/v1/images/prune') {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (!runtime.pruneImages) return json({ error: 'not_found', path }, 404);
				return json({ ok: true, ...(await runtime.pruneImages()) });
			}

			if (path === '/v1/slice') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const memoryMb = assertMemoryMb(body.memoryMb, 'memoryMb');
				const cpuWeight = body.cpuWeight === undefined ? 200 : assertCpuWeight(body.cpuWeight, 'cpuWeight');
				await runtime.ensureSlice({ memoryMb, cpuWeight });
				return json({ ok: true, memoryMb, cpuWeight });
			}

			// --- node update (D99): install a signed release's agent + helper, nothing else ------
			if (path === '/v1/node/update' && options.nodeUpdate) {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (url.search) throw new ValidationError('node update takes no query parameters');
				const input = parseNodeUpdateRequest(await readJson(request, maxBodyBytes));
				return json({ ok: true, ...(await options.nodeUpdate.update(input)) });
			}

			// --- managed overlay (C1): keygen, apply, status; no shell and no passthrough ----
			if (path.startsWith('/v1/wireguard/')) {
				if (!options.wireguard) return json({ error: 'wireguard is not available on this helper' }, 404);
				if (path === '/v1/wireguard/keygen') {
					if (method !== 'POST') return methodNotAllowed('POST');
					assertNoVerbInput({ search: url.search, body: await readText(request, maxBodyBytes) });
					return json({ ok: true, ...(await options.wireguard.keygen()) });
				}
				if (path === '/v1/wireguard/apply') {
					if (method !== 'POST') return methodNotAllowed('POST');
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					if (!('state' in body)) throw new ValidationError('state is required');
					return json({ ok: true, ...(await options.wireguard.apply(body.state)) });
				}
				if (path === '/v1/wireguard/status') {
					if (method !== 'GET') return methodNotAllowed('GET');
					return json({ ok: true, ...(await options.wireguard.status()) });
				}
				return json({ error: 'not_found' }, 404);
			}

			// --- cluster share mounts (C3): fixed mount/unmount, no shell ---------------------
			if (path === '/v1/shares/mount' || path === '/v1/shares/unmount' || path === '/v1/shares/status') {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (!options.shares) return json({ error: 'shares are not available on this helper' }, 404);
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				if (path === '/v1/shares/status') {
					if (!Array.isArray(body.ids) || body.ids.length > 100) throw new ValidationError('ids must be an array of at most 100');
					const ids = body.ids.map((id, index) => assertString(id, `ids[${index}]`, { max: 100 }));
					return json({ ok: true, shares: await options.shares.status(ids) });
				}
				if (path === '/v1/shares/mount') {
					const share = assertRecord(body.share, 'share') as unknown as ShareMount;
					return json({ ok: true, share: await options.shares.mount(share) });
				}
				const id = assertString(body.id, 'id', { max: 100 });
				return json({ ok: true, ...(await options.shares.unmount(id)) });
			}

			// --- disk mounts (STORAGE §3.1): a UUID and a name in, fixed mount, no shell ----------
			if (path === '/v1/disks/mount' || path === '/v1/disks/unmount' || path === '/v1/disks/status') {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (!options.disks) return json({ error: 'partition mounts are not available on this helper' }, 404);
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				if (path === '/v1/disks/status') {
					if (!Array.isArray(body.ids) || body.ids.length > 100) throw new ValidationError('ids must be an array of at most 100');
					const ids = body.ids.map((id, index) => assertString(id, `ids[${index}]`, { max: 100 }));
					return json({ ok: true, disks: await options.disks.status(ids) });
				}
				if (path === '/v1/disks/mount') {
					const disk = assertRecord(body.disk, 'disk');
					return json({
						ok: true,
						disk: await options.disks.mount({
							id: assertString(disk.id, 'disk.id', { max: 100 }),
							fsUuid: assertString(disk.fsUuid, 'disk.fsUuid', { max: 64 }),
							fsType: assertString(disk.fsType, 'disk.fsType', { max: 32 }),
						}),
					});
				}
				const id = assertString(body.id, 'id', { max: 100 });
				return json({ ok: true, ...(await options.disks.unmount(id)) });
			}

			// --- native database studio (plan 22): start/stop one fixed unit, nothing else -----
			if (path === '/v1/studio/start' || path === '/v1/studio/stop') {
				if (method !== 'POST') return methodNotAllowed('POST');
				assertNoVerbInput({ search: url.search, body: await readText(request, maxBodyBytes) });
				if (path === '/v1/studio/start') await runtime.startStudio();
				else await runtime.stopStudio();
				return json({ ok: true });
			}

			// --- email (docs/EMAIL.md §3.2): one fixed unit, and its certificate -----------------
			if (path === '/v1/mail/start' || path === '/v1/mail/stop') {
				if (method !== 'POST') return methodNotAllowed('POST');
				assertNoVerbInput({ search: url.search, body: await readText(request, maxBodyBytes) });
				const verb = path === '/v1/mail/start' ? runtime.startMail : runtime.stopMail;
				if (!verb) return json({ error: 'not_supported' }, 501);
				await verb.call(runtime);
				return json({ ok: true });
			}
			if (path === '/v1/mail/tls') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				if (!runtime.copyMailTls) return json({ error: 'not_supported' }, 501);
				return json({ ok: true, ...(await runtime.copyMailTls(assertMailHost(body.host))) });
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
			if (path === '/v1/volumes/profile') {
				if (method !== 'POST') return methodNotAllowed('POST');
				if (!options.volumeProfiler) return json({ error: 'volume profiling is not available on this helper' }, 404);
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const input = {
					volumeId: assertString(body.volumeId, 'volumeId', { max: 100 }),
					sizeMb: Number(body.sizeMb),
					runtimeSeconds: Number(body.runtimeSeconds),
				};
				try {
					return json({ ok: true, profile: await options.volumeProfiler.profile(input) });
				} catch (error) {
					return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
				}
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

			// --- app volumes (docs/VOLUMES.md): ids and backing in, never a path ----------------------
			if (path.startsWith('/v1/app-volumes/')) {
				const appVolumes = options.appVolumes;
				if (!appVolumes) return json({ error: 'app volume verbs are not available on this helper' }, 404);
				if (method !== 'POST') return methodNotAllowed('POST');
				const verb = path.slice('/v1/app-volumes/'.length);
				if (verb === 'usage') {
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					return json({ ok: true, usage: await appVolumes.usage(parseAppVolumeRefs(body.volumes)) });
				}
				if (verb === 'purge') {
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					const ref = parseAppVolumeRef(body.volume);
					await appVolumes.purge(ref);
					return json({ ok: true, purged: ref.id });
				}
				if (verb === 'snapshot') {
					const snapshot = await appVolumes.snapshot(parseSnapshotRequest(await readJson(request, maxBodyBytes)));
					return new Response(snapshot.body, {
						headers: {
							'content-type': 'application/gzip',
							'x-skiff-snapshot-method': snapshot.method,
							'cache-control': 'no-store',
						},
					});
				}
				if (verb === 'restore') {
					// The body is the archive, so the reference rides the query string.
					const ref = parseAppVolumeRefQuery(url.searchParams);
					await appVolumes.restore(ref, request.body);
					return json({ ok: true, restored: ref.id });
				}
				return json({ error: 'not_found', path }, 404);
			}

			// --- pipeline job containers (W5/W6): validated fields only, helper-derived mounts ----------
			if (path.startsWith('/v1/pipeline/')) {
				if (!options.pipelineJobs) return json({ error: 'pipeline jobs are not available on this helper' }, 404);
				const routed = await routePipelineRequest(options.pipelineJobs, {
					method,
					path,
					search: url.search,
					readJson: () => readJson(request, maxBodyBytes),
					readText: () => readText(request, maxBodyBytes),
				});
				if (!routed) return json({ error: 'not_found', path }, 404);
				if (routed.allow) return methodNotAllowed(routed.allow);
				return json(routed.body, routed.status);
			}

			// --- job runs (plan 09): one transient unit per run id, argv only, no shell ----------------
			if (path === '/v1/jobs' || path.startsWith('/v1/jobs/')) {
				const jobs = options.jobs;
				if (!jobs) return json({ error: 'jobs are not available on this helper' }, 404);
				if (path === '/v1/jobs') {
					if (method !== 'POST') return methodNotAllowed('POST');
					const job = await jobs.start(parseJobRequest(await readJson(request, maxBodyBytes)));
					return json({ ok: true, job });
				}
				const jobMatch = /^\/v1\/jobs\/([^/]+)(?:\/(logs|stop))?$/.exec(path);
				if (!jobMatch) return json({ error: 'not_found', path }, 404);
				const runId = assertRunId(jobMatch[1]);
				const verb = jobMatch[2];
				if (!verb) {
					if (method === 'GET') {
						const raw = url.searchParams.get('timeout');
						const timeout = raw === null ? undefined : Number(raw);
						if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400))
							throw new ValidationError('timeout must be an integer number of seconds');
						return json({ ok: true, job: await jobs.status(runId, timeout) });
					}
					if (method === 'DELETE') {
						assertNoVerbInput({ search: url.search, body: await readText(request, maxBodyBytes) });
						await jobs.remove(runId);
						return json({ ok: true, removed: runId });
					}
					return methodNotAllowed('GET, DELETE');
				}
				if (verb === 'logs') {
					if (method !== 'GET') return methodNotAllowed('GET');
					const lines = Number(url.searchParams.get('lines') ?? 200);
					if (!Number.isFinite(lines) || lines < 1 || lines > 1_000) throw new ValidationError('lines must be between 1 and 1000');
					const cursor = url.searchParams.get('cursor')?.trim() || undefined;
					if (cursor && cursor.length > 512) throw new ValidationError('cursor must be 512 characters or fewer');
					return json({ ok: true, ...(await jobs.logs(runId, { cursor, lines: Math.floor(lines) })) });
				}
				if (method !== 'POST') return methodNotAllowed('POST');
				if (url.search) throw new ValidationError('stop takes no query parameters');
				const text = await readText(request, maxBodyBytes);
				let force = false;
				if (text.trim()) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(text);
					} catch {
						throw new ValidationError('Request body must be valid JSON');
					}
					const body = assertRecord(parsed, 'request');
					for (const key of Object.keys(body)) if (key !== 'force') throw new ValidationError(`request.${key} is not allowed`);
					if (body.force !== undefined && typeof body.force !== 'boolean') throw new ValidationError('force must be a boolean');
					force = body.force === true;
				}
				await jobs.stop(runId, { force });
				return json({ ok: true, stopped: runId, force });
			}

			// --- container console (D127): inspect, read-only files and shells in project containers ---
			if (path.startsWith('/v1/containers/')) {
				const containers = options.containers;
				if (!containers) return json({ error: 'the container console is not available on this helper' }, 404);
				const parts = path.slice('/v1/containers/'.length).split('/');
				const id = containers.assertWorkload(parts[0] ?? '');
				const rest = parts.slice(1).join('/');
				if (rest === '') {
					if (method !== 'GET') return methodNotAllowed('GET');
					return json({ ok: true, container: await containers.inspect(id) });
				}
				if (rest === 'files' || rest === 'files/preview' || rest === 'files/download') {
					if (method !== 'GET') return methodNotAllowed('GET');
					const requested = url.searchParams.get('path') ?? '/';
					const files = await containers.filesystem(id);
					if (rest === 'files') return json({ ok: true, listing: files.list(requested, containers.fileLimits.listEntries) });
					if (rest === 'files/preview')
						return json({ ok: true, preview: files.preview(requested, containers.fileLimits.previewBytes) });
					const file = files.open(requested);
					// `autoClose` closes the descriptor at the end, on error and when the agent hangs up.
					const stream = Readable.toWeb(createReadStream('', { fd: file.fd, autoClose: true })) as ReadableStream<Uint8Array>;
					return new Response(stream, {
						headers: {
							'content-type': 'application/octet-stream',
							'content-length': String(file.sizeBytes),
							'x-skiff-file-name': encodeURIComponent(file.name),
							'x-skiff-file-path': encodeURIComponent(file.path),
							'cache-control': 'no-store',
						},
					});
				}
				if (rest === 'exec') {
					if (method !== 'POST') return methodNotAllowed('POST');
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					const shell = body.shell === undefined ? 'auto' : body.shell;
					if (typeof shell !== 'string' || !(CONSOLE_SHELLS as readonly string[]).includes(shell))
						throw new ValidationError(`shell must be one of ${CONSOLE_SHELLS.join(', ')}`);
					const user = body.user === undefined ? 'default' : body.user;
					if (user !== 'default' && user !== 'root') throw new ValidationError('user must be default or root');
					const opened = await containers.execOpen(id, {
						shell: shell as ConsoleShell,
						user,
						cols: terminalSize(body.cols, 'cols', 10, 500, 120),
						rows: terminalSize(body.rows, 'rows', 4, 200, 32),
					});
					return json({ ok: true, exec: opened });
				}
				const execMatch = /^exec\/([^/]+)(?:\/(stream|input|resize))?$/.exec(rest);
				if (execMatch) {
					const execId = execMatch[1]!;
					const verb = execMatch[2];
					if (!verb) {
						if (method !== 'DELETE') return methodNotAllowed('DELETE');
						await containers.execClose(id, execId);
						return json({ ok: true });
					}
					if (verb === 'stream') {
						if (method !== 'GET') return methodNotAllowed('GET');
						const after = Number(url.searchParams.get('after') ?? request.headers.get('last-event-id') ?? 0);
						const stream = containers.execStream(id, execId, Number.isFinite(after) && after > 0 ? Math.floor(after) : 0, request.signal);
						return new Response(stream, {
							headers: {
								'content-type': 'text/event-stream',
								'cache-control': 'no-store',
								'x-accel-buffering': 'no',
							},
						});
					}
					if (method !== 'POST') return methodNotAllowed('POST');
					if (verb === 'input') {
						const bytes = new Uint8Array(await request.arrayBuffer());
						containers.execInput(id, execId, bytes);
						return json({ ok: true });
					}
					const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
					containers.execResize(id, execId, terminalSize(body.cols, 'cols', 10, 500, 120), terminalSize(body.rows, 'rows', 4, 200, 32));
					return json({ ok: true });
				}
				return json({ error: 'not_found', path }, 404);
			}

			if (path === '/v1/workloads') {
				if (method !== 'POST') return methodNotAllowed('POST');
				const {
					workload,
					activation,
					function: functionFiles,
				} = parseApplyRequest(await readJson(request, maxBodyBytes));
				const status = await runtime.apply(workload, activation, functionFiles);
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

			// --- scale to zero and the runaway watchdog (FN4, FN5): fixed-unit lifecycle verbs ---
			const lifecycleMatch = /^\/v1\/workloads\/([^/]+)\/(stop|restart)$/.exec(path);
			if (lifecycleMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = decodeWorkloadId(lifecycleMatch[1]!);
				assertNoVerbInput({ search: url.search, body: await readText(request, maxBodyBytes) });
				if (lifecycleMatch[2] === 'stop') {
					await runtime.stop(id);
					return json({ ok: true, stopped: id });
				}
				await runtime.restart(id);
				return json({ ok: true, restarted: id });
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

			// --- Streaming replication (C7): fixed verbs; slots and the password are validated ---
			const replicationMatch = /^\/v1\/workloads\/([^/]+)\/replication\/(configure|status)$/.exec(path);
			if (replicationMatch && runtime.replicationConfigure && runtime.replicationStatus) {
				const id = assertDatabaseId(decodeURIComponent(replicationMatch[1]!), 'database id');
				if (replicationMatch[2] === 'status') {
					if (method !== 'GET') return methodNotAllowed('GET');
					return json({ ok: true, ...(await runtime.replicationStatus(id)) });
				}
				if (method !== 'POST') return methodNotAllowed('POST');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				for (const key of Object.keys(body))
					if (key !== 'slots' && key !== 'password') throw new ValidationError(`request.${key} is not supported`);
				return json({ ok: true, ...(await runtime.replicationConfigure(id, body)) });
			}
			const promoteMatch = /^\/v1\/workloads\/([^/]+)\/replica\/promote$/.exec(path);
			if (promoteMatch && runtime.replicaPromote) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = assertDatabaseId(decodeURIComponent(promoteMatch[1]!), 'replica id');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				for (const key of Object.keys(body))
					if (key !== 'databaseId') throw new ValidationError(`request.${key} is not supported`);
				return json({ ok: true, ...(await runtime.replicaPromote(id, body)) });
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

			// Fixed user, base64url password, engine from the helper's own env file (track G).
			const studioPrincipalMatch = /^\/v1\/workloads\/([^/]+)\/studio-principal$/.exec(path);
			if (studioPrincipalMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = assertDatabaseId(decodeURIComponent(studioPrincipalMatch[1]!), 'database id');
				const { password } = parseStudioPrincipalRequest(await readJson(request, maxBodyBytes));
				await runtime.ensureStudioPrincipal(id, password);
				return json({ ok: true, studioPrincipal: { user: STUDIO_PRINCIPAL_USER } });
			}

			const credentialMatch = /^\/v1\/workloads\/([^/]+)\/credential$/.exec(path);
			if (credentialMatch) {
				if (method !== 'POST') return methodNotAllowed('POST');
				const id = assertDatabaseId(decodeURIComponent(credentialMatch[1]!), 'database id');
				const body = assertRecord(await readJson(request, maxBodyBytes), 'request');
				const action = body.action === 'grant' || body.action === 'revoke' ? body.action : null;
				if (!action) throw new ValidationError('action must be grant or revoke');
				const role =
					body.role === 'owner' ||
					body.role === 'app' ||
					body.role === 'monitor' ||
					body.role === 'readonly' ||
					body.role === 'backup'
						? body.role
						: null;
				if (!role) throw new ValidationError('role must be owner, app, monitor, readonly or backup');
				const username = assertString(body.username, 'username', { max: 63 });
				if (action === 'grant') {
					const password = assertString(body.password, 'password', { max: 200 });
					await runtime.applyDatabaseCredential(id, action, role, username, password);
				} else {
					await runtime.applyDatabaseCredential(id, action, role, username);
				}
				return json({ ok: true, credential: { action, role } });
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
			if (error instanceof NodeUpdateError) return json({ error: error.message }, 409);
			if (error instanceof ConsoleError || error instanceof ContainerFileError)
				return json({ error: error.message }, error.status);
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
	extras: Pick<HandlerOptions, 'nodeUpdate' | 'wireguard' | 'shares' | 'disks' | 'containers' | 'appVolumes' | 'jobs' | 'pipelineJobs' | 'volumeProfiler'> = {},
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
		fetch: createHandler(runtime, { version: config.version, ...extras }),
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

function terminalSize(value: unknown, name: string, min: number, max: number, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
		throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
	return value;
}

async function readText(request: Request, maxBodyBytes: number): Promise<string> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > maxBodyBytes)
		throw new BodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`);
	const text = await request.text();
	if (Buffer.byteLength(text) > maxBodyBytes)
		throw new BodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`);
	return text;
}

async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
	const text = await readText(request, maxBodyBytes);
	if (!text.trim()) throw new ValidationError('Request body is required');
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ValidationError('Request body must be valid JSON');
	}
}

/** One workload id from a path segment: valid URL encoding and a fixed, helper-checked shape. */
function decodeWorkloadId(raw: string): string {
	try {
		return assertId(decodeURIComponent(raw), 'workload id');
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		throw new ValidationError('workload id is not valid URL encoding');
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
