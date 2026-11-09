import type { DatabasePromotionChoice, DatabaseReplica } from '@yoal/contracts';

/**
 * Promotion choice for a managed database (docs/CLUSTERING.md §9.3, C7).
 *
 * Highest replay LSN wins; a replica that is lost, failed or beyond the lag budget is refused.
 * The caller fences the old primary and performs `pg_ctl promote`.
 */
export function chooseReplicaForPromotion(
	replicas: DatabaseReplica[],
	limits: { maxLagBytes?: number; maxLagSeconds?: number } = {},
): DatabasePromotionChoice {
	const refusals: DatabasePromotionChoice['refusals'] = [];
	const eligible: DatabaseReplica[] = [];
	for (const replica of replicas) {
		if (replica.status === 'lost' || replica.status === 'failed' || replica.status === 'stopped') {
			refusals.push({ id: replica.id, nodeId: replica.nodeId, reason: `replica is ${replica.status}` });
			continue;
		}
		if (limits.maxLagBytes !== undefined && replica.lagBytes !== null && replica.lagBytes > limits.maxLagBytes) {
			refusals.push({ id: replica.id, nodeId: replica.nodeId, reason: `lag ${replica.lagBytes} B` });
			continue;
		}
		if (limits.maxLagSeconds !== undefined && replica.lagSeconds !== null && replica.lagSeconds > limits.maxLagSeconds) {
			refusals.push({ id: replica.id, nodeId: replica.nodeId, reason: `lag ${replica.lagSeconds}s` });
			continue;
		}
		eligible.push(replica);
	}
	if (eligible.length === 0)
		return { replica: null, reason: 'No replica is eligible for promotion.', refusals };
	eligible.sort((a, b) => compareLsn(b.replayLsn, a.replayLsn) || b.primaryGeneration - a.primaryGeneration);
	return { replica: eligible[0]!, reason: `highest replay LSN ${eligible[0]!.replayLsn ?? 'unknown'}`, refusals };
}

/** Postgres LSNs are `X/Y` hex; compare numerically, treating null as lowest. */
export function compareLsn(a: string | null, b: string | null): number {
	const parse = (value: string | null): bigint => {
		if (!value) return 0n;
		const [high, low] = value.split('/');
		try {
			return (BigInt(`0x${high ?? '0'}`) << 32n) + BigInt(`0x${low ?? '0'}`);
		} catch {
			return 0n;
		}
	};
	const left = parse(a);
	const right = parse(b);
	return left === right ? 0 : left > right ? 1 : -1;
}
