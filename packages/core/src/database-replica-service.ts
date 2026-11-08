import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
	databaseFailovers,
	databaseReplicas,
	databaseReplication,
	databases,
	nodeCertificates,
	nodes,
	serviceEndpoints,
} from '@skiff/db';
import {
	DATABASE_PROMOTION_MAX_LAG_BYTES,
	DATABASE_PROMOTION_MAX_LAG_SECONDS,
	DATABASE_REPLICA_LAG_WARN_BYTES,
	DATABASE_REPLICA_LAG_WARN_SECONDS,
	DATABASE_REPLICA_REPORT_STALE_SECONDS,
	DATABASE_REPLICAS_CAPABILITY,
	DATABASE_REPLICATION_MAX_SLOTS,
	databaseAlias,
	databaseCapabilities,
	databaseEngineRegistry,
	databaseIdentifier,
	databaseImage,
	databaseReplicaCreateSchema,
	databaseReplicaIdFromWorkload,
	databaseReplicaPromoteSchema,
	databaseReplicaReadable,
	databaseReplicaWorkloadId,
	isDatabaseReplicaWorkloadId,
	orgNetworkName,
	type DatabaseFailoverStage,
	type DatabaseFailoverView,
	type DatabaseReplicaCreate,
	type DatabaseReplicaLink,
	type DatabaseReplicaPromote,
	type DatabaseReplicaPromotionResult,
	type DatabaseReplicaPromotionTask,
	type DatabaseReplicaStatus,
	type DatabaseReplicaView,
	type DatabaseReplicationActivation,
	type DatabaseReplicationReport,
	type DatabaseReplicationSlotStatus,
	type DatabaseReplicationTask,
	type FailoverPlan,
	type Principal,
	type ServiceProvider,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadStatus,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import type { FailoverDatabaseHandler, FailoverFence, FailoverHandlerStage, FailoverStageOutcome } from './failover-service.ts';
import { resolvePlacement } from './placement.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

type ReplicaRow = typeof databaseReplicas.$inferSelect;
type FailoverRow = typeof databaseFailovers.$inferSelect;

/** Bump when the replica unit profile changes and existing replicas must be re-rendered. */
const REPLICA_PROFILE = 1;
/** A fence the old primary's node never confirms is abandoned (nothing irreversible happened yet). */
export const DATABASE_FENCE_TIMEOUT_MS = 10 * 60_000;
/** Failover rows whose work is still running (`pending` = fencing, `promoting` = promote + repoint). */
const ACTIVE_FAILOVER = ['pending', 'promoting'] as const;

/**
 * Postgres streaming read replicas (docs/CLUSTERING.md §9.2–9.3, C7).
 *
 * A replica is its own container workload, `db_dbr_<hex>`, on its node. On first start the helper's
 * standby unit runs `pg_basebackup` through a unix socket the agent serves (the "link"), which
 * reaches the primary's loopback port on the same node or the primary node's pinned-mTLS provider
 * listener over the overlay. The primary's node keeps the `skiff_repl` role, a `pg_hba` rule and
 * one physical slot per replica, and samples `pg_replication_slots` ⋈ `pg_stat_replication`;
 * those samples are the replica's status and lag.
 *
 * Promotion fences the old primary first (it leaves its node's desired state, and the node must
 * confirm it stopped unless the node is gone), then the replica's node runs `pg_ctl promote` and
 * renames the data directory to the database's id, and only then does the database row move.
 */
export class DatabaseReplicaService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- surfaces

	list(principal: Principal, databaseName: string): DatabaseReplicaView[] {
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		const nodesById = this.nodesById();
		return this.rowsFor(database.id).map((row) => this.view(row, database, nodesById));
	}

	add(principal: Principal, databaseName: string, raw: DatabaseReplicaCreate): DatabaseReplicaView {
		const input = databaseReplicaCreateSchema.parse(raw);
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		if (databaseCapabilities(database.engine).replication !== 'streaming' || database.engine !== 'postgres')
			throw new ValidationError(
				`${databaseEngineRegistry[database.engine].label} replicas are not available yet; only Postgres streaming replicas are.`,
			);
		if (input.mode === 'sync')
			throw new ValidationError(
				'Synchronous replicas are not available yet: Skiff has no automatic downgrade when the sync replica is lost, so a sync replica could block every write. Use mode "async".',
			);
		if (this.pitrEnabled(database.id))
			throw new ValidationError(
				`"${database.name}" has point-in-time recovery on; replicas of a PITR database are not supported yet.`,
			);
		this.ctx.moves.assertNotMoving(database);
		if (this.activeFailover(database.id))
			throw new ConflictError(`"${database.name}" is failing over; wait for the promotion to finish.`);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, input.node)).get()
			?? this.ctx.db.select().from(nodes).where(eq(nodes.name, input.node)).get();
		if (!node) throw new NotFoundError('Node');
		if (node.status !== 'online') throw new ConflictError(`"${node.name}" is ${node.status}.`);
		const sameNode = node.id === database.nodeId;
		const primaryNode = this.ctx.db.select().from(nodes).where(eq(nodes.id, database.nodeId)).get();
		if (!sameNode && !node.privateAddress)
			throw new ValidationError(`"${node.name}" has no managed overlay address, so the replica cannot stream from another node.`);
		if (!sameNode && !primaryNode?.privateAddress)
			throw new ValidationError(
				`The primary's node "${primaryNode?.name ?? database.nodeId}" has no managed overlay address, so a replica on another node cannot reach it.`,
			);
		for (const target of [node, ...(primaryNode && !sameNode ? [primaryNode] : [])]) {
			if (!parseJson<string[]>(target.capabilitiesJson, []).includes(DATABASE_REPLICAS_CAPABILITY))
				throw new ConflictError(
					`The agent on "${target.name}" is too old to run database replicas (it does not advertise "${DATABASE_REPLICAS_CAPABILITY}"). Update it first.`,
				);
		}
		const existing = this.rowsFor(database.id);
		const onNode = existing.find((row) => row.nodeId === node.id);
		if (onNode)
			throw new ConflictError(
				onNode.removingAt
					? `The previous replica on "${node.name}" is still being removed. Try again once it is gone.`
					: `"${database.name}" already has a replica on "${node.name}".`,
			);
		const maxReplicas = Math.min(this.ctx.cluster.get().database.maxReplicas, DATABASE_REPLICATION_MAX_SLOTS);
		const live = existing.filter((row) => !row.removingAt);
		if (live.length >= maxReplicas)
			throw new ValidationError(`This install allows at most ${maxReplicas} replica(s) per database.`);

		// The replica holds a full copy: same memory as the primary, and its disk must be on that node.
		const decision = resolvePlacement({
			runtime: 'container',
			requested: node.id,
			memoryMb: database.memoryMb,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(decision.message.replace('this app reserves', 'this replica reserves'), decision.freeByNode);
		// The requested storage, else the primary's tier (docs/STORAGE.md §2.2): a primary on a fast
		// disk gets its replica on a fast disk, one on the system disk on that node's system disk.
		const plan = this.ctx.disks.plan('databases', input.storage ?? this.ctx.disks.targetOf(database.diskId), node.id);
		const disk = this.ctx.disks.pick(plan, node.id, database.storageMb);
		this.ctx.quota.assertCanAdmitMemory(database.orgId, null, database.memoryMb);

		const view = this.insertReplica(database, node.id, disk?.id ?? null);
		this.ctx.audit.record({
			principal,
			action: 'database.replica.add',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, replicaId: view.id, node: node.id, mode: input.mode, disk: disk?.name ?? null, sameNode },
			result: 'ok',
		});
		this.ctx.endpoints.reconcileForDatabase(database.id);
		this.ctx.projects.bump(database.orgId);
		return view;
	}

	/**
	 * Start removing a replica: it leaves its node's desired state, its node deletes the data dir
	 * and the primary drops its slot; the row goes once both are confirmed. Removing the replica a
	 * promotion is waiting on cancels that promotion and puts the old primary back.
	 */
	remove(principal: Principal, databaseName: string, replicaId: string): DatabaseReplicaView {
		const database = this.ctx.databases.requireRow(principal, databaseName, { includeDeleted: true });
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		const row = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.id, replicaId), eq(databaseReplicas.databaseId, database.id)))
			.get();
		if (!row) throw new NotFoundError('Database replica');
		const failover = this.activeFailover(database.id);
		if (failover && failover.replicaId === row.id) {
			if (failover.promotedAt)
				throw new ConflictError('This replica is already the new primary; wait for the failover to finish.');
			this.failFailover(failover, 'Cancelled: the replica was removed.');
		}
		if (!row.removingAt) {
			this.markRemoving(row, database, { rebuild: false });
			this.ctx.audit.record({
				principal,
				action: 'database.replica.remove',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, replicaId, node: row.nodeId },
				result: 'ok',
			});
			this.ctx.endpoints.reconcileForDatabase(database.id);
			this.ctx.projects.bump(database.orgId);
		}
		const updated = this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, row.id)).get() ?? row;
		return this.view(updated, database, this.nodesById());
	}

	/**
	 * Promote a replica to primary (docs/CLUSTERING.md §9.3). `ifMatch` is the primary generation
	 * the caller saw. The replica must have streamed; it must be within the 64 MB / 60 s budget
	 * with a fresh report, and the old primary's node must be able to confirm the fence, or the
	 * caller must accept the data loss. A replica on the primary's own node is never promoted.
	 */
	promote(
		principal: Principal,
		databaseName: string,
		replicaId: string,
		raw: DatabaseReplicaPromote,
		options: { ifMatch?: number | null } = {},
	): DatabaseFailoverView {
		const input = databaseReplicaPromoteSchema.parse(raw);
		const database = this.ctx.databases.requireRow(principal, databaseName);
		this.ctx.iam.require(principal, 'database:update', { type: 'database', id: database.id });
		if (options.ifMatch !== undefined && options.ifMatch !== null && options.ifMatch !== database.primaryGeneration)
			throw new CoreError(
				'precondition_failed',
				`"${database.name}" is at primary generation ${database.primaryGeneration}, not ${options.ifMatch}. Re-read its replicas and try again.`,
				412,
			);
		const row = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.id, replicaId), eq(databaseReplicas.databaseId, database.id)))
			.get();
		if (!row || row.removingAt) throw new NotFoundError('Database replica');
		const risks = this.promotionRisks(database, row);
		if (risks.length > 0 && !input.acceptDataLoss)
			throw new ConflictError(
				`Promoting this replica may lose recent commits: ${risks.join('; ')}. Pass acceptDataLoss: true to promote anyway.`,
			);
		const failover = this.begin(database, row, {
			reason: `Manual promotion by ${principal.userId ?? principal.kind}${risks.length ? ` (accepted: ${risks.join('; ')})` : ''}.`,
			automatic: false,
		});
		this.ctx.audit.record({
			principal,
			action: 'database.failover.promote',
			resource: 'database',
			resourceId: database.id,
			args: {
				name: database.name,
				replicaId: row.id,
				from: database.nodeId,
				to: row.nodeId,
				generation: failover.generation,
				acceptDataLoss: input.acceptDataLoss,
				risks,
			},
			result: 'ok',
		});
		return this.failoverView(failover, this.nodesById());
	}

	/** Promotion history for one database, newest first. */
	failovers(principal: Principal, databaseName: string): DatabaseFailoverView[] {
		const database = this.ctx.databases.requireRow(principal, databaseName, { includeDeleted: true });
		this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
		const nodesById = this.nodesById();
		return this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(eq(databaseFailovers.databaseId, database.id))
			.orderBy(desc(databaseFailovers.startedAt))
			.limit(20)
			.all()
			.map((row) => this.failoverView(row, nodesById));
	}

	/**
	 * The automatic promotion path for the failover controller (docs/CLUSTERING.md §9.3, C8):
	 * `ctx.failover.registerDatabaseHandler(ctx.databaseReplicas.failoverHandler())`. Each stage is
	 * idempotent and reports `waiting` until the node protocol has moved it on.
	 */
	failoverHandler(): FailoverDatabaseHandler {
		return { run: (stage, plan, fence) => this.runFailoverStage(stage, plan, fence) };
	}

	runFailoverStage(stage: FailoverHandlerStage, plan: FailoverPlan, fence: FailoverFence): FailoverStageOutcome {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, plan.databaseId)).get();
		if (!database) return { status: 'failed', message: 'The database no longer exists.' };
		const latest = this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.databaseId, database.id), eq(databaseFailovers.toNodeId, plan.candidateNodeId)))
			.orderBy(desc(databaseFailovers.startedAt))
			.get();
		const mine = latest && latest.generation === plan.generation ? latest : undefined;
		if (stage === 'fence') {
			if (mine?.status === 'failed') return { status: 'failed', message: mine.message ?? 'The promotion failed.' };
			if (mine) return mine.status === 'pending' ? { status: 'waiting', message: 'Waiting for the old primary to stop.' } : { status: 'done' };
			if (database.primaryGeneration + 1 !== plan.generation)
				return { status: 'failed', message: `The database is at generation ${database.primaryGeneration}; this plan is for ${plan.generation}.` };
			const replica = this.rowsFor(database.id).find(
				(row) => row.nodeId === plan.candidateNodeId && !row.removingAt && row.primaryGeneration === database.primaryGeneration,
			);
			if (!replica) return { status: 'failed', message: 'No live replica on the candidate node.' };
			if (!fence.holds()) return { status: 'failed', message: 'The controller lost its lease before fencing.' };
			try {
				const started = this.begin(database, replica, { reason: plan.reason || 'Automatic failover.', automatic: true });
				return started.status === 'pending'
					? { status: 'waiting', message: 'Fence issued; waiting for the old primary to stop.' }
					: { status: 'done', message: 'The old primary is unreachable; its node will stop it when it returns.' };
			} catch (error) {
				return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
			}
		}
		if (!mine) return { status: 'failed', message: 'No promotion was started for this plan.' };
		if (mine.status === 'failed' || mine.status === 'rolled-back')
			return { status: 'failed', message: mine.message ?? 'The promotion failed.' };
		if (stage === 'promote')
			return mine.promotedAt
				? { status: 'done', message: 'The replica was promoted and handed over.' }
				: { status: 'waiting', message: mine.status === 'pending' ? 'Still fencing.' : 'Waiting for the replica node.' };
		if (stage === 'repoint')
			return mine.status === 'completed'
				? { status: 'done', message: 'The database runs on its new node.' }
				: { status: 'waiting', message: 'Waiting for the new primary to report running.' };
		return {
			status: 'done',
			message: 'The old primary is purged when its node returns; the other replicas re-bootstrap from the new primary.',
		};
	}

	// ---------------------------------------------------------------- hooks for other services

	/** Every replica row of a database, removing ones included, by node then id. */
	rowsFor(databaseId: string): ReplicaRow[] {
		return this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(eq(databaseReplicas.databaseId, databaseId))
			.all()
			.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.id.localeCompare(b.id));
	}

	/** True when a database has a replica that is not being removed (moves and upgrades refuse). */
	hasReplicas(databaseId: string): boolean {
		return this.rowsFor(databaseId).some((row) => !row.removingAt);
	}

	isReplicaWorkloadId(id: string): boolean {
		return isDatabaseReplicaWorkloadId(id);
	}

	/** Loopback ports replicas hold on a node, removing ones included until purged. */
	hostPortsOnNode(nodeId: string): number[] {
		return this.ctx.db
			.select({ port: databaseReplicas.hostPort })
			.from(databaseReplicas)
			.where(eq(databaseReplicas.nodeId, nodeId))
			.all()
			.flatMap((row) => (row.port === null ? [] : [row.port]));
	}

	/** Memory replicas reserve per node (D42 admission): a replica reserves its database's memory. */
	reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, []>(
				`SELECT r.node_id AS nodeId, SUM(d.memory_mb) AS total FROM database_replicas r
				 JOIN databases d ON d.id = r.database_id
				 WHERE r.removing_at IS NULL AND d.deleted_at IS NULL GROUP BY r.node_id`,
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
	}

	/** Databases whose primary must not run on its node right now: fenced for a promotion. */
	fencedDatabaseIds(): Set<string> {
		const rows = this.ctx.db
			.select({ databaseId: databaseFailovers.databaseId, fromNodeId: databaseFailovers.fromNodeId, promotedAt: databaseFailovers.promotedAt })
			.from(databaseFailovers)
			.where(inArray(databaseFailovers.status, [...ACTIVE_FAILOVER]))
			.all();
		return new Set(rows.filter((row) => row.promotedAt === null).map((row) => row.databaseId));
	}

	/**
	 * Read targets one consumer can reach, lowest node id first (§9.2): a replica on the consumer's
	 * node directly, one elsewhere through its service endpoint (process apps with C2 endpoints).
	 * Only replicas that are streaming or lagging serve reads.
	 */
	readTargets(database: DatabaseRow, consumerNodeId: string, runtime: WorkloadRuntime): Array<{ replicaId: string; host: string; port: number }> {
		if (database.engine !== 'postgres') return [];
		const container = runtime === 'container';
		const info = databaseEngineRegistry[database.engine];
		return this.rowsFor(database.id)
			.filter(
				(row) =>
					!row.removingAt &&
					row.hostPort !== null &&
					row.primaryGeneration === database.primaryGeneration &&
					databaseReplicaReadable(row.status),
			)
			.flatMap((row) => {
				if (row.nodeId === consumerNodeId)
					return [
						{
							replicaId: row.id,
							host: container ? databaseAlias(databaseReplicaWorkloadId(row.id)) : '127.0.0.1',
							port: container ? info.containerPort : row.hostPort!,
						},
					];
				if (container) return [];
				const endpoint = this.ctx.db
					.select({ localPort: serviceEndpoints.localPort })
					.from(serviceEndpoints)
					.where(
						and(
							eq(serviceEndpoints.consumerNodeId, consumerNodeId),
							eq(serviceEndpoints.serviceKind, 'database'),
							eq(serviceEndpoints.serviceId, row.id),
						),
					)
					.get();
				return endpoint ? [{ replicaId: row.id, host: '127.0.0.1', port: endpoint.localPort }] : [];
			});
	}

	/** Replica services a consumer endpoint may need (C2), for `ServiceEndpointService`. */
	endpointServicesFor(databaseId: string): Array<{ serviceId: string; nodeId: string; port: number }> {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.engine !== 'postgres') return [];
		return this.rowsFor(databaseId)
			.filter((row) => !row.removingAt && row.hostPort !== null && row.primaryGeneration === database.primaryGeneration)
			.map((row) => ({ serviceId: row.id, nodeId: row.nodeId, port: row.hostPort! }));
	}

	/** The loopback port a replica service id (`dbr_…`) is published on, for provider listeners. */
	servicePort(serviceId: string): number | null {
		return this.ctx.db.select({ port: databaseReplicas.hostPort }).from(databaseReplicas).where(eq(databaseReplicas.id, serviceId)).get()?.port ?? null;
	}

	// ---------------------------------------------------------------- node protocol

	/** Replica workloads placed on a node: the database's own profile plus the standby slot. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const rows = this.ctx.db
			.select({ replica: databaseReplicas, database: databases })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(eq(databaseReplicas.nodeId, nodeId), isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all();
		const tls = featureEnabled(this.ctx.config, 'DB_TLS');
		const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
		return rows.flatMap(({ replica, database }) => {
			if (!replica.slot || replica.hostPort === null || database.engine !== 'postgres') return [];
			// A replica of an older generation follows a primary that no longer exists.
			if (replica.primaryGeneration !== database.primaryGeneration) return [];
			const id = databaseReplicaWorkloadId(replica.id);
			const env = replicaContainerEnv(database);
			return [
				{
					id,
					projectId: database.id,
					projectSlug: database.name,
					deploymentId: replica.id,
					...(isolated ? { orgId: database.orgId, networkName: orgNetworkName(database.orgId) } : {}),
					runtime: 'container' as const,
					status: 'running' as const,
					release: null,
					image: databaseImage(database.engine, database.version, database.variant),
					upstream: `127.0.0.1:${replica.hostPort}`,
					memoryMb: database.memoryMb,
					cpus: database.cpus,
					port: replica.hostPort,
					healthPath: '/',
					socketActivation: false,
					activationVersion: this.replicaActivationVersion(database, replica, env, tls),
					env,
					secrets: [],
					dataSizeMb: null,
					...(replica.diskId ? { volumeId: replica.diskId } : {}),
					database: {
						engine: database.engine,
						version: database.version,
						...(database.variant !== 'standard' ? { variant: database.variant } : {}),
						...(tls ? { tls: true } : {}),
						replica: { slot: replica.slot },
					},
				},
			];
		});
	}

	/** Secrets for a replica workload: the owner password (for the image) and `PGPASSWORD` for streaming. */
	activation(nodeId: string, workloadId: string): WorkloadActivation {
		const replica = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(eq(databaseReplicas.id, databaseReplicaIdFromWorkload(workloadId)))
			.get();
		if (!replica || replica.removingAt) throw new NotFoundError('Database replica');
		if (replica.nodeId !== nodeId) throw new CoreError('forbidden', 'This replica is placed on another node.', 403);
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, replica.databaseId)).get();
		if (!database || database.deletedAt) throw new NotFoundError('Database');
		const secret = this.replicationRow(database.id);
		if (!secret) throw new ConflictError('The database has no replication role yet.');
		const env = replicaContainerEnv(database);
		const info = databaseEngineRegistry[database.engine];
		return {
			workloadId,
			activationVersion: this.replicaActivationVersion(database, replica, env, featureEnabled(this.ctx.config, 'DB_TLS')),
			env: {
				[info.containerEnv.password]: this.ctx.secrets.open(database.orgId, database.ownerSecret),
				// libpq reads it for both `pg_basebackup` and the walreceiver; never on argv.
				PGPASSWORD: this.ctx.secrets.open(database.orgId, secret.secretSealed),
			},
			files: {},
		};
	}

	/** Upstream sockets the agent serves for the replicas on a node. */
	linksForNode(nodeId: string): DatabaseReplicaLink[] {
		const rows = this.ctx.db
			.select({ replica: databaseReplicas, database: databases })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(eq(databaseReplicas.nodeId, nodeId), isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all();
		if (rows.length === 0) return [];
		const nodesById = this.nodesById();
		return rows
			.filter(({ replica, database }) => replica.primaryGeneration === database.primaryGeneration)
			.map(({ replica, database }) => {
				const workloadId = databaseReplicaWorkloadId(replica.id);
				if (database.nodeId === nodeId)
					return { workloadId, databaseId: database.id, upstream: { kind: 'local' as const, port: database.hostPort } };
				const primary = nodesById.get(database.nodeId);
				return {
					workloadId,
					databaseId: database.id,
					upstream: {
						kind: 'remote' as const,
						nodeId: database.nodeId,
						address: primary?.privateAddress ?? null,
						port: database.hostPort,
						tlsFingerprint: this.fingerprint(database.nodeId),
					},
				};
			})
			.sort((a, b) => a.workloadId.localeCompare(b.workloadId));
	}

	/**
	 * Overlay listeners a primary's node opens for replicas on other nodes: the database's own host
	 * port, pinned to the replica nodes' certificates. Merged with the C2 endpoint providers by port.
	 */
	providersForNode(nodeId: string, privateAddress: string): ServiceProvider[] {
		const rows = this.ctx.db
			.select({ replica: databaseReplicas, database: databases })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(and(eq(databases.nodeId, nodeId), isNull(databaseReplicas.removingAt), isNull(databases.deletedAt)))
			.all()
			.filter(({ replica, database }) => replica.nodeId !== nodeId && replica.primaryGeneration === database.primaryGeneration);
		const fenced = this.fencedDatabaseIds();
		const byPort = new Map<number, ServiceProvider>();
		for (const { replica, database } of rows) {
			if (fenced.has(database.id)) continue;
			const provider = byPort.get(database.hostPort) ?? {
				id: `svp_repl_${database.id}`,
				listenAddress: privateAddress,
				listenPort: database.hostPort,
				targetPort: database.hostPort,
				allowedClientFingerprints: [],
			};
			const fingerprint = this.fingerprint(replica.nodeId);
			if (fingerprint && !provider.allowedClientFingerprints.includes(fingerprint))
				provider.allowedClientFingerprints.push(fingerprint);
			byPort.set(database.hostPort, provider);
		}
		return [...byPort.values()];
	}

	/** What a primary's node must keep configured: role, `pg_hba` rule and slots. */
	replicationTasksForNode(nodeId: string): DatabaseReplicationTask[] {
		const fenced = this.fencedDatabaseIds();
		const rows = this.ctx.db
			.select({ replication: databaseReplication, database: databases })
			.from(databaseReplication)
			.innerJoin(databases, eq(databases.id, databaseReplication.databaseId))
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all();
		return rows
			.filter(({ database }) => !fenced.has(database.id))
			.map(({ replication, database }) => this.taskFor(database, replication))
			.sort((a, b) => a.databaseId.localeCompare(b.databaseId));
	}

	/** The `skiff_repl` password for one task; only the primary's own node may fetch it. */
	replicationActivation(nodeId: string, databaseId: string): DatabaseReplicationActivation {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!database || database.deletedAt) throw new NotFoundError('Database');
		if (database.nodeId !== nodeId) throw new CoreError('forbidden', 'This database is placed on another node.', 403);
		const replication = this.replicationRow(databaseId);
		if (!replication) throw new NotFoundError('Database replication');
		const task = this.taskFor(database, replication);
		return {
			databaseId,
			version: task.version,
			slots: task.slots,
			password: task.slots.length > 0 ? this.ctx.secrets.open(database.orgId, replication.secretSealed) : null,
		};
	}

	/** Replicas this node must promote, once their old primary is fenced. */
	promotionsForNode(nodeId: string): DatabaseReplicaPromotionTask[] {
		return this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.toNodeId, nodeId), eq(databaseFailovers.status, 'promoting'), isNull(databaseFailovers.promotedAt)))
			.all()
			.flatMap((row) =>
				row.replicaId
					? [{ failoverId: row.id, databaseId: row.databaseId, replicaWorkloadId: databaseReplicaWorkloadId(row.replicaId) }]
					: [],
			);
	}

	/**
	 * Data dirs this node must delete: removed replicas, the leftover of a promoted (or failed)
	 * replica, and the fenced old primary once its database lives on another node.
	 */
	purgesForNode(nodeId: string): string[] {
		const ids = new Set<string>();
		for (const row of this.ctx.db
			.select({ id: databaseReplicas.id })
			.from(databaseReplicas)
			.where(
				and(eq(databaseReplicas.nodeId, nodeId), isNotNull(databaseReplicas.removingAt), isNull(databaseReplicas.purgedAt)),
			)
			.all())
			ids.add(databaseReplicaWorkloadId(row.id));
		const failovers = this.ctx.db
			.select({ failover: databaseFailovers, database: databases })
			.from(databaseFailovers)
			.leftJoin(databases, eq(databases.id, databaseFailovers.databaseId))
			.where(inArray(databaseFailovers.status, ['completed', 'failed']))
			.all();
		for (const { failover, database } of failovers) {
			const currentNode = database?.nodeId ?? null;
			if (failover.toNodeId === nodeId && failover.replicaPurgedAt === null && failover.replicaId) {
				if (failover.status === 'completed') ids.add(databaseReplicaWorkloadId(failover.replicaId));
				// A failed promotion may have renamed the data dir already; never touch a live copy.
				else if (currentNode !== nodeId) ids.add(failover.databaseId);
			}
			if (
				failover.status === 'completed' &&
				failover.fromNodeId === nodeId &&
				failover.oldPurgedAt === null &&
				currentNode !== nodeId
			)
				ids.add(failover.databaseId);
		}
		return [...ids].sort();
	}

	/** Replica workload status from its own node: a restart loop marks the replica failed. */
	applyWorkloadReports(nodeId: string, reports: ReadonlyArray<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		const now = this.ctx.now();
		let changed = false;
		for (const report of reports) {
			if (!isDatabaseReplicaWorkloadId(report.id)) continue;
			const row = this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, databaseReplicaIdFromWorkload(report.id))).get();
			if (!row || row.nodeId !== nodeId || row.removingAt) continue;
			const failing = report.status === 'failed' || (report.status === 'running' && report.restarts >= 5);
			if (failing && row.status !== 'failed') {
				const wasReadable = databaseReplicaReadable(row.status);
				this.ctx.db
					.update(databaseReplicas)
					.set({
						status: 'failed',
						message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts) on its node.` : 'The replica failed to start on its node.',
						updatedAt: now,
					})
					.where(eq(databaseReplicas.id, row.id))
					.run();
				changed ||= wasReadable;
			}
		}
		// A promoted database reporting running on its new node completes the failover.
		for (const failover of this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.status, 'promoting'), eq(databaseFailovers.toNodeId, nodeId)))
			.all()) {
			if (!failover.promotedAt) continue;
			const report = reports.find((item) => item.id === failover.databaseId);
			if (report?.status !== 'running') continue;
			this.ctx.db
				.update(databaseFailovers)
				.set({ status: 'completed', finishedAt: now })
				.where(eq(databaseFailovers.id, failover.id))
				.run();
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
			this.ctx.audit.record({
				...(database ? { orgId: database.orgId } : {}),
				action: 'database.failover.complete',
				resource: 'database',
				resourceId: failover.databaseId,
				args: { name: database?.name ?? null, from: failover.fromNodeId, to: failover.toNodeId, generation: failover.generation, seconds: Math.round((now - failover.startedAt) / 1000) },
				result: 'ok',
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** A primary's configure outcome and slot sample: replica status, lag and slot-drop confirmation. */
	applyReplicationReports(nodeId: string, reports: readonly DatabaseReplicationReport[]): void {
		const now = this.ctx.now();
		let bump = false;
		for (const report of reports) {
			const database = this.ctx.db.select().from(databases).where(eq(databases.id, report.databaseId)).get();
			if (!database || database.nodeId !== nodeId) continue;
			const replication = this.replicationRow(database.id);
			if (!replication) continue;
			const task = this.taskFor(database, replication);
			const applied = report.appliedVersion === task.version;
			if (report.appliedVersion !== replication.appliedVersion || report.error !== replication.error)
				this.ctx.db
					.update(databaseReplication)
					.set({
						appliedVersion: report.appliedVersion,
						appliedAt: report.appliedVersion !== replication.appliedVersion ? now : replication.appliedAt,
						error: report.error,
						updatedAt: now,
					})
					.where(eq(databaseReplication.databaseId, database.id))
					.run();
			const rows = this.rowsFor(database.id);
			for (const row of rows) {
				const sample = report.slots?.find((slot) => slot.slot === row.slot) ?? null;
				if (row.removingAt) {
					// The slot is gone once the primary applied a version without it.
					if (row.slot && applied && report.slots && !sample) {
						this.ctx.db.update(databaseReplicas).set({ slot: null, updatedAt: now }).where(eq(databaseReplicas.id, row.id)).run();
						this.finalizeIfDone(row.id);
					}
					continue;
				}
				if (row.primaryGeneration !== database.primaryGeneration) continue;
				if (!report.slots) continue;
				const before = databaseReplicaReadable(row.status);
				const next = sample
					? replicaStatusFrom(sample, row)
					: { status: row.status, message: applied ? 'The primary has no slot for this replica.' : row.message };
				const patch = sample
					? {
							status: next.status,
							message: next.message,
							replayLsn: sample.replayLsn ?? row.replayLsn,
							sentLsn: sample.sentLsn ?? row.sentLsn,
							lagBytes: sample.lagBytes,
							lagSeconds: sample.lagSeconds,
							reportedAt: now,
							updatedAt: now,
						}
					: { message: next.message, updatedAt: now };
				this.ctx.db.update(databaseReplicas).set(patch).where(eq(databaseReplicas.id, row.id)).run();
				if (before !== databaseReplicaReadable(next.status)) bump = true;
			}
			// Teardown confirmed with nothing left to serve: forget the role's secret.
			if (applied && task.slots.length === 0 && this.rowsFor(database.id).length === 0)
				this.ctx.db.delete(databaseReplication).where(eq(databaseReplication.databaseId, database.id)).run();
		}
		if (bump) {
			for (const report of reports) this.ctx.endpoints.reconcileForDatabase(report.databaseId);
			this.ctx.projects.bump();
		}
	}

	/** Promotion outcomes from the replica's node: re-point the database, or put the old primary back. */
	applyPromotionResults(nodeId: string, results: readonly DatabaseReplicaPromotionResult[]): void {
		for (const result of results) {
			const failover = this.ctx.db.select().from(databaseFailovers).where(eq(databaseFailovers.id, result.failoverId)).get();
			if (!failover || failover.toNodeId !== nodeId || failover.status !== 'promoting' || failover.promotedAt) continue;
			if (result.status === 'failed') {
				const message = `Promotion failed on the replica's node: ${result.error ?? 'unknown error'}`;
				this.failFailover(failover, message);
				if (failover.replicaId)
					this.ctx.db
						.update(databaseReplicas)
						.set({ status: 'failed', message: `${message} Remove this replica and add a new one.`, updatedAt: this.ctx.now() })
						.where(eq(databaseReplicas.id, failover.replicaId))
						.run();
				continue;
			}
			this.repoint(failover, result.lsn ?? null);
		}
	}

	/** The old primary's node applied the fence: the primary is no longer among its workloads. */
	onHeartbeat(nodeId: string, actualStateVersion: number, reportedIds: readonly string[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const failover of this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.status, 'pending'), eq(databaseFailovers.fromNodeId, nodeId)))
			.all()) {
			if (failover.fenceVersion === null || actualStateVersion < failover.fenceVersion) continue;
			if (reportedIds.includes(failover.databaseId)) continue;
			this.ctx.db
				.update(databaseFailovers)
				.set({ status: 'promoting', fencedAt: now })
				.where(eq(databaseFailovers.id, failover.id))
				.run();
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** Purge confirmations for replica dirs, promotion leftovers and fenced old primaries. */
	applyPurged(nodeId: string, ids: readonly string[]): void {
		if (ids.length === 0) return;
		const now = this.ctx.now();
		const purged = new Set(ids);
		let changed = false;
		for (const id of ids) {
			if (!isDatabaseReplicaWorkloadId(id)) continue;
			const row = this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, databaseReplicaIdFromWorkload(id))).get();
			if (!row || row.nodeId !== nodeId || !row.removingAt || row.purgedAt) continue;
			this.ctx.db.update(databaseReplicas).set({ purgedAt: now, updatedAt: now }).where(eq(databaseReplicas.id, row.id)).run();
			this.finalizeIfDone(row.id);
			changed = true;
		}
		for (const failover of this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(inArray(databaseFailovers.status, ['completed', 'failed']))
			.all()) {
			const leftover =
				failover.status === 'completed' && failover.replicaId
					? databaseReplicaWorkloadId(failover.replicaId)
					: failover.databaseId;
			if (failover.toNodeId === nodeId && failover.replicaPurgedAt === null && purged.has(leftover)) {
				this.ctx.db.update(databaseFailovers).set({ replicaPurgedAt: now }).where(eq(databaseFailovers.id, failover.id)).run();
				changed = true;
			}
			if (failover.status === 'completed' && failover.fromNodeId === nodeId && failover.oldPurgedAt === null && purged.has(failover.databaseId)) {
				this.ctx.db.update(databaseFailovers).set({ oldPurgedAt: now }).where(eq(databaseFailovers.id, failover.id)).run();
				changed = true;
			}
		}
		if (changed) this.ctx.projects.bump();
	}

	/** The database itself was purged: its replicas go too (nothing left to drop slots on). */
	onDatabasePurged(databaseId: string): void {
		const now = this.ctx.now();
		for (const row of this.rowsFor(databaseId))
			this.ctx.db
				.update(databaseReplicas)
				.set({ removingAt: row.removingAt ?? now, slot: null, rebuildOnPurge: false, updatedAt: now })
				.where(eq(databaseReplicas.id, row.id))
				.run();
		this.ctx.db.delete(databaseReplication).where(eq(databaseReplication.databaseId, databaseId)).run();
		for (const row of this.rowsFor(databaseId)) this.finalizeIfDone(row.id);
	}

	/** Replicas on a node that are not being removed (node removal refuses while there are any). */
	liveCountOnNode(nodeId: string): number {
		return this.ctx.db
			.select({ id: databaseReplicas.id })
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.nodeId, nodeId), isNull(databaseReplicas.removingAt)))
			.all().length;
	}

	/**
	 * A removed node can never confirm a purge: its removing replicas count as purged, and the
	 * leftovers it would have deleted after a promotion are forgotten.
	 */
	forgetNode(nodeId: string): void {
		const now = this.ctx.now();
		for (const row of this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.nodeId, nodeId), isNotNull(databaseReplicas.removingAt)))
			.all()) {
			// Never rebuilt onto a node that is gone.
			this.ctx.db
				.update(databaseReplicas)
				.set({ purgedAt: row.purgedAt ?? now, rebuildOnPurge: false, updatedAt: now })
				.where(eq(databaseReplicas.id, row.id))
				.run();
			this.finalizeIfDone(row.id);
		}
		this.ctx.db
			.update(databaseFailovers)
			.set({ oldPurgedAt: now })
			.where(and(eq(databaseFailovers.fromNodeId, nodeId), isNull(databaseFailovers.oldPurgedAt)))
			.run();
		this.ctx.db
			.update(databaseFailovers)
			.set({ replicaPurgedAt: now })
			.where(and(eq(databaseFailovers.toNodeId, nodeId), isNull(databaseFailovers.replicaPurgedAt)))
			.run();
	}

	/** Maintenance: a fence the old node never confirms is abandoned; nothing irreversible ran. */
	tick(now = this.ctx.now()): number {
		let changed = 0;
		for (const failover of this.ctx.db.select().from(databaseFailovers).where(eq(databaseFailovers.status, 'pending')).all()) {
			if (now - failover.startedAt < DATABASE_FENCE_TIMEOUT_MS) continue;
			this.failFailover(
				failover,
				`The old primary's node did not stop it within ${DATABASE_FENCE_TIMEOUT_MS / 60_000} minutes; the promotion was abandoned and the old primary restarts.`,
			);
			changed += 1;
		}
		return changed;
	}

	// ---------------------------------------------------------------- internals

	private insertReplica(database: DatabaseRow, nodeId: string, diskId: string | null): DatabaseReplicaView {
		const now = this.ctx.now();
		const id = newId('dbr_');
		const hostPort = this.ctx.databases.allocatePort(nodeId);
		this.ctx.sqlite.transaction(() => {
			if (!this.replicationRow(database.id))
				this.ctx.db
					.insert(databaseReplication)
					.values({
						databaseId: database.id,
						secretSealed: this.ctx.secrets.seal(database.orgId, Buffer.from(randomBytes(24)).toString('base64url')),
						createdAt: now,
						updatedAt: now,
					})
					.run();
			this.ctx.db
				.insert(databaseReplicas)
				.values({
					id,
					databaseId: database.id,
					nodeId,
					status: 'pending',
					slot: slotName(id),
					primaryGeneration: database.primaryGeneration,
					hostPort,
					diskId,
					mode: 'async',
					createdAt: now,
					updatedAt: now,
				})
				.run();
		})();
		const row = this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, id)).get()!;
		return this.view(row, database, this.nodesById());
	}

	private markRemoving(row: ReplicaRow, database: DatabaseRow | undefined, options: { rebuild: boolean }): void {
		const now = this.ctx.now();
		// Without a live primary of the same generation there is no slot left to drop.
		const slotGone = !database || database.deletedAt !== null || row.primaryGeneration !== database.primaryGeneration;
		this.ctx.db
			.update(databaseReplicas)
			.set({
				removingAt: now,
				rebuildOnPurge: options.rebuild,
				...(slotGone ? { slot: null } : {}),
				updatedAt: now,
			})
			.where(eq(databaseReplicas.id, row.id))
			.run();
	}

	/** Delete a removed replica once its data dir and slot are both gone; re-add it if asked to. */
	private finalizeIfDone(id: string): void {
		const row = this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, id)).get();
		if (!row || !row.removingAt || !row.purgedAt || row.slot !== null) return;
		this.ctx.db.delete(databaseReplicas).where(eq(databaseReplicas.id, row.id)).run();
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, row.databaseId)).get();
		if (row.rebuildOnPurge && database && !database.deletedAt && database.nodeId !== row.nodeId) {
			const view = this.insertReplica(database, row.nodeId, row.diskId);
			this.ctx.audit.record({
				orgId: database.orgId,
				action: 'database.replica.rebuild',
				resource: 'database',
				resourceId: database.id,
				args: { name: database.name, replaced: row.id, replicaId: view.id, node: row.nodeId },
				result: 'ok',
			});
		}
		this.ctx.projects.bump();
	}

	/** Why promoting this replica could lose commits; refusals are thrown instead. */
	private promotionRisks(database: DatabaseRow, row: ReplicaRow): string[] {
		if (database.engine !== 'postgres') throw new ValidationError('Only Postgres replicas can be promoted.');
		if (row.nodeId === database.nodeId)
			throw new ValidationError(
				'This replica runs on the primary\'s own node: it is for read scaling and shares the primary\'s failure domain, so it cannot be promoted. Add a replica on another node.',
			);
		if (row.primaryGeneration !== database.primaryGeneration)
			throw new ConflictError('This replica follows an older primary; it is being rebuilt.');
		if (this.activeFailover(database.id)) throw new ConflictError(`"${database.name}" is already failing over.`);
		this.ctx.moves.assertNotMoving(database);
		if (row.status === 'pending' || !row.replayLsn)
			throw new ConflictError('This replica has not streamed yet, so it holds no data to promote.');
		if (row.status === 'failed' || row.status === 'lost')
			throw new ConflictError(`This replica is ${row.status}${row.message ? ` (${row.message})` : ''}; it cannot be promoted.`);
		const replicaNode = this.ctx.db.select().from(nodes).where(eq(nodes.id, row.nodeId)).get();
		if (!replicaNode || replicaNode.status !== 'online')
			throw new ConflictError(`The replica's node is ${replicaNode?.status ?? 'gone'}; it cannot run the promotion.`);
		if (!parseJson<string[]>(replicaNode.capabilitiesJson, []).includes(DATABASE_REPLICAS_CAPABILITY))
			throw new ConflictError(`The agent on "${replicaNode.name}" cannot promote replicas; update it first.`);
		const limits = this.ctx.cluster.get().database;
		const maxBytes = Math.min(limits.maxLagBytes, DATABASE_PROMOTION_MAX_LAG_BYTES);
		const maxSeconds = Math.min(limits.maxLagSeconds, DATABASE_PROMOTION_MAX_LAG_SECONDS);
		const risks: string[] = [];
		if (row.status !== 'streaming') risks.push(`it is ${row.status}`);
		if (row.lagBytes !== null && row.lagBytes > maxBytes) risks.push(`${row.lagBytes} bytes behind`);
		if (row.lagSeconds !== null && row.lagSeconds > maxSeconds) risks.push(`${Math.round(row.lagSeconds)} s behind`);
		const now = this.ctx.now();
		if (row.reportedAt === null || now - row.reportedAt > DATABASE_REPLICA_REPORT_STALE_SECONDS * 1000)
			risks.push('the primary has not reported its lag recently');
		const primaryNode = this.ctx.db.select().from(nodes).where(eq(nodes.id, database.nodeId)).get();
		if (!this.nodeReachable(primaryNode))
			risks.push(`the primary's node is ${primaryNode?.status ?? 'gone'}, so the fence cannot be confirmed`);
		return risks;
	}

	private nodeReachable(node: typeof nodes.$inferSelect | undefined): boolean {
		if (!node || node.status === 'offline') return false;
		const last = node.lastHeartbeatAt ?? 0;
		return this.ctx.now() - last < 2 * 60_000;
	}

	/** Record the failover and fence the old primary (it leaves its node's desired state). */
	private begin(database: DatabaseRow, replica: ReplicaRow, options: { reason: string; automatic: boolean }): FailoverRow {
		if (this.activeFailover(database.id)) throw new ConflictError(`"${database.name}" is already failing over.`);
		if (replica.nodeId === database.nodeId) throw new ValidationError('A same-node replica cannot be promoted.');
		const now = this.ctx.now();
		const id = newId('dfo_');
		const primaryNode = this.ctx.db.select().from(nodes).where(eq(nodes.id, database.nodeId)).get();
		const reachable = this.nodeReachable(primaryNode);
		this.ctx.db
			.insert(databaseFailovers)
			.values({
				id,
				databaseId: database.id,
				fromNodeId: database.nodeId,
				toNodeId: replica.nodeId,
				generation: database.primaryGeneration + 1,
				// An unreachable node cannot confirm; its next desired state no longer has the primary.
				status: reachable ? 'pending' : 'promoting',
				reason: options.reason.slice(0, 500),
				startedAt: now,
				replicaId: replica.id,
				...(reachable ? {} : { fencedAt: now }),
			})
			.run();
		this.ctx.projects.bump(database.orgId);
		// The first desired state without the primary carries this version (or a later one).
		this.ctx.db
			.update(databaseFailovers)
			.set({ fenceVersion: this.ctx.projects.stateVersion() })
			.where(eq(databaseFailovers.id, id))
			.run();
		this.ctx.audit.record({
			orgId: database.orgId,
			action: 'database.failover.fence',
			resource: 'database',
			resourceId: database.id,
			args: {
				name: database.name,
				replicaId: replica.id,
				from: database.nodeId,
				to: replica.nodeId,
				automatic: options.automatic,
				confirmed: reachable ? 'waiting for the node' : 'node unreachable',
			},
			result: 'ok',
		});
		return this.ctx.db.select().from(databaseFailovers).where(eq(databaseFailovers.id, id)).get()!;
	}

	/** The replica is the primary now: move the database row onto it and rebuild the others. */
	private repoint(failover: FailoverRow, lsn: string | null): void {
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		const replica = failover.replicaId
			? this.ctx.db.select().from(databaseReplicas).where(eq(databaseReplicas.id, failover.replicaId)).get()
			: undefined;
		if (!database || !replica || replica.hostPort === null) {
			this.failFailover(failover, 'The database or its replica disappeared before the re-point.');
			return;
		}
		const now = this.ctx.now();
		const poolerPort = database.poolerEnabled ? this.ctx.databases.allocatePoolerPort(replica.nodeId) : null;
		const others = this.rowsFor(database.id).filter((row) => row.id !== replica.id && !row.removingAt);
		this.ctx.sqlite.transaction(() => {
			this.ctx.db.delete(databaseReplicas).where(eq(databaseReplicas.id, replica.id)).run();
			this.ctx.db
				.update(databases)
				.set({
					nodeId: replica.nodeId,
					hostPort: replica.hostPort!,
					diskId: replica.diskId,
					poolerPort,
					primaryGeneration: failover.generation,
					status: 'pending',
					message: null,
					updatedAt: now,
				})
				.where(eq(databases.id, database.id))
				.run();
			// The new primary has no slots and the others streamed from the old timeline: rebuild them.
			for (const other of others)
				this.ctx.db
					.update(databaseReplicas)
					.set({ removingAt: now, slot: null, rebuildOnPurge: true, updatedAt: now })
					.where(eq(databaseReplicas.id, other.id))
					.run();
			this.ctx.db
				.update(databaseReplication)
				.set({ appliedVersion: null, appliedAt: null, error: null, updatedAt: now })
				.where(eq(databaseReplication.databaseId, database.id))
				.run();
			this.ctx.db
				.update(databaseFailovers)
				.set({ promotedAt: now, message: lsn ? `Promoted at ${lsn}.` : null })
				.where(eq(databaseFailovers.id, failover.id))
				.run();
		})();
		this.ctx.audit.record({
			orgId: database.orgId,
			action: 'database.failover.repoint',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, from: failover.fromNodeId, to: replica.nodeId, generation: failover.generation, lsn, rebuilt: others.map((row) => row.id) },
			result: 'ok',
		});
		this.ctx.endpoints.reconcileForDatabase(database.id);
		this.ctx.projects.bump(database.orgId);
	}

	private failFailover(failover: FailoverRow, message: string): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(databaseFailovers)
			.set({ status: 'failed', message: message.slice(0, 2_000), finishedAt: now })
			.where(eq(databaseFailovers.id, failover.id))
			.run();
		const database = this.ctx.db.select().from(databases).where(eq(databases.id, failover.databaseId)).get();
		this.ctx.audit.record({
			...(database ? { orgId: database.orgId } : {}),
			action: 'database.failover.fail',
			resource: 'database',
			resourceId: failover.databaseId,
			args: { name: database?.name ?? null, from: failover.fromNodeId, to: failover.toNodeId, message },
			result: 'error',
			error: message.slice(0, 500),
		});
		// Un-fenced: the old primary is back in its node's desired state.
		this.ctx.projects.bump();
	}

	private activeFailover(databaseId: string): FailoverRow | undefined {
		return this.ctx.db
			.select()
			.from(databaseFailovers)
			.where(and(eq(databaseFailovers.databaseId, databaseId), inArray(databaseFailovers.status, [...ACTIVE_FAILOVER])))
			.get();
	}

	private replicationRow(databaseId: string): typeof databaseReplication.$inferSelect | undefined {
		return this.ctx.db.select().from(databaseReplication).where(eq(databaseReplication.databaseId, databaseId)).get();
	}

	private taskFor(database: DatabaseRow, replication: typeof databaseReplication.$inferSelect): DatabaseReplicationTask {
		const slots = this.rowsFor(database.id)
			.filter((row) => !row.removingAt && row.slot && row.primaryGeneration === database.primaryGeneration)
			.map((row) => row.slot!)
			.sort();
		return {
			databaseId: database.id,
			version: sha256Hex(
				JSON.stringify({ v: 1, slots, secret: slots.length > 0 ? sha256Hex(replication.secretSealed) : null }),
			),
			slots,
		};
	}

	private replicaActivationVersion(database: DatabaseRow, replica: ReplicaRow, env: Record<string, string>, tls: boolean): string {
		const replication = this.replicationRow(database.id);
		return sha256Hex(
			JSON.stringify({
				id: replica.id,
				profile: REPLICA_PROFILE,
				engine: database.engine,
				version: database.version,
				...(database.variant !== 'standard' ? { variant: database.variant } : {}),
				port: replica.hostPort,
				slot: replica.slot,
				generation: replica.primaryGeneration,
				restartGeneration: database.restartGeneration,
				...(tls ? { tls: true } : {}),
				env,
				// A new replication secret must reach the walreceiver's env.
				secret: replication ? sha256Hex(replication.secretSealed) : null,
			}),
		);
	}

	private pitrEnabled(databaseId: string): boolean {
		const row = this.ctx.sqlite
			.query<{ enabled: number }, [string]>('SELECT enabled FROM database_pitr WHERE database_id = ?')
			.get(databaseId);
		return Boolean(row?.enabled);
	}

	private fingerprint(nodeId: string): string | null {
		return (
			this.ctx.db.select({ serial: nodeCertificates.serial }).from(nodeCertificates).where(eq(nodeCertificates.nodeId, nodeId)).get()
				?.serial ?? null
		);
	}

	private nodesById(): Map<string, typeof nodes.$inferSelect> {
		return new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
	}

	private view(row: ReplicaRow, database: DatabaseRow, nodesById: Map<string, typeof nodes.$inferSelect>): DatabaseReplicaView {
		const node = nodesById.get(row.nodeId);
		return {
			id: row.id,
			databaseId: row.databaseId,
			nodeId: row.nodeId,
			status: row.status,
			replayLsn: row.replayLsn,
			lagBytes: row.lagBytes,
			lagSeconds: row.lagSeconds,
			slot: row.slot,
			primaryGeneration: row.primaryGeneration,
			nodeName: node?.name ?? null,
			zone: node?.zone ?? null,
			workloadId: databaseReplicaWorkloadId(row.id),
			mode: row.mode,
			hostPort: row.hostPort,
			diskId: row.diskId,
			sameNode: row.nodeId === database.nodeId,
			message: row.message,
			removing: row.removingAt !== null,
			reportedAt: row.reportedAt ? new Date(row.reportedAt).toISOString() : null,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	private failoverView(row: FailoverRow, nodesById: Map<string, typeof nodes.$inferSelect>): DatabaseFailoverView {
		return {
			id: row.id,
			databaseId: row.databaseId,
			replicaId: row.replicaId,
			fromNodeId: row.fromNodeId,
			fromNodeName: row.fromNodeId ? (nodesById.get(row.fromNodeId)?.name ?? null) : null,
			toNodeId: row.toNodeId,
			toNodeName: nodesById.get(row.toNodeId)?.name ?? null,
			generation: row.generation,
			stage: failoverStage(row),
			reason: row.reason,
			message: row.message,
			startedAt: new Date(row.startedAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
		};
	}
}

/** `skiff_dbr_<hex>`: one physical slot per replica, inside the pattern the helper accepts. */
export function slotName(replicaId: string): string {
	return `skiff_${replicaId.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 56)}`;
}

/** The replica container gets the database's own env (owner, database name, PGDATA). */
function replicaContainerEnv(database: DatabaseRow): Record<string, string> {
	const user = databaseIdentifier(database.name);
	return { POSTGRES_USER: user, POSTGRES_DB: user, PGDATA: '/data/pgdata' };
}

/** Replica status from the primary's view of its slot (§9.2 thresholds). */
export function replicaStatusFrom(
	sample: DatabaseReplicationSlotStatus,
	previous: { status: DatabaseReplicaStatus; replayLsn: string | null },
): { status: DatabaseReplicaStatus; message: string | null } {
	if (sample.walStatus === 'lost' || previous.status === 'lost')
		return {
			status: 'lost',
			message: 'The primary removed WAL this replica still needed (max_slot_wal_keep_size). Remove it and add a new one.',
		};
	if (sample.state === 'streaming') {
		const lagging =
			(sample.lagSeconds !== null && sample.lagSeconds > DATABASE_REPLICA_LAG_WARN_SECONDS) ||
			(sample.lagBytes !== null && sample.lagBytes > DATABASE_REPLICA_LAG_WARN_BYTES);
		return lagging
			? { status: 'lagging', message: `Behind the primary by ${sample.lagBytes ?? '?'} bytes / ${sample.lagSeconds ?? '?'} s.` }
			: { status: 'streaming', message: null };
	}
	const streamed = previous.replayLsn !== null || sample.replayLsn !== null;
	if (sample.active) return { status: streamed ? 'lagging' : 'pending', message: sample.state ? `Walsender is ${sample.state}.` : null };
	if (!streamed) return { status: 'pending', message: 'Waiting for the base backup and first connection.' };
	return { status: 'stopped', message: 'The replica is not connected to the primary.' };
}

function failoverStage(row: FailoverRow): DatabaseFailoverStage {
	if (row.status === 'failed' || row.status === 'rolled-back') return 'failed';
	if (row.status === 'completed') return 'completed';
	if (row.status === 'pending') return 'fencing';
	return row.promotedAt ? 'repointing' : 'promoting';
}
