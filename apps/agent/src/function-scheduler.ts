import { promises as fs } from 'node:fs';
import {
	FUNCTION_INTERNAL_HEADER,
	FUNCTION_INTERNAL_VALUE,
	nextCronTime,
	type DesiredState,
	type FunctionRuntimeSpec,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';
import { probeWorkloadHealth } from './runtime.ts';
import { atomicWriteFile } from './state.ts';

/**
 * Functions economics and triggers on the node (docs/FUNCTIONS.md §4.7, §4.10; FN4, FN5, FN9).
 *
 * Three duties, all local — no control-plane round trip:
 *
 * - **Scale to zero**: a function host that has served nothing for `idleStopSeconds` is stopped.
 *   The socket unit keeps listening (`RemoveOnStop=yes` is on the socket, not the service), so the
 *   next request cold-starts the host through socket activation. `0` means always on.
 * - **Runaway watchdog**: every `watchdogIntervalMs` each running host is probed at
 *   `/__skiff/health`; three consecutive misses restart it, then it is left alone for a cooldown.
 * - **Cron**: `triggers.crons` fire on the node by POSTing to the shim's internal
 *   `/__skiff/scheduled` over the host socket. A persisted cursor keeps one run per occurrence and
 *   never replays a backlog after a restart.
 *
 * Everything is dependency-injected (helper, clock, sleep, fetch, probe) so the whole class runs in
 * a unit test with no timers or sockets.
 */

export interface FunctionSchedulerOptions {
	helper: Pick<HelperApi, 'status' | 'stop' | 'restart'>;
	socketDir: string;
	/** `<dataDir>/function-cron-state.json`; null disables persistence (tests). */
	statePath: string | null;
	probeHealth?: (workload: WorkloadDesired, signal: AbortSignal) => Promise<boolean>;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	watchdogIntervalMs?: number;
	watchdogMisses?: number;
	restartCooldownMs?: number;
	cronIntervalMs?: number;
	/**
	 * False when the agent has no Caddy access log to observe requests (scale-to-zero would stop a
	 * host that is actually serving). Defaults true; `main.ts` passes whether telemetry is on.
	 */
	activityEnabled?: boolean;
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_WATCHDOG_MISSES = 3;
const DEFAULT_RESTART_COOLDOWN_MS = 60_000;
const DEFAULT_CRON_INTERVAL_MS = 10_000;
/**
 * How old a missed occurrence may be before catch-up drops it instead of firing it. One minute is
 * enough to cover a quick agent restart at an occurrence boundary and short enough that a long
 * outage never replays history.
 */
const CRON_GRACE_MS = 60_000;
/** The shim aborts a `scheduled` invocation after this long (docs/FUNCTIONS.md §4.7). */
const CRON_TIMEOUT_MS = 60_000;
const CRON_STATE_VERSION = 1;

type FunctionWorkload = WorkloadDesired & { function: FunctionRuntimeSpec };

interface CronCursor {
	workloadId: string;
	cron: string;
	/** Epoch ms of the last occurrence handed to the shim; null until the first run. */
	lastFiredAt: number | null;
}

interface CronStateFile {
	version: number;
	crons: CronCursor[];
}

export class FunctionScheduler {
	private readonly helper: Pick<HelperApi, 'status' | 'stop' | 'restart'>;
	private readonly socketDir: string;
	private readonly statePath: string | null;
	private readonly probeHealth: (workload: WorkloadDesired, signal: AbortSignal) => Promise<boolean>;
	private readonly doFetch: typeof fetch;
	private readonly now: () => number;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
	private readonly watchdogIntervalMs: number;
	private readonly watchdogMisses: number;
	private readonly restartCooldownMs: number;
	private readonly cronIntervalMs: number;
	private readonly activityEnabled: boolean;
	/** How often `run` takes a pass: the faster of the two cadences (5 s with the defaults). */
	private readonly loopIntervalMs: number;

	/** Last request per project (FN4). Seeded with the first-seen time when a host appears. */
	private readonly lastActivityByProject = new Map<string, number>();
	/** Previous observed helper status, for the "reset the idle timer after a restart" rule. */
	private readonly previousStatus = new Map<string, WorkloadStatus>();
	/** Consecutive failed health probes per workload id (FN5). */
	private readonly missedProbes = new Map<string, number>();
	/** Workloads the watchdog leaves alone until this epoch ms. */
	private readonly cooldownUntil = new Map<string, number>();
	/** Cron cursors keyed by `${workloadId}\n${cron}`. */
	private readonly crons = new Map<string, CronCursor>();
	/** Expressions that cannot match within a year; never scanned again. */
	private readonly deadCrons = new Set<string>();
	private cronStateLoaded = false;
	/** False until the first cron pass has finished, so a restart can skip a backlog once. */
	private firstCronPass = true;
	private lastCronPassAt = Number.NEGATIVE_INFINITY;

	constructor(options: FunctionSchedulerOptions) {
		this.helper = options.helper;
		this.socketDir = options.socketDir;
		this.statePath = options.statePath;
		this.probeHealth =
			options.probeHealth ??
			((workload, signal) => probeWorkloadHealth(workload, this.socketDir, signal));
		this.doFetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.doSleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
		this.watchdogMisses = Math.max(1, options.watchdogMisses ?? DEFAULT_WATCHDOG_MISSES);
		this.restartCooldownMs = options.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
		this.cronIntervalMs = options.cronIntervalMs ?? DEFAULT_CRON_INTERVAL_MS;
		this.activityEnabled = options.activityEnabled ?? true;
		this.loopIntervalMs = Math.max(1, Math.min(this.watchdogIntervalMs, this.cronIntervalMs));
	}

	/**
	 * Record that a project served a request. The telemetry access-log path calls this for every
	 * bucket it resolves, which is the signal the idle stop is measured from.
	 */
	noteActivity(projectId: string, at: number = this.now()): void {
		this.lastActivityByProject.set(projectId, at);
	}

	/** Run the scheduler until the shutdown signal aborts. Never throws out of the loop. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.tick(getState(), signal);
			} catch (error) {
				// A bug or a helper outage must never take the agent's other loops down.
				this.log('warn', `Function scheduler tick failed: ${errorText(error)}`);
			}
			await this.doSleep(this.loopIntervalMs, signal);
		}
	}

	/** One pass over the desired state: idle sweep, watchdog, then cron. */
	async tick(state: DesiredState | null, signal: AbortSignal): Promise<void> {
		if (!state) return;
		const now = this.now();
		const functions: FunctionWorkload[] = [];
		for (const workload of state.workloads) {
			if (workload.runtime !== 'function' || !workload.function) continue;
			// A stopped desired state normally means quiesced; but an idle-stopped function's
			// heartbeat also reads `stopped`, and its cron/watchdog still need to run (the socket
			// starts it on demand). Keep those.
			if (workload.status === 'stopped' && workload.function.idleStopSeconds <= 0) continue;
			functions.push(workload as FunctionWorkload);
		}

		const statuses = await this.readStatuses(functions);
		await this.sweepIdle(functions, statuses, now);
		await this.runWatchdog(functions, statuses, now, signal);
		await this.runCron(functions, now, signal);
	}

	/** Helper state per workload; a failure is logged and leaves the workload "unknown". */
	private async readStatuses(workloads: FunctionWorkload[]): Promise<Map<string, WorkloadStatus>> {
		const statuses = new Map<string, WorkloadStatus>();
		for (const workload of workloads) {
			try {
				const status = await this.helper.status(workload.id);
				statuses.set(workload.id, status.status);
			} catch (error) {
				this.log('warn', `Function ${workload.id} status failed: ${errorText(error)}`);
			}
		}
		return statuses;
	}

	/**
	 * Stop hosts that have been idle for `idleStopSeconds`. A host that has never served is measured
	 * from the first tick that saw it, so a fresh deploy is never stopped immediately. A status
	 * transition (a restart or an apply) resets the timer: the host just started working again.
	 */
	private async sweepIdle(
		workloads: FunctionWorkload[],
		statuses: Map<string, WorkloadStatus>,
		now: number,
	): Promise<void> {
		const liveIds = new Set<string>();
		const liveProjects = new Set<string>();
		for (const workload of workloads) {
			liveIds.add(workload.id);
			liveProjects.add(workload.projectId);
			const status = statuses.get(workload.id) ?? null;
			const previous = this.previousStatus.get(workload.id) ?? null;
			if (status !== null) {
				if (previous !== null && previous !== status)
					this.lastActivityByProject.set(workload.projectId, now);
				this.previousStatus.set(workload.id, status);
			}
			// First sight of a host counts as its last activity (FN4: never stop a host that has
			// never served).
			if (!this.lastActivityByProject.has(workload.projectId))
				this.lastActivityByProject.set(workload.projectId, now);

			const idleStopSeconds = workload.function.idleStopSeconds;
			if (!this.activityEnabled || idleStopSeconds <= 0) continue;
			if (status !== 'running') continue;
			const lastActivity = this.lastActivityByProject.get(workload.projectId)!;
			const idleMs = now - lastActivity;
			if (idleMs < idleStopSeconds * 1_000) continue;
			try {
				await this.helper.stop(workload.id);
				// The watchdog in this same pass must not probe the host we just stopped.
				statuses.set(workload.id, 'stopped');
				this.previousStatus.set(workload.id, 'stopped');
				this.log('info', `Function ${workload.id} stopped after ${Math.round(idleMs / 1_000)}s idle`);
			} catch (error) {
				this.log('warn', `Function ${workload.id} idle stop failed: ${errorText(error)}`);
			}
		}

		// Drop state for workloads and projects that left desired state (telemetry records activity
		// for every project on the node, not only functions).
		for (const id of this.previousStatus.keys()) if (!liveIds.has(id)) this.previousStatus.delete(id);
		for (const id of this.missedProbes.keys()) if (!liveIds.has(id)) this.missedProbes.delete(id);
		for (const id of this.cooldownUntil.keys()) if (!liveIds.has(id)) this.cooldownUntil.delete(id);
		for (const projectId of this.lastActivityByProject.keys())
			if (!liveProjects.has(projectId)) this.lastActivityByProject.delete(projectId);
	}

	/** Probe every running host; three consecutive misses restart it, then cool down (FN5). */
	private async runWatchdog(
		workloads: FunctionWorkload[],
		statuses: Map<string, WorkloadStatus>,
		now: number,
		signal: AbortSignal,
	): Promise<void> {
		for (const workload of workloads) {
			// Stopped and stopping hosts are not probed: only a running unit can be runaway.
			if (statuses.get(workload.id) !== 'running') continue;
			if (now < (this.cooldownUntil.get(workload.id) ?? 0)) continue;

			let healthy = false;
			try {
				healthy = await this.probeHealth(workload, signal);
			} catch {
				healthy = false;
			}
			if (healthy) {
				this.missedProbes.delete(workload.id);
				continue;
			}

			const misses = (this.missedProbes.get(workload.id) ?? 0) + 1;
			this.missedProbes.set(workload.id, misses);
			if (misses < this.watchdogMisses) continue;

			// Reset before the attempt so a failed restart does not retry on every tick.
			this.missedProbes.set(workload.id, 0);
			try {
				await this.helper.restart(workload.id);
				this.cooldownUntil.set(workload.id, now + this.restartCooldownMs);
				this.log(
					'warn',
					`Function ${workload.id} watchdog restart after ${misses} missed health probes`,
				);
			} catch (error) {
				this.log('warn', `Function ${workload.id} watchdog restart failed: ${errorText(error)}`);
			}
		}
	}

	/**
	 * Fire due cron occurrences into the shim's internal route (FN9). The cursor advances to the
	 * fired occurrence even when the POST fails: a broken host must not build a retry storm, and the
	 * next occurrence is the next chance.
	 */
	private async runCron(
		workloads: FunctionWorkload[],
		now: number,
		signal: AbortSignal,
	): Promise<void> {
		if (now - this.lastCronPassAt < this.cronIntervalMs) return;
		this.lastCronPassAt = now;
		await this.loadCronState();

		const liveKeys = new Set<string>();
		let dirty = false;
		for (const workload of workloads) {
			// Replicas share one schedule, so only replica 0 fires: one run per occurrence per
			// project on this node. Phase 4 replaces this with a cluster-wide run lease (FN9).
			if (workload.replica && workload.replica.index > 0) continue;
			for (const cron of workload.function.triggers.crons) {
				const key = `${workload.id}\n${cron}`;
				liveKeys.add(key);
				if (this.deadCrons.has(key)) continue;

				let cursor = this.crons.get(key);
				if (!cursor) {
					cursor = { workloadId: workload.id, cron, lastFiredAt: null };
					this.crons.set(key, cursor);
					dirty = true;
				}

				const from = cursor.lastFiredAt ?? now - CRON_GRACE_MS;
				const due = nextCronTime(cron, from);
				if (due === null) {
					// No occurrence within a year (for example 31 February): never scan it again.
					this.deadCrons.add(key);
					continue;
				}
				if (due > now) continue;

				// First pass after a restart with a persisted cursor: an occurrence older than the
				// grace window was missed while the agent was down. Skip to now, never replay it.
				if (this.firstCronPass && cursor.lastFiredAt !== null && due <= now - CRON_GRACE_MS) {
					cursor.lastFiredAt = now;
					dirty = true;
					continue;
				}

				await this.fire(workload, cron, due, signal);
				cursor.lastFiredAt = due;
				dirty = true;
			}
		}

		// Forget schedules whose workload or expression left desired state.
		for (const key of this.crons.keys()) {
			if (liveKeys.has(key)) continue;
			this.crons.delete(key);
			this.deadCrons.delete(key);
			dirty = true;
		}

		if (dirty) await this.persistCronState();
		this.firstCronPass = false;
	}

	private async fire(
		workload: FunctionWorkload,
		cron: string,
		due: number,
		signal: AbortSignal,
	): Promise<void> {
		// The host socket is named after the desired-state id (phase 4: one socket per replica), the
		// same name `probeWorkloadHealth` dials.
		const socketPath = `${this.socketDir}/${workload.id}.sock`;
		try {
			const response = await this.doFetch('http://localhost/__skiff/scheduled', {
				method: 'POST',
				unix: socketPath,
				headers: {
					[FUNCTION_INTERNAL_HEADER]: FUNCTION_INTERNAL_VALUE,
					'x-skiff-cron': cron,
					'x-skiff-scheduled-time': String(due),
				},
				signal: AbortSignal.any([signal, AbortSignal.timeout(CRON_TIMEOUT_MS)]),
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				this.log(
					'warn',
					`Function ${workload.id} cron ${cron} failed: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
				);
			}
		} catch (error) {
			// A shutdown aborts the fetch; that is not a cron failure worth a warning.
			if (signal.aborted) return;
			this.log('warn', `Function ${workload.id} cron ${cron} failed: ${errorText(error)}`);
		}
	}

	private async loadCronState(): Promise<void> {
		if (this.cronStateLoaded) return;
		this.cronStateLoaded = true;
		if (this.statePath === null) return;
		let text: string;
		try {
			text = await fs.readFile(this.statePath, 'utf8');
		} catch (error) {
			if (!isNotFound(error))
				this.log('warn', `Function cron state is unreadable (${errorText(error)}); starting fresh`);
			return;
		}
		try {
			const parsed = JSON.parse(text) as unknown;
			const crons = (parsed as { crons?: unknown } | null)?.crons;
			if (!Array.isArray(crons)) throw new Error('crons is not an array');
			for (const value of crons) {
				if (typeof value !== 'object' || value === null) continue;
				const record = value as Record<string, unknown>;
				if (typeof record.workloadId !== 'string' || typeof record.cron !== 'string') continue;
				if (typeof record.lastFiredAt !== 'number' || !Number.isFinite(record.lastFiredAt)) continue;
				this.crons.set(`${record.workloadId}\n${record.cron}`, {
					workloadId: record.workloadId,
					cron: record.cron,
					lastFiredAt: record.lastFiredAt,
				});
			}
		} catch (error) {
			this.log('warn', `Function cron state is invalid (${errorText(error)}); starting fresh`);
		}
	}

	/** Write the cursor atomically, after every tick that changed it. */
	private async persistCronState(): Promise<void> {
		if (this.statePath === null) return;
		const body: CronStateFile = {
			version: CRON_STATE_VERSION,
			crons: [...this.crons.values()].sort((a, b) =>
				a.workloadId === b.workloadId
					? a.cron.localeCompare(b.cron)
					: a.workloadId.localeCompare(b.workloadId),
			),
		};
		try {
			await atomicWriteFile(this.statePath, `${JSON.stringify(body)}\n`);
		} catch (error) {
			this.log('warn', `Function cron state write failed: ${errorText(error)}`);
		}
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
