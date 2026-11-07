import { hostname } from 'node:os';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { databaseReplicas, databases, failoverEvents, nodes } from '@skiff/db';
import {
	canViewPlatform,
	failoverEventKinds,
	type ClusterConfig,
	type DatabaseReplica,
	type FailoverEventKind,
	type FailoverEventStatus,
	type FailoverEventView,
	type FailoverLeaseState,
	type FailoverPlan,
	type FailoverStage,
	type FailoverStatusView,
	type IngressDriver,
	type LeasePolicy,
	type NodeRole,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { chooseReplicaForPromotion } from './database-replicas.ts';
import { CoreError } from './errors.ts';
import { canAdvance } from './failover.ts';
import { IngressHealth } from './ingress-health.ts';
import { ControlPlaneLease, SqliteLeaseStore, type LeaseDecision } from './lease.ts';
import { OFFLINE_AFTER_MS } from './nodes.ts';
import { buildPrincipal } from './orgs.ts';
import { newId, parseJson, randomToken } from './util.ts';
import type { ReplicaCopy } from './workloads.ts';

/**
 * The failover controller (docs/CLUSTERING.md §8.3, §9.3, §11; phase C8).
 *
 * One `tick()` every few seconds from the control plane's loop. Only the holder of the controller
 * lease acts, and every write it makes checks the lease again inside its own transaction, so a
 * deposed controller (an old primary still running during an update) cannot land a change. It:
 *
 * - re-places spread replica copies off a node that has been silent for
 *   `replicas.failoverGraceSeconds` (only when `failover.enabled`) or is draining (always), under
 *   the §8.3 rate limits, with flap protection, one audit row per move and a 10-minute queue expiry;
 * - tracks the intended ingress record set for the DNS drivers and records each withdrawal or
 *   re-add as a `manual` event, because no driver writes DNS yet;
 * - takes a database whose primary node is lost to the `decide` stage, picks the replica a
 *   promotion would use, and hands the remaining stages to a registered handler. Without one (or
 *   with failover off) it records a `manual` event and pages.
 */

export const FAILOVER_LEASE_KEY = 'ha:failover_lease';
export const INGRESS_ROTATION_KEY = 'ha:ingress_rotation';
/** §8.3 step 5. */
export const FAILOVER_PER_TARGET_PER_MINUTE = 2;
export const FAILOVER_QUEUE_EXPIRY_MS = 10 * 60_000;
export const FAILOVER_COMPLETION_TIMEOUT_MS = 10 * 60_000;
/** A node that was a failover source is not a move target for this long. */
export const FAILOVER_FLAP_WINDOW_MS = 30 * 60_000;
/** Ingress: re-add one node at most this often, and pin a node withdrawn twice inside the flap window. */
export const INGRESS_READD_INTERVAL_MS = 10 * 60_000;
export const INGRESS_MIN_HOLD_DOWN_MS = 120_000;
const MINUTE_MS = 60_000;
const HISTORY_LIMIT = 50;
/** Drivers whose record set the controller tracks; the others have nothing to rotate. */
const ROTATING_DRIVERS: ReadonlySet<IngressDriver> = new Set(['dns-failover', 'cloudflare-lb']);

const OPEN_REPLICA: FailoverEventStatus[] = ['queued', 'blocked', 'in-progress'];
const OPEN_DATABASE: FailoverEventStatus[] = ['queued', 'blocked', 'in-progress', 'manual'];

/** The fencing token a handler checks before each irreversible step. */
export interface FailoverFence {
	epoch: number;
	holderId: string;
	/** True while this controller still holds the lease at `epoch`. */
	holds(): boolean;
}

/** What a handler reports for one stage; `waiting` is asked again on the next tick. */
export type FailoverStageOutcome =
	| { status: 'done'; message?: string }
	| { status: 'waiting'; message?: string }
	| { status: 'failed'; message: string };

/** The stages a database handler executes; the controller owns `detect`, `decide` and `complete`. */
export type FailoverHandlerStage = Extract<FailoverStage, 'fence' | 'promote' | 'repoint' | 'heal'>;

/**
 * The integration point for automatic database promotion (read replicas, A8/C7). The controller
 * calls `run` for `fence`, `promote`, `repoint` and `heal` in that order, once per tick until each
 * reports `done`. `plan.stage` is the stage being asked for. A handler must check `fence.holds()`
 * immediately before anything it cannot undo.
 */
export interface FailoverDatabaseHandler {
	run(stage: FailoverHandlerStage, plan: FailoverPlan, fence: FailoverFence): Promise<FailoverStageOutcome> | FailoverStageOutcome;
}

export interface FailoverTickReport {
	lease: FailoverLeaseState;
	epoch: number;
	/** Copies moved this tick. */
	moved: number;
	completed: number;
	queued: number;
	blocked: number;
	expired: number;
	ingress: { withdrawn: string[]; added: string[] };
	databases: { manual: number; started: number; advanced: number; failed: number };
}

interface NodeFact {
	id: string;
	name: string;
	zone: string;
	status: string;
	mode: string;
	roles: NodeRole[];
	lastHeartbeatAt: number | null;
	silentMs: number;
	/** Silent past `failover.graceSeconds` (ingress, databases). */
	lost: boolean;
	/** Silent past `replicas.failoverGraceSeconds`. */
	replicaLost: boolean;
	/** Silent past `OFFLINE_AFTER_MS`, so not a move target even if its row still says online. */
	unreachable: boolean;
}

interface RotationState {
	records: string[] | null;
	withdrawals: Record<string, number[]>;
	pinnedUntil: Record<string, number>;
	lastAddAt: Record<string, number>;
}

type EventRow = typeof failoverEvents.$inferSelect;
type Alert = { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' };

class FencedError extends Error {
	constructor() {
		super('The failover controller lost its lease; the change was not written.');
	}
}

export class FailoverService {
	/** This process's identity in the lease; unique per start, so a restart is a new holder. */
	readonly holderId: string;
	readonly #store: SqliteLeaseStore;
	readonly #ingress = new IngressHealth();
	#handler: FailoverDatabaseHandler | null = null;
	#lastTickAt: number | null = null;
	#lastLease: { state: FailoverLeaseState; epoch: number } | null = null;
	#running = false;

	constructor(
		private readonly ctx: CoreContext,
		options: { holderId?: string } = {},
	) {
		this.holderId = options.holderId ?? `${hostname()}:${process.pid}:${randomToken(4)}`;
		this.#store = new SqliteLeaseStore(ctx.sqlite, FAILOVER_LEASE_KEY, () => ctx.now());
	}

	/**
	 * Install the automatic database promotion path. Returns an unregister function. With no
	 * handler, a lost primary is a `manual` event and a critical alert.
	 */
	registerDatabaseHandler(handler: FailoverDatabaseHandler): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = null;
		};
	}

	/** Milliseconds between ticks: `renewSeconds`, capped at a third of the lease TTL. */
	intervalMs(config: ClusterConfig = this.ctx.cluster.get()): number {
		const { leaseTtlSeconds, renewSeconds } = config.controlPlane;
		return Math.max(1, Math.min(renewSeconds, Math.floor(leaseTtlSeconds / 3))) * 1000;
	}

	/** The lease policy: renew on every tick, so the TTL is the most a dead holder can block. */
	leasePolicy(config: ClusterConfig = this.ctx.cluster.get()): LeasePolicy {
		const ttlMs = config.controlPlane.leaseTtlSeconds * 1000;
		const renewBeforeMs = Math.min(299_000, ttlMs - 1000, Math.max(1000, ttlMs - this.intervalMs(config)));
		return { ttlMs, renewBeforeMs };
	}

	/** Give up the lease (clean shutdown), so another control plane need not wait for the TTL. */
	async release(): Promise<void> {
		await new ControlPlaneLease(this.#store, this.holderId, this.leasePolicy()).release();
	}

	async tick(): Promise<FailoverTickReport> {
		const report: FailoverTickReport = {
			lease: 'idle',
			epoch: 0,
			moved: 0,
			completed: 0,
			queued: 0,
			blocked: 0,
			expired: 0,
			ingress: { withdrawn: [], added: [] },
			databases: { manual: 0, started: 0, advanced: 0, failed: 0 },
		};
		// A slow tick (a handler awaiting a node) must not overlap the next one.
		if (this.#running) return { ...report, lease: this.#lastLease?.state ?? 'idle', epoch: this.#lastLease?.epoch ?? 0 };
		this.#running = true;
		const alerts: Alert[] = [];
		try {
			const config = this.ctx.cluster.get();
			const now = this.ctx.now();
			const decision = await new ControlPlaneLease(this.#store, this.holderId, this.leasePolicy(config)).acquire(now);
			this.#noteLease(decision, now, alerts);
			report.lease = decision.state;
			report.epoch = decision.record.epoch;
			this.#lastTickAt = now;
			if (decision.state !== 'holder') return report;
			const epoch = decision.record.epoch;
			const fence: FailoverFence = {
				epoch,
				holderId: this.holderId,
				holds: () => this.#store.holdsSync(this.holderId, epoch, this.ctx.now()),
			};
			const facts = this.#nodeFacts(now, config);
			try {
				this.#replicaTick(now, config, fence, facts, report, alerts);
				this.#ingressTick(now, fence, facts, report, alerts);
				await this.#databaseTick(config, fence, facts, report, alerts);
			} catch (error) {
				if (!(error instanceof FencedError)) throw error;
				report.lease = 'fenced';
			}
			return report;
		} finally {
			this.#running = false;
			for (const alert of alerts) await this.#notify(alert).catch(() => undefined);
		}
	}

	// ------------------------------------------------------------------ lease

	#noteLease(decision: LeaseDecision, now: number, alerts: Alert[]): void {
		const previous = this.#lastLease;
		const epoch = decision.record.epoch;
		if (decision.state === 'holder' && (previous?.state !== 'holder' || previous.epoch !== epoch)) {
			this.#insertEvent({
				kind: 'lease',
				status: 'completed',
				stage: 'complete',
				subjectId: FAILOVER_LEASE_KEY,
				subjectName: this.holderId,
				reason: `This control plane holds the failover lease at epoch ${epoch}.`,
				epoch,
				detectedAt: now,
				appliedAt: now,
				finishedAt: now,
			});
		} else if (previous?.state === 'holder' && decision.state !== 'holder') {
			const reason =
				decision.state === 'fenced'
					? `Lost the failover lease at epoch ${previous.epoch}: another control plane wrote it first. This one stopped acting.`
					: `The failover lease moved to ${decision.record.holderNodeId} at epoch ${epoch}. This control plane stopped acting.`;
			this.#insertEvent({
				kind: 'lease',
				status: 'failed',
				stage: 'detect',
				subjectId: FAILOVER_LEASE_KEY,
				subjectName: this.holderId,
				reason,
				epoch: previous.epoch,
				detectedAt: now,
				finishedAt: now,
			});
			alerts.push({ key: 'failover:lease', title: 'Failover controller lost its lease', detail: reason, severity: 'critical' });
		}
		this.#lastLease = { state: decision.state, epoch };
	}

	// ------------------------------------------------------------------ nodes

	#nodeFacts(now: number, config: ClusterConfig): Map<string, NodeFact> {
		const graceMs = config.failover.graceSeconds * 1000;
		const replicaGraceMs = config.replicas.failoverGraceSeconds * 1000;
		const facts = new Map<string, NodeFact>();
		for (const row of this.ctx.db.select().from(nodes).all()) {
			const view = this.ctx.nodes.view(row);
			const silentMs = Math.max(0, now - (row.lastHeartbeatAt ?? row.createdAt));
			facts.set(row.id, {
				id: row.id,
				name: row.name,
				zone: row.zone,
				status: row.status,
				mode: row.mode,
				roles: view.roles,
				lastHeartbeatAt: row.lastHeartbeatAt,
				silentMs,
				lost: silentMs >= graceMs,
				replicaLost: silentMs >= replicaGraceMs,
				unreachable: silentMs >= OFFLINE_AFTER_MS,
			});
		}
		return facts;
	}

	// ------------------------------------------------------------------ replica copies (§8.3)

	#replicaTick(
		now: number,
		config: ClusterConfig,
		fence: FailoverFence,
		facts: Map<string, NodeFact>,
		report: FailoverTickReport,
		alerts: Alert[],
	): void {
		const copies = this.ctx.workloads.replicaCopies();
		const byId = new Map(copies.map((copy) => [copy.id, copy]));
		const open = this.ctx.db
			.select()
			.from(failoverEvents)
			.where(and(eq(failoverEvents.kind, 'replica'), inArray(failoverEvents.status, OPEN_REPLICA)))
			.all();

		// 1. Applied moves complete when the copy reports running from its new node.
		for (const event of open.filter((row) => row.status === 'in-progress')) {
			const copy = byId.get(event.subjectId);
			if (!copy) this.#finish(fence, event, 'cancelled', now, 'The copy was removed before it started.');
			else if (copy.nodeId !== event.toNodeId)
				this.#finish(fence, event, 'cancelled', now, 'A deploy re-placed the copy before it started.');
			else if (copy.status === 'running') {
				this.#finish(fence, event, 'completed', now, event.reason);
				report.completed += 1;
			} else if (copy.status === 'failed' || now - (event.appliedAt ?? event.detectedAt) >= FAILOVER_COMPLETION_TIMEOUT_MS) {
				const reason =
					copy.status === 'failed'
						? `The copy failed on ${this.#nodeName(facts, copy.nodeId)}.`
						: `The copy did not report running on ${this.#nodeName(facts, copy.nodeId)} within 10 minutes.`;
				this.#finish(fence, event, 'failed', now, reason);
				alerts.push({
					key: `failover:replica:${copy.id}`,
					title: `Failover of ${copy.projectSlug} [r${copy.replicaIndex}] failed`,
					detail: reason,
					severity: 'warning',
				});
			}
		}

		// 2. Which copies need a new node: on a draining node always, on a lost one when enabled.
		const needs = new Map<string, 'drain' | 'failover'>();
		for (const copy of copies) {
			const node = facts.get(copy.nodeId);
			if (node?.status === 'draining') needs.set(copy.id, 'drain');
			else if (config.failover.enabled && (!node || node.replicaLost)) needs.set(copy.id, 'failover');
		}

		// 3. Waiting moves the fleet no longer needs are cancelled; old ones expire and alert.
		const waiting = new Map<string, EventRow>();
		for (const event of open.filter((row) => row.status === 'queued' || row.status === 'blocked')) {
			const copy = byId.get(event.subjectId);
			if (!copy || copy.nodeId !== event.fromNodeId || !needs.has(copy.id)) {
				this.#finish(
					fence,
					event,
					'cancelled',
					now,
					!copy
						? 'The copy was removed.'
						: copy.nodeId !== event.fromNodeId
							? 'The copy was re-placed by a deploy.'
							: `${this.#nodeName(facts, copy.nodeId)} came back before the move ran.`,
				);
			} else if (now - event.detectedAt >= FAILOVER_QUEUE_EXPIRY_MS) {
				this.#finish(fence, event, 'expired', now, `Not moved within 10 minutes: ${event.reason}`);
				report.expired += 1;
				alerts.push({
					key: `failover:replica:${copy.id}`,
					title: `Failover of ${copy.projectSlug} [r${copy.replicaIndex}] expired`,
					detail: `The move off ${this.#nodeName(facts, copy.nodeId)} waited 10 minutes and was dropped: ${event.reason}`,
					severity: 'warning',
				});
			} else waiting.set(copy.id, event);
		}

		// 4. New moves are queued at `detect`. A move that expired is not queued again for the same
		// node inside the flap window: the fleet it was decided for has changed.
		const detection = (copy: ReplicaCopy) => sourceReason(facts.get(copy.nodeId), copy.nodeId, needs.get(copy.id)!);
		const expired = this.#recentlyExpired(now);
		for (const [copyId] of needs) {
			if (waiting.has(copyId) || open.some((row) => row.status === 'in-progress' && row.subjectId === copyId)) continue;
			if (expired.has(`${copyId}:${byId.get(copyId)!.nodeId}`)) continue;
			const copy = byId.get(copyId)!;
			const reason = detection(copy);
			const event = this.#insertEvent({
				kind: 'replica',
				status: 'queued',
				stage: 'detect',
				subjectId: copy.id,
				subjectName: `${copy.projectSlug} [r${copy.replicaIndex}]`,
				orgId: copy.orgId,
				fromNodeId: copy.nodeId,
				reason,
				epoch: fence.epoch,
				detectedAt: now,
			});
			waiting.set(copyId, event);
		}

		// 5. Apply in §8.3 order under the rate limits.
		const inFlight = new Set(
			open
				.filter((row) => row.status === 'in-progress' && byId.has(row.subjectId))
				.map((row) => byId.get(row.subjectId)!.workloadId),
		);
		const recent = this.#appliedSince(now - MINUTE_MS);
		let fleetCount = recent.length;
		const perTarget = new Map<string, number>();
		for (const row of recent) if (row.toNodeId) perTarget.set(row.toNodeId, (perTarget.get(row.toNodeId) ?? 0) + 1);
		const flapping = this.#recentSources(now);
		// planReplicaMove only takes `online` rows; a node silent past 30 s may not be marked yet.
		const unfit = [...facts.values()].filter((fact) => fact.unreachable || fact.status !== 'online').map((fact) => fact.id);
		const ordered = [...waiting.values()]
			.map((event) => ({ event, copy: byId.get(event.subjectId)! }))
			.sort(
				(a, b) =>
					rank(a.copy) - rank(b.copy) ||
					a.copy.replicaIndex - b.copy.replicaIndex ||
					a.event.detectedAt - b.event.detectedAt,
			);
		for (const { event, copy } of ordered) {
			if (fleetCount >= config.failover.maxPerMinute) {
				report.queued += 1;
				this.#note(fence, event, 'queued', now, `${detection(copy)} Waiting for the fleet rate limit (${config.failover.maxPerMinute}/min).`);
				continue;
			}
			if (inFlight.has(copy.workloadId)) {
				report.queued += 1;
				this.#note(fence, event, 'queued', now, `${detection(copy)} Waiting for another copy of this workload to finish moving.`);
				continue;
			}
			const base = new Set<string>([...flapping, ...unfit]);
			const saturated = [...perTarget].filter(([, count]) => count >= FAILOVER_PER_TARGET_PER_MINUTE).map(([id]) => id);
			const plan = this.ctx.workloads.planReplicaMove(copy.id, new Set([...base, ...saturated]));
			// A target that is only busy is a wait, not a block: the copy moves there next minute.
			if (!plan.ok && saturated.length > 0 && this.ctx.workloads.planReplicaMove(copy.id, base).ok) {
				report.queued += 1;
				this.#note(
					fence,
					event,
					'queued',
					now,
					`${detection(copy)} Waiting for the per-target rate limit (${FAILOVER_PER_TARGET_PER_MINUTE}/min).`,
				);
				continue;
			}
			if (!plan.ok) {
				report.blocked += 1;
				if (event.status !== 'blocked')
					alerts.push({
						key: `failover:replica:${copy.id}`,
						title: `No node can take ${copy.projectSlug} [r${copy.replicaIndex}]`,
						detail: `${detection(copy)} ${plan.message}`,
						severity: 'warning',
					});
				this.#note(fence, event, 'blocked', now, `${detection(copy)} ${plan.message}`);
				continue;
			}
			const why = needs.get(copy.id)!;
			this.#fenced(fence, () => {
				this.ctx.workloads.moveReplica(copy.id, plan.nodeId, why);
				this.ctx.db
					.update(failoverEvents)
					.set({
						status: 'in-progress',
						stage: walkFailoverStages(event.stage, 'promote'),
						toNodeId: plan.nodeId,
						reason: `${detection(copy)} Moving to ${plan.nodeName}.`,
						epoch: fence.epoch,
						appliedAt: now,
						updatedAt: now,
					})
					.where(eq(failoverEvents.id, event.id))
					.run();
				this.ctx.audit.record({
					principal: systemPrincipal(copy.orgId),
					action: 'ha.failover',
					resource: 'workload_replica',
					resourceId: copy.id,
					orgId: copy.orgId,
					args: {
						kind: 'replica',
						reason: why,
						project: copy.projectSlug,
						workloadId: copy.workloadId,
						replica: copy.replicaIndex,
						from: copy.nodeId,
						to: plan.nodeId,
						epoch: fence.epoch,
						eventId: event.id,
					},
					result: 'ok',
				});
			});
			report.moved += 1;
			fleetCount += 1;
			perTarget.set(plan.nodeId, (perTarget.get(plan.nodeId) ?? 0) + 1);
			inFlight.add(copy.workloadId);
			alerts.push({
				key: `failover:replica:${copy.id}`,
				title: `Moved ${copy.projectSlug} [r${copy.replicaIndex}] to ${plan.nodeName}`,
				detail: `${detection(copy)} The failover controller re-placed the copy on ${plan.nodeName} (lease epoch ${fence.epoch}).`,
				severity: 'info',
			});
		}
	}

	// ------------------------------------------------------------------ ingress rotation (§7.2)

	#ingressTick(now: number, fence: FailoverFence, facts: Map<string, NodeFact>, report: FailoverTickReport, alerts: Alert[]): void {
		const policies = this.ctx.policies.get();
		const ingressNodes = [...facts.values()].filter((fact) => fact.roles.includes('ingress'));
		for (const fact of ingressNodes) this.#ingress.observe({ nodeId: fact.id, ok: ingressHealthy(fact), at: now });
		if (!ROTATING_DRIVERS.has(policies.ingressDriver)) return;

		const ids = ingressNodes.map((fact) => fact.id);
		const state = this.#rotation();
		let changed = false;
		if (state.records === null) {
			state.records = ids;
			changed = true;
		}
		const records = state.records.filter((id) => ids.includes(id));
		if (records.length !== state.records.length) changed = true;
		for (const [id, until] of Object.entries(state.pinnedUntil))
			if (until <= now) {
				delete state.pinnedUntil[id];
				changed = true;
			}
		for (const [id, times] of Object.entries(state.withdrawals)) {
			const kept = times.filter((at) => now - at < FAILOVER_FLAP_WINDOW_MS);
			if (kept.length !== times.length) {
				changed = true;
				if (kept.length) state.withdrawals[id] = kept;
				else delete state.withdrawals[id];
			}
		}
		const holdDownMs = this.#ingressHoldDownMs();
		const decision = this.#ingress.decision(ids, records, now, {
			holdDownMs,
			readdHoldDownMs: Math.min(3_600_000, policies.ingressReaddSeconds * 1000),
			minHealthy: 1,
		});
		const writes: Array<() => void> = [];
		for (const id of decision.remove) {
			const fact = facts.get(id)!;
			records.splice(records.indexOf(id), 1);
			const times = [...(state.withdrawals[id] ?? []), now];
			state.withdrawals[id] = times;
			const pinned = times.length >= 2;
			if (pinned) state.pinnedUntil[id] = now + FAILOVER_FLAP_WINDOW_MS;
			changed = true;
			report.ingress.withdrawn.push(id);
			const reason =
				`Withdraw ${fact.name} from the ${policies.ingressDriver} record set: ` +
				(fact.unreachable ? `no heartbeat for ${Math.round(fact.silentMs / 1000)}s.` : 'it reports its proxy (Caddy) down.') +
				' The driver does not write DNS yet, so remove its record by hand.' +
				(pinned ? ' Withdrawn twice in 30 minutes: it stays out for 30 minutes.' : '');
			writes.push(() =>
				this.#insertEvent({
					kind: 'ingress',
					status: 'manual',
					stage: 'decide',
					subjectId: id,
					subjectName: fact.name,
					fromNodeId: id,
					reason,
					epoch: fence.epoch,
					detectedAt: now,
				}),
			);
			alerts.push({ key: `failover:ingress:${id}`, title: `Withdraw ingress ${fact.name}`, detail: reason, severity: 'warning' });
		}
		for (const id of decision.add) {
			if ((state.pinnedUntil[id] ?? 0) > now) continue;
			if (state.lastAddAt[id] !== undefined && now - state.lastAddAt[id]! < INGRESS_READD_INTERVAL_MS) continue;
			const fact = facts.get(id)!;
			records.push(id);
			state.lastAddAt[id] = now;
			changed = true;
			report.ingress.added.push(id);
			const reason = `Add ${fact.name} back to the ${policies.ingressDriver} record set: healthy for ${policies.ingressReaddSeconds}s. The driver does not write DNS yet, so add its record by hand.`;
			writes.push(() =>
				this.#insertEvent({
					kind: 'ingress',
					status: 'manual',
					stage: 'decide',
					subjectId: id,
					subjectName: fact.name,
					toNodeId: id,
					reason,
					epoch: fence.epoch,
					detectedAt: now,
				}),
			);
			alerts.push({ key: `failover:ingress:${id}`, title: `Re-add ingress ${fact.name}`, detail: reason, severity: 'info' });
		}
		if (!changed) return;
		state.records = records;
		this.#fenced(fence, () => {
			this.ctx.sqlite.run(
				'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
				[INGRESS_ROTATION_KEY, JSON.stringify(state), now],
			);
			for (const write of writes) write();
		});
	}

	#ingressHoldDownMs(): number {
		return Math.min(600_000, Math.max(2 * this.ctx.policies.get().ingressHoldDownSeconds * 1000, INGRESS_MIN_HOLD_DOWN_MS));
	}

	#rotation(): RotationState {
		const row = this.ctx.sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(INGRESS_ROTATION_KEY);
		const raw = parseJson<Partial<RotationState>>(row?.value, {});
		return {
			records: Array.isArray(raw.records) ? raw.records.filter((id): id is string => typeof id === 'string') : null,
			withdrawals: isRecord(raw.withdrawals) ? (raw.withdrawals as Record<string, number[]>) : {},
			pinnedUntil: isRecord(raw.pinnedUntil) ? (raw.pinnedUntil as Record<string, number>) : {},
			lastAddAt: isRecord(raw.lastAddAt) ? (raw.lastAddAt as Record<string, number>) : {},
		};
	}

	// ------------------------------------------------------------------ databases (§9.3)

	async #databaseTick(
		config: ClusterConfig,
		fence: FailoverFence,
		facts: Map<string, NodeFact>,
		report: FailoverTickReport,
		alerts: Alert[],
	): Promise<void> {
		// A replica being removed is torn down next: it is never a promotion candidate.
		const replicaRows = this.ctx.db
			.select()
			.from(databaseReplicas)
			.all()
			.filter((row) => row.removingAt == null);
		if (replicaRows.length === 0) return;
		const byDatabase = new Map<string, typeof replicaRows>();
		for (const row of replicaRows) byDatabase.set(row.databaseId, [...(byDatabase.get(row.databaseId) ?? []), row]);
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(isNull(databases.deletedAt), inArray(databases.id, [...byDatabase.keys()])))
			.all();
		const open = this.ctx.db
			.select()
			.from(failoverEvents)
			.where(and(eq(failoverEvents.kind, 'database'), inArray(failoverEvents.status, OPEN_DATABASE)))
			.all();
		for (const database of rows) {
			const now = this.ctx.now();
			const primary = facts.get(database.nodeId);
			const lost = !primary || primary.lost;
			const event = open.find((row) => row.subjectId === database.id);
			if (event?.status === 'in-progress') {
				await this.#driveDatabase(event, database.name, database.orgId, fence, report, alerts);
				continue;
			}
			if (event && !lost) {
				this.#finish(fence, event, 'cancelled', now, `${this.#nodeName(facts, database.nodeId)} came back.`);
				continue;
			}
			if (!lost || event?.status === 'manual') continue;
			const choice = this.#promotionChoice(byDatabase.get(database.id) ?? [], facts, config);
			const automatic = config.failover.enabled && this.#handler !== null;
			const silent = `${database.name}: its primary ${sourceReason(primary, database.nodeId, 'failover')}`;
			if (!choice.replica) {
				const reason = `${silent} No replica can be promoted: ${choice.refusals.map((r) => `${this.#nodeName(facts, r.nodeId)}: ${r.reason}`).join('; ') || choice.reason}`;
				if (event) {
					this.#note(fence, event, 'blocked', now, reason);
					continue;
				}
				this.#fenced(fence, () =>
					this.#insertEvent({
						kind: 'database',
						status: 'blocked',
						stage: 'decide',
						subjectId: database.id,
						subjectName: database.name,
						orgId: database.orgId,
						fromNodeId: database.nodeId,
						reason,
						epoch: fence.epoch,
						detectedAt: now,
					}),
				);
				alerts.push({ key: `failover:database:${database.id}`, title: `Database ${database.name} lost its primary`, detail: reason, severity: 'critical' });
				continue;
			}
			const candidate = choice.replica;
			const generation = Math.max(0, ...(byDatabase.get(database.id) ?? []).map((r) => r.primaryGeneration)) + 1;
			if (!automatic) {
				const reason =
					`${silent} Promote the replica on ${this.#nodeName(facts, candidate.nodeId)} by hand ` +
					(config.failover.enabled ? '(no automatic promotion path is installed).' : '(automatic failover is off).');
				this.#fenced(fence, () => {
					if (event) this.#finish(fence, event, 'cancelled', now, 'Superseded: a replica is now eligible.');
					this.#insertEvent({
						kind: 'database',
						status: 'manual',
						stage: 'decide',
						subjectId: database.id,
						subjectName: database.name,
						orgId: database.orgId,
						fromNodeId: database.nodeId,
						toNodeId: candidate.nodeId,
						reason,
						epoch: fence.epoch,
						generation,
						detectedAt: now,
					});
				});
				report.databases.manual += 1;
				alerts.push({ key: `failover:database:${database.id}`, title: `Database ${database.name} needs a manual promotion`, detail: reason, severity: 'critical' });
				continue;
			}
			if (this.#appliedSince(now - MINUTE_MS).length >= config.failover.maxPerMinute) {
				if (!event)
					this.#fenced(fence, () =>
						this.#insertEvent({
							kind: 'database',
							status: 'queued',
							stage: 'detect',
							subjectId: database.id,
							subjectName: database.name,
							orgId: database.orgId,
							fromNodeId: database.nodeId,
							toNodeId: candidate.nodeId,
							reason: `${silent} Waiting for the fleet rate limit.`,
							epoch: fence.epoch,
							generation,
							detectedAt: now,
						}),
					);
				else if (now - event.detectedAt >= FAILOVER_QUEUE_EXPIRY_MS) this.#finish(fence, event, 'expired', now, `Not started within 10 minutes. ${event.reason}`);
				continue;
			}
			const reason = `${silent} Promoting the replica on ${this.#nodeName(facts, candidate.nodeId)} (${choice.reason}).`;
			let started: EventRow | null = null;
			this.#fenced(fence, () => {
				if (event) this.#finish(fence, event, 'cancelled', now, 'Superseded by the automatic failover.');
				started = this.#insertEvent({
					kind: 'database',
					status: 'in-progress',
					stage: 'decide',
					subjectId: database.id,
					subjectName: database.name,
					orgId: database.orgId,
					fromNodeId: database.nodeId,
					toNodeId: candidate.nodeId,
					reason,
					epoch: fence.epoch,
					generation,
					detectedAt: now,
					appliedAt: now,
				});
				this.ctx.audit.record({
					principal: systemPrincipal(database.orgId),
					action: 'ha.failover',
					resource: 'database',
					resourceId: database.id,
					orgId: database.orgId,
					args: { kind: 'database', from: database.nodeId, to: candidate.nodeId, replica: candidate.id, generation, epoch: fence.epoch },
					result: 'ok',
				});
			});
			report.databases.started += 1;
			alerts.push({ key: `failover:database:${database.id}`, title: `Failing over database ${database.name}`, detail: reason, severity: 'critical' });
			if (started) await this.#driveDatabase(started, database.name, database.orgId, fence, report, alerts);
		}
	}

	/** Run the handler for the next stage(s) until one is not `done`. */
	async #driveDatabase(
		event: EventRow,
		name: string,
		orgId: string,
		fence: FailoverFence,
		report: FailoverTickReport,
		alerts: Alert[],
	): Promise<void> {
		let current = event;
		const fail = (message: string) => {
			this.#finish(fence, current, 'failed', this.ctx.now(), message);
			report.databases.failed += 1;
			alerts.push({ key: `failover:database:${event.subjectId}`, title: `Failover of database ${name} failed`, detail: message, severity: 'critical' });
		};
		if (this.ctx.now() - (event.appliedAt ?? event.detectedAt) >= FAILOVER_COMPLETION_TIMEOUT_MS)
			return fail(`Did not complete within 10 minutes (stuck at ${event.stage}).`);
		const handler = this.#handler;
		if (!handler) return fail('The automatic promotion path was removed while the failover ran. Finish it by hand.');
		for (;;) {
			const next = nextStage(current.stage);
			if (!next) return;
			if (next === 'complete') {
				this.#finish(fence, current, 'completed', this.ctx.now(), current.reason);
				alerts.push({
					key: `failover:database:${event.subjectId}`,
					title: `Database ${name} failed over`,
					detail: `Promoted the replica on ${current.toNodeId} at generation ${current.generation ?? '?'} (lease epoch ${fence.epoch}).`,
					severity: 'info',
				});
				return;
			}
			const plan: FailoverPlan = {
				databaseId: current.subjectId,
				candidateNodeId: current.toNodeId!,
				generation: current.generation ?? 1,
				stage: next,
				reason: current.reason.slice(0, 200),
			};
			if (!fence.holds()) throw new FencedError();
			let outcome: FailoverStageOutcome;
			try {
				// `decide` is the controller's own stage (an event recorded at `detect`); the rest are the handler's.
				outcome = next === 'decide' ? { status: 'done' } : await handler.run(next, plan, fence);
			} catch (error) {
				outcome = { status: 'failed', message: error instanceof Error ? error.message : String(error) };
			}
			if (outcome.status === 'failed') return fail(`${next}: ${outcome.message}`);
			if (outcome.status === 'waiting') return;
			const now = this.ctx.now();
			this.#fenced(fence, () =>
				this.ctx.db.update(failoverEvents).set({ stage: next, updatedAt: now }).where(eq(failoverEvents.id, current.id)).run(),
			);
			this.ctx.audit.record({
				principal: systemPrincipal(orgId),
				action: 'ha.failover',
				resource: 'database',
				resourceId: current.subjectId,
				orgId,
				args: { kind: 'database', stage: next, epoch: fence.epoch, eventId: current.id, message: outcome.message },
				result: 'ok',
			});
			current = { ...current, stage: next, updatedAt: now };
			report.databases.advanced += 1;
		}
	}

	#promotionChoice(rows: Array<typeof databaseReplicas.$inferSelect>, facts: Map<string, NodeFact>, config: ClusterConfig) {
		// A replica on a node that is itself silent cannot be promoted, whatever it last reported.
		const replicas: DatabaseReplica[] = rows.map((row) => {
			const node = facts.get(row.nodeId);
			const reachable = node !== undefined && !node.unreachable && node.status !== 'offline';
			return {
				id: row.id,
				databaseId: row.databaseId,
				nodeId: row.nodeId,
				status: reachable ? row.status : 'lost',
				replayLsn: row.replayLsn,
				lagBytes: row.lagBytes,
				lagSeconds: row.lagSeconds,
				slot: row.slot,
				primaryGeneration: row.primaryGeneration,
			};
		});
		// A pending replica never streamed: it holds no data to promote.
		const choice = chooseReplicaForPromotion(
			replicas.filter((replica) => replica.status !== 'pending'),
			{ maxLagBytes: config.database.maxLagBytes, maxLagSeconds: config.database.maxLagSeconds },
		);
		const pending = replicas
			.filter((replica) => replica.status === 'pending')
			.map((replica) => ({ id: replica.id, nodeId: replica.nodeId, reason: 'replica is pending (it has not streamed)' }));
		return { ...choice, refusals: [...choice.refusals, ...pending] };
	}

	// ------------------------------------------------------------------ reads

	status(principal: Principal): FailoverStatusView {
		requireViewer(principal);
		const config = this.ctx.cluster.get();
		const now = this.ctx.now();
		const facts = this.#nodeFacts(now, config);
		const copies = this.ctx.workloads.replicaCopies();
		const copiesByNode = new Map<string, number>();
		for (const copy of copies) copiesByNode.set(copy.nodeId, (copiesByNode.get(copy.nodeId) ?? 0) + 1);
		const policies = this.ctx.policies.get();
		const rotation = this.#rotation();
		const rotates = ROTATING_DRIVERS.has(policies.ingressDriver);
		const handler = this.#handler !== null;

		// A replica being removed is torn down next: it is never a promotion candidate.
		const replicaRows = this.ctx.db
			.select()
			.from(databaseReplicas)
			.all()
			.filter((row) => row.removingAt == null);
		const byDatabase = new Map<string, typeof replicaRows>();
		for (const row of replicaRows) byDatabase.set(row.databaseId, [...(byDatabase.get(row.databaseId) ?? []), row]);
		const databaseRows = byDatabase.size
			? this.ctx.db
					.select()
					.from(databases)
					.where(and(isNull(databases.deletedAt), inArray(databases.id, [...byDatabase.keys()])))
					.all()
			: [];

		const recentApplied = this.#appliedSince(now - MINUTE_MS);
		const open = this.ctx.db
			.select({ status: failoverEvents.status })
			.from(failoverEvents)
			.where(inArray(failoverEvents.status, ['queued', 'blocked', 'in-progress']))
			.all();

		return {
			enabled: config.failover.enabled,
			policy: {
				graceSeconds: config.failover.graceSeconds,
				replicaGraceSeconds: config.replicas.failoverGraceSeconds,
				maxPerMinute: config.failover.maxPerMinute,
				perTargetPerMinute: FAILOVER_PER_TARGET_PER_MINUTE,
				queueExpirySeconds: FAILOVER_QUEUE_EXPIRY_MS / 1000,
				completionTimeoutSeconds: FAILOVER_COMPLETION_TIMEOUT_MS / 1000,
				flapWindowSeconds: FAILOVER_FLAP_WINDOW_MS / 1000,
				leaseTtlSeconds: config.controlPlane.leaseTtlSeconds,
				renewSeconds: config.controlPlane.renewSeconds,
				tickSeconds: this.intervalMs(config) / 1000,
				ingressHoldDownSeconds: this.#ingressHoldDownMs() / 1000,
				ingressReaddSeconds: policies.ingressReaddSeconds,
			},
			lease: this.#leaseView(now),
			lastTickAt: this.#lastTickAt === null ? null : new Date(this.#lastTickAt).toISOString(),
			nodes: [...facts.values()].map((fact) => ({
				id: fact.id,
				name: fact.name,
				zone: fact.zone,
				status: fact.status,
				roles: fact.roles,
				lastHeartbeatAt: fact.lastHeartbeatAt === null ? null : new Date(fact.lastHeartbeatAt).toISOString(),
				silentSeconds: fact.lastHeartbeatAt === null ? null : Math.round(fact.silentMs / 1000),
				lost: fact.lost,
				replicaFailoverAt:
					config.failover.enabled && fact.unreachable
						? new Date(now - fact.silentMs + config.replicas.failoverGraceSeconds * 1000).toISOString()
						: null,
				copies: copiesByNode.get(fact.id) ?? 0,
			})),
			ingress: {
				driver: policies.ingressDriver,
				steers: false,
				rotates,
				nodes: [...facts.values()]
					.filter((fact) => fact.roles.includes('ingress'))
					.map((fact) => {
						const pinnedUntil = (rotation.pinnedUntil[fact.id] ?? 0) > now ? rotation.pinnedUntil[fact.id]! : null;
						return {
							id: fact.id,
							name: fact.name,
							healthy: ingressHealthy(fact),
							inRotation: rotates && rotation.records !== null ? rotation.records.includes(fact.id) : ingressHealthy(fact),
							pinned: pinnedUntil !== null,
							pinnedUntil: pinnedUntil === null ? null : new Date(pinnedUntil).toISOString(),
						};
					}),
			},
			databases: databaseRows.map((database) => {
				const choice = this.#promotionChoice(byDatabase.get(database.id) ?? [], facts, config);
				const candidate = choice.replica;
				const primary = facts.get(database.nodeId);
				return {
					id: database.id,
					name: database.name,
					nodeId: database.nodeId,
					nodeName: primary?.name ?? null,
					primaryLost: !primary || primary.lost,
					replicas: byDatabase.get(database.id)?.length ?? 0,
					candidate: candidate
						? { id: candidate.id, nodeId: candidate.nodeId, nodeName: facts.get(candidate.nodeId)?.name ?? null }
						: null,
					refusals: choice.refusals.map((refusal) => `${facts.get(refusal.nodeId)?.name ?? refusal.nodeId}: ${refusal.reason}`),
					automatic: config.failover.enabled && handler,
				};
			}),
			databaseHandler: handler,
			counts: {
				lastMinute: recentApplied.length,
				inProgress: open.filter((row) => row.status === 'in-progress').length,
				queued: open.filter((row) => row.status !== 'in-progress').length,
			},
			recent: this.#history({ limit: HISTORY_LIMIT }),
		};
	}

	history(principal: Principal, options: { limit?: number; kind?: FailoverEventKind } = {}): FailoverEventView[] {
		requireViewer(principal);
		if (options.kind !== undefined && !(failoverEventKinds as readonly string[]).includes(options.kind))
			throw new CoreError('invalid_request', `Unknown failover event kind ${options.kind}.`, 400);
		return this.#history(options);
	}

	#history(options: { limit?: number; kind?: FailoverEventKind }): FailoverEventView[] {
		const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? HISTORY_LIMIT)));
		const rows = this.ctx.db
			.select()
			.from(failoverEvents)
			.where(options.kind ? eq(failoverEvents.kind, options.kind) : undefined)
			.orderBy(desc(failoverEvents.detectedAt), desc(failoverEvents.updatedAt))
			.limit(limit)
			.all();
		const names = new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((row) => [row.id, row.name]));
		const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			status: row.status,
			stage: row.stage,
			subjectId: row.subjectId,
			subjectName: row.subjectName,
			fromNodeId: row.fromNodeId,
			fromNodeName: row.fromNodeId ? (names.get(row.fromNodeId) ?? null) : null,
			toNodeId: row.toNodeId,
			toNodeName: row.toNodeId ? (names.get(row.toNodeId) ?? null) : null,
			reason: row.reason,
			epoch: row.epoch,
			generation: row.generation,
			detectedAt: new Date(row.detectedAt).toISOString(),
			appliedAt: iso(row.appliedAt),
			updatedAt: new Date(row.updatedAt).toISOString(),
			finishedAt: iso(row.finishedAt),
		}));
	}

	#leaseView(now: number): FailoverStatusView['lease'] {
		const current = this.#store.readSync();
		const record = current?.record ?? null;
		const live = record !== null && record.expiresAt > now;
		const self = live && record.holderNodeId === this.holderId;
		const state: FailoverLeaseState = self
			? 'holder'
			: this.#lastLease?.state === 'fenced'
				? 'fenced'
				: live
					? 'standby'
					: 'idle';
		return {
			state,
			epoch: record?.epoch ?? 0,
			holderId: live ? record.holderNodeId : null,
			self,
			expiresAt: record ? new Date(record.expiresAt).toISOString() : null,
		};
	}

	// ------------------------------------------------------------------ writes

	/** Run `write` in one transaction that first re-checks the lease (the fencing token). */
	#fenced(fence: FailoverFence, write: () => void): void {
		this.ctx.sqlite.transaction(() => {
			if (!fence.holds()) throw new FencedError();
			write();
		})();
	}

	#insertEvent(input: {
		kind: FailoverEventKind;
		status: FailoverEventStatus;
		stage: FailoverStage;
		subjectId: string;
		subjectName?: string | null;
		orgId?: string | null;
		fromNodeId?: string | null;
		toNodeId?: string | null;
		reason: string;
		epoch: number;
		generation?: number | null;
		detectedAt: number;
		appliedAt?: number | null;
		finishedAt?: number | null;
	}): EventRow {
		const row: EventRow = {
			id: newId('fov_'),
			kind: input.kind,
			status: input.status,
			stage: input.stage,
			subjectId: input.subjectId,
			subjectName: input.subjectName ?? null,
			orgId: input.orgId ?? null,
			fromNodeId: input.fromNodeId ?? null,
			toNodeId: input.toNodeId ?? null,
			reason: input.reason.slice(0, 1000),
			epoch: input.epoch,
			generation: input.generation ?? null,
			detectedAt: input.detectedAt,
			appliedAt: input.appliedAt ?? null,
			updatedAt: input.detectedAt,
			finishedAt: input.finishedAt ?? null,
		};
		this.ctx.db.insert(failoverEvents).values(row).run();
		return row;
	}

	/** Terminal status; `completed` walks the stage machine to `complete`. */
	#finish(fence: FailoverFence, event: EventRow, status: FailoverEventStatus, now: number, reason: string): void {
		this.#fenced(fence, () =>
			this.ctx.db
				.update(failoverEvents)
				.set({
					status,
					stage: status === 'completed' ? walkFailoverStages(event.stage, 'complete') : event.stage,
					reason: reason.slice(0, 1000),
					updatedAt: now,
					finishedAt: now,
				})
				.where(eq(failoverEvents.id, event.id))
				.run(),
		);
		event.status = status;
		event.finishedAt = now;
	}

	/** A non-terminal update; written only when something changed, so a waiting queue costs no writes. */
	#note(fence: FailoverFence, event: EventRow, status: FailoverEventStatus, now: number, reason: string): void {
		const trimmed = reason.slice(0, 1000);
		if (event.status === status && event.reason === trimmed) return;
		this.#fenced(fence, () =>
			this.ctx.db
				.update(failoverEvents)
				.set({ status, reason: trimmed, updatedAt: now })
				.where(eq(failoverEvents.id, event.id))
				.run(),
		);
		event.status = status;
		event.reason = trimmed;
	}

	/** Automatic actions applied since `since` (the fleet-wide and per-target rate limits). */
	#appliedSince(since: number): Array<{ toNodeId: string | null }> {
		return this.ctx.db
			.select({ toNodeId: failoverEvents.toNodeId })
			.from(failoverEvents)
			.where(and(inArray(failoverEvents.kind, ['replica', 'database']), gte(failoverEvents.appliedAt, since)))
			.all();
	}

	/** `<copy>:<from node>` for replica moves that expired inside the flap window. */
	#recentlyExpired(now: number): Set<string> {
		return new Set(
			this.ctx.db
				.select({ subjectId: failoverEvents.subjectId, fromNodeId: failoverEvents.fromNodeId })
				.from(failoverEvents)
				.where(
					and(
						eq(failoverEvents.kind, 'replica'),
						eq(failoverEvents.status, 'expired'),
						gte(failoverEvents.updatedAt, now - FAILOVER_FLAP_WINDOW_MS),
					),
				)
				.all()
				.map((row) => `${row.subjectId}:${row.fromNodeId}`),
		);
	}

	/** Nodes that were a failover source inside the flap window: never a move target. */
	#recentSources(now: number): Set<string> {
		return new Set(
			this.ctx.db
				.select({ nodeId: failoverEvents.fromNodeId })
				.from(failoverEvents)
				.where(
					and(
						inArray(failoverEvents.kind, ['replica', 'ingress', 'database']),
						gte(failoverEvents.detectedAt, now - FAILOVER_FLAP_WINDOW_MS),
					),
				)
				.all()
				.flatMap((row) => (row.nodeId ? [row.nodeId] : [])),
		);
	}

	#nodeName(facts: Map<string, NodeFact>, nodeId: string): string {
		return facts.get(nodeId)?.name ?? nodeId;
	}

	/** System alert with the maintenance sweep's cooldown (Alerts → System alerts → Failover). */
	async #notify(alert: Alert): Promise<void> {
		if (!this.ctx.alerts.systemRoute(alert.key)) return;
		const last = this.ctx.sqlite
			.query<{ last_fired_at: number | null; last_value: string | null }, [string]>(
				'SELECT last_fired_at, last_value FROM alert_state WHERE key = ?',
			)
			.get(alert.key);
		const cooldown = this.ctx.policies.get().systemAlertRepeatMinutes * 60_000;
		// The same message inside the cooldown is a repeat; a new outcome for the same subject is not.
		if (last?.last_fired_at && this.ctx.now() - last.last_fired_at < cooldown && last.last_value === alert.detail) return;
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[alert.key, this.ctx.now(), alert.detail],
		);
		await this.ctx.alerts.deliverSystem(alert);
	}
}

