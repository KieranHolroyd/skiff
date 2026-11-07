import * as z from 'zod';

/**
 * Deployment and build logs (DESIGN §8). A log drain turns process output into small, ordered
 * events so every surface can show the same stream: builders push chunks while they run, agents
 * drain journald for workloads, and the dashboard tails the result over SSE.
 */

export const logSources = ['runtime', 'build', 'system'] as const;
export type LogSource = (typeof logSources)[number];

export const logStreams = ['stdout', 'stderr', 'system'] as const;
export type LogStream = (typeof logStreams)[number];

export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

/** One line as shown in the dashboard, CLI and REST API. */
export interface LogEventView {
	/** Monotonic cursor within the platform; clients pass it back as `after`. */
	seq: number;
	/** Epoch milliseconds. */
	ts: number;
	source: LogSource;
	stream: LogStream;
	level: LogLevel;
	message: string;
	projectId: string;
	deploymentId: string | null;
	buildId: string | null;
}

export interface LogQuery {
	/** Return only events after this cursor. Omit for the newest page. */
	after?: number;
	limit?: number;
	source?: LogSource;
	buildId?: string;
	deploymentId?: string;
	/** Minimum severity; `warn` includes errors. */
	level?: LogLevel;
	/** Case-insensitive substring match. */
	q?: string;
	/**
	 * One job run's output (plan 09). Without it, project queries leave job output out: it is
	 * shown per run, not mixed into the app's own stream.
	 */
	jobRunId?: string;
}

export interface LogQueryResult {
	events: LogEventView[];
	/** Cursor of the last returned event (or the requested `after`). */
	cursor: number;
	hasMore: boolean;
}

/** Managed-service logs (RustFS, Postgres) use the same level/stream vocabulary. */
export const serviceLogKinds = ['storage', 'database', 'broker'] as const;
export type ServiceLogKind = (typeof serviceLogKinds)[number];

export interface ServiceLogEvent {
	seq: number;
	/** Epoch milliseconds. */
	ts: number;
	kind: ServiceLogKind;
	serviceId: string;
	source: 'runtime' | 'system';
	stream: LogStream;
	level: LogLevel;
	message: string;
}

export interface ServiceLogQuery {
	after?: number;
	limit?: number;
	level?: LogLevel;
	q?: string;
}

export interface ServiceLogQueryResult {
	events: ServiceLogEvent[];
	cursor: number;
	hasMore: boolean;
}

/** A drained journald line posted by an agent for one workload. */
export const runtimeLogLineSchema = z.object({
	/** Epoch milliseconds; the agent falls back to its own clock when journald omits it. */
	ts: z.number().int().nonnegative().optional(),
	stream: z.enum(logStreams).default('stdout'),
	level: z.enum(logLevels).default('info'),
	message: z.string().max(16_384),
});
export type RuntimeLogLine = z.infer<typeof runtimeLogLineSchema>;

/** Agent -> control plane batch. The workload id resolves the project/deployment server-side. */
export const runtimeLogBatchSchema = z.object({
	workloadId: z.string().min(3).max(128),
	/** Journald cursor after this batch, so an agent restart can resume without duplicates. */
	cursor: z.string().max(512).optional(),
	/** Output of one job run (plan 09) on this workload's node, not the app itself. */
	jobRunId: z.string().min(1).max(64).optional(),
	lines: z.array(runtimeLogLineSchema).max(500),
});
export type RuntimeLogBatch = z.infer<typeof runtimeLogBatchSchema>;

/** Helper -> agent journald read. Fixed fields only; the helper never runs journalctl with a shell. */
export const journalLogEntrySchema = z.object({
	cursor: z.string(),
	ts: z.number().int().nonnegative(),
	/** Raw syslog priority: 0–3 error, 4 warning, 5–6 info, 7 debug. */
	priority: z.number().int().min(0).max(7).default(6),
	message: z.string().max(16_384),
});
export type JournalLogEntry = z.infer<typeof journalLogEntrySchema>;

export const journalLogResponseSchema = z.object({
	entries: z.array(journalLogEntrySchema).default([]),
	nextCursor: z.string().nullable().default(null),
});
export type JournalLogResponse = z.infer<typeof journalLogResponseSchema>;

/** Keep the level vocabulary shared by the drain, REST and UI. */
export function levelForPriority(priority: number): LogLevel {
	if (priority <= 3) return 'error';
	if (priority === 4) return 'warn';
	if (priority === 7) return 'debug';
	return 'info';
}

/** Best-effort severity for a raw build line (builders rarely emit structured levels). */
export function levelForBuildLine(line: string, stream: LogStream): LogLevel {
	if (/\b(fatal|panic|exception|error|failed|failure)\b/i.test(line))
		return 'error';
	if (/\bwarn(ing)?\b/i.test(line)) return 'warn';
	return stream === 'stderr' ? 'warn' : 'info';
}
