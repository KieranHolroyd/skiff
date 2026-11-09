import { promises as fs } from 'node:fs';
import { databaseCapabilities, functionIsPython } from '@yoal/contracts';
import type {
	BrokerEngine,
	DatabaseEngine,
	DatabaseMonitor,
	DesiredState,
	ReleaseSpec,
	StorageAdmin,
	WorkloadActivation,
	WorkloadDesired,
	WorkloadStatus,
} from '@yoal/contracts';
import type { DatabaseTarget, DatabaseTargetSource } from './database-stats.ts';
import { renderWorkerdConfigParts } from './function-config.ts';
import { renderFunctionShim } from './function-shim.ts';
import { renderPythonFunctionShim } from './function-shim-python.ts';
import type { StorageTarget, StorageTargetSource } from './storage-admin.ts';
import type { BrokerStatsTarget, BrokerTargetSource } from './broker-stats.ts';
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
	/** Managed databases only: TLS state from the helper (the CA PEM is public material). */
	tls?: { enabled: boolean; caPem: string | null; error: string | null };
}

export type WorkloadLogLevel = 'info' | 'warn' | 'error';
export type WorkloadLog = (level: WorkloadLogLevel, message: string) => void;

export interface WorkloadRuntimeOptions {
	helper: HelperApi;
	releases: Pick<ReleaseManager, 'ensureRelease' | 'hasRelease' | 'releasePath'>;
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
	/** How long after an apply a stopped runner is assumed to be still starting (default 20 s). */
	runnerSettleMs?: number;
	/**
	 * Workload identity (IAM.md I18): remember the token an activation carried. Called before the
	 * helper applies the workload, so the metadata endpoint can serve it immediately.
	 */
	onIdentity?: (workload: WorkloadDesired, identity: WorkloadActivation['identity']) => void | Promise<void>;
	/**
	 * After an agent restart the desired state is unchanged, so no activation is fetched. This
	 * recovers a missing identity token/file for a workload that already has one.
	 */
	ensureIdentity?: (workload: WorkloadDesired, signal: AbortSignal) => Promise<void>;
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
	/**
	 * Owner credential kept in memory only for the PgBouncer admin console (`SHOW POOLS`/`SHOW
	 * STATS`). It never reaches disk, desired state or the helper, and `ownerPassword` above is
	 * still dropped after the monitor role exists.
	 */
	poolerPassword: string | null;
}

/** Root and scoped keys for one storage instance (memory only). */
interface HeldStorageAdmin {
	activationVersion: string;
	admin: StorageAdmin;
}

/** RustFS answers 200 here once the S3 API is up (verified on 1.0.4). */
export const STORAGE_HEALTH_PATH = '/health';

export const DEFAULT_WORKLOAD_SOCKET_DIR = '/run/yoal-workloads';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const HEALTH_PROBE_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/** A runner reported stopped this soon after its apply may just not have started yet. */
const RUNNER_SETTLE_MS = 20_000;

