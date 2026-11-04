import { promises as fs } from 'node:fs';
import type {
	DesiredState,
	ReleaseSpec,
	WorkloadActivation,
	WorkloadDesired,
	WorkloadStatus,
} from '@skiff/contracts';
import type { HelperApi, HelperWorkloadStatus } from './helper-client.ts';
import type { ReleaseManager } from './releases.ts';
import { atomicWriteFile } from './state.ts';

/**
 * Agent-side workload driver (DESIGN §3.4.1). It converges `desiredState.workloads` onto the
 * privileged helper:
 *
 * - releases are ensured with the normal release cache (one artifact feed, no second path),
 * - the node slice budget is applied once per converge,
 * - only changed workloads are re-applied (a fingerprint of the full public spec, not just the
 *   activation hash, so a memory or CPU change restarts the unit),
 * - secret values are fetched just in time and handed straight to the helper; they are never
 *   written to the agent's data dir or the desired-state cache,
 * - a failure is reported per workload and never thrown out of `converge`, so static serving and
 *   Caddy reconciliation continue.
 */

export interface WorkloadRuntimeReport {
	id: string;
	status: WorkloadStatus;
	restarts: number;
	memoryBytes?: number;
}

export type WorkloadLogLevel = 'info' | 'warn' | 'error';
export type WorkloadLog = (level: WorkloadLogLevel, message: string) => void;

export interface WorkloadRuntimeOptions {
	helper: HelperApi;
	releases: Pick<ReleaseManager, 'ensureRelease' | 'hasRelease'>;
	/** Just-in-time activation fetch; must call the node-authenticated endpoint. */
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	/** Node workload-slice memory budget, e.g. 1024 for the default 1 GiB edge slice. */
	sliceMemoryMb: number;
	/** Where socket-activated process workloads expose their socket. */
	socketDir?: string;
	healthTimeoutMs?: number;
	probeHealth?: (workload: WorkloadDesired, signal: AbortSignal) => Promise<boolean>;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: WorkloadLog;
	/** Delay before an unchanged desired state is retried after a workload failure. */
	retryDelayMs?: number;
	/** Optional non-secret diff cache (`<dataDir>/workloads-state.json`). */
	statePath?: string | null;
}

interface AppliedWorkload {
	fingerprint: string;
	activationVersion: string;
	restarts: number;
}

