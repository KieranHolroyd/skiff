import * as z from 'zod';
import { backupTargetNameSchema } from './backup-target.ts';
import { volumeNameSchema } from './volume.ts';

/**
 * App volumes (plan 07, docs/VOLUMES.md).
 *
 * An app volume is a project-scoped directory with a size quota, mounted into a workload. It is
 * deliberately distinct from a **disk** (`disk.ts`, docs/STORAGE.md): a disk is an infrastructure
 * mount on a node that managed services and app volumes are stored on; an app volume is the
 * user-facing resource that apps attach to. A volume lives on a disk or the node's system disk (the
 * helper state directory), but the API never exposes a host path — only names, quotas and mount
 * points.
 *
 * Single-writer is the v1 rule: a read-write volume has one running owner; read-only attachments
 * are unlimited. Snapshots are versioned copies written to a backup target (plan 05) and restore
 * into a **new** volume, never over the original.
 */

export const APP_VOLUME_ID_PREFIX = 'av_';

/** Volume names reuse the disk-name rules so they are safe in URLs, units and CLI arguments. */
export const appVolumeNameSchema = volumeNameSchema;

export const appVolumeBackings = ['node_volume', 'state_dir'] as const;
export type AppVolumeBacking = (typeof appVolumeBackings)[number];

export const appVolumeStatuses = ['pending', 'ready', 'missing', 'failed', 'deleting'] as const;
export type AppVolumeStatus = (typeof appVolumeStatuses)[number];

export const appVolumeSnapshotStatuses = ['pending', 'running', 'ok', 'failed'] as const;
export type AppVolumeSnapshotStatus = (typeof appVolumeSnapshotStatuses)[number];

export const APP_VOLUME_SNAPSHOT_ID_PREFIX = 'avs_';

/**
 * How the node copied the volume:
 * - `reflink`: the writer was paused only while the directory was cloned copy-on-write (btrfs,
 *   XFS with reflink, OpenZFS 2.2+ block cloning); the archive streamed from the clone.
 * - `paused`: no reflink support, so the writer stayed paused (cgroup freeze) while the archive streamed.
 * - `idle`: nothing was writing (no running read-write attachment on the node), so no pause was needed.
 * - `live`: `quiesce: false` with a running writer; the copy may be inconsistent.
 */
export const appVolumeSnapshotMethods = ['reflink', 'paused', 'idle', 'live'] as const;
export type AppVolumeSnapshotMethod = (typeof appVolumeSnapshotMethods)[number];

/** Usage at or above this share of the quota is flagged in every surface and raises an alert. */
export const APP_VOLUME_USAGE_WARN_PERCENT = 90;

/** Used share of the quota as a whole percent, or null before the node reports a sample. */
export function appVolumeUsagePercent(view: { usedBytes: number | null; sizeMb: number }): number | null {
	if (view.usedBytes === null) return null;
	const budget = view.sizeMb * 1024 * 1024;
	return budget > 0 ? Math.round((view.usedBytes / budget) * 100) : 0;
}

/**
 * Mount points inside the workload sandbox. Absolute and normalized, never a host path, and not
 * a system tree, the helper state directory or the legacy `/data` mount.
 */
const FORBIDDEN_MOUNT_EXACT: ReadonlySet<string> = new Set([
	'/',
	'/data',
	'/home',
	'/media',
	'/mnt',
	'/srv',
	'/var',
	'/var/lib',
]);

const FORBIDDEN_MOUNT_PREFIXES: readonly string[] = [
	'/bin',
	'/boot',
	'/dev',
	'/etc',
	'/home',
	'/lib',
	'/lib32',
	'/lib64',
	'/libx32',
	'/opt/skiff',
	'/proc',
	'/root',
	'/run',
	'/sbin',
	'/sys',
	'/tmp',
	'/usr',
	'/var/lib/skiff',
	'/var/run',
	'/var/tmp',
];

