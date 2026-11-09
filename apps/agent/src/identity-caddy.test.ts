import { describe, expect, test } from 'bun:test';
import { desiredStateSchema } from '@yoal/contracts';
import { buildCaddyConfig, compileIdentityIssuerRoutes } from './caddy-config.ts';

type Json = Record<string, unknown>;

function state(identity: unknown) {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'node_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-09T00:00:00Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		platformOrigin: 'https://cloud.example.com',
		identity,
	});
}

function compile(identity: unknown) {
	return buildCaddyConfig({
		state: state(identity),
		listen: [':443'],
		dataDir: '/data',
		agentSocket: '/run/yoal-agent/agent.sock',
		caddyAdminSocket: '/var/lib/caddy/admin.sock',
		platform: { host: 'cloud.example.com', upstream: '127.0.0.1:3000' },
	});
}

function routes(config: Json): Json[] {
	const apps = config.apps as Json;
	const http = apps.http as Json;
	const servers = http.servers as Json;
	return (servers.content as Json).routes as Json[];
}

const identity = {
	generation: 42,
	host: 'auth.example.com',
	upstream: '127.0.0.1:8788',
	pools: [
		{
			id: 'shop',
			orgId: 'org_1',
			host: 'auth.example.com',
			issuer: 'https://auth.example.com/shop',
			name: 'Shop',
			signupMode: 'open',
			requireEmailVerification: true,
			mfaRequired: false,
			theme: {},
			clients: [{ id: 'upc_1', clientId: 'client_1', name: 'Web', public: true, redirectUris: ['https://shop.example.com/cb'] }],
		},
	],
};

describe('identity issuer routing (IAM.md §11.2)', () => {
	test('assigns only the listed pool paths to the identity process', () => {
		const compiled = routes(compile(identity));
		const route = compiled[0]!;
		expect(route['@id']).toBe('identity:shop');
		const match = (route.match as Json[])[0]!;
		expect(match.host).toEqual(['auth.example.com']);
		expect((match.path_regexp as Json).pattern).toBe('^(?:pool/)?shop(/|$)');
		const proxy = (route.handle as Json[]).find((handler) => handler.handler === 'reverse_proxy')!;
		expect(proxy.upstreams).toEqual([{ dial: '127.0.0.1:8788' }]);
	});

	test('routes the engine social callback path to the identity process too', () => {
		const compiled = routes(compile(identity));
		const callback = compiled.find((route) => route['@id'] === 'identity:shop:callback')!;
		expect(callback).toBeDefined();
		const match = (callback.match as Json[])[0]!;
		expect((match.path_regexp as Json).pattern).toBe('^/api/v1/user-pools/shop/oauth/callback/');
		const proxy = (callback.handle as Json[]).find((handler) => handler.handler === 'reverse_proxy')!;
		expect(proxy.upstreams).toEqual([{ dial: '127.0.0.1:8788' }]);
	});

	test('keeps the control-plane fallback for unassigned pools', () => {
		const compiled = routes(compile(identity));
		const fallback = compiled.find((route) => route['@id'] === 'user-pool:discovery')!;
		expect(fallback).toBeDefined();
		// The assigned pool route is earlier than the fallback, so it wins for `shop`.
		const identityIndex = compiled.findIndex((route) => route['@id'] === 'identity:shop');
		const fallbackIndex = compiled.findIndex((route) => route['@id'] === 'user-pool:discovery');
		expect(identityIndex).toBeLessThan(fallbackIndex);
	});

	test('without desired identity the fallback is unchanged (dev path)', () => {
		const compiled = routes(compile(null));
		expect(compiled.some((route) => String(route['@id']).startsWith('identity:'))).toBe(false);
		expect(compiled.some((route) => route['@id'] === 'user-pool:discovery')).toBe(true);
	});

	test('compiles nothing for an empty assignment', () => {
		expect(compileIdentityIssuerRoutes({ ...identity, pools: [] })).toEqual([]);
	});
});
