import {
	endpointPortRange,
	type ServiceEndpoint,
	type ServiceKind,
} from '@yoal/contracts';

/**
 * Service endpoint planning (docs/CLUSTERING.md §4.3, phase C2).
 *
 * Pure so port allocation and stability are testable without a network: a consumer keeps the same
 * loopback port for a service across provider moves, and only cross-node attachments get one.
 */

export interface EndpointService {
	kind: ServiceKind;
	serviceId: string;
	upstreamNodeId: string;
	upstreamPort: number;
	/** Provider overlay address; null until known. */
	address?: string | null;
	tlsFingerprint?: string | null;
}

export interface ExistingEndpoint {
	kind: ServiceKind;
	serviceId: string;
	localPort: number;
}

export interface EndpointPlan {
	endpoints: ServiceEndpoint[];
	removed: string[];
}

export function endpointId(consumerNodeId: string, service: EndpointService): string {
	return `sep_${consumerNodeId}_${service.kind}_${service.serviceId}`.slice(0, 100);
}

/** Plan one consumer's endpoints. Existing ports are reused; freed ports are not renumbered. */
export function planServiceEndpoints(
	consumerNodeId: string,
	services: EndpointService[],
	existing: ExistingEndpoint[],
	range: { min: number; max: number } = endpointPortRange,
): EndpointPlan {
	const wanted = dedupe(services.filter((service) => service.upstreamNodeId !== consumerNodeId));
	const existingByKey = new Map(existing.map((item) => [`${item.kind}:${item.serviceId}`, item]));
	const wantedKeys = new Set(wanted.map((service) => `${service.kind}:${service.serviceId}`));
	// Ports a kept endpoint already owns are taken before any new one is allocated, so a new
	// service planned ahead of an existing one can never be handed that one's port.
	const used = new Set<number>(
		existing.filter((item) => wantedKeys.has(`${item.kind}:${item.serviceId}`)).map((item) => item.localPort),
	);
	const endpoints: ServiceEndpoint[] = [];

	for (const service of wanted) {
		const key = `${service.kind}:${service.serviceId}`;
		const previous = existingByKey.get(key);
		const localPort = previous?.localPort ?? allocatePort(used, range);
		used.add(localPort);
		endpoints.push({
			id: endpointId(consumerNodeId, service),
			kind: service.kind,
			serviceId: service.serviceId,
			localPort,
			upstream: {
				nodeId: service.upstreamNodeId,
				address: service.address ?? null,
				port: service.upstreamPort,
			},
			tlsFingerprint: service.tlsFingerprint ?? null,
		});
	}

	const removed = existing
		.filter((item) => !wantedKeys.has(`${item.kind}:${item.serviceId}`))
		.map((item) => `${item.kind}:${item.serviceId}`);
	return { endpoints: endpoints.sort((a, b) => a.localPort - b.localPort), removed };
}

/** One endpoint per service: two projects on a node attached to one database share it. */
function dedupe(services: EndpointService[]): EndpointService[] {
	const seen = new Map<string, EndpointService>();
	for (const service of services) {
		const key = `${service.kind}:${service.serviceId}`;
		if (!seen.has(key)) seen.set(key, service);
	}
	return [...seen.values()];
}

function allocatePort(used: Set<number>, range: { min: number; max: number }): number {
	for (let port = range.min; port <= range.max; port++)
		if (!used.has(port)) return port;
	throw new Error(`No free service endpoint port in ${range.min}–${range.max}.`);
}
