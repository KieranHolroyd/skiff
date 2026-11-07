import { and, eq, isNull, or } from 'drizzle-orm';
import { nodes, storageBuckets, storageInstances, storageReplication } from '@skiff/db';
import {
	requirePermission,
	storageGatewayHost,
	storageReplicationCreateSchema,
	storageReplicationReportSchema,
	type Principal,
	type StorageGrant,
	type StorageReplicationBucketReport,
	type StorageReplicationCreate,
	type StorageReplicationDesired,
	type StorageReplicationReport,
	type StorageReplicationStatus,
	type StorageReplicationView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { mintStorageKeyPair } from './storage-instances.ts';
import { newId, parseJson, sha256Hex } from './util.ts';

type ReplicationRow = typeof storageReplication.$inferSelect;
type InstanceRow = typeof storageInstances.$inferSelect;

/** A link's scoped key may be granted on at most this many buckets (`storageUserDesiredSchema`). */
export const REPLICATION_MAX_BUCKETS = 20;
/** A link that last finished a full pass longer ago than this many intervals is `lagging`. */
const LAGGING_INTERVALS = 2;

/**
 * Bucket replication (docs/OBJECT-STORAGE.md §12, CLUSTERING.md §10.2, C9).
 *
 * The control plane owns the rule; a node's agent copies the objects. RustFS's own bucket
 * replication is not used: its remote target must be dialled from inside the source container,
 * which cannot reach a private instance on another node (D56). Instead one agent runs the link:
 *
 * - the **runner** is the source's node, unless the target is on the edge, whose gateway only
 *   listens on loopback; then the edge pulls from the source's worker gateway;
 * - the runner reads or writes its local instance over loopback with that instance's root key, and
 *   reaches the peer through the peer node's internal gateway (D82) with a key scoped to the
 *   replicated buckets (read on a source peer, read-write on a target peer), never the peer's root;
 * - the target's buckets are created as ordinary rows here, so the target node converges them.
 *
 * Progress, lag and errors come back on the heartbeat (`storageReplication`).
 */
export class StorageReplicationService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- surfaces

	list(principal: Principal, storageName: string): StorageReplicationView[] {
		requirePermission(principal, 'storage:read');
		const instance = this.ctx.storage.requireRow(principal, storageName, { includeDeleted: true });
		return this.ctx.db
			.select()
			.from(storageReplication)
			.where(or(eq(storageReplication.sourceId, instance.id), eq(storageReplication.targetId, instance.id)))
			.all()
			.map((row) => this.view(row));
	}

	add(principal: Principal, storageName: string, raw: StorageReplicationCreate): StorageReplicationView {
		requirePermission(principal, 'storage:update');
		const input = storageReplicationCreateSchema.parse(raw);
		const source = this.ctx.storage.requireRow(principal, storageName);
		const target = this.ctx.storage.requireRow(principal, input.target);
		if (source.id === target.id) throw new ValidationError('Choose a different target instance.');
		if (source.nodeId === target.nodeId)
			throw new ValidationError('The target must be on another node (or zone) to protect against node loss.');
		if (target.public) throw new ValidationError('The passive target must be private.');
		if (this.isEdge(source.nodeId) && this.isEdge(target.nodeId))
			throw new ValidationError('Both instances are on edge nodes, which only expose storage on loopback. Put one of them on a worker.');
		const asTarget = this.ctx.db.select().from(storageReplication).where(eq(storageReplication.targetId, source.id)).get();
		if (asTarget) throw new ValidationError(`"${source.name}" is itself a replication target; chains are not supported.`);
		if (this.ctx.db.select().from(storageReplication).where(eq(storageReplication.sourceId, target.id)).get())
			throw new ValidationError(`"${target.name}" replicates to another instance, so it cannot be a target.`);
		if (this.ctx.db.select().from(storageReplication).where(eq(storageReplication.targetId, target.id)).get())
			throw new ConflictError(`"${target.name}" is already the target of another replication rule.`);
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
		const buckets = this.sourceBuckets(source.id);
		if (buckets.length > REPLICATION_MAX_BUCKETS)
			throw new ValidationError(
				`"${source.name}" has ${buckets.length} buckets; replication covers at most ${REPLICATION_MAX_BUCKETS}.`,
			);
		const now = this.ctx.now();
		const key = mintStorageKeyPair();
		const row: ReplicationRow = {
			id: newId('srp_'),
			sourceId: source.id,
			targetId: target.id,
			mode: 'bucket',
			status: 'pending',
			lastSyncAt: null,
			lagSeconds: null,
			accessKeyId: key.accessKeyId,
			secretSealed: this.ctx.secrets.seal(source.orgId, key.secret),
			lastError: null,
			lastAttemptAt: null,
			initialSyncAt: null,
			pendingObjects: null,
			objectsCopied: 0,
			bytesCopied: 0,
			bucketsJson: null,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.sqlite.transaction(() => {
			this.ctx.db.insert(storageReplication).values(row).run();
			this.ensureTargetBuckets(row);
		})();
		this.ctx.audit.record({
			principal,
			action: 'storage.replication.add',
			resource: 'storage',
			resourceId: source.id,
			args: { source: source.name, target: target.name, mode: row.mode, buckets },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.view(row);
	}

	remove(principal: Principal, storageName: string, replicationId: string): { ok: true } {
		requirePermission(principal, 'storage:update');
		const source = this.ctx.storage.requireRow(principal, storageName, { includeDeleted: true });
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
		this.ctx.projects.bump(principal.orgId);
		return { ok: true };
	}

	// ---------------------------------------------------------------- node protocol

	/**
	 * Links the instance's own node runs, as desired state. A link is only sent while both
	 * instances are live and on different nodes; the target's buckets must exist for its key's
	 * grants to cover them, so they are listed from the source.
	 */
	linksFor(instanceId: string): StorageReplicationDesired[] {
		const intervalSeconds = Math.max(60, this.ctx.cluster.get().storage.syncIntervalMinutes * 60);
		return this.activeLinks()
			.filter((link) => link.local.id === instanceId)
			.map((link) => ({
				id: link.row.id,
				direction: link.direction,
				peerId: link.peer.id,
				endpoint: `http://${this.publicAddress(link.peer.nodeId) ?? '127.0.0.1:1'}`,
				host: storageGatewayHost(link.peer.id),
				accessKeyId: link.row.accessKeyId!,
				buckets: this.sourceBuckets(link.source.id).slice(0, REPLICATION_MAX_BUCKETS),
				intervalSeconds,
				deletes: true,
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Scoped users the peer side of each link needs on this instance (`objectStorage.users`). */
	peerUsersFor(instanceId: string): Array<{ accessKeyId: string; grants: StorageGrant[] }> {
		return this.activeLinks()
			.filter((link) => link.peer.id === instanceId)
			.map((link) => ({
				accessKeyId: link.row.accessKeyId!,
				grants: this.sourceBuckets(link.source.id)
					.slice(0, REPLICATION_MAX_BUCKETS)
					.map((bucket) => ({ bucket, mode: link.direction === 'push' ? 'read-write' : 'read' }) as StorageGrant),
			}));
	}

	/** Secrets for `peerUsersFor`, by access key id. */
	peerSecretsFor(instanceId: string): Map<string, string> {
		const out = new Map<string, string>();
		for (const link of this.activeLinks())
			if (link.peer.id === instanceId)
				out.set(link.row.accessKeyId!, this.ctx.secrets.open(link.source.orgId, link.row.secretSealed!));
		return out;
	}

	/** Secrets for `linksFor`, by link id (`storageAdmin.replication`). */
	linkSecretsFor(instanceId: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const link of this.activeLinks())
			if (link.local.id === instanceId) out[link.row.id] = this.ctx.secrets.open(link.source.orgId, link.row.secretSealed!);
		return out;
	}

	/**
	 * Folded into the instance's `keysVersion`: adding or removing a link, or a bucket joining one,
	 * makes the agent re-fetch activation for the new secrets without restarting RustFS.
	 */
	keysFingerprint(instanceId: string): string {
		const items = this.activeLinks()
			.filter((link) => link.local.id === instanceId || link.peer.id === instanceId)
			.map((link) => ({
				id: link.row.id,
				key: link.row.accessKeyId,
				sealed: link.row.secretSealed,
				buckets: this.sourceBuckets(link.source.id).slice(0, REPLICATION_MAX_BUCKETS),
			}));
		return items.length === 0 ? '' : sha256Hex(JSON.stringify(items));
	}

	/**
	 * Progress from the node that runs each link. A report for a link this node does not run is
	 * dropped. New source buckets get their target rows here, so they join the link next round.
	 */
	applyReports(nodeId: string, reports: ReadonlyArray<StorageReplicationReport | Record<string, unknown>>): void {
		const links = new Map(this.activeLinks().map((link) => [link.row.id, link]));
		let bumped = false;
		for (const raw of reports) {
			// Malformed reports are dropped rather than failing the whole heartbeat.
			const parsed = storageReplicationReportSchema.safeParse(raw);
			if (!parsed.success) continue;
			const report = parsed.data;
			const link = links.get(report.id);
			if (!link || link.local.nodeId !== nodeId) continue;
			const now = this.ctx.now();
			// A report without a complete pass (an error, a pass in progress) keeps the last one known.
			const lastSync = parseTime(report.lastSyncAt) ?? link.row.lastSyncAt;
			const attempt = parseTime(report.attemptAt) ?? now;
			const intervalMs = this.ctx.cluster.get().storage.syncIntervalMinutes * 60_000;
			const status = replicationStatus(report, lastSync, now, intervalMs);
			this.ctx.db
				.update(storageReplication)
				.set({
					status,
					lastSyncAt: lastSync,
					lagSeconds: lastSync !== null ? Math.max(0, Math.round((now - lastSync) / 1000)) : null,
					initialSyncAt: link.row.initialSyncAt ?? (report.status === 'in-sync' ? (lastSync ?? now) : null),
					lastAttemptAt: attempt,
					lastError: report.error,
					pendingObjects: report.pending,
					objectsCopied: link.row.objectsCopied + report.copiedObjects,
					bytesCopied: link.row.bytesCopied + report.copiedBytes,
					bucketsJson: JSON.stringify(report.buckets),
					updatedAt: now,
				})
				.where(eq(storageReplication.id, link.row.id))
				.run();
			if (this.ensureTargetBuckets(link.row)) bumped = true;
		}
		if (bumped) this.ctx.projects.bump();
	}

	/**
	 * Maintenance: rows created before migration 0059 have no scoped key yet; mint one so the link
	 * can run. Returns how many were filled in.
	 */
	backfillKeys(): number {
		const rows = this.ctx.db.select().from(storageReplication).where(isNull(storageReplication.accessKeyId)).all();
		for (const row of rows) {
			const source = this.instance(row.sourceId);
			if (!source) continue;
			const key = mintStorageKeyPair();
			this.ctx.db
				.update(storageReplication)
				.set({
					accessKeyId: key.accessKeyId,
					secretSealed: this.ctx.secrets.seal(source.orgId, key.secret),
					updatedAt: this.ctx.now(),
				})
				.where(eq(storageReplication.id, row.id))
				.run();
		}
		if (rows.length > 0) this.ctx.projects.bump();
		return rows.length;
	}

	/** Rules touching a deleted or purged instance stop; called when an instance is purged. */
	removeForInstance(instanceId: string): void {
		this.ctx.db
			.delete(storageReplication)
			.where(or(eq(storageReplication.sourceId, instanceId), eq(storageReplication.targetId, instanceId)))
			.run();
	}

	// ---------------------------------------------------------------- internals

	/**
	 * Links that can run now: both ends live and on different nodes, with a key. The runner side
	 * (`local`) is the source unless the target sits on an edge node.
	 */
	private activeLinks(): Array<{
		row: ReplicationRow;
		source: InstanceRow;
		target: InstanceRow;
		local: InstanceRow;
		peer: InstanceRow;
		direction: 'push' | 'pull';
	}> {
		const out = [];
		for (const row of this.ctx.db.select().from(storageReplication).all()) {
			if (!row.accessKeyId || !row.secretSealed) continue;
			const source = this.instance(row.sourceId);
			const target = this.instance(row.targetId);
			if (!source || !target || source.deletedAt || target.deletedAt || source.nodeId === target.nodeId) continue;
			const pull = this.isEdge(target.nodeId) && !this.isEdge(source.nodeId);
			out.push({
				row,
				source,
				target,
				local: pull ? target : source,
				peer: pull ? source : target,
				direction: pull ? ('pull' as const) : ('push' as const),
			});
		}
		return out;
	}

	/** Live bucket names on the source, sorted. */
	private sourceBuckets(sourceId: string): string[] {
		return this.ctx.db
			.select({ name: storageBuckets.name })
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, sourceId), isNull(storageBuckets.deleteRequestedAt)))
			.all()
			.map((bucket) => bucket.name)
			.sort();
	}

	/**
	 * Create the target's copy of every replicated source bucket that has no row there yet. A bucket
	 * someone deleted on the target (a pending delete) is left alone. Returns whether rows were added.
	 */
	private ensureTargetBuckets(row: ReplicationRow): boolean {
		const target = this.instance(row.targetId);
		if (!target || target.deletedAt) return false;
		const existing = new Set(
			this.ctx.db
				.select({ name: storageBuckets.name })
				.from(storageBuckets)
				.where(eq(storageBuckets.storageId, target.id))
				.all()
				.map((bucket) => bucket.name),
		);
		const sourceRows = this.ctx.db
			.select()
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, row.sourceId), isNull(storageBuckets.deleteRequestedAt)))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, REPLICATION_MAX_BUCKETS);
		let added = false;
		for (const bucket of sourceRows) {
			if (existing.has(bucket.name)) continue;
			this.ctx.db
				.insert(storageBuckets)
				.values({
					id: newId('stb_'),
					orgId: target.orgId,
					storageId: target.id,
					name: bucket.name,
					access: 'private',
					// Versioning on the passive copy keeps replicated deletes and overwrites recoverable.
					versioning: bucket.versioning,
					lifecycleJson: '[]',
					corsJson: '[]',
					quotaBytes: null,
					objectLockJson: null,
					configVersion: 1,
					configStatus: 'pending',
					createdBy: 'system:replication',
					createdAt: this.ctx.now(),
				})
				.run();
			added = true;
		}
		return added;
	}

	private instance(id: string): InstanceRow | undefined {
		return this.ctx.db.select().from(storageInstances).where(eq(storageInstances.id, id)).get();
	}

	private isEdge(nodeId: string): boolean {
		if (this.ctx.workloads.edgeNode() === nodeId) return true;
		return this.ctx.db.select({ mode: nodes.mode }).from(nodes).where(eq(nodes.id, nodeId)).get()?.mode === 'edge';
	}

	private publicAddress(nodeId: string): string | null {
		return this.ctx.db.select({ address: nodes.publicAddress }).from(nodes).where(eq(nodes.id, nodeId)).get()?.address ?? null;
	}

	private view(row: ReplicationRow): StorageReplicationView {
		const source = this.instance(row.sourceId);
		const target = this.instance(row.targetId);
		const runner =
			source && target ? (this.isEdge(target.nodeId) && !this.isEdge(source.nodeId) ? target.nodeId : source.nodeId) : null;
		return {
			id: row.id,
			sourceId: row.sourceId,
			targetId: row.targetId,
			mode: 'bucket',
			status: row.status,
			lastSyncAt: iso(row.lastSyncAt),
			lagSeconds: row.lagSeconds,
			sourceName: source?.name ?? null,
			targetName: target?.name ?? null,
			runnerNodeId: runner,
			lastError: row.lastError,
			lastAttemptAt: iso(row.lastAttemptAt),
			initialSyncAt: iso(row.initialSyncAt),
			pendingObjects: row.pendingObjects,
			objectsCopied: row.objectsCopied,
			bytesCopied: row.bytesCopied,
			buckets: parseJson<StorageReplicationBucketReport[]>(row.bucketsJson, []),
		};
	}
}

/**
 * `syncing` until the first complete pass, then `protected` while the last complete pass is
 * recent, `lagging` once it is older than two intervals, and `failed` while the runner reports an
 * error with no complete pass inside that window.
 */
export function replicationStatus(
	report: Pick<StorageReplicationReport, 'status' | 'error'>,
	lastSyncAt: number | null,
	now: number,
	intervalMs: number,
): StorageReplicationStatus {
	const stale = lastSyncAt === null || now - lastSyncAt > LAGGING_INTERVALS * intervalMs;
	if (report.status === 'error') return stale ? 'failed' : 'lagging';
	if (lastSyncAt === null) return 'syncing';
	return stale ? 'lagging' : 'protected';
}

function parseTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: number | null): string | null {
	return value ? new Date(value).toISOString() : null;
}
