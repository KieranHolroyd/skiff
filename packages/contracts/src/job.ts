import * as z from 'zod';
import { cronSchema } from './database-backup.ts';

/**
 * Jobs (plan 09, docs/SCHEDULER.md §Jobs): cron jobs and one-off commands for process and
 * container projects.
 *
 * A run executes the project's **current release** on the project's node, in a transient systemd
 * unit with the app's sandbox, environment, secrets and volumes. The command is an argv array,
 * never a shell string. Schedules use Skiff's five-field cron parser, which is UTC only, so jobs
 * have no time zone. After an outage the scheduler runs a missed job once, never every occurrence.
 *
 * Runs are leased by the node's agent over the agent protocol, like node tasks (D124): they are
 * one-shot, have a result, and must not be replayed from desired state after an agent restart.
 * Environment values and secrets are not on this wire; the agent fetches the app's activation.
 */

/** The agent capability that says a build leases and runs jobs. Older agents never pick them up. */
export const JOBS_CAPABILITY = 'jobs';

export const jobLimits = {
	/** Defined jobs per project, whatever the quota says. */
	perProject: 50,
	/** Finished runs kept per job (and per project for one-off runs); older ones are deleted. */
	runsKept: 100,
	/** Runs one node executes at the same time; more wait in the queue. */
	concurrentPerNode: 8,
	/** How often the agent reports a running run; a run silent for `leaseSeconds` is lost. */
	heartbeatSeconds: 15,
	leaseSeconds: 90,
	/** A queued run no node started within this long fails ("node did not pick it up"). */
	pickupMs: 5 * 60_000,
	/** Seconds a run gets after its timeout before the agent stops it (`RuntimeMaxSec` fires first). */
	timeoutGraceSeconds: 30,
	minTimeoutSeconds: 10,
	maxTimeoutSeconds: 86_400,
	maxRetries: 10,
} as const;

export const jobNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Fixed argv, no shell. Spaces and quotes inside one argument are preserved. */
export const jobCommandSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(1024)
			.refine((arg) => !/[\u0000-\u001f\u007f]/.test(arg), 'Arguments cannot contain newlines or control characters.'),
	)
	.min(1, 'Give the command to run.')
	.max(64);

export const jobTimeoutSchema = z.number().int().min(jobLimits.minTimeoutSeconds).max(jobLimits.maxTimeoutSeconds);

/**
 * What happens when a cron run is due while the previous one is still going: `forbid` records the
 * new run as skipped, `allow` runs both, `replace` cancels the running one and starts the new one.
 */
export const jobConcurrencyPolicies = ['forbid', 'allow', 'replace'] as const;
export type JobConcurrency = (typeof jobConcurrencyPolicies)[number];

/** `schedule` = the cron fired, `manual` = someone ran it, `retry` = a failed run's next attempt. */
export const jobRunTriggers = ['schedule', 'manual', 'retry'] as const;
export type JobRunTrigger = (typeof jobRunTriggers)[number];

export const jobRunStatuses = ['queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled', 'skipped'] as const;
export type JobRunStatus = (typeof jobRunStatuses)[number];

/** Finished one way or the other. */
export function jobRunDone(status: JobRunStatus): boolean {
	return status !== 'queued' && status !== 'running';
}

/** A null `schedule` is a job you only run by hand (or from a script). */
export const jobCreateSchema = z
	.strictObject({
		name: jobNameSchema,
		command: jobCommandSchema,
		schedule: cronSchema.nullable().default(null),
		timeoutSeconds: jobTimeoutSchema.default(600),
		concurrency: z.enum(jobConcurrencyPolicies).default('forbid'),
		/** Extra attempts after a failure or timeout, with exponential backoff (30 s, 1 min, 2 min, …). */
		maxRetries: z.number().int().min(0).max(jobLimits.maxRetries).default(0),
		/** A paused job keeps its definition and history and can still be run by hand. */
		enabled: z.boolean().default(true),
	})
	.describe('A job definition.');
export type JobCreate = z.input<typeof jobCreateSchema>;

