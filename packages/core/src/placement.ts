import type { Runtime } from '@skiff/contracts';
import { diskAdmissionProblem } from './app-volumes.ts';

/**
 * Placement and admission for tier 2/3 workloads (DESIGN §3.4.1, D41).
 *
 * Kept pure so the rules are testable without a database or an agent: the control plane resolves
 * `auto` exactly once, at deploy time, and records the chosen node on the deployment. A running app
 * never migrates on its own.
 */

export interface PlacementCandidate {
	id: string;
	name: string;
	mode: string;
	status: string;
	/** `skiff-workloads.slice` memory budget for this node. */
	sliceMemoryMb: number;
	/** Memory already reserved by workloads on this node (pending, starting or running). */
	reservedMemoryMb: number;
	/** Free space on the data filesystem; null before the node reports, undefined = not checked. */
	diskFreeBytes?: number | null;
	/** Bytes already reserved by app volumes backed by the state directory. */
	reservedDiskBytes?: number;
}

export interface PlacementRequest {
	runtime: Runtime;
	/** `edge`, `auto`, or a node id. */
	requested: string;
	/** Admission unit for the requested workload. */
	memoryMb: number;
	/**
	 * Optional disk admission for a workload that needs a new volume. Placement for ordinary
	 * workloads leaves it unset; app volumes also re-check disk in their service.
	 */
	diskMb?: number;
	edgeNodeId: string | null;
	candidates: PlacementCandidate[];
}

export type PlacementDecision =
	| {
			ok: true;
			nodeId: string;
			mode: 'edge' | 'worker';
			/** Why this node won, for the deploy response and the audit log. */
			reason: string;
	  }
	| { ok: false; message: string; freeByNode: Array<{ nodeId: string; name: string; freeMemoryMb: number }> };

const isEdge = (node: PlacementCandidate, edgeNodeId: string | null): boolean =>
	node.mode === 'edge' || (edgeNodeId !== null && node.id === edgeNodeId);

const freeMemory = (node: PlacementCandidate): number => node.sliceMemoryMb - node.reservedMemoryMb;

const diskProblem = (node: PlacementCandidate, diskMb: number | undefined): string | null =>
	diskMb === undefined
		? null
		: diskAdmissionProblem({
				requestMb: diskMb,
				freeBytes: node.diskFreeBytes ?? null,
				reservedBytes: node.reservedDiskBytes ?? 0,
			});

const canAdmit = (node: PlacementCandidate, memoryMb: number, diskMb?: number): boolean =>
	freeMemory(node) >= memoryMb && diskProblem(node, diskMb) === null;

function freeByNode(candidates: PlacementCandidate[]) {
	return candidates.map((node) => ({
		nodeId: node.id,
		name: node.name,
		freeMemoryMb: freeMemory(node),
	}));
}

export function resolvePlacement(request: PlacementRequest): PlacementDecision {
	const { candidates, memoryMb, edgeNodeId } = request;
	const edge = candidates.find((node) => isEdge(node, edgeNodeId)) ?? null;

	if (request.runtime === 'static') {
		if (!edge) return { ok: false, message: 'No edge node is registered yet.', freeByNode: freeByNode(candidates) };
		if (edge.status === 'draining' || edge.status === 'offline')
			return {
				ok: false,
				message: `The edge node "${edge.name}" is ${edge.status}; static sites need it online.`,
				freeByNode: freeByNode(candidates),
			};
		return { ok: true, nodeId: edge.id, mode: 'edge', reason: 'Static sites run on the edge.' };
	}

	const healthy = candidates.filter((node) => node.status === 'online');
	const describe = (node: PlacementCandidate): string =>
		`${node.name} (${freeMemory(node)} MB free of ${node.sliceMemoryMb} MB)`;

	if (request.requested === 'edge') {
		if (!edge)
			return { ok: false, message: 'No edge node is registered yet.', freeByNode: freeByNode(candidates) };
		if (!healthy.includes(edge))
			return {
				ok: false,
				message: `The edge node "${edge.name}" is ${edge.status}; it cannot accept workloads.`,
				freeByNode: freeByNode(candidates),
			};
		if (!canAdmit(edge, memoryMb, request.diskMb)) {
			const disk = diskProblem(edge, request.diskMb);
			return {
				ok: false,
				message:
					disk ??
					`The edge node "${edge.name}" only has ${freeMemory(edge)} MB of workload budget free, but this app reserves ${memoryMb} MB.`,
				freeByNode: freeByNode(candidates),
			};
		}
		return { ok: true, nodeId: edge.id, mode: 'edge', reason: 'Explicitly placed on the edge.' };
	}

	if (request.requested !== 'auto') {
		const target = candidates.find((node) => node.id === request.requested);
		if (!target)
			return {
				ok: false,
				message: `Node "${request.requested}" is not registered on this platform.`,
				freeByNode: freeByNode(candidates),
			};
		if (!healthy.includes(target))
			return {
				ok: false,
				message: `Node "${target.name}" is ${target.status}; pick an online node or "auto".`,
				freeByNode: freeByNode(candidates),
			};
		if (!canAdmit(target, memoryMb, request.diskMb)) {
			const disk = diskProblem(target, request.diskMb);
			return {
				ok: false,
				message:
					disk ??
					`Node "${target.name}" only has ${freeMemory(target)} MB of workload budget free, but this app reserves ${memoryMb} MB.`,
				freeByNode: freeByNode(candidates),
			};
		}
		return { ok: true, nodeId: target.id, mode: 'worker', reason: `Explicitly placed on ${target.name}.` };
	}

	// `auto`: prefer a worker with room (keeps the edge for ingress and survives a homelab outage
	// only when the operator pins the app there). Ties go to the emptiest node.
	const workers = healthy
		.filter((node) => !isEdge(node, edgeNodeId) && canAdmit(node, memoryMb, request.diskMb))
		.sort((a, b) => freeMemory(b) - freeMemory(a) || a.name.localeCompare(b.name));
	const worker = workers[0];
	if (worker)
		return {
			ok: true,
			nodeId: worker.id,
			mode: 'worker',
			reason: `Auto: ${describe(worker)}.`,
		};

	if (edge && canAdmit(edge, memoryMb, request.diskMb))
		return {
			ok: true,
			nodeId: edge.id,
			mode: 'edge',
			reason: `Auto: no worker had room; using the edge ${describe(edge)}.`,
		};

	return {
		ok: false,
		message: `No node can admit ${memoryMb} MB of workload memory. Free budget: ${
			freeByNode(candidates)
				.map((node) => `${node.name} ${node.freeMemoryMb} MB`)
				.join(', ') || 'no nodes online'
		}.`,
		freeByNode: freeByNode(candidates),
	};
}
