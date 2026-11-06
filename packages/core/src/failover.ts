import type { FailoverPlan, FailoverStage } from '@skiff/contracts';

/** The only allowed forward steps; a failure may move to `detect` for a retry. */
const NEXT: Record<FailoverStage, FailoverStage[]> = {
	detect: ['decide'],
	decide: ['fence'],
	fence: ['promote'],
	promote: ['repoint'],
	repoint: ['heal'],
	heal: ['complete'],
	complete: [],
};

export function canAdvance(from: FailoverStage, to: FailoverStage): boolean {
	return NEXT[from].includes(to);
}

/** Advance one stage; throws rather than skipping fencing or promotion. */
export function advanceFailover(plan: FailoverPlan): FailoverPlan {
	const next = NEXT[plan.stage][0];
	if (!next) return plan;
	return { ...plan, stage: next };
}

/** Published budget for a node-loss promotion, in milliseconds. */
export const FAILOVER_BUDGET_MS = 2 * 60_000;
