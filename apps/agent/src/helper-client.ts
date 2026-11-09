import {
	databaseReplicationSlotStatusSchema,
	type DatabaseReplicationSlotStatus,
	appVolumeSnapshotMethods,
	type AppVolumeNodeRef,
	type AppVolumeSnapshotMethod,
	volumeInventorySchema,
	type WireguardState,
	type WireguardStatus,
	wireguardStatusSchema,
	type NodeVolumeDesired,
	type VolumeInventory,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@skiff/contracts';
import type { HelperNodeUpdateApi } from './node-update.ts';
import type { HelperMailApi } from './mail-bridge.ts';
import type { HelperShareApi } from './share-mounts.ts';
import type { HelperDiskApi } from './disk-mounts.ts';
import type { HelperVolumeProfileApi } from './volume-profiles.ts';
import type { HelperJobApi, HelperJobStatus } from './jobs.ts';

/**
 * Client for the privileged helper's fixed verbs. The agent is unprivileged (D26): this is its
 * only way to start, stop or inspect a workload. Transport is a root-only unix socket; there is no
 * TCP fallback and no command passthrough.
 */

export interface HelperWorkloadStatus {
	id: string;
	status: WorkloadStatus;
	restarts: number;
	memoryBytes?: number;
	/** Managed databases only: TLS state derived from the helper's certificate files. */
	tls?: { enabled: boolean; caPem: string | null; error: string | null };
}

export interface HelperLogEntry {
	cursor: string;
	/** Epoch milliseconds. */
	ts: number;
	/** Syslog priority: 0–3 error, 4 warning, 5–6 info, 7 debug. */
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

export interface HelperApi {
	ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void>;
	apply(input: {
		workload: WorkloadDesired;
		activation: WorkloadActivation;
		/**
		 * Functions only: the rendered workerd config, shim module and any extra binding-service
		 * modules (FN2, PLAN.md). `files` is omitted when a build needs none.
		 */
		function?: { config: string; shim: string; files?: Record<string, string> };
	}): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
	/** Stop one workload's service; its `.socket` unit keeps listening (FN4 scale to zero). */
	stop(id: string): Promise<void>;
	/** Restart a socket-activated workload's service, then its socket (FN5 watchdog). */
	restart(id: string): Promise<void>;
	/** Rotate one workload's 0400 identity token file without restarting it (IAM.md I18). */
	setIdentity?(id: string, token: string): Promise<void>;
	logs(id: string, options?: LogReadOptions): Promise<HelperLogResult>;
	/** Delete a purged database's unit and data dir (D59). Idempotent. */
	purge(id: string): Promise<void>;
	/** Stream a `pg_dump -Fc` artifact from the helper (docs/DATABASES.md §9). */
	dumpDatabase(id: string): Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number | null }>;
	/** Stream a dump into a managed database. */
	restoreDatabase(id: string, body: ReadableStream<Uint8Array> | null): Promise<void>;
	/** Apply a rotated owner/monitor password. */
	rotateDatabaseRole(id: string, role: 'owner' | 'monitor', password: string): Promise<void>;
	/** Grant or revoke a named database role (plan 04b). */
	applyDatabaseCredential(
		id: string,
		action: 'grant' | 'revoke',
		role: 'owner' | 'app' | 'monitor' | 'readonly' | 'backup',
		username: string,
		password?: string,
	): Promise<void>;
	/** Restart only the PgBouncer sidecar. */
	restartPooler(id: string): Promise<void>;
	/**
	 * Streaming replication (docs/CLUSTERING.md §9.2, C7): keep a primary's role, `pg_hba` rule and
	 * exactly `slots` (empty tears down); sample its slots; promote a replica and hand it over.
	 */
	replicationConfigure(id: string, input: { slots: string[]; password: string | null }): Promise<void>;
	replicationStatus(id: string): Promise<DatabaseReplicationSlotStatus[]>;
	replicaPromote(replicaId: string, databaseId: string): Promise<{ lsn: string | null }>;
	/** Write the 0400 pgBackRest config for PITR (docs/PITR.md). */
	pitrConfigure(
		id: string,
		repo: unknown,
	): Promise<{ stanza: string; configPath: string }>;
	/** Run a full or differential base backup. */
	pitrBaseBackup(id: string, type: string): Promise<{ stanza: string; type: string }>;
	/** Restore to a timestamp into a new database and verify it. */
	pitrRestore(
		id: string,
		input: { targetDatabaseId: string; targetTime: number },
	): Promise<{ targetDatabaseId: string; targetTime: number; verified: true }>;
	/** Credential-free repository/archive status. */
	pitrStatus(id: string): Promise<HelperPitrStatus>;
}

/** The native studio process's fixed verbs (plan 22). Kept apart from `HelperApi` so test fakes need not grow. */
export interface HelperStudioApi {
	/** `systemctl start skiff-studio.service`; no arguments. */
	studioStart(): Promise<void>;
	/** `systemctl stop skiff-studio.service`; no arguments. */
	studioStop(): Promise<void>;
}

/** The read-only studio principal verb (plan 22 track G). Apart from `HelperApi` so test fakes need not grow. */
export interface HelperStudioPrincipalApi {
	/** Create or update `skiff_studio_ro` in a managed database; the helper picks the engine. */
	ensureStudioPrincipal(id: string, user: string, password: string): Promise<void>;
}

/** App-volume data verbs (docs/VOLUMES.md). Apart from `HelperApi` so test fakes need not grow. */
export interface HelperAppVolumeApi {
	/** Allocated bytes per volume (`du -B1`); null with an error for one the helper could not read. */
	appVolumeUsage(
		volumes: AppVolumeNodeRef[],
		signal?: AbortSignal,
	): Promise<Array<{ id: string; usedBytes: number | null; error?: string }>>;
	/** Delete a trashed volume's directory. Idempotent. */
	purgeAppVolume(volume: AppVolumeNodeRef, signal?: AbortSignal): Promise<void>;
	/** Start a snapshot; the helper pauses `writers` while it copies and streams a gzip tar. */
	snapshotAppVolume(
		input: { volume: AppVolumeNodeRef; snapshotId: string; quiesce: boolean; writers: string[] },
		signal?: AbortSignal,
	): Promise<{ method: AppVolumeSnapshotMethod; body: ReadableStream<Uint8Array> }>;
	/** Stream a snapshot archive into a new, empty volume; the helper empties it again on failure. */
	restoreAppVolume(volume: AppVolumeNodeRef, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void>;
}

export interface HelperPitrStatus {
	configured: boolean;
	stanza: string;
	repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
	archiveStatus: 'ok' | 'failing' | 'unknown';
	/** The recoverable window (epoch ms) and repository state; null/0 from older helpers. */
	recoverableFrom: number | null;
	recoverableTo: number | null;
	backupCount: number;
	newestBackupAt: number | null;
	newestBackupType: 'full' | 'diff' | 'incr' | null;
	lastArchivedAt: number | null;
	repoMessage: string | null;
}

export class HelperError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HelperError';
	}
}

