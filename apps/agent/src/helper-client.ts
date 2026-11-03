import type {
	WorkloadActivation,
	WorkloadDesired,
	WorkloadStatus,
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

export interface HelperApi {
	ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void>;
	apply(input: {
		workload: WorkloadDesired;
		activation: WorkloadActivation;
	}): Promise<HelperWorkloadStatus>;
	remove(id: string): Promise<void>;
	status(id: string): Promise<HelperWorkloadStatus>;
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
const STATUS_TIMEOUT_MS = 2_000;
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

	async status(id: string): Promise<HelperWorkloadStatus> {
		const body = await this.request(
			'GET',
			`/v1/workloads/${encodeURIComponent(id)}`,
			undefined,
			STATUS_TIMEOUT_MS,
		);
		return parseStatus(asRecord(body).workload);
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
