import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import { nodeStoragePathSchema } from './storage.ts';

/**
 * The node side of disks (docs/STORAGE.md §3.1, D72, D76, D169). The wire predates the rename and
 * keeps saying "volume": the heartbeat inventory, the `volumes` registry in desired state (one
 * entry per disk) and the partition-mount messages. The product surface — views, inputs, Settings —
 * lives in `disk.ts`.
 *
 * The control plane stores what the node reported; the node re-derives and verifies it before a
 * workload starts, so a missing mount fails closed instead of writing to the root filesystem.
 */

export const volumeKinds = ['filesystem', 'lvm', 'mdadm', 'zfs', 'luks', 'nfs', 'cifs'] as const;
export type VolumeKind = (typeof volumeKinds)[number];

/** Kinds whose mount is a network filesystem. */
const REMOTE_KINDS: ReadonlySet<VolumeKind> = new Set(['nfs', 'cifs']);
export function isRemoteVolumeKind(kind: VolumeKind): boolean {
	return REMOTE_KINDS.has(kind);
}

/** Disk and app volume names follow slug rules so they are safe in URLs, unit names and CLI arguments. */
export const volumeNameSchema = z
	.string()
	.trim()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/**
 * A stable identity reported by the node:
 * `fs:<UUID>`, `lvm:<vg>/<lv>`, `md:<array UUID>`, `zfs:<pool>/<dataset>`, `luks:<mapper UUID>`,
 * `nfs:<server>:<export>` or `cifs:<server>/<share>`.
 */
export const volumeSourceKeySchema = z
	.string()
	.min(3)
	.max(300)
	.regex(/^[A-Za-z0-9._:/#+@-]+$/, 'Unexpected characters in the volume source key.')
	.refine((key) => !key.startsWith('/'), 'Use a stable identity (UUID, pool, export), not a device path.');

/** One mounted filesystem the node can offer. */
export const volumeInventoryEntrySchema = z.object({
	sourceKey: volumeSourceKeySchema,
	kind: z.enum(volumeKinds),
	fsType: z.string().min(1).max(32),
	mountPath: nodeStoragePathSchema,
	/** Kernel device, `server:/export` or `//server/share`; display only. */
	device: z.string().max(200).nullable().default(null),
	label: z.string().max(120).nullable().default(null),
	sizeBytes: z.number().int().nonnegative(),
	freeBytes: z.number().int().nonnegative(),
	remote: z.boolean().default(false),
	/** The device behind it spins (lsblk ROTA); null when unknown or remote. Older helpers omit it. */
	rotational: z.boolean().nullable().default(null),
});
export type VolumeInventoryEntry = z.infer<typeof volumeInventoryEntrySchema>;

/**
 * A block device (disk, partition, LV, array or LUKS mapper) the node reports. `id` is a
 * serial/WWN where available so it survives reboots; `free` means no filesystem, mount, holder,
 * swap or system role. `type`, `uuid`, `label` and `parent` are absent from agents that predate
 * partition mounts (they then default to null).
 */
export const volumeDeviceSchema = z.object({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200),
	/** lsblk TYPE: `disk`, `part`, `lvm`, `crypt`, `raid1`, … */
	type: z.string().max(32).nullable().default(null),
	/** Kernel name of the device this one sits on (a partition's disk). */
	parent: z.string().max(200).nullable().default(null),
	model: z.string().max(120).nullable().default(null),
	serial: z.string().max(120).nullable().default(null),
	sizeBytes: z.number().int().nonnegative(),
	fsType: z.string().max(32).nullable().default(null),
	/** Filesystem UUID; what a partition mount is addressed by, never the device name. */
	uuid: z.string().max(100).nullable().default(null),
	label: z.string().max(120).nullable().default(null),
	mountPath: z.string().max(200).nullable().default(null),
	holders: z.array(z.string().max(120)).max(20).default([]),
	/** lsblk ROTA; null from helpers that predate disks (D169). */
	rotational: z.boolean().nullable().default(null),
	free: z.boolean(),
});
export type VolumeDevice = z.infer<typeof volumeDeviceSchema>;

/** One disk in a node's desired state (`volumes`); the helper keeps it in its registry (D76). */
export const nodeVolumeDesiredSchema = z.object({
	id: z.string().min(1).max(100),
	mountPath: nodeStoragePathSchema,
	sourceKey: volumeSourceKeySchema,
	fsType: z.string().min(1).max(32),
});
export type NodeVolumeDesired = z.infer<typeof nodeVolumeDesiredSchema>;

export const volumeInventorySchema = z.object({
	generatedAt: z.string(),
	mounts: z.array(volumeInventoryEntrySchema).max(200).default([]),
	devices: z.array(volumeDeviceSchema).max(200).default([]),
});
export type VolumeInventory = z.infer<typeof volumeInventorySchema>;

// ------------------------------------------------------------------ partition mounts

/**
 * Disks Skiff mounts (docs/STORAGE.md §3): *Use this disk* on an unmounted filesystem asks the
 * node's helper to mount it — by UUID, never by device name — at `/mnt/skiff-disks/<name>`. The
 * disk turns ready once the inventory shows it there. Nothing is ever formatted.
 */
export const DISK_MOUNT_ROOT = '/mnt/skiff-disks';
export const DISK_MOUNT_CAPABILITY = 'disk-mounts';

export function diskMountPath(name: string): string {
	return `${DISK_MOUNT_ROOT}/${name}`;
}

/** Filesystems Skiff mounts for managed data: POSIX ownership and permissions are required. */
export const mountableFsTypes = ['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'f2fs'] as const;
export function isMountableFsType(fsType: string | null | undefined): boolean {
	return !!fsType && (mountableFsTypes as readonly string[]).includes(fsType.toLowerCase());
}

/** A filesystem UUID as lsblk reports it (ext/xfs/btrfs hex-with-dashes, FAT `ABCD-1234`). */
export const fsUuidSchema = z
	.string()
	.trim()
	.min(4)
	.max(64)
	.regex(/^[A-Fa-f0-9-]+$/, 'Unexpected characters in the filesystem UUID.');

/** A disk Skiff mounts, in a node's desired state: a UUID and a name, never a device path. */
export const diskMountDesiredSchema = z.object({
	/** The disk id; reports use it. */
	id: z.string().min(1).max(100),
	/** Mount directory name under `/mnt/skiff-disks`. */
	name: volumeNameSchema,
	fsUuid: fsUuidSchema,
	fsType: z.enum(mountableFsTypes),
});
export type DiskMountDesired = z.infer<typeof diskMountDesiredSchema>;

/** A disk Skiff mounted that the node must unmount (the disk is `removing`). */
export const diskUnmountDesiredSchema = z.object({
	id: z.string().min(1).max(100),
	name: volumeNameSchema,
});
export type DiskUnmountDesired = z.infer<typeof diskUnmountDesiredSchema>;

/** Heartbeat report: the node's view of each disk it should mount. */
export const diskMountReportSchema = z.object({
	id: z.string().min(1).max(100),
	mounted: z.boolean(),
	error: z.string().max(2_000).nullable().default(null),
});
export type DiskMountReport = z.infer<typeof diskMountReportSchema>;
