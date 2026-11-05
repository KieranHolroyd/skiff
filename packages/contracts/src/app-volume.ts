import * as z from 'zod';
import { backupTargetNameSchema } from './backup-target.ts';
import { volumeNameSchema } from './volume.ts';

/**
 * App volumes (plan 07, docs/VOLUMES.md).
 *
 * An app volume is a project-scoped directory with a size quota, mounted into a workload. It is
 * deliberately distinct from a **node volume** (`volume.ts`, D72–D80): node volumes are
 * infrastructure mounts that back managed databases and storage instances; app volumes are the
 * user-facing resource that apps attach to. A volume is backed by a node volume or the helper
 * state directory, but the API never exposes a host path — only names, quotas and mount points.
 *
 * Single-writer is the v1 rule: a read-write volume has one running owner; read-only attachments
 * are unlimited. Snapshots are versioned copies written to a backup target (plan 05) and restore
 * into a **new** volume, never over the original.
 */

export const APP_VOLUME_ID_PREFIX = 'av_';

/** Volume names reuse the node-volume rules so they are safe in URLs, units and CLI arguments. */
export const appVolumeNameSchema = volumeNameSchema;

export const appVolumeBackings = ['node_volume', 'state_dir'] as const;
export type AppVolumeBacking = (typeof appVolumeBackings)[number];

export const appVolumeStatuses = ['pending', 'ready', 'missing', 'failed', 'deleting'] as const;
export type AppVolumeStatus = (typeof appVolumeStatuses)[number];

export const appVolumeSnapshotStatuses = ['pending', 'running', 'ok', 'failed'] as const;
export type AppVolumeSnapshotStatus = (typeof appVolumeSnapshotStatuses)[number];

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
 * Create a project volume. `sizeMb` is both the quota and the disk-admission input; an omitted
 * backing uses the helper state directory, and `nodeVolume` names an adopted node volume.
 */
export const appVolumeCreateSchema = z
	.strictObject({
		name: appVolumeNameSchema,
		sizeMb: z.number().int().min(1).max(1_048_576).default(1024),
		backing: z.enum(appVolumeBackings).default('state_dir'),
		/** Node volume name (not a host path); required for `node_volume`, rejected otherwise. */
		nodeVolume: z.string().min(3).max(40).optional(),
		/** v1 is single-writer; keep the default unless the volume is read-only everywhere. */
		singleWriter: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		if (input.backing === 'node_volume' && !input.nodeVolume)
			ctx.addIssue({ code: 'custom', path: ['nodeVolume'], message: 'Choose the node volume that backs this volume.' });
		if (input.backing === 'state_dir' && input.nodeVolume)
			ctx.addIssue({ code: 'custom', path: ['nodeVolume'], message: 'A state-dir volume cannot name a node volume.' });
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

/** Restore always creates a new volume; it never overwrites the source. */
export const appVolumeRestoreSchema = z
	.strictObject({
		name: appVolumeNameSchema,
		sizeMb: z.number().int().min(1).max(1_048_576).optional(),
		/** Optionally attach the restored volume to a workload right away. */
		workload: z.string().min(1).max(100).optional(),
		mountPath: appVolumeMountPathSchema.optional(),
		readOnly: z.boolean().default(false),
	})
	.superRefine((input, ctx) => {
		if (input.mountPath && !input.workload)
			ctx.addIssue({ code: 'custom', path: ['mountPath'], message: 'A mount path needs a workload to attach to.' });
	});
export type AppVolumeRestore = z.input<typeof appVolumeRestoreSchema>;

// -------------------------------------------------------------------- views

/**
 * The node volume backing a volume. A summary only: the node's mount path and device are host
 * details and deliberately absent from project-facing responses.
 */
export const appVolumeNodeVolumeSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	remote: z.boolean(),
});
export type AppVolumeNodeVolume = z.infer<typeof appVolumeNodeVolumeSchema>;

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
	createdAt: z.string(),
	expiresAt: z.string().nullable(),
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
	nodeVolume: appVolumeNodeVolumeSchema.nullable(),
	sizeMb: z.number().int().positive(),
	/** Latest helper usage sample; null until the agent reports. */
	usedBytes: z.number().int().nonnegative().nullable(),
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
