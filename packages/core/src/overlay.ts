import {
	DEFAULT_OVERLAY_CIDR,
	DEFAULT_WG_MTU,
	DEFAULT_WG_PORT,
	WG_KEEPALIVE_SECONDS,
	type NodeNetworkMode,
	type NodeRole,
	type WireguardPeer,
	type WireguardState,
} from '@skiff/contracts';

/**
 * Overlay address allocation and peer graph (docs/CLUSTERING.md §4.1, phase C1).
 *
 * Pure so the allocation and routing rules are testable without root, a kernel module or a
 * network. The control plane stores only public keys and addresses; the helper applies the
 * resulting state on the node.
 */

export interface OverlayNode {
	id: string;
	name: string;
	zone: string;
	roles: NodeRole[];
	networkMode: NodeNetworkMode;
	privateAddress: string | null;
	wgPublicKey: string | null;
	/** Underlay endpoint the hub dials (`host:port`), or null for a NATed node. */
	wgEndpoint: string | null;
	lanEndpoint: string | null;
}

/** `10.88.1.1` and up by default: the first /24 of a /22 is reserved for gateways. */
export function allocateOverlayAddress(cidr: string, used: ReadonlySet<string>): string | null {
	const parsed = parseCidr(cidr);
	if (!parsed) return null;
	const first = parsed.network + (parsed.prefix <= 24 ? 256 : 1);
	const last = parsed.network + parsed.size - 1;
	for (let value = first; value < last; value++) {
		const lastOctet = value & 255;
		if (lastOctet === 0 || lastOctet === 255) continue;
		const address = intToIpv4(value);
		if (!used.has(address)) return address;
	}
	return null;
}

/** The overlay state a node should converge to; external/BYO nodes receive no peers. */
export function buildWireguardState(
	nodeId: string,
	nodes: OverlayNode[],
	cidr = DEFAULT_OVERLAY_CIDR,
	options: { mtu?: number; listenPort?: number; keepaliveSeconds?: number } = {},
): WireguardState {
	const self = nodes.find((node) => node.id === nodeId);
	if (!self || self.networkMode === 'external' || !self.privateAddress) {
		return {
			mode: self?.networkMode ?? 'external',
			address: self?.privateAddress ?? null,
			cidr: null,
			mtu: options.mtu ?? DEFAULT_WG_MTU,
			listenPort: options.listenPort ?? DEFAULT_WG_PORT,
			peers: [],
		};
	}

	const managed = nodes.filter(
		(node) =>
			node.id !== self.id &&
			node.networkMode !== 'external' &&
			node.privateAddress &&
			node.wgPublicKey,
	);
	const hubs = managed.filter((node) => node.wgEndpoint && node.roles.includes('ingress'));
	const direct = managed.filter(
		(node) => node.zone === self.zone && node.lanEndpoint && !node.roles.includes('ingress'),
	);
	const directIds = new Set(direct.map((node) => node.id));
	const peers: WireguardPeer[] = [];

	if (hubs.length === 0 || self.roles.includes('ingress')) {
		// A hub dials every node; a spoke with no hub can still reach same-zone LAN peers.
		for (const node of managed) {
			const endpoint = node.lanEndpoint && node.zone === self.zone ? node.lanEndpoint : node.wgEndpoint;
			peers.push({
				nodeId: node.id,
				publicKey: node.wgPublicKey!,
				endpoint: endpoint ?? null,
				allowedIps: [`${node.privateAddress}/32`],
				persistentKeepalive: endpoint ? 0 : (options.keepaliveSeconds ?? WG_KEEPALIVE_SECONDS),
			});
		}
	} else {
		const hubIds = new Set(hubs.map((hub) => hub.id));
		const relayedByHub = new Map<string, OverlayNode[]>(hubs.map((hub) => [hub.id, []]));
		for (const node of managed) {
			if (directIds.has(node.id) || hubIds.has(node.id)) continue;
			const hub = hubs.find((candidate) => candidate.zone === node.zone) ?? hubs[0];
			if (hub) relayedByHub.get(hub.id)!.push(node);
		}
		for (const hub of hubs) {
			const relayed = relayedByHub.get(hub.id) ?? [];
			peers.push({
				nodeId: hub.id,
				publicKey: hub.wgPublicKey!,
				endpoint: hub.wgEndpoint ?? null,
				allowedIps: [hub.privateAddress!, ...relayed.map((node) => node.privateAddress!)].map((ip) => `${ip}/32`),
				persistentKeepalive: options.keepaliveSeconds ?? WG_KEEPALIVE_SECONDS,
			});
		}
		for (const node of direct) {
			peers.push({
				nodeId: node.id,
				publicKey: node.wgPublicKey!,
				endpoint: node.lanEndpoint,
				allowedIps: [`${node.privateAddress}/32`],
				persistentKeepalive: 0,
			});
		}
	}

	return {
		mode: self.networkMode,
		address: self.privateAddress,
		cidr,
		mtu: options.mtu ?? DEFAULT_WG_MTU,
		listenPort: options.listenPort ?? DEFAULT_WG_PORT,
		peers: dedupePeers(peers),
	};
}

function dedupePeers(peers: WireguardPeer[]): WireguardPeer[] {
	const byNode = new Map<string, WireguardPeer>();
	for (const peer of peers) {
		const existing = byNode.get(peer.nodeId);
		if (!existing) {
			byNode.set(peer.nodeId, peer);
			continue;
		}
		existing.allowedIps = [...new Set([...existing.allowedIps, ...peer.allowedIps])];
		if (!existing.endpoint) existing.endpoint = peer.endpoint;
	}
	return [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

interface ParsedCidr {
	network: number;
	prefix: number;
	size: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
	if (!match) return null;
	const address = ipv4ToInt(match[1]!);
	const prefix = Number(match[2]);
	if (address === null || prefix < 8 || prefix > 30) return null;
	const size = 2 ** (32 - prefix);
	const network = Math.floor(address / size) * size;
	return { network, prefix, size };
}

function ipv4ToInt(value: string): number | null {
	const parts = value.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(value: number): string {
	return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