export interface FailoverLoopOptions {
	/** Defaults to `setTimeout` with `unref`, so the loop never keeps a process alive. */
	schedule?: (run: () => void, ms: number) => { cancel(): void };
	/** Called with each failed tick; the loop keeps going. */
	onError?: (error: unknown) => void;
}

/**
 * Run the controller: tick, then wait `intervalMs()` (re-read every time, so a Settings →
 * Clustering change applies on the next tick) and tick again. Ticks never overlap. Returns a stop
 * function that also releases the lease, so a clean shutdown hands over without waiting a TTL.
 */
export function startFailoverLoop(service: FailoverService, options: FailoverLoopOptions = {}): () => Promise<void> {
	const schedule =
		options.schedule ??
		((run: () => void, ms: number) => {
			const timer = setTimeout(run, ms);
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		});
	let stopped = false;
	let pending: { cancel(): void } | null = null;
	const loop = async () => {
		pending = null;
		if (stopped) return;
		try {
			await service.tick();
		} catch (error) {
			options.onError?.(error);
		}
		if (!stopped) pending = schedule(() => void loop(), service.intervalMs());
	};
	pending = schedule(() => void loop(), 0);
	return async () => {
		stopped = true;
		pending?.cancel();
		await service.release().catch(() => undefined);
	};
}

