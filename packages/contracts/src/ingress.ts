import * as z from 'zod';

/** Ingress high availability drivers and health policy (docs/CLUSTERING.md §7.2, C5). */
export const ingressDrivers = ['direct', 'dns-failover', 'cloudflare-lb', 'cloudflare-tunnel'] as const;
export type IngressDriver = (typeof ingressDrivers)[number];
export const ingressDriverSchema = z.enum(ingressDrivers);

export const ingressHealthPolicySchema = z.object({
	/** Serve a failed node out after this many consecutive failed probes. */
	holdDownMs: z.number().int().min(5_000).max(600_000).default(45_000),
	/** Add a recovered node back only after this long healthy. */
	readdHoldDownMs: z.number().int().min(10_000).max(3_600_000).default(120_000),
	/** Never remove the last healthy record. */
	minHealthy: z.number().int().min(1).max(10).default(1),
});
export type IngressHealthPolicy = z.infer<typeof ingressHealthPolicySchema>;

export interface IngressObservation {
	nodeId: string;
	ok: boolean;
	at: number;
}

export interface IngressHealthDecision {
	/** Nodes that should be withdrawn from DNS. */
	remove: string[];
	/** Nodes that should be added back. */
	add: string[];
	/** Nodes currently healthy and kept. */
	keep: string[];
}
