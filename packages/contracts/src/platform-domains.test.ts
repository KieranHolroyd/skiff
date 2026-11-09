import { describe, expect, test } from 'bun:test';
import { parsePlatformConfigRequest } from './platform-config.ts';
import {
	applyEnvChanges,
	cloudflareTokenCreateUrl,
	controlPlaneEnvChanges,
	domainSettingsFromEnv,
	edgeAgentEnvChanges,
	isDomainName,
	isIpv4,
	isTemporaryContentDomain,
	platformOriginFor,
	temporaryContentDomain,
	validateDomainSettings,
} from './platform-domains.ts';

const https = { platformHost: 'control.example.com', contentDomain: 'example.dev', tls: true, acmeEmail: 'ops@example.com' };
const ipOnly = { platformHost: '203.0.113.7', contentDomain: '203-0-113-7.sslip.io', tls: false, acmeEmail: '' };

describe('addresses', () => {
	test('IPv4 and domain names are told apart', () => {
		expect(isIpv4('203.0.113.7')).toBe(true);
		expect(isIpv4('256.1.1.1')).toBe(false);
		expect(isIpv4('1.2.3')).toBe(false);
		expect(isDomainName('control.example.com')).toBe(true);
		expect(isDomainName('203.0.113.7')).toBe(false);
		expect(isDomainName('localhost')).toBe(false);
		expect(isDomainName('Example.com')).toBe(false); // callers lower-case first
		expect(isDomainName('a..b.com')).toBe(false);
	});

	test('the temporary content domain is the IP with dashes under sslip.io', () => {
		expect(temporaryContentDomain('203.0.113.7')).toBe('203-0-113-7.sslip.io');
		expect(isTemporaryContentDomain('203-0-113-7.sslip.io')).toBe(true);
		expect(isTemporaryContentDomain('example.dev')).toBe(false);
		expect(() => temporaryContentDomain('example.com')).toThrow();
	});
});

describe('validateDomainSettings', () => {
	test('accepts an IP-only HTTP install and an HTTPS install with domains', () => {
		expect(validateDomainSettings(ipOnly, false)).toEqual({ ok: true, value: ipOnly });
		expect(validateDomainSettings(https, true)).toEqual({ ok: true, value: https });
	});

	test('normalises case, whitespace and a trailing dot; drops the ACME email without HTTPS', () => {
		expect(
			validateDomainSettings({ platformHost: ' Control.Example.com. ', contentDomain: 'EXAMPLE.dev', tls: false, acmeEmail: 'x@y.z' }, false),
		).toEqual({ ok: true, value: { platformHost: 'control.example.com', contentDomain: 'example.dev', tls: false, acmeEmail: '' } });
	});

	test('names the field that is wrong', () => {
		const field = (raw: Record<string, unknown>, token = true) => {
			const result = validateDomainSettings({ ...https, ...raw }, token);
			return result.ok ? null : result.field;
		};
		expect(field({ platformHost: '' })).toBe('platformHost');
		expect(field({ platformHost: 'https://control.example.com' })).toBe('platformHost');
		expect(field({ platformHost: '203.0.113.7:8080' })).toBe('platformHost');
		expect(field({ contentDomain: '203.0.113.7' })).toBe('contentDomain');
		expect(field({ contentDomain: 'control.example.com' })).toBe('contentDomain');
		expect(field({ platformHost: '203.0.113.7' })).toBe('tls');
		expect(field({ contentDomain: '203-0-113-7.sslip.io' })).toBe('tls');
		expect(field({ acmeEmail: 'nope' })).toBe('acmeEmail');
		expect(field({}, false)).toBe('cloudflareToken');
	});
});