/** HTTP copies first, then workers (§8.3 step 3). */
function rank(copy: ReplicaCopy): number {
	return copy.ingress === 'http' ? 0 : 1;
}

/** An ingress node serves while it heartbeats and does not report its proxy down. */
function ingressHealthy(fact: NodeFact): boolean {
	return !fact.unreachable && fact.status !== 'offline';
}

/** Step through the stage machine one allowed transition at a time; never skips a stage. */
export function walkFailoverStages(from: FailoverStage, to: FailoverStage): FailoverStage {
	let stage = from;
	while (stage !== to) {
		const next = nextStage(stage);
		if (!next || !canAdvance(stage, next)) throw new Error(`Cannot advance a failover from ${stage} to ${to}.`);
		stage = next;
	}
	return stage;
}

function nextStage(stage: FailoverStage): Exclude<FailoverStage, 'detect'> | null {
	const order: FailoverStage[] = ['detect', 'decide', 'fence', 'promote', 'repoint', 'heal', 'complete'];
	const next = order[order.indexOf(stage) + 1];
	return next && next !== 'detect' && canAdvance(stage, next) ? next : null;
}

/** Why a node's work moves, in a sentence that stays the same from tick to tick. */
function sourceReason(fact: NodeFact | undefined, nodeId: string, why: 'drain' | 'failover'): string {
	if (!fact) return `node ${nodeId} no longer exists.`;
	if (why === 'drain') return `${fact.name} is draining.`;
	return fact.lastHeartbeatAt === null
		? `${fact.name} has never sent a heartbeat.`
		: `${fact.name} has not sent a heartbeat since ${new Date(fact.lastHeartbeatAt).toISOString()}.`;
}

function systemPrincipal(orgId: string): Principal {
	return buildPrincipal({ kind: 'system', userId: 'system:failover', orgId, role: 'owner' });
}

function requireViewer(principal: Principal): void {
	if (!canViewPlatform(principal)) throw new CoreError('forbidden', 'Only a platform admin can read the failover controller.', 403);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