export class WorkloadRuntime implements DatabaseTargetSource, StorageTargetSource, BrokerTargetSource {
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
	private readonly runnerSettleMs: number;
	private readonly onIdentity: WorkloadRuntimeOptions['onIdentity'];
	private readonly ensureIdentity: WorkloadRuntimeOptions['ensureIdentity'];

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
	/** Purged broker ids not yet acknowledged by a heartbeat (D111). */
	private readonly purgedBrokerPending = new Set<string>();
	private retryAt = 0;
	private pendingFailure = false;
	/** Desired workloads from the last converge, for the runner recycler (plan 21). */
	private desiredById = new Map<string, WorkloadDesired>();
	/** Runner replicas whose container exited after a job and need a fresh JIT config. */
	private readonly recycleDue = new Set<string>();
	/**
	 * Workloads another runner owns for now (a read replica being promoted, C7): left exactly as
	 * they are, neither re-applied nor restarted, until released or gone from desired state.
	 */
	private readonly held = new Set<string>();
	/** When each runner was last applied; a just-queued `--no-block` start can still read inactive. */
	private readonly runnerAppliedAt = new Map<string, number>();
	private recycling: Promise<void> | null = null;
	/** Serialises converge and recycle so one unit is never applied twice at once. */
	private lock: Promise<void> = Promise.resolve();
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
		this.runnerSettleMs = options.runnerSettleMs ?? RUNNER_SETTLE_MS;
		this.onIdentity = options.onIdentity;
		this.ensureIdentity = options.ensureIdentity;
	}

	/** True when a previous converge left work behind and the retry window has passed. */
	needsRetry(now = Date.now()): boolean {
		return this.pendingFailure && now >= this.retryAt;
	}

	/** Reports for the heartbeat, in stable id order. */
	currentReports(): WorkloadRuntimeReport[] {
		return [...this.reports.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Desired workloads with workload identity enabled, for the token refresh loop. */
	identityWorkloads(): WorkloadDesired[] {
		return [...this.desiredById.values()].filter((workload) => workload.identity);
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
					// An ephemeral runner whose job finished exits cleanly (`stopped`). That is the
					// normal cycle, not an outage: report it as starting and replace it right away.
					// A `failed` runner (bad credential, broken image) takes the normal retry backoff.
					if (actual.status === 'stopped' && this.desiredById.get(id)?.runner) {
						this.reports.set(id, { ...reportFromStatus(actual), status: 'starting' });
						if (Date.now() - (this.runnerAppliedAt.get(id) ?? 0) >= this.runnerSettleMs) this.recycleDue.add(id);
						return;
					}
					this.reports.set(id, reportFromStatus(actual));
					// A function configured to scale to zero is stopped on purpose: the socket keeps
					// listening and the next request cold-starts it, so this is steady state, not an
					// outage to retry. A failed unit still gets the normal retry.
					if (
						(actual.status === 'failed' || actual.status === 'stopped') &&
						!this.pendingFailure &&
						!(actual.status === 'stopped' && isIdleStoppable(this.desiredById.get(id)))
					) {
						this.scheduleRetry();
					}
				} catch {
					// Keep the previous report; the next heartbeat retries.
				}
			}),
		);
		if (this.recycleDue.size > 0) void this.recycleRunners();
		return this.currentReports();
	}

	/**
	 * Re-apply runner replicas that finished a job (D91). Re-applying fetches a new activation,
	 * which carries a fresh single-use JIT config, and recreates the container from a clean image.
	 * Runs outside the reconcile loop so a finished runner is replaced within one heartbeat instead
	 * of waiting for the next desired-state long poll.
	 */
	recycleRunners(signal: AbortSignal = new AbortController().signal): Promise<void> {
		// One pass at a time; a caller during a pass waits for it. Ids added meanwhile stay due and
		// the next heartbeat starts another pass.
		this.recycling ??= this.recyclePass(signal).finally(() => {
			this.recycling = null;
		});
		return this.recycling;
	}

	private async recyclePass(signal: AbortSignal): Promise<void> {
		try {
			await this.exclusive(async () => {
				for (const id of [...this.recycleDue]) {
					if (signal.aborted) return;
					this.recycleDue.delete(id);
					const workload = this.desiredById.get(id);
					if (!workload?.runner) continue;
					await this.applyOne(workload, new Map(), signal);
					if (this.reports.get(id)?.status === 'failed') this.scheduleRetry();
				}
			});
		} finally {
			if (this.dirty) await this.persistState();
		}
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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
				...(report?.tls?.enabled
					? { tls: { caPem: report.tls.caPem } }
					: {}),
				...(workload.pooler && held.poolerPassword
					? {
							pooler: {
								port: workload.pooler.port,
								username: held.monitor.ownerUser,
								password: held.poolerPassword,
							},
						}
					: {}),
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

	/** Brokers the stats sampler talks to (D123). Credentials come from the activation, on demand. */
	brokerTargets(): BrokerStatsTarget[] {
		const targets: BrokerStatsTarget[] = [];
		for (const [id, workload] of this.desiredById) {
			if (!workload.broker) continue;
			const report = this.reports.get(id);
			targets.push({
				id,
				activationVersion: workload.activationVersion,
				port: workload.port,
				status: report?.status ?? 'pending',
				...(report?.memoryBytes !== undefined ? { memoryBytes: report.memoryBytes } : {}),
				storageMb: workload.broker.storageMb,
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

	/** Purged broker ids for the next heartbeat's `purgedBrokers`. */
	pendingPurgedBrokers(): string[] {
		return [...this.purgedBrokerPending].sort();
	}

	/** Call only after the control plane accepted a heartbeat that carried these ids. */
	acknowledgePurgedBrokers(ids: readonly string[]): void {
		for (const id of ids) this.purgedBrokerPending.delete(id);
	}

	/** Purged database ids for the next heartbeat's `purgedDatabases`. */
	pendingPurgedDatabases(): string[] {
		return [...this.purgedPending].sort();
	}

	/** Call only after the control plane accepted a heartbeat that carried these ids. */
	hold(id: string): void {
		this.held.add(id);
	}

	release(id: string): void {
		this.held.delete(id);
	}

	acknowledgePurgedDatabases(ids: readonly string[]): void {
		for (const id of ids) this.purgedPending.delete(id);
	}

	/** Idempotently converge all workloads placed on this node. Never throws. */
	async converge(state: DesiredState, signal: AbortSignal = new AbortController().signal): Promise<void> {
		await this.loadState();
		await this.exclusive(async () => {
			try {
				await this.convergeState(state, signal);
			} finally {
				if (this.dirty) await this.persistState();
			}
		});
	}

	private async convergeState(state: DesiredState, signal: AbortSignal): Promise<void> {
		const desired = state.workloads.filter((workload) => workload.status !== 'stopped');
		const desiredIds = new Set(desired.map((workload) => workload.id));
		this.desiredById = new Map(desired.map((workload) => [workload.id, workload]));
		for (const id of [...this.recycleDue]) if (!desiredIds.has(id)) this.recycleDue.delete(id);
		for (const id of [...this.runnerAppliedAt.keys()]) if (!desiredIds.has(id)) this.runnerAppliedAt.delete(id);
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
		const brokerPurgeFailed = await this.purgeManaged('broker', state.brokerPurges ?? [], listedIds, signal);
		const purgeFailed = databasePurgeFailed || storagePurgeFailed || brokerPurgeFailed;

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
			if (this.held.has(workload.id)) continue;
			await this.applyOne(workload, releaseSpecs, signal);
		}

		const failed = desired.some(
			(workload) => !this.applied.has(workload.id) || this.reports.get(workload.id)?.status === 'failed',
		);
		if (failed || purgeFailed) this.scheduleRetry();
		else this.pendingFailure = false;
	}

	/**
	 * Hand `databasePurges` / `storagePurges` / `brokerPurges` to the helper (D59, S8, D111). An id that is still listed as
	 * a workload is never purged, whatever the purge list says; an id already purged and awaiting
	 * its heartbeat is not purged twice. Returns true when a purge failed and needs a retry.
	 */
	private async purgeManaged(
		kind: 'database' | 'storage' | 'broker',
		ids: readonly string[],
		listedIds: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<boolean> {
		const pending =
			kind === 'database' ? this.purgedPending : kind === 'storage' ? this.purgedStoragePending : this.purgedBrokerPending;
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
			poolerPassword: monitor.ownerPassword,
		});
	}

	/**
	 * After an agent restart the diff cache says a database is unchanged, so its activation is not
	 * re-fetched for the helper. Fetch it once for the sampler's credentials only.
	 */
	private async recoverMonitor(workload: WorkloadDesired, signal: AbortSignal): Promise<void> {
		// Only engines with the stats sampler carry monitor credentials (D57).
		if (!workload.database || !databaseCapabilities(workload.database.engine).metrics) return;
		// A read replica has no sampler credentials (C7): nothing to recover.
		if (workload.database.replica) return;
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
			// A function is rendered from its spec and release, so refuse an incomplete desired
			// state before fetching activation or sending half a request to the helper.
			if (workload.runtime === 'function') {
				if (!workload.function)
					throw new Error('a function workload needs a resolved function spec');
				if (!workload.release) throw new Error('a function workload needs a release');
			}

			await this.ensureRelease(workload, releaseSpecs, signal);

			if (previous && previous.fingerprint === fingerprint && previous.activationVersion === workload.activationVersion) {
				// Unchanged: reconcile the actual status instead of restarting a healthy unit.
				if (workload.identity) await this.ensureIdentity?.(workload, signal);
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
						...(status.tls ? { tls: status.tls } : {}),
					});
					return;
				}
				if (status.status === 'starting' || status.status === 'pending') {
					this.reports.set(id, reportFromStatus(status));
					return;
				}
				if (status.status === 'stopped' && isIdleStoppable(workload)) {
					// Scale-to-zero: the socket unit is still listening; do not restart the host
					// just because it is idle. A new request starts it through socket activation.
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

			// Remember the token before the helper applies the unit, so the metadata endpoint can
			// serve it as soon as the workload starts. The helper writes the 0400 file itself.
			if (activation.identity) await this.onIdentity?.(workload, activation.identity);

			// `monitor`, `databaseSetup` and `storageAdmin` are for this process only: the helper
			// never sees them.
			const { monitor, databaseSetup, storageAdmin, ...helperActivation } = activation;
			const applied = await this.helper.apply({
				workload: withOptionalSpec(workload),
				activation: helperActivation,
				// Only a function gets the rendered workerd config and shim (FN2); every other
				// runtime keeps the original two-field body. The activation env is only used for
				// bindings whose config must carry credentials (Hyperdrive).
				...(workload.runtime === 'function'
					? { function: this.renderFunction(workload, activation.env) }
					: {}),
			});
			this.holdMonitor(workload, monitor, databaseSetup?.extensions ?? []);
			this.holdStorageAdmin(workload, storageAdmin);
			if (workload.runner) this.runnerAppliedAt.set(id, Date.now());
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

			// A worker has nothing to probe: it is running once systemd says so. Runners restart with
			// --no-block (the first start pulls a large image), so they may still be activating here.
			const healthy =
				workload.ingress === 'none' ? applied.status === 'running' : await this.waitForHealth(workload, signal);
			const status: WorkloadStatus = healthy ? 'running' : 'starting';
			this.reports.set(id, {
				id,
				status,
				restarts: applied.restarts,
				...(applied.memoryBytes !== undefined ? { memoryBytes: applied.memoryBytes } : {}),
				...(applied.tls ? { tls: applied.tls } : {}),
			});
			if (healthy) {
				this.log('info', `Workload ${id} (${workload.projectSlug}) is running`);
			} else if (workload.ingress !== 'none') {
				this.log(
					'warn',
					`Workload ${id} (${workload.projectSlug}) did not answer ${workload.database || workload.broker ? `on 127.0.0.1:${workload.port}` : workload.objectStorage ? STORAGE_HEALTH_PATH : workload.healthPath} yet; reporting starting`,
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

	/**
	 * FN2: a function is a process workload whose unit runs the pinned workerd binary. The helper
	 * writes `config` and `shim` beside the workload and embeds them as `function-config` and
	 * `function-shim`; the modules are embedded from the release directory under `module-<i>`
	 * (PLAN.md). Phase-2 binding services add extra embedded modules (`files`) under their own
	 * credential names. Rendering is pure, so an unchanged desired state is caught by the
	 * fingerprint before this runs; the activation env only feeds bindings that embed credentials
	 * (Hyperdrive), never the phase-1 output.
	 */
	private renderFunction(
		workload: WorkloadDesired,
		env: Record<string, string>,
	): { config: string; shim: string; files?: Record<string, string> } {
		const spec = workload.function;
		if (!spec || !workload.release)
			throw new Error('a function workload needs a resolved function spec and a release');
		const releaseDir = this.releases.releasePath(workload.release);
		const rendered = renderWorkerdConfigParts({ workload, releaseDir, env });
		return {
			config: rendered.config,
			// A Python Worker gets the binding-based shim in a Worker of its own (D121).
			shim: functionIsPython(spec) ? renderPythonFunctionShim() : renderFunctionShim({ main: spec.main }),
			// Binding-service modules are omitted entirely when empty, so phase-1 requests keep
			// their original two-field `function` body.
			...(Object.keys(rendered.files).length > 0 ? { files: rendered.files } : {}),
		};
	}

	private async ensureRelease(
		workload: WorkloadDesired,
		releaseSpecs: Map<string, ReleaseSpec>,
		signal: AbortSignal,
	): Promise<void> {
		// Container workloads pull an image; process and function workloads run from a release
		// directory (a function's config embeds its modules from there).
		if (workload.runtime === 'container' || !workload.release) return;
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

/** TLS state for the heartbeat; the CA PEM is public and the private key stays on the node. */
export function databaseTlsHeartbeat(
	reports: WorkloadRuntimeReport[],
): Array<{ id: string; enabled: boolean; caPem: string | null; error: string | null }> {
	return reports
		.filter((report) => report.tls)
		.map((report) => ({
			id: report.id,
			enabled: report.tls?.enabled ?? false,
			caPem: report.tls?.caPem ?? null,
			error: report.tls?.error ?? null,
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
	// Injection point for tests: the default is the global fetch, which does not accept `unix:`.
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	// Workers (plan 21) listen on nothing; the caller only probes a unit systemd reports active.
	if (workload.ingress === 'none') return true;
	if (workload.database) return probeDatabasePort(workload.port, signal, { engine: workload.database.engine });
	if (workload.broker)
		return probeDatabasePort(workload.port, signal, { handshake: brokerProbeHandshake(workload.broker.engine) });
	const healthPath = workload.objectStorage ? STORAGE_HEALTH_PATH : workload.healthPath;
	// A function host is socket-activated like a process app, but its socket is named after the
	// desired-state id: the workload id for replica 0, `<id>-r<n>` for the rest (phase 4). A process
	// app keeps the project socket the helper has always created.
	const socketName = workload.runtime === 'function' ? workload.id : workload.projectId;
	const socketPath =
		(workload.runtime === 'process' || workload.runtime === 'function') && workload.socketActivation
			? `${socketDir}/${socketName}.sock`
			: null;
	const url = socketPath
		? `http://localhost${healthPath}`
		: `http://127.0.0.1:${workload.port}${healthPath}`;
	try {
		const response = await fetcher(url, {
			method: 'GET',
			redirect: 'manual',
			headers: { 'user-agent': 'yoal-agent-health' },
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
 * MongoDB `OP_MSG` (opCode 2013) carrying `{ hello: 1, $db: "admin" }`. `hello` needs no
 * authentication; only a running `mongod` answers it.
 */
const MONGODB_HELLO = new Uint8Array([
	0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xdd, 0x07, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x02, 0x24, 0x64, 0x62, 0x00, 0x06, 0x00, 0x00, 0x00, 0x61, 0x64, 0x6d,
	0x69, 0x6e, 0x00, 0x00,
]);

/** RESP inline `PING`. Without credentials Valkey/Redis answer `-NOAUTH`, which still proves it is up. */
const RESP_PING = new TextEncoder().encode('PING\r\n');

/** ClickHouse's unauthenticated HTTP liveness endpoint; the server answers `200 Ok.`. */
const CLICKHOUSE_PING = new TextEncoder().encode('GET /ping HTTP/1.0\r\nHost: localhost\r\n\r\n');

/**
 * Per-engine handshake: what the probe sends after connecting (null: the server speaks first) and
 * whether the first bytes it gets back come from the real server, not Podman's port forwarder.
 */
export interface ProbeHandshake {
	send: Uint8Array | null;
	accept(data: Uint8Array): boolean;
}

export function probeHandshake(engine: DatabaseEngine): ProbeHandshake {
	switch (engine) {
		case 'postgres':
			return { send: POSTGRES_SSL_REQUEST, accept: (data) => data[0] === 0x53 || data[0] === 0x4e };
		case 'mysql':
		case 'mariadb':
			// The server greets first: a protocol-10 handshake (byte 4 is 0x0a), or an error packet
			// (0xff) when it is up but refusing, which still means it is running.
			return { send: null, accept: (data) => data.length >= 5 && (data[4] === 0x0a || data[4] === 0xff) };
		case 'mongodb':
			// Any reply header whose opCode is OP_MSG (2013) or the legacy OP_REPLY (1).
			return {
				send: MONGODB_HELLO,
				accept: (data) => {
					if (data.length < 16) return false;
					const opCode = data[12]! | (data[13]! << 8) | (data[14]! << 16) | (data[15]! << 24);
					return opCode === 2013 || opCode === 1;
				},
			};
		case 'valkey':
		case 'redis': {
			return {
				send: RESP_PING,
				accept: (data) => {
					const text = new TextDecoder().decode(data.subarray(0, 16));
					// `-LOADING` means the dataset is still being read from disk: not ready yet.
					return (text.startsWith('+') || text.startsWith('-')) && !text.startsWith('-LOADING');
				},
			};
		}
		case 'clickhouse':
			// Only a running server sends a status line. During the entrypoint's first-start init the
			// server listens on its own loopback only, so the probe stays down until it is done.
			return {
				send: CLICKHOUSE_PING,
				accept: (data) => /^HTTP\/1\.[01] 200 /.test(new TextDecoder().decode(data.subarray(0, 16))),
			};
	}
}

/**
 * Broker handshake (D111). A NATS server greets every connection with `INFO {…}` before the client
 * says anything; Podman's forwarder accepts the TCP connect but never sends that line.
 */
export function brokerProbeHandshake(engine: BrokerEngine): ProbeHandshake {
	switch (engine) {
		case 'nats':
			return { send: null, accept: (data) => new TextDecoder().decode(data.subarray(0, 5)) === 'INFO ' };
	}
}

/**
 * TCP health probe for a database on `127.0.0.1:<port>`. A bare connect can succeed against a
 * port forwarder before the server is up, so the probe performs the engine's smallest handshake
 * (Postgres `SSLRequest`, the MySQL greeting, MongoDB `hello`, RESP `PING`, ClickHouse `GET /ping`)
 * and waits for an answer
 * only the server itself gives. No credentials are ever sent.
 */
export function probeDatabasePort(
	port: number,
	signal: AbortSignal,
	options: {
		engine?: DatabaseEngine;
		/** An explicit handshake (brokers); wins over `engine`. */
		handshake?: ProbeHandshake;
		postgres?: boolean;
		timeoutMs?: number;
		hostname?: string;
	} = {},
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	// `postgres: false` (older callers) means "a bare TCP connect is enough".
	const handshake =
		options.handshake ??
		(options.postgres === false && !options.engine ? null : probeHandshake(options.engine ?? 'postgres'));
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
					if (!handshake) finish(true);
					else if (handshake.send) opened.write(handshake.send);
				},
				data(_socket, data) {
					finish(handshake ? handshake.accept(data) : true);
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
		...(status.tls ? { tls: status.tls } : {}),
	};
}

/**
 * Everything that affects the rendered unit, not just activation. `activationVersion` in the
 * contract hashes env/secrets/command/image/port, so resource or health changes must be part of
 * the agent's own diff or they would never restart the unit.
 */
/**
 * True when this workload is stopped on purpose when idle: a function host (phase 3, FN4) or a
 * socket-activated process app with `idleStopSeconds` (D121). Its socket keeps listening.
 */
export function isIdleStoppable(workload: WorkloadDesired | undefined): boolean {
	if (workload?.runtime === 'function') return (workload.function?.idleStopSeconds ?? 0) > 0;
	return workload?.runtime === 'process' && workload.socketActivation && (workload.idleStopSeconds ?? 0) > 0;
}

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
		// Worker and runner profiles change the unit; only present when set (no restart on upgrade).
		...(workload.ingress ? { ingress: workload.ingress } : {}),
		// Node.js apps (D125) get a different default command and the fd-3 preload.
		...(workload.engine ? { engine: workload.engine } : {}),
		...(workload.runner ? { runner: workload.runner.provider } : {}),
		// Turning workload identity on changes the rendered unit (mount/credential), so it must
		// re-apply even though the activation version did not move.
		...(workload.identity ? { identity: true } : {}),
		// A disk move must re-render the unit and restart the container (D169).
		...(workload.volumeId ? { volumeId: workload.volumeId } : {}),
		// Only present for databases, so existing app fingerprints (and units) stay unchanged.
		...(workload.database
			? {
					database: {
						engine: workload.database.engine,
						version: workload.database.version,
						...(workload.database.variant ? { variant: workload.database.variant } : {}),
						...(workload.database.tls ? { tls: true } : {}),
					},
				}
			: {}),
		// Engine + version only: buckets, users and keysVersion are converged over S3 and must never
		// restart the container.
		...(workload.objectStorage
			? { objectStorage: { engine: workload.objectStorage.engine, version: workload.objectStorage.version } }
			: {}),
		// Only present for brokers; the store cap is written into the rendered config.
		...(workload.broker ? { broker: workload.broker } : {}),
		// A function's bindings, compatibility date and assets are part of the rendered workerd
		// config, so a change must re-render and restart the host.
		...(workload.function ? { function: workload.function } : {}),
		// Every compose unit and route is rendered from this block; a service change must re-apply.
		...(workload.compose ? { compose: workload.compose } : {}),
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
		broker?: WorkloadDesired['broker'];
		compose?: WorkloadDesired['compose'];
	} = {};
	if (Array.isArray(candidate.command) && candidate.command.every((arg) => typeof arg === 'string'))
		extras.command = candidate.command as string[];
	if (typeof candidate.image === 'string') extras.image = candidate.image;
	// Compose services are validated by the control plane; the helper validates the wire shape again.
	if (workload.compose) extras.compose = workload.compose;
	// The helper derives image, user and mounts from this profile (D61).
	const database = candidate.database as { engine?: unknown; version?: unknown; variant?: unknown } | undefined;
	if (database && typeof database.engine === 'string' && typeof database.version === 'string')
		extras.database = {
			engine: database.engine as NonNullable<WorkloadDesired['database']>['engine'],
			version: database.version,
			// Yoal-built Postgres image variants (D126); absent means the engine's own image.
			...(database.variant === 'postgis' || database.variant === 'pg_cron' ? { variant: database.variant } : {}),
			...((candidate.database as { tls?: unknown } | undefined)?.tls === true ? { tls: true } : {}),
			// Point-in-time recovery (docs/PITR.md): without it the helper renders no WAL archiving.
			// The helper validates the stanza and timeout.
			...(() => {
				const pitr = (candidate.database as { pitr?: { stanza?: unknown; archiveTimeoutSeconds?: unknown } }).pitr;
				return pitr && typeof pitr.stanza === 'string' && typeof pitr.archiveTimeoutSeconds === 'number'
					? { pitr: { stanza: pitr.stanza, archiveTimeoutSeconds: pitr.archiveTimeoutSeconds } }
					: {};
			})(),
			// A read replica's standby slot (C7); the helper validates the name.
			...(typeof (candidate.database as { replica?: { slot?: unknown } } | undefined)?.replica?.slot === 'string'
				? { replica: { slot: (candidate.database as { replica: { slot: string } }).replica.slot } }
				: {}),
		};
	if (workload.objectStorage)
		extras.objectStorage = {
			engine: workload.objectStorage.engine,
			version: workload.objectStorage.version,
		} as WorkloadDesired['objectStorage'];
	// The helper derives image, user, config and mounts from the broker profile (D111).
	if (workload.broker)
		extras.broker = {
			engine: workload.broker.engine,
			version: workload.broker.version,
			storageMb: workload.broker.storageMb,
		};
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
