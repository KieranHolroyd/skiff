import { describe, expect, test } from 'bun:test';
import {
	SSO_RECHECK_MS,
	SSO_SAML_SLO_BINDINGS,
	SSO_VERIFY_PREFIX,
	emailDomain,
	groupClaimValues,
	groupIdsForClaims,
	hasSsoVerificationRecord,
	isAllowedSsoUrl,
	isSsoProtocol,
	isSsoSamlSloBinding,
	normalizeGroupClaim,
	normalizeSamlCertificates,
	normalizeSamlCertificate,
	normalizeSsoDomain,
	normalizeSsoSloUrl,
	ssoDomainCheckDue,
	ssoProviderFieldErrors,
	ssoSamlAcsUrl,
	ssoSamlMetadataUrl,
	ssoSamlSloBindingForRequest,
	ssoSamlSloBindingUri,
	ssoSamlSloUrl,
	ssoSamlSpMetadataXml,
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

describe('normalizeSamlCertificates', () => {
	const first = 'A'.repeat(120);
	const second = 'B'.repeat(120);

	test('accepts a single bare base64 body', () => {
		const certs = normalizeSamlCertificates(first);
		expect(certs).toHaveLength(1);
		expect(certs[0]).toBe(normalizeSamlCertificate(first)!);
	});

	test('accepts an array and de-duplicates repeated certificates', () => {
		const certs = normalizeSamlCertificates([first, second, first]);
		expect(certs).toHaveLength(2);
		expect(certs[0]).toBe(normalizeSamlCertificate(first)!);
		expect(certs[1]).toBe(normalizeSamlCertificate(second)!);
	});

	test('reads several PEM blocks from one field', () => {
		const certs = normalizeSamlCertificates(
			`${normalizeSamlCertificate(first)}\n\n${normalizeSamlCertificate(second)}`
		);
		expect(certs).toHaveLength(2);
	});

	test('reads comma-separated and one-line newline-separated bare values', () => {
		expect(normalizeSamlCertificates(`${first},${second}`)).toHaveLength(2);
		expect(normalizeSamlCertificates(`${first}\n${second}`)).toHaveLength(2);
	});

	test('keeps the valid certificates and drops junk', () => {
		const certs = normalizeSamlCertificates([first, 'sha256:AB:CD', 'not a cert']);
		expect(certs).toHaveLength(1);
		expect(certs[0]).toBe(normalizeSamlCertificate(first)!);
	});

	test('an empty or missing value is an empty list', () => {
		expect(normalizeSamlCertificates('')).toEqual([]);
		expect(normalizeSamlCertificates(undefined)).toEqual([]);
		expect(normalizeSamlCertificates(null)).toEqual([]);
		expect(normalizeSamlCertificates([])).toEqual([]);
	});
});

describe('SAML single logout', () => {
	test('only redirect and post are bindings', () => {
		expect(SSO_SAML_SLO_BINDINGS).toEqual(['redirect', 'post']);
		expect(isSsoSamlSloBinding('redirect')).toBe(true);
		expect(isSsoSamlSloBinding('post')).toBe(true);
		expect(isSsoSamlSloBinding('GET')).toBe(false);
		expect(isSsoSamlSloBinding(undefined)).toBe(false);
	});

	test('maps a binding to its SAML URI', () => {
		expect(ssoSamlSloBindingUri('redirect')).toBe(
			'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
		);
		expect(ssoSamlSloBindingUri('post')).toBe(
			'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
		);
	});

	test('normalises an https SLO URL and strips a fragment', () => {
		expect(normalizeSsoSloUrl('  https://idp.example.com/slo  ')).toBe(
			'https://idp.example.com/slo'
		);
		expect(normalizeSsoSloUrl('https://idp.example.com/slo#fragment')).toBe(
			'https://idp.example.com/slo'
		);
		expect(normalizeSsoSloUrl('https://idp.example.com')).toBe('https://idp.example.com/');
	});

	test('allows loopback http only, like every other SSO URL', () => {
		expect(normalizeSsoSloUrl('http://localhost:8080/slo')).toBe('http://localhost:8080/slo');
		expect(normalizeSsoSloUrl('http://idp.example.com/slo')).toBeNull();
	});

	test('refuses an empty, malformed or over-long URL', () => {
		expect(normalizeSsoSloUrl('')).toBeNull();
		expect(normalizeSsoSloUrl(undefined)).toBeNull();
		expect(normalizeSsoSloUrl('not a url')).toBeNull();
		expect(normalizeSsoSloUrl(`https://example.com/${'a'.repeat(501)}`)).toBeNull();
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
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: { metadataUrl: 'https://idp.example.com/metadata' }
		});
		expect(errors).toEqual({});
	});

	test('SAML refuses plain http, a bad certificate and an over-long audience', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
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
			issuer: 'http://www.okta.com/exk123',
			protocol: 'saml',
			clientId: '',
			clientSecret: '',
			saml: { entryPoint: 'https://idp.example.com/sso', cert }
		});
		expect(errors).toEqual({});
	});

	test('SAML accepts a secondary certificate for a rollover', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: {
				entryPoint: 'https://idp.example.com/sso',
				cert,
				secondaryCerts: 'B'.repeat(120)
			}
		});
		expect(errors).toEqual({});
	});

	test('SAML accepts a certificate list instead of a single cert', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: { entryPoint: 'https://idp.example.com/sso', certs: [cert, 'B'.repeat(120)] }
		});
		expect(errors).toEqual({});
	});

	test('SAML refuses a secondary value that is not a certificate', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: {
				entryPoint: 'https://idp.example.com/sso',
				cert,
				secondaryCerts: 'sha256:AB:CD:EF'
			}
		});
		expect(errors.secondaryCerts).toMatch(/additional/);
	});

	test('SAML accepts a valid SLO URL and binding', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: {
				entryPoint: 'https://idp.example.com/sso',
				cert,
				sloUrl: 'https://idp.example.com/slo',
				sloBinding: 'post'
			}
		});
		expect(errors).toEqual({});
	});

	test('SAML refuses a plain-http SLO URL and an unknown binding', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: {
				entryPoint: 'https://idp.example.com/sso',
				cert,
				sloUrl: 'http://idp.example.com/slo',
				sloBinding: 'artifact'
			}
		});
		expect(errors.sloUrl).toMatch(/https/);
		expect(errors.sloBinding).toMatch(/redirect or POST/);
	});

	test('an empty SLO URL is not an error: it disables SLO', () => {
		const errors = ssoProviderFieldErrors({
			name: 'Okta SAML',
			issuer: 'https://idp.example.com/metadata',
			protocol: 'saml',
			saml: { entryPoint: 'https://idp.example.com/sso', cert, sloUrl: '  ' }
		});
		expect(errors.sloUrl).toBeUndefined();
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

describe('SAML service-provider metadata', () => {
	const certificateA = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(120)}\n-----END CERTIFICATE-----`;
	const certificateB = `-----BEGIN CERTIFICATE-----\n${'B'.repeat(120)}\n-----END CERTIFICATE-----`;

	test('the SLO callback URL is the plugin endpoint for the provider', () => {
		expect(ssoSamlSloUrl('https://skiff.example/', 'sso_abc')).toBe(
			'https://skiff.example/api/auth/sso/saml2/sp/slo/sso_abc'
		);
	});

	test('publishes the entity id, ACS URL, signing certificate and both SLO bindings', () => {
		const xml = ssoSamlSpMetadataXml({
			entityId: 'https://skiff.example/api/auth/sso/saml2/sp/metadata?providerId=sso_abc',
			acsUrl: 'https://skiff.example/api/auth/sso/saml2/sp/acs/sso_abc',
			sloUrl: 'https://skiff.example/api/auth/sso/saml2/sp/slo/sso_abc',
			certificates: [certificateA],
			wantAssertionsSigned: true
		});
		expect(xml).toContain(
			'entityID="https://skiff.example/api/auth/sso/saml2/sp/metadata?providerId=sso_abc"'
		);
		expect(xml).toContain('AuthnRequestsSigned="true"');
		expect(xml).toContain('WantAssertionsSigned="true"');
		expect(xml).toContain('<md:KeyDescriptor use="signing">');
		expect(xml).toContain(`<ds:X509Certificate>${'A'.repeat(120)}</ds:X509Certificate>`);
		expect(xml).toContain(
			'<md:AssertionConsumerService index="0" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://skiff.example/api/auth/sso/saml2/sp/acs/sso_abc"/>'
		);
		expect(xml).toContain(
			'<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://skiff.example/api/auth/sso/saml2/sp/slo/sso_abc"/>'
		);
		expect(xml).toContain(
			'<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://skiff.example/api/auth/sso/saml2/sp/slo/sso_abc"/>'
		);
	});

	test('publishes a rollover certificate next to the current one', () => {
		const xml = ssoSamlSpMetadataXml({
			entityId: 'https://skiff.example/sp',
			acsUrl: 'https://skiff.example/acs',
			certificates: [certificateA, certificateB],
			wantAssertionsSigned: true
		});
		expect(xml.match(/<md:KeyDescriptor use="signing">/g)).toHaveLength(2);
		expect(xml).toContain(`${'A'.repeat(120)}`);
		expect(xml).toContain(`${'B'.repeat(120)}`);
	});

	test('escapes attribute values and omits an unconfigured SLO endpoint', () => {
		const xml = ssoSamlSpMetadataXml({
			entityId: 'https://skiff.example/sp?a=1&b="2"',
			acsUrl: 'https://skiff.example/acs',
			certificates: [certificateA],
			wantAssertionsSigned: false,
			identifierFormat: 'urn:example:nameid'
		});
		expect(xml).toContain('entityID="https://skiff.example/sp?a=1&amp;b=&quot;2&quot;"');
		expect(xml).toContain('WantAssertionsSigned="false"');
		expect(xml).toContain('<md:NameIDFormat>urn:example:nameid</md:NameIDFormat>');
		expect(xml).not.toContain('SingleLogoutService');
	});

	test('an SLO message uses POST for a form body and Redirect otherwise', () => {
		expect(ssoSamlSloBindingForRequest('POST')).toBe('post');
		expect(ssoSamlSloBindingForRequest('post', true)).toBe('post');
		expect(ssoSamlSloBindingForRequest('GET')).toBe('redirect');
		expect(ssoSamlSloBindingForRequest(null)).toBe('redirect');
	});
});
