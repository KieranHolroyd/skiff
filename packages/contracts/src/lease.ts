import * as z from 'zod';

/** Control-plane lease (docs/CLUSTERING.md §6.3, C6). */
export const leaseRecordSchema = z.object({
	epoch: z.number().int().positive(),
	holderNodeId: z.string().min(1).max(100),
	/** Epoch milliseconds; a holder that cannot renew lets this expire. */
	expiresAt: z.number().int().nonnegative(),
});
export type LeaseRecord = z.infer<typeof leaseRecordSchema>;

export const leasePolicySchema = z.object({
	ttlMs: z.number().int().min(5_000).max(300_000).default(30_000),
	/** Renew with this much of the TTL left. */
	renewBeforeMs: z.number().int().min(1_000).max(299_000).default(5_000),
});
export type LeasePolicy = z.infer<typeof leasePolicySchema>;
