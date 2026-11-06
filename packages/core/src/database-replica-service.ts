import { and, eq } from 'drizzle-orm';
import { databaseReplicas, databases, nodes } from '@skiff/db';
import {
	databaseReplicaCreateSchema,
	databaseEngineRegistry,
	requirePermission,
	type DatabaseReplica,
	type DatabaseReplicaCreate,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';

export interface DatabaseReplicaRowView extends DatabaseReplica {
	nodeName: string | null;
	zone: string | null;
}

/**
 * Database replica registry (docs/CLUSTERING.md §9.2, C7).
 *
 * This records intent and admission. Actual `pg_basebackup`, slots and streaming are a later
 * helper/agent slice; the row is the source of truth the control plane will reconcile from.
 */
export class DatabaseReplicaService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal, databaseName: string): DatabaseReplicaRowView[] {
		requirePermission(principal, 'database:read');
		const database = this.requireDatabase(databaseName);
		return this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(eq(databaseReplicas.databaseId, database.id))
			.all()
			.map((row) => {
				const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, row.nodeId)).get();
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
				};
			});
	}

	add(principal: Principal, databaseName: string, raw: DatabaseReplicaCreate): DatabaseReplicaRowView {
		requirePermission(principal, 'database:update');
		const input = databaseReplicaCreateSchema.parse(raw);
		const database = this.requireDatabase(databaseName);
		if (database.nodeId === input.node)
			throw new ValidationError('A replica must run on a different node than the primary.');
		if (database.engine !== 'postgres')
			throw new ValidationError(
				`${databaseEngineRegistry[database.engine].label} replicas arrive in C10; only Postgres streaming is implemented.`,
			);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, input.node)).get();
		if (!node) throw new NotFoundError('Node');
		if (node.status !== 'online') throw new ConflictError(`"${node.name}" is ${node.status}.`);
		if (!node.privateAddress)
			throw new ValidationError(`"${node.name}" has no managed overlay address, so the replica cannot stream.`);
		const existing = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(eq(databaseReplicas.databaseId, database.id))
			.all();
		if (existing.some((row) => row.nodeId === input.node))
			throw new ConflictError(`"${database.name}" already has a replica on "${node.name}".`);
		const maxReplicas = this.ctx.cluster.get().database.maxReplicas;
		if (existing.length >= maxReplicas)
			throw new ValidationError(`This install allows at most ${maxReplicas} replica(s) per database.`);
		if (input.volume) {
			const volume = this.ctx.volumes.byId(input.volume);
			if (!volume || volume.nodeId !== node.id)
				throw new ValidationError('That volume is not registered on the replica node.');
		}
		const now = this.ctx.now();
		const row = {
			id: newId('dbr_'),
			databaseId: database.id,
			nodeId: node.id,
			status: 'pending' as const,
			replayLsn: null,
			lagBytes: null,
			lagSeconds: null,
			slot: `skiff_${database.id.slice(0, 12)}_${node.id.slice(0, 8)}`,
			primaryGeneration: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(databaseReplicas).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'database.replica.add',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, node: node.id, mode: input.mode, volume: input.volume ?? null },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return {
			...row,
			nodeName: node.name,
			zone: node.zone,
		};
	}

	remove(principal: Principal, databaseName: string, replicaId: string): { ok: true } {
		requirePermission(principal, 'database:update');
		const database = this.requireDatabase(databaseName);
		const row = this.ctx.db
			.select()
			.from(databaseReplicas)
			.where(and(eq(databaseReplicas.id, replicaId), eq(databaseReplicas.databaseId, database.id)))
			.get();
		if (!row) throw new NotFoundError('Database replica');
		this.ctx.db.delete(databaseReplicas).where(eq(databaseReplicas.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'database.replica.remove',
			resource: 'database',
			resourceId: database.id,
			args: { name: database.name, replicaId },
			result: 'ok',
		});
		this.ctx.projects.bump(database.orgId);
		return { ok: true };
	}

	private requireDatabase(name: string) {
		const row = this.ctx.db.select().from(databases).where(eq(databases.name, name)).get();
		if (!row) throw new NotFoundError('Database');
		return row;
	}
}
