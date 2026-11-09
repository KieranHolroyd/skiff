import { describe, expect, test } from 'bun:test';
import {
	SSO_RECHECK_MS,
	SSO_VERIFY_PREFIX,
	emailDomain,
	groupClaimValues,
	groupIdsForClaims,
	hasSsoVerificationRecord,
	isAllowedSsoUrl,
	isSsoProtocol,
	normalizeGroupClaim,
	normalizeSamlCertificate,
	normalizeSsoDomain,
	ssoDomainCheckDue,
	ssoProviderFieldErrors,
	ssoSamlAcsUrl,
	ssoSamlMetadataUrl,
	ssoVerificationRecord,
	verifiedDomainForEmail
} from './sso.ts';

describe('normalizeSsoDomain', () => {
	test('lowercases, trims and drops a trailing dot', () => {
		expect(normalizeSsoDomain('  Example.COM. ')).toBe('example.com');
	});

	test('accepts a delegated subdomain and an international-looking TLD', () => {
		expect(normalizeSsoDomain('login.eu.example.co.uk')).toBe('login.eu.example.co.uk');
	});

	test('rejects schemes, paths, ports, emails and wildcards', () => {
		for (const value of [
			'https://example.com',
			'example.com/login',
			'example.com:443',
			'user@example.com',
			'*.example.com',
			'localhost',
			'127.0.0.1',
			''
		])
			expect(normalizeSsoDomain(value)).toBeNull();
	});
});

describe('emailDomain', () => {
	test('returns the lowercased domain', () => {
		expect(emailDomain('Ada@Example.COM')).toBe('example.com');
	});

	test('handles a plus address and the last at-sign only', () => {
		expect(emailDomain('ada+skiff@mail.example.com')).toBe('mail.example.com');
	});

	test('rejects anything without exactly one local part and domain', () => {
		for (const value of ['', 'ada', '@example.com', 'ada@', 'a@b@example.com', 'ada@localhost'])
			expect(emailDomain(value)).toBeNull();
	});
});

describe('verifiedDomainForEmail', () => {
	const domains = [
		{ domain: 'example.com', verifiedAt: null },
		{ domain: 'mail.example.com', verifiedAt: 1 }
	];

	test('only a verified row routes', () => {
		expect(verifiedDomainForEmail('ada@example.com', domains)).toBeNull();
		expect(verifiedDomainForEmail('ada@mail.example.com', domains)).toEqual(domains[1]!);
	});

	test('matching is exact, never a suffix', () => {
		expect(verifiedDomainForEmail('ada@sub.mail.example.com', domains)).toBeNull();
		expect(verifiedDomainForEmail('ada@evil-example.com', domains)).toBeNull();
	});

	test('a bad address routes nowhere', () => {
		expect(verifiedDomainForEmail('ada', domains)).toBeNull();
	});
});

describe('verification record', () => {
	test('uses the skiff-verify prefix', () => {
		expect(SSO_VERIFY_PREFIX).toBe('skiff-verify=');
		expect(ssoVerificationRecord('  abc123 ')).toBe('skiff-verify=abc123');
	});

	test('joins a record split into character-strings', () => {
		expect(hasSsoVerificationRecord([['skiff-verify=', 'abc123']], 'abc123')).toBe(true);
	});

	test('ignores other TXT records and other tokens', () => {
		expect(
			hasSsoVerificationRecord(
				[['v=spf1 -all'], ['skiff-verify=other'], ['not-skiff-verify=abc123']],
				'abc123'
			)
		).toBe(false);
		expect(hasSsoVerificationRecord([], 'abc123')).toBe(false);
	});
});

describe('ssoDomainCheckDue', () => {
	test('a never-checked row is due', () => {
		expect(ssoDomainCheckDue(null, 0)).toBe(true);
	});

	test('a row is due a day after its check', () => {
		const now = 100 * SSO_RECHECK_MS;
		expect(ssoDomainCheckDue(now - SSO_RECHECK_MS + 1, now)).toBe(false);
		expect(ssoDomainCheckDue(now - SSO_RECHECK_MS, now)).toBe(true);
	});
});

