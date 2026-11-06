import type { NodeRole, PlacementSpec, Runtime } from '@skiff/contracts';
import { diskAdmissionProblem } from './app-volumes.ts';

/**
 * Placement and admission for tier 2/3 workloads (DESIGN §3.4.1, D41; CLUSTERING §3.4).
 *
 * Kept pure so the rules are testable without a database or an agent: the control plane resolves
 * placement exactly once, at deploy time, and records the chosen node. A running app never
 * migrates on its own.
 *
 * The old `edge | <node> | auto` shorthand still works. A `PlacementSpec` adds hard filters
 * (node, zone, roles, labels, volume class, replica spread) and a soft locality hint (`near`).
 * When no spec is present the old algorithm runs unchanged.
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
	/** Failure domain (CLUSTERING §3.2). */
	zone?: string;
	/** Roles the node may run, already derived from mode/can_build when unset. */
	roles?: NodeRole[];
	/** Operator labels plus derived `skiff.io/*` facts. */
	labels?: Record<string, string>;
	/** Classes of the volumes registered on this node. */
	volumeClasses?: string[];
	/** Ids of the volumes registered on this node. */
	volumeIds?: string[];
	/** Optional CPU reservation ceiling and current reservation, in millis. */
	cpuBudgetMillis?: number | null;
	reservedCpuMillis?: number;
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
	/** Constraint spec from the project; null/undefined keeps the shorthand path. */
	spec?: PlacementSpec | null;
	/** CPU reservation requested by this workload, in millis. */
	cpuMillis?: number;
	/** For replica n>0: nodes and zones that already hold a copy. */
	replicaNodes?: string[];
	replicaZones?: string[];
	/** Resolved nodes for `spec.near` (a database or storage instance's node). */
	nearNodeIds?: string[];
}

export interface PlacementRefusal {
	nodeId: string;
	name: string;
	reason: string;
}

export type PlacementDecision =
	| {
			ok: true;
			nodeId: string;
			mode: 'edge' | 'worker';
			/** Why this node won, for the deploy response and the audit log. */
			reason: string;
	  }
	| {
			ok: false;
			message: string;
			freeByNode: Array<{ nodeId: string; name: string; freeMemoryMb: number }>;
			/** One first-failing constraint per rejected node, in candidate order. */
			rejections?: PlacementRefusal[];
	  };

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

const cpuProblem = (node: PlacementCandidate, cpuMillis: number | undefined): string | null => {
	if (cpuMillis === undefined || node.cpuBudgetMillis == null) return null;
	const reserved = node.reservedCpuMillis ?? 0;
	if (reserved + cpuMillis <= node.cpuBudgetMillis) return null;
	return `its CPU budget is ${node.cpuBudgetMillis} millis, ${reserved} reserved and ${cpuMillis} requested`;
};

const canAdmit = (node: PlacementCandidate, memoryMb: number, diskMb?: number, cpuMillis?: number): boolean =>
	freeMemory(node) >= memoryMb && diskProblem(node, diskMb) === null && cpuProblem(node, cpuMillis) === null;

function freeByNode(candidates: PlacementCandidate[]) {
	return candidates.map((node) => ({
		nodeId: node.id,
		name: node.name,
		freeMemoryMb: freeMemory(node),
	}));
}

function specZones(spec: PlacementSpec): string[] | null {
	if (spec.zone === undefined) return null;
	return Array.isArray(spec.zone) ? spec.zone : [spec.zone];
}

/**
 * Apply the hard constraints. Returns the survivors and one first-failing reason per rejected
 * node, so a refusal can name the constraint instead of "no capacity".
 */
function filterBySpec(
	candidates: PlacementCandidate[],
	spec: PlacementSpec,
	request: PlacementRequest,
): { kept: PlacementCandidate[]; rejections: PlacementRefusal[] } {
	const kept: PlacementCandidate[] = [];
	const rejections: PlacementRefusal[] = [];
	const zones = specZones(spec);
	for (const node of candidates) {
		const fail = (reason: string) => rejections.push({ nodeId: node.id, name: node.name, reason });
		if (spec.node !== undefined && node.id !== spec.node) {
			fail(`not the pinned node ${spec.node}`);
			continue;
		}
		if (zones && !zones.includes(node.zone ?? 'default')) {
			fail(`zone ${node.zone ?? 'default'} is not ${zones.join(' or ')}`);
			continue;
		}
		const missingRole = spec.roles?.find((role) => !(node.roles ?? []).includes(role));
		if (missingRole) {
			fail(`does not hold the ${missingRole} role`);
			continue;
		}
		const labelMismatch = Object.entries(spec.labels ?? {}).find(([key, value]) => node.labels?.[key] !== value);
		if (labelMismatch) {
			fail(`label ${labelMismatch[0]}=${labelMismatch[1]} does not match`);
			continue;
		}
		if (spec.volumeClass && !(node.volumeClasses ?? []).includes(spec.volumeClass)) {
			fail(`has no ${spec.volumeClass} volume`);
			continue;
		}
		if (spec.volumeId && !(node.volumeIds ?? []).includes(spec.volumeId)) {
			fail(`does not own volume ${spec.volumeId}`);
			continue;
		}
		if (request.replicaNodes?.includes(node.id)) {
			fail('already holds a replica');
			continue;
		}
		if (spec.spread === 'zone' && request.replicaZones?.includes(node.zone ?? 'default')) {
			fail(`zone ${node.zone ?? 'default'} already holds a replica`);
			continue;
		}
		kept.push(node);
	}
	return { kept, rejections };
}

