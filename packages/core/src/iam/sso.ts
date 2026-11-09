/**
 * Pure helpers for SSO domain ownership and email routing (IAM.md I19, §8.3).
 *
 * Domains are the bridge between an email address and an identity provider: `/login` asks for the
 * email first, then sends the browser to the IdP of the organisation that has verified the domain.
 * Two rules matter for safety:
 *
 * - Matching is exact on the registrable hostname. `mail.example.com` does not route to an IdP that
 *   verified `example.com` unless that exact host is listed; suffix matching would let anyone who
 *   controls a delegated subdomain claim the parent.
 * - Only a verified row routes. A pending token, or one whose record has disappeared, must never
 *   send a user to an IdP (or let an unverified domain claim an organisation).
 *
 * The TXT value is `yoal-verify=<token>` published on the domain itself, mirroring the email
 * domain check (D116). This module is deliberately free of I/O so the API, the dashboard and tests
 * all agree; the DNS lookup and token generation live in the control plane.
 */

/** The DNS TXT value an organisation publishes to prove it owns a domain. */
export const SSO_VERIFY_PREFIX = 'yoal-verify=';

/** The sign-in protocols `@better-auth/sso` supports for one provider (IAM.md §8.3). */
export type SsoProtocol = 'oidc' | 'saml';

export const SSO_PROTOCOLS = ['oidc', 'saml'] as const;

export function isSsoProtocol(value: unknown): value is SsoProtocol {
	return value === 'oidc' || value === 'saml';
}

/** The longest a claim, URL or entity id may be before it is refused. */
const MAX_SSO_VALUE = 500;

function trimToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * True for an absolute `https` URL, or `http` on a loopback host for a development IdP. SAML
 * entity ids are opaque strings, so they are not checked with this.
 */
export function isAllowedSsoUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') return true;
	return (
		url.protocol === 'http:' &&
		(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
	);
}

/**
 * The Assertion Consumer Service URL `@better-auth/sso` serves for a provider. It is derived from
 * the provider id, so Settings can show it (and the SP metadata URL) before the provider exists.
 */
export function ssoSamlAcsUrl(origin: string, providerId: string): string {
	return `${origin.replace(/\/+$/, '')}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`;
}

/** The SP metadata URL the plugin serves, which an IdP can import instead of manual fields. */
export function ssoSamlMetadataUrl(origin: string, providerId: string): string {
	return `${origin.replace(/\/+$/, '')}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
}

/**
 * The IdP-initiated Single Logout callback the plugin serves. This is where an IdP sends a
 * `LogoutRequest` (or a `LogoutResponse` for an SP-initiated request); the plugin deletes the
 * matching platform session and clears the session cookie. It is advertised in the SP metadata
 * with both the POST and Redirect bindings.
 */
export function ssoSamlSloUrl(origin: string, providerId: string): string {
	return `${origin.replace(/\/+$/, '')}/api/auth/sso/saml2/sp/slo/${encodeURIComponent(providerId)}`;
}

/** The SAML protocol and metadata namespaces, spelled once for the metadata builder. */
const SAML_PROTOCOL_URN = 'urn:oasis:names:tc:SAML:2.0:protocol';
const SAML_METADATA_URN = 'urn:oasis:names:tc:SAML:2.0:metadata';
const SAML_DSIG_URN = 'http://www.w3.org/2000/09/xmldsig#';
const SAML_EMAIL_NAMEID = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

function xmlAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function certificateBody(pem: string): string {
	return pem
		.replace(/-----BEGIN CERTIFICATE-----/g, '')
		.replace(/-----END CERTIFICATE-----/g, '')
		.replace(/\s+/g, '');
}

export interface SsoSamlSpMetadataInput {
	/** The SP entity id the IdP sees (defaults to the metadata URL elsewhere). */
	entityId: string;
	/** The plugin's ACS URL. */
	acsUrl: string;
	/** The plugin's IdP-initiated SLO URL. Omitted when SLO should not be advertised. */
	sloUrl?: string | null;
	/**
	 * SP signing certificates, current first. A previous certificate during a rollover window is
	 * published next to the current one so the IdP keeps trusting requests signed just before the
	 * rotation.
	 */
	certificates: readonly string[];
	/**
	 * SP assertion-encryption certificates, current first, published with `use="encryption"`. This
	 * is a separate key from the signing key. Omit it when the provider does not want encrypted
	 * assertions: the metadata then carries no encryption certificate at all.
	 */
	encryptionCertificates?: readonly string[];
	/** Require a signed assertion. Must match the provider's `wantAssertionsSigned`. */
	wantAssertionsSigned: boolean;
	/** The NameID format to advertise; the plugin default is emailAddress. */
	identifierFormat?: string | null;
}

function keyDescriptor(
	use: 'signing' | 'encryption',
	certificate: string,
	encryptionMethods = false
): string {
	const methods = encryptionMethods
		? `
          <md:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"/>`
		: '';
	return `        <md:KeyDescriptor use="${use}">
          <ds:KeyInfo>
            <ds:X509Data>
              <ds:X509Certificate>${certificateBody(certificate)}</ds:X509Certificate>
            </ds:X509Data>
          </ds:KeyInfo>${methods}
        </md:KeyDescriptor>`;
}

