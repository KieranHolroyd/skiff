import { promises as fs } from 'node:fs';
import type {
	DatabaseMonitor,
	DesiredState,
	ReleaseSpec,
	StorageAdmin,
	WorkloadActivation,
	WorkloadDesired,
	WorkloadStatus,
} from '@skiff/contracts';
import type { DatabaseTarget, DatabaseTargetSource } from './database-stats.ts';
import type { StorageTarget, StorageTargetSource } from './storage-admin.ts';
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
 *
 * Managed databases (D55–D59) are container workloads with a `database` profile. They are probed
 * over TCP instead of HTTP, their activation's `monitor` credentials are kept in memory for the
 * stats sampler (never sent to the helper, never written to disk), and `databasePurges` are
 * handed to the helper's `purge` verb and reported back on the next heartbeat.
 *
 * Storage instances (S1–S8) are container workloads with an `objectStorage` profile and follow the
 * same pattern: HTTP `/health` probe, `storageAdmin` (root and scoped keys) held in memory for the
 * bucket/key reconciler, `storagePurges` through the same helper verb. Bucket and key changes move
 * `objectStorage.keysVersion`, not `activationVersion`: the agent re-fetches activation for the new
 * secrets but never re-applies (restarts) the container for them.
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

/** Sampler credentials for one database. `ownerPassword` is dropped once the monitor role exists. */
interface HeldMonitor {
	activationVersion: string;
	monitor: Omit<DatabaseMonitor, 'ownerPassword'> & { ownerPassword: string | null };
	/** Allowlisted extensions to create on first start. */
	extensions: string[];
}

/** Root and scoped keys for one storage instance (memory only). */
interface HeldStorageAdmin {
	activationVersion: string;
	admin: StorageAdmin;
}

/** RustFS answers 200 here once the S3 API is up (verified on 1.0.4). */
export const STORAGE_HEALTH_PATH = '/health';