describe('env changes', () => {
	test('HTTPS writes https origins, the ACME email and the token on both files', () => {
		expect(controlPlaneEnvChanges(https, '/etc/yoal/cloudflare.token')).toEqual({
			YOAL_PLATFORM_ORIGIN: 'https://control.example.com',
			YOAL_CONTENT_DOMAIN: 'example.dev',
			YOAL_ACME_EMAIL: 'ops@example.com',
			YOAL_CLOUDFLARE_TOKEN_FILE: '/etc/yoal/cloudflare.token',
		});
		expect(edgeAgentEnvChanges(https, '/etc/yoal/cloudflare.token')).toMatchObject({
			YOAL_CONTROL_URL: 'https://control.example.com',
			YOAL_CONTROL_SOCKET: '/run/yoal/control.sock',
			YOAL_PLATFORM_HOST: 'control.example.com',
			YOAL_TLS: '1',
			YOAL_CLOUDFLARE_API_TOKEN_FILE: '/etc/yoal/cloudflare.token',
		});
	});

	test('HTTP removes the ACME email and the agent token, and turns TLS off', () => {
		const agent = edgeAgentEnvChanges(ipOnly, '/etc/yoal/cloudflare.token');
		expect(agent).toMatchObject({ YOAL_CONTROL_URL: 'http://203.0.113.7', YOAL_TLS: '0', YOAL_ACME_EMAIL: null, YOAL_CLOUDFLARE_API_TOKEN_FILE: null });
		const env = new Map([
			['YOAL_ACME_EMAIL', 'old@example.com'],
			['YOAL_TLS', '1'],
			['YOAL_NODE_TOKEN', 'kept'],
		]);
		const changed = applyEnvChanges(env, agent);
		expect(env.has('YOAL_ACME_EMAIL')).toBe(false);
		expect(env.get('YOAL_TLS')).toBe('0');
		expect(env.get('YOAL_NODE_TOKEN')).toBe('kept');
		expect(changed).toContain('YOAL_ACME_EMAIL');
		expect(applyEnvChanges(env, agent)).toEqual([]);
	});

	test('settings round-trip through the control-plane env', () => {
		const env = new Map<string, string>();
		applyEnvChanges(env, controlPlaneEnvChanges(https, null));
		expect(domainSettingsFromEnv(env)).toEqual(https);
		expect(platformOriginFor(ipOnly)).toBe('http://203.0.113.7');
	});
});

describe('the domains request', () => {
	const base = { id: 'req_12345678', requestedAt: new Date().toISOString(), by: 'user_1', action: 'domains' };

	test('parses and normalises', () => {
		const parsed = parsePlatformConfigRequest({ ...base, ...ipOnly, platformHost: '203.0.113.7 ' });
		expect(parsed).toMatchObject({ ok: true, request: { action: 'domains', platformHost: '203.0.113.7', tls: false } });
	});

	test('rejects invalid settings and malformed tokens', () => {
		expect(parsePlatformConfigRequest({ ...base, ...https, platformHost: '203.0.113.7' })).toMatchObject({ ok: false });
		expect(parsePlatformConfigRequest({ ...base, ...https, cloudflareToken: 'has spaces in it, sadly' })).toMatchObject({
			ok: false,
			error: 'cloudflareToken is not a valid token',
		});
		const withToken = parsePlatformConfigRequest({ ...base, ...https, cloudflareToken: 'a'.repeat(40) });
		expect(withToken).toMatchObject({ ok: true, request: { cloudflareToken: 'a'.repeat(40) } });
	});
});

describe('cloudflareTokenCreateUrl', () => {
	test('pre-fills zone read and DNS edit on the user token form', () => {
		const url = new URL(cloudflareTokenCreateUrl({ name: 'Yoal DNS (example.dev)' }));
		expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
		expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
			{ key: 'zone', type: 'read' },
			{ key: 'dns', type: 'edit' },
		]);
		expect(url.searchParams.get('accountId')).toBe('*');
		expect(url.searchParams.get('zoneId')).toBe('all');
		expect(url.searchParams.get('name')).toBe('Yoal DNS (example.dev)');
	});

	test('permissions and name are configurable', () => {
		const url = new URL(cloudflareTokenCreateUrl({ permissions: [{ key: 'dns', type: 'read' }] }));
		expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([{ key: 'dns', type: 'read' }]);
		expect(url.searchParams.get('name')).toBe('Yoal DNS');
	});
});