describe('normalizeGroupClaim', () => {
	test('trims and lowercases so an IdP casing change does not break the mapping', () => {
		expect(normalizeGroupClaim('  Engineering ')).toBe('engineering');
	});

	test('rejects empty and over-long claims', () => {
		expect(normalizeGroupClaim('   ')).toBeNull();
		expect(normalizeGroupClaim('x'.repeat(201))).toBeNull();
	});
});

describe('groupClaimValues', () => {
	test('accepts the array shape most OIDC providers use, case-insensitively', () => {
		expect(groupClaimValues(['Engineering', 'Platform', 'engineering'])).toEqual([
			'engineering',
			'platform'
		]);
	});

	test('accepts comma, newline and JSON-array strings', () => {
		expect(groupClaimValues('Engineering, Platform\nFinance')).toEqual([
			'engineering',
			'platform',
			'finance'
		]);
		expect(groupClaimValues('["Engineering","Platform"]')).toEqual(['engineering', 'platform']);
	});

	test('a missing claim stays undefined, an empty one is an empty list', () => {
		expect(groupClaimValues(undefined)).toBeUndefined();
		expect(groupClaimValues(null)).toBeUndefined();
		expect(groupClaimValues('  ')).toEqual([]);
		expect(groupClaimValues([])).toEqual([]);
	});

	test('ignores non-string entries and over-long values', () => {
		expect(groupClaimValues(['Engineering', 3, null, 'x'.repeat(201)])).toEqual(['engineering']);
	});
});

describe('groupIdsForClaims', () => {
	const mappings = [
		{ claimValue: 'Engineering', groupId: 'grp_eng' },
		{ claimValue: 'platform', groupId: 'grp_platform' },
		{ claimValue: 'finance', groupId: 'grp_fin' },
		{ claimValue: 'engineering', groupId: 'grp_eng' }
	];

	test('maps known claims to unique Skiff group ids', () => {
		expect(groupIdsForClaims(['engineering', 'Platform'], mappings)).toEqual([
			'grp_eng',
			'grp_platform'
		]);
	});

	test('an unmapped claim grants nothing', () => {
		expect(groupIdsForClaims(['sales'], mappings)).toEqual([]);
		expect(groupIdsForClaims(undefined, mappings)).toEqual([]);
		expect(groupIdsForClaims([], mappings)).toEqual([]);
	});
});

// ---------------------------------------------------------------- SAML providers (I19, §8.3)

describe('isSsoProtocol', () => {
	test('accepts exactly oidc and saml', () => {
		expect(isSsoProtocol('oidc')).toBe(true);
		expect(isSsoProtocol('saml')).toBe(true);
		expect(isSsoProtocol('OIDC')).toBe(false);
		expect(isSsoProtocol('')).toBe(false);
		expect(isSsoProtocol(undefined)).toBe(false);
	});
});

describe('SAML URLs', () => {
	test('ACS and metadata URLs are derived from the provider id', () => {
		expect(ssoSamlAcsUrl('https://control.example.com', 'sso_abc123')).toBe(
			'https://control.example.com/api/auth/sso/saml2/sp/acs/sso_abc123'
		);
		expect(ssoSamlMetadataUrl('https://control.example.com', 'sso_abc123')).toBe(
			'https://control.example.com/api/auth/sso/saml2/sp/metadata?providerId=sso_abc123'
		);
	});

	test('a trailing slash and an unsafe id are handled', () => {
		expect(ssoSamlAcsUrl('https://control.example.com/', 'sso_a b')).toBe(
			'https://control.example.com/api/auth/sso/saml2/sp/acs/sso_a%20b'
		);
		expect(ssoSamlMetadataUrl('http://localhost:3000/', 'sso_abc')).toBe(
			'http://localhost:3000/api/auth/sso/saml2/sp/metadata?providerId=sso_abc'
		);
	});
});

describe('isAllowedSsoUrl', () => {
	test('allows https and loopback http only', () => {
		expect(isAllowedSsoUrl('https://idp.example.com/sso')).toBe(true);
		expect(isAllowedSsoUrl('http://localhost:8080/sso')).toBe(true);
		expect(isAllowedSsoUrl('http://127.0.0.1/sso')).toBe(true);
		expect(isAllowedSsoUrl('http://idp.example.com/sso')).toBe(false);
		expect(isAllowedSsoUrl('urn:example:idp')).toBe(false);
		expect(isAllowedSsoUrl('not a url')).toBe(false);
	});
});

