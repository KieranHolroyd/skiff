import { and, eq, isNull } from 'drizzle-orm';
import {
	appVolumeAttachments,
	appVolumes,
	disks,
	nodes,
	projects,
	workloads,
} from '@skiff/db';
import {
	APP_VOLUME_ID_PREFIX,
	APP_VOLUME_USAGE_WARN_PERCENT,
	appVolumeUsagePercent,
	appVolumeAttachSchema,
	appVolumeCreateSchema,
	appVolumeDetachSchema,
	appVolumeUpdateSchema,
	requirePermission,
	type AppVolumeAttachmentView,
	type AppVolumeAttach,
	type AppVolumeCreate,
	type AppVolumeDetach,
	type AppVolumeSnapshotView,
	type AppVolumeStatus,
	type AppVolumeUpdate,
	type AppVolumeView,
	type Principal,
	type WorkloadVolumeMount,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { AppVolumeLifecycle } from './app-volume-lifecycle.ts';
import { featureEnabled } from './config.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';
import type { ProjectRow } from './projects.ts';
import type { DiskRow } from './disks.ts';

export type AppVolumeRow = typeof appVolumes.$inferSelect;
export type AppVolumeAttachmentRow = typeof appVolumeAttachments.$inferSelect;

const MB = 1024 * 1024;
/** Disk admission reserves at most this share of the free space. */
export const DISK_ADMISSION_NUMERATOR = 9;
export const DISK_ADMISSION_DENOMINATOR = 10;
export interface DiskAdmissionInput {
	/** The new volume's quota, in megabytes. */
	requestMb: number;
	/** Free bytes on the backing filesystem, or null before the node reports. */
	freeBytes: number | null;
	/** Bytes already reserved by other app volumes on the same backing. */
	reservedBytes: number;
}

/**
 * Pure disk admission rule for app volumes (plan 07): `reserved + requested ≤ 90% of free`.
 * Returns a human-readable problem naming the numbers, or null when there is room. A node that
 * has not reported free disk yet is refused rather than guessed at (fail closed).
 */
export function diskAdmissionProblem(input: DiskAdmissionInput): string | null {
	if (!Number.isFinite(input.requestMb) || input.requestMb <= 0)
		return 'The volume size must be a positive number of megabytes.';
	if (input.freeBytes === null)
		return 'The node has not reported its free disk yet. Retry after the next heartbeat (about 10 s).';
	const requestBytes = input.requestMb * MB;
	const limit = Math.floor((input.freeBytes * DISK_ADMISSION_NUMERATOR) / DISK_ADMISSION_DENOMINATOR);
	const needed = input.reservedBytes + requestBytes;
	if (needed <= limit) return null;
	const freeMb = Math.floor(input.freeBytes / MB);
	const reservedMb = Math.floor(input.reservedBytes / MB);
	const limitMb = Math.floor(limit / MB);
	return `The node has ${freeMb} MB free; ${reservedMb} MB is already reserved by app volumes and this ${input.requestMb} MB volume would exceed the 90% admission limit (${limitMb} MB). Lower the size or add a disk.`;
}

/** Snapshot a node's latest free-disk report, deriving it from used/total for older agents. */
export function nodeDiskFreeBytes(stats: unknown): number | null {
	if (!stats || typeof stats !== 'object') return null;
	const record = stats as Record<string, unknown>;
	const free = record.diskFreeBytes;
	if (typeof free === 'number' && Number.isFinite(free) && free >= 0) return Math.floor(free);
	const total = record.diskTotalBytes;
	const used = record.diskUsedBytes;
	if (typeof total === 'number' && typeof used === 'number' && Number.isFinite(total) && Number.isFinite(used))
		return Math.max(0, Math.floor(total - used));
	return null;
}

/**
 * Project-owned app volumes (plan 07). A volume is not a node volume: it is a directory with a
 * quota, backed by a node volume or the helper state directory, attached to one workload. The
 * control plane stores ids, sizes and mount points — the node derives the host path and fails
 * closed if the backing mount is missing. Single-writer is enforced here; read-only attachments
 * are unlimited.
 */
export class AppVolumeService {
	/** Snapshots, restores, usage and the trash purge (app-volume-lifecycle.ts). */
	readonly lifecycle: AppVolumeLifecycle;

	constructor(private readonly ctx: CoreContext) {
		this.lifecycle = new AppVolumeLifecycle(ctx, this);
	}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'APP_VOLUMES');
	}

	/** Throws `feature_disabled` (404) while SKIFF_FEATURE_APP_VOLUMES is off. */
	assertFeature(): void {
		this.assertEnabled();
	}

	private assertEnabled(): void {
		if (!this.enabled())
			throw new CoreError(
				'feature_disabled',
				'App volumes are not enabled on this platform (SKIFF_FEATURE_APP_VOLUMES).',
				404,
			);
	}

	// ---------------------------------------------------------------- reads

	list(
		principal: Principal,
		project: ProjectRow,
		options: { includeDeleted?: boolean } = {},
	): AppVolumeView[] {
		this.assertEnabled();
		requirePermission(principal, 'project:read');
		const filters = [eq(appVolumes.orgId, principal.orgId), eq(appVolumes.projectId, project.id)];
		if (!options.includeDeleted) filters.push(isNull(appVolumes.deletedAt));
		return this.ctx.db
			.select()
			.from(appVolumes)
			.where(and(...filters))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toView(row, project));
	}

	get(
		principal: Principal,
		project: ProjectRow,
		name: string,
		options: { includeDeleted?: boolean } = {},
	): AppVolumeView {
		this.assertEnabled();
		requirePermission(principal, 'project:read');
		return this.toView(this.requireRow(principal, project, name, options), project);
	}

	requireRow(
		principal: Principal,
		project: ProjectRow,
		name: string,
		options: { includeDeleted?: boolean } = {},
	): AppVolumeRow {
		const row = this.ctx.db
			.select()
			.from(appVolumes)
			.where(
				and(
					eq(appVolumes.orgId, principal.orgId),
					eq(appVolumes.projectId, project.id),
					eq(appVolumes.name, name),
				),
			)
			.get();
		if (!row || (row.deletedAt && !options.includeDeleted)) throw new NotFoundError(`Volume "${name}"`);
		return row;
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Create a volume. `restoreFrom` (used by `lifecycle.restore`) marks it as being filled from a
	 * snapshot: it stays `pending` and unattachable until its node reports the restore.
	 */
	create(
		principal: Principal,
		project: ProjectRow,
		raw: AppVolumeCreate,
		options: { restoreFrom?: { snapshotId: string; sourceName: string; diskId: string | null } } = {},
	): AppVolumeView {
		this.assertEnabled();
		requirePermission(principal, 'project:update');
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process" or "container" to use a volume.`,
			);
		const input = appVolumeCreateSchema.parse(raw);
		const existing = this.ctx.db
			.select({ id: appVolumes.id, deletedAt: appVolumes.deletedAt })
			.from(appVolumes)
			.where(and(eq(appVolumes.projectId, project.id), eq(appVolumes.name, input.name)))
			.get();
		if (existing)
			throw new ConflictError(
				existing.deletedAt
					? `Volume "${input.name}" is in the trash. Wait for it to purge or pick another name.`
					: `Volume "${input.name}" already exists in this project.`,
			);
		// Org quotas (docs/QUOTAS.md) before disk admission: the quota is policy, the disk is physics.
		this.ctx.quota.assertCanCreateVolume(principal.orgId, project.id, input.sizeMb);

		// The storage target (chosen at creation, else the app-volumes default) picks a disk on the
		// project's node, or its system disk (docs/STORAGE.md §2.2). A volume pins its project to one
		// node, so a named disk may choose the node only while nothing runs yet. A restore goes back
		// onto the source's disk.
		let nodeId: string;
		let freeBytes: number | null;
		let reservedBytes: number;
		const workloadNode = this.workloadNode(project);
		let disk: DiskRow | null;
		if (options.restoreFrom) {
			disk = this.ctx.disks.byId(options.restoreFrom.diskId);
			if (options.restoreFrom.diskId && !disk)
				throw new ConflictError('The disk that held the source volume was removed, so its snapshot cannot be restored onto it.');
			if (disk) this.ctx.disks.assertRoom(disk, input.sizeMb);
		} else {
			const plan = this.ctx.disks.plan('app-volumes', input.storage, workloadNode);
			if (plan.target === 'disk' && workloadNode && workloadNode !== plan.disk!.nodeId)
				throw new ValidationError(
					`Disk "${plan.disk!.name}" is on another node; a volume cannot pin this project away from its running workload. Detach or move the workload first.`,
				);
			disk = this.ctx.disks.pick(plan, plan.target === 'disk' ? plan.disk!.nodeId : (workloadNode ?? this.requiredEdgeNode()), input.sizeMb);
		}
		const backing = disk ? 'node_volume' : 'state_dir';
		if (disk) {
			nodeId = disk.nodeId;
			freeBytes = disk.freeBytes;
			reservedBytes = this.reservedBytesForDisk(disk.id);
		} else {
			nodeId = this.workloadNode(project) ?? this.requiredEdgeNode();
			freeBytes = this.diskFreeForNode(nodeId);
			reservedBytes = this.reservedBytesForStateDir(nodeId);
		}
		const problem = diskAdmissionProblem({ requestMb: input.sizeMb, freeBytes, reservedBytes });
		if (problem) throw new ConflictError(problem);

		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		const restoreFrom = options.restoreFrom;
		if (restoreFrom) this.lifecycle.assertNodeCapable(nodeId, 'restore');
		const now = this.ctx.now();
		const id = newId(APP_VOLUME_ID_PREFIX);
		this.ctx.db
			.insert(appVolumes)
			.values({
				id,
				orgId: principal.orgId,
				projectId: project.id,
				name: input.name,
				nodeId,
				backing,
				diskId: disk?.id ?? null,
				sizeMb: input.sizeMb,
				usedBytes: null,
				mountPath: '',
				status: restoreFrom ? 'pending' : 'ready',
				message: restoreFrom ? `Restoring from snapshot ${restoreFrom.snapshotId} of "${restoreFrom.sourceName}".` : null,
				singleWriter: input.singleWriter,
				restoreSnapshotId: restoreFrom?.snapshotId ?? null,
				createdBy: principal.userId,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'appVolume.create',
			resource: 'appVolume',
			resourceId: id,
			args: {
				project: project.slug,
				name: input.name,
				sizeMb: input.sizeMb,
				backing,
				...(disk ? { disk: disk.name } : {}),
				...(input.storage ? { storage: input.storage } : {}),
				nodeId,
				...(restoreFrom ? { restoreFrom: restoreFrom.snapshotId, source: restoreFrom.sourceName } : {}),
			},
			result: 'ok',
		});
		if (restoreFrom) this.ctx.nodes.bump();
		return this.toView(this.requireRow(principal, project, input.name), project);
	}

	update(principal: Principal, project: ProjectRow, name: string, raw: AppVolumeUpdate): AppVolumeView {
		this.assertEnabled();
		requirePermission(principal, 'project:update');
		const input = appVolumeUpdateSchema.parse(raw);
		const row = this.requireRow(principal, project, name);
		if (row.deletedAt) throw new ConflictError(`Volume "${name}" is in the trash.`);
		if (input.sizeMb !== undefined && input.sizeMb < row.sizeMb)
			throw new ValidationError(
				`Volume "${name}" is ${row.sizeMb} MB; shrinking to ${input.sizeMb} MB is not supported. Create a new volume and copy the data.`,
			);
		if (input.sizeMb !== undefined && input.sizeMb > row.sizeMb) {
			this.ctx.quota.assertCanResizeVolume(principal.orgId, project.id, row.sizeMb, input.sizeMb);
			const freeBytes = row.diskId ? (this.ctx.disks.byId(row.diskId)?.freeBytes ?? null) : this.diskFreeForNode(row.nodeId);
			const reservedBytes = row.diskId
				? this.reservedBytesForDisk(row.diskId) - row.sizeMb * MB
				: this.reservedBytesForStateDir(row.nodeId) - row.sizeMb * MB;
			const problem = diskAdmissionProblem({
				requestMb: input.sizeMb,
				freeBytes,
				reservedBytes,
			});
			if (problem) throw new ConflictError(problem);
		}
		if (input.name !== undefined && input.name !== row.name) {
			const clash = this.ctx.db
				.select({ id: appVolumes.id })
				.from(appVolumes)
				.where(and(eq(appVolumes.projectId, project.id), eq(appVolumes.name, input.name)))
				.get();
			if (clash) throw new ConflictError(`Volume "${input.name}" already exists in this project.`);
		}
		const now = this.ctx.now();
		this.ctx.db
			.update(appVolumes)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.sizeMb !== undefined ? { sizeMb: input.sizeMb } : {}),
				...(input.singleWriter !== undefined ? { singleWriter: input.singleWriter } : {}),
				updatedAt: now,
			})
			.where(eq(appVolumes.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'appVolume.update',
			resource: 'appVolume',
			resourceId: row.id,
			args: { project: project.slug, name, ...input },
			result: 'ok',
		});
		return this.toView(this.requireRow(principal, project, input.name ?? name), project);
	}

	/** Soft delete. Refused while attached; the data stays until `purgeAt` (seven days). */
	delete(principal: Principal, project: ProjectRow, name: string): { ok: true; purgeAt: string } {
		this.assertEnabled();
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, project, name);
		if (row.restoreSnapshotId)
			throw new ConflictError(`Volume "${name}" is being restored; wait for the restore to finish (or fail) before deleting it.`);
		const attached = this.ctx.db
			.select({ id: appVolumeAttachments.id })
			.from(appVolumeAttachments)
			.where(eq(appVolumeAttachments.volumeId, row.id))
			.get();
		if (attached)
			throw new ConflictError(
				`Volume "${name}" is still attached. Detach it before deleting; its data is kept for ${this.ctx.policies.get().trashDays} days.`,
			);
		const now = this.ctx.now();
		const purgeAt = now + this.ctx.policies.trashMs();
		this.ctx.db
			.update(appVolumes)
			.set({ deletedAt: now, purgeAt, status: 'deleting', updatedAt: now })
			.where(eq(appVolumes.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'appVolume.delete',
			resource: 'appVolume',
			resourceId: row.id,
			args: { project: project.slug, name, purgeAt: new Date(purgeAt).toISOString() },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return { ok: true, purgeAt: new Date(purgeAt).toISOString() };
	}

	// ---------------------------------------------------------------- attachments

	attach(principal: Principal, project: ProjectRow, name: string, raw: AppVolumeAttach): AppVolumeView {
		this.assertEnabled();
		requirePermission(principal, 'project:update');
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process" or "container" to mount a volume.`,
			);
		const input = appVolumeAttachSchema.parse(raw);
		const row = this.requireRow(principal, project, name);
		if (row.deletedAt) throw new ConflictError(`Volume "${name}" is in the trash.`);
		if (row.restoreSnapshotId)
			throw new ConflictError(
				`Volume "${name}" is still being restored from snapshot ${row.restoreSnapshotId}; attach it once it is ready.`,
			);
		if (row.status === 'failed')
			throw new ConflictError(row.message ?? `Volume "${name}" failed. Delete it and create or restore it again.`);
		const workload = this.resolveWorkload(project, input.workload);
		if (workload.nodeId && workload.nodeId !== row.nodeId)
			throw new ConflictError(
				`Volume "${name}" is on another node. A volume pins its project to one node; redeploy the project on ${row.nodeId} first.`,
			);
		this.assertBackingReady(row);

		const existing = this.ctx.db
			.select()
			.from(appVolumeAttachments)
			.where(eq(appVolumeAttachments.volumeId, row.id))
			.all();
		const same = existing.find(
			(item) => item.workloadId === workload.id && item.environment === input.environment,
		);
		if (same)
			throw new ConflictError(
				`Volume "${name}" is already attached to ${input.environment} at ${same.mountPath}. Detach it first to change the mount path.`,
			);
		if (!input.readOnly && row.singleWriter) {
			const writer = existing.find((item) => !item.readOnly);
			if (writer)
				throw new ConflictError(
					`Volume "${name}" is already attached read-write to ${writer.environment}. Single-writer volumes allow one read-write attachment; detach it first or attach read-only.`,
				);
		}
		const mountTaken = this.ctx.db
			.select({ id: appVolumeAttachments.id, volumeId: appVolumeAttachments.volumeId })
			.from(appVolumeAttachments)
			.where(
				and(
					eq(appVolumeAttachments.workloadId, workload.id),
					eq(appVolumeAttachments.environment, input.environment),
					eq(appVolumeAttachments.mountPath, input.mountPath),
				),
			)
			.get();
		if (mountTaken)
			throw new ConflictError(
				`${input.mountPath} is already used by another volume in ${input.environment}. Pick a different mount path.`,
			);

		const now = this.ctx.now();
		const id = newId('ava_');
		this.ctx.db.transaction(() => {
			this.ctx.db
				.insert(appVolumeAttachments)
				.values({
					id,
					orgId: principal.orgId,
					projectId: project.id,
					volumeId: row.id,
					workloadId: workload.id,
					environment: input.environment,
					mountPath: input.mountPath,
					readOnly: input.readOnly,
					createdAt: now,
				})
				.run();
			this.ctx.db
				.update(appVolumes)
				.set({ mountPath: input.mountPath, status: 'ready', message: null, updatedAt: now })
				.where(eq(appVolumes.id, row.id))
				.run();
		});
		this.ctx.audit.record({
			principal,
			action: 'appVolume.attach',
			resource: 'appVolume',
			resourceId: row.id,
			args: {
				project: project.slug,
				name,
				workload: workload.id,
				environment: input.environment,
				mountPath: input.mountPath,
				readOnly: input.readOnly,
			},
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.toView(this.requireRow(principal, project, name), project);
	}

	detach(principal: Principal, project: ProjectRow, name: string, raw: AppVolumeDetach): AppVolumeView {
		this.assertEnabled();
		requirePermission(principal, 'project:update');
		const input = appVolumeDetachSchema.parse(raw);
		const row = this.requireRow(principal, project, name, { includeDeleted: true });
		const workload = this.resolveWorkload(project, input.workload);
		const attachment = this.ctx.db
			.select()
			.from(appVolumeAttachments)
			.where(
				and(
					eq(appVolumeAttachments.volumeId, row.id),
					eq(appVolumeAttachments.workloadId, workload.id),
					eq(appVolumeAttachments.environment, input.environment),
				),
			)
			.get();
		if (!attachment)
			throw new NotFoundError(`Attachment of "${name}" to ${input.environment}`);
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(appVolumeAttachments).where(eq(appVolumeAttachments.id, attachment.id)).run();
			const remaining = this.ctx.db
				.select({ mountPath: appVolumeAttachments.mountPath })
				.from(appVolumeAttachments)
				.where(eq(appVolumeAttachments.volumeId, row.id))
				.all();
			this.ctx.db
				.update(appVolumes)
				.set({
					mountPath: remaining[0]?.mountPath ?? '',
					...(row.deletedAt ? {} : { status: 'ready' as const }),
					updatedAt: now,
				})
				.where(eq(appVolumes.id, row.id))
				.run();
		});
		this.ctx.audit.record({
			principal,
			action: 'appVolume.detach',
			resource: 'appVolume',
			resourceId: row.id,
			args: { project: project.slug, name, workload: workload.id, environment: input.environment },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.toView(this.requireRow(principal, project, name, { includeDeleted: true }), project);
	}

	// ---------------------------------------------------------------- desired state

	/** Mounts for one workload in node desired state. Metadata only: no host path or device. */
	mountsForWorkload(workloadId: string): WorkloadVolumeMount[] {
		return this.ctx.db
			.select({ attachment: appVolumeAttachments, volume: appVolumes })
			.from(appVolumeAttachments)
			.innerJoin(appVolumes, eq(appVolumes.id, appVolumeAttachments.volumeId))
			.where(and(eq(appVolumeAttachments.workloadId, workloadId), isNull(appVolumes.deletedAt)))
			.all()
			.sort((a, b) => a.attachment.mountPath.localeCompare(b.attachment.mountPath))
			.map(({ attachment, volume }) => ({
				id: volume.id,
				mountPath: attachment.mountPath,
				readOnly: attachment.readOnly,
				backing: volume.backing,
				...(volume.diskId ? { nodeVolumeId: volume.diskId } : {}),
			}));
	}

	/** Stable fingerprint of a workload's volume attachments for the activation version. */
	attachmentsVersion(workloadId: string): string {
		return this.mountsForWorkload(workloadId)
			.map((mount) => `${mount.id}:${mount.mountPath}:${mount.readOnly ? 'ro' : 'rw'}`)
			.join(',');
	}

	/** Same fingerprint for a project before a workload row exists (deploy planning). */
	projectVersion(projectId: string): string {
		return this.ctx.db
			.select({
				id: appVolumeAttachments.volumeId,
				mountPath: appVolumeAttachments.mountPath,
				readOnly: appVolumeAttachments.readOnly,
			})
			.from(appVolumeAttachments)
			.where(eq(appVolumeAttachments.projectId, projectId))
			.all()
			.sort((a, b) => a.mountPath.localeCompare(b.mountPath))
			.map((mount) => `${mount.id}:${mount.mountPath}:${mount.readOnly ? 'ro' : 'rw'}`)
			.join(',');
	}

	/** State-dir reservations per node, for capacity views and disk admission. */
	reservedDiskByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, []>(
				`SELECT node_id AS nodeId, SUM(size_mb * 1048576) AS total FROM app_volumes
				 WHERE backing = 'state_dir' AND deleted_at IS NULL GROUP BY node_id`,
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
	}

	// ---------------------------------------------------------------- snapshots

	snapshots(volumeId: string): AppVolumeSnapshotView[] {
		return this.lifecycle.snapshotViews(volumeId);
	}

	// ---------------------------------------------------------------- internals

	private toView(row: AppVolumeRow, project: ProjectRow): AppVolumeView {
		const attachments = this.ctx.db
			.select()
			.from(appVolumeAttachments)
			.where(eq(appVolumeAttachments.volumeId, row.id))
			.all()
			.sort((a, b) => a.createdAt - b.createdAt);
		const disk = this.ctx.disks.byId(row.diskId);
		let status = row.status as AppVolumeStatus;
		let message = row.message;
		if (row.deletedAt) status = 'deleting';
		else if (row.diskId) {
			if (!disk) {
				status = 'missing';
				message = 'The disk this volume lives on was removed.';
			} else if (disk.status !== 'ready') {
				status = disk.status === 'missing' ? 'missing' : 'failed';
				message = disk.message ?? `Its disk "${disk.name}" is ${disk.status}.`;
			}
		}
		const writer = attachments.find((item) => !item.readOnly) ?? null;
		return {
			id: row.id,
			orgId: row.orgId,
			projectId: row.projectId,
			projectSlug: project.slug,
			name: row.name,
			nodeId: row.nodeId,
			backing: row.backing,
			disk: disk ? { id: disk.id, name: disk.name, tier: disk.tier, remote: disk.remote } : null,
			sizeMb: row.sizeMb,
			usedBytes: row.usedBytes,
			usedAt: row.usedAt ? new Date(row.usedAt).toISOString() : null,
			nearQuota: (appVolumeUsagePercent(row) ?? 0) >= APP_VOLUME_USAGE_WARN_PERCENT,
			restoringFrom: row.restoreSnapshotId,
			mountPath: row.mountPath || attachments[0]?.mountPath || '',
			status,
			message,
			singleWriter: row.singleWriter,
			writer: writer ? { workloadId: writer.workloadId, environment: writer.environment } : null,
			attachments: attachments.map((item) => this.attachmentView(item, row)),
			snapshots: this.snapshots(row.id),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
		};
	}

	private attachmentView(
		row: AppVolumeAttachmentRow,
		volume: Pick<AppVolumeRow, 'name'>,
	): AppVolumeAttachmentView {
		return {
			id: row.id,
			volumeId: row.volumeId,
			volumeName: volume.name,
			workloadId: row.workloadId,
			environment: row.environment,
			mountPath: row.mountPath,
			readOnly: row.readOnly,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	private resolveWorkload(
		project: ProjectRow,
		reference: string,
	): typeof workloads.$inferSelect {
		const row = this.ctx.db
			.select()
			.from(workloads)
			.where(eq(workloads.projectId, project.id))
			.get();
		if (!row)
			throw new ConflictError(
				`Project "${project.slug}" has no workload yet. Deploy it before attaching a volume.`,
			);
		if (reference !== row.id && reference !== project.slug)
			throw new ValidationError(
				`Workload "${reference}" is not this project's workload. Use "${project.slug}" or ${row.id}.`,
			);
		return row;
	}

	private workloadNode(project: ProjectRow): string | null {
		return (
			this.ctx.db
				.select({ nodeId: workloads.nodeId })
				.from(workloads)
				.where(eq(workloads.projectId, project.id))
				.get()?.nodeId ?? null
		);
	}

	private requiredEdgeNode(): string {
		const nodeId = this.ctx.workloads.edgeNode();
		if (!nodeId) throw new ConflictError('No edge node is registered yet. Join a node before creating a volume.');
		return nodeId;
	}

	private diskFreeForNode(nodeId: string): number | null {
		const row = this.ctx.db.select({ statsJson: nodes.statsJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return nodeDiskFreeBytes(parseJson(row?.statsJson ?? null, null));
	}

	private reservedBytesForStateDir(nodeId: string): number {
		const rows = this.ctx.db
			.select({ sizeMb: appVolumes.sizeMb })
			.from(appVolumes)
			.where(
				and(
					eq(appVolumes.nodeId, nodeId),
					eq(appVolumes.backing, 'state_dir'),
					isNull(appVolumes.deletedAt),
				),
			)
			.all();
		return rows.reduce((total, row) => total + row.sizeMb * MB, 0);
	}

	private reservedBytesForDisk(diskId: string): number {
		const rows = this.ctx.db
			.select({ sizeMb: appVolumes.sizeMb })
			.from(appVolumes)
			.where(and(eq(appVolumes.diskId, diskId), isNull(appVolumes.deletedAt)))
			.all();
		return rows.reduce((total, row) => total + row.sizeMb * MB, 0);
	}

	private assertBackingReady(row: AppVolumeRow): void {
		if (!row.diskId) return;
		const disk = this.ctx.disks.byId(row.diskId);
		if (!disk) throw new ConflictError('The disk this volume lives on was removed.');
		if (disk.status !== 'ready')
			throw new ConflictError(`Its disk "${disk.name}" is ${disk.status}${disk.message ? `: ${disk.message}` : ''}.`);
		if (disk.freeBytes !== null && disk.freeBytes < row.sizeMb * MB)
			throw new ConflictError(
				`Its disk "${disk.name}" has ${Math.floor(disk.freeBytes / MB)} MB free; this volume needs ${row.sizeMb} MB.`,
			);
	}
}
