import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	agentJobHeartbeatResponseSchema,
	agentJobLeaseSchema,
	jobLimits,
	levelForPriority,
	parseLogLine,
	type AgentJobLease,
	type AgentJobResult,
	type AgentJobRun,
	type DesiredState,
	type RuntimeLogBatch,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@yoal/contracts';
import type { HelperLogResult, LogReadOptions } from './helper-client.ts';

/**
 * Job runs (plan 09): the agent's half of app cron jobs and one-off commands.
 *
 * The control plane queues runs bound to this node. This runner leases them (a long-poll while it
 * holds nothing), fetches the app's activation and asks the helper to start each one as a
 * transient unit. While runs are held it polls their status every couple of seconds, drains their
 * output to `/api/agent/logs` tagged with the run id, and heartbeats every `heartbeatSeconds`;
 * the heartbeat's answer names runs to stop (cancelled or replaced). A run that outlives its
 * timeout plus a grace period is stopped here too, in case `RuntimeMaxSec` did not fire. On exit
 * it reports the outcome, then removes the unit and its files.
 *
 * Held runs, their log cursors and unsent results are persisted in `jobs-state.json`, so an agent
 * restart picks up where it left off instead of losing a run or reporting it twice.
 */

export interface HelperJobStatus {
	runId: string;
	outcome: 'running' | 'succeeded' | 'failed' | 'timeout' | 'killed' | 'not-found';
	exitCode: number | null;
	signal: number | null;
	startedAt: number | null;
	finishedAt: number | null;
}

export interface HelperJobApi {
	startJob(input: {
		run: { runId: string; command: string[]; timeoutSeconds: number };
		workload: WorkloadDesired;
		activation: WorkloadActivation;
	}): Promise<HelperJobStatus>;
	jobStatus(runId: string, timeoutSeconds?: number): Promise<HelperJobStatus>;
	jobLogs(runId: string, options?: LogReadOptions): Promise<HelperLogResult>;
	stopJob(runId: string, force?: boolean): Promise<void>;
	removeJob(runId: string): Promise<void>;
}

export interface JobRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: HelperJobApi;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	/** `<dataDir>/jobs-state.json`; null keeps state in memory (tests). */
	statePath: string | null;
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Seconds the control plane holds an empty lease open. */
	leaseWaitSeconds?: number;
	/** How often held runs are polled. */
	pollMs?: number;
}

/** One run this node holds. */
export interface HeldRun {
	runId: string;
	workloadId: string;
	command: string[];
	timeoutSeconds: number;
	/** Agent clock when the helper accepted it. */
	startedAt: number | null;
	cursor: string | null;
	/** Why the agent asked the unit to stop, and when (escalates to SIGKILL after the grace). */
	stop: { reason: 'cancel' | 'timeout'; at: number; forced: boolean } | null;
	/** The outcome, kept until the control plane has it. */
	result: AgentJobResult | null;
}

interface StateFile {
	version: 1;
	runs: HeldRun[];
}

const IDLE_POLL_MS = 5_000;
const POLL_MS = 2_000;
const ERROR_BACKOFF_MAX_MS = 30_000;
const LINES_PER_READ = 500;
const LINES_PER_POST = 400;
/** systemd's stop timeout on the helper side; SIGKILL follows if the run is still there. */
const STOP_GRACE_MS = 30_000;
/** systemd's exit statuses for a command that never ran (`systemd.exec(5)`, 200–243). */
const EXEC_STATUS: Record<number, string> = {
	200: 'the working directory could not be entered (CHDIR)',
	203: 'the program was not found or could not be executed (EXEC); is it on PATH or in the release?',
	217: 'the dynamic user could not be set up (USER)',
	226: 'the sandbox could not be set up (NAMESPACE)',
	243: 'a credential could not be loaded (CREDENTIALS)',
};

