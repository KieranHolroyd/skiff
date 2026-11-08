import { and, eq } from 'drizzle-orm';
import { nodes, workloadReplicas, workloads } from '@skiff/db';
import {
	JOBS_CAPABILITY,
	jobCreateSchema,
	jobLimits,
	jobOneOffSchema,
	jobRunDone,
	jobUpdateSchema,
	type AgentJobHeartbeat,
	type AgentJobHeartbeatResponse,
	type AgentJobLease,
	type AgentJobResult,
	type JobConcurrency,
	type JobRunStatus,
	type JobRunTrigger,
	type JobRunView,
	type JobView,
	type LogQuery,
	type LogQueryResult,
	type Principal,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { parseCron } from './cron.ts';
import { ConflictError, CoreError, NotFoundError, QuotaError, ValidationError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import { nextRun, retryDelayMs } from './scheduler.ts';
import { newId, parseJson } from './util.ts';

/**
 * Jobs (plan 09, docs/SCHEDULER.md §Jobs): cron jobs and one-off commands on process and
 * container projects.
 *
 * - **Definitions.** A job is a name, an argv command, an optional five-field UTC cron, a timeout,
 *   a concurrency policy and a retry count. A null schedule is a job you only run by hand.
 * - **Runs.** Each execution is a `job_runs` row bound to the node that hosts the project (replica
 *   0). `scheduleDue` fires due cron jobs once per due time, never replaying missed occurrences: a
 *   conditional update on `next_run_at` makes two control planes fire it once. Manual runs, one-off
 *   commands and retries insert the same rows.
 * - **Node protocol.** The node's agent leases queued runs (`lease`), reports the ones it holds
 *   (`heartbeat`, which answers with runs to stop) and posts the exit (`complete`), like node tasks
 *   (D124). Output arrives on the runtime log drain tagged with the run id.
 * - **Sweep.** Unclaimed runs fail after `pickupMs`, silent ones after `leaseSeconds`; a job keeps
 *   its newest `runsKept` finished runs.
 * - **Quota.** The service counts `jobs` and `jobRunsPerDay` for `QuotaService`, checks
 *   `assertCanCreateJob` before a create and `assertCanRunJob` before every run. A refused
 *   scheduled run (or retry) is recorded `skipped` with the reason, never thrown.
 */

interface JobRow {
	id: string;
	org_id: string;
	project_id: string;
	name: string;
	command_json: string;
	schedule: string | null;
	timeout_seconds: number;
	concurrency: JobConcurrency;
	max_retries: number;
	enabled: number;
	next_run_at: number | null;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface RunRow {
	id: string;
	org_id: string;
	project_id: string;
	job_id: string | null;
	job_name: string | null;
	trigger: JobRunTrigger;
	attempt: number;
	retry_of: string | null;
	status: JobRunStatus;
	command_json: string;
	timeout_seconds: number;
	node_id: string | null;
	workload_id: string | null;
	deployment_id: string | null;
	exit_code: number | null;
	error: string | null;
	cancel_requested: number;
	leased_until: number;
	created_by: string | null;
	created_at: number;
	run_at: number;
	started_at: number | null;
	finished_at: number | null;
}

/** Where a project's runs execute: replica 0's node and desired-state id. */
interface RunTarget {
	nodeId: string;
	workloadId: string;
	deploymentId: string;
}

interface InsertRun {
	orgId: string;
	projectId: string;
	job: JobRow | null;
	trigger: JobRunTrigger;
	attempt?: number;
	retryOf?: string | null;
	command: string[];
	timeoutSeconds: number;
	target: RunTarget | null;
	status: JobRunStatus;
	error?: string | null;
	createdBy: string | null;
	runAt: number;
}

/** A job's output is capped per run; the rest of a chatty run is dropped with one notice. */
export const JOB_LOG_LINES_MAX = 10_000;
const LIST_RUNS_DEFAULT = 50;
const LIST_RUNS_MAX = 200;
const ACTIVE = "('queued', 'running')";

export class JobService {
	constructor(private readonly ctx: CoreContext) {
		ctx.quota.registerCounter('jobs', ({ orgId, projectId }) =>
			projectId
				? this.count('SELECT COUNT(*) AS n FROM jobs WHERE org_id = ? AND project_id = ?', orgId, projectId)
				: this.count('SELECT COUNT(*) AS n FROM jobs WHERE org_id = ?', orgId),
		);
		// Skipped runs never ran, so they do not use the day's budget.
		ctx.quota.registerCounter('jobRunsPerDay', ({ orgId, projectId, since }) =>
			projectId
				? this.count(
						"SELECT COUNT(*) AS n FROM job_runs WHERE org_id = ? AND project_id = ? AND created_at >= ? AND status != 'skipped'",
						orgId,
						projectId,
						since,
					)
				: this.count("SELECT COUNT(*) AS n FROM job_runs WHERE org_id = ? AND created_at >= ? AND status != 'skipped'", orgId, since),
		);
	}

	/** `SKIFF_FEATURE_JOBS` (off by default). Off: no new jobs or runs, and the scheduler stops. */
	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'JOBS');
	}

	private assertEnabled(): void {
		if (!this.enabled()) throw new CoreError('feature_disabled', 'Jobs are not enabled on this platform (SKIFF_FEATURE_JOBS).', 404);
	}

	// ---------------------------------------------------------------- definitions

	list(principal: Principal, project: ProjectRow): JobView[] {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const rows = this.ctx.sqlite
			.query<JobRow, [string, string]>('SELECT * FROM jobs WHERE org_id = ? AND project_id = ? ORDER BY name')
			.all(principal.orgId, project.id);
		return rows.map((row) => this.view(row, project.slug));
	}

	get(principal: Principal, project: ProjectRow, name: string): JobView {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		return this.view(this.requireJob(principal, project, name), project.slug);
	}

	create(principal: Principal, project: ProjectRow, raw: unknown): JobView {
		this.assertEnabled();
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const input = jobCreateSchema.parse(raw);
		this.requireJobRuntime(project);
		// `…/jobs/runs` is the project's run history in the REST API.
		if (input.name === 'runs') throw new ValidationError('"runs" is reserved; pick another job name.');
		if (input.schedule) assertSchedule(input.schedule);
		if (this.findJob(project.id, input.name)) throw new ConflictError(`${project.slug} already has a job named "${input.name}".`);
		const defined = this.count('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?', project.id);
		if (defined >= jobLimits.perProject)
			throw new ConflictError(`${project.slug} already has ${defined} jobs, the most a project can have. Delete one first.`);
		this.ctx.quota.assertCanCreateJob(principal.orgId, project.id);
		const now = this.ctx.now();
		const id = newId('job_');
		const next = input.enabled && input.schedule ? nextRun(input.schedule, now) : null;
		this.ctx.sqlite.run(
			`INSERT INTO jobs (id, org_id, project_id, name, command_json, schedule, timeout_seconds, concurrency, max_retries, enabled, next_run_at, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				principal.orgId,
				project.id,
				input.name,
				JSON.stringify(input.command),
				input.schedule,
				input.timeoutSeconds,
				input.concurrency,
				input.maxRetries,
				input.enabled ? 1 : 0,
				next,
				principal.userId,
				now,
				now,
			],
		);
		this.audit(principal, 'job.create', id, {
			project: project.slug,
			name: input.name,
			schedule: input.schedule,
			...commandSummary(input.command),
		});
		return this.view(this.jobById(id)!, project.slug);
	}

	update(principal: Principal, project: ProjectRow, name: string, raw: unknown): JobView {
		this.assertEnabled();
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const input = jobUpdateSchema.parse(raw);
		const row = this.requireJob(principal, project, name);
		if (input.schedule) assertSchedule(input.schedule);
		const schedule = input.schedule === undefined ? row.schedule : input.schedule;
		const enabled = input.enabled === undefined ? row.enabled === 1 : input.enabled;
		const now = this.ctx.now();
		// A changed schedule or a resume counts from now; an untouched one keeps its due time.
		const rescheduled = input.schedule !== undefined || (input.enabled === true && row.enabled === 0);
		const next = !enabled || !schedule ? null : rescheduled || row.next_run_at === null ? nextRun(schedule, now) : row.next_run_at;
		this.ctx.sqlite.run(
			'UPDATE jobs SET command_json = ?, schedule = ?, timeout_seconds = ?, concurrency = ?, max_retries = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
			[
				input.command ? JSON.stringify(input.command) : row.command_json,
				schedule,
				input.timeoutSeconds ?? row.timeout_seconds,
				input.concurrency ?? row.concurrency,
				input.maxRetries ?? row.max_retries,
				enabled ? 1 : 0,
				next,
				now,
				row.id,
			],
		);
		const action = input.enabled === false && Object.keys(input).length === 1 ? 'job.pause' : input.enabled === true && Object.keys(input).length === 1 ? 'job.resume' : 'job.update';
		this.audit(principal, action, row.id, {
			project: project.slug,
			name,
			...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'command')),
			...(input.command ? commandSummary(input.command) : {}),
		});
		return this.view(this.jobById(row.id)!, project.slug);
	}

	/** Pause or resume. A paused job keeps its history and can still be run by hand. */
	setEnabled(principal: Principal, project: ProjectRow, name: string, enabled: boolean): JobView {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.requireJob(principal, project, name);
		if (enabled) this.assertEnabled();
		if ((row.enabled === 1) === enabled) return this.view(row, project.slug);
		const now = this.ctx.now();
		const next = enabled && row.schedule ? nextRun(row.schedule, now) : null;
		this.ctx.sqlite.run('UPDATE jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, next, now, row.id]);
		this.audit(principal, enabled ? 'job.resume' : 'job.pause', row.id, { project: project.slug, name });
		return this.view(this.jobById(row.id)!, project.slug);
	}

	/** Delete the definition and its history; a run in progress is asked to stop. */
	remove(principal: Principal, project: ProjectRow, name: string): { deleted: true; stopping: number } {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const row = this.requireJob(principal, project, name);
		const now = this.ctx.now();
		const stopping = this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				"UPDATE job_runs SET status = 'cancelled', finished_at = ?, error = 'The job was deleted.' WHERE job_id = ? AND status = 'queued'",
				[now, row.id],
			);
			const running = this.ctx.sqlite.run("UPDATE job_runs SET cancel_requested = 1 WHERE job_id = ? AND status = 'running'", [row.id]).changes;
			this.deleteRuns("job_id = ? AND status NOT IN ('queued', 'running')", [row.id]);
			this.ctx.sqlite.run('DELETE FROM jobs WHERE id = ?', [row.id]);
			return running;
		})();
		this.audit(principal, 'job.delete', row.id, { project: project.slug, name });
		return { deleted: true, stopping };
	}

	// ---------------------------------------------------------------- runs

	/** Run a job now, whatever its schedule or pause state. */
	run(principal: Principal, project: ProjectRow, name: string): JobRunView {
		this.assertEnabled();
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const job = this.requireJob(principal, project, name);
		const target = this.requireTarget(project);
		this.ctx.quota.assertCanRunJob(principal.orgId, project.id);
		const view = this.insertRun({
			orgId: principal.orgId,
			projectId: project.id,
			job,
			trigger: 'manual',
			command: parseJson<string[]>(job.command_json, []),
			timeoutSeconds: job.timeout_seconds,
			target,
			status: 'queued',
			createdBy: principal.userId,
			runAt: this.ctx.now(),
		});
		this.audit(principal, 'job.run', view.id, { project: project.slug, name });
		return view;
	}

	/** One command, now, against the current release. Not saved as a job. */
	runOneOff(principal: Principal, project: ProjectRow, raw: unknown): JobRunView {
		this.assertEnabled();
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const input = jobOneOffSchema.parse(raw);
		this.requireJobRuntime(project);
		const target = this.requireTarget(project);
		this.ctx.quota.assertCanRunJob(principal.orgId, project.id);
		const view = this.insertRun({
			orgId: principal.orgId,
			projectId: project.id,
			job: null,
			trigger: 'manual',
			command: input.command,
			timeoutSeconds: input.timeoutSeconds,
			target,
			status: 'queued',
			createdBy: principal.userId,
			runAt: this.ctx.now(),
		});
		this.audit(principal, 'job.run_once', view.id, { project: project.slug, ...commandSummary(input.command) });
		return view;
	}

	/** Newest first; `job` narrows to one job, `oneOff` to runs without one. */
	runs(principal: Principal, project: ProjectRow, options: { job?: string; oneOff?: boolean; limit?: number } = {}): JobRunView[] {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const limit = Math.max(1, Math.min(Math.floor(options.limit ?? LIST_RUNS_DEFAULT), LIST_RUNS_MAX));
		let rows: RunRow[];
		if (options.job) {
			const job = this.requireJob(principal, project, options.job);
			rows = this.ctx.sqlite
				.query<RunRow, [string, number]>('SELECT * FROM job_runs WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
				.all(job.id, limit);
		} else if (options.oneOff) {
			rows = this.ctx.sqlite
				.query<RunRow, [string, string, number]>(
					'SELECT * FROM job_runs WHERE org_id = ? AND project_id = ? AND job_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?',
				)
				.all(principal.orgId, project.id, limit);
		} else {
			rows = this.ctx.sqlite
				.query<RunRow, [string, string, number]>('SELECT * FROM job_runs WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
				.all(principal.orgId, project.id, limit);
		}
		return rows.map(runView);
	}

	getRun(principal: Principal, project: ProjectRow, runId: string): JobRunView {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		return runView(this.requireRun(principal, project, runId));
	}

	/** A queued run is cancelled at once; a running one is stopped by its node at the next heartbeat. */
	cancelRun(principal: Principal, project: ProjectRow, runId: string): JobRunView {
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const row = this.requireRun(principal, project, runId);
		if (jobRunDone(row.status)) return runView(row);
		const now = this.ctx.now();
		if (row.status === 'queued')
			this.ctx.sqlite.run("UPDATE job_runs SET status = 'cancelled', finished_at = ?, error = 'Cancelled before it started.' WHERE id = ? AND status = 'queued'", [now, row.id]);
		else this.ctx.sqlite.run('UPDATE job_runs SET cancel_requested = 1 WHERE id = ?', [row.id]);
		this.audit(principal, 'job.cancel', row.id, { project: project.slug, job: row.job_name });
		return runView(this.runById(row.id)!);
	}

	/** One run's output; the same `logs:read` check and cursor as project logs. */
	runLogs(principal: Principal, project: ProjectRow, runId: string, input: Omit<LogQuery, 'jobRunId'> = {}): LogQueryResult {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const row = this.requireRun(principal, project, runId);
		return this.ctx.logs.query(principal, project, { ...input, jobRunId: row.id });
	}

	/** Wait up to `timeoutMs` for the run to finish; returns whatever state it is in by then. */
	async wait(principal: Principal, project: ProjectRow, runId: string, timeoutMs: number): Promise<JobRunView> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		let current = this.getRun(principal, project, runId);
		while (!jobRunDone(current.status) && Date.now() < deadline) {
			await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
			current = this.getRun(principal, project, runId);
		}
		return current;
	}

	// ---------------------------------------------------------------- scheduler

	/**
	 * Fire every enabled job whose `next_run_at` has passed. The next fire is computed from now, so
	 * a control plane that was down runs a missed job once, not once per missed occurrence.
	 */
	scheduleDue(now = this.ctx.now()): { fired: number; skipped: number } {
		if (!this.enabled()) return { fired: 0, skipped: 0 };
		const due = this.ctx.sqlite
			.query<JobRow, [number]>(
				`SELECT jobs.* FROM jobs JOIN projects ON projects.id = jobs.project_id
				 WHERE jobs.enabled = 1 AND jobs.next_run_at IS NOT NULL AND jobs.next_run_at <= ? AND projects.deleted_at IS NULL
				 ORDER BY jobs.next_run_at LIMIT 500`,
			)
			.all(now);
		let fired = 0;
		let skipped = 0;
		for (const job of due) {
			const next = job.schedule ? nextRun(job.schedule, now) : null;
			// The conditional update is the claim: a second control plane in the same window gets nothing.
			const claimed = this.ctx.sqlite.run('UPDATE jobs SET next_run_at = ? WHERE id = ? AND next_run_at = ?', [next, job.id, job.next_run_at]).changes;
			if (claimed === 0) continue;
			const run = this.fireScheduled(job, now);
			if (run.status === 'skipped') skipped += 1;
			else fired += 1;
		}
		return { fired, skipped };
	}

	// ---------------------------------------------------------------- node protocol

	/** Queued runs due on this node, up to its free slots, leased to the caller. */
	lease(nodeId: string): AgentJobLease {
		const now = this.ctx.now();
		const running = this.count("SELECT COUNT(*) AS n FROM job_runs WHERE node_id = ? AND status = 'running'", nodeId);
		const free = Math.max(0, jobLimits.concurrentPerNode - running);
		const runs: AgentJobLease['runs'] = [];
		if (free > 0) {
			const rows = this.ctx.sqlite
				.query<RunRow, [string, number, number]>(
					"SELECT * FROM job_runs WHERE node_id = ? AND status = 'queued' AND run_at <= ? ORDER BY run_at, created_at LIMIT ?",
				)
				.all(nodeId, now, free);
			const until = now + jobLimits.leaseSeconds * 1000;
			const claim = this.ctx.sqlite.prepare(
				"UPDATE job_runs SET status = 'running', leased_until = ?, started_at = ?, deployment_id = COALESCE(?, deployment_id) WHERE id = ? AND status = 'queued'",
			);
			for (const row of rows) {
				// The node runs whatever release its desired state has now; record that one.
				const deploymentId = row.workload_id ? this.workloadDeployment(row.workload_id) : null;
				if (claim.run(until, now, deploymentId, row.id).changes === 0) continue;
				runs.push({
					runId: row.id,
					workloadId: row.workload_id!,
					command: parseJson<string[]>(row.command_json, []),
					timeoutSeconds: row.timeout_seconds,
				});
			}
		}
		return { runs, heartbeatSeconds: jobLimits.heartbeatSeconds };
	}

	/** True when a lease right now would hand out something (the long-poll checks this cheaply). */
	hasQueued(nodeId: string): boolean {
		return (
			this.ctx.sqlite
				.query<{ n: number }, [string, number]>("SELECT 1 AS n FROM job_runs WHERE node_id = ? AND status = 'queued' AND run_at <= ? LIMIT 1")
				.get(nodeId, this.ctx.now()) !== null
		);
	}

	/** Extend the leases the node still holds; name the runs it should stop. */
	heartbeat(nodeId: string, input: AgentJobHeartbeat): AgentJobHeartbeatResponse {
		const now = this.ctx.now();
		const until = now + jobLimits.leaseSeconds * 1000;
		const stop: string[] = [];
		for (const runId of input.runIds) {
			const row = this.runById(runId);
			if (!row || row.node_id !== nodeId || row.status !== 'running' || row.cancel_requested === 1) {
				stop.push(runId);
				continue;
			}
			this.ctx.sqlite.run("UPDATE job_runs SET leased_until = ? WHERE id = ? AND status = 'running'", [until, runId]);
		}
		return { stop };
	}

	complete(nodeId: string, input: AgentJobResult): { ok: true; retry: string | null } {
		const row = this.runById(input.runId);
		// Another node's run, or one the sweep already settled: ignore.
		if (!row || row.node_id !== nodeId || row.status !== 'running') return { ok: true, retry: null };
		const status: JobRunStatus = row.cancel_requested === 1 && input.status !== 'succeeded' ? 'cancelled' : input.status;
		const error = input.error?.slice(0, 2000) ?? (status === 'failed' && input.exitCode !== null ? `Exited with status ${input.exitCode}.` : null);
		const finishedAt = this.ctx.now();
		this.ctx.sqlite.run(
			"UPDATE job_runs SET status = ?, exit_code = ?, error = ?, started_at = COALESCE(?, started_at), finished_at = ?, leased_until = 0 WHERE id = ? AND status = 'running'",
			[status, input.exitCode, error, input.startedAt, finishedAt, row.id],
		);
		const retry = status === 'failed' || status === 'timeout' ? this.retry(row, finishedAt) : null;
		return { ok: true, retry: retry?.id ?? null };
	}

	/**
	 * May this node post output for this run under this workload? The log drain uses it so an agent
	 * can only write into its own runs (any status: the last lines arrive after the exit).
	 */
	runForLogs(nodeId: string, runId: string, workloadId: string): { orgId: string; projectId: string; deploymentId: string | null } | null {
		const row = this.runById(runId);
		if (!row || row.node_id !== nodeId || row.workload_id !== workloadId) return null;
		return { orgId: row.org_id, projectId: row.project_id, deploymentId: row.deployment_id };
	}

	/** Maintenance: fail what no node picked up or reported, trim history, drop orphans. */
	sweep(now = this.ctx.now()): { failed: number; removed: number } {
		let failed = 0;
		const unclaimed = this.ctx.sqlite
			.query<RunRow, [number]>("SELECT * FROM job_runs WHERE status = 'queued' AND run_at <= ?")
			.all(now - jobLimits.pickupMs);
		for (const row of unclaimed) {
			const changed = this.ctx.sqlite.run(
				"UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'The node did not pick this run up. Is it online and on a current agent?' WHERE id = ? AND status = 'queued'",
				[now, row.id],
			).changes;
			if (changed) {
				failed += 1;
				this.retry(row, now);
			}
		}
		const lost = this.ctx.sqlite.query<RunRow, [number]>("SELECT * FROM job_runs WHERE status = 'running' AND leased_until <= ?").all(now);
		for (const row of lost) {
			const cancelled = row.cancel_requested === 1;
			const changed = this.ctx.sqlite.run(
				"UPDATE job_runs SET status = ?, finished_at = ?, leased_until = 0, error = ? WHERE id = ? AND status = 'running'",
				[
					cancelled ? 'cancelled' : 'failed',
					now,
					cancelled ? 'Cancelled; the node did not confirm it stopped.' : 'The node stopped reporting this run (agent restart or node offline).',
					row.id,
				],
			).changes;
			if (changed) {
				failed += 1;
				if (!cancelled) this.retry(row, now);
			}
		}
		let removed = 0;
		// A purged project, or a deleted job whose last runs have now finished.
		this.ctx.sqlite.run('DELETE FROM jobs WHERE project_id NOT IN (SELECT id FROM projects)');
		removed += this.deleteRuns(
			`project_id NOT IN (SELECT id FROM projects) OR (job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM jobs) AND status NOT IN ${ACTIVE})`,
			[],
		);
		// Newest `runsKept` finished runs per job, and per project for one-off runs.
		removed += this.deleteRuns(
			`id IN (SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(job_id, 'project:' || project_id) ORDER BY created_at DESC, rowid DESC) AS position
				FROM job_runs WHERE status NOT IN ${ACTIVE}
			) WHERE position > ?)`,
			[jobLimits.runsKept],
		);
		return { failed, removed };
	}

	// ---------------------------------------------------------------- internals

	private fireScheduled(job: JobRow, now: number): JobRunView {
		const base = {
			orgId: job.org_id,
			projectId: job.project_id,
			job,
			trigger: 'schedule' as const,
			command: parseJson<string[]>(job.command_json, []),
			timeoutSeconds: job.timeout_seconds,
			createdBy: null,
			runAt: now,
		};
		const active = this.ctx.sqlite
			.query<RunRow, [string]>(`SELECT * FROM job_runs WHERE job_id = ? AND status IN ${ACTIVE}`)
			.all(job.id);
		if (active.length > 0) {
			if (job.concurrency === 'forbid')
				return this.insertRun({ ...base, target: null, status: 'skipped', error: 'The previous run was still going (concurrency: forbid).' });
			if (job.concurrency === 'replace') {
				this.ctx.sqlite.run(
					"UPDATE job_runs SET status = 'cancelled', finished_at = ?, error = 'Replaced by a newer scheduled run.' WHERE job_id = ? AND status = 'queued'",
					[now, job.id],
				);
				this.ctx.sqlite.run("UPDATE job_runs SET cancel_requested = 1 WHERE job_id = ? AND status = 'running'", [job.id]);
			}
		}
		const blocked = this.blocked(job.org_id, job.project_id);
		if (blocked) return this.insertRun({ ...base, target: null, status: 'skipped', error: blocked });
		const target = this.targetOrError(job.project_id);
		if ('error' in target) return this.insertRun({ ...base, target: null, status: 'failed', error: target.error });
		return this.insertRun({ ...base, target, status: 'queued' });
	}

	/** Queue the next attempt of a failed run when its job still wants one. */
	private retry(row: RunRow, now: number): JobRunView | null {
		if (!row.job_id) return null;
		const job = this.jobById(row.job_id);
		if (!job || job.enabled !== 1 || row.attempt > job.max_retries) return null;
		const base = {
			orgId: row.org_id,
			projectId: row.project_id,
			job,
			trigger: 'retry' as const,
			attempt: row.attempt + 1,
			retryOf: row.retry_of ?? row.id,
			command: parseJson<string[]>(job.command_json, []),
			timeoutSeconds: job.timeout_seconds,
			createdBy: row.created_by,
			runAt: now + retryDelayMs(row.attempt),
		};
		const blocked = this.blocked(row.org_id, row.project_id);
		if (blocked) return this.insertRun({ ...base, target: null, status: 'skipped', error: blocked });
		const target = this.targetOrError(row.project_id);
		if ('error' in target) return this.insertRun({ ...base, target: null, status: 'failed', error: target.error });
		return this.insertRun({ ...base, target, status: 'queued' });
	}

	/** The quota's refusal as a message, or null when the run may go ahead. */
	private blocked(orgId: string, projectId: string): string | null {
		try {
			this.ctx.quota.assertCanRunJob(orgId, projectId);
			return null;
		} catch (error) {
			if (error instanceof QuotaError) return error.message;
			throw error;
		}
	}

	private insertRun(input: InsertRun): JobRunView {
		const id = `jr_${newId().slice(0, 32)}`;
		const now = this.ctx.now();
		const finished = jobRunDone(input.status) ? now : null;
		this.ctx.sqlite.run(
			`INSERT INTO job_runs (id, org_id, project_id, job_id, job_name, trigger, attempt, retry_of, status, command_json, timeout_seconds,
			   node_id, workload_id, deployment_id, error, created_by, created_at, run_at, finished_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.orgId,
				input.projectId,
				input.job?.id ?? null,
				input.job?.name ?? null,
				input.trigger,
				input.attempt ?? 1,
				input.retryOf ?? null,
				input.status,
				JSON.stringify(input.command),
				input.timeoutSeconds,
				input.target?.nodeId ?? null,
				input.target?.workloadId ?? null,
				input.target?.deploymentId ?? null,
				input.error ?? null,
				input.createdBy,
				now,
				input.runAt,
				finished,
			],
		);
		return runView(this.runById(id)!);
	}

	private requireJobRuntime(project: ProjectRow): void {
		const runtime = effectiveRuntime(project);
		if (runtime === 'process' || runtime === 'container') return;
		if (runtime === 'function')
			throw new ValidationError(`${project.slug} is a function. Functions run on a schedule with cron triggers in their wrangler config, not jobs.`);
		throw new ValidationError(`${project.slug} is a static site, which has no process to run a command in. Jobs run on process and container projects.`);
	}

	/** Refuse up front when nothing could run the command. */
	private requireTarget(project: ProjectRow): RunTarget {
		this.requireJobRuntime(project);
		const target = this.targetOrError(project.id, project.slug);
		if ('error' in target) throw new ConflictError(target.error);
		return target;
	}

	private targetOrError(projectId: string, slug?: string): RunTarget | { error: string } {
		const label = slug ?? 'The project';
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, projectId)).get();
		if (!row) return { error: `${label} has no running deployment yet. Deploy it first.` };
		if ((row.runtimeName ?? row.runtime) === 'function') return { error: `${label} is a function; jobs run on process and container projects.` };
		const spec = parseJson<{ runner?: unknown }>(row.specJson, {});
		if (spec.runner) return { error: `${label} is a CI runner pool, which does not run jobs.` };
		const replica = this.ctx.db
			.select({ nodeId: workloadReplicas.nodeId })
			.from(workloadReplicas)
			.where(and(eq(workloadReplicas.workloadId, row.id), eq(workloadReplicas.replicaIndex, 0)))
			.get();
		const nodeId = replica?.nodeId ?? row.nodeId;
		if (!nodeId) return { error: `${label} is not placed on a node yet.` };
		const node = this.ctx.db
			.select({ name: nodes.name, status: nodes.status, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (!node) return { error: `${label} is placed on a node that no longer exists.` };
		const nodeLabel = node.name ?? nodeId;
		if (node.status === 'offline') return { error: `${nodeLabel} is offline, so it cannot run the job.` };
		if (!parseJson<string[]>(node.capabilitiesJson, []).includes(JOBS_CAPABILITY))
			return { error: `${nodeLabel} runs an agent that predates jobs. Update the node first.` };
		// Replica 0's desired-state id is the workload id itself (workloadReplicaId(id, 0)).
		return { nodeId, workloadId: row.id, deploymentId: row.deploymentId };
	}

	private workloadDeployment(workloadId: string): string | null {
		return this.ctx.db.select({ deploymentId: workloads.deploymentId }).from(workloads).where(eq(workloads.id, workloadId)).get()?.deploymentId ?? null;
	}

	private requireJob(principal: Principal, project: ProjectRow, name: string): JobRow {
		const row = this.findJob(project.id, name);
		if (!row || row.org_id !== principal.orgId) throw new NotFoundError(`Job "${name}" in ${project.slug}`);
		return row;
	}

	private requireRun(principal: Principal, project: ProjectRow, runId: string): RunRow {
		const row = this.runById(runId);
		if (!row || row.org_id !== principal.orgId || row.project_id !== project.id) throw new NotFoundError(`Job run "${runId}"`);
		return row;
	}

	private findJob(projectId: string, name: string): JobRow | null {
		return this.ctx.sqlite.query<JobRow, [string, string]>('SELECT * FROM jobs WHERE project_id = ? AND name = ?').get(projectId, name);
	}

	private jobById(id: string): JobRow | null {
		return this.ctx.sqlite.query<JobRow, [string]>('SELECT * FROM jobs WHERE id = ?').get(id);
	}

	private runById(id: string): RunRow | null {
		return this.ctx.sqlite.query<RunRow, [string]>('SELECT * FROM job_runs WHERE id = ?').get(id);
	}

	/** Delete runs and the output they carried. */
	private deleteRuns(where: string, params: Array<string | number>): number {
		const ids = this.ctx.sqlite.query<{ id: string }, Array<string | number>>(`SELECT id FROM job_runs WHERE ${where}`).all(...params);
		if (ids.length === 0) return 0;
		const remove = this.ctx.sqlite.prepare('DELETE FROM job_runs WHERE id = ?');
		const removeLogs = this.ctx.sqlite.prepare('DELETE FROM log_events WHERE job_run_id = ?');
		this.ctx.sqlite.transaction(() => {
			for (const { id } of ids) {
				removeLogs.run(id);
				remove.run(id);
			}
		})();
		return ids.length;
	}

	private count(sql: string, ...params: Array<string | number>): number {
		return this.ctx.sqlite.query<{ n: number }, Array<string | number>>(sql).get(...params)?.n ?? 0;
	}

	private view(row: JobRow, projectSlug: string): JobView {
		const last = this.ctx.sqlite
			.query<RunRow, [string]>('SELECT * FROM job_runs WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
			.get(row.id);
		return {
			id: row.id,
			projectSlug,
			name: row.name,
			command: parseJson<string[]>(row.command_json, []),
			schedule: row.schedule,
			timeoutSeconds: row.timeout_seconds,
			concurrency: row.concurrency,
			maxRetries: row.max_retries,
			enabled: row.enabled === 1,
			nextRunAt: row.enabled === 1 && row.next_run_at !== null ? iso(row.next_run_at) : null,
			lastRun: last ? runView(last) : null,
			createdAt: iso(row.created_at),
			updatedAt: iso(row.updated_at),
		};
	}

	private audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'job', resourceId, args, result: 'ok' });
	}
}

