import * as z from 'zod';
import { volumeNameSchema, type VolumeKind } from './volume.ts';

/**
 * Disks and default storage (docs/STORAGE.md, D169).
 *
 * A **disk** is one mounted filesystem on one node that Yoal may store data on: a local disk or
 * partition, a device the OS already assembled (LVM, mdadm, ZFS, LUKS), or a mounted network
 * share. Each disk is `fast` or `bulk`. Every node also has its **system disk**, which is never a
 * row. A new service goes on a **storage target** — `system`, `fast`, `bulk` or one disk by name —
 * preselected from the kind's default in Settings → Storage. Yoal never picks another tier on its
 * own, and nothing already placed moves.
 */

export const storageTiers = ['fast', 'bulk'] as const;
export type StorageTier = (typeof storageTiers)[number];

/** Default targets: the system disk, or a tier. */
export const storageDefaultTargets = ['system', 'fast', 'bulk'] as const;
export type StorageDefaultTarget = (typeof storageDefaultTargets)[number];

/** Names a disk cannot take, because a storage target with that name means a tier. */
const RESERVED_DISK_NAMES: ReadonlySet<string> = new Set(storageDefaultTargets);

export const diskNameSchema = volumeNameSchema.refine(
	(name) => !RESERVED_DISK_NAMES.has(name),
	'"system", "fast" and "bulk" are storage targets; pick another disk name.',
);

/** `system`, `fast`, `bulk` or a disk name, as create bodies take it. */
export const storageTargetSchema = z.string().trim().min(3).max(40);

export function isTierTarget(target: string): target is StorageTier {
	return target === 'fast' || target === 'bulk';
}

/** Ids are `dsk_<32 hex>` (disks registered before 2026-11-08 keep `vol_…`). */
export const DISK_ID_PREFIX = 'dsk_';

/** Keep this share of a disk free after placing a service on it. */
export const DISK_MIN_FREE_PERCENT = 10;

export const storageKinds = ['databases', 'object-storage', 'brokers', 'app-volumes', 'builds', 'site-data'] as const;
export type StorageKind = (typeof storageKinds)[number];

/** Kinds resolved per node from desired state (D48 directories) rather than per resource. */
export const nodeStorageKinds: ReadonlySet<StorageKind> = new Set(['builds', 'site-data']);

export const storageKindInfo: Record<StorageKind, { label: string; description: string; suggested: StorageDefaultTarget }> = {
	databases: { label: 'Databases', description: 'Managed databases, read replicas and move targets.', suggested: 'fast' },
	'object-storage': { label: 'Object storage', description: 'S3-compatible storage instances.', suggested: 'bulk' },
	brokers: { label: 'Queues', description: 'Message broker data.', suggested: 'fast' },
	'app-volumes': { label: 'App volumes', description: 'Persistent directories mounted into apps.', suggested: 'fast' },
	builds: { label: 'Builds', description: 'Builder scratch space for git builds. Local disks only.', suggested: 'bulk' },
	'site-data': {
		label: 'Site data',
		description: 'Agent state and the static release cache Caddy serves. Local disks only.',
		suggested: 'system',
	},
};

export const storageTierInfo: Record<StorageDefaultTarget, { label: string; description: string }> = {
	system: { label: 'System disk', description: "Each node's built-in disk." },
	fast: { label: 'Fast disks', description: 'SSD or NVMe disks.' },
	bulk: { label: 'Bulk disks', description: 'Spinning disks, arrays and network shares.' },
};

// ------------------------------------------------------------------ inputs

/** *Use this disk*: a candidate key from the node's listing, a name and a tier. */
export const diskAddSchema = z
	.object({
		/** Node id or name. */
		node: z.string().trim().min(1).max(100),
		/** `DiskCandidateView.key`: `mount:<source key>` or `uuid:<filesystem UUID>`. */
		candidate: z.string().trim().min(6).max(320),
		/** Defaults to the candidate's suggested name. */
		name: diskNameSchema.optional(),
		/** Defaults to the tier derived from the hardware. */
		tier: z.enum(storageTiers).optional(),
	})
	.strict();
export type DiskAdd = z.input<typeof diskAddSchema>;

export const diskUpdateSchema = z
	.object({
		name: diskNameSchema.optional(),
		tier: z.enum(storageTiers).optional(),
	})
	.strict()
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type DiskUpdate = z.input<typeof diskUpdateSchema>;

export const storageDefaultSchema = z.object({
	kind: z.enum(storageKinds),
	target: z.enum(storageDefaultTargets),
});
export type StorageDefaultInput = z.input<typeof storageDefaultSchema>;

export const storageDefaultsSchema = z
	.object({ defaults: z.array(storageDefaultSchema).min(1).max(storageKinds.length) })
	.strict();
