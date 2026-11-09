import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Core } from '@yoal/core';
import { createIdentityHandler } from '../src/server.ts';
import { applyIdentityDesired } from '../src/state.ts';
import { identityDesiredSchema } from '@yoal/contracts';

function db(): Database {
	const sqlite = new Database(':memory:');
	sqlite.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
	sqlite.run(`CREATE TABLE identity_pools (pool_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, host TEXT NOT NULL, issuer TEXT NOT NULL, generation INTEGER NOT NULL, synced_at INTEGER NOT NULL)`);
	sqlite.run(`CREATE TABLE user_pools (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL, issuer TEXT NOT NULL, signing_key_id TEXT, signup_mode TEXT NOT NULL, theme_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disabled_at INTEGER)`);
	sqlite.run(`CREATE TABLE user_pool_clients (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, name TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_sealed TEXT, redirect_uris_json TEXT NOT NULL DEFAULT '[]', public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
	applyIdentityDesired(
		sqlite,
		identityDesiredSchema.parse({
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
				},
			],
		}),
	);
	return sqlite;
}

/** Health and metrics do not touch the engine; the page routes are covered by their own tests. */
const core = {} as Core;

describe('identity health and metrics surface', () => {
	test('GET /health reports pool count, last state and readiness', async () => {
		const handler = createIdentityHandler({ core, sqlite: db(), secureCookies: false, version: '1.2.3' });
		const response = await handler(new Request('http://auth.example.com/health'));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			ready: true,
			status: 'running',
			generation: 42,
			pools: 1,
			version: '1.2.3',
		});
		expect(body.lastStateAt).toBeNumber();
	});

	test('GET /readyz is a cheap readiness probe and /metrics is Prometheus text', async () => {
		const handler = createIdentityHandler({ core, sqlite: db(), secureCookies: false, version: '1.2.3' });
		const ready = await handler(new Request('http://auth.example.com/readyz'));
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ ready: true, version: '1.2.3' });

		await handler(new Request('http://auth.example.com/health'));
		const metrics = await handler(new Request('http://auth.example.com/metrics'));
		expect(metrics.headers.get('content-type')).toContain('text/plain');
		const text = await metrics.text();
		expect(text).toContain('yoal_identity_ready 1');
		expect(text).toContain('yoal_identity_pools 1');
		expect(text).toContain('yoal_identity_generation 42');
		expect(text).toContain('yoal_identity_requests_total{route="health",status="200"} 1');
	});
});