export class JobRunner {
	private readonly controlUrl: string;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly now: () => number;
	private readonly log: NonNullable<JobRunnerOptions['log']>;
	private readonly leaseWaitSeconds: number;
	private readonly pollMs: number;
	private readonly held = new Map<string, HeldRun>();
	private loaded = false;
	private lastHeartbeat = Number.NEGATIVE_INFINITY;
	private controlPlaneHasJobs = true;

	constructor(private readonly options: JobRunnerOptions) {
		this.controlUrl = options.controlUrl.replace(/\/$/, '');
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.leaseWaitSeconds = options.leaseWaitSeconds ?? 20;
		this.pollMs = options.pollMs ?? POLL_MS;
	}

	/** Runs this node holds right now (tests and `/healthz`). */
	heldRuns(): HeldRun[] {
		return [...this.held.values()];
	}

	/** Lease, start, watch and report until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			let wait = IDLE_POLL_MS;
			try {
				const state = getState();
				const workloads = jobWorkloads(state);
				await this.tick(workloads, signal);
				// Held runs are polled; with nothing held the lease itself long-polls.
				wait = this.held.size > 0 ? this.pollMs : workloads.size > 0 && this.controlPlaneHasJobs ? 0 : IDLE_POLL_MS;
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				wait = Math.min(1000 * 2 ** failures, ERROR_BACKOFF_MAX_MS);
				this.log('warn', `Jobs failed: ${errorText(error)}`);
			}
			if (wait > 0) await this.doSleep(wait, signal).catch(() => undefined);
		}
	}

	/** One round: lease new runs, watch held ones, heartbeat when due. */
	async tick(workloads: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<void> {
		await this.load();
		if (workloads.size > 0 && this.held.size < jobLimits.concurrentPerNode) {
			const lease = await this.lease(this.held.size > 0 ? 0 : this.leaseWaitSeconds, signal);
			for (const run of lease.runs) await this.start(run, workloads, signal);
		}
		if (this.held.size === 0) return;
		if (this.now() - this.lastHeartbeat >= jobLimits.heartbeatSeconds * 1000) await this.heartbeat(signal);
		for (const run of [...this.held.values()]) await this.watch(run, signal);
	}

	// ---------------------------------------------------------------- lifecycle

	private async start(run: AgentJobRun, workloads: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<void> {
		if (this.held.has(run.runId)) return;
		const held: HeldRun = {
			runId: run.runId,
			workloadId: run.workloadId,
			command: run.command,
			timeoutSeconds: run.timeoutSeconds,
			startedAt: null,
			cursor: null,
			stop: null,
			result: null,
		};
		this.held.set(run.runId, held);
		const workload = workloads.get(run.workloadId);
		try {
			if (!workload) throw new Error('The app is not running on this node any more.');
			const activation = await this.options.fetchActivation(workload.id, signal);
			await this.options.helper.startJob({
				run: { runId: run.runId, command: run.command, timeoutSeconds: run.timeoutSeconds },
				workload,
				activation,
			});
			held.startedAt = this.now();
			this.log('info', `Job run ${run.runId} started for ${workload.projectSlug}`);
		} catch (error) {
			held.result = { runId: run.runId, status: 'failed', exitCode: null, startedAt: null, finishedAt: this.now(), error: `Could not start: ${errorText(error)}`.slice(0, 2000) };
		}
		await this.persist();
	}

	private async watch(run: HeldRun, signal: AbortSignal): Promise<void> {
		if (!run.result) {
			let status: HelperJobStatus;
			try {
				status = await this.options.helper.jobStatus(run.runId, run.timeoutSeconds);
			} catch (error) {
				this.log('warn', `Job run ${run.runId}: status failed: ${errorText(error)}`);
				return;
			}
			await this.drain(run, signal).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: log drain failed: ${errorText(error)}`));
			if (status.outcome === 'running') {
				await this.enforce(run);
				return;
			}
			run.result = this.resultFor(run, status);
			await this.persist();
		}
		if (!(await this.report(run.result, signal))) return;
		await this.options.helper.removeJob(run.runId).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: cleanup failed: ${errorText(error)}`));
		this.held.delete(run.runId);
		await this.persist();
	}

	/** The agent's own timeout (in case `RuntimeMaxSec` did not fire) and SIGKILL escalation. */
	private async enforce(run: HeldRun): Promise<void> {
		const now = this.now();
		if (!run.stop && run.startedAt !== null && now - run.startedAt > (run.timeoutSeconds + jobLimits.timeoutGraceSeconds) * 1000)
			await this.requestStop(run, 'timeout');
		else if (run.stop && !run.stop.forced && now - run.stop.at > STOP_GRACE_MS) {
			await this.options.helper.stopJob(run.runId, true).catch(() => undefined);
			run.stop.forced = true;
			await this.persist();
		}
	}

	private async requestStop(run: HeldRun, reason: 'cancel' | 'timeout'): Promise<void> {
		if (run.stop) return;
		run.stop = { reason, at: this.now(), forced: false };
		await this.persist();
		await this.options.helper.stopJob(run.runId).catch((error: unknown) => this.log('warn', `Job run ${run.runId}: stop failed: ${errorText(error)}`));
	}

	/** Map the helper's reading (and why the agent stopped it) onto the wire statuses. */
	resultFor(run: HeldRun, status: HelperJobStatus): AgentJobResult {
		const base = { runId: run.runId, exitCode: status.exitCode, startedAt: status.startedAt ?? run.startedAt, finishedAt: status.finishedAt ?? this.now() };
		const stopped = run.stop?.reason;
		if (status.outcome === 'succeeded') return { ...base, status: 'succeeded', error: null };
		if (stopped === 'cancel') return { ...base, status: 'cancelled', error: 'Cancelled.' };
		if (status.outcome === 'timeout' || stopped === 'timeout')
			return { ...base, status: 'timeout', error: `Timed out after ${run.timeoutSeconds} s.` };
		if (status.outcome === 'not-found')
			return { ...base, status: 'failed', error: 'The run’s unit is gone from this node (was the node restarted?).' };
		if (status.outcome === 'killed') return { ...base, status: 'failed', error: `Killed by signal ${status.signal ?? '?'} (out of memory?).` };
		const exec = status.exitCode !== null ? EXEC_STATUS[status.exitCode] : undefined;
		return { ...base, status: 'failed', error: exec ? `The command did not start: ${exec}` : `Exited with status ${status.exitCode ?? '?'}.` };
	}

	/** Forward new journal lines for the run, then advance its cursor. */
	private async drain(run: HeldRun, signal: AbortSignal): Promise<void> {
		for (let page = 0; page < 20; page += 1) {
			const result = await this.options.helper.jobLogs(run.runId, { ...(run.cursor ? { cursor: run.cursor } : {}), lines: LINES_PER_READ });
			if (result.entries.length === 0) return;
			const lines = result.entries.map((entry) => {
				const parsed = parseLogLine(entry.message);
				return {
					ts: parsed.ts ?? entry.ts,
					stream: (entry.priority <= 3 ? 'stderr' : 'stdout') as 'stdout' | 'stderr',
					level: parsed.level ?? levelForPriority(entry.priority),
					message: parsed.message,
				};
			});
			for (let index = 0; index < lines.length; index += LINES_PER_POST) {
				const batch: RuntimeLogBatch = { workloadId: run.workloadId, jobRunId: run.runId, lines: lines.slice(index, index + LINES_PER_POST) };
				await this.post('/api/agent/logs', batch, signal);
			}
			run.cursor = result.nextCursor ?? run.cursor;
			await this.persist();
			if (result.entries.length < LINES_PER_READ) return;
		}
	}

	// ---------------------------------------------------------------- protocol

	private async lease(waitSeconds: number, signal: AbortSignal): Promise<AgentJobLease> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/jobs/lease?wait=${waitSeconds}`, {
			method: 'POST',
			headers: this.headers(),
			body: '{}',
			signal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 15) * 1000)]),
		});
		if (response.status === 404) {
			// A control plane that predates jobs: nothing will ever be queued, so ask rarely.
			this.controlPlaneHasJobs = false;
			await this.doSleep(60_000, signal).catch(() => undefined);
			return { runs: [], heartbeatSeconds: jobLimits.heartbeatSeconds };
		}
		if (!response.ok) throw new Error(`jobs/lease answered ${response.status}`);
		this.controlPlaneHasJobs = true;
		return agentJobLeaseSchema.parse(await response.json());
	}

	private async heartbeat(signal: AbortSignal): Promise<void> {
		const running = [...this.held.values()].filter((run) => !run.result);
		this.lastHeartbeat = this.now();
		if (running.length === 0) return;
		const response = await this.doFetch(`${this.controlUrl}/api/agent/jobs/heartbeat`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ runIds: running.map((run) => run.runId) }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) throw new Error(`jobs/heartbeat answered ${response.status}`);
		const { stop } = agentJobHeartbeatResponseSchema.parse(await response.json());
		for (const runId of stop) {
			const run = this.held.get(runId);
			if (run && !run.result) await this.requestStop(run, 'cancel');
		}
	}

	/** True once the control plane has the result. */
	private async report(result: AgentJobResult, signal: AbortSignal): Promise<boolean> {
		try {
			await this.post('/api/agent/jobs/result', result, signal);
			return true;
		} catch (error) {
			this.log('warn', `Job run ${result.runId}: report failed, will retry: ${errorText(error)}`);
			return false;
		}
	}

	private async post(path: string, body: unknown, signal: AbortSignal): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}${path}`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`${path} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
	}

	private headers(): Record<string, string> {
		return { authorization: `Bearer ${this.options.nodeToken}`, 'content-type': 'application/json' };
	}

	// ---------------------------------------------------------------- state

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.statePath) return;
		let text: string;
		try {
			text = await fs.readFile(this.options.statePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log('warn', `Job state is unreadable (${errorText(error)}); starting fresh`);
			return;
		}
		try {
			const parsed = JSON.parse(text) as Partial<StateFile>;
			for (const run of parsed.runs ?? []) {
				if (typeof run?.runId !== 'string' || typeof run.workloadId !== 'string' || !Array.isArray(run.command)) continue;
				this.held.set(run.runId, {
					runId: run.runId,
					workloadId: run.workloadId,
					command: run.command,
					timeoutSeconds: Number(run.timeoutSeconds) || jobLimits.maxTimeoutSeconds,
					startedAt: typeof run.startedAt === 'number' ? run.startedAt : null,
					cursor: typeof run.cursor === 'string' ? run.cursor : null,
					stop: run.stop ?? null,
					result: run.result ?? null,
				});
			}
			if (this.held.size > 0) this.log('info', `Resuming ${this.held.size} job run(s) from ${this.options.statePath}`);
		} catch (error) {
			this.log('warn', `Job state is invalid (${errorText(error)}); starting fresh`);
		}
	}

	private async persist(): Promise<void> {
		const path = this.options.statePath;
		if (!path) return;
		const body: StateFile = { version: 1, runs: [...this.held.values()] };
		const temp = `${path}.tmp`;
		await fs.mkdir(dirname(path), { recursive: true });
		await fs.writeFile(temp, JSON.stringify(body), { mode: 0o600 });
		await fs.rename(temp, path);
	}
}

/** App workloads on this node that can run jobs, by desired-state id. */
export function jobWorkloads(state: DesiredState | null): Map<string, WorkloadDesired> {
	const out = new Map<string, WorkloadDesired>();
	for (const workload of state?.workloads ?? []) {
		if (workload.runtime !== 'process' && workload.runtime !== 'container') continue;
		if (workload.database || workload.objectStorage || workload.broker || workload.runner || workload.function) continue;
		out.set(workload.id, workload);
	}
	return out;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
