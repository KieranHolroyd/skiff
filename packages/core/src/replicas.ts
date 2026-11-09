import type { ReplicaPlan, ReplicaRefusal, ReplicaSpread, WorkloadReplica } from '@yoal/contracts';

/**
 * Replica placement across nodes (docs/CLUSTERING.md §8.2, C4).
 *
 * Pure filter/score: a copy needs a node with room; node/zone spread is a hard constraint; then
 * the emptiest eligible nodes win. It runs once, at deploy or scale, never as a scheduler.
 */

export interface ReplicaCandidate {
	id: string;
	name: string;
	zone: string;
	status: string;
	freeMemoryMb: number;
}

export interface ReplicaRequest {
	count: number;
	memoryMb: number;
	candidates: ReplicaCandidate[];
	spread: ReplicaSpread;
}

export type ReplicaDecision =
	| { ok: true; plan: ReplicaPlan }
	| { ok: false; message: string; refusals: ReplicaRefusal[] };

export function planReplicas(request: ReplicaRequest): ReplicaDecision {
	if (!Number.isInteger(request.count) || request.count < 1)
		return { ok: false, message: 'Replica count must be a positive integer.', refusals: [] };
	if (!Number.isInteger(request.memoryMb) || request.memoryMb < 0)
		return { ok: false, message: 'Replica memory must be a non-negative integer.', refusals: [] };

	const healthy = request.candidates.filter((candidate) => candidate.status === 'online');
	const refusals: ReplicaRefusal[] = request.candidates
		.filter((candidate) => candidate.status !== 'online')
		.map((candidate) => ({ nodeId: candidate.id, name: candidate.name, reason: `node is ${candidate.status}` }));
	const assignments: WorkloadReplica[] = [];
	const usedNodes = new Set<string>();
	const usedZones = new Set<string>();

	for (let index = 0; index < request.count; index++) {
		const eligible = healthy
			.filter((candidate) => !usedNodes.has(candidate.id))
			.filter((candidate) => request.spread !== 'zone' || !usedZones.has(candidate.zone))
			.filter((candidate) => candidate.freeMemoryMb >= request.memoryMb);
		eligible.sort((a, b) => b.freeMemoryMb - a.freeMemoryMb || a.name.localeCompare(b.name));
		const chosen = eligible[0];
		if (!chosen) {
			for (const candidate of healthy) {
				const reason = usedNodes.has(candidate.id)
					? 'already holds a copy'
					: request.spread === 'zone' && usedZones.has(candidate.zone)
						? `zone ${candidate.zone} already holds a copy`
						: candidate.freeMemoryMb < request.memoryMb
							? `only ${candidate.freeMemoryMb} MB free`
							: 'no eligible slot';
				refusals.push({ nodeId: candidate.id, name: candidate.name, reason });
			}
			return {
				ok: false,
				message: `Cannot place ${request.count} replica(s) with ${request.spread} spread: ${refusals
					.map((row) => `${row.name}: ${row.reason}`)
					.join('; ')}.`,
				refusals,
			};
		}
		assignments.push({ index, nodeId: chosen.id, zone: chosen.zone, reason: `deploy: ${chosen.freeMemoryMb} MB free` });
		usedNodes.add(chosen.id);
		usedZones.add(chosen.zone);
		chosen.freeMemoryMb -= request.memoryMb;
	}

	return { ok: true, plan: { assignments } };
}
