import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Principal } from '@skiff/contracts';

/**
 * `SsoService` provider writes with presets (IAM.md §8.3, D180), against a fake `core` holding a
 * real SQLite table and a stubbed discovery fetch. The point is what ends up stored: the issuer
 * verbatim from the IdP's discovery document (trailing slash and all), because Better Auth checks
 * ID tokens against it byte for byte.
 */

const db = new Database(':memory:');
db.run(readFileSync(new URL('../../../../../packages/db/migrations/0087_sso.sql', import.meta.url), 'utf8'));

const audits: Array<{ action: string; args: unknown }> = [];
const fakeCore = {
	ctx: {
		sqlite: db,
		now: () => 1_000,
		secrets: {
			seal: (_orgId: string, value: string) => `sealed:${value}`,
			open: (_orgId: string, value: string) => value.replace(/^sealed:/, '')
		},
		audit: { record: (entry: { action: string; args: unknown }) => audits.push(entry) }
	},
	iam: { require: () => {}, can: () => true }
};

mock.module('./core', () => ({ core: fakeCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./sso-sync', () => ({ syncSsoProviders: () => 0 }));

const { sso, reserveSsoProviderId, ssoCallbackUrl } = await import('./sso');

const principal = { orgId: 'org_1', userId: 'user_1' } as Principal;

/** Discovery documents by URL; anything else is a 404. */
const documents = new Map<string, Record<string, unknown>>();
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = String(input instanceof Request ? input.url : input);
	fetched.push(url);
	const document = documents.get(url);
	return document ? Response.json(document) : new Response('not found', { status: 404 });
}) as typeof fetch;
afterAll(() => {
	globalThis.fetch = realFetch;
});

function publish(issuer: string, discoveryUrl: string) {
	const base = issuer.replace(/\/$/, '');
	documents.set(discoveryUrl, {
		issuer,
		authorization_endpoint: `${base}/authorize`,
		token_endpoint: `${base}/oauth/token`,
		jwks_uri: `${base}/.well-known/jwks.json`
	});
}

beforeEach(() => {
	db.run('DELETE FROM sso_providers');
	documents.clear();
	fetched.length = 0;
	audits.length = 0;
});

describe('SsoService with presets', () => {
	test('an Auth0 preset stores the issuer with its trailing slash', async () => {
		publish('https://acme.us.auth0.com/', 'https://acme.us.auth0.com/.well-known/openid-configuration');
		const provider = await sso.createProvider(principal, {
			name: 'Auth0',
			preset: { id: 'auth0', values: { domain: 'acme.us.auth0.com' } },
			clientId: 'client',
			clientSecret: 'secret'
		});
		expect(provider.issuer).toBe('https://acme.us.auth0.com/');
		expect(provider.scopes).toEqual(['openid', 'profile', 'email']);
		expect(provider.tokenEndpoint).toBe('https://acme.us.auth0.com/oauth/token');
		expect(audits.at(-1)?.args).toMatchObject({ preset: 'auth0' });

		// Renaming does not re-fetch discovery, and the stored issuer keeps its slash.
		fetched.length = 0;
		const renamed = await sso.updateProvider(principal, provider.id, { name: 'Acme Auth0' });
		expect(fetched).toEqual([]);
		expect(renamed.issuer).toBe('https://acme.us.auth0.com/');

		// Saving again through the same preset is not an issuer change either.
		const resaved = await sso.updateProvider(principal, provider.id, {
			preset: { id: 'auth0', values: { domain: 'acme.us.auth0.com' } }
		});
		expect(fetched).toEqual([]);
		expect(resaved.issuer).toBe('https://acme.us.auth0.com/');
	});

	test('a preset supplies Okta scopes, and explicit scopes and claims win', async () => {
		publish('https://acme.okta.com', 'https://acme.okta.com/.well-known/openid-configuration');
		const provider = await sso.createProvider(principal, {
			name: 'Okta',
			preset: { id: 'okta', values: { domain: 'acme-admin.okta.com' } },
			clientId: 'client',
			clientSecret: 'secret'
		});
		expect(provider.issuer).toBe('https://acme.okta.com');
		expect(provider.scopes).toEqual(['openid', 'profile', 'email', 'groups']);

		const edited = await sso.updateProvider(principal, provider.id, {
			preset: { id: 'okta', values: { domain: 'acme.okta.com' } },
			scopes: ['openid', 'email'],
			claims: { groups: 'roles' }
		});
		expect(edited.scopes).toEqual(['openid', 'email']);
		expect(edited.claims).toEqual({ email: 'email', name: 'name', groups: 'roles' });
	});

	test('a reserved id keeps the redirect URI shown before the provider existed', async () => {
		publish('https://accounts.google.com', 'https://accounts.google.com/.well-known/openid-configuration');
		const reserved = reserveSsoProviderId();
		const provider = await sso.createProvider(
			principal,
			{ name: 'Google', preset: { id: 'google' }, clientId: 'client', clientSecret: 'secret' },
			reserved
		);
		expect(provider.id).toBe(reserved);
		expect(provider.callbackUrl).toBe(ssoCallbackUrl(reserved));
		expect(provider.callbackUrl).toBe(`https://control.test/api/auth/sso/callback/${reserved}`);
	});

	test('a malformed reserved id is refused', async () => {
		await expect(
			sso.createProvider(
				principal,
				{ name: 'Google', preset: { id: 'google' }, clientId: 'client', clientSecret: 'secret' },
				'sso_../../other'
			)
		).rejects.toThrow('reserved provider id');
	});

	test('a bad preset value is a validation error before anything is fetched', async () => {
		await expect(
			sso.createProvider(principal, {
				name: 'Entra',
				preset: { id: 'entra', values: { tenantId: 'contoso.onmicrosoft.com' } },
				clientId: 'client',
				clientSecret: 'secret'
			})
		).rejects.toThrow('tenant ID');
		expect(fetched).toEqual([]);
	});

	test('a discovery document for another issuer is still refused', async () => {
		documents.set('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/.well-known/openid-configuration', {
			issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
			authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
			token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
		});
		await expect(
			sso.createProvider(principal, {
				name: 'Entra',
				preset: { id: 'entra', values: { tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47' } },
				clientId: 'client',
				clientSecret: 'secret'
			})
		).rejects.toThrow('names the issuer');
	});

	test('a custom provider still needs an issuer', async () => {
		await expect(
			sso.createProvider(principal, { name: 'Custom', clientId: 'client', clientSecret: 'secret' })
		).rejects.toThrow('issuer is required');
	});
});
