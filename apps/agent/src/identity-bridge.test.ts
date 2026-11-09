import { describe, expect, test } from 'bun:test';
import { identityDesiredSchema, identitySecretsSchema } from '@yoal/contracts';
import { IdentityBridge, type HelperIdentityApi } from '../src/identity-bridge.ts';

type Call = { url: string; init: RequestInit & { unix?: string } };

function desired(generation = 7) {
	return identityDesiredSchema.parse({
		generation,
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
				clients: [
					{ id: 'upc_public', clientId: 'web', name: 'Web', public: true, redirectUris: ['https://shop.example.com/cb'] },
					{ id: 'upc_secret', clientId: 'server', name: 'Server', public: false, redirectUris: ['https://shop.example.com/cb'] },
				],
			},
		],
	});
}

function secrets() {
	return identitySecretsSchema.parse({
		generation: 9,
		pools: [
			{
				id: 'shop',
				orgId: 'org_1',
				clients: [
					{ id: 'upc_public', clientId: 'web', secret: null },
					{ id: 'upc_secret', clientId: 'server', secret: 'super-secret-client-value' },
				],
				oauthProviders: [
					{ provider: 'github', clientId: 'gh', secret: 'super-secret-provider-value', scopes: [], enabled: true },
				],
			},
		],
	});
}

function health(generation: number | null, secretsGeneration: number | null) {
	return {
		ok: true,
		ready: true,
		status: 'running',
		generation,
		secretsGeneration,
		pools: 1,
		version: '1.2.3',
		lastStateAt: Date.now(),
	};
}

function fakeBridge(options: {
	calls: Call[];
	health: () => Response | null;
	helper?: Partial<HelperIdentityApi>;
	logs?: string[];
}) {
	const helper: HelperIdentityApi = {
		identityStart: async () => undefined,
		identityStop: async () => undefined,
		...(options.helper ?? {}),
	};
	const fetch = async (input: string, init: RequestInit & { unix?: string } = {}): Promise<Response> => {
		const call = { url: input, init };
		options.calls.push(call);
		if (input.includes('/api/agent/identity/secrets')) return Response.json(secrets());
		if (input.endsWith('/health')) return options.health() ?? new Response('{}', { status: 503 });
		if (input.endsWith('/state')) return Response.json(health(7, 9));
		if (input.endsWith('/secrets')) return Response.json(health(7, 9));
		return new Response('{}', { status: 404 });
	};
	const bridge = new IdentityBridge({
		socketPath: '/run/yoal/identity.sock',
		controlUrl: 'https://cloud.example.com',
		nodeToken: 'node-token',
		version: '1.2.3',
		helper,
		fetch,
		log: (level, message) => options.logs?.push(`${level}:${message}`),
		loops: false,
		secretsIntervalMs: 0,
	});
	return bridge;
}

describe('identity agent bridge', () => {
	test('pushes state and fetches secrets with the node token, never logging the values', async () => {
		const calls: Call[] = [];
		const logs: string[] = [];
		const bridge = fakeBridge({ calls, health: () => Response.json(health(0, null)), logs });

		bridge.apply(desired());
		await bridge.tick();

		const control = calls.find((call) => call.url.includes('/api/agent/identity/secrets'))!;
		expect(control).toBeDefined();
		expect((control.init.headers as Record<string, string>).authorization).toBe('Bearer node-token');

		const state = calls.find((call) => call.url.endsWith('/state'))!;
		expect(state.init.method).toBe('PUT');
		expect(JSON.parse(String(state.init.body)).generation).toBe(7);

		const pushedSecrets = calls.find(
			(call) => call.url.startsWith('http://yoal-identity') && call.url.endsWith('/secrets'),
		)!;
		expect(pushedSecrets).toBeDefined();
		expect(String(pushedSecrets.init.body)).toContain('super-secret-client-value');
		expect(logs.join('\n')).not.toContain('super-secret');
		expect(bridge.isHealthy).toBe(true);
		expect(bridge.status()).toMatchObject({ status: 'running', version: '1.2.3', pools: 1 });
	});

	test('restarts an unhealthy unit and stops it when the node is no longer assigned', async () => {
		const calls: Call[] = [];
		let starts = 0;
		let stops = 0;
		let restarts = 0;
		const bridge = fakeBridge({
			calls,
			health: () => null,
			helper: {
				identityStart: async () => {
					starts += 1;
				},
				identityStop: async () => {
					stops += 1;
				},
				identityRestart: async () => {
					restarts += 1;
				},
			},
		});
		bridge.apply(desired());
		await bridge.tick();
		await bridge.tick();
		await bridge.tick();

		expect(starts).toBe(1);
		expect(restarts).toBe(1);
		expect(bridge.status().status).toBe('starting');
		expect(bridge.isHealthy).toBe(false);

		bridge.apply(null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stops).toBe(1);
		expect(bridge.status().status).toBe('stopped');
	});

	test('pushes a new state generation without restarting the unit', async () => {
		const calls: Call[] = [];
		const bridge = fakeBridge({ calls, health: () => Response.json(health(3, 9)) });
		bridge.apply(desired(4));
		await bridge.tick();
		const pushes = calls.filter((call) => call.url.endsWith('/state'));
		expect(pushes).toHaveLength(1);
		expect(JSON.parse(String(pushes[0]!.init.body)).generation).toBe(4);
	});

	test('public clients work when the secret fetch is unavailable', async () => {
		const calls: Call[] = [];
		const bridge = new IdentityBridge({
			socketPath: '/run/yoal/identity.sock',
			helper: { identityStart: async () => undefined, identityStop: async () => undefined },
			controlUrl: 'https://cloud.example.com',
			nodeToken: 'node-token',
			fetch: async (input, init = {}) => {
				calls.push({ url: input, init });
				if (input.includes('/api/agent/identity/secrets')) return new Response('nope', { status: 500 });
				if (input.endsWith('/health')) return Response.json(health(7, null));
				return Response.json(health(7, null));
			},
			log: () => undefined,
			loops: false,
			secretsIntervalMs: 0,
		});
		bridge.apply(desired());
		await bridge.tick();
		expect(bridge.isHealthy).toBe(true);
		expect(
			calls.some(
				(call) => call.url.startsWith('http://yoal-identity') && call.url.endsWith('/secrets'),
			),
		).toBe(false);
	});
});