export const jobUpdateSchema = z
	.strictObject({
		command: jobCommandSchema.optional(),
		/** `null` removes the schedule; the job stays and can be run by hand. */
		schedule: cronSchema.nullable().optional(),
		timeoutSeconds: jobTimeoutSchema.optional(),
		concurrency: z.enum(jobConcurrencyPolicies).optional(),
		maxRetries: z.number().int().min(0).max(jobLimits.maxRetries).optional(),
		enabled: z.boolean().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type JobUpdate = z.infer<typeof jobUpdateSchema>;

/** A one-off run: this command, now, against the current release. Not saved as a job. */
export const jobOneOffSchema = z.strictObject({
	command: jobCommandSchema,
	timeoutSeconds: jobTimeoutSchema.default(600),
});
export type JobOneOff = z.input<typeof jobOneOffSchema>;

// -------------------------------------------------------------------- node wire

/** One run the node must execute. No env or secret values: the agent fetches the activation. */
export const agentJobRunSchema = z.strictObject({
	runId: z.string().regex(/^jr_[a-f0-9]{32}$/),
	/** Desired-state id of the app workload whose release, env and volumes the run uses. */
	workloadId: z.string().min(1).max(128),
	command: jobCommandSchema,
	timeoutSeconds: jobTimeoutSchema,
});
export type AgentJobRun = z.infer<typeof agentJobRunSchema>;

export const agentJobLeaseSchema = z.object({
	runs: z.array(agentJobRunSchema).max(jobLimits.concurrentPerNode),
	heartbeatSeconds: z.number().int().positive(),
});
export type AgentJobLease = z.infer<typeof agentJobLeaseSchema>;

/** The agent's "still running" for every run it holds; the answer names runs to stop. */
export const agentJobHeartbeatSchema = z.object({
	runIds: z.array(z.string().min(1).max(64)).max(64),
});
export type AgentJobHeartbeat = z.infer<typeof agentJobHeartbeatSchema>;

export const agentJobHeartbeatResponseSchema = z.object({
	/** Runs the agent should stop: cancelled, replaced, or no longer this node's. */
	stop: z.array(z.string()),
});
export type AgentJobHeartbeatResponse = z.infer<typeof agentJobHeartbeatResponseSchema>;

export const agentJobResultSchema = z.object({
	runId: z.string().min(1).max(64),
	status: z.enum(['succeeded', 'failed', 'timeout', 'cancelled']),
	exitCode: z.number().int().nullable(),
	/** Epoch ms, as the node saw them. */
	startedAt: z.number().int().nonnegative().nullable(),
	finishedAt: z.number().int().nonnegative(),
	error: z.string().max(2000).nullable().default(null),
});
export type AgentJobResult = z.infer<typeof agentJobResultSchema>;

// -------------------------------------------------------------------- views

export const jobRunViewSchema = z.object({
	id: z.string(),
	/** Null for a one-off run. */
	jobId: z.string().nullable(),
	jobName: z.string().nullable(),
	trigger: z.enum(jobRunTriggers),
	/** 1 for the first attempt; a retry counts up. */
	attempt: z.number().int().positive(),
	status: z.enum(jobRunStatuses),
	command: z.array(z.string()),
	timeoutSeconds: z.number().int().positive(),
	deploymentId: z.string().nullable(),
	nodeId: z.string().nullable(),
	exitCode: z.number().int().nullable(),
	error: z.string().nullable(),
	/** The user who ran it by hand, or null for the scheduler. */
	createdBy: z.string().nullable(),
	createdAt: z.string(),
	/** When it may start (later than `createdAt` for a retry's backoff). */
	runAt: z.string(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	/** Set while a cancel waits for the node to stop the unit. */
	cancelRequested: z.boolean(),
});
export type JobRunView = z.infer<typeof jobRunViewSchema>;

export const jobViewSchema = z.object({
	id: z.string(),
	projectSlug: z.string(),
	name: z.string(),
	command: z.array(z.string()),
	schedule: z.string().nullable(),
	timeoutSeconds: z.number().int().positive(),
	concurrency: z.enum(jobConcurrencyPolicies),
	maxRetries: z.number().int().nonnegative(),
	enabled: z.boolean(),
	/** Null when there is no schedule or the job is paused. */
	nextRunAt: z.string().nullable(),
	lastRun: jobRunViewSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type JobView = z.infer<typeof jobViewSchema>;
