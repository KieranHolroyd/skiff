import { describe, expect, test } from 'bun:test';
import {
	identityDesiredSchema,
	identityHost,
	selectIdentityNode,
} from './identity.ts';

describe('identity placement and projection', () => {
	test('prefers a configured capable node, then the edge, then the first id', () => {
		expect(selectIdentityNode(['b', 'a'], 'b', 'a')).toBe('b');
		expect(selectIdentityNode(['b', 'a'], 'missing', 'a')).toBe('a');
		expect(selectIdentityNode(['b', 'a'], null, null)).toBe('a');
		expect(selectIdentityNode(['b', 'a'], 'missing', 'missing')).toBe('a');
		expect(selectIdentityNode([], 'b', 'a')).toBeNull();
	});

	test('derives the issuer host from the content domain', () => {
		expect(identityHost('example.com')).toBe('auth.example.com');
		expect(identityHost('https://example.com/')).toBeNull();
		expect(identityHost('localhost')).toBe('auth.localhost');
	});

	test('accepts a projection with no secrets and rejects unknown fields', () => {
		const parsed = identityDesiredSchema.parse({
			generation: 1,
			host: 'auth.example.com',
			upstream: '127.0.0.1:8788',
			pools: [
				{
					id: 'shop',
					orgId: 'org_1',
					host: 'auth.example.com',
					issuer: 'https://auth.example.com/shop',
					name: 'Shop',
					signupMode: 'invite',
					clients: [{ id: 'upc_1', clientId: 'client_1', name: 'Web', public: true, redirectUris: [] }],
				},
			],
		});
		expect(parsed.pools[0]!.clients[0]!.public).toBe(true);
		expect(
			identityDesiredSchema.safeParse({
				generation: 1,
				host: 'auth.example.com',
				upstream: '127.0.0.1:8788',
				pools: [],
				clientSecret: 'nope',
			}).success,
		).toBe(false);
	});
});
