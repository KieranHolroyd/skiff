import * as z from 'zod';
import { replicaSpreads } from './replica.ts';

/**
 * Cluster configuration (docs/CLUSTERING.md).
 *
 * One `settings` row holds the tunables the clustering phases read: overlay addressing, endpoint
 * ports, replica limits, control-plane lease timing, failover policy and storage replication.
 * Every field has a default, so a missing or stale row keeps the documented behaviour.
 */
export const CLUSTER_CONFIG_KEY = 'cluster_config';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const overlay = z.object({
	/** Per-install overlay CIDR; the first /24 is reserved for gateways. */
	cidr: z.string().trim().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/).default('10.47.0.0/22'),
	mtu: int(1280, 1420).default(1420),
	listenPort: int(1, 65_535).default(51_820),
	keepaliveSeconds: int(0, 65_535).default(25),
	maxHubs: int(1, 16).default(4),
});

const endpoints = z.object({
	portMin: int(10_000, 60_000).default(21_000),
	portMax: int(10_001, 61_000).default(21_999),
	requireMtls: z.boolean().default(true),
	forwarder: z.enum(['auto', 'bun', 'caddy-l4']).default('auto'),
});

const replicas = z.object({
	max: int(1, 20).default(20),
	spread: z.enum(replicaSpreads).default('node'),
	/** Caddy's active health-check interval across a replica set's upstreams. */
	healthIntervalSeconds: int(1, 300).default(5),
	/** Seconds since a node's last heartbeat before its replica copies are re-placed (§8.3). */
	failoverGraceSeconds: int(0, 3_600).default(120),
});

const database = z.object({
	maxReplicas: int(0, 5).default(2),
	/** A replica further behind than either limit is never picked for promotion (§9.3). */
	maxLagBytes: int(0, 10_000_000_000).default(67_108_864),
	maxLagSeconds: int(0, 86_400).default(60),
	defaultMode: z.enum(['async', 'sync']).default('async'),
});

const storage = z.object({
	maxTargets: int(0, 5).default(2),
	syncIntervalMinutes: int(1, 1_440).default(15),
});

/**
 * The failover controller's lease (§6.3): only the holder acts, it renews every `renewSeconds`
 * (the controller's tick), and a holder that stops renewing loses it after `leaseTtlSeconds`.
 * Standby promotion of the control plane itself is C6 and has no setting yet.
 */
const controlPlane = z.object({
	leaseTtlSeconds: int(5, 300).default(30),
	renewSeconds: int(1, 60).default(5),
});

/**
 * Automatic failover (§8.3, §11). Off by default: a lost node is reported, not acted on. A manual
 * drain moves replica copies whether or not this is on.
 */
const failover = z.object({
	enabled: z.boolean().default(false),
	/** Seconds since a node's last heartbeat before it counts as lost for ingress and databases. */
	graceSeconds: int(0, 3_600).default(120),
	/** Fleet-wide cap on automatic actions per minute. */
	maxPerMinute: int(1, 60).default(6),
});

const shares = z.object({
	mountRoot: z.string().trim().regex(/^\/(?:[A-Za-z0-9._-]+\/?)*$/).default('/run/yoal-shares'),
});

export const clusterConfigSchema = z.object({
	overlay,
	endpoints,
	replicas,
	database,
	storage,
	controlPlane,
	failover,
	shares,
});
export type ClusterConfig = z.infer<typeof clusterConfigSchema>;

const sectionUpdates = {
	overlay: overlay.partial().optional(),
	endpoints: endpoints.partial().optional(),
	replicas: replicas.partial().optional(),
	database: database.partial().optional(),
	storage: storage.partial().optional(),
	controlPlane: controlPlane.partial().optional(),
	failover: failover.partial().optional(),
	shares: shares.partial().optional(),
};

export const clusterConfigUpdateSchema = z.object(sectionUpdates).strict();
export type ClusterConfigUpdate = z.infer<typeof clusterConfigUpdateSchema>;