/**
 * The SP metadata an IdP imports. The plugin's own metadata endpoint normally generates this XML,
 * but its generator cannot add a signing certificate, and the plugin treats custom metadata as the
 * authority for the ACS URL and signed-assertion policy. Building it here also lets Settings show
 * exactly what the IdP will fetch, including a rollover certificate. An encryption certificate is
 * only published when the provider has assertion encryption turned on.
 */
export function ssoSamlSpMetadataXml(input: SsoSamlSpMetadataInput): string {
	const signingCertificates = input.certificates
		.map((certificate) => normalizeSamlCertificate(certificate))
		.filter((certificate): certificate is string => certificate !== null);
	const encryptionCertificates = (input.encryptionCertificates ?? [])
		.map((certificate) => normalizeSamlCertificate(certificate))
		.filter((certificate): certificate is string => certificate !== null);
	const keyDescriptors = [
		...signingCertificates.map((certificate) => keyDescriptor('signing', certificate)),
		...encryptionCertificates.map((certificate) => keyDescriptor('encryption', certificate, true))
	];
	const nameIdFormat = input.identifierFormat?.trim() || SAML_EMAIL_NAMEID;
	const slo = input.sloUrl
		? `        <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlAttribute(input.sloUrl)}"/>
        <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${xmlAttribute(input.sloUrl)}"/>`
		: '';
	return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${SAML_METADATA_URN}" xmlns:ds="${SAML_DSIG_URN}" entityID="${xmlAttribute(input.entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="true" WantAssertionsSigned="${input.wantAssertionsSigned}" protocolSupportEnumeration="${SAML_PROTOCOL_URN}">
${keyDescriptors.join('\n')}
        <md:NameIDFormat>${xmlAttribute(nameIdFormat)}</md:NameIDFormat>
${slo}
        <md:AssertionConsumerService index="0" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlAttribute(input.acsUrl)}"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

/**
 * Normalise an IdP signing certificate to a PEM block. Certificates are public, unlike a private
 * key, so they are stored and returned in the clear; only the IdP holds the matching private key.
 * Accepts a PEM block or the bare base64 body an IdP console often shows.
 */
export function normalizeSamlCertificate(raw: string | null | undefined): string | null {
	const value = raw?.trim();
	if (!value) return null;
	const body = value
		.replace(/-----BEGIN CERTIFICATE-----/g, '')
		.replace(/-----END CERTIFICATE-----/g, '')
		.replace(/\s+/g, '');
	// A certificate is base64; anything else (a private key, a fingerprint) is refused rather than
	// handed to the SAML library as a signing certificate.
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
	if (body.length < 100 || body.length > 20_000) return null;
	const lines = body.match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Normalise one or more IdP signing certificates for rolling rotation. The plugin accepts a string
 * or an array of PEM strings and trusts any certificate that verifies an assertion, so a rollover
 * is "publish the new IdP certificate next to the old one, then remove the old one".
 *
 * Accepts an array, PEM blocks, comma-separated values, or one-line bare base64 values. Invalid
 * entries are dropped rather than failing the whole list: an IdP that publishes a stray
 * fingerprint in its metadata should not stop the real certificate from being used.
 */
export function normalizeSamlCertificates(
	raw: string | readonly string[] | null | undefined
): string[] {
	if (raw === null || raw === undefined) return [];
	const out: string[] = [];
	const add = (candidate: string | null | undefined): void => {
		const certificate = normalizeSamlCertificate(candidate);
		if (certificate && !out.includes(certificate)) out.push(certificate);
	};
	const pemBlock = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
	for (const value of Array.isArray(raw) ? raw : [raw]) {
		if (typeof value !== 'string') continue;
		const text = value.trim();
		if (!text) continue;
		let remainder = text;
		// PEM blocks are unambiguous even when they contain line breaks; take them first.
		for (const block of text.match(pemBlock) ?? []) {
			add(block);
			remainder = remainder.replace(block, '').trim();
		}
		if (!remainder) continue;
		// A comma-separated list of bare base64 bodies, or one-line values separated by newlines.
		for (const separator of [',', '\n']) {
			if (!remainder.includes(separator)) continue;
			const chunks = remainder
				.split(separator)
				.map((chunk) => chunk.trim())
				.filter(Boolean);
			if (chunks.length > 0 && chunks.every((chunk) => normalizeSamlCertificate(chunk))) {
				for (const chunk of chunks) add(chunk);
				remainder = '';
				break;
			}
		}
		if (remainder) add(remainder);
	}
	return out;
}

/** The two SAML bindings an IdP's Single Logout Service may use. */
export const SSO_SAML_SLO_BINDINGS = ['redirect', 'post'] as const;

export type SsoSamlSloBinding = (typeof SSO_SAML_SLO_BINDINGS)[number];

export function isSsoSamlSloBinding(value: unknown): value is SsoSamlSloBinding {
	return value === 'redirect' || value === 'post';
}

/** Normalise an IdP Single Logout Service URL. An empty value means "no SLO configured". */
export function normalizeSsoSloUrl(raw: string | null | undefined): string | null {
	const value = raw?.trim();
	if (!value || value.length > MAX_SSO_VALUE || !isAllowedSsoUrl(value)) return null;
	const url = new URL(value);
	url.hash = '';
	return url.toString();
}

/** The SAML binding URI for an IdP Single Logout Service, for `samlConfig.idpMetadata`. */
export function ssoSamlSloBindingUri(binding: SsoSamlSloBinding): string {
	return binding === 'post'
		? 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
		: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
}

/**
 * Which binding an inbound SLO message used. The plugin accepts `SAMLRequest`/`SAMLResponse` from
 * either a GET query string (Redirect) or a form body (POST); this is the one place that decision
 * is made, so the callback and its test agree.
 */
export function ssoSamlSloBindingForRequest(
	method: string | null | undefined,
	hasFormBody = false
): SsoSamlSloBinding {
	return (method ?? '').toUpperCase() === 'POST' || hasFormBody ? 'post' : 'redirect';
}

// ---------------------------------------------------------------- provider field validation

/** The SAML half of a provider form. Metadata import is one way to fill it; manual fields the other. */
export interface SsoSamlFields {
	/** An IdP metadata document URL, fetched at save time. */
	metadataUrl?: string | null;
	/** The IdP entity id (the `issuer` column). Metadata import supplies it. */
	entityId?: string;
	/** The IdP SSO URL (manual entry). */
	entryPoint?: string;
	/** The IdP signing certificate (public). May contain more than one PEM block. */
	cert?: string;
	/** Additional IdP signing certificates for a rollover, or every certificate when provided. */
	certs?: string | readonly string[];
	/** Additional IdP signing certificates (PEM or bare base64, comma/newline separated). */
	secondaryCerts?: string | readonly string[];
	/** The IdP Single Logout Service URL. Empty means SLO is not configured. */
	sloUrl?: string | null;
	/** The IdP SLO binding. Defaults to `redirect`. */
	sloBinding?: string;
	/** The SP entity id; defaults to the SP metadata URL. */
	spEntityId?: string;
	audience?: string;
	wantAssertionsSigned?: boolean;
	/** Ask the IdP to encrypt assertions to the provider's separate SP encryption certificate. */
	wantAssertionsEncrypted?: boolean;
	identifierFormat?: string;
}

export interface SsoProviderFieldInput {
	protocol?: string | null;
	name?: string;
	/** The OIDC issuer, or the SAML IdP entity id when `saml.entityId` is absent. */
	issuer?: string;
	clientId?: string;
	clientSecret?: string;
	/** Present when the OIDC configuration comes from a preset. */
	preset?: unknown;
	saml?: SsoSamlFields | null;
}

export type SsoProviderField =
	| 'protocol'
	| 'name'
	| 'issuer'
	| 'clientId'
	| 'clientSecret'
	| 'metadataUrl'
	| 'entryPoint'
	| 'cert'
	| 'secondaryCerts'
	| 'sloUrl'
	| 'sloBinding'
	| 'spEntityId'
	| 'audience'
	| 'identifierFormat';

export interface SsoProviderFieldOptions {
	/** A new OIDC provider needs a secret; a partial update may keep the stored one. */
	requireSecret?: boolean;
}

/**
 * Protocol-aware presence and shape checks, shared by the settings form, the REST API and the
 * service so they refuse the same input with the same words. It deliberately does not fetch or
 * normalise anything (issuer discovery and metadata import need I/O); the service does that after
 * these pass, and re-checks the values it stored.
 */
export function ssoProviderFieldErrors(
	input: SsoProviderFieldInput,
	options: SsoProviderFieldOptions = {}
): Partial<Record<SsoProviderField, string>> {
	const errors: Partial<Record<SsoProviderField, string>> = {};
	const protocol = input.protocol ?? 'oidc';
	if (!isSsoProtocol(protocol)) {
		errors.protocol = 'Choose either OIDC or SAML.';
		return errors;
	}

	const name = input.name?.trim() ?? '';
	if (!name) errors.name = 'Give the provider a name.';
	else if (name.length > 80) errors.name = 'Keep the name under 80 characters.';

	const saml = input.saml ?? {};

	if (protocol === 'oidc') {
		if (input.preset === undefined || input.preset === null) {
			if (!trimToNull(input.issuer)) errors.issuer = 'The issuer is required, or choose a preset.';
			else if (input.issuer!.trim().length > MAX_SSO_VALUE)
				errors.issuer = 'The issuer is too long.';
		}
		if (!trimToNull(input.clientId)) errors.clientId = 'The client id is required.';
		else if (input.clientId!.trim().length > MAX_SSO_VALUE)
			errors.clientId = 'The client id is too long.';
		if (options.requireSecret && !trimToNull(input.clientSecret))
			errors.clientSecret = 'The client secret is required.';
		return errors;
	}

	const metadataUrl = trimToNull(saml.metadataUrl);
	if (!metadataUrl) {
		if (!trimToNull(saml.entryPoint))
			errors.entryPoint = 'An entry point (SSO URL) or an IdP metadata URL is required.';
		else if (!isAllowedSsoUrl(saml.entryPoint!.trim()))
			errors.entryPoint = 'The entry point must use https (http is allowed only for localhost).';
		else if (saml.entryPoint!.trim().length > MAX_SSO_VALUE)
			errors.entryPoint = 'The entry point is too long.';

		const suppliedCertText =
			saml.certs === undefined
				? saml.cert
				: typeof saml.certs === 'string'
					? saml.certs
					: saml.certs.join('\n');
		if (!trimToNull(suppliedCertText)) errors.cert = 'The IdP signing certificate is required.';
		else if (normalizeSamlCertificates(suppliedCertText).length === 0)
			errors.cert = 'Paste the IdP signing certificate in PEM or base64 form.';
	} else if (!isAllowedSsoUrl(metadataUrl)) {
		errors.metadataUrl = 'The metadata URL must use https (http is allowed only for localhost).';
	}

	// Secondary certificates are optional; when supplied, each one must be a certificate. They are
	// what makes a rolling rotation possible without a gap in trust.
	const secondaryText =
		typeof saml.secondaryCerts === 'string'
			? saml.secondaryCerts
			: (saml.secondaryCerts ?? []).join('\n');
	if (trimToNull(secondaryText) && normalizeSamlCertificates(secondaryText).length === 0)
		errors.secondaryCerts = 'Paste each additional IdP signing certificate in PEM or base64 form.';

	// SLO is optional. A blank URL disables it, so an empty value is not an error.
	if (trimToNull(saml.sloUrl) && !normalizeSsoSloUrl(saml.sloUrl))
		errors.sloUrl = 'The SLO URL must use https (http is allowed only for localhost).';
	if (trimToNull(saml.sloBinding) && !isSsoSamlSloBinding(saml.sloBinding))
		errors.sloBinding = 'Choose the redirect or POST binding.';

	if (!trimToNull(saml.entityId) && !trimToNull(input.issuer) && !metadataUrl)
		errors.issuer = 'The IdP entity id is required.';
	if (trimToNull(saml.entityId) && saml.entityId!.trim().length > MAX_SSO_VALUE)
		errors.issuer = 'The IdP entity id is too long.';
	if (trimToNull(saml.spEntityId) && saml.spEntityId!.trim().length > MAX_SSO_VALUE)
		errors.spEntityId = 'The SP entity id is too long.';
	if (trimToNull(saml.audience) && saml.audience!.trim().length > MAX_SSO_VALUE)
		errors.audience = 'The audience is too long.';
	if (trimToNull(saml.identifierFormat) && saml.identifierFormat!.trim().length > MAX_SSO_VALUE)
		errors.identifierFormat = 'The identifier format is too long.';

	return errors;
}

/** How long a verification result is trusted before the record is checked again (IAM.md §8.3). */
export const SSO_RECHECK_MS = 24 * 60 * 60 * 1000;

/** A hostname with at least two labels; no wildcard, underscore, scheme or port. */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/**
 * Normalise what someone typed into a domain field: lowercase, no scheme, path, port or trailing
 * dot. Returns `null` for anything that is not a bare public hostname, so a URL or an email address
 * in the domain box is a validation error rather than a silently wrong record.
 */
export function normalizeSsoDomain(input: string): string | null {
	let value = input.trim().toLowerCase();
	if (!value) return null;
	if (value.endsWith('.')) value = value.slice(0, -1);
	if (value.includes('://') || value.includes('/') || value.includes('@') || value.includes(':'))
		return null;
	if (value.length > 253) return null;
	// A bare IPv4 address is not a registrable domain.
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
	return HOSTNAME.test(value) ? value : null;
}

/** The lowercased domain of an email address, or `null` when it is not one address. */
export function emailDomain(email: string): string | null {
	const value = email.trim().toLowerCase();
	const at = value.lastIndexOf('@');
	if (at <= 0 || at === value.length - 1) return null;
	const local = value.slice(0, at);
	if (!local || local.includes('@')) return null;
	return normalizeSsoDomain(value.slice(at + 1));
}

/**
 * The verified domain an email belongs to, from rows shaped like `sso_domains`. Matching is exact:
 * an address is routed only by the domain it actually uses.
 */
export function verifiedDomainForEmail<T extends { domain: string; verifiedAt: number | null }>(
	email: string,
	domains: Iterable<T>
): T | null {
	const domain = emailDomain(email);
	if (!domain) return null;
	for (const row of domains) {
		if (row.verifiedAt === null) continue;
		if (normalizeSsoDomain(row.domain) === domain) return row;
	}
	return null;
}

/** The exact TXT value to publish at the domain. */
export function ssoVerificationRecord(token: string): string {
	return `${SSO_VERIFY_PREFIX}${token.trim()}`;
}

/**
 * Whether any TXT record at the domain carries this verification token. Each record arrives as its
 * character-strings; they are joined first because a resolver (or Bun) may split one value.
 */
export function hasSsoVerificationRecord(
	records: readonly (readonly string[])[],
	token: string
): boolean {
	const expected = ssoVerificationRecord(token);
	for (const record of records) {
		if (record.join('').trim() === expected) return true;
	}
	return false;
}

/** A row is due when it has never been checked, or its last check is a day old. */
export function ssoDomainCheckDue(
	lastCheckedAt: number | null,
	now: number,
	interval = SSO_RECHECK_MS
): boolean {
	return lastCheckedAt === null || now - lastCheckedAt >= interval;
}

// ---------------------------------------------------------------- IdP group mapping (I19, §8.3)

/** A claim value longer than this is not a group name; ignore it rather than store it. */
export const MAX_GROUP_CLAIM_LENGTH = 200;

/**
 * Normalise one IdP group claim for storage and comparison. Directory services disagree about
 * whitespace and case (`Engineering`, ` engineering `), and a mapping that silently stops matching
 * after an IdP rename defeats the point of syncing groups. Matching is therefore case-insensitive;
 * the display value from the IdP is not used anywhere, only the Yoal group id is.
 */
export function normalizeGroupClaim(value: string): string | null {
	const claim = value.trim().toLowerCase();
	if (!claim || claim.length > MAX_GROUP_CLAIM_LENGTH) return null;
	return claim;
}

/**
 * Read the groups claim from an IdP's userinfo/ID token into normalised, de-duplicated values.
 *
 * Accepts an array (Okta, Entra, most OIDC providers), a comma- or newline-separated string
 * (Auth0 and custom mappers), and a JSON array encoded as a string (some SAML/OIDC bridges).
 * `undefined`/`null` stays `undefined` rather than becoming an empty list: a missing claim must
 * not be treated as "the user is in no groups", or a misconfigured claim name would wipe access.
 */
export function groupClaimValues(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	let values: unknown[];
	if (Array.isArray(raw)) values = raw;
	else if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith('[')) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				values = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				values = trimmed.split(',');
			}
		} else values = trimmed.split(/[,\n]/);
	} else values = [raw];

	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const claim = normalizeGroupClaim(value);
		if (claim && !out.includes(claim)) out.push(claim);
	}
	return out;
}

/** The group a mapping row points at, as stored in `sso_group_mappings`. */
export interface GroupClaimMapping {
	claimValue: string;
	groupId: string;
}

/**
 * Resolve the IdP claims a user presented against the organisation's mappings. Returns unique
 * Yoal group ids; unknown claims are ignored, so adding a new IdP group never grants access
 * until an administrator maps it. Local groups are not involved here — only membership rows.
 */
export function groupIdsForClaims(
	claims: readonly string[] | undefined,
	mappings: readonly GroupClaimMapping[]
): string[] {
	if (!claims || claims.length === 0) return [];
	const wanted = new Set(
		claims.map(normalizeGroupClaim).filter((claim): claim is string => claim !== null)
	);
	const out: string[] = [];
	for (const mapping of mappings) {
		const claim = normalizeGroupClaim(mapping.claimValue);
		if (claim && wanted.has(claim) && !out.includes(mapping.groupId)) out.push(mapping.groupId);
	}
	return out;
}
