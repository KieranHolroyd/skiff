import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { builds, databases, logEvents, projects, serviceLogEvents, storageInstances, workloads } from '@skiff/db';
import {
	levelForBuildLine,
	parseLogLine,
	parseWorkloadReplicaId,
	requirePermission,
	type BuildLogChunk,
	type LogEventView,
	type LogLevel,
	type LogQuery,
	type LogQueryResult,
	type Principal,
	type ServiceLogEvent,
	type ServiceLogKind,
	type ServiceLogQuery,
	type ServiceLogQueryResult,
	type RuntimeLogBatch,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import type { ProjectRow } from './projects.ts';

const LOG_LIMIT = 2_000_000;
const LOG_TAIL = 8_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;
const RETENTION_MS = 7 * 86_400_000;
/** A global ceiling on drained rows; age is the primary policy, this bounds a chatty week. */
const MAX_ROWS = 500_000;
const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * The log drain (DESIGN §8). Builders and agents append small batches, the dashboard tails the
 * monotonic `seq` cursor over SSE, and every read goes through `logs:read` like any other surface.
 */
export class LogService {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Append one Builder chunk. The node must own the build and the build must still be running;
	 * returns false so the agent route can answer 404 without leaking another org's build.
	 */
	appendBuild(nodeId: string, buildId: string, chunk: BuildLogChunk): boolean {
		const build = this.ctx.db
			.select()
			.from(builds)
			.where(eq(builds.id, buildId))
			.get();
		if (!build || build.nodeId !== nodeId || build.status !== 'building')
			return false;
		const lines = chunk.lines.map((line) => sanitize(line));
		if (lines.length === 0) return true;
		const now = this.ctx.now();
		const text = `${lines.map((line) => (chunk.stream === 'stderr' ? `[stderr] ${line}` : line)).join('\n')}\n`;
		const log = `${build.log ?? ''}${text}`.slice(-LOG_LIMIT);
		const rows = lines.map((line) => {
			const parsed = parseLogLine(line);
			return {
				orgId: build.orgId,
				projectId: build.projectId,
				deploymentId: null,
				buildId: build.id,
				nodeId,
				source: 'build' as const,
				stream: chunk.stream,
				level: parsed.level ?? levelForBuildLine(line, chunk.stream),
				message: sanitize(parsed.message),
				ts: parsed.ts ?? now,
			};
		});
		this.ctx.db.transaction((tx) => {
			tx.insert(logEvents).values(rows).run();
			tx.update(builds)
				.set({ log, logTail: log.slice(-LOG_TAIL) })
				.where(eq(builds.id, buildId))
				.run();
		});
		return true;
	}

	/** Compatibility path for callers that already hold a plain text chunk (for example recovery). */
	appendBuildText(nodeId: string, buildId: string, text: string): boolean {
		const lines = text
			.replace(/\r\n/g, '\n')
			.split('\n')
			.filter((line, index, all) => line.length > 0 || index < all.length - 1);
		if (lines.length === 0) return true;
		return this.appendBuild(nodeId, buildId, { stream: 'stdout', lines });
	}

	/** Runtime journal output drained by an agent, one batch per workload. */
	appendRuntime(nodeId: string, batch: RuntimeLogBatch): number {
		// Replicas (plan 21) drain under `<id>-r<n>` and belong to the workload `<id>`.
		const { workloadId, replica } = parseWorkloadReplicaId(batch.workloadId);
		const workload = this.ctx.db
			.select()
			.from(workloads)
			.where(eq(workloads.id, workloadId))
			.get();
		// A workload may have moved or stopped between the helper read and this POST. Treat that as
		// an empty, successful drain instead of failing the agent's loop. Managed services are not
		// in `workloads`; their ids (`st_…`, `db_…`) resolve to their own table.
		if (!workload) return this.appendServiceRuntime(nodeId, batch);
		if (workload.nodeId !== nodeId)
			throw new CoreError(
				'forbidden',
				'This workload is placed on another node.',
				403,
			);
		const project = this.ctx.db
			.select()
			.from(projects)
			.where(eq(projects.id, workload.projectId))
			.get();
		if (!project || project.deletedAt) return 0;
		if (batch.lines.length === 0) return 0;
		const now = this.ctx.now();
		const rows = batch.lines.map((line) => {
			const parsed = parseLogLine(line.message);
			return {
				orgId: workload.orgId,
				projectId: workload.projectId,
				deploymentId: workload.deploymentId,
				buildId: null,
				nodeId,
				source: 'runtime' as const,
				stream: line.stream,
				level: parsed.level ?? line.level,
				message: replica > 0
					? `[r${replica}] ${sanitize(parsed.message)}`
					: sanitize(parsed.message),
				ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? now,
			};
		});
		this.ctx.db.insert(logEvents).values(rows).run();
		return rows.length;
	}

	/**
	 * Store a drained batch for a managed service. Returns 0 for an unknown id (the unit may have
	 * been removed between the read and the POST), and 403 if the node does not own it.
	 */
	private appendServiceRuntime(nodeId: string, batch: RuntimeLogBatch): number {
		const storage = this.ctx.db
			.select()
			.from(storageInstances)
			.where(eq(storageInstances.id, batch.workloadId))
			.get();
		const database = storage
			? undefined
			: this.ctx.db.select().from(databases).where(eq(databases.id, batch.workloadId)).get();
		const service = storage ?? database;
		if (!service) return 0;
		if (service.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This service is placed on another node.', 403);
		if (batch.lines.length === 0) return 0;
		const kind: ServiceLogKind = storage ? 'storage' : 'database';
		const now = this.ctx.now();
		const rows = batch.lines.map((line) => {
			const parsed = parseLogLine(line.message);
			return {
				orgId: service.orgId,
				kind,
				serviceId: service.id,
				nodeId,
				source: 'runtime' as const,
				stream: line.stream,
				level: parsed.level ?? line.level,
				message: sanitize(parsed.message),
				ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? now,
			};
		});
		this.ctx.db.insert(serviceLogEvents).values(rows).run();
		return rows.length;
	}

	/** A lifecycle breadcrumb in a managed service's own stream (restart, volume move, …). */
	appendServiceSystem(input: {
		kind: ServiceLogKind;
		serviceId: string;
		orgId: string;
		nodeId?: string | null;
		level?: LogLevel;
		message: string;
	}): void {
		this.ctx.db
			.insert(serviceLogEvents)
			.values({
				orgId: input.orgId,
				kind: input.kind,
				serviceId: input.serviceId,
				nodeId: input.nodeId ?? null,
				source: 'system',
				stream: 'system',
				level: input.level ?? 'info',
				message: sanitize(input.message),
				ts: this.ctx.now(),
			})
			.run();
	}

	/** Newest page or everything after a cursor, scoped to one managed service. */
	queryService(
		principal: Principal,
		kind: ServiceLogKind,
		serviceId: string,
		input: ServiceLogQuery = {},
	): ServiceLogQueryResult {
		requirePermission(principal, 'logs:read');
		const orgId =
			kind === 'storage'
				? this.ctx.db
						.select({ orgId: storageInstances.orgId })
						.from(storageInstances)
						.where(eq(storageInstances.id, serviceId))
						.get()?.orgId
				: this.ctx.db
						.select({ orgId: databases.orgId })
						.from(databases)
						.where(eq(databases.id, serviceId))
						.get()?.orgId;
		if (!orgId || orgId !== principal.orgId)
			throw new CoreError('not_found', 'Service not found.', 404);

		const requested = Number(input.limit ?? DEFAULT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), MAX_LIMIT))
			: DEFAULT_LIMIT;
		const conditions = [
			eq(serviceLogEvents.orgId, principal.orgId),
			eq(serviceLogEvents.kind, kind),
			eq(serviceLogEvents.serviceId, serviceId),
		];
		if (input.level) {
			const index = LEVEL_ORDER.indexOf(input.level);
			conditions.push(inArray(serviceLogEvents.level, LEVEL_ORDER.slice(Math.max(0, index))));
		}
		const q = input.q?.trim();
		if (q)
			conditions.push(sql`instr(lower(${serviceLogEvents.message}), lower(${q.slice(0, 200)})) > 0`);

		const after = input.after;
		let rows: Array<typeof serviceLogEvents.$inferSelect>;
		if (after !== undefined) {
			rows = this.ctx.db
				.select()
				.from(serviceLogEvents)
				.where(and(...conditions, gt(serviceLogEvents.seq, after)))
				.orderBy(asc(serviceLogEvents.seq))
				.limit(limit + 1)
				.all();
		} else {
			rows = this.ctx.db
				.select()
				.from(serviceLogEvents)
				.where(and(...conditions))
				.orderBy(desc(serviceLogEvents.seq))
				.limit(limit + 1)
				.all()
				.reverse();
		}
		const hasMore = rows.length > limit;
		if (hasMore) rows = after !== undefined ? rows.slice(0, limit) : rows.slice(1);
		return {
			events: rows.map(
				(row): ServiceLogEvent => ({
					seq: row.seq,
					ts: row.ts,
					kind: row.kind,
					serviceId: row.serviceId,
					source: row.source,
					stream: row.stream,
					level: row.level,
					message: row.message,
				}),
			),
			cursor: rows.at(-1)?.seq ?? after ?? 0,
			hasMore,
		};
	}

	/** Lifecycle breadcrumb (queue recovery, drain notices) that belongs in the same stream. */
	appendSystem(input: {
		orgId: string;
		projectId: string;
		deploymentId?: string | null;
		buildId?: string | null;
		nodeId?: string | null;
		level?: LogLevel;
		message: string;
	}): void {
		this.ctx.db
			.insert(logEvents)
			.values({
				orgId: input.orgId,
				projectId: input.projectId,
				deploymentId: input.deploymentId ?? null,
				buildId: input.buildId ?? null,
				nodeId: input.nodeId ?? null,
				source: 'system',
				stream: 'system',
				level: input.level ?? 'info',
				message: sanitize(input.message),
				ts: this.ctx.now(),
			})
			.run();
	}

	/**
	 * Newest page (`after` omitted) or everything after a cursor (SSE reconnect). The extra row
	 * tells the caller whether to offer "load older".
	 */
	query(
		principal: Principal,
		project: ProjectRow,
		input: LogQuery = {},
	): LogQueryResult {
		requirePermission(principal, 'logs:read');
		const requested = Number(input.limit ?? DEFAULT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), MAX_LIMIT))
			: DEFAULT_LIMIT;
		const conditions = [
			eq(logEvents.orgId, principal.orgId),
			eq(logEvents.projectId, project.id),
		];
		// A build view includes lifecycle breadcrumbs (claim recovery, cancellation) alongside the
		// Builder's own stdout/stderr; the row is still scoped by buildId below.
		if (input.source === 'build' && input.buildId)
			conditions.push(inArray(logEvents.source, ['build', 'system']));
		else if (input.source) conditions.push(eq(logEvents.source, input.source));
		if (input.buildId) conditions.push(eq(logEvents.buildId, input.buildId));
		if (input.deploymentId)
			conditions.push(eq(logEvents.deploymentId, input.deploymentId));
		if (input.level) {
			const index = LEVEL_ORDER.indexOf(input.level);
			conditions.push(
				inArray(logEvents.level, LEVEL_ORDER.slice(Math.max(0, index))),
			);
		}
		const q = input.q?.trim();
		if (q)
			conditions.push(
				sql`instr(lower(${logEvents.message}), lower(${q.slice(0, 200)})) > 0`,
			);

		const after = input.after;
		let rows: Array<typeof logEvents.$inferSelect>;
		if (after !== undefined) {
			rows = this.ctx.db
				.select()
				.from(logEvents)
				.where(and(...conditions, gt(logEvents.seq, after)))
				.orderBy(asc(logEvents.seq))
				.limit(limit + 1)
				.all();
		} else {
			rows = this.ctx.db
				.select()
				.from(logEvents)
				.where(and(...conditions))
				.orderBy(desc(logEvents.seq))
				.limit(limit + 1)
				.all()
				.reverse();
		}
		const hasMore = rows.length > limit;
		if (hasMore)
			rows = after !== undefined ? rows.slice(0, limit) : rows.slice(1);
		return {
			events: rows.map(toView),
			cursor: rows.at(-1)?.seq ?? after ?? 0,
			hasMore,
		};
	}

	/** Delete drained rows older than the retention window, then trim the global ceiling. */
	prune(now = this.ctx.now(), retentionMs = RETENTION_MS): number {
		const expired = this.ctx.sqlite.run('DELETE FROM log_events WHERE ts < ?', [
			now - retentionMs,
		]);
		const overflow = this.ctx.sqlite.run(
			'DELETE FROM log_events WHERE seq IN (SELECT seq FROM log_events ORDER BY seq DESC LIMIT -1 OFFSET ?)',
			[MAX_ROWS],
		);
		const expiredService = this.ctx.sqlite.run('DELETE FROM service_log_events WHERE ts < ?', [
			now - retentionMs,
		]);
		const overflowService = this.ctx.sqlite.run(
			'DELETE FROM service_log_events WHERE seq IN (SELECT seq FROM service_log_events ORDER BY seq DESC LIMIT -1 OFFSET ?)',
			[MAX_ROWS],
		);
		return expired.changes + overflow.changes + expiredService.changes + overflowService.changes;
	}
}

function sanitize(message: string): string {
	return (
		message
			.replace(/\u0000/g, '')
			// Terminal colour is not useful in a shared log view; keep the text, drop the escapes.
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
			.slice(0, 16_384)
	);
}

function toView(row: typeof logEvents.$inferSelect): LogEventView {
	return {
		seq: row.seq,
		ts: row.ts,
		source: row.source,
		stream: row.stream,
		level: row.level,
		message: row.message,
		projectId: row.projectId,
		deploymentId: row.deploymentId,
		buildId: row.buildId,
	};
}