function within(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** Why `path` is not an acceptable app-volume mount point, or null when it is. */
export function appVolumeMountPathProblem(path: string): string | null {
	if (!path.startsWith('/')) return 'Use an absolute mount path, such as /var/lib/app.';
	if (path !== '/' && path.endsWith('/')) return 'Drop the trailing slash.';
	if (path.split('/').some((part, index) => (index > 0 && part === '') || part === '.' || part === '..'))
		return 'Use a normalized path, without "//", "." or "..".';
	if (FORBIDDEN_MOUNT_EXACT.has(path)) return `${path} is reserved; mount inside it, such as ${path === '/' ? '/mnt/data' : `${path}/app`}.`;
	const prefix = FORBIDDEN_MOUNT_PREFIXES.find((candidate) => within(path, candidate));
	if (prefix) return `${path} is inside ${prefix}, which a workload cannot mount.`;
	return null;
}

export const appVolumeMountPathSchema = z
	.string()
	.trim()
	.max(200)
	.superRefine((value, ctx) => {
		const problem = appVolumeMountPathProblem(value);
		if (problem) ctx.addIssue({ code: 'custom', message: problem });
	});

/**
 * Create a project volume. `sizeMb` is both the quota and the disk-admission input. `storage` is
 * `system`, `fast`, `bulk` or a disk name, like every other service (docs/STORAGE.md); omitted
 * uses the `app-volumes` default from Settings → Storage.
 */
export const appVolumeCreateSchema = z.strictObject({
	name: appVolumeNameSchema,
	sizeMb: z.number().int().min(1).max(1_048_576).default(1024),
	storage: z.string().trim().min(3).max(40).optional(),
	/** v1 is single-writer; keep the default unless the volume is read-only everywhere. */
	singleWriter: z.boolean().default(true),
});
export type AppVolumeCreate = z.input<typeof appVolumeCreateSchema>;

export const appVolumeUpdateSchema = z
	.strictObject({
		name: appVolumeNameSchema.optional(),
		/** Grow only; shrinking is rejected by the service. */
		sizeMb: z.number().int().min(1).max(1_048_576).optional(),
		singleWriter: z.boolean().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type AppVolumeUpdate = z.infer<typeof appVolumeUpdateSchema>;

/** Attach a volume to a workload. A second read-write attachment is refused by the service. */
export const appVolumeAttachSchema = z.strictObject({
	workload: z.string().min(1).max(100),
	environment: z
		.string()
		.min(1)
		.max(30)
		.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens.')
		.refine((value) => !value.includes('--'), 'Environment names cannot contain "--".')
		.default('production'),
	mountPath: appVolumeMountPathSchema,
	readOnly: z.boolean().default(false),
});
export type AppVolumeAttach = z.input<typeof appVolumeAttachSchema>;

export const appVolumeDetachSchema = z.strictObject({
	workload: z.string().min(1).max(100),
	environment: z
		.string()
		.min(1)
		.max(30)
		.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/, 'Environment names are 1–30 lowercase letters, digits and hyphens.')
		.refine((value) => !value.includes('--'), 'Environment names cannot contain "--".')
		.default('production'),
});
export type AppVolumeDetach = z.input<typeof appVolumeDetachSchema>;

/** Snapshot a volume to a backup target. Quiescing the writer is the safe default. */
export const appVolumeSnapshotCreateSchema = z.strictObject({
	label: z.string().trim().min(1).max(120).optional(),
	/** Pinned snapshots are never removed by retention. */
	pinned: z.boolean().default(false),
	/** Stop/pause the owning workload so the copy is consistent; `false` is a warned choice. */
	quiesce: z.boolean().default(true),
	/** Backup target name; omitted resolves org → platform → local (plan 05). */
	target: backupTargetNameSchema.optional(),
});
export type AppVolumeSnapshotCreate = z.input<typeof appVolumeSnapshotCreateSchema>;

/**
 * Restore always creates a new volume in the same project, on the source's backing; it never
 * overwrites the source. The new volume is mountable once the node finished filling it.
 */
export const appVolumeRestoreSchema = z.strictObject({
	/** Name of the new volume. */
	name: appVolumeNameSchema,
	/** Quota of the new volume; defaults to the source's and cannot be smaller. */
	sizeMb: z.number().int().min(1).max(1_048_576).optional(),
});
export type AppVolumeRestore = z.input<typeof appVolumeRestoreSchema>;

// -------------------------------------------------------------------- views

/**
 * The disk an app volume lives on (D169); null is the node's system disk. A summary only: the
 * node's mount path and device are host details and deliberately absent from project-facing
 * responses.
 */
export const appVolumeDiskSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	tier: z.enum(['fast', 'bulk']),
	remote: z.boolean(),
});
export type AppVolumeDisk = z.infer<typeof appVolumeDiskSchema>;

export const appVolumeAttachmentViewSchema = z.strictObject({
	id: z.string(),
	volumeId: z.string(),
	volumeName: z.string(),
	workloadId: z.string(),
	environment: z.string(),
	mountPath: z.string(),
	readOnly: z.boolean(),
	createdAt: z.string(),
});
export type AppVolumeAttachmentView = z.infer<typeof appVolumeAttachmentViewSchema>;