export type StorageDefaultsInput = z.input<typeof storageDefaultsSchema>;

export const storageOnboardingStates = ['pending', 'done', 'skipped'] as const;
export type StorageOnboardingState = (typeof storageOnboardingStates)[number];
export const storageOnboardingSchema = z.object({ state: z.enum(['done', 'skipped']) }).strict();

// ------------------------------------------------------------------ views

export const diskStatuses = ['pending', 'ready', 'missing', 'failed', 'removing'] as const;
export type DiskStatus = (typeof diskStatuses)[number];

/** The disk a service is placed on, as its detail view shows it; null means the system disk. */
export interface DiskSummary {
	id: string;
	name: string;
	tier: StorageTier;
	remote: boolean;
}

export interface DiskView {
	id: string;
	name: string;
	nodeId: string;
	nodeName: string | null;
	kind: VolumeKind;
	/** Stable node-reported identity (UUID, dataset, export). */
	sourceKey: string;
	mountPath: string;
	fsType: string;
	/** A mounted network share (D143). */
	remote: boolean;
	tier: StorageTier;
	/** The operator chose the tier; otherwise it follows the hardware. */
	tierSet: boolean;
	/** Yoal mounts this filesystem itself (at /mnt/yoal-disks/<name>). */
	mountedByYoal: boolean;
	/** The disk came from a network share mount; remove it by unmounting the share. */
	share: string | null;
	status: DiskStatus;
	message: string | null;
	sizeBytes: number | null;
	freeBytes: number | null;
	statsAt: string | null;
	/** What is stored on it, as "database main", "app volume uploads", "the node's builds". */
	holds: string[];
	profile: DiskProfileView | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Something on a node Yoal could use as a disk (`usable`), or a device the node reports that it
 * cannot (`reason`). Device names are display only; adding goes by `key`.
 */
export interface DiskCandidateView {
	/** `mount:<source key>` (already mounted) or `uuid:<filesystem UUID>` (Yoal mounts it). */
	key: string;
	usable: boolean;
	/** Why it cannot be used, when `usable` is false. */
	reason: string | null;
	/** `/dev/sdb1`, `tank/media` or `nas:/export`; display only. */
	device: string;
	model: string | null;
	fsType: string | null;
	label: string | null;
	mountPath: string | null;
	sizeBytes: number;
	freeBytes: number | null;
	remote: boolean;
	/** Yoal will mount it (it is not mounted yet). */
	needsMount: boolean;
	suggestedName: string;
	suggestedTier: StorageTier;
}

export interface StorageNodeView {
	id: string;
	name: string;
	status: string;
	/** System disk capacity, when the node reports it. */
	system: { sizeBytes: number | null; freeBytes: number | null };
	disks: DiskView[];
	/** Usable first, then the ones that are not (with a reason). */
	candidates: DiskCandidateView[];
	/** The node has reported its disks at least once. */
	inventoryReported: boolean;
}

export interface StorageDefaultView {
	kind: StorageKind;
	label: string;
	description: string;
	target: StorageDefaultTarget;
	/** False when nothing is saved and the system disk applies. */
	configured: boolean;
	warnings: string[];
}

export interface StorageOverview {
	onboarding: StorageOnboardingState;
	defaults: StorageDefaultView[];
	nodes: StorageNodeView[];
	/** Ready disks per tier across all nodes. */
	tiers: Record<StorageTier, { disks: number; sizeBytes: number; freeBytes: number }>;
}

/** What a create form may offer for one kind (no nodes, paths or capacity). */
export interface StorageChoices {
	kind: StorageKind;
	/** The default from Settings → Storage (`system` when none is saved). */
	defaultTarget: StorageDefaultTarget;
	/** Targets that can hold something right now: `system`, plus each tier with a ready disk. */
	targets: Array<{ value: StorageDefaultTarget; label: string; description: string; available: boolean }>;
}

// ------------------------------------------------------------------ profiles

/** Agent capability: runs `volumeProfileTasks` through the helper and reports the numbers. */
export const VOLUME_PROFILE_CAPABILITY = 'volume-profiles';

export const volumeProfileLimits = {
	/** Scratch file per disk. */
	sizeMb: 512,
	/** Seconds per fio job (five jobs). */
	runtimeSeconds: 10,
	/** A profile the node has not finished within this long fails. */
	timeoutMs: 15 * 60_000,
} as const;

/** One benchmark in a node's desired state: a disk id (`volumeId` on the wire) and limits, never a path. */
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

export const diskProfileStatuses = ['queued', 'running', 'succeeded', 'failed'] as const;
export type DiskProfileStatus = (typeof diskProfileStatuses)[number];

export interface DiskProfileView {
	id: string;
	diskId: string;
	status: DiskProfileStatus;
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