export const DEFAULT_WORKLOAD_SOCKET_DIR = '/run/skiff-workloads';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const HEALTH_PROBE_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export class WorkloadRuntime implements DatabaseTargetSource, StorageTargetSource {
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
	/** Memory only (D57): database monitor credentials from the last activation fetch. */
	private readonly monitors = new Map<string, HeldMonitor>();
	/** Desired database workloads from the last converge. */
	private databases = new Map<string, WorkloadDesired>();
	/** Purged database ids not yet acknowledged by a heartbeat. */
	private readonly purgedPending = new Set<string>();
	/** Memory only (S6): storage root and scoped keys from the last activation fetch. */
	private readonly storageAdmins = new Map<string, HeldStorageAdmin>();
	/** Desired storage workloads from the last converge. */
	private storages = new Map<string, WorkloadDesired>();
	/** Purged storage ids not yet acknowledged by a heartbeat. */
	private readonly purgedStoragePending = new Set<string>();
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

	/** Running-or-not database workloads the sampler may connect to (credentials in memory only). */
	databaseTargets(): DatabaseTarget[] {
		const targets: DatabaseTarget[] = [];
		for (const [id, workload] of this.databases) {
			const held = this.monitors.get(id);
			if (!held || held.activationVersion !== workload.activationVersion) continue;
			const report = this.reports.get(id);
			targets.push({
				id,
				activationVersion: workload.activationVersion,
				// The port the helper published, which the activation's `monitor.port` mirrors.
				port: workload.port,
				status: report?.status ?? 'pending',
				...(report?.memoryBytes !== undefined ? { memoryBytes: report.memoryBytes } : {}),
				monitor: { ...held.monitor },
				extensions: [...held.extensions],
			});
		}
		return targets.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Storage instances the reconciler and sampler may talk to (keys in memory only). */
	storageTargets(): StorageTarget[] {
		const targets: StorageTarget[] = [];
		for (const [id, workload] of this.storages) {
			const held = this.storageAdmins.get(id);
			if (!held || held.activationVersion !== workload.activationVersion || !workload.objectStorage) continue;
			const report = this.reports.get(id);
			targets.push({
				id,
				activationVersion: workload.activationVersion,
				// The port the helper published; the activation's `storageAdmin.port` mirrors it.
				port: workload.port,
				status: report?.status ?? 'pending',
				...(report?.memoryBytes !== undefined ? { memoryBytes: report.memoryBytes } : {}),
				admin: { ...held.admin, users: { ...held.admin.users } },
				desired: workload.objectStorage,
			});
		}
		return targets.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Purged storage ids for the next heartbeat's `purgedStorage`. */
	pendingPurgedStorage(): string[] {
		return [...this.purgedStoragePending].sort();
	}

	/** Call only after the control plane accepted a heartbeat that carried these ids. */
	acknowledgePurgedStorage(ids: readonly string[]): void {
		for (const id of ids) this.purgedStoragePending.delete(id);
	}

	/** The sampler created the monitor role; the owner password is no longer needed (D57). */
	forgetOwnerPassword(id: string, activationVersion: string): void {
		const held = this.monitors.get(id);
		if (held && held.activationVersion === activationVersion) held.monitor.ownerPassword = null;
	}

	/** Purged database ids for the next heartbeat's `purgedDatabases`. */
	pendingPurgedDatabases(): string[] {
		return [...this.purgedPending].sort();
	}

	/** Call only after the control plane accepted a heartbeat that carried these ids. */
	acknowledgePurgedDatabases(ids: readonly string[]): void {
		for (const id of ids) this.purgedPending.delete(id);
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
		// Anything listed at all, stopped included, is never purged.
		const listedIds = new Set(state.workloads.map((workload) => workload.id));
		this.databases = new Map(
			desired.filter((workload) => workload.database).map((workload) => [workload.id, workload]),
		);
		for (const id of [...this.monitors.keys()]) {
			if (!this.databases.has(id)) this.monitors.delete(id);
		}
		this.storages = new Map(
			desired.filter((workload) => workload.objectStorage).map((workload) => [workload.id, workload]),
		);
		for (const id of [...this.storageAdmins.keys()]) {
			if (!this.storages.has(id)) this.storageAdmins.delete(id);
		}

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

		const databasePurgeFailed = await this.purgeManaged('database', state.databasePurges ?? [], listedIds, signal);
		const storagePurgeFailed = await this.purgeManaged('storage', state.storagePurges ?? [], listedIds, signal);
		const purgeFailed = databasePurgeFailed || storagePurgeFailed;

		if (desired.length === 0) {
			if (purgeFailed) this.scheduleRetry();
			else this.pendingFailure = false;
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
		if (failed || purgeFailed) this.scheduleRetry();
		else this.pendingFailure = false;
	}

	/**
	 * Hand `databasePurges` / `storagePurges` to the helper (D59, S8). An id that is still listed as
	 * a workload is never purged, whatever the purge list says; an id already purged and awaiting
	 * its heartbeat is not purged twice. Returns true when a purge failed and needs a retry.
	 */
	private async purgeManaged(
		kind: 'database' | 'storage',
		ids: readonly string[],
		listedIds: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<boolean> {
		const pending = kind === 'database' ? this.purgedPending : this.purgedStoragePending;
		let failed = false;
		for (const id of new Set(ids)) {
			if (signal.aborted) return true;
			if (pending.has(id)) continue;
			if (listedIds.has(id)) {
				this.log('warn', `Not purging ${kind} ${id}: it is still a desired workload`);
				continue;
			}
			try {
				await this.helper.purge(id);
				pending.add(id);
				if (this.applied.delete(id)) this.dirty = true;
				this.reports.delete(id);
				this.monitors.delete(id);
				this.storageAdmins.delete(id);
				this.log('info', `Purged ${kind} ${id}`);
			} catch (error) {
				failed = true;
				this.log('error', `Could not purge ${kind} ${id}: ${errorText(error)}`);
			}
		}
		return failed;
	}

	/** Keep a storage instance's keys in memory; they never reach the helper or the disk. */
	private holdStorageAdmin(workload: WorkloadDesired, admin: StorageAdmin | undefined): void {
		if (!workload.objectStorage || !admin) {
			this.storageAdmins.delete(workload.id);
			return;
		}
		this.storageAdmins.set(workload.id, {
			activationVersion: workload.activationVersion,
			admin: { ...admin, users: { ...admin.users } },
		});
	}

	/**
	 * Fetch a storage instance's keys without re-applying it: after an agent restart (the diff cache
	 * says unchanged) and whenever `objectStorage.keysVersion` moved (an attach, detach or rotation).
	 */
	private async recoverStorageAdmin(workload: WorkloadDesired, signal: AbortSignal): Promise<void> {
		const held = this.storageAdmins.get(workload.id);
		if (
			held &&
			held.activationVersion === workload.activationVersion &&
			held.admin.keysVersion === workload.objectStorage?.keysVersion
		)
			return;
		try {
			const activation = await this.fetchActivation(workload.id, signal);
			if (activation.workloadId !== workload.id || activation.activationVersion !== workload.activationVersion)
				return;
			if (!activation.storageAdmin) {
				this.log('warn', `Storage ${workload.id}: activation carried no storageAdmin`);
				return;
			}
			this.holdStorageAdmin(workload, activation.storageAdmin);
		} catch (error) {
			this.log('warn', `Could not fetch keys for storage ${workload.id}: ${errorText(error)}`);
		}
	}

	/** Keep the sampler's credentials in memory; anything else in the activation goes to the helper. */
	private holdMonitor(
		workload: WorkloadDesired,
		monitor: DatabaseMonitor | undefined,
		extensions: string[] = [],
	): void {
		if (!workload.database || !monitor) {
			this.monitors.delete(workload.id);
			return;
		}
		this.monitors.set(workload.id, {
			activationVersion: workload.activationVersion,
			monitor: { ...monitor },
			extensions: [...extensions],
		});
	}

	/**
	 * After an agent restart the diff cache says a database is unchanged, so its activation is not
	 * re-fetched for the helper. Fetch it once for the sampler's credentials only.
	 */
	private async recoverMonitor(workload: WorkloadDesired, signal: AbortSignal): Promise<void> {
		const held = this.monitors.get(workload.id);
		if (held && held.activationVersion === workload.activationVersion) return;
		try {
			const activation = await this.fetchActivation(workload.id, signal);
			if (activation.workloadId !== workload.id || activation.activationVersion !== workload.activationVersion)
				return;
			this.holdMonitor(workload, activation.monitor, activation.databaseSetup?.extensions ?? []);
		} catch (error) {
			this.log('warn', `Could not fetch monitor credentials for database ${workload.id}: ${errorText(error)}`);
		}
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
				if (workload.database) await this.recoverMonitor(workload, signal);
				if (workload.objectStorage) await this.recoverStorageAdmin(workload, signal);
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

			// `monitor`, `databaseSetup` and `storageAdmin` are for this process only: the helper
			// never sees them.
			const { monitor, databaseSetup, storageAdmin, ...helperActivation } = activation;
			const applied = await this.helper.apply({
				workload: withOptionalSpec(workload),
				activation: helperActivation,
			});
			this.holdMonitor(workload, monitor, databaseSetup?.extensions ?? []);
			this.holdStorageAdmin(workload, storageAdmin);
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
					`Workload ${id} (${workload.projectSlug}) did not answer ${workload.database ? `on 127.0.0.1:${workload.port}` : workload.objectStorage ? STORAGE_HEALTH_PATH : workload.healthPath} yet; reporting starting`,
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
 * same); databases get a TCP probe on their loopback port; everything else answers HTTP on
 * loopback.
 */
export async function probeWorkloadHealth(
	workload: WorkloadDesired,
	socketDir: string,
	signal: AbortSignal,
): Promise<boolean> {
	if (workload.database) return probeDatabasePort(workload.port, signal, { postgres: workload.database.engine === 'postgres' });
	const healthPath = workload.objectStorage ? STORAGE_HEALTH_PATH : workload.healthPath;
	const socketPath =
		workload.runtime === 'process' && workload.socketActivation
			? `${socketDir}/${workload.projectId}.sock`
			: null;
	const url = socketPath
		? `http://localhost${healthPath}`
		: `http://127.0.0.1:${workload.port}${healthPath}`;
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

/** Postgres `SSLRequest`: length 8, code 80877103. The server answers one byte, `S` or `N`. */
const POSTGRES_SSL_REQUEST = new Uint8Array([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * TCP health probe for a database on `127.0.0.1:<port>`. A bare connect can succeed against a
 * port forwarder before the server is up, so for Postgres the probe also sends an `SSLRequest`
 * and waits for the one-byte answer, which only the postmaster gives. No credentials are sent and
 * the server logs nothing for a connection that ends after SSL negotiation.
 */
export function probeDatabasePort(
	port: number,
	signal: AbortSignal,
	options: { postgres?: boolean; timeoutMs?: number; hostname?: string } = {},
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	const postgres = options.postgres ?? true;
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let socket: { end(): void } | null = null;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			try {
				socket?.end();
			} catch {
				// Already closed.
			}
			resolve(ok);
		};
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(false), options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS);
		signal.addEventListener('abort', onAbort, { once: true });
		Bun.connect({
			hostname: options.hostname ?? '127.0.0.1',
			port,
			socket: {
				open(opened) {
					socket = opened;
					if (!postgres) finish(true);
					else opened.write(POSTGRES_SSL_REQUEST);
				},
				data(_socket, data) {
					const answer = data[0];
					finish(answer === 0x53 || answer === 0x4e);
				},
				end() {
					finish(false);
				},
				close() {
					finish(false);
				},
				error() {
					finish(false);
				},
				connectError() {
					finish(false);
				},
			},
		}).then(
			(connected) => {
				socket = connected;
				if (settled) connected.end();
			},
			() => finish(false),
		);
	});
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
		// A volume move must re-render the unit and restart the container (D74).
		...(workload.volumeId ? { volumeId: workload.volumeId } : {}),
		// Only present for databases, so existing app fingerprints (and units) stay unchanged.
		...(workload.database
			? { database: { engine: workload.database.engine, version: workload.database.version } }
			: {}),
		// Engine + version only: buckets, users and keysVersion are converged over S3 and must never
		// restart the container.
		...(workload.objectStorage
			? { objectStorage: { engine: workload.objectStorage.engine, version: workload.objectStorage.version } }
			: {}),
		env: Object.entries(workload.env).sort(([a], [b]) => a.localeCompare(b)),
		secrets: workload.secrets
			.map((secret) => ({ name: secret.name, delivery: secret.delivery, version: secret.version ?? null }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	});
}

/**
 * Forward the optional spec fields (`command`, `image`, `database`, `objectStorage`) to the helper
 * in normalised form. Without them the helper uses its `bun run start` default or rejects a
 * container with a clear message; a `database` or `objectStorage` profile switches it to the fixed
 * managed-service unit (D61, S1). The storage profile is cut down to engine + version: bucket names
 * and access key ids are the agent's business, not the privileged helper's.
 */
export function withOptionalSpec(workload: WorkloadDesired): WorkloadDesired {
	const candidate = workload as WorkloadDesired & { command?: unknown; image?: unknown; database?: unknown };
	const extras: {
		command?: string[];
		image?: string;
		database?: WorkloadDesired['database'];
		objectStorage?: WorkloadDesired['objectStorage'];
	} = {};
	if (Array.isArray(candidate.command) && candidate.command.every((arg) => typeof arg === 'string'))
		extras.command = candidate.command as string[];
	if (typeof candidate.image === 'string') extras.image = candidate.image;
	// The helper derives image, user and mounts from this profile (D61).
	const database = candidate.database as { engine?: unknown; version?: unknown } | undefined;
	if (database && typeof database.engine === 'string' && typeof database.version === 'string')
		extras.database = {
			engine: database.engine as NonNullable<WorkloadDesired['database']>['engine'],
			version: database.version,
		};
	if (workload.objectStorage)
		extras.objectStorage = {
			engine: workload.objectStorage.engine,
			version: workload.objectStorage.version,
		} as WorkloadDesired['objectStorage'];
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
