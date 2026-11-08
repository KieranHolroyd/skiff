import { describe, expect, test } from 'bun:test';
import {
	SSO_PRESETS,
	SsoPresetError,
	describeSsoPresets,
	detectSsoPreset,
	resolveSsoPreset,
	ssoPreset
} from './sso-presets';

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const ENV = '0a7ab0f2-1111-4c4c-9e9e-123456789abc';

function fieldError(run: () => unknown): SsoPresetError {
	try {
		run();
	} catch (cause) {
		if (cause instanceof SsoPresetError) return cause;
		throw cause;
	}
	throw new Error('expected an SsoPresetError');
}

describe('resolveSsoPreset', () => {
	test('Entra builds the v2.0 tenant issuer from a GUID or a pasted URL', () => {
		const config = resolveSsoPreset('entra', { tenantId: TENANT.toUpperCase() });
		expect(config.issuer).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);
		expect(config.discoveryUrl).toBe(
			`https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`
		);
		expect(config.scopes).toEqual(['openid', 'profile', 'email']);
		expect(
			resolveSsoPreset('entra', {
				tenantId: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`
			}).issuer
		).toBe(config.issuer);
	});

	test('Entra refuses a tenant domain, which would never match the issued tokens', () => {
		const error = fieldError(() => resolveSsoPreset('entra', { tenantId: 'contoso.onmicrosoft.com' }));
		expect(error.field).toBe('tenantId');
		expect(fieldError(() => resolveSsoPreset('entra', {})).field).toBe('tenantId');
	});

	test('Google and JumpCloud need no values', () => {
		expect(resolveSsoPreset('google').issuer).toBe('https://accounts.google.com');
		// JumpCloud publishes its issuer with a trailing slash and tokens carry it.
		expect(resolveSsoPreset('jumpcloud').issuer).toBe('https://oauth.id.jumpcloud.com/');
	});

	test('Okta uses the org server with the groups scope, or a custom server without it', () => {
		const org = resolveSsoPreset('okta', { domain: 'https://acme-admin.okta.com/admin/dashboard' });
		expect(org.issuer).toBe('https://acme.okta.com');
		expect(org.scopes).toContain('groups');

		const custom = resolveSsoPreset('okta', { domain: 'acme.okta.com', authServer: 'default' });
		expect(custom.issuer).toBe('https://acme.okta.com/oauth2/default');
		expect(custom.scopes).not.toContain('groups');

		// A pasted custom-server issuer fills the server id.
		expect(resolveSsoPreset('okta', { domain: 'https://acme.okta.com/oauth2/aus1abc' }).issuer).toBe(
			'https://acme.okta.com/oauth2/aus1abc'
		);
		// A custom domain is accepted as is.
		expect(resolveSsoPreset('okta', { domain: 'login.acme.com' }).issuer).toBe('https://login.acme.com');
		expect(fieldError(() => resolveSsoPreset('okta', { domain: 'not a domain' })).field).toBe('domain');
		expect(
			fieldError(() => resolveSsoPreset('okta', { domain: 'acme.okta.com', authServer: 'a/b' })).field
		).toBe('authServer');
	});

	test('Auth0 keeps the trailing slash its issuer is published with', () => {
		const config = resolveSsoPreset('auth0', { domain: 'https://acme.us.auth0.com/' });
		expect(config.issuer).toBe('https://acme.us.auth0.com/');
		expect(config.discoveryUrl).toBe('https://acme.us.auth0.com/.well-known/openid-configuration');
	});

	test('OneLogin accepts a subdomain or the full host', () => {
		expect(resolveSsoPreset('onelogin', { subdomain: 'acme' }).issuer).toBe(
			'https://acme.onelogin.com/oidc/2'
		);
		expect(resolveSsoPreset('onelogin', { subdomain: 'https://ACME.onelogin.com/admin' }).issuer).toBe(
			'https://acme.onelogin.com/oidc/2'
		);
		expect(fieldError(() => resolveSsoPreset('onelogin', { subdomain: 'acme.example.com' })).field).toBe(
			'subdomain'
		);
	});

	test('PingOne combines region and environment, and a pasted URL carries its region', () => {
		expect(resolveSsoPreset('pingone', { region: 'eu', environmentId: ENV }).issuer).toBe(
			`https://auth.pingone.eu/${ENV}/as`
		);
		expect(
			resolveSsoPreset('pingone', { region: 'com', environmentId: `https://auth.pingone.ca/${ENV}/as` })
				.issuer
		).toBe(`https://auth.pingone.ca/${ENV}/as`);
		expect(resolveSsoPreset('pingone', { environmentId: ENV }).issuer).toBe(
			`https://auth.pingone.com/${ENV}/as`
		);
		expect(fieldError(() => resolveSsoPreset('pingone', { region: 'mars', environmentId: ENV })).field).toBe(
			'region'
		);
	});

	test('Keycloak builds the realm issuer and reads a pasted realm URL', () => {
		expect(resolveSsoPreset('keycloak', { serverUrl: 'sso.example.com/', realm: 'acme' }).issuer).toBe(
			'https://sso.example.com/realms/acme'
		);
		expect(
			resolveSsoPreset('keycloak', { serverUrl: 'https://sso.example.com/auth/realms/acme/account' })
				.issuer
		).toBe('https://sso.example.com/auth/realms/acme');
		expect(fieldError(() => resolveSsoPreset('keycloak', { serverUrl: 'https://sso.example.com' })).field).toBe(
			'realm'
		);
	});

	test('authentik builds the per-application issuer with its trailing slash', () => {
		const config = resolveSsoPreset('authentik', { serverUrl: 'https://auth.example.com', slug: 'skiff' });
		expect(config.issuer).toBe('https://auth.example.com/application/o/skiff/');
		expect(config.discoveryUrl).toBe(
			'https://auth.example.com/application/o/skiff/.well-known/openid-configuration'
		);
		expect(
			resolveSsoPreset('authentik', { serverUrl: 'https://auth.example.com/application/o/skiff/' }).issuer
		).toBe(config.issuer);
		expect(
			fieldError(() => resolveSsoPreset('authentik', { serverUrl: 'https://auth.example.com', slug: 'Bad Slug' }))
				.field
		).toBe('slug');
	});

	test('an unknown preset is an error, not a silent custom provider', () => {
		expect(() => resolveSsoPreset('ldap')).toThrow(SsoPresetError);
		expect(ssoPreset('custom')).toBeNull();
	});
});

describe('detectSsoPreset', () => {
	const samples: Record<string, Record<string, string>> = {
		entra: { tenantId: TENANT },
		google: {},
		okta: { domain: 'acme.okta.com', authServer: 'default' },
		auth0: { domain: 'acme.eu.auth0.com' },
		onelogin: { subdomain: 'acme' },
		jumpcloud: {},
		pingone: { region: 'com.au', environmentId: ENV },
		keycloak: { serverUrl: 'https://sso.example.com', realm: 'acme corp' },
		authentik: { serverUrl: 'https://auth.example.com/sub', slug: 'skiff' },
		gitlab: { serverUrl: 'https://gitlab.com' },
		forgejo: { serverUrl: 'https://codeberg.org' },
		gitea: { serverUrl: 'https://gitea.example.com' }
	};

	test('every preset round-trips: detecting its issuer gives values that rebuild it', () => {
		for (const preset of SSO_PRESETS) {
			const values = samples[preset.id];
			expect(values).toBeDefined();
			const { issuer } = preset.resolve(values!);
			const detected = detectSsoPreset(issuer);
			expect(detected?.preset.id).toBe(preset.id);
			expect(preset.resolve(detected!.values).issuer).toBe(issuer);
		}
	});

	test('forge issuers: GitLab without a trailing slash, Gitea and Forgejo with one; unknown hosts stay custom', () => {
		expect(ssoPreset('gitlab')!.resolve({ serverUrl: 'https://gitlab.example.com/' })).toMatchObject({
			issuer: 'https://gitlab.example.com',
			discoveryUrl: 'https://gitlab.example.com/.well-known/openid-configuration'
		});
		expect(ssoPreset('forgejo')!.resolve({ serverUrl: 'https://codeberg.org' })).toMatchObject({ issuer: 'https://codeberg.org/', scopes: ['openid', 'profile', 'email', 'groups'] });
		expect(detectSsoPreset('https://git.example.com/')).toBeNull();
		expect(detectSsoPreset('https://gitlab.com/')).toBeNull();
	});

	test('a stored Okta org issuer reopens with no authorization server', () => {
		expect(detectSsoPreset('https://acme.okta.com')?.values).toEqual({ domain: 'acme.okta.com', authServer: '' });
	});

	test('an issuer no preset knows is custom', () => {
		expect(detectSsoPreset('https://idp.example.com')).toBeNull();
		expect(detectSsoPreset('https://login.acme.com/oauth2/default')).toBeNull();
	});
});

describe('describeSsoPresets', () => {
	test('lists every preset with plain data only', () => {
		const described = describeSsoPresets();
		expect(described.map((preset) => preset.id)).toEqual(SSO_PRESETS.map((preset) => preset.id));
		expect(JSON.parse(JSON.stringify(described))).toEqual(described);
		const pingone = described.find((preset) => preset.id === 'pingone')!;
		expect(pingone.fields.find((field) => field.key === 'region')?.options).toContain('eu');
	});
});
