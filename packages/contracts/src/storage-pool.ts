import * as z from 'zod';
import { SLUG_PATTERN } from './slugs.ts';
import type { VolumeInventoryEntry, VolumeKind, VolumeStatus } from './volume.ts';
import type { VolumeClass } from './cluster.ts';

/**
 * Storage pools and default storage (docs/STORAGE.md, D144).
 *
 * A **pool** is a named, platform-wide group of node volumes (a volume is in at most one). The
 * built-in `system` pool is every node's system disk. Where a service's data lives is chosen when
 * it is created; Settings → Storage holds the **default** pool each kind of service starts with.
 * Skiff never picks a different pool on its own, and nothing already placed moves.
 */

/** The built-in pool: each node's system disk (helper state dir, D48 install defaults). */
export const SYSTEM_POOL = 'system';

export const storageKinds = ['databases', 'object-storage', 'brokers', 'app-volumes', 'builds', 'site-data'] as const;
export type StorageKind = (typeof storageKinds)[number];

/** Kinds resolved per node from desired state (D48 directories) rather than per resource. */
export const nodeStorageKinds: ReadonlySet<StorageKind> = new Set(['builds', 'site-data']);

export const storageKindInfo: Record<StorageKind, { label: string; description: string; prefer: 'fast' | 'bulk' | 'system' }> = {
	databases: {
		label: 'Databases',
		description: 'Managed database data, read replicas and move targets.',
		prefer: 'fast',
	},
	'object-storage': {
		label: 'Object storage',
		description: 'S3-compatible storage instances (RustFS).',
		prefer: 'bulk',
	},
	brokers: {
		label: 'Queues',
		description: 'Message broker data.',
		prefer: 'fast',
	},
	'app-volumes': {
		label: 'App volumes',
		description: 'Persistent directories mounted into apps.',
		prefer: 'fast',
	},
	builds: {
		label: 'Builds',
		description: 'Builder scratch space for git builds. Local volumes only.',
		prefer: 'bulk',
	},
	'site-data': {
		label: 'Site data',
		description: 'Agent state and the static release cache Caddy serves. Local volumes only.',
		prefer: 'system',
	},
};

export const storageAllocations = ['most-free', 'fill-up'] as const;
export type StorageAllocation = (typeof storageAllocations)[number];

export const storagePoolNameSchema = z
	.string()
	.trim()
	.min(2)
	.max(40)
	.regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.')
	.refine((name) => !name.includes('--'), 'Double hyphens are not allowed.')
	.refine((name) => name !== SYSTEM_POOL, '"system" is the built-in pool for each node\'s system disk.');

export const storagePoolCreateSchema = z
	.object({
		name: storagePoolNameSchema,
		description: z.string().trim().max(200).default(''),
		allocation: z.enum(storageAllocations).default('most-free'),
		/** Keep this share of each member free; a member below it after the request is skipped. */
		minFreePercent: z.number().int().min(0).max(90).default(10),
		/** Volume ids to put in the pool now. */
		volumes: z.array(z.string().min(1).max(100)).max(200).default([]),
	})
	.strict();
export type StoragePoolCreate = z.input<typeof storagePoolCreateSchema>;

