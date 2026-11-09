import { and, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { appVolumeAttachments, appVolumeSnapshots, appVolumes, backupTargets, nodes } from '@skiff/db';
import {
	APP_VOLUME_SNAPSHOT_ID_PREFIX,
	appVolumeRestoreSchema,
	appVolumeSnapshotCreateSchema,
	type AppVolumeNodeRef,
	type AppVolumeRestore,
	type AppVolumeSnapshotCreate,
	type AppVolumeSnapshotMethod,
	type AppVolumeSnapshotView,
	type AppVolumeTask,
	type AppVolumeTaskResult,
	type AppVolumeUsageSample,
	type AppVolumeView,
	type Principal,
} from '@skiff/contracts';
import type { AppVolumeRow, AppVolumeService } from './app-volumes.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { newId, parseJson } from './util.ts';

/**
 * App-volume snapshots, restores, usage and the trash purge (docs/VOLUMES.md).
 *
 * A snapshot is a gzip tar of the volume directory that the volume's node streams to a plan-05
 * backup target through a presigned PUT. The row records the target it was written to (as
 * database backups do, 0053), so restore and delete always open that target, never the one that
 * applies now. A restore creates a **new** volume in the same project (quotas and disk admission
 * apply), and the node fills it from a presigned GET while it is not attachable.
 *
 * The node side is desired state: `appVolumes` (measure usage), `appVolumePurges` (delete the
 * directory of a trashed volume past its window) and `appVolumeTasks` (snapshots and restores),
 * answered in the heartbeat. Work no node finished within `TASK_TIMEOUT_MS` fails in `tick()`.
 */

export type AppVolumeSnapshotRow = typeof appVolumeSnapshots.$inferSelect;

/** The agent capability that measures, snapshots, restores and purges app volumes. */
export const APP_VOLUME_CAPABILITY = 'app-volumes';
/** Presigned URLs in a task live this long; a pending task gets a fresh URL on every pull. */
export const APP_VOLUME_TASK_URL_TTL_SECONDS = 3_600;
/** A snapshot or restore that no node finished within this window fails. */
export const APP_VOLUME_TASK_TIMEOUT_MS = 6 * 60 * 60_000;
/** The archive's content type; the presigned PUT is signed for it and the agent sends it. */
export const APP_VOLUME_ARCHIVE_CONTENT_TYPE = 'application/gzip';

const RESTORE_TASK_PREFIX = 'restore:';

/** Object key of a snapshot archive inside its target. */
export function appVolumeSnapshotObjectKey(orgId: string, volumeId: string, snapshotId: string): string {
	return `app-volumes/${orgId}/${volumeId}/${snapshotId}.tar.gz`;
}

export class AppVolumeLifecycle {
	constructor(
		private readonly ctx: CoreContext,
		private readonly volumes: AppVolumeService,
	) {}

	// ---------------------------------------------------------------- snapshots

	/** Snapshots of one volume, newest first. Trashed volumes keep theirs until the purge. */
	listSnapshots(principal: Principal, project: ProjectRow, name: string): AppVolumeSnapshotView[] {
		this.volumes.assertFeature();
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const row = this.volumes.requireRow(principal, project, name, { includeDeleted: true });
		return this.snapshotViews(row.id);
	}

	getSnapshot(principal: Principal, project: ProjectRow, name: string, snapshotId: string): AppVolumeSnapshotView {
		this.volumes.assertFeature();
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		const row = this.volumes.requireRow(principal, project, name, { includeDeleted: true });
		return this.requireSnapshotView(row.id, snapshotId);
	}

	/**
	 * Queue a snapshot. The node pauses the read-write writers (cgroup freeze) unless `quiesce` is
	 * false, copies, and streams the archive to the target. One snapshot runs per volume.
	 */
	createSnapshot(
		principal: Principal,
		project: ProjectRow,
		name: string,
		raw: AppVolumeSnapshotCreate = {},
	): AppVolumeSnapshotView {
		this.volumes.assertFeature();
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const input = appVolumeSnapshotCreateSchema.parse(raw);
		const row = this.volumes.requireRow(principal, project, name);
		if (row.restoreSnapshotId)
			throw new ConflictError(`Volume "${name}" is still being restored; snapshot it once it is ready.`);
		this.assertNodeCapable(row.nodeId, 'snapshot');
		const busy = this.ctx.db
			.select({ id: appVolumeSnapshots.id })
			.from(appVolumeSnapshots)
			.where(
				and(
					eq(appVolumeSnapshots.volumeId, row.id),
					inArray(appVolumeSnapshots.status, ['pending', 'running']),
				),
			)
			.get();
		if (busy) throw new ConflictError(`A snapshot of "${name}" is already running (${busy.id}).`);
		const targetId = input.target === undefined ? undefined : this.targetIdByName(principal.orgId, input.target);
		const placement = this.ctx.backupTargets.placementFor(principal.orgId, targetId);

		const now = this.ctx.now();
		const id = newId(APP_VOLUME_SNAPSHOT_ID_PREFIX);
		this.ctx.db
			.insert(appVolumeSnapshots)
			.values({
				id,
				orgId: row.orgId,
				volumeId: row.id,
				targetId: placement.targetId,
				targetName: placement.targetName,
				locationJson: placement.locationJson,
				objectKey: appVolumeSnapshotObjectKey(row.orgId, row.id, id),
				pinned: input.pinned,
				status: 'pending',
				label: input.label ?? null,
				quiesce: input.quiesce,
				createdBy: principal.userId,
				createdAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'appVolume.snapshot',
			resource: 'appVolume',
			resourceId: row.id,
			args: {
				project: project.slug,
				name,
				snapshotId: id,
				target: placement.targetName,
				quiesce: input.quiesce,
				...(input.label ? { label: input.label } : {}),
			},
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.requireSnapshotView(row.id, id);
	}

	/** Delete one snapshot: the archive first (from the target it was written to), then the row. */
	async deleteSnapshot(principal: Principal, project: ProjectRow, name: string, snapshotId: string): Promise<void> {
		this.volumes.assertFeature();
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.volumes.requireRow(principal, project, name, { includeDeleted: true });
		const snapshot = this.requireSnapshot(row.id, snapshotId);
		if (snapshot.status === 'pending' || snapshot.status === 'running')
			throw new ConflictError('Wait for the snapshot to finish before deleting it.');
		const restoring = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(eq(appVolumes.restoreSnapshotId, snapshot.id))
			.get();
		if (restoring)
			throw new ConflictError(`Volume "${restoring.name}" is being restored from this snapshot right now.`);
		const objectDeleted = await this.deleteObject(snapshot, true);
		this.ctx.db.delete(appVolumeSnapshots).where(eq(appVolumeSnapshots.id, snapshot.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'appVolume.snapshot-delete',
			resource: 'appVolume',
			resourceId: row.id,
			args: { project: project.slug, name, snapshotId, target: snapshot.targetName, objectDeleted },
			result: 'ok',
		});
	}

	/**
	 * Restore a completed snapshot into a new volume in the same project, on the source's backing.
	 * The new volume is created now (quotas and disk admission apply) and cannot be attached until
	 * its node reports the archive was extracted and its checksum matched.
	 */
	restore(
		principal: Principal,
		project: ProjectRow,
		name: string,
		snapshotId: string,
		raw: AppVolumeRestore,
	): AppVolumeView {
		this.volumes.assertFeature();
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const input = appVolumeRestoreSchema.parse(raw);
		const source = this.volumes.requireRow(principal, project, name, { includeDeleted: true });
		const snapshot = this.requireSnapshot(source.id, snapshotId);
		if (snapshot.status !== 'ok')
			throw new ConflictError(`Snapshot ${snapshotId} is ${snapshot.status}; only a completed snapshot can be restored.`);
		// Fail before creating anything when the recorded target is gone.
		this.ctx.backupTargets.requireRecorded(this.recorded(snapshot));
		const sizeMb = input.sizeMb ?? source.sizeMb;
		if (sizeMb < source.sizeMb)
			throw new ValidationError(
				`Volume "${name}" was ${source.sizeMb} MB; its restore needs at least that (asked for ${sizeMb} MB).`,
			);
		if (source.backing === 'node_volume' && !this.ctx.disks.byId(source.diskId))
			throw new ConflictError(`The disk that held "${name}" was removed, so its snapshot cannot be restored onto it.`);
		return this.volumes.create(
			principal,
			project,
			{
				name: input.name,
				sizeMb,
				singleWriter: source.singleWriter,
			},
			{ restoreFrom: { snapshotId: snapshot.id, sourceName: source.name, diskId: source.backing === 'node_volume' ? source.diskId : null } },
		);
	}

	/** Refuse work for a node whose agent cannot run it, instead of leaving it pending. */
	assertNodeCapable(nodeId: string, what: 'snapshot' | 'restore'): void {
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (!node) throw new NotFoundError('Node');
		if (parseJson<string[]>(node.capabilitiesJson, []).includes(APP_VOLUME_CAPABILITY)) return;
		throw new ConflictError(
			`Node "${node.name}" runs an agent that cannot ${what} app volumes yet. Update the node (Nodes → Update), then retry.`,
		);
	}

	snapshotViews(volumeId: string): AppVolumeSnapshotView[] {
		return this.ctx.db
			.select()
			.from(appVolumeSnapshots)
			.where(eq(appVolumeSnapshots.volumeId, volumeId))
			.all()
			.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
			.slice(0, 100)
			.map((row) => snapshotView(row));
	}

	// ---------------------------------------------------------------- node side

	/** Live volumes on a node, for usage sampling. */
	volumesForNode(nodeId: string): AppVolumeNodeRef[] {
		return this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(eq(appVolumes.nodeId, nodeId), isNull(appVolumes.deletedAt)))
			.all()
			.sort((a, b) => a.id.localeCompare(b.id))
			.slice(0, 1_000)
			.map(nodeRef);
	}

	/** Trashed volumes past their window whose directory this node must delete. */
	purgesForNode(nodeId: string): AppVolumeNodeRef[] {
		return this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(eq(appVolumes.nodeId, nodeId), isNotNull(appVolumes.purgeRequestedAt)))
			.all()
			.sort((a, b) => a.id.localeCompare(b.id))
			.map(nodeRef);
	}

	/**
	 * Snapshots and restores for one node, with fresh presigned URLs. Work whose recorded target
	 * was deleted can never run: it fails here instead of staying pending.
	 */
	async tasksForNode(nodeId: string): Promise<AppVolumeTask[]> {
		const tasks: AppVolumeTask[] = [];
		const unreachable: AppVolumeTaskResult[] = [];
		const snapshots = this.ctx.db
			.select({ snapshot: appVolumeSnapshots, volume: appVolumes })
			.from(appVolumeSnapshots)
			.innerJoin(appVolumes, eq(appVolumes.id, appVolumeSnapshots.volumeId))
			.where(
				and(
					eq(appVolumes.nodeId, nodeId),
					inArray(appVolumeSnapshots.status, ['pending', 'running']),
					isNull(appVolumes.purgeRequestedAt),
				),
			)
			.all()
			.sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt);
		for (const { snapshot, volume } of snapshots) {
			const recorded = this.ctx.backupTargets.openRecorded(this.recorded(snapshot));
			if (!recorded.available) {
				unreachable.push(failedResult('snapshot', snapshot.id, volume.id, recorded.reason));
				continue;
			}
			tasks.push({
				id: snapshot.id,
				action: 'snapshot',
				volume: nodeRef(volume),
				snapshotId: snapshot.id,
				url: await recorded.store.presignPut(
					snapshot.objectKey,
					APP_VOLUME_TASK_URL_TTL_SECONDS,
					APP_VOLUME_ARCHIVE_CONTENT_TYPE,
				),
				quiesce: snapshot.quiesce,
				checksum: null,
			});
		}
		const restoring = this.ctx.db
			.select()
			.from(appVolumes)
			.where(
				and(eq(appVolumes.nodeId, nodeId), isNotNull(appVolumes.restoreSnapshotId), isNull(appVolumes.deletedAt)),
			)
			.all()
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const volume of restoring) {
			const snapshot = this.ctx.db
				.select()
				.from(appVolumeSnapshots)
				.where(eq(appVolumeSnapshots.id, volume.restoreSnapshotId!))
				.get();
			if (!snapshot) {
				unreachable.push(
					failedResult('restore', volume.restoreSnapshotId!, volume.id, 'The snapshot was deleted before the restore ran.'),
				);
				continue;
			}
			const recorded = this.ctx.backupTargets.openRecorded(this.recorded(snapshot));
			if (!recorded.available) {
				unreachable.push(failedResult('restore', snapshot.id, volume.id, recorded.reason));
				continue;
			}
			tasks.push({
				id: `${RESTORE_TASK_PREFIX}${volume.id}`,
				action: 'restore',
				volume: nodeRef(volume),
				snapshotId: snapshot.id,
				url: await recorded.store.presignGet(snapshot.objectKey, APP_VOLUME_TASK_URL_TTL_SECONDS),
				quiesce: false,
				checksum: snapshot.checksum && /^[0-9a-f]{64}$/.test(snapshot.checksum) ? snapshot.checksum : null,
			});
		}
		if (unreachable.length > 0) this.applyTaskResults(nodeId, unreachable);
		return tasks;
	}

	/** Latest usage samples from a node's heartbeat; only volumes placed on that node are touched. */
	applyUsage(nodeId: string, samples: AppVolumeUsageSample[]): void {
		if (samples.length === 0) return;
		const owned = new Set(
			this.ctx.db
				.select({ id: appVolumes.id })
				.from(appVolumes)
				.where(and(eq(appVolumes.nodeId, nodeId), isNull(appVolumes.deletedAt)))
				.all()
				.map((row) => row.id),
		);
		const now = this.ctx.now();
		for (const sample of samples) {
			if (!owned.has(sample.id)) continue;
			this.ctx.db
				.update(appVolumes)
				.set({ usedBytes: sample.usedBytes, usedAt: now })
				.where(eq(appVolumes.id, sample.id))
				.run();
		}
	}

	/** Snapshot and restore outcomes from a node's heartbeat (or a task that could never run). */
	applyTaskResults(nodeId: string, results: AppVolumeTaskResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			if (result.action === 'snapshot') changed = this.settleSnapshot(nodeId, result, now) || changed;
			else changed = this.settleRestore(nodeId, result, now) || changed;
		}
		if (changed) this.ctx.nodes.bump();
	}

	/** The node deleted these directories: drop the rows. Their snapshots go in the next `tick()`. */
	applyPurged(nodeId: string, ids: string[]): void {
		if (ids.length === 0) return;
		const rows = this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(eq(appVolumes.nodeId, nodeId), inArray(appVolumes.id, ids), isNotNull(appVolumes.purgeRequestedAt)))
			.all();
		if (rows.length === 0) return;
		const purged = rows.map((row) => row.id);
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(appVolumeAttachments).where(inArray(appVolumeAttachments.volumeId, purged)).run();
			this.ctx.db.delete(appVolumes).where(inArray(appVolumes.id, purged)).run();
		});
		for (const row of rows)
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'appVolume.purged',
				resource: 'appVolume',
				resourceId: row.id,
				args: { name: row.name, projectId: row.projectId, nodeId },
				result: 'ok',
			});
		this.ctx.nodes.bump();
	}

	/**
	 * Prune support: delete one unpinned, finished snapshot older than `cutoff` and its archive.
	 * Returns the freed bytes; zero when it is gone, too new, pinned, still being restored or its
	 * backup target is unavailable.
	 */
	async pruneSnapshot(snapshotId: string, cutoff: number): Promise<{ removed: boolean; bytes: number }> {
		const snapshot = this.ctx.db
			.select()
			.from(appVolumeSnapshots)
			.where(
				and(
					eq(appVolumeSnapshots.id, snapshotId),
					eq(appVolumeSnapshots.pinned, false),
					inArray(appVolumeSnapshots.status, ['ok', 'failed']),
					lt(appVolumeSnapshots.createdAt, cutoff),
				),
			)
			.get();
		if (!snapshot) return { removed: false, bytes: 0 };
		const restoring = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(eq(appVolumes.restoreSnapshotId, snapshot.id))
			.get();
		if (restoring) return { removed: false, bytes: 0 };
		const objectDeleted = await this.deleteObject(snapshot, false);
		if (!objectDeleted) return { removed: false, bytes: 0 };
		this.ctx.db.delete(appVolumeSnapshots).where(eq(appVolumeSnapshots.id, snapshot.id)).run();
		return { removed: true, bytes: snapshot.sizeBytes ?? 0 };
	}

	// ---------------------------------------------------------------- maintenance

	/**
	 * The maintenance sweep: hand expired trash to its node, fail snapshots and restores no node
	 * finished in time, and delete the snapshots of purged volumes (archive, then row).
	 */
	async tick(): Promise<{ purgesRequested: number; timedOut: number; snapshotsRemoved: number }> {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select({ id: appVolumes.id })
			.from(appVolumes)
			.where(
				and(
					isNotNull(appVolumes.deletedAt),
					isNotNull(appVolumes.purgeAt),
					lte(appVolumes.purgeAt, now),
					isNull(appVolumes.purgeRequestedAt),
				),
			)
			.all();
		if (due.length > 0) {
			this.ctx.db
				.update(appVolumes)
				.set({ purgeRequestedAt: now, updatedAt: now })
				.where(inArray(appVolumes.id, due.map((row) => row.id)))
				.run();
			this.ctx.nodes.bump();
		}

		const cutoff = now - APP_VOLUME_TASK_TIMEOUT_MS;
		let timedOut = 0;
		const staleSnapshots = this.ctx.db
			.select({ snapshot: appVolumeSnapshots, nodeId: appVolumes.nodeId })
			.from(appVolumeSnapshots)
			.innerJoin(appVolumes, eq(appVolumes.id, appVolumeSnapshots.volumeId))
			.where(
				and(inArray(appVolumeSnapshots.status, ['pending', 'running']), lt(appVolumeSnapshots.createdAt, cutoff)),
			)
			.all();
		for (const { snapshot, nodeId } of staleSnapshots) {
			this.applyTaskResults(nodeId, [
				failedResult('snapshot', snapshot.id, snapshot.volumeId, timeoutMessage('snapshot')),
			]);
			timedOut += 1;
		}
		const staleRestores = this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(isNotNull(appVolumes.restoreSnapshotId), lt(appVolumes.createdAt, cutoff)))
			.all();
		for (const volume of staleRestores) {
			this.applyTaskResults(volume.nodeId, [
				failedResult('restore', volume.restoreSnapshotId!, volume.id, timeoutMessage('restore')),
			]);
			timedOut += 1;
		}

		// Snapshots whose volume row is gone (purged): their archives go too.
		const orphaned = this.ctx.db
			.select({ snapshot: appVolumeSnapshots })
			.from(appVolumeSnapshots)
			.leftJoin(appVolumes, eq(appVolumes.id, appVolumeSnapshots.volumeId))
			.where(isNull(appVolumes.id))
			.limit(100)
			.all();
		let snapshotsRemoved = 0;
		for (const { snapshot } of orphaned) {
			try {
				await this.deleteObject(snapshot, false);
			} catch (error) {
				console.error(`[app-volumes] could not delete snapshot ${snapshot.id}:`, error);
				continue;
			}
			this.ctx.db.delete(appVolumeSnapshots).where(eq(appVolumeSnapshots.id, snapshot.id)).run();
			snapshotsRemoved += 1;
		}
		return { purgesRequested: due.length, timedOut, snapshotsRemoved };
	}

	/** Live volumes at or above `ratio` of their quota, for the usage alert. */
	alertCandidates(ratio: number): Array<{ row: AppVolumeRow; ratio: number }> {
		return this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(isNull(appVolumes.deletedAt), isNotNull(appVolumes.usedBytes)))
			.all()
			.map((row) => ({ row, ratio: row.sizeMb > 0 ? (row.usedBytes ?? 0) / (row.sizeMb * 1024 * 1024) : 0 }))
			.filter((item) => item.ratio >= ratio);
	}

	// ---------------------------------------------------------------- internals

	private settleSnapshot(nodeId: string, result: AppVolumeTaskResult, now: number): boolean {
		const found = this.ctx.db
			.select({ snapshot: appVolumeSnapshots, volume: appVolumes })
			.from(appVolumeSnapshots)
			.innerJoin(appVolumes, eq(appVolumes.id, appVolumeSnapshots.volumeId))
			.where(eq(appVolumeSnapshots.id, result.snapshotId))
			.get();
		if (!found || found.volume.nodeId !== nodeId) return false;
		const { snapshot, volume } = found;
		if (snapshot.status === 'ok' || snapshot.status === 'failed') return false;
		const ok = result.status === 'ok';
		const error = ok ? null : (result.error ?? 'Snapshot failed on the node.');
		this.ctx.db
			.update(appVolumeSnapshots)
			.set({
				status: ok ? 'ok' : 'failed',
				sizeBytes: result.sizeBytes ?? snapshot.sizeBytes,
				checksum: result.sha256 ?? snapshot.checksum,
				method: (result.method as AppVolumeSnapshotMethod | undefined) ?? snapshot.method,
				error,
				finishedAt: now,
			})
			.where(eq(appVolumeSnapshots.id, snapshot.id))
			.run();
		this.ctx.audit.record({
			orgId: volume.orgId,
			action: ok ? 'appVolume.snapshot-ok' : 'appVolume.snapshot-failed',
			resource: 'appVolume',
			resourceId: volume.id,
			args: {
				name: volume.name,
				snapshotId: snapshot.id,
				sizeBytes: result.sizeBytes ?? null,
				method: result.method ?? null,
			},
			result: ok ? 'ok' : 'error',
			...(error ? { error } : {}),
		});
		return true;
	}

	private settleRestore(nodeId: string, result: AppVolumeTaskResult, now: number): boolean {
		const volume = this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(eq(appVolumes.id, result.volumeId), eq(appVolumes.nodeId, nodeId)))
			.get();
		if (!volume || volume.restoreSnapshotId !== result.snapshotId) return false;
		const ok = result.status === 'ok';
		const error = ok ? null : (result.error ?? 'Restore failed on the node.');
		this.ctx.db
			.update(appVolumes)
			.set({
				restoreSnapshotId: null,
				// A failed restore leaves the new volume empty; it stays unattachable until deleted.
				status: ok ? 'ready' : 'failed',
				message: ok
					? null
					: `Restore from ${result.snapshotId} failed: ${error}. Delete this volume and restore again.`.slice(0, 2_000),
				updatedAt: now,
			})
			.where(eq(appVolumes.id, volume.id))
			.run();
		if (ok)
			this.ctx.db
				.update(appVolumeSnapshots)
				.set({ restoreVerifiedAt: now })
				.where(eq(appVolumeSnapshots.id, result.snapshotId))
				.run();
		this.ctx.audit.record({
			orgId: volume.orgId,
			action: ok ? 'appVolume.restore-ok' : 'appVolume.restore-failed',
			resource: 'appVolume',
			resourceId: volume.id,
			args: { name: volume.name, snapshotId: result.snapshotId },
			result: ok ? 'ok' : 'error',
			...(error ? { error } : {}),
		});
		return true;
	}

	/**
	 * Delete the archive from the target it was written to. A target that was deleted leaves the
	 * object behind (Skiff has no credentials for it); that is reported, not an error.
	 */
	private async deleteObject(snapshot: AppVolumeSnapshotRow, strict: boolean): Promise<boolean> {
		const recorded = this.ctx.backupTargets.openRecorded(this.recorded(snapshot));
		if (!recorded.available) return false;
		if (recorded.target) {
			if (strict) this.ctx.backupTargets.assertDeleteAllowed(recorded.target);
			else if (recorded.writeOnly) return false;
		}
		await recorded.store.delete(snapshot.objectKey).catch(() => undefined);
		return true;
	}

	private recorded(snapshot: AppVolumeSnapshotRow) {
		return {
			orgId: snapshot.orgId,
			objectKey: snapshot.objectKey,
			targetId: snapshot.targetId,
			targetName: snapshot.targetName,
			locationJson: snapshot.locationJson,
		};
	}

	private requireSnapshot(volumeId: string, snapshotId: string): AppVolumeSnapshotRow {
		const row = this.ctx.db
			.select()
			.from(appVolumeSnapshots)
			.where(and(eq(appVolumeSnapshots.id, snapshotId), eq(appVolumeSnapshots.volumeId, volumeId)))
			.get();
		if (!row) throw new NotFoundError(`Snapshot ${snapshotId}`);
		return row;
	}

	private requireSnapshotView(volumeId: string, snapshotId: string): AppVolumeSnapshotView {
		return snapshotView(this.requireSnapshot(volumeId, snapshotId));
	}

	/** A target name the org can use: its own first, then a platform target of that name. */
	private targetIdByName(orgId: string, name: string): string {
		const rows = this.ctx.db
			.select({ id: backupTargets.id, orgId: backupTargets.orgId })
			.from(backupTargets)
			.where(and(eq(backupTargets.name, name), or(eq(backupTargets.orgId, orgId), isNull(backupTargets.orgId))))
			.all();
		const row = rows.find((item) => item.orgId === orgId) ?? rows[0];
		if (!row) throw new NotFoundError(`Backup target "${name}"`);
		return row.id;
	}
}