const HEALTH_TIMEOUT_MS = 3_000;
const SLICE_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 90_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** Stopping Postgres (TimeoutStopSec=120) plus deleting a large data dir. */
const PURGE_TIMEOUT_MS = 300_000;
/** Removing many images can take a while; the agent never waits on it during a reconcile. */
const IMAGE_PRUNE_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 2_000;
/** `systemctl stop` waits for the unit's TimeoutStopSec; a restart is the same plus a start. */
const LIFECYCLE_TIMEOUT_MS = 120_000;
const VOLUME_TIMEOUT_MS = 10_000;
/** A mount against an unreachable server waits for the kernel's own timeouts. */
const SHARE_MOUNT_TIMEOUT_MS = 90_000;
const LOG_TIMEOUT_MS = 8_000;
/** Starting or stopping the studio unit is a local systemctl call. */
const STUDIO_TIMEOUT_MS = 30_000;
/** Download plus checksum of the node bundle; the helper bounds the download at 10 minutes. */
const NODE_UPDATE_TIMEOUT_MS = 11 * 60_000;
/** Kernel WireGuard apply is a handful of local commands. */
const WIREGUARD_TIMEOUT_MS = 30_000;
/** `du` over every app volume on the node. */
const APP_VOLUME_USAGE_TIMEOUT_MS = 5 * 60_000;
const APP_VOLUME_PURGE_TIMEOUT_MS = 10 * 60_000;
/** Whole snapshot or restore stream; the helper bounds a paused copy at 15 minutes itself. */
const APP_VOLUME_STREAM_TIMEOUT_MS = 6 * 60 * 60_000;
const STATUSES: readonly WorkloadStatus[] = ['pending', 'starting', 'running', 'failed', 'stopped'];