function locality(node: PlacementCandidate, request: PlacementRequest): number {
	return request.nearNodeIds?.includes(node.id) ? 1 : 0;
}

export function resolvePlacement(request: PlacementRequest): PlacementDecision {
	const spec = request.spec ?? null;
	let candidates = request.candidates;
	let rejections: PlacementRefusal[] | undefined;
	if (spec) {
		const filtered = filterBySpec(candidates, spec, request);
		candidates = filtered.kept;
		rejections = filtered.rejections;
		if (candidates.length === 0) {
			return {
				ok: false,
				message: `No node matches the placement constraints (${rejections.map((row) => `${row.name}: ${row.reason}`).join('; ')}).`,
				freeByNode: freeByNode(request.candidates),
				rejections,
			};
		}
	}

	const { memoryMb, edgeNodeId } = request;
	const edge = candidates.find((node) => isEdge(node, edgeNodeId)) ?? null;

	if (request.runtime === 'static') {
		if (!edge) return { ok: false, message: 'No edge node is registered yet.', freeByNode: freeByNode(candidates), rejections };
		if (edge.status === 'draining' || edge.status === 'offline')
			return {
				ok: false,
				message: `The edge node "${edge.name}" is ${edge.status}; static sites need it online.`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		return { ok: true, nodeId: edge.id, mode: 'edge', reason: 'Static sites run on the edge.' };
	}

	const healthy = candidates.filter((node) => node.status === 'online');
	const describe = (node: PlacementCandidate): string =>
		`${node.name} (${freeMemory(node)} MB free of ${node.sliceMemoryMb} MB)`;

	if (request.requested === 'edge') {
		if (!edge)
			return { ok: false, message: 'No edge node is registered yet.', freeByNode: freeByNode(candidates), rejections };
		if (!healthy.includes(edge))
			return {
				ok: false,
				message: `The edge node "${edge.name}" is ${edge.status}; it cannot accept workloads.`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		if (!canAdmit(edge, memoryMb, request.diskMb, request.cpuMillis)) {
			const disk = diskProblem(edge, request.diskMb) ?? cpuProblem(edge, request.cpuMillis);
			return {
				ok: false,
				message:
					disk ??
					`The edge node "${edge.name}" only has ${freeMemory(edge)} MB of workload budget free, but this app reserves ${memoryMb} MB.`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		}
		return { ok: true, nodeId: edge.id, mode: 'edge', reason: 'Explicitly placed on the edge.' };
	}

	if (request.requested !== 'auto') {
		const target = candidates.find((node) => node.id === request.requested);
		if (!target)
			return {
				ok: false,
				message: spec
					? `Node "${request.requested}" is not registered or does not satisfy the placement constraints.`
					: `Node "${request.requested}" is not registered on this platform.`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		if (!healthy.includes(target))
			return {
				ok: false,
				message: `Node "${target.name}" is ${target.status}; pick an online node or "auto".`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		if (!canAdmit(target, memoryMb, request.diskMb, request.cpuMillis)) {
			const disk = diskProblem(target, request.diskMb) ?? cpuProblem(target, request.cpuMillis);
			return {
				ok: false,
				message:
					disk ??
					`Node "${target.name}" only has ${freeMemory(target)} MB of workload budget free, but this app reserves ${memoryMb} MB.`,
				freeByNode: freeByNode(candidates),
				rejections,
			};
		}
		return { ok: true, nodeId: target.id, mode: 'worker', reason: `Explicitly placed on ${target.name}.` };
	}

	// `auto`: prefer a worker with room. Locality is a soft hint; budget still breaks ties.
	const workers = healthy
		.filter((node) => !isEdge(node, edgeNodeId) && canAdmit(node, memoryMb, request.diskMb, request.cpuMillis))
		.sort(
			(a, b) =>
				locality(b, request) - locality(a, request) ||
				freeMemory(b) - freeMemory(a) ||
				a.name.localeCompare(b.name),
		);
	const worker = workers[0];
	if (worker)
		return {
			ok: true,
			nodeId: worker.id,
			mode: 'worker',
			reason: `Auto: ${describe(worker)}${locality(worker, request) ? '; near the attached service' : ''}.`,
		};

	if (edge && canAdmit(edge, memoryMb, request.diskMb, request.cpuMillis))
		return {
			ok: true,
			nodeId: edge.id,
			mode: 'edge',
			reason: `Auto: no worker had room; using the edge ${describe(edge)}.`,
		};

	const cpuReasons = candidates
		.map((node) => ({ node, problem: cpuProblem(node, request.cpuMillis) }))
		.filter((row): row is { node: PlacementCandidate; problem: string } => row.problem !== null)
		.map((row) => `${row.node.name}: ${row.problem}`);
	return {
		ok: false,
		message: `No node can admit ${memoryMb} MB of workload memory. Free budget: ${
			freeByNode(candidates)
				.map((node) => `${node.name} ${node.freeMemoryMb} MB`)
				.join(', ') || 'no nodes online'
		}.${cpuReasons.length ? ` CPU budget: ${cpuReasons.join('; ')}.` : ''}`,
		freeByNode: freeByNode(candidates),
		rejections,
	};
}