export const storagePoolUpdateSchema = z
	.object({
		name: storagePoolNameSchema.optional(),
		description: z.string().trim().max(200).optional(),
		allocation: z.enum(storageAllocations).optional(),
		minFreePercent: z.number().int().min(0).max(90).optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type StoragePoolUpdate = z.input<typeof storagePoolUpdateSchema>;

/** A pool reference in a default or a create request: a pool name, or `system`. */
export const storagePoolRefSchema = z.string().trim().min(2).max(40);

/** The pool new services of one kind start with when the creator does not pick another. */
export const storageDefaultSchema = z.object({
	kind: z.enum(storageKinds),
	/** Pool name or `system`. */
	pool: storagePoolRefSchema,
});
export type StorageDefaultInput = z.input<typeof storageDefaultSchema>;

export const storageDefaultsSchema = z
	.object({ defaults: z.array(storageDefaultSchema).min(1).max(storageKinds.length) })
	.strict();
export type StorageDefaultsInput = z.input<typeof storageDefaultsSchema>;

export const storageVolumePoolSchema = z.object({ pool: storagePoolRefSchema.nullable() }).strict();

export const storageOnboardingStates = ['pending', 'done', 'skipped'] as const;
export type StorageOnboardingState = (typeof storageOnboardingStates)[number];
export const storageOnboardingSchema = z.object({ state: z.enum(['done', 'skipped']) }).strict();

// ------------------------------------------------------------------ views

export interface StoragePoolMemberView {
	volumeId: string;
	volumeName: string;
	nodeId: string;
	nodeName: string | null;
	kind: VolumeKind;
	class: VolumeClass;
	remote: boolean;
	mountPath: string;
	status: VolumeStatus;
	sizeBytes: number | null;
	freeBytes: number | null;
	/** Latest benchmark of this volume, if any. */
	profile: VolumeProfileView | null;
}

export interface StoragePoolView {
	id: string;
	name: string;
	description: string;
	allocation: StorageAllocation;
	minFreePercent: number;
	members: StoragePoolMemberView[];
	/** Sum over ready members that reported capacity. */
	sizeBytes: number;
	freeBytes: number;
	/** Distinct member classes, e.g. `['fast']` or `['bulk', 'remote']`. */
	classes: VolumeClass[];
	/** Kinds whose default is this pool. */
	usedBy: StorageKind[];
	/** A profile of at least one member is queued or running. */
	profiling: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface StorageDefaultView {
	kind: StorageKind;
	label: string;
	description: string;
	/** Pool name or `system`. */
	pool: string;
	/** False when no default is saved and the legacy fallback (node default volume) applies. */
	configured: boolean;
	/** Problems worth showing next to the default (e.g. databases defaulting to a remote pool). */
	warnings: string[];
}

/**
 * What Settings → Storage can do with one partition (docs/VOLUMES.md §3.1):
 * - `volume`: already a registered volume;
 * - `adoptable`: mounted at a usable path — *Add as volume* adopts it (`sourceKey`);
 * - `mountable`: an unmounted ext4/xfs/btrfs/f2fs filesystem — *Add as volume* mounts it at
 *   `/mnt/skiff-disks/<name>` by UUID, then adopts it;
 * - `mounting` / `failed` / `unmounting`: a partition mount in progress, failed or being removed;
 * - `system`: mounted at `/`, `/boot`, … (cannot hold managed data);
 * - `in-use`: swap, an LVM/RAID/LUKS/ZFS member, or a disk holding partitions;
 * - `unformatted`: no filesystem (formatting is not offered);
 * - `unsupported`: a filesystem without Unix permissions or a stable UUID.
 */
export const storagePartitionStates = [
	'volume',
	'adoptable',
	'mountable',
	'mounting',
	'failed',
	'unmounting',
	'system',
	'in-use',
	'unformatted',
	'unsupported',
] as const;
export type StoragePartitionState = (typeof storagePartitionStates)[number];

export interface StoragePartitionView {
	/** `/dev/sdb1`, display only. */
	device: string;
	type: string | null;
	/** Kernel name of the disk the partition is on. */
	parent: string | null;
	/** Model of the device or of its disk. */
	model: string | null;
	sizeBytes: number;
	fsType: string | null;
	uuid: string | null;
	label: string | null;
	mountPath: string | null;
	state: StoragePartitionState;
	/** Why it cannot be added, or the last mount error. */
	reason: string | null;
	/** Registered volume on it (`volume`). */
	volumeName: string | null;
	/** Inventory source key to adopt (`adoptable`). */
	sourceKey: string | null;
	/** Partition mount row (`mounting`, `failed`, `unmounting`, or a mount Skiff made). */
	diskMountId: string | null;
	/** Name suggested for *Add as volume*. */
	suggestedName: string;
	/** Free bytes when mounted. */
	freeBytes: number | null;
}

export interface StorageNodeView {
	id: string;
	name: string;
	status: string;
	/** Registered volumes on the node, with the pool each belongs to. */
	volumes: Array<{
		id: string;
		name: string;
		kind: VolumeKind;
		class: VolumeClass;
		remote: boolean;
		mountPath: string;
		status: VolumeStatus;
		sizeBytes: number | null;
		freeBytes: number | null;
		pool: string | null;
		profile: VolumeProfileView | null;
	}>;
	/** Mounted filesystems the node reports that are not registered yet. */
	adoptable: VolumeInventoryEntry[];
	/** Free block devices (formatting comes with VOLUMES P1). */
	freeDevices: number;
	/** Every partition (and whole-disk filesystem, LV, array or LUKS mapper) the node reports. */
	partitions: StoragePartitionView[];
	/** The node's agent can mount an unmounted partition (`disk-mounts`). */
	canMountPartitions: boolean;
	/** Free bytes on the system disk, when the node reports it. */
	systemFreeBytes: number | null;
	systemSizeBytes: number | null;
}

export interface StorageOverview {
	onboarding: StorageOnboardingState;
	pools: StoragePoolView[];
	defaults: StorageDefaultView[];
	nodes: StorageNodeView[];
}

/** Pools a create form may offer for one kind (no node, path or capacity detail). */
export interface StorageChoices {
	kind: StorageKind;
	/** The default pool from Settings → Storage, or null when none is saved (node default volume / system disk). */
	defaultPool: string | null;
	pools: Array<{ name: string; description: string; classes: VolumeClass[]; empty: boolean }>;
}

// ------------------------------------------------------------------ profiles

/** Agent capability: runs `volumeProfileTasks` through the helper and reports the numbers. */
export const VOLUME_PROFILE_CAPABILITY = 'volume-profiles';

export const volumeProfileLimits = {
	/** Scratch file per volume. */
	sizeMb: 512,
	/** Seconds per fio job (five jobs). */
	runtimeSeconds: 10,
	/** A profile the node has not finished within this long fails. */
	timeoutMs: 15 * 60_000,
} as const;

/** One benchmark in a node's desired state: a registered volume id and limits, never a path. */
export const volumeProfileTaskSchema = z.object({
	id: z.string().min(1).max(100),
	volumeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
	sizeMb: z.number().int().min(64).max(4096),
	runtimeSeconds: z.number().int().min(3).max(60),
});
export type VolumeProfileTask = z.infer<typeof volumeProfileTaskSchema>;

const metric = z.number().nonnegative().nullable().default(null);

/** Heartbeat report for one task. */
export const volumeProfileResultSchema = z.object({
	taskId: z.string().min(1).max(100),
	status: z.enum(['running', 'succeeded', 'failed']),
	method: z.enum(['fio', 'dd']).nullable().default(null),
	seqReadMBps: metric,
	seqWriteMBps: metric,
	randReadIops: metric,
	randWriteIops: metric,
	syncWriteIops: metric,
	syncWriteLatencyUs: metric,
	direct: z.boolean().nullable().default(null),
	notes: z.array(z.string().max(300)).max(10).default([]),
	error: z.string().max(2_000).nullable().default(null),
});
export type VolumeProfileResult = z.infer<typeof volumeProfileResultSchema>;

export const volumeProfileStatuses = ['queued', 'running', 'succeeded', 'failed'] as const;
export type VolumeProfileStatus = (typeof volumeProfileStatuses)[number];

export interface VolumeProfileView {
	id: string;
	volumeId: string;
	status: VolumeProfileStatus;
	method: 'fio' | 'dd' | null;
	seqReadMBps: number | null;
	seqWriteMBps: number | null;
	randReadIops: number | null;
	randWriteIops: number | null;
	syncWriteIops: number | null;
	syncWriteLatencyUs: number | null;
	direct: boolean | null;
	notes: string[];
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}