function nodeRef(row: AppVolumeRow): AppVolumeNodeRef {
	return {
		id: row.id,
		projectId: row.projectId,
		backing: row.backing,
		...(row.backing === 'node_volume' && row.diskId ? { nodeVolumeId: row.diskId } : {}),
	};
}

function snapshotView(row: AppVolumeSnapshotRow): AppVolumeSnapshotView {
	const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
	return {
		id: row.id,
		volumeId: row.volumeId,
		target: row.targetId ? { id: row.targetId, name: row.targetName ?? row.targetId } : null,
		objectKey: row.objectKey,
		sizeBytes: row.sizeBytes,
		checksum: row.checksum,
		pinned: row.pinned,
		status: row.status,
		error: row.error,
		label: row.label,
		method: (row.method as AppVolumeSnapshotMethod | null) ?? null,
		quiesce: row.quiesce,
		createdAt: new Date(row.createdAt).toISOString(),
		finishedAt: iso(row.finishedAt),
		expiresAt: iso(row.expiresAt),
		restoreVerifiedAt: iso(row.restoreVerifiedAt),
	};
}

function failedResult(
	action: 'snapshot' | 'restore',
	snapshotId: string,
	volumeId: string,
	error: string,
): AppVolumeTaskResult {
	return {
		taskId: action === 'restore' ? `${RESTORE_TASK_PREFIX}${volumeId}` : snapshotId,
		action,
		snapshotId,
		volumeId,
		status: 'failed',
		error: error.slice(0, 2_000),
	};
}

function timeoutMessage(what: 'snapshot' | 'restore'): string {
	return `No node finished this ${what} within 6 hours. Check that the volume's node is online and runs an agent with app-volume support, then retry.`;
}
