import * as z from 'zod';

/**
 * Cluster topology (docs/CLUSTERING.md §3, phase C0).
 *
 * A node reports hardware facts; the operator assigns the failure domain and the roles the node
 * may run. Placement filters on those facts once, at deploy time. Everything here is additive:
 * an install that never sets a zone keeps `default`, and a node that predates hardware reporting
 * simply has no facts.
 */

export const nodeRoles = ['ingress', 'control', 'compute', 'data', 'build'] as const;
export type NodeRole = (typeof nodeRoles)[number];
export const nodeRoleSchema = z.enum(nodeRoles);

/** A failure domain: nodes in one zone share power, uplink and provider fate. */
export const nodeZoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(32)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and single hyphens.');

/**
 * Operator labels match placement constraints. Keys are lowercase and may contain dots, so
 * `owner=media` and `tier=critical` are valid; `skiff.io/*` is reserved for derived facts.
 */
export const nodeLabelKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9./-]*[a-z0-9])?$/, 'Use lowercase letters, digits, dots, slashes and hyphens.')
	.refine((key) => !key.startsWith('skiff.io/'), 'The skiff.io/ prefix is reserved for derived labels.');
export const nodeLabelValueSchema = z.string().trim().min(0).max(128);
export const nodeLabelsSchema = z.record(nodeLabelKeySchema, nodeLabelValueSchema);

/** Placement constraint on a node's disks (D169): a tier, or `remote` for a network share. `unknown` matches nothing. */
export const volumeClasses = ['fast', 'bulk', 'remote', 'unknown'] as const;
export type VolumeClass = (typeof volumeClasses)[number];
export const volumeClassSchema = z.enum(volumeClasses);

/** Hardware facts are optional field by field: a container or an older kernel cannot report all. */
export const nodeHardwareSchema = z
	.object({
		arch: z.string().max(32).optional(),
		cpuModel: z.string().max(160).optional(),
		cores: z.number().int().min(1).max(1024).optional(),
		threads: z.number().int().min(1).max(4096).optional(),
		memoryBytes: z.number().int().nonnegative().optional(),
		swapBytes: z.number().int().nonnegative().optional(),
		virtualization: z.string().max(64).optional(),
		gpus: z
			.array(
				z.object({
					name: z.string().max(160).optional(),
					memoryMiB: z.number().int().nonnegative().optional(),
					pciId: z.string().max(64).optional(),
				}),
			)
			.max(16)
			.optional(),
		disks: z
			.array(
				z.object({
					name: z.string().max(64),
					sizeBytes: z.number().int().nonnegative().optional(),
					rotational: z.boolean().optional(),
					transport: z.enum(['nvme', 'sata', 'sas', 'usb', 'virtio', 'unknown']).optional(),
				}),
			)
			.max(64)
			.optional(),
		nics: z
			.array(
				z.object({
					name: z.string().max(64),
					speedMbps: z.number().int().nonnegative().optional(),
					mtu: z.number().int().min(68).max(65_535).optional(),
				}),
			)
			.max(32)
			.optional(),
		os: z.string().max(160).optional(),
		kernel: z.string().max(160).optional(),
		power: z
			.object({
				state: z.string().max(32),
				percent: z.number().min(0).max(100).optional(),
			})
			.nullable()
			.optional(),
		collectedAt: z.string().max(40).optional(),
	})
	.strip();
export type NodeHardware = z.infer<typeof nodeHardwareSchema>;

/**
 * Placement constraints. The old `edge | <node> | auto` values on a project remain shorthands;
 * a spec adds hard constraints (zone, roles, labels, disk tier or id) and a soft locality hint.
 * `volumeClass` matches a node's disk tiers plus `remote` for a network disk; `volumeId` is a disk
 * id and pins its node (D169).
 */
export const placementSpecSchema = z
	.object({
		/** Pin to one node id. */
		node: z.string().trim().min(1).max(100).optional(),
		zone: z.union([nodeZoneSchema, z.array(nodeZoneSchema).min(1).max(16)]).optional(),
		roles: z.array(nodeRoleSchema).min(1).max(nodeRoles.length).optional(),
		labels: z.record(z.string().min(1).max(63), z.string().max(128)).optional(),
		volumeClass: volumeClassSchema.optional(),
		volumeId: z.string().trim().min(1).max(100).optional(),
		/** Replica constraint: never two copies on one node, or in one zone. */
		spread: z.enum(['node', 'zone']).optional(),
		/** Prefer the node(s) running this database or storage instance. */
		near: z.string().trim().min(1).max(100).optional(),
	})
	.strict();
export type PlacementSpec = z.infer<typeof placementSpecSchema>;

export const nodeClusterSettingsSchema = z
	.object({
		zone: nodeZoneSchema.optional(),
		roles: z.array(nodeRoleSchema).min(1).max(nodeRoles.length).optional(),
		labels: nodeLabelsSchema.optional(),
		/** LAN address used for direct peering inside one zone (C1). */
		lanEndpoint: z
			.string()
			.trim()
			.max(253)
			.regex(/^[A-Za-z0-9.\-[\]:]+$/, 'Use a host or host:port, without a scheme or path.')
			.nullable()
			.optional(),
		/** CPU reservation budget in millis; null removes the cap. */
		cpuBudgetMillis: z.number().int().min(100).max(1_000_000).nullable().optional(),
	})
	.strict();
export type NodeClusterSettings = z.infer<typeof nodeClusterSettingsSchema>;

/** A node in the topology view. Counts are live reservations, not historical totals. */
export interface TopologyNodeView {
	id: string;
	name: string;
	zone: string;
	roles: NodeRole[];
	labels: Record<string, string>;
	status: string;
	mode: string;
	publicAddress: string | null;
	privateAddress: string | null;
	lanEndpoint: string | null;
	hardware: NodeHardware | null;
	/** Derived labels (skiff.io/*) plus operator labels. */
	derivedLabels: Record<string, string>;
	disks: Array<{
		id: string;
		name: string;
		tier: 'fast' | 'bulk';
		mountPath: string;
		sizeBytes: number | null;
		freeBytes: number | null;
		remote: boolean;
	}>;
	workloads: number;
	databases: number;
	storageInstances: number;
	cpuBudgetMillis: number | null;
}

export interface TopologyZoneView {
	zone: string;
	nodes: string[];
	/** What an outage of this zone would take down, before failover. */
	workloads: number;
	databases: number;
	storageInstances: number;
}

export interface TopologyView {
	generatedAt: string;
	zones: TopologyZoneView[];
	nodes: TopologyNodeView[];
}

export interface BlastRadiusItem {
	kind: 'workload' | 'database' | 'storage' | 'disk';
	id: string;
	name: string;
	nodeId: string;
	orgId: string | null;
	/** `L0` is the only level that exists today; the field is present so the view can grow. */
	haLevel: string;
}

export interface BlastRadiusView {
	target: { kind: 'node' | 'zone'; id: string; name: string };
	affectedNodes: string[];
	items: BlastRadiusItem[];
	summary: {
		workloads: number;
		databases: number;
		storageInstances: number;
		disks: number;
	};
}
