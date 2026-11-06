import { and, eq } from 'drizzle-orm';
import { storageInstances, storageReplication } from '@skiff/db';
import {
	requirePermission,
	storageReplicationCreateSchema,
	type Principal,
	type StorageReplicationCreate,
	type StorageReplicationView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

/**
 * Bucket replication registry (docs/CLUSTERING.md §10.2, C9).
 *
 * The control plane records source → passive target intent. RustFS applies the rule; this service
 * only admits and exposes it, so a failed S5 keeps every instance at `L1`.
 */
export class StorageReplicationService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal, storageName: string): StorageReplicationView[] {
		requirePermission(principal, 'storage:read');
		const source = this.requireStorage(storageName);
		return this.ctx.db
			.select()
			.from(storageReplication)
			.where(eq(storageReplication.sourceId, source.id))
			.all()
			.map((row) => this.view(row));
	}

	add(principal: Principal, storageName: string, raw: StorageReplicationCreate): StorageReplicationView {
		requirePermission(principal, 'storage:update');
		const input = storageReplicationCreateSchema.parse(raw);
		const source = this.requireStorage(storageName);
		const target = this.requireStorage(input.target);
		if (source.id === target.id) throw new ValidationError('Choose a different target instance.');
		if (source.nodeId === target.nodeId)
			throw new ValidationError('The target must be on another node (or zone) to protect against node loss.');
		if (target.public) throw new ValidationError('The passive target must be private.');
		const existing = this.ctx.db
			.select()
			.from(storageReplication)
			.where(eq(storageReplication.sourceId, source.id))
			.all();
		if (existing.some((row) => row.targetId === target.id))
			throw new ConflictError(`"${source.name}" already replicates to "${target.name}".`);
		const maxTargets = this.ctx.cluster.get().storage.maxTargets;
		if (existing.length >= maxTargets)
			throw new ValidationError(`This install allows at most ${maxTargets} replication target(s).`);
		const now = this.ctx.now();
		const row = {
			id: newId('srp_'),
			sourceId: source.id,
			targetId: target.id,
			mode: 'bucket' as const,
			status: 'pending' as const,
			lastSyncAt: null,
			lagSeconds: null,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(storageReplication).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'storage.replication.add',
			resource: 'storage',
			resourceId: source.id,
			args: { source: source.name, target: target.name, mode: row.mode },
			result: 'ok',
		});
		return this.view(row);
	}

	remove(principal: Principal, storageName: string, replicationId: string): { ok: true } {
		requirePermission(principal, 'storage:update');
		const source = this.requireStorage(storageName);
		const row = this.ctx.db
			.select()
			.from(storageReplication)
			.where(and(eq(storageReplication.id, replicationId), eq(storageReplication.sourceId, source.id)))
			.get();
		if (!row) throw new NotFoundError('Storage replication');
		this.ctx.db.delete(storageReplication).where(eq(storageReplication.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'storage.replication.remove',
			resource: 'storage',
			resourceId: source.id,
			args: { source: source.name, replicationId },
			result: 'ok',
		});
		return { ok: true };
	}

	private view(row: typeof storageReplication.$inferSelect): StorageReplicationView {
		const source = this.ctx.db.select().from(storageInstances).where(eq(storageInstances.id, row.sourceId)).get();
		const target = this.ctx.db.select().from(storageInstances).where(eq(storageInstances.id, row.targetId)).get();
		return {
			id: row.id,
			sourceId: row.sourceId,
			targetId: row.targetId,
			mode: 'bucket',
			status: row.status,
			lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
			lagSeconds: row.lagSeconds,
			sourceName: source?.name ?? null,
			targetName: target?.name ?? null,
		};
	}

	private requireStorage(name: string) {
		const row = this.ctx.db.select().from(storageInstances).where(eq(storageInstances.name, name)).get();
		if (!row) throw new NotFoundError('Storage');
		return row;
	}
}
