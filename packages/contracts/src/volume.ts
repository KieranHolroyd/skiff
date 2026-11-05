import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import { nodeStoragePathSchema } from './storage.ts';

/**
 * Node volumes (docs/VOLUMES.md, D72–D80). A volume is the mounted endpoint of a disk, pool,
 * array, LUKS mapper or network export, identified by a stable `sourceKey` — never a device name.
 * Managed databases and storage instances can be placed on one instead of the helper state dir.
 *
 * The control plane stores what the node reported; the node re-derives and verifies it before a
 * workload starts, so a missing mount fails closed instead of writing to the root filesystem.
 */

export const volumeKinds = ['filesystem', 'lvm', 'mdadm', 'zfs', 'luks', 'nfs', 'cifs'] as const;
export type VolumeKind = (typeof volumeKinds)[number];

export const volumeStatuses = ['pending', 'ready', 'missing', 'failed', 'removing'] as const;
export type VolumeStatus = (typeof volumeStatuses)[number];

/** Kinds whose mount is a network filesystem. */
const REMOTE_KINDS: ReadonlySet<VolumeKind> = new Set(['nfs', 'cifs']);
export function isRemoteVolumeKind(kind: VolumeKind): boolean {
	return REMOTE_KINDS.has(kind);
}

/** Volume names follow slug rules so they are safe in URLs, unit names and CLI arguments. */
export const volumeNameSchema = z
	.string()
	.trim()
	.min(3)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens; start and end with a letter or digit.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.');

/** Ids are `vol_<32 hex>`. */
export const VOLUME_ID_PREFIX = 'vol_';

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
});
export type VolumeInventoryEntry = z.infer<typeof volumeInventoryEntrySchema>;

/**
 * A block device for the provisioning wizard (P1+). `id` is a serial/WWN where available so it
 * survives reboots; `free` means no filesystem, mount, holder, swap or system role.
 */
export const volumeDeviceSchema = z.object({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200),
	model: z.string().max(120).nullable().default(null),
	serial: z.string().max(120).nullable().default(null),
	sizeBytes: z.number().int().nonnegative(),
	fsType: z.string().max(32).nullable().default(null),
	mountPath: z.string().max(200).nullable().default(null),
	holders: z.array(z.string().max(120)).max(20).default([]),
	free: z.boolean(),
});
export type VolumeDevice = z.infer<typeof volumeDeviceSchema>;

/** One registered volume in a node's desired state; the helper keeps it in its registry. */
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

/** Adopt a mount the node already reports. No formatting happens in P0. */
export const volumeAdoptSchema = z
	.object({
		name: volumeNameSchema,
		sourceKey: volumeSourceKeySchema,
		/** Make it the node default for new managed instances. */
		default: z.boolean().default(false),
	})
	.strict();
export type VolumeAdopt = z.input<typeof volumeAdoptSchema>;

export const volumeUpdateSchema = z
	.object({
		name: volumeNameSchema.optional(),
		default: z.boolean().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type VolumeUpdate = z.infer<typeof volumeUpdateSchema>;

/** Name, path and transport of the volume an instance is placed on. */
export interface VolumeSummary {
	id: string;
	name: string;
	mountPath: string;
	remote: boolean;
}

export interface VolumeView {
	id: string;
	name: string;
	nodeId: string;
	nodeName: string | null;
	kind: VolumeKind;
	/** Stable node-reported identity (UUID/pool/export). */
	sourceKey: string;
	mountPath: string;
	fsType: string;
	remote: boolean;
	status: VolumeStatus;
	message: string | null;
	sizeBytes: number | null;
	freeBytes: number | null;
	statsAt: string | null;
	/** This volume is what new managed instances on the node use by default. */
	isDefault: boolean;
	/** Instances placed on it (visible to the resource's owners). */
	instances: { storage: string[]; databases: string[] };
	createdAt: string;
	updatedAt: string;
}

/** `GET /nodes/:id/volumes`: registered volumes plus the node's latest raw inventory. */
export interface NodeVolumesView {
	volumes: VolumeView[];
	inventory: VolumeInventory | null;
}

/** True when the volume has room for a managed instance's budget. */
export function volumeHasRoom(volume: Pick<VolumeView, 'freeBytes'>, storageMb: number): boolean {
	return volume.freeBytes === null || volume.freeBytes >= storageMb * 1024 * 1024;
}