describe('normalizeSamlCertificate', () => {
	const body = 'A'.repeat(120);

	test('accepts a bare base64 body and returns a wrapped PEM block', () => {
		const pem = normalizeSamlCertificate(body);
		expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
		expect(pem).toContain(body.slice(0, 64));
		expect(pem).toMatch(/\n-----END CERTIFICATE-----$/);
	});

	test('normalises an existing PEM block, whitespace and all', () => {
		const pem = `  -----BEGIN CERTIFICATE-----\n${body.slice(0, 60)}\n${body.slice(60)}\n-----END CERTIFICATE-----  `;
		expect(normalizeSamlCertificate(pem)).toBe(normalizeSamlCertificate(body));
	});

	test('refuses a private key, a fingerprint and an empty value', () => {
		expect(normalizeSamlCertificate('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toBeNull();
		expect(normalizeSamlCertificate('sha256:AB:CD:EF')).toBeNull();
		expect(normalizeSamlCertificate('')).toBeNull();
		expect(normalizeSamlCertificate(undefined)).toBeNull();
		expect(normalizeSamlCertificate('abc')).toBeNull();
	});
});

describe('ssoProviderFieldErrors', () => {
	const cert = 'A'.repeat(120);

	test('defaults to OIDC and asks for issuer, client id and (on create) a secret', () => {
		const errors = ssoProviderFieldErrors({ name: 'Okta' }, { requireSecret: true });
		expect(errors.issuer).toMatch(/issuer is required/);
		expect(errors.clientId).toMatch(/client id is required/);
		expect(errors.clientSecret).toMatch(/client secret is required/);
	});

	test('an OIDC preset supplies the issuer, but a client id is still required', () => {
		const errors = ssoProviderFieldErrors(
			{ name: 'Okta', preset: { id: 'okta' }, clientId: 'client', clientSecret: 'secret' },
			{ requireSecret: true }
		);
		expect(errors).toEqual({});
	});

	test('SAML manual entry needs an entity id, entry point and certificate', () => {
		const errors = ssoProviderFieldErrors({ name: 'Okta SAML', protocol: 'saml' });
		expect(errors.issuer).toMatch(/entity id/);
		expect(errors.entryPoint).toMatch(/entry point/);
		expect(errors.cert).toMatch(/certificate is required/);
	});

	test('SAML with a metadata URL needs no manual fields', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			protocol: 'saml',
			saml: { metadataUrl: 'https://idp.example.com/metadata' }
		});
		expect(errors).toEqual({});
	});

	test('SAML refuses plain http, a bad certificate and an over-long audience', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			protocol: 'saml',
			saml: {
				entityId: 'http://www.okta.com/exk123',
				entryPoint: 'http://idp.example.com/sso',
				cert: 'not a certificate',
				audience: 'a'.repeat(501)
			}
		});
		expect(errors.entryPoint).toMatch(/https/);
		expect(errors.cert).toMatch(/PEM or base64/);
		expect(errors.audience).toMatch(/too long/);
	});

	test('SAML ignores OIDC client fields', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			protocol: 'saml',
			issuer: 'http://www.okta.com/exk123',
			clientId: '',
			clientSecret: '',
			saml: { entryPoint: 'https://idp.example.com/sso', cert }
		});
		expect(errors).toEqual({});
	});

	test('an unknown protocol is refused before anything else', () => {
		expect(ssoProviderFieldErrors({ name: 'X', protocol: 'ldap' })).toEqual({
			protocol: 'Choose either OIDC or SAML.'
		});
	});

	test('the name is required and bounded', () => {
		expect(ssoProviderFieldErrors({ protocol: 'saml' }).name).toMatch(/name/);
		expect(
			ssoProviderFieldErrors({ name: 'x'.repeat(81), protocol: 'saml' }).name
		).toMatch(/under 80/);
	});
});
