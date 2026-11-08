import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	appVolumes,
	databaseAttachments,
	databaseBackups,
	databaseCredentials,
	databaseMoves,
	databasePitr,
	databaseRotations,
	databaseStudioSessions,
	databases,
	deployments,
	nodes,
	projects,
	storageAttachments,
	storageInstances,
	workloads,
} from '@skiff/db';
import {
	databaseCapabilities,
	requirePermission,
	serviceMoveSchema,
	workloadSpecSchema,
	type AppMoveResult,
	type DatabaseMoveView,
	type Principal,
	type StorageMoveResult,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { nextCronTime } from './cron.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import type { DatabaseRow } from './databases.ts';
import { backupObjectKey } from './databases.ts';
import { resolvePlacement } from './placement.ts';
import type { VolumeRow } from './volumes.ts';
import { newId, parseJson } from './util.ts';
import { flow, type FlowDefinition, type FlowOutcome } from './flows/types.ts';

type MoveRow = typeof databaseMoves.$inferSelect;

/** The flow that drives a database move (docs/FLOWS.md §6). Its key is the move id. */
export const DATABASE_MOVE_FLOW = 'database.move';
interface DatabaseMoveFlowState {
	moveId: string;
}
/** Signals the move flow waits for; the node protocol hooks below send them. */
const MOVE_SIGNALS = {
	converged: 'source-converged',
	backup: 'backup-result',
	restore: 'restore-result',
	purged: 'purged',
} as const;
/** Where a move that predates flows is adopted, by phase; null for a finished move. */
function adoptionPoint(phase: MoveRow['phase']): { step: string; signal: string; timeoutMs: number | null } | null {
	switch (phase) {
		case 'quiescing':
			return { step: 'quiesce', signal: MOVE_SIGNALS.converged, timeoutMs: MOVE_QUIESCE_TIMEOUT_MS };
		case 'dumping':
			return { step: 'dump', signal: MOVE_SIGNALS.backup, timeoutMs: MOVE_STEP_TIMEOUT_MS };
		case 'restoring':
			return { step: 'cutover', signal: MOVE_SIGNALS.restore, timeoutMs: MOVE_STEP_TIMEOUT_MS };
		case 'purging':
			return { step: 'purge', signal: MOVE_SIGNALS.purged, timeoutMs: null };
		default:
			return null;
	}
}

/** Phases in which the database is unavailable and its attached apps are stopped. */
const ACTIVE_PHASES = ['quiescing', 'dumping', 'restoring'] as const;
const DAY_MS = 86_400_000;
/** Attached apps get this long to stop before the move gives up and restarts them. */
export const MOVE_QUIESCE_TIMEOUT_MS = 10 * 60_000;
/** A dump or restore that has not reported back by then is treated as failed. */
export const MOVE_STEP_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Moving services between nodes (D97).
 *
 * Apps are stateless from Skiff's point of view, so a move re-points the workload at the target
 * and the agents converge: the old node removes the unit, the new one starts it.
 *
 * A managed database keeps its row (id, name, credentials, attachments) and moves in phases:
 *
 * 1. `quiescing`: attached apps are listed as `stopped` on the source. The dump waits until the
 *    source has converged that state and no longer reports them, so no write lands after it.
 * 2. `dumping`: a final backup runs on the source through the D83 pipeline.
 * 3. `restoring`: the row is re-pointed at the target (fresh ports and volume) with
 *    `pendingRestoreId`, so the target creates an empty instance and restores the dump into it.
 *    The source drops the unit but keeps its data: nothing is purged without an explicit entry.
 * 4. `purging`: on success the attached apps follow the database and the source copy is purged;
 *    on a failed restore the row goes back to the source (its data is untouched) and the target's
 *    partial copy is purged instead.
 */
export class ServiceMoveService {
	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------------ apps

	moveApp(principal: Principal, slug: string, raw: unknown): AppMoveResult {
		requirePermission(principal, 'project:update');
		const input = serviceMoveSchema.parse(raw);
		const project = this.ctx.projects.requireRow(principal, slug);
		if (project.runtime === 'static')
			throw new ValidationError(`"${project.slug}" is a static site; the edge node serves it, so it cannot move.`);
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!workload?.nodeId)
			throw new ValidationError(`"${project.slug}" has not been deployed yet. Set its placement and deploy instead.`);
		const from = workload.nodeId;
		if (from === input.node) throw new ConflictError(`"${project.slug}" already runs on that node.`);
		if (this.quiescedProjectIds().has(project.id))
			throw new ConflictError(`"${project.slug}" is stopped while its database moves. Wait for that to finish.`);
		if (this.ctx.workloads.attachmentNode(project.id))
			throw new ConflictError(
				`"${project.slug}" runs next to its attached database or private storage (D56). Move the database instead; attached apps move with it.`,
			);
		const volumes = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(and(eq(appVolumes.projectId, project.id), isNull(appVolumes.deletedAt)))
			.all();
		if (volumes.length > 0)
			throw new ConflictError(
				`"${project.slug}" has app volumes (${volumes.map((v) => `"${v.name}"`).join(', ')}) whose data stays on its node. Skiff cannot copy volume data yet.`,
			);
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(workload.specJson, null));
		if (spec.success && spec.data.data)
			throw new ConflictError(
				`"${project.slug}" has a persistent data directory on its node. Skiff cannot copy it yet, so the app cannot move.`,
			);

		const decision = resolvePlacement({
			runtime: project.runtime,
			requested: input.node,
			memoryMb: workload.memoryMb,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok) throw new ValidationError(decision.message, decision.freeByNode);

		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.repointProject(project.id, from, decision.nodeId, now, { pinPlacement: true });
		})();
		this.ctx.audit.record({
			principal,
			action: 'project.move',
			resource: 'project',
			resourceId: project.id,
			args: { slug: project.slug, from, to: decision.nodeId },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
		return { project: project.slug, from: this.nodeRef(from), to: this.nodeRef(decision.nodeId) };
	}

	// ------------------------------------------------------------- databases

	moveDatabase(principal: Principal, name: string, raw: unknown): DatabaseMoveView {
		requirePermission(principal, 'database:update');
		const input = serviceMoveSchema.parse(raw);
		const db = this.ctx.databases.requireRow(principal, name);
		const source = db.nodeId;
		const target = input.node;
		const caps = databaseCapabilities(db.engine);
		if (!caps.backups && input.from !== 'empty')
			throw new ValidationError(
				`${db.engine} databases have no backups, so Skiff cannot copy "${db.name}"'s data. Use from: "empty" to start it fresh on the target, discarding its data.`,
			);
		if (target === source) throw new ConflictError(`"${db.name}" already runs on that node.`);
		// `latest-backup` and `empty` are for a database that cannot be dumped (down, or its node is).
		const offline = input.from !== 'dump';
		this.assertMovable(db, offline);

		const sourceNode = this.ctx.db.select().from(nodes).where(eq(nodes.id, source)).get();
		const sourceUp = sourceNode?.status === 'online';
		if (!offline && !sourceUp)
			throw new ConflictError(
				`The node "${sourceNode?.name ?? source}" holding "${db.name}" is ${sourceNode?.status ?? 'gone'}, so it cannot take a final dump. Move it from its latest backup (from: "latest-backup") or start it empty on the target (from: "empty").`,
			);
		// Engines without backups can only start empty, so that stays allowed while they run.
		if (offline && caps.backups && sourceUp && db.status === 'running')
			throw new ConflictError(
				`"${db.name}" is running, so a final dump keeps every write. Move it without "from" (or with from: "dump") instead.`,
			);
		// The newest completed backup whose recorded target Skiff can still reach (0053).
		const latest =
			input.from === 'latest-backup'
				? this.ctx.db
						.select()
						.from(databaseBackups)
						.where(and(eq(databaseBackups.databaseId, db.id), eq(databaseBackups.status, 'ok')))
						.orderBy(desc(databaseBackups.finishedAt))
						.all()
						.find((row) => this.ctx.backupTargets.describeRecorded(row).available)
				: undefined;
		if (input.from === 'latest-backup' && !latest)
			throw new ConflictError(
				`"${db.name}" has no completed backup to restore. Use from: "empty" to start it fresh on the target, discarding its data.`,
			);

		const { items: attached, warnings } = this.attachedProjects(db, target);
		const appMemory = attached.reduce((sum, item) => sum + (item.memoryMb ?? 0), 0);
		const decision = resolvePlacement({
			runtime: 'container',
			requested: target,
			memoryMb: db.memoryMb + appMemory,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(
				decision.message.replace('this app reserves', `this database${attached.length ? ' and its apps reserve' : ' reserves'}`),
				decision.freeByNode,
			);
		const volume = this.resolveVolume('databases', db, target, input.volume, input.pool);

		const now = this.ctx.now();
		const id = newId('dmv_');
		const targetName = this.nodeRef(target).name ?? target;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(databaseMoves)
				.values({
					id,
					orgId: db.orgId,
					databaseId: db.id,
					sourceNodeId: source,
					targetNodeId: target,
					sourceHostPort: db.hostPort,
					sourcePoolerPort: db.poolerPort,
					sourceVolumeId: db.volumeId,
					targetVolumeId: volume?.id ?? null,
					dataSource: input.from,
					// A database that cannot run has nothing to quiesce or dump: cut over straight away.
					phase: offline ? 'dumping' : 'quiescing',
					backupId: latest?.id ?? null,
					projectIdsJson: JSON.stringify(attached.map((item) => item.projectId)),
					backupWasEnabled: db.backupEnabled,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			// No scheduled dump may race the final one, and the studio cannot follow the move.
			this.ctx.db
				.update(databases)
				.set({
					backupEnabled: false,
					nextBackupAt: null,
					message: offline
						? `Moving to ${targetName}.`
						: attached.length
							? `Moving to ${targetName}: stopping attached apps.`
							: `Moving to ${targetName}: taking the final backup.`,
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
			this.closeStudios(db.id, now);
		})();
		this.ctx.projects.bump(db.orgId);
		// The version that lists the attached apps as stopped; the dump waits for the source to apply it.
		const quiesceVersion = this.ctx.projects.stateVersion();
		this.ctx.db.update(databaseMoves).set({ quiesceVersion }).where(eq(databaseMoves.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'database.move',
			resource: 'database',
			resourceId: db.id,
			args: {
				name: db.name,
				from: source,
				to: target,
				volume: volume?.name ?? null,
				projects: attached.map((item) => item.slug),
				source: input.from,
				...(latest ? { backupId: latest.id } : {}),
			},
			result: 'ok',
		});
		// The flow takes it from here (docs/FLOWS.md §6). Its steps are synchronous, so the first
		// transitions (an offline cut-over, or the dump when nothing needs stopping) happen now.
		this.ctx.flows.start<DatabaseMoveFlowState>({
			kind: DATABASE_MOVE_FLOW,
			key: id,
			input: { moveId: id },
			orgId: db.orgId,
			subject: { kind: 'database', id: db.id },
			readPermission: 'database:read',
			cancelPermission: 'database:update',
			createdBy: principal.userId,
			step: offline ? 'cutover' : attached.some((item) => item.nodeId === source) ? 'quiesce' : 'dump',
			detail: `Moving ${db.name} to ${targetName}.`,
		});
		return { ...this.view(this.requireMove(id)), warnings };
	}

	/** The newest move of a database, finished or not, for its detail page. */
	latestForDatabase(principal: Principal, name: string): DatabaseMoveView | null {
		requirePermission(principal, 'database:read');
		const db = this.ctx.databases.requireRow(principal, name);
		const row = this.ctx.db
			.select()
			.from(databaseMoves)
			.where(eq(databaseMoves.databaseId, db.id))
			.orderBy(desc(databaseMoves.createdAt), desc(sql`rowid`))
			.get();
		return row ? this.view(row) : null;
	}

	/** Mutations that would fight a move (resize, restart, delete, backups, credentials…) call this. */
	assertNotMoving(db: Pick<DatabaseRow, 'id' | 'name'>): void {
		if (this.activeFor(db.id))
			throw new ConflictError(`"${db.name}" is moving to another node. Wait for the move to finish.`);
	}

	/** Projects stopped while a database they use moves. */
	quiescedProjectIds(): Set<string> {
		const ids = new Set<string>();
		for (const row of this.activeMoves()) for (const id of parseJson<string[]>(row.projectIdsJson, [])) ids.add(id);
		return ids;
	}

	/** Source ports a rollback would need back; port allocation on that node skips them. */
	reservedPorts(nodeId: string): { host: Set<number>; pooler: Set<number> } {
		const host = new Set<number>();
		const pooler = new Set<number>();
		for (const row of this.activeMoves()) {
			if (row.sourceNodeId !== nodeId) continue;
			host.add(row.sourceHostPort);
			if (row.sourcePoolerPort !== null) pooler.add(row.sourcePoolerPort);
		}
		return { host, pooler };
	}

	/** Why a node cannot be removed right now, if a move still needs it. */
	nodeBlockers(nodeId: string): string[] {
		return this.ctx.db
			.select({ move: databaseMoves, name: databases.name })
			.from(databaseMoves)
			.innerJoin(databases, eq(databases.id, databaseMoves.databaseId))
			.where(inArray(databaseMoves.phase, [...ACTIVE_PHASES]))
			.all()
			.filter(({ move }) => move.sourceNodeId === nodeId || move.targetNodeId === nodeId)
			.map(({ name }) => `"${name}"`);
	}

	/** A removed node can never confirm its purge; those moves are finished as they stand. */
	forgetNode(nodeId: string): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(storageInstances)
			.set({ purgeNodeId: null, updatedAt: now })
			.where(eq(storageInstances.purgeNodeId, nodeId))
			.run();
		this.ctx.db
			.update(databaseMoves)
			.set({ phase: 'done', purgeNodeId: null, updatedAt: now, finishedAt: now })
			.where(and(eq(databaseMoves.phase, 'purging'), eq(databaseMoves.purgeNodeId, nodeId)))
			.run();
	}

	// --------------------------------------------------------- node protocol

	/** Signal `quiescing` moves once the source applied the stop and no longer runs the attached apps. */
	onHeartbeat(nodeId: string, actualStateVersion: number, reportedIds: readonly string[]): void {
		for (const row of this.activeMoves()) {
			if (row.phase !== 'quiescing' || row.sourceNodeId !== nodeId) continue;
			if (actualStateVersion < row.quiesceVersion) continue;
			const workloadIds = this.ctx.db
				.select({ id: workloads.id })
				.from(workloads)
				.where(and(inArray(workloads.projectId, parseJson<string[]>(row.projectIdsJson, [])), eq(workloads.nodeId, nodeId)))
				.all()
				.map((item) => item.id);
			// Replicas report as `<id>-r<n>` (D90); the agent drops a report only once the unit is gone.
			const stillRunning = reportedIds.some((id) =>
				workloadIds.some((workloadId) => id === workloadId || id.startsWith(`${workloadId}-r`)),
			);
			if (stillRunning) continue;
			this.signalMove(row, MOVE_SIGNALS.converged);
		}
	}

	/** The final dump finished on the source: the flow re-points the database, or gives up. */
	onBackupResult(backupId: string, ok: boolean, error: string | null): void {
		const row = this.ctx.db
			.select()
			.from(databaseMoves)
			.where(and(eq(databaseMoves.backupId, backupId), eq(databaseMoves.phase, 'dumping')))
			.get();
		if (!row) return;
		this.signalMove(row, MOVE_SIGNALS.backup, { ok, error });
	}

	/**
	 * A restore result for a database that is mid-move. Returns false when the database is not
	 * moving, so the ordinary restore-to-new handling applies.
	 */
	onRestoreResult(db: DatabaseRow, ok: boolean, error: string | null): boolean {
		const row = this.activeFor(db.id);
		if (!row || row.phase !== 'restoring' || db.pendingRestoreId !== row.backupId) return false;
		this.signalMove(row, MOVE_SIGNALS.restore, { ok, error });
		return true;
	}

	/** Database ids whose old copy this node must delete. */
	purgesForNode(nodeId: string): string[] {
		return this.ctx.db
			.select({ databaseId: databaseMoves.databaseId })
			.from(databaseMoves)
			.where(and(eq(databaseMoves.phase, 'purging'), eq(databaseMoves.purgeNodeId, nodeId)))
			.all()
			.map((row) => row.databaseId);
	}

	onPurged(nodeId: string, ids: readonly string[]): void {
		if (ids.length === 0) return;
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select()
			.from(databaseMoves)
			.where(
				and(
					eq(databaseMoves.phase, 'purging'),
					eq(databaseMoves.purgeNodeId, nodeId),
					inArray(databaseMoves.databaseId, [...ids]),
				),
			)
			.all();
		for (const row of rows) {
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'done', updatedAt: now, finishedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'database.move-purged',
				resource: 'database',
				resourceId: row.databaseId,
				args: { nodeId, outcome: row.outcome },
				result: 'ok',
			});
			// The purge is domain state any reader needs at once; the flow only records the end.
			this.ctx.flows.signal(DATABASE_MOVE_FLOW, row.id, MOVE_SIGNALS.purged);
		}
		if (rows.length > 0) this.ctx.projects.bump();
	}

	/**
	 * Maintenance: adopt moves that began before flows, then advance due move runs (timeouts give
	 * up on nodes that never answered). Returns the runs advanced.
	 */
	tick(): number {
		for (const row of this.ctx.db.select().from(databaseMoves).where(inArray(databaseMoves.phase, [...ACTIVE_PHASES, 'purging'])).all())
			this.adopt(row);
		return this.ctx.flows.drive({ kind: DATABASE_MOVE_FLOW }).processed;
	}

	/**
	 * The flow definition (docs/FLOWS.md §6). Steps reuse the transitions below; each re-reads the
	 * move row, and the `database_moves` phase stays the domain state other services read.
	 */
	databaseMoveFlow(): FlowDefinition<DatabaseMoveFlowState> {
		const move = (state: DatabaseMoveFlowState) => this.requireMove(state.moveId);
		const result = (row: MoveRow) => ({ moveId: row.id, outcome: row.outcome, databaseId: row.databaseId });
		const failedWith = (row: MoveRow, fallback: string): FlowOutcome =>
			flow.fail(this.requireMove(row.id).error ?? fallback);
		/** After the cut-over, a result either finishes the move or returns it to the source. */
		const restored = (row: MoveRow, ok: boolean, error: string | null): FlowOutcome => {
			const db = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
			if (!db) return flow.fail('The database was deleted during the move.');
			if (ok) this.finish(row, db);
			else this.rollBack(row, `The restore on the target failed: ${error ?? 'unknown error'}`);
			return flow.next('purge');
		};
		return {
			kind: DATABASE_MOVE_FLOW,
			title: 'Database move',
			steps: {
				quiesce: {
					run: () =>
						flow.wait(MOVE_SIGNALS.converged, {
							timeoutMs: MOVE_QUIESCE_TIMEOUT_MS,
							detail: 'Stopping the attached apps on the source.',
						}),
					onSignal: () => flow.next('dump'),
					onTimeout: ({ state }) => {
						const error = `The attached apps did not stop within ${MOVE_QUIESCE_TIMEOUT_MS / 60_000} minutes.`;
						this.abort(move(state), error);
						return flow.fail(error);
					},
				},
				dump: {
					run: ({ state, now }) => {
						const row = move(state);
						// Idempotent: a resumed step whose dump was already requested keeps waiting for it.
						if (row.phase !== 'dumping') this.startDump(row, now);
						return flow.wait(MOVE_SIGNALS.backup, { timeoutMs: MOVE_STEP_TIMEOUT_MS, detail: 'Taking the final backup on the source.' });
					},
					onSignal: ({ state }, signal) => {
						const row = move(state);
						const { ok, error } = signal.payload as { ok: boolean; error: string | null };
						if (ok) return flow.next('cutover');
						const message = `The final backup failed: ${error ?? 'unknown error'}`;
						this.abort(row, message);
						return flow.fail(message);
					},
					onTimeout: ({ state }) => {
						const error = 'The final backup did not finish in time.';
						this.abort(move(state), error);
						return flow.fail(error);
					},
				},
				cutover: {
					run: ({ state }) => {
						const row = move(state);
						// Resumed after the cut-over already happened: keep waiting for the restore.
						const outcome = row.phase === 'restoring' ? 'restoring' : row.phase === 'purging' ? 'finished' : this.cutOver(row);
						if (outcome === 'aborted') return failedWith(row, 'The move could not cut over.');
						if (outcome === 'finished') return flow.next('purge');
						return flow.wait(MOVE_SIGNALS.restore, {
							timeoutMs: MOVE_STEP_TIMEOUT_MS,
							detail: 'Restoring the data on the target.',
						});
					},
					onSignal: ({ state }, signal) => {
						const { ok, error } = signal.payload as { ok: boolean; error: string | null };
						return restored(move(state), ok, error);
					},
					onTimeout: ({ state }) => {
						this.rollBack(move(state), 'The restore on the target did not finish in time.');
						return flow.next('purge');
					},
				},
				purge: {
					run: ({ state }) => {
						const row = move(state);
						if (row.phase === 'done') return this.endOfMove(row, result(row));
						return flow.wait(MOVE_SIGNALS.purged, { detail: 'Deleting the old copy.' });
					},
					onSignal: ({ state }) => {
						const row = move(state);
						return this.endOfMove(row, result(row));
					},
				},
			},
			// Before the cut-over nothing has moved, so a cancel is an abort; after it, the restore
			// result decides (finish or roll back) and the move cannot be cancelled.
			cancel: ({ state, run }) => {
				if (run.step !== 'quiesce' && run.step !== 'dump') return null;
				this.abort(move(state), 'The move was cancelled.');
				return flow.cancel('The move was cancelled before the cut-over.');
			},
			onFailure: ({ state }, error) => {
				const row = this.ctx.db.select().from(databaseMoves).where(eq(databaseMoves.id, state.moveId)).get();
				if (!row) return;
				if (row.phase === 'quiescing' || row.phase === 'dumping') this.abort(row, error);
				else if (row.phase === 'restoring') this.rollBack(row, error);
			},
		};
	}

	// ------------------------------------------------------------- internals

	/** A rolled-back move ends failed (its data never moved); a completed one succeeds. */
	private endOfMove(row: MoveRow, result: unknown): FlowOutcome {
		return row.outcome === 'rolled_back'
			? flow.fail(row.error ?? 'The move failed and was rolled back.')
			: flow.succeed(result, 'Moved.');
	}

	/** Deliver a node event to the move's flow, adopting a move that began before flows. */
	private signalMove(row: MoveRow, name: string, payload?: unknown): void {
		this.adopt(row);
		this.ctx.flows.signal(DATABASE_MOVE_FLOW, row.id, name, payload);
	}

	/** Give a pre-flow move a run parked where its phase is, so signals and timeouts reach it. */
	private adopt(row: MoveRow): void {
		if (this.ctx.flows.idFor(DATABASE_MOVE_FLOW, row.id)) return;
		const point = adoptionPoint(row.phase);
		if (!point) return;
		this.ctx.flows.start<DatabaseMoveFlowState>({
			kind: DATABASE_MOVE_FLOW,
			key: row.id,
			input: { moveId: row.id },
			orgId: row.orgId,
			subject: { kind: 'database', id: row.databaseId },
			readPermission: 'database:read',
			cancelPermission: 'database:update',
			createdBy: row.createdBy,
			step: point.step,
			waiting: { signal: point.signal, deadline: point.timeoutMs === null ? null : row.updatedAt + point.timeoutMs },
		});
	}

	private assertMovable(db: DatabaseRow, offline: boolean): void {
		this.assertNotMoving(db);
		// A move re-creates the primary from a dump; its replicas would follow nothing (C7). Promote
		// a replica on the target instead, or remove them first.
		if (this.ctx.databaseReplicas.hasReplicas(db.id))
			throw new ConflictError(
				`"${db.name}" has read replicas. Remove them first, or add a replica on the target node and promote it.`,
			);
		const purging = this.ctx.db
			.select({ id: databaseMoves.id })
			.from(databaseMoves)
			.where(and(eq(databaseMoves.databaseId, db.id), eq(databaseMoves.phase, 'purging')))
			.get();
		if (purging)
			throw new ConflictError(`"${db.name}" still has an old copy being deleted from its previous node. Try again shortly.`);
		const problems: string[] = [];
		if (!offline && db.status !== 'running')
			problems.push(
				`it is ${db.status}, so it cannot be dumped. Move it from its latest backup (from: "latest-backup") or start it empty on the target (from: "empty")`,
			);
		if (db.pendingRestoreId) problems.push('a backup restore is running on it');
		if (offline) {
			// A database that cannot run never finishes those tasks; they continue on the target.
			if (problems.length) throw new ConflictError(`"${db.name}" cannot move yet: ${problems.join('; ')}.`);
			this.assertNoPitr(db);
			return;
		}
		const busyBackup = this.ctx.db
			.select({ id: databaseBackups.id })
			.from(databaseBackups)
			.where(and(eq(databaseBackups.databaseId, db.id), inArray(databaseBackups.status, ['pending', 'running'])))
			.get();
		if (busyBackup) problems.push('a backup is running');
		const rotation = this.ctx.db
			.select({ id: databaseRotations.id })
			.from(databaseRotations)
			.where(and(eq(databaseRotations.databaseId, db.id), inArray(databaseRotations.status, ['pending', 'running'])))
			.get();
		if (rotation) problems.push('a credential rotation is running');
		const credential = this.ctx.db
			.select({ id: databaseCredentials.id })
			.from(databaseCredentials)
			.where(and(eq(databaseCredentials.databaseId, db.id), inArray(databaseCredentials.status, ['pending', 'revoking'])))
			.get();
		if (credential) problems.push('a credential change is still being applied');
		if (problems.length) throw new ConflictError(`"${db.name}" cannot move yet: ${problems.join('; ')}.`);
		this.assertNoPitr(db);
	}

	/** The WAL archive belongs to the old cluster; a restored or fresh one needs a new base backup. */
	private assertNoPitr(db: DatabaseRow): void {
		const pitr = this.ctx.db
			.select({ enabled: databasePitr.enabled })
			.from(databasePitr)
			.where(eq(databasePitr.databaseId, db.id))
			.get();
		if (pitr?.enabled)
			throw new ConflictError(
				`"${db.name}" cannot move yet: point-in-time recovery is on (turn it off, move, then turn it on again for a new base backup).`,
			);
	}

	/**
	 * Attached live projects, which follow the database to the target. Services they also use that
	 * stay behind are warnings, not blockers (D97): moving those too makes the app whole again, in
	 * either order. App volumes and a persistent data dir cannot follow, so they still refuse.
	 */
	private attachedProjects(
		db: DatabaseRow,
		target: string,
	): {
		items: Array<{ projectId: string; slug: string; nodeId: string | null; memoryMb: number | null }>;
		warnings: string[];
	} {
		const rows = this.ctx.db
			.select({ project: projects })
			.from(databaseAttachments)
			.innerJoin(projects, eq(projects.id, databaseAttachments.projectId))
			.where(and(eq(databaseAttachments.databaseId, db.id), isNull(projects.deletedAt)))
			.all();
		const problems: string[] = [];
		const warnings: string[] = [];
		const items = rows.map(({ project }) => {
			const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
			problems.push(...this.cannotFollow(project.id, project.slug, workload?.specJson ?? null));
			const behind = this.leftBehind(project.id, target, { databaseId: db.id });
			if (behind.length)
				warnings.push(
					`"${project.slug}" also uses ${behind.join(', ')}, which ${behind.length === 1 ? 'stays' : 'stay'} where ${behind.length === 1 ? 'it is' : 'they are'}. Move ${behind.length === 1 ? 'it' : 'them'} to the same node next; until then "${project.slug}" cannot reach ${behind.length === 1 ? 'it' : 'them'} or deploy.`,
				);
			return { projectId: project.id, slug: project.slug, nodeId: workload?.nodeId ?? null, memoryMb: workload?.memoryMb ?? null };
		});
		if (problems.length)
			throw new ConflictError(`Attached apps move with "${db.name}", but ${problems.join('; ')}.`);
		return { items, warnings };
	}

	/** Why an app cannot follow a service to another node: local state Skiff cannot copy. */
	private cannotFollow(projectId: string, slug: string, specJson: string | null): string[] {
		const problems: string[] = [];
		const volumes = this.ctx.db
			.select({ id: appVolumes.id })
			.from(appVolumes)
			.where(and(eq(appVolumes.projectId, projectId), isNull(appVolumes.deletedAt)))
			.all();
		if (volumes.length) problems.push(`"${slug}" has app volumes whose data stays on its node`);
		const spec = specJson ? workloadSpecSchema.safeParse(parseJson<unknown>(specJson, null)) : null;
		if (spec?.success && spec.data.data) problems.push(`"${slug}" has a persistent data directory on its node`);
		return problems;
	}

	/** Other services pinning this project (D56, S5) that are not on `target`, as display names. */
	private leftBehind(projectId: string, target: string, except: { databaseId?: string; storageId?: string }): string[] {
		const dbs = this.ctx.db
			.select({ id: databases.id, name: databases.name, nodeId: databases.nodeId })
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.where(and(eq(databaseAttachments.projectId, projectId), isNull(databases.deletedAt)))
			.all()
			.filter((row) => row.id !== except.databaseId && row.nodeId !== target)
			.map((row) => `database "${row.name}"`);
		const stores = this.ctx.db
			.select({ id: storageInstances.id, name: storageInstances.name, nodeId: storageInstances.nodeId, public: storageInstances.public })
			.from(storageAttachments)
			.innerJoin(storageInstances, eq(storageInstances.id, storageAttachments.storageId))
			.where(and(eq(storageAttachments.projectId, projectId), isNull(storageInstances.deletedAt)))
			.all()
			// Public storage is reachable from any node, so it never pins an app.
			.filter((row) => row.id !== except.storageId && !row.public && row.nodeId !== target)
			.map((row) => `private storage "${row.name}"`);
		return [...dbs, ...stores];
	}

	// --------------------------------------------------------------- storage

	/**
	 * Move a storage instance (D97). Objects are not copied between nodes yet, so the move is always
	 * `from: "empty"`: the target starts a fresh instance and the agent recreates its buckets and
	 * keys from desired state, so attached apps keep their credentials. The old copy is purged.
	 * Apps pinned by private storage follow it unless something else they use stays behind.
	 */
	moveStorage(principal: Principal, name: string, raw: unknown): StorageMoveResult {
		requirePermission(principal, 'storage:update');
		const input = serviceMoveSchema.parse(raw);
		const row = this.ctx.storage.requireRow(principal, name);
		if (input.from !== 'empty')
			throw new ConflictError(
				`Skiff cannot copy objects between nodes yet, so "${row.name}" can only move empty: its buckets, keys and attached apps' credentials come back on the target, its objects do not. Move it with from: "empty".`,
			);
		const source = row.nodeId;
		const target = input.node;
		if (target === source) throw new ConflictError(`"${row.name}" already runs on that node.`);
		if (row.purgeNodeId)
			throw new ConflictError(`"${row.name}" still has an old copy being deleted from a previous node. Try again shortly.`);

		const followers: Array<{ projectId: string; slug: string; nodeId: string; memoryMb: number }> = [];
		const warnings: string[] = [];
		const problems: string[] = [];
		if (!row.public) {
			const attached = this.ctx.db
				.select({ project: projects })
				.from(storageAttachments)
				.innerJoin(projects, eq(projects.id, storageAttachments.projectId))
				.where(and(eq(storageAttachments.storageId, row.id), isNull(projects.deletedAt)))
				.all();
			for (const { project } of attached) {
				if (this.quiescedProjectIds().has(project.id))
					throw new ConflictError(`"${project.slug}" is stopped while a database it uses moves. Wait for that to finish.`);
				const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
				// Not deployed yet, or already on the target (an earlier move split it): nothing to move.
				if (!workload?.nodeId || workload.nodeId === target) continue;
				const behind = this.leftBehind(project.id, target, { storageId: row.id });
				if (behind.length) {
					warnings.push(
						`"${project.slug}" stays on ${this.nodeRef(workload.nodeId).name ?? workload.nodeId} with ${behind.join(', ')}; it cannot reach "${row.name}" until ${behind.length === 1 ? 'that moves' : 'those move'} too.`,
					);
					continue;
				}
				problems.push(...this.cannotFollow(project.id, project.slug, workload.specJson));
				followers.push({ projectId: project.id, slug: project.slug, nodeId: workload.nodeId, memoryMb: workload.memoryMb });
			}
		}
		if (problems.length) throw new ConflictError(`Attached apps move with "${row.name}", but ${problems.join('; ')}.`);

		const decision = resolvePlacement({
			runtime: 'container',
			requested: target,
			memoryMb: row.memoryMb + followers.reduce((sum, item) => sum + item.memoryMb, 0),
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(decision.message.replace('this app reserves', 'this storage instance reserves'), decision.freeByNode);
		const volume = this.resolveVolume('object-storage', { volumeId: row.volumeId, storageMb: row.storageMb }, target, input.volume, input.pool);
		const hostPort = this.ctx.storage.allocatePort(target);

		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(storageInstances)
				.set({
					nodeId: target,
					hostPort,
					volumeId: volume?.id ?? null,
					status: 'pending',
					message: null,
					usedBytes: null,
					objects: null,
					statsAt: null,
					purgeNodeId: source,
					updatedAt: now,
				})
				.where(eq(storageInstances.id, row.id))
				.run();
			for (const item of followers) this.repointProject(item.projectId, item.nodeId, target, now, { pinPlacement: false });
		})();
		this.ctx.audit.record({
			principal,
			action: 'storage.move',
			resource: 'storage',
			resourceId: row.id,
			args: { name: row.name, from: source, to: target, projects: followers.map((item) => item.slug), source: 'empty' },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return {
			storage: row.name,
			from: this.nodeRef(source),
			to: this.nodeRef(target),
			projects: followers.map((item) => item.slug).sort(),
			warnings,
		};
	}

	/**
	 * Explicit volume on the target, else the requested pool, else the resource's current pool,
	 * else the kind's default pool (docs/STORAGE.md §8). Null means the system disk.
	 */
	private resolveVolume(
		kind: 'databases' | 'object-storage',
		current: { volumeId: string | null; storageMb: number },
		target: string,
		name: string | undefined,
		pool: string | undefined,
	): VolumeRow | null {
		let volume: VolumeRow | null = null;
		if (name) {
			volume = this.ctx.volumes.requireOnNode(target, name);
		} else {
			const currentPool = current.volumeId ? this.ctx.storagePools.poolNameOfVolume(current.volumeId) : null;
			volume = this.ctx.storagePools.pick(this.ctx.storagePools.plan(kind, pool ?? currentPool ?? undefined), target, current.storageMb);
		}
		if (volume) {
			this.ctx.volumes.assertRoom(volume, current.storageMb);
			const existing = current.volumeId ? this.ctx.volumes.byId(current.volumeId) : null;
			// Both nodes mounting one network share: purging the old copy would delete the new one.
			if (existing && existing.sourceKey === volume.sourceKey)
				throw new ConflictError(
					`Volume "${volume.name}" is the same share as "${existing.name}" on the current node; moving gains nothing and the old copy's purge would delete the new one.`,
				);
		}
		return volume;
	}

	private startDump(row: MoveRow, now: number): void {
		const db = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		if (!db) return;
		const backupId = newId('bkp_');
		const targetName = this.nodeRef(row.targetNodeId).name ?? row.targetNodeId;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(databaseBackups)
				.values({
					id: backupId,
					orgId: db.orgId,
					databaseId: db.id,
					kind: 'manual',
					status: 'pending',
					objectKey: backupObjectKey(db.orgId, db.id, backupId),
					...this.ctx.backupTargets.placementFor(db.orgId),
					createdBy: row.createdBy,
					createdAt: now,
					expiresAt: now + db.backupRetentionDays * DAY_MS,
				})
				.run();
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'dumping', backupId, updatedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
			this.ctx.db
				.update(databases)
				.set({
					lastBackupStatus: 'pending',
					lastBackupError: null,
					message: `Moving to ${targetName}: taking the final backup.`,
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
		})();
		this.ctx.projects.bump(db.orgId);
	}

	/**
	 * Point the database at the target with the final dump as its pending restore. Returns
	 * `restoring` (wait for the target), `finished` (nothing to restore; the move is purging) or
	 * `aborted` (the target can no longer take it; nothing moved).
	 */
	private cutOver(row: MoveRow): 'restoring' | 'finished' | 'aborted' {
		const db = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		if (!db) {
			this.abort(row, 'The database was deleted during the move.');
			return 'aborted';
		}
		const now = this.ctx.now();
		// Capacity may have changed since the move was accepted; check again before committing.
		const attachedMemory = this.ctx.db
			.select({ memoryMb: workloads.memoryMb })
			.from(workloads)
			.where(inArray(workloads.projectId, parseJson<string[]>(row.projectIdsJson, [])))
			.all()
			.reduce((sum, item) => sum + item.memoryMb, 0);
		const decision = resolvePlacement({
			runtime: 'container',
			requested: row.targetNodeId,
			memoryMb: db.memoryMb + attachedMemory,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok) {
			this.abort(row, decision.message);
			return 'aborted';
		}
		let hostPort: number;
		let poolerPort: number | null;
		try {
			hostPort = this.ctx.databases.allocatePort(row.targetNodeId);
			poolerPort = db.poolerPort !== null ? this.ctx.databases.allocatePoolerPort(row.targetNodeId) : null;
		} catch (error) {
			this.abort(row, error instanceof Error ? error.message : String(error));
			return 'aborted';
		}
		const targetName = this.nodeRef(row.targetNodeId).name ?? row.targetNodeId;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(databases)
				.set({
					nodeId: row.targetNodeId,
					hostPort,
					poolerPort,
					volumeId: row.targetVolumeId,
					status: 'pending',
					pendingRestoreId: row.backupId,
					message:
						row.dataSource === 'empty'
							? `Moving to ${targetName}: starting empty.`
							: `Moving to ${targetName}: restoring ${row.dataSource === 'latest-backup' ? 'its latest backup' : 'the final backup'}.`,
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'restoring', updatedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
			// Dumps queued on a database that could not run would never start; drop them.
			if (row.dataSource !== 'dump')
				this.ctx.db
					.update(databaseBackups)
					.set({ status: 'failed', error: 'The database moved to another node first.', finishedAt: now })
					.where(and(eq(databaseBackups.databaseId, db.id), inArray(databaseBackups.status, ['pending', 'running'])))
					.run();
		})();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.move-cutover',
			resource: 'database',
			resourceId: db.id,
			args: { name: db.name, to: row.targetNodeId, backupId: row.backupId, from: row.dataSource },
			result: 'ok',
		});
		// Nothing to restore: the target simply starts an empty instance.
		if (!row.backupId) {
			const moved = this.ctx.db.select().from(databases).where(eq(databases.id, db.id)).get();
			if (moved) this.finish(this.requireMove(row.id), moved);
			return 'finished';
		}
		this.ctx.projects.bump(db.orgId);
		return 'restoring';
	}

	/** The target restored the dump: attached apps follow, and the source copy is purged. */
	private finish(row: MoveRow, db: DatabaseRow): void {
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(databases)
				.set({
					pendingRestoreId: null,
					message: null,
					backupEnabled: row.backupWasEnabled,
					nextBackupAt: row.backupWasEnabled ? nextCronTime(db.backupSchedule, now) : null,
					// Only a restore proves anything; an empty start verifies no backup.
					lastVerifiedAt: row.backupId ? now : db.lastVerifiedAt,
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
			if (row.backupId)
				this.ctx.db
					.update(databaseBackups)
					.set({ verifiedAt: now })
					.where(eq(databaseBackups.id, row.backupId))
					.run();
			// pg_dump carries no roles: grant every named credential again, with its existing password.
			for (const credential of this.ctx.db
				.select()
				.from(databaseCredentials)
				.where(
					and(
						eq(databaseCredentials.databaseId, db.id),
						eq(databaseCredentials.status, 'ready'),
						inArray(databaseCredentials.role, ['app', 'readonly', 'backup']),
					),
				)
				.all())
				this.ctx.db
					.update(databaseCredentials)
					.set({ status: 'pending', pendingSecretSealed: credential.secretSealed, updatedAt: now })
					.where(eq(databaseCredentials.id, credential.id))
					.run();
			for (const projectId of parseJson<string[]>(row.projectIdsJson, [])) {
				const workload = this.ctx.db
					.select({ nodeId: workloads.nodeId })
					.from(workloads)
					.where(eq(workloads.projectId, projectId))
					.get();
				this.repointProject(projectId, workload?.nodeId ?? row.sourceNodeId, row.targetNodeId, now, { pinPlacement: false });
			}
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'purging', outcome: 'moved', purgeNodeId: row.sourceNodeId, updatedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
		})();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.move-ok',
			resource: 'database',
			resourceId: db.id,
			args: { name: db.name, from: row.sourceNodeId, to: row.targetNodeId, source: row.dataSource },
			result: 'ok',
		});
		this.ctx.projects.bump(db.orgId);
	}

	/** Back to the source, whose data was never touched; the target's partial copy is purged. */
	private rollBack(row: MoveRow, error: string): void {
		const db = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		if (!db) return;
		const now = this.ctx.now();
		const sourceName = this.nodeRef(row.sourceNodeId).name ?? row.sourceNodeId;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(databases)
				.set({
					nodeId: row.sourceNodeId,
					hostPort: row.sourceHostPort,
					poolerPort: row.sourcePoolerPort,
					volumeId: row.sourceVolumeId,
					status: 'pending',
					pendingRestoreId: null,
					backupEnabled: row.backupWasEnabled,
					nextBackupAt: row.backupWasEnabled ? nextCronTime(db.backupSchedule, now) : null,
					message: `Move failed and was rolled back; still on ${sourceName}. ${error}`.slice(0, 1_000),
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'purging', outcome: 'rolled_back', purgeNodeId: row.targetNodeId, error, updatedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
		})();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.move-failed',
			resource: 'database',
			resourceId: db.id,
			args: { name: db.name, from: row.sourceNodeId, to: row.targetNodeId, rolledBack: true },
			result: 'error',
			error,
		});
		this.ctx.projects.bump(db.orgId);
	}

	/** Give up before the cut-over: nothing moved, so the apps simply start again. */
	private abort(row: MoveRow, error: string): void {
		const db = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			if (row.backupId)
				this.ctx.db
					.update(databaseBackups)
					.set({ status: 'failed', error: 'The move was abandoned.', finishedAt: now })
					.where(and(eq(databaseBackups.id, row.backupId), inArray(databaseBackups.status, ['pending', 'running'])))
					.run();
			if (db)
				this.ctx.db
					.update(databases)
					.set({
						backupEnabled: row.backupWasEnabled,
						nextBackupAt: row.backupWasEnabled ? nextCronTime(db.backupSchedule, now) : null,
						// The move row keeps the error; the dashboard shows it from there.
						message: null,
						updatedAt: now,
					})
					.where(eq(databases.id, db.id))
					.run();
			this.ctx.db
				.update(databaseMoves)
				.set({ phase: 'failed', error, updatedAt: now, finishedAt: now })
				.where(eq(databaseMoves.id, row.id))
				.run();
		})();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.move-failed',
			resource: 'database',
			resourceId: row.databaseId,
			args: { name: db?.name ?? null, from: row.sourceNodeId, to: row.targetNodeId, rolledBack: false },
			result: 'error',
			error,
		});
		this.ctx.projects.bump(row.orgId);
	}

	/**
	 * Re-point a project's workload (and the deployments a rollback would restore) at `to`.
	 * An explicit app move pins the placement to the target; a project following its database
	 * only drops a specific-node placement that would now conflict with it (D56).
	 */
	private repointProject(projectId: string, from: string, to: string, now: number, options: { pinPlacement: boolean }): void {
		this.ctx.db
			.update(workloads)
			.set({ nodeId: to, status: 'pending', message: null, updatedAt: now })
			.where(eq(workloads.projectId, projectId))
			.run();
		this.ctx.db
			.update(deployments)
			.set({ nodeId: to })
			.where(and(eq(deployments.projectId, projectId), eq(deployments.nodeId, from)))
			.run();
		const project = this.ctx.db.select({ placement: projects.placement }).from(projects).where(eq(projects.id, projectId)).get();
		if (!project) return;
		const placement = options.pinPlacement ? to : project.placement === 'auto' ? 'auto' : to;
		if (placement !== project.placement)
			this.ctx.db.update(projects).set({ placement, updatedAt: now }).where(eq(projects.id, projectId)).run();
	}

	private closeStudios(databaseId: string, now: number): void {
		this.ctx.db
			.update(databaseStudioSessions)
			.set({ closedAt: now, closeReason: 'closed' })
			.where(and(eq(databaseStudioSessions.databaseId, databaseId), isNull(databaseStudioSessions.closedAt)))
			.run();
	}

	private activeMoves(): MoveRow[] {
		return this.ctx.db.select().from(databaseMoves).where(inArray(databaseMoves.phase, [...ACTIVE_PHASES])).all();
	}

	private activeFor(databaseId: string): MoveRow | undefined {
		return this.ctx.db
			.select()
			.from(databaseMoves)
			.where(and(eq(databaseMoves.databaseId, databaseId), inArray(databaseMoves.phase, [...ACTIVE_PHASES])))
			.get();
	}

	private requireMove(id: string): MoveRow {
		const row = this.ctx.db.select().from(databaseMoves).where(eq(databaseMoves.id, id)).get();
		if (!row) throw new NotFoundError('Move');
		return row;
	}

	private nodeRef(nodeId: string): { nodeId: string; name: string | null } {
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return { nodeId, name: node?.name ?? null };
	}

	private view(row: MoveRow): DatabaseMoveView {
		const db = this.ctx.db.select({ name: databases.name }).from(databases).where(eq(databases.id, row.databaseId)).get();
		const projectIds = parseJson<string[]>(row.projectIdsJson, []);
		const slugs = projectIds.length
			? this.ctx.db
					.select({ slug: projects.slug })
					.from(projects)
					.where(inArray(projects.id, projectIds))
					.all()
					.map((item) => item.slug)
			: [];
		return {
			id: row.id,
			databaseId: row.databaseId,
			databaseName: db?.name ?? row.databaseId,
			phase: row.phase,
			from: row.dataSource,
			outcome: row.outcome,
			source: this.nodeRef(row.sourceNodeId),
			target: this.nodeRef(row.targetNodeId),
			projects: slugs.sort(),
			backupId: row.backupId,
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
			operationId: this.ctx.flows.idFor(DATABASE_MOVE_FLOW, row.id),
		};
	}
}
