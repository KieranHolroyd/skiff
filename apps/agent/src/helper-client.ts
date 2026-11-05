import {
	volumeInventorySchema,
	type NodeVolumeDesired,
	type VolumeInventory,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@skiff/contracts';

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
	}): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
	logs(id: string, options?: LogReadOptions): Promise<HelperLogResult>;
	/** Delete a purged database's unit and data dir (D59). Idempotent. */
	purge(id: string): Promise<void>;
	/** Stream a `pg_dump -Fc` artifact from the helper (docs/DATABASES.md §9). */
	dumpDatabase(id: string): Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number | null }>;
	/** Stream a dump into a managed database. */
	restoreDatabase(id: string, body: ReadableStream<Uint8Array> | null): Promise<void>;
	/** Apply a rotated owner/monitor password. */
	rotateDatabaseRole(id: string, role: 'owner' | 'monitor', password: string): Promise<void>;
	/** Restart only the PgBouncer sidecar. */
	restartPooler(id: string): Promise<void>;
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

export interface HelperPitrStatus {
	configured: boolean;
	stanza: string;
	repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
	archiveStatus: 'ok' | 'failing' | 'unknown';
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
const STATUS_TIMEOUT_MS = 2_000;
const VOLUME_TIMEOUT_MS = 10_000;
const LOG_TIMEOUT_MS = 8_000;
const STATUSES: readonly WorkloadStatus[] = ['pending', 'starting', 'running', 'failed', 'stopped'];

export class HelperClient implements HelperApi {
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
	}): Promise<HelperWorkloadStatus> {
		const body = await this.request(
			'POST',
			'/v1/workloads',
			{ workload: input.workload, activation: input.activation },
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

	async rotateDatabaseRole(id: string, role: 'owner' | 'monitor', password: string): Promise<void> {
		await this.request(
			'POST',
			`/v1/workloads/${encodeURIComponent(id)}/rotate`,
			{ role, password },
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
			30_000,
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
		};
	}

	/** Read-only mount/device inventory for the volume wizard (D72). */
	async volumes(signal?: AbortSignal): Promise<VolumeInventory> {
		const body = await this.request('GET', '/v1/volumes', undefined, VOLUME_TIMEOUT_MS, signal);
		return volumeInventorySchema.parse(asRecord(body).inventory);
	}

	/** Replace the helper's volume registry from desired state (D74). */
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
	return status;
}
