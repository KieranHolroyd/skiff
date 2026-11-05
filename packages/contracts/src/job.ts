import * as z from 'zod';
import { cronSchema } from './database-backup.ts';
import { workloadVolumeMountSchema } from './workload.ts';

/**
 * Jobs, cron and one-off tasks (plan 09, docs/JOBS.md).
 *
 * A job runs the project's **current production release** (or a pinned deployment) in the same
 * sandbox as the app: same DynamicUser, same memory slice, same read-only release directory. The
 * command is an argv array, never a shell string. Schedules are five-field cron expressions in an
 * IANA time zone; the scheduler computes `nextRunAt` and never replays a downtime storm.
 *
 * Environment variables and secrets are not in this contract: the agent fetches them from the
 * workload activation endpoint at run time, exactly as it does for a deployment.
 */

export const jobNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Fixed argv, no shell. Spaces and quotes inside one argument are preserved. */
export const jobCommandSchema = z.array(z.string().min(1).max(1024)).min(1).max(64);

/**
 * IANA zone (`Europe/London`, `America/Argentina/Buenos_Aires`) or `UTC`. The service resolves
 * the zone with `Intl` so DST rules are the platform's, not a hand-rolled table's.
 */
export const jobTimezoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/, 'Use an IANA time zone like Europe/London or UTC.')
	.refine((value) => value === 'UTC' || value.includes('/'), 'Use "UTC" or an IANA zone with a region, like Europe/London.')
	.refine((value) => {
		try {
			new Intl.DateTimeFormat('en', { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, 'Use a time zone the platform recognises, like Europe/London or UTC.');

export const jobConcurrencyModes = ['forbid', 'allow'] as const;
export type JobConcurrency = (typeof jobConcurrencyModes)[number];

export const jobRunTriggers = ['schedule', 'manual', 'api', 'mcp'] as const;
export type JobRunTrigger = (typeof jobRunTriggers)[number];

export const jobRunStatuses = ['queued', 'running', 'ok', 'failed', 'timeout', 'skipped'] as const;
export type JobRunStatus = (typeof jobRunStatuses)[number];

export const jobEnvironmentNameSchema = z
	.string()
	.min(1)
	.max(30)
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens.')
	.refine((value) => !value.includes('--'), 'Environment names cannot contain "--".');

export const jobEnvironmentSchema = jobEnvironmentNameSchema.default('production');

/**
 * Create a job. A null `schedule` is a manual/one-off job; cron jobs default to
 * `concurrency: 'forbid'` so an overlap is recorded as `skipped` instead of doubling load.
 */
export const jobCreateSchema = z
	.strictObject({
		name: jobNameSchema,
		command: jobCommandSchema,
		schedule: cronSchema.nullable().default(null),
		timezone: jobTimezoneSchema.default('UTC'),
		timeoutSeconds: z.number().int().min(10).max(86_400).default(300),
		concurrency: z.enum(jobConcurrencyModes).default('forbid'),
		maxRetries: z.number().int().min(0).max(10).default(0),
		/** After an outage, run once and record the missed count; never replay every occurrence. */
		catchUp: z.boolean().default(false),
		memoryMb: z.number().int().min(32).max(8192).default(256),
		cpus: z.number().positive().max(8).default(1),
		enabled: z.boolean().default(true),
		environment: jobEnvironmentSchema,
		/** Pin one release for a one-off; omitted uses the environment's current release. */
		deploymentId: z.string().min(1).max(100).optional(),
	})
	.describe('A job definition.');
export type JobCreate = z.input<typeof jobCreateSchema>;

export const jobUpdateSchema = z
	.strictObject({
		command: jobCommandSchema.optional(),
		/** `null` pauses the cron and leaves the job manually runnable. */
		schedule: cronSchema.nullable().optional(),
		timezone: jobTimezoneSchema.optional(),
		timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
		concurrency: z.enum(jobConcurrencyModes).optional(),
		maxRetries: z.number().int().min(0).max(10).optional(),
		catchUp: z.boolean().optional(),
		memoryMb: z.number().int().min(32).max(8192).optional(),
		cpus: z.number().positive().max(8).optional(),
		enabled: z.boolean().optional(),
		environment: jobEnvironmentNameSchema.optional(),
		deploymentId: z.string().min(1).max(100).nullable().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type JobUpdate = z.infer<typeof jobUpdateSchema>;

/** Trigger a run now. The surface records the real trigger (`manual`, `api` or `mcp`). */
export const jobRunCreateSchema = z.strictObject({
	trigger: z.enum(['manual', 'api', 'mcp']).default('manual'),
	/** One-off only: pin a deployment instead of using the environment's current release. */
	deploymentId: z.string().min(1).max(100).optional(),
});
export type JobRunCreate = z.input<typeof jobRunCreateSchema>;

// -------------------------------------------------------------------- node wire

/**
 * One run the node must execute. Secret values are absent; the agent fetches activation.
 * `volumes` reuses the workload mount shape so a job sees the same data as the app.
 */
export const jobTaskSchema = z.strictObject({
	id: z.string().min(1).max(120),
	jobId: z.string().min(1).max(100),
	runId: z.string().min(1).max(100),
	projectId: z.string().min(1).max(100),
	environment: jobEnvironmentNameSchema,
	/** Content-addressed release the run executes from. */
	release: z.string().length(64).nullable(),
	command: jobCommandSchema,
	timeoutSeconds: z.number().int().min(10).max(86_400),
	memoryMb: z.number().int().min(32).max(8192),
	cpus: z.number().positive().max(8),
	volumes: z.array(workloadVolumeMountSchema).max(20).default([]),
});
export type JobTask = z.infer<typeof jobTaskSchema>;

export const jobResultSchema = z.strictObject({
	taskId: z.string().min(1).max(120),
	jobId: z.string().min(1).max(100),
	runId: z.string().min(1).max(100),
	status: z.enum(['ok', 'failed', 'timeout']),
	exitCode: z.number().int().nullable(),
	startedAt: z.string(),
	finishedAt: z.string(),
	/** Bounded tails (the agent keeps at most 64 KiB each). Never full logs. */
	stdoutTail: z.string().max(65_536).default(''),
	stderrTail: z.string().max(65_536).default(''),
	error: z.string().max(2000).nullable().default(null),
});
export type JobResult = z.infer<typeof jobResultSchema>;

// -------------------------------------------------------------------- views

export const jobViewSchema = z.strictObject({
	id: z.string(),
	orgId: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	environment: z.string(),
	name: z.string(),
	command: z.array(z.string()),
	schedule: z.string().nullable(),
	timezone: z.string(),
	timeoutSeconds: z.number().int().positive(),
	concurrency: z.enum(jobConcurrencyModes),
	maxRetries: z.number().int().nonnegative(),
	catchUp: z.boolean(),
	memoryMb: z.number().int().positive(),
	cpus: z.number().positive(),
	enabled: z.boolean(),
	nextRunAt: z.string().nullable(),
	lastRunAt: z.string().nullable(),
	lastRunStatus: z.enum(jobRunStatuses).nullable(),
	/** Runs skipped while the scheduler was down; shown so a gap is explainable. */
	missedRuns: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type JobView = z.infer<typeof jobViewSchema>;

export const jobRunViewSchema = z.strictObject({
	id: z.string(),
	jobId: z.string(),
	jobName: z.string(),
	trigger: z.enum(jobRunTriggers),
	status: z.enum(jobRunStatuses),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	durationMs: z.number().int().nonnegative().nullable(),
	exitCode: z.number().int().nullable(),
	stdoutTail: z.string().nullable(),
	stderrTail: z.string().nullable(),
	error: z.string().max(2000).nullable(),
	/** Set when a `forbid` run was skipped because another run was active. */
	skippedReason: z.string().max(500).nullable(),
});
export type JobRunView = z.infer<typeof jobRunViewSchema>;

/** `GET /jobs/:name/runs` plus the next scheduled occurrence. */
export const jobHistoryViewSchema = z.strictObject({
	job: jobViewSchema,
	runs: z.array(jobRunViewSchema).max(200),
	nextRunAt: z.string().nullable(),
});
export type JobHistoryView = z.infer<typeof jobHistoryViewSchema>;