export const appVolumeSnapshotViewSchema = z.strictObject({
	id: z.string(),
	volumeId: z.string(),
	/** Target the snapshot was written to; null while queued or after the target was removed. */
	target: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
	objectKey: z.string(),
	sizeBytes: z.number().int().nonnegative().nullable(),
	/** Lowercase hex digest recorded while streaming. */
	checksum: z.string().nullable(),
	pinned: z.boolean(),
	status: z.enum(appVolumeSnapshotStatuses),
	error: z.string().max(2000).nullable(),
	label: z.string().nullable(),
	/** How the node made the copy; null until it ran. */
	method: z.enum(appVolumeSnapshotMethods).nullable(),
	/** Whether the writer was to be paused for a consistent copy. */
	quiesce: z.boolean(),
	createdAt: z.string(),
	finishedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	/** Last time a restore from this snapshot matched its checksum. */
	restoreVerifiedAt: z.string().nullable(),
});
export type AppVolumeSnapshotView = z.infer<typeof appVolumeSnapshotViewSchema>;

export const appVolumeViewSchema = z.strictObject({
	id: z.string(),
	orgId: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	name: z.string(),
	nodeId: z.string(),
	backing: z.enum(appVolumeBackings),
	disk: appVolumeDiskSchema.nullable(),
	sizeMb: z.number().int().positive(),
	/** Latest helper usage sample; null until the agent reports. */
	usedBytes: z.number().int().nonnegative().nullable(),
	/** When the node measured `usedBytes`. */
	usedAt: z.string().nullable(),
	/** True at or above `APP_VOLUME_USAGE_WARN_PERCENT` of the quota. */
	nearQuota: z.boolean(),
	/** Snapshot this volume is being restored from; null once it is ready. */
	restoringFrom: z.string().nullable(),
	mountPath: z.string(),
	status: z.enum(appVolumeStatuses),
	message: z.string().max(2000).nullable(),
	singleWriter: z.boolean(),
	/** Current read-write owner when single-writer is enforced. */
	writer: z.strictObject({ workloadId: z.string(), environment: z.string() }).nullable(),
	attachments: z.array(appVolumeAttachmentViewSchema).max(100),
	snapshots: z.array(appVolumeSnapshotViewSchema).max(100),
	createdAt: z.string(),
	updatedAt: z.string(),
	deletedAt: z.string().nullable(),
});
export type AppVolumeView = z.infer<typeof appVolumeViewSchema>;

// -------------------------------------------------------------------- node protocol

/**
 * An app volume as the node sees it: ids and the backing only. The helper derives the host path
 * from its own state dir or disk registry, exactly as it does for mounts.
 */
export const appVolumeNodeRefSchema = z.object({
	id: z.string().regex(/^av_[A-Za-z0-9_-]{1,96}$/),
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
	backing: z.enum(appVolumeBackings),
	nodeVolumeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
});
export type AppVolumeNodeRef = z.infer<typeof appVolumeNodeRefSchema>;

/**
 * A snapshot or restore the node must run. `snapshot` streams a gzip tar of the volume to `url`
 * (presigned PUT); `restore` streams `url` (presigned GET) into the new, empty `volume`.
 * `quiesce` pauses the writers named in desired state (`workloads[].volumes`) for the copy.
 */
export const appVolumeTaskSchema = z.object({
	id: z.string().min(1).max(200),
	action: z.enum(['snapshot', 'restore']),
	volume: appVolumeNodeRefSchema,
	snapshotId: z.string().regex(/^avs_[A-Za-z0-9_-]{1,96}$/),
	url: z.string().min(1),
	quiesce: z.boolean().default(true),
	/** Restore only: the snapshot's recorded sha256, checked while streaming. */
	checksum: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});
export type AppVolumeTask = z.infer<typeof appVolumeTaskSchema>;

export const appVolumeTaskResultSchema = z.object({
	taskId: z.string().min(1).max(200),
	action: z.enum(['snapshot', 'restore']),
	snapshotId: z.string().max(100),
	volumeId: z.string().max(100),
	status: z.enum(['ok', 'failed']),
	sizeBytes: z.number().int().nonnegative().optional(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
	method: z.enum(appVolumeSnapshotMethods).optional(),
	error: z.string().max(2_000).optional(),
});
export type AppVolumeTaskResult = z.infer<typeof appVolumeTaskResultSchema>;

/** One usage sample. `usedBytes` is the allocated size (`du -B1`) of the volume directory. */
export const appVolumeUsageSampleSchema = z.object({
	id: z.string().max(100),
	usedBytes: z.number().int().nonnegative(),
});
export type AppVolumeUsageSample = z.infer<typeof appVolumeUsageSampleSchema>;