export const DEFAULT_WORKLOAD_SOCKET_DIR = '/run/skiff-workloads';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const HEALTH_PROBE_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export class WorkloadRuntime {
	private readonly helper: HelperApi;
	private readonly releases: WorkloadRuntimeOptions['releases'];
	private readonly fetchActivation: WorkloadRuntimeOptions['fetchActivation'];
	private readonly sliceMemoryMb: number;
	private readonly socketDir: string;
	private readonly healthTimeoutMs: number;
	private readonly probeHealth: (workload: WorkloadDesired, signal: AbortSignal) => Promise<boolean>;
	private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: WorkloadLog;
	private readonly retryDelayMs: number;
	private readonly statePath: string | null;

	private readonly applied = new Map<string, AppliedWorkload>();
	private readonly reports = new Map<string, WorkloadRuntimeReport>();
	private retryAt = 0;
	private pendingFailure = false;
	private stateLoaded = false;
	private dirty = false;

	constructor(options: WorkloadRuntimeOptions) {
		this.helper = options.helper;
		this.releases = options.releases;
		this.fetchActivation = options.fetchActivation;
		this.sliceMemoryMb = options.sliceMemoryMb;
		this.socketDir = options.socketDir ?? DEFAULT_WORKLOAD_SOCKET_DIR;
		this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
		this.probeHealth =
			options.probeHealth ??
			((workload, signal) => probeWorkloadHealth(workload, this.socketDir, signal));
		this.sleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.statePath = options.statePath ?? null;
	}

	/** True when a previous converge left work behind and the retry window has passed. */
	needsRetry(now = Date.now()): boolean {
		return this.pendingFailure && now >= this.retryAt;
	}

	/** Reports for the heartbeat, in stable id order. */
	currentReports(): WorkloadRuntimeReport[] {
		return [...this.reports.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/**
	 * Refresh from systemd just before a heartbeat. Parallel, best effort: a helper hiccup keeps
	 * the last known report rather than blanking the fleet view.
	 */
	async refreshReports(): Promise<WorkloadRuntimeReport[]> {
		await Promise.all(
			[...this.reports.keys()].map(async (id) => {
				try {
					const actual = await this.helper.status(id);
					this.reports.set(id, reportFromStatus(actual));
					// A unit that systemd reports as down gets a retry from the reconcile loop even
					// when the desired version has not changed.
					if (
						(actual.status === 'failed' || actual.status === 'stopped') &&
						!this.pendingFailure
					) {
						this.scheduleRetry();
					}
				} catch {
					// Keep the previous report; the next heartbeat retries.
				}
			}),
		);
		return this.currentReports();
	}

	/** Idempotently converge all workloads placed on this node. Never throws. */
	async converge(state: DesiredState, signal: AbortSignal = new AbortController().signal): Promise<void> {
		await this.loadState();
		try {
			await this.convergeState(state, signal);
		} finally {
			if (this.dirty) await this.persistState();
		}
	}

	private async convergeState(state: DesiredState, signal: AbortSignal): Promise<void> {
		const desired = state.workloads.filter((workload) => workload.status !== 'stopped');
		const desiredIds = new Set(desired.map((workload) => workload.id));

		// Remove workloads that left this node before touching the slice or new units.
		for (const id of [...this.applied.keys()]) {
			if (desiredIds.has(id)) continue;
			try {
				await this.helper.remove(id);
				this.applied.delete(id);
				this.reports.delete(id);
				this.dirty = true;
				this.log('info', `Removed workload ${id}`);
			} catch (error) {
				this.log('warn', `Could not remove workload ${id}: ${errorText(error)}`);
			}
		}

		if (desired.length === 0) {
			this.pendingFailure = false;
			return;
		}
		if (signal.aborted) return;

		try {
			await this.helper.ensureSlice({
				memoryMb: state.sliceMemoryMb ?? this.sliceMemoryMb,
				...(state.sliceCpuWeight ? { cpuWeight: state.sliceCpuWeight } : {}),
			});
		} catch (error) {
			// Without the slice every unit would start beside the platform services. Report each
			// workload as failed, keep static serving untouched, and retry later.
			const detail = errorText(error);
			this.log(
				'error',
				`Workload slice unavailable (${state.sliceMemoryMb ?? this.sliceMemoryMb} MiB); workloads are not running: ${detail}`,
			);
			for (const workload of desired) {
				this.reports.set(workload.id, {
					id: workload.id,
					status: 'failed',
					restarts: this.applied.get(workload.id)?.restarts ?? 0,
				});
			}
			this.scheduleRetry();
			return;
		}

		const releaseSpecs = new Map<string, ReleaseSpec>(
			state.releases.map((release) => [release.sha256, release]),
		);
		for (const workload of desired) {
			if (signal.aborted) break;
			await this.applyOne(workload, releaseSpecs, signal);
		}

		const failed = desired.some(
			(workload) => !this.applied.has(workload.id) || this.reports.get(workload.id)?.status === 'failed',
		);
		if (failed) this.scheduleRetry();
		else this.pendingFailure = false;
	}

	private async applyOne(
		workload: WorkloadDesired,
		releaseSpecs: Map<string, ReleaseSpec>,
		signal: AbortSignal,
	): Promise<void> {
		const id = workload.id;
		const previous = this.applied.get(id);
		const fingerprint = workloadFingerprint(workload);
		let restarts = previous?.restarts ?? 0;

		try {
			await this.ensureRelease(workload, releaseSpecs, signal);

			if (previous && previous.fingerprint === fingerprint && previous.activationVersion === workload.activationVersion) {
				// Unchanged: reconcile the actual status instead of restarting a healthy unit.
				const status = await this.helper.status(id);
				restarts = status.restarts;
				if (status.status === 'running') {
					const healthy = await this.probeHealth(workload, signal);
					this.reports.set(id, {
						id,
						status: healthy ? 'running' : 'starting',
						restarts: status.restarts,
						...(status.memoryBytes !== undefined ? { memoryBytes: status.memoryBytes } : {}),
					});
					return;
				}
				if (status.status === 'starting' || status.status === 'pending') {
					this.reports.set(id, reportFromStatus(status));
					return;
				}
				// Stopped or failed: fall through and apply again. A crash loop or an operator
				// `systemctl stop` must recover on the next retry without a new deployment.
			}

			// Secret values exist only in this variable and the helper's runtime dir.
			const activation = await this.fetchActivation(id, signal);
			if (activation.workloadId !== id)
				throw new Error(`activation is for workload ${activation.workloadId}, not ${id}`);
			if (activation.activationVersion !== workload.activationVersion)
				throw new Error('activation version does not match the desired workload');

			const applied = await this.helper.apply({
				workload: withOptionalSpec(workload),
				activation,
			});
			this.applied.set(id, {
				fingerprint,
				activationVersion: workload.activationVersion,
				restarts: applied.restarts,
			});
			this.dirty = true;

			if (applied.status === 'failed') {
				this.reports.set(id, reportFromStatus(applied));
				this.log('error', `Workload ${id} (${workload.projectSlug}) failed to start`);
				return;
			}

			const healthy = await this.waitForHealth(workload, signal);
			const status: WorkloadStatus = healthy ? 'running' : 'starting';
			this.reports.set(id, {
				id,
				status,
				restarts: applied.restarts,
				...(applied.memoryBytes !== undefined ? { memoryBytes: applied.memoryBytes } : {}),
			});
			if (healthy) {
				this.log('info', `Workload ${id} (${workload.projectSlug}) is running`);
			} else {
				this.log(
					'warn',
					`Workload ${id} (${workload.projectSlug}) did not answer ${workload.healthPath} yet; reporting starting`,
				);
			}
		} catch (error) {
			this.reports.set(id, {
				id,
				status: 'failed',
				restarts,
			});
			this.log('error', `Workload ${id} (${workload.projectSlug}) failed: ${errorText(error)}`);
		}
	}

	private async ensureRelease(
		workload: WorkloadDesired,
		releaseSpecs: Map<string, ReleaseSpec>,
		signal: AbortSignal,
	): Promise<void> {
		// Container workloads pull an image; only process workloads run from a release directory.
		if (workload.runtime !== 'process' || !workload.release) return;
		if (await this.releases.hasRelease(workload.release)) return;
		const spec = releaseSpecs.get(workload.release);
		if (!spec)
			throw new Error(
				`route release ${workload.release.slice(0, 12)} is missing from desired state`,
			);
		await this.releases.ensureRelease(spec, signal);
	}

	private async waitForHealth(workload: WorkloadDesired, signal: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + this.healthTimeoutMs;
		while (!signal.aborted) {
			if (await this.probeHealth(workload, signal)) return true;
			if (Date.now() >= deadline) return false;
			await this.sleep(HEALTH_PROBE_INTERVAL_MS, signal);
		}
		return false;
	}

	private scheduleRetry(): void {
		this.pendingFailure = true;
		this.retryAt = Date.now() + this.retryDelayMs;
	}

	/**
	 * The applied map is a *diff cache*, not state the control plane relies on. It contains only
	 * public spec fingerprints and activation versions — never secret values — and makes removal
	 * work after an agent restart.
	 */
	private async loadState(): Promise<void> {
		if (this.stateLoaded) return;
		this.stateLoaded = true;
		if (!this.statePath) return;
		let text: string;
		try {
			text = await fs.readFile(this.statePath, 'utf8');
		} catch (error) {
			if (isNotFound(error)) return;
			this.log('warn', `Could not read workload diff cache: ${errorText(error)}`);
			return;
		}
		try {
			const parsed = JSON.parse(text) as { applied?: unknown };
			if (!Array.isArray(parsed.applied)) return;
			for (const entry of parsed.applied) {
				if (typeof entry !== 'object' || entry === null) continue;
				const record = entry as Record<string, unknown>;
				if (typeof record.id !== 'string' || typeof record.fingerprint !== 'string') continue;
				if (typeof record.activationVersion !== 'string') continue;
				const restarts =
					typeof record.restarts === 'number' && Number.isInteger(record.restarts) && record.restarts >= 0
						? record.restarts
						: 0;
				this.applied.set(record.id, {
					fingerprint: record.fingerprint,
					activationVersion: record.activationVersion,
					restarts,
				});
			}
		} catch {
			this.log('warn', 'Ignoring an unreadable workload diff cache');
		}
	}

	private async persistState(): Promise<void> {
		if (!this.statePath) {
			this.dirty = false;
			return;
		}
		this.dirty = false;
		try {
			await atomicWriteFile(
				this.statePath,
				`${JSON.stringify({
					version: 1,
					applied: [...this.applied.entries()].map(([id, entry]) => ({ id, ...entry })),
				})}\n`,
			);
		} catch (error) {
			// A read-only data dir must not take the agent down; the next converge retries.
			this.dirty = true;
			this.log('warn', `Could not persist the workload diff cache: ${errorText(error)}`);
		}
	}
}

/** Heartbeat `workloads[]` with only the fields the protocol accepts. */
export function workloadHeartbeat(reports: WorkloadRuntimeReport[]): Array<{
	id: string;
	status: WorkloadStatus;
	restarts: number;
	memoryBytes?: number;
}> {
	return reports.map((report) => ({
		id: report.id,
		status: report.status,
		restarts: report.restarts,
		...(report.memoryBytes !== undefined ? { memoryBytes: report.memoryBytes } : {}),
	}));
}

/**
 * One health probe. Socket-activated processes are reached through their socket (Caddy does the
 * same); everything else listens on loopback.
 */
export async function probeWorkloadHealth(
	workload: WorkloadDesired,
	socketDir: string,
	signal: AbortSignal,
): Promise<boolean> {
	const socketPath =
		workload.runtime === 'process' && workload.socketActivation
			? `${socketDir}/${workload.projectId}.sock`
			: null;
	const url = socketPath
		? `http://localhost${workload.healthPath}`
		: `http://127.0.0.1:${workload.port}${workload.healthPath}`;
	try {
		const response = await fetch(url, {
			method: 'GET',
			redirect: 'manual',
			headers: { 'user-agent': 'skiff-agent-health' },
			signal: AbortSignal.any([signal, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)]),
			...(socketPath ? { unix: socketPath } : {}),
		});
		return response.status >= 200 && response.status < 400;
	} catch {
		return false;
	}
}

function reportFromStatus(status: HelperWorkloadStatus): WorkloadRuntimeReport {
	return {
		id: status.id,
		status: status.status,
		restarts: status.restarts,
		...(status.memoryBytes !== undefined ? { memoryBytes: status.memoryBytes } : {}),
	};
}

/**
 * Everything that affects the rendered unit, not just activation. `activationVersion` in the
 * contract hashes env/secrets/command/image/port, so resource or health changes must be part of
 * the agent's own diff or they would never restart the unit.
 */
export function workloadFingerprint(workload: WorkloadDesired): string {
	return JSON.stringify({
		id: workload.id,
		projectId: workload.projectId,
		runtime: workload.runtime,
		release: workload.release,
		memoryMb: workload.memoryMb,
		cpus: workload.cpus,
		port: workload.port,
		healthPath: workload.healthPath,
		socketActivation: workload.socketActivation,
		dataSizeMb: workload.dataSizeMb,
		env: Object.entries(workload.env).sort(([a], [b]) => a.localeCompare(b)),
		secrets: workload.secrets
			.map((secret) => ({ name: secret.name, delivery: secret.delivery, version: secret.version ?? null }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	});
}

/**
 * Pass optional fields through when the control plane (or a future contract) includes them.
 * Zod strips unknown keys today, so `command`/`image` are usually absent; the helper then uses its
 * `bun run start` default or rejects a container with a clear message.
 */
function withOptionalSpec(workload: WorkloadDesired): WorkloadDesired {
	const candidate = workload as WorkloadDesired & { command?: unknown; image?: unknown };
	const extras: { command?: string[]; image?: string } = {};
	if (Array.isArray(candidate.command) && candidate.command.every((arg) => typeof arg === 'string'))
		extras.command = candidate.command as string[];
	if (typeof candidate.image === 'string') extras.image = candidate.image;
	return Object.keys(extras).length === 0 ? workload : { ...workload, ...extras };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		const onAbort = (): void => finish();
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'AbortError' ? 'aborted' : error.message;
	return String(error);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	);
}
