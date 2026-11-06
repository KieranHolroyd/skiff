import {
	ingressHealthPolicySchema,
	type IngressHealthDecision,
	type IngressHealthPolicy,
	type IngressObservation,
} from '@skiff/contracts';

/**
 * DNS failover health policy (docs/CLUSTERING.md §7.2, C5).
 *
 * Pure state: one failed probe starts a hold-down, one success clears it, a recovered node is
 * added back only after a longer healthy window, and the last healthy record is never withdrawn.
 * The caller owns probing and the DNS API.
 */
export class IngressHealth {
	private readonly failedSince = new Map<string, number>();
	private readonly healthySince = new Map<string, number>();

	observe(observation: IngressObservation): void {
		if (observation.ok) {
			this.failedSince.delete(observation.nodeId);
			if (!this.healthySince.has(observation.nodeId)) this.healthySince.set(observation.nodeId, observation.at);
		} else {
			this.healthySince.delete(observation.nodeId);
			if (!this.failedSince.has(observation.nodeId)) this.failedSince.set(observation.nodeId, observation.at);
		}
	}

	decision(
		nodes: string[],
		currentRecords: string[],
		now: number,
		policy: Partial<IngressHealthPolicy> = {},
	): IngressHealthDecision {
		const resolved = ingressHealthPolicySchema.parse(policy);
		const records = new Set(currentRecords);
		const healthy = nodes.filter((node) => !this.failedSince.has(node));
		const remove = nodes.filter(
			(node) =>
				records.has(node) &&
				this.failedSince.has(node) &&
				now - this.failedSince.get(node)! >= resolved.holdDownMs,
		);
		const healthyRecords = currentRecords.filter((node) => !this.failedSince.has(node));
		const safeRemove = healthyRecords.length >= resolved.minHealthy ? remove : [];
		const add = nodes.filter(
			(node) =>
				!records.has(node) &&
				!this.failedSince.has(node) &&
				this.healthySince.has(node) &&
				now - this.healthySince.get(node)! >= resolved.readdHoldDownMs,
		);
		return {
			remove: safeRemove,
			add,
			keep: nodes.filter((node) => records.has(node) && !safeRemove.includes(node)),
		};
	}
}
