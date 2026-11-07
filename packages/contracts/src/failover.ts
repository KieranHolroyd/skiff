import * as z from 'zod';

/** Database failover orchestration (docs/CLUSTERING.md §9.3, C8). */
export const failoverStages = ['detect', 'decide', 'fence', 'promote', 'repoint', 'heal', 'complete'] as const;
export type FailoverStage = (typeof failoverStages)[number];
export const failoverStageSchema = z.enum(failoverStages);

export const failoverPlanSchema = z.object({
	databaseId: z.string().min(1).max(100),
	candidateNodeId: z.string().min(1).max(100),
	generation: z.number().int().positive(),
	stage: failoverStageSchema.default('detect'),
	reason: z.string().max(200).default(''),
});
export type FailoverPlan = z.infer<typeof failoverPlanSchema>;

/**
 * The failover controller's history (docs/CLUSTERING.md §8.3, §11, C8). One row per action the
 * controller decided on: a replica copy re-placed off a lost or draining node, an ingress node
 * withdrawn from or re-added to rotation, a database primary on a lost node, or a change of the
 * controller lease itself.
 */
export const failoverEventKinds = ['replica', 'ingress', 'database', 'lease'] as const;
export type FailoverEventKind = (typeof failoverEventKinds)[number];

/**
 * `queued` waits for the rate limit (and expires after 10 minutes), `in-progress` was applied and
 * waits for the new copy, `manual` needs a human (automatic failover is off, or there is no
 * automatic path for the resource), `blocked` found no admissible target, `cancelled` means the
 * node came back first.
 */
export const failoverEventStatuses = [
	'queued',
	'in-progress',
	'completed',
	'failed',
	'blocked',
	'expired',
	'cancelled',
	'manual',
] as const;
export type FailoverEventStatus = (typeof failoverEventStatuses)[number];

export interface FailoverEventView {
	id: string;
	kind: FailoverEventKind;
	status: FailoverEventStatus;
	stage: FailoverStage;
	subjectId: string;
	subjectName: string | null;
	fromNodeId: string | null;
	fromNodeName: string | null;
	toNodeId: string | null;
	toNodeName: string | null;
	reason: string;
	/** The controller lease epoch the decision was made under (the fencing token). */
	epoch: number;
	/** Database failovers: the primary generation the promotion moves to. */
	generation: number | null;
	detectedAt: string;
	/** When the controller wrote the change (null while queued, blocked or manual). */
	appliedAt: string | null;
	updatedAt: string;
	finishedAt: string | null;
}

export type FailoverLeaseState = 'holder' | 'standby' | 'fenced' | 'idle';

export interface FailoverStatusView {
	/** `failover.enabled` in Settings → Clustering. Drains move copies either way. */
	enabled: boolean;
	policy: {
		graceSeconds: number;
		replicaGraceSeconds: number;
		maxPerMinute: number;
		perTargetPerMinute: number;
		queueExpirySeconds: number;
		/** How long an applied move may take before it counts as failed. */
		completionTimeoutSeconds: number;
		/** A node that was a failover source is not a target for this long. */
		flapWindowSeconds: number;
		leaseTtlSeconds: number;
		renewSeconds: number;
		/** The controller's tick: `renewSeconds`, capped so the lease is renewed well inside its TTL. */
		tickSeconds: number;
		/** Ingress withdrawal hold-down: twice the policy value, at least 120 s. */
		ingressHoldDownSeconds: number;
		ingressReaddSeconds: number;
	};
	/** The controller lease: only its holder acts, and every write is conditional on it. */
	lease: {
		state: FailoverLeaseState;
		epoch: number;
		holderId: string | null;
		/** True when this control-plane process holds it. */
		self: boolean;
		expiresAt: string | null;
	};
	lastTickAt: string | null;
	nodes: Array<{
		id: string;
		name: string;
		zone: string;
		status: string;
		roles: string[];
		lastHeartbeatAt: string | null;
		silentSeconds: number | null;
		/** Silent past `failover.graceSeconds`. */
		lost: boolean;
		/** When replica copies on it become eligible to move (null while it heartbeats). */
		replicaFailoverAt: string | null;
		copies: number;
	}>;
	ingress: {
		driver: string;
		/** True when the driver changes records itself; otherwise a withdrawal is a manual step. */
		steers: boolean;
		/**
		 * True when the controller tracks a record set for this driver (`dns-failover`,
		 * `cloudflare-lb`). `direct` has one edge and `cloudflare-tunnel` balances its connectors itself.
		 */
		rotates: boolean;
		nodes: Array<{
			id: string;
			name: string;
			healthy: boolean;
			inRotation: boolean;
			/** Withdrawn twice in 30 minutes: not re-added until `pinnedUntil`. */
			pinned: boolean;
			pinnedUntil: string | null;
		}>;
	};
	databases: Array<{
		id: string;
		name: string;
		nodeId: string | null;
		nodeName: string | null;
		primaryLost: boolean;
		replicas: number;
		/** The replica a promotion would pick under the lag limits, or null with the refusals. */
		candidate: { id: string; nodeId: string; nodeName: string | null } | null;
		refusals: string[];
		/** True when an automatic promotion path is installed and failover is on. */
		automatic: boolean;
	}>;
	/** True when an automatic database promotion path is installed (`registerDatabaseHandler`). */
	databaseHandler: boolean;
	counts: { lastMinute: number; inProgress: number; queued: number };
	recent: FailoverEventView[];
}