export class HelperClient
	implements
		HelperApi,
		HelperStudioApi,
		HelperStudioPrincipalApi,
		HelperNodeUpdateApi,
		HelperMailApi,
		HelperAppVolumeApi,
		HelperShareApi,
		HelperDiskApi,
		HelperVolumeProfileApi
{
	constructor(
		readonly socketPath: string,
		private readonly timeouts: { health?: number; apply?: number } = {},
	) {}

	async health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string }> {
		const body = await this.request('GET', '/healthz', undefined, this.timeouts.health ?? HEALTH_TIMEOUT_MS, signal);
		const record = asRecord(body);
		return { ok: record.ok === true, ...(typeof record.version === 'string' ? { version: record.version } : {}) };
	}

	async ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void> {
		await this.request('POST', '/v1/slice', options, SLICE_TIMEOUT_MS);
	}

	async apply(input: {
		workload: WorkloadDesired;
		activation: WorkloadActivation;
		function?: { config: string; shim: string; files?: Record<string, string> };
	}): Promise<HelperWorkloadStatus> {
		const body = await this.request(
			'POST',
			'/v1/workloads',
			{
				workload: input.workload,
				activation: input.activation,
				// Omitted entirely for non-function workloads, so their request body is unchanged.
				...(input.function ? { function: input.function } : {}),
			},
			this.timeouts.apply ?? APPLY_TIMEOUT_MS,
		);
		return parseStatus(asRecord(body).workload);
	}

	async remove(id: string): Promise<void> {
		await this.request('DELETE', `/v1/workloads/${encodeURIComponent(id)}`, undefined, REMOVE_TIMEOUT_MS);
	}

	async purge(id: string): Promise<void> {
		await this.request('POST', `/v1/workloads/${encodeURIComponent(id)}/purge`, undefined, PURGE_TIMEOUT_MS);
	}

	async dumpDatabase(id: string): Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number | null }> {
		const response = await fetch(`http://localhost/v1/workloads/${encodeURIComponent(id)}/dump`, {
			method: 'GET',
			unix: this.socketPath,
			signal: AbortSignal.timeout(10 * 60_000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new HelperError(`helper dump ${id} -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		if (!response.body) throw new HelperError(`helper dump ${id} returned no body`);
		const length = Number(response.headers.get('content-length') ?? '');
		return { body: response.body, sizeBytes: Number.isFinite(length) ? length : null };
	}

	async restartPooler(id: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/pooler/restart`,
			undefined,
			30_000,
		);
	}

	async replicationConfigure(id: string, input: { slots: string[]; password: string | null }): Promise<void> {
		await this.request('POST', `/v1/workloads/${encodeURIComponent(id)}/replication/configure`, input, 60_000);
	}

	async replicationStatus(id: string): Promise<DatabaseReplicationSlotStatus[]> {
		const body = (await this.request(
			'GET',
			`/v1/workloads/${encodeURIComponent(id)}/replication/status`,
			undefined,
			30_000,
		)) as { slots?: unknown };
		return databaseReplicationSlotStatusSchema.array().max(32).parse(body.slots ?? []);
	}

	async replicaPromote(replicaId: string, databaseId: string): Promise<{ lsn: string | null }> {
		// pg_ctl promote waits up to 60 s, then a checkpoint and a clean stop.
		const body = (await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(replicaId)}/replica/promote`,
			{ databaseId },
			240_000,
		)) as { lsn?: unknown };
		return { lsn: typeof body.lsn === 'string' ? body.lsn : null };
	}

	async studioStart(): Promise<void> {
		await this.request('POST', '/v1/studio/start', undefined, STUDIO_TIMEOUT_MS);
	}

	async studioStop(): Promise<void> {
		await this.request('POST', '/v1/studio/stop', undefined, STUDIO_TIMEOUT_MS);
	}

	/** `systemctl start skiff-mail.service` on the mail node (docs/EMAIL.md). */
	async mailStart(): Promise<void> {
		await this.request('POST', '/v1/mail/start', undefined, STUDIO_TIMEOUT_MS);
	}

	async mailStop(): Promise<void> {
		await this.request('POST', '/v1/mail/stop', undefined, STUDIO_TIMEOUT_MS);
	}

	/** Copy the submission certificate out of Caddy's storage into skiff-mail's TLS dir. */
	async mailTls(host: string): Promise<{ found: boolean; changed: boolean }> {
		const result = (await this.request('POST', '/v1/mail/tls', { host }, STUDIO_TIMEOUT_MS)) as { found?: unknown; changed?: unknown };
		return { found: result.found === true, changed: result.changed === true };
	}

	/** `systemctl start skiff-identity.service` (and its Litestream unit) on the identity node. */
	async identityStart(): Promise<void> {
		await this.request('POST', '/v1/identity/start', undefined, STUDIO_TIMEOUT_MS);
	}

	async identityStop(): Promise<void> {
		await this.request('POST', '/v1/identity/stop', undefined, STUDIO_TIMEOUT_MS);
	}

	/**
	 * Install a signed release's agent and helper (D99). Downloads and verifies on the node, so it
	 * may take minutes on a slow link. The helper restarts both services after it answers.
	 */
	async updateNode(input: { version: string; repo: string }, signal?: AbortSignal): Promise<{ version: string }> {
		const body = asRecord(await this.request('POST', '/v1/node/update', input, NODE_UPDATE_TIMEOUT_MS, signal));
		if (typeof body.version !== 'string') throw new HelperError('helper node update returned no version');
		return { version: body.version };
	}

	/** Generate or read the node's WireGuard key pair; only the public key returns (C1). */
	async wireguardKeygen(): Promise<{ publicKey: string }> {
		const body = asRecord(await this.request('POST', '/v1/wireguard/keygen', undefined, WIREGUARD_TIMEOUT_MS));
		if (typeof body.publicKey !== 'string') throw new HelperError('helper keygen returned no public key');
		return { publicKey: body.publicKey };
	}

	/** Apply the control plane's overlay state to the kernel interface (C1). */
	async wireguardApply(state: WireguardState): Promise<{ peers: number }> {
		const body = asRecord(
			await this.request('POST', '/v1/wireguard/apply', { state }, WIREGUARD_TIMEOUT_MS),
		);
		return { peers: typeof body.peers === 'number' ? body.peers : 0 };
	}

	/** Latest handshakes and counters, for the node's heartbeat and dashboard (C1). */
	async wireguardStatus(): Promise<WireguardStatus> {
		const body = await this.request('GET', '/v1/wireguard/status', undefined, WIREGUARD_TIMEOUT_MS);
		return wireguardStatusSchema.parse(body);
	}

	async ensureStudioPrincipal(id: string, user: string, password: string): Promise<void> {
		// Two podman execs (apply, then a login check), each bounded by the helper.
		await this.request('POST', `/v1/workloads/${encodeURIComponent(id)}/studio-principal`, { user, password }, 150_000);
	}

	async rotateDatabaseRole(id: string, role: 'owner' | 'monitor', password: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/rotate`,
			{ role, password },
			60_000,
		);
	}

	async applyDatabaseCredential(
		id: string,
		action: 'grant' | 'revoke',
		role: 'owner' | 'app' | 'monitor' | 'readonly' | 'backup',
		username: string,
		password?: string,
	): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/credential`,
			{ action, role, username, ...(password ? { password } : {}) },
			60_000,
		);
	}

	async restoreDatabase(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
		const response = await fetch(`http://localhost/v1/workloads/${encodeURIComponent(id)}/restore`, {
			method: 'POST',
			unix: this.socketPath,
			signal: AbortSignal.timeout(30 * 60_000),
			headers: { 'content-type': 'application/octet-stream' },
			body: body as never,
			duplex: 'half',
		} as RequestInit & { duplex: 'half' });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new HelperError(`helper restore ${id} -> ${response.status}${text ? `: ${text}` : ''}`);
		}
	}

	async pitrConfigure(id: string, repo: unknown): Promise<{ stanza: string; configPath: string }> {
		const body = await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/pitr/configure`,
			{ repo },
			60_000,
		);
		const record = asRecord(body);
		return {
			stanza: String(record.stanza ?? ''),
			configPath: String(record.configPath ?? ''),
		};
	}

	async pitrBaseBackup(id: string, type: string): Promise<{ stanza: string; type: string }> {
		const body = await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/pitr/basebackup`,
			{ type },
			60 * 60_000,
		);
		const record = asRecord(body);
		return { stanza: String(record.stanza ?? ''), type: String(record.type ?? '') };
	}

	async pitrRestore(
		id: string,
		input: { targetDatabaseId: string; targetTime: number },
	): Promise<{ targetDatabaseId: string; targetTime: number; verified: true }> {
		const body = await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/pitr/restore`,
			input,
			2 * 60 * 60_000,
		);
		const record = asRecord(body);
		if (record.verified !== true) throw new HelperError('helper PITR restore did not verify');
		return {
			targetDatabaseId: String(record.targetDatabaseId ?? ''),
			targetTime: Number(record.targetTime),
			verified: true,
		};
	}

	async pitrStatus(id: string): Promise<HelperPitrStatus> {
		const body = await this.request(
			'GET',
			`/v1/workloads/${encodeURIComponent(id)}/pitr/status`,
			undefined,
			// `pgbackrest info` lists the repository over S3.
			120_000,
		);
		const record = asRecord(body);
		const repo = asRecord(record.repo);
		return {
			configured: record.configured === true,
			stanza: String(record.stanza ?? ''),
			repo: {
				bucket: typeof repo.bucket === 'string' ? repo.bucket : null,
				region: typeof repo.region === 'string' ? repo.region : null,
				endpoint: typeof repo.endpoint === 'string' ? repo.endpoint : null,
				path: typeof repo.path === 'string' ? repo.path : null,
			},
			archiveStatus:
				record.archiveStatus === 'ok' || record.archiveStatus === 'failing'
					? record.archiveStatus
					: 'unknown',
			recoverableFrom: epochOrNull(record.recoverableFrom),
			recoverableTo: epochOrNull(record.recoverableTo),
			backupCount: typeof record.backupCount === 'number' && record.backupCount >= 0 ? Math.floor(record.backupCount) : 0,
			newestBackupAt: epochOrNull(record.newestBackupAt),
			newestBackupType:
				record.newestBackupType === 'full' || record.newestBackupType === 'diff' || record.newestBackupType === 'incr'
					? record.newestBackupType
					: null,
			lastArchivedAt: epochOrNull(record.lastArchivedAt),
			repoMessage: typeof record.repoMessage === 'string' ? record.repoMessage.slice(0, 500) : null,
		};
	}

	/** Read-only mount/device inventory for the volume wizard (D72). */
	async volumes(signal?: AbortSignal): Promise<VolumeInventory> {
		const body = await this.request('GET', '/v1/volumes', undefined, VOLUME_TIMEOUT_MS, signal);
		return volumeInventorySchema.parse(asRecord(body).inventory);
	}

	/** Which shares are mounted at `/mnt/skiff-shares/<id>` (docs/STORAGE.md §3). No credentials. */
	async shareStatus(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; mounted: boolean }>> {
		const body = asRecord(await this.request('POST', '/v1/shares/status', { ids }, VOLUME_TIMEOUT_MS, signal));
		const shares = Array.isArray(body.shares) ? body.shares : [];
		return shares.map((item) => {
			const record = asRecord(item);
			return { id: String(record.id), mounted: record.mounted === true };
		});
	}

	/** Mount one share. SMB credentials pass through to the helper for this call only. */
	async mountShare(
		share: Parameters<HelperShareApi['mountShare']>[0],
		signal?: AbortSignal,
	): Promise<{ id: string; mounted: boolean; error: string | null }> {
		const body = asRecord(await this.request('POST', '/v1/shares/mount', { share }, SHARE_MOUNT_TIMEOUT_MS, signal));
		const record = asRecord(body.share);
		return {
			id: String(record.id),
			mounted: record.mounted === true,
			error: typeof record.error === 'string' ? record.error : null,
		};
	}

	/** Unmount one share; a busy mount is reported as still mounted, never forced. */
	async unmountShare(id: string, signal?: AbortSignal): Promise<{ id: string; mounted: boolean; error: string | null }> {
		const body = asRecord(await this.request('POST', '/v1/shares/unmount', { id }, SHARE_MOUNT_TIMEOUT_MS, signal));
		return {
			id: String(body.id ?? id),
			mounted: body.mounted === true,
			error: typeof body.error === 'string' ? body.error : null,
		};
	}

	/** Which of the disks Skiff mounts are up at `/mnt/skiff-disks/<id>` (docs/STORAGE.md §3.1). */
	async diskStatus(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; mounted: boolean }>> {
		const body = asRecord(await this.request('POST', '/v1/disks/status', { ids }, VOLUME_TIMEOUT_MS, signal));
		const disks = Array.isArray(body.disks) ? body.disks : [];
		return disks.map((item) => {
			const record = asRecord(item);
			return { id: String(record.id), mounted: record.mounted === true };
		});
	}

	/** Mount one partition by filesystem UUID; the helper re-checks it is free first. */
	async mountDisk(
		disk: Parameters<HelperDiskApi['mountDisk']>[0],
		signal?: AbortSignal,
	): Promise<{ id: string; mounted: boolean; error: string | null }> {
		const body = asRecord(await this.request('POST', '/v1/disks/mount', { disk }, SHARE_MOUNT_TIMEOUT_MS, signal));
		const record = asRecord(body.disk);
		return {
			id: String(record.id),
			mounted: record.mounted === true,
			error: typeof record.error === 'string' ? record.error : null,
		};
	}

	/** Unmount one partition; a busy mount is reported as still mounted, never forced. */
	async unmountDisk(id: string, signal?: AbortSignal): Promise<{ id: string; mounted: boolean; error: string | null }> {
		const body = asRecord(await this.request('POST', '/v1/disks/unmount', { id }, SHARE_MOUNT_TIMEOUT_MS, signal));
		return {
			id: String(body.id ?? id),
			mounted: body.mounted === true,
			error: typeof body.error === 'string' ? body.error : null,
		};
	}

	/** Benchmark one disk (docs/STORAGE.md §5.1); the helper resolves the path. */
	async profileVolume(
		input: { volumeId: string; sizeMb: number; runtimeSeconds: number },
		signal?: AbortSignal,
	): Promise<Awaited<ReturnType<HelperVolumeProfileApi['profileVolume']>>> {
		// Five fio jobs of `runtimeSeconds` each, plus laying out the scratch file.
		const timeoutMs = Math.min(15 * 60_000, (input.runtimeSeconds + 2) * 5 * 1000 + 5 * 60_000);
		const body = asRecord(await this.request('POST', '/v1/volumes/profile', input, timeoutMs, signal));
		if (body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : 'volume profile failed');
		const profile = asRecord(body.profile);
		const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
		return {
			method: profile.method === 'fio' || profile.method === 'dd' ? profile.method : null,
			seqReadMBps: num(profile.seqReadMBps),
			seqWriteMBps: num(profile.seqWriteMBps),
			randReadIops: num(profile.randReadIops),
			randWriteIops: num(profile.randWriteIops),
			syncWriteIops: num(profile.syncWriteIops),
			syncWriteLatencyUs: num(profile.syncWriteLatencyUs),
			direct: typeof profile.direct === 'boolean' ? profile.direct : null,
			notes: Array.isArray(profile.notes) ? profile.notes.filter((note): note is string => typeof note === 'string').map((note) => note.slice(0, 300)).slice(0, 10) : [],
		};
	}

	/** Replace the helper's disk registry (`volumes`) from desired state (D76). */
	async syncVolumes(volumes: NodeVolumeDesired[], signal?: AbortSignal): Promise<void> {
		await this.request('POST', '/v1/volumes/registry', { volumes }, VOLUME_TIMEOUT_MS, signal);
	}

	/** Prove a registered volume is mounted before a workload references it (D76). */
	async verifyVolume(
		mountPath: string,
		sourceKey: string,
		signal?: AbortSignal,
	): Promise<{ ok: boolean; message: string | null }> {
		const body = await this.request(
			'POST',
			'/v1/volumes/verify',
			{ mountPath, sourceKey },
			VOLUME_TIMEOUT_MS,
			signal,
		);
		const record = asRecord(body);
		return {
			ok: record.ok === true,
			message: typeof record.message === 'string' ? record.message : null,
		};
	}

	async appVolumeUsage(
		volumes: AppVolumeNodeRef[],
		signal?: AbortSignal,
	): Promise<Array<{ id: string; usedBytes: number | null; error?: string }>> {
		const body = await this.request('POST', '/v1/app-volumes/usage', { volumes }, APP_VOLUME_USAGE_TIMEOUT_MS, signal);
		const usage = asRecord(body).usage;
		if (!Array.isArray(usage)) throw new HelperError('helper app-volume usage is not a list');
		return usage.map((item) => {
			const record = asRecord(item);
			if (typeof record.id !== 'string') throw new HelperError('helper app-volume usage entry has no id');
			const used = record.usedBytes;
			return {
				id: record.id,
				usedBytes: typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 ? used : null,
				...(typeof record.error === 'string' ? { error: record.error } : {}),
			};
		});
	}

	async purgeAppVolume(volume: AppVolumeNodeRef, signal?: AbortSignal): Promise<void> {
		await this.request('POST', '/v1/app-volumes/purge', { volume }, APP_VOLUME_PURGE_TIMEOUT_MS, signal);
	}

	async snapshotAppVolume(
		input: { volume: AppVolumeNodeRef; snapshotId: string; quiesce: boolean; writers: string[] },
		signal?: AbortSignal,
	): Promise<{ method: AppVolumeSnapshotMethod; body: ReadableStream<Uint8Array> }> {
		const timeout = AbortSignal.timeout(APP_VOLUME_STREAM_TIMEOUT_MS);
		const response = await fetch('http://localhost/v1/app-volumes/snapshot', {
			method: 'POST',
			unix: this.socketPath,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new HelperError(`helper snapshot ${input.volume.id} -> ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
		}
		if (!response.body) throw new HelperError(`helper snapshot ${input.volume.id} returned no body`);
		const method = response.headers.get('x-skiff-snapshot-method');
		if (!method || !(appVolumeSnapshotMethods as readonly string[]).includes(method)) {
			await response.body.cancel().catch(() => undefined);
			throw new HelperError(`helper snapshot ${input.volume.id} did not say how it copied (${method ?? 'no header'})`);
		}
		return { method: method as AppVolumeSnapshotMethod, body: response.body };
	}

	async restoreAppVolume(volume: AppVolumeNodeRef, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
		const query = new URLSearchParams({ id: volume.id, projectId: volume.projectId, backing: volume.backing });
		if (volume.nodeVolumeId) query.set('nodeVolumeId', volume.nodeVolumeId);
		const timeout = AbortSignal.timeout(APP_VOLUME_STREAM_TIMEOUT_MS);
		const response = await fetch(`http://localhost/v1/app-volumes/restore?${query}`, {
			method: 'POST',
			unix: this.socketPath,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { 'content-type': 'application/gzip' },
			body: body as never,
			duplex: 'half',
		} as RequestInit & { duplex: 'half' });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new HelperError(`helper restore ${volume.id} -> ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
		}
	}

	/** Point Podman's mirrors at the platform registry, or remove them with no upstreams (G4). */
	async applyRegistryMirror(request: { host: string; upstreams: string[]; username: string; password: string }): Promise<void> {
		await this.request('POST', '/v1/registry/mirror', request, SLICE_TIMEOUT_MS);
	}

	/** Remove images no unit or container needs (docs/REGISTRY.md R3). Local images are kept. */
	async pruneImages(): Promise<{ removed: number; kept: number; reclaimedBytes: number; failed: number }> {
		const body = asRecord(await this.request('POST', '/v1/images/prune', {}, IMAGE_PRUNE_TIMEOUT_MS));
		const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
		const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
		return {
			removed: count(body.removed),
			kept: number(body.kept),
			reclaimedBytes: number(body.reclaimedBytes),
			failed: count(body.failed),
		};
	}

	async status(id: string): Promise<HelperWorkloadStatus> {
		const body = await this.request(
			'GET',
			`/v1/workloads/${encodeURIComponent(id)}`,
			undefined,
			STATUS_TIMEOUT_MS,
		);
		return parseStatus(asRecord(body).workload);
	}

	async logs(id: string, options: LogReadOptions = {}): Promise<HelperLogResult> {
		const params = new URLSearchParams({ lines: String(options.lines ?? 200) });
		if (options.cursor) params.set('cursor', options.cursor);
		const body = await this.request(
			'GET',
			`/v1/workloads/${encodeURIComponent(id)}/logs?${params.toString()}`,
			undefined,
			LOG_TIMEOUT_MS,
		);
		const record = asRecord(body);
		const entries = Array.isArray(record.entries) ? record.entries : [];
		return {
			entries: entries.map((value) => parseLogEntry(value)),
			nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
		};
	}

	/**
	 * Stop a workload's service. Its socket unit keeps listening, so the next connection starts the
	 * host again through socket activation (FN4 scale to zero). Idempotent on the helper side.
	 */
	async stop(id: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/stop`,
			undefined,
			LIFECYCLE_TIMEOUT_MS,
		);
	}

	/** Restart the service and then its socket, used by the runaway watchdog (FN5). */
	async restart(id: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/restart`,
			undefined,
			LIFECYCLE_TIMEOUT_MS,
		);
	}

	async setIdentity(id: string, token: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/identity`,
			{ token },
			LIFECYCLE_TIMEOUT_MS,
		);
	}

	// --- job runs (plan 09): one transient unit per run --------------------------------------

	async startJob(input: Parameters<HelperJobApi['startJob']>[0]): Promise<HelperJobStatus> {
		const body = await this.request('POST', '/v1/jobs', input, this.timeouts.apply ?? APPLY_TIMEOUT_MS);
		return parseJobStatus(asRecord(body).job);
	}

	async jobStatus(runId: string, timeoutSeconds?: number): Promise<HelperJobStatus> {
		const query = timeoutSeconds === undefined ? '' : `?timeout=${timeoutSeconds}`;
		const body = await this.request('GET', `/v1/jobs/${encodeURIComponent(runId)}${query}`, undefined, LOG_TIMEOUT_MS);
		return parseJobStatus(asRecord(body).job);
	}

	async jobLogs(runId: string, options: LogReadOptions = {}): Promise<HelperLogResult> {
		const params = new URLSearchParams({ lines: String(options.lines ?? 200) });
		if (options.cursor) params.set('cursor', options.cursor);
		const body = await this.request('GET', `/v1/jobs/${encodeURIComponent(runId)}/logs?${params.toString()}`, undefined, LOG_TIMEOUT_MS);
		const record = asRecord(body);
		const entries = Array.isArray(record.entries) ? record.entries : [];
		return {
			entries: entries.map((value) => parseLogEntry(value)),
			nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
		};
	}

	async stopJob(runId: string, force = false): Promise<void> {
		await this.request('POST', `/v1/jobs/${encodeURIComponent(runId)}/stop`, force ? { force: true } : undefined, LIFECYCLE_TIMEOUT_MS);
	}

	async removeJob(runId: string): Promise<void> {
		await this.request('DELETE', `/v1/jobs/${encodeURIComponent(runId)}`, undefined, LIFECYCLE_TIMEOUT_MS);
	}

	/**
	 * One container-console call (D127), passed through untouched so streams (shell output, file
	 * downloads) are never buffered here. Only `/v1/containers/…` paths; the caller sets timeouts.
	 */
	async containerConsole(
		path: string,
		init: { method?: string; body?: string | Uint8Array | ReadableStream<Uint8Array> | null; contentType?: string; lastEventId?: string; signal?: AbortSignal } = {},
	): Promise<Response> {
		if (!path.startsWith('/v1/containers/')) throw new HelperError('not a container console path');
		try {
			return await fetch(`http://localhost${path}`, {
				method: init.method ?? 'GET',
				unix: this.socketPath,
				...(init.signal ? { signal: init.signal } : {}),
				headers: {
					...(init.contentType ? { 'content-type': init.contentType } : {}),
					...(init.lastEventId ? { 'last-event-id': init.lastEventId } : {}),
				},
				...(init.body === undefined ? {} : { body: init.body }),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new HelperError(`helper unavailable on ${this.socketPath}: ${detail}`);
		}
	}

	private async request(
		method: string,
		path: string,
		body: unknown,
		timeoutMs: number,
		outerSignal?: AbortSignal,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(`http://localhost${path}`, {
				method,
				unix: this.socketPath,
				signal,
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new HelperError(`helper unavailable on ${this.socketPath}: ${detail}`);
		}

		const text = await response.text().catch(() => '');
		let payload: unknown = null;
		if (text) {
			try {
				payload = JSON.parse(text) as unknown;
			} catch {
				payload = null;
			}
		}
		if (!response.ok) {
			const message =
				payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
					? String((payload as { error: string }).error)
					: text.slice(0, 500);
			throw new HelperError(`helper ${method} ${path} -> ${response.status}${message ? `: ${message}` : ''}`);
		}
		return payload;
	}
}

const JOB_OUTCOMES: readonly HelperJobStatus['outcome'][] = ['running', 'succeeded', 'failed', 'timeout', 'killed', 'not-found'];

function parseJobStatus(value: unknown): HelperJobStatus {
	const record = asRecord(value);
	if (typeof record.runId !== 'string') throw new HelperError('helper job status is missing runId');
	if (typeof record.outcome !== 'string' || !JOB_OUTCOMES.includes(record.outcome as HelperJobStatus['outcome']))
		throw new HelperError(`helper job status is invalid: ${String(record.outcome)}`);
	const int = (field: unknown) => (typeof field === 'number' && Number.isInteger(field) ? field : null);
	return {
		runId: record.runId,
		outcome: record.outcome as HelperJobStatus['outcome'],
		exitCode: int(record.exitCode),
		signal: int(record.signal),
		startedAt: int(record.startedAt),
		finishedAt: int(record.finishedAt),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new HelperError('helper returned an invalid JSON body');
	return value as Record<string, unknown>;
}

function parseLogEntry(value: unknown): HelperLogEntry {
	const record = asRecord(value);
	if (typeof record.cursor !== 'string' || typeof record.message !== 'string')
		throw new HelperError('helper log entry is missing cursor or message');
	const ts = Number(record.ts);
	if (!Number.isFinite(ts) || ts < 0) throw new HelperError('helper log entry has an invalid timestamp');
	const priority = Number(record.priority ?? 6);
	return {
		cursor: record.cursor,
		ts: Math.floor(ts),
		priority: Number.isInteger(priority) ? Math.max(0, Math.min(priority, 7)) : 6,
		message: record.message.slice(0, 16_384),
	};
}

function parseStatus(value: unknown): HelperWorkloadStatus {
	const record = asRecord(value);
	if (typeof record.id !== 'string') throw new HelperError('helper status is missing id');
	if (typeof record.status !== 'string' || !STATUSES.includes(record.status as WorkloadStatus))
		throw new HelperError(`helper status is invalid: ${String(record.status)}`);
	if (typeof record.restarts !== 'number' || !Number.isInteger(record.restarts) || record.restarts < 0)
		throw new HelperError('helper status has invalid restarts');
	const status: HelperWorkloadStatus = {
		id: record.id,
		status: record.status as WorkloadStatus,
		restarts: record.restarts,
	};
	if (typeof record.memoryBytes === 'number' && Number.isFinite(record.memoryBytes) && record.memoryBytes >= 0)
		status.memoryBytes = record.memoryBytes;
	const tls = asOptionalRecord(record.tls);
	if (tls && typeof tls.enabled === 'boolean') {
		status.tls = {
			enabled: tls.enabled,
			caPem: typeof tls.caPem === 'string' ? tls.caPem : null,
			error: typeof tls.error === 'string' ? tls.error : null,
		};
	}
	return status;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A positive integer epoch-ms value from the helper, or null. */
function epochOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
