import { describe, expect, test } from 'bun:test';
import { allocateOverlayAddress, buildWireguardState, type OverlayNode } from './overlay.ts';

const key = (char: string) => `${char.repeat(43)}=`;
const node = (overrides: Partial<OverlayNode> & { id: string; privateAddress: string }): OverlayNode => ({
	name: overrides.id,
	zone: 'cloud-a',
	roles: ['compute'],
	networkMode: 'skiff',
	wgPublicKey: key('A'),
	wgEndpoint: null,
	lanEndpoint: null,
	...overrides,
});

describe('overlay allocation', () => {
	test('starts after the reserved first /24 and skips network/broadcast octets', () => {
		expect(allocateOverlayAddress('10.88.0.0/22', new Set())).toBe('10.88.1.1');
	});

	test('skips used addresses and returns null when exhausted', () => {
		expect(allocateOverlayAddress('10.88.0.0/22', new Set(['10.88.1.1', '10.88.1.2']))).toBe('10.88.1.3');
	});

	test('rejects an invalid CIDR', () => {
		expect(allocateOverlayAddress('not-a-cidr', new Set())).toBeNull();
	});
});

describe('peer graph', () => {
	const edge = node({
		id: 'nod_edge',
		privateAddress: '10.88.1.1',
		zone: 'cloud-a',
		roles: ['ingress', 'control', 'compute', 'data'],
		wgEndpoint: '203.0.113.10:51820',
	});
	const edgeB = node({
		id: 'nod_edge_b',
		privateAddress: '10.88.1.2',
		zone: 'cloud-b',
		roles: ['ingress', 'control', 'data'],
		wgEndpoint: '203.0.113.20:51820',
	});
	const homelab = node({
		id: 'nod_home',
		privateAddress: '10.88.1.3',
		zone: 'home',
		roles: ['compute', 'data'],
		lanEndpoint: '192.168.1.20:51820',
	});
	const linux = node({
		id: 'nod_linux',
		privateAddress: '10.88.1.4',
		zone: 'home',
		roles: ['compute', 'build'],
		lanEndpoint: '192.168.1.30:51820',
	});
	const all = [edge, edgeB, homelab, linux];

	test('a spoke peers with every hub and its LAN neighbour', () => {
		const state = buildWireguardState('nod_home', all);
		expect(state).toMatchObject({ mode: 'skiff', address: '10.88.1.3', cidr: '10.88.0.0/22' });
		expect(state.peers.map((peer) => peer.nodeId).sort()).toEqual(['nod_edge', 'nod_edge_b', 'nod_linux']);
		const direct = state.peers.find((peer) => peer.nodeId === 'nod_linux')!;
		expect(direct).toMatchObject({ endpoint: '192.168.1.30:51820', allowedIps: ['10.88.1.4/32'] });
	});

	test('a hub peers with every managed node', () => {
		const state = buildWireguardState('nod_edge', all);
		expect(state.peers.map((peer) => peer.nodeId).sort()).toEqual(['nod_edge_b', 'nod_home', 'nod_linux']);
	});

	test('an external node receives no managed peers', () => {
		const external = node({ id: 'nod_byo', privateAddress: '10.0.0.5', networkMode: 'external' });
		expect(buildWireguardState('nod_byo', [...all, external]).peers).toEqual([]);
	});

	test('no peer appears twice with conflicting allowed IPs', () => {
		const state = buildWireguardState('nod_home', all);
		const allowed = state.peers.flatMap((peer) => peer.allowedIps);
		expect(new Set(allowed).size).toBe(allowed.length);
	});
});