/** Reject an expression the parser refuses or that can never fire (31 February). */
function assertSchedule(expression: string): void {
	try {
		parseCron(expression);
	} catch (error) {
		throw new ValidationError(`Schedule "${expression}": ${error instanceof Error ? error.message : String(error)}`);
	}
	if (nextRun(expression, Date.now()) === null) throw new ValidationError(`Schedule "${expression}" never fires.`);
}

/** The audit log keeps the program and the argument count, not arguments that may hold tokens. */
function commandSummary(command: string[]): { program: string; args: number } {
	return { program: command[0] ?? '', args: Math.max(0, command.length - 1) };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function runView(row: RunRow): JobRunView {
	return {
		id: row.id,
		jobId: row.job_id,
		jobName: row.job_name,
		trigger: row.trigger,
		attempt: row.attempt,
		status: row.status,
		command: parseJson<string[]>(row.command_json, []),
		timeoutSeconds: row.timeout_seconds,
		deploymentId: row.deployment_id,
		nodeId: row.node_id,
		exitCode: row.exit_code,
		error: row.error,
		createdBy: row.created_by,
		createdAt: iso(row.created_at),
		runAt: iso(row.run_at),
		startedAt: row.started_at !== null ? iso(row.started_at) : null,
		finishedAt: row.finished_at !== null ? iso(row.finished_at) : null,
		durationMs: row.started_at !== null && row.finished_at !== null ? Math.max(0, row.finished_at - row.started_at) : null,
		cancelRequested: row.cancel_requested === 1,
	};
}
