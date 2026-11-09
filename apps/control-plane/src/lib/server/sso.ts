import {
	ConflictError,
	NotFoundError,
	ValidationError,
	newId,
	nodeDnsResolver,
	randomToken
} from '@skiff/core';
import type { Principal } from '@skiff/contracts';
// The pure domain/TXT and group-claim helpers live in core so they can be tested without
// SvelteKit or a database. They are also exported from `@skiff/core`; this deep import keeps the
// settings service's dependency narrow.
import {
	MAX_GROUP_CLAIM_LENGTH,
	SSO_RECHECK_MS,
	hasSsoVerificationRecord,
	isSsoProtocol,
	isSsoSamlSloBinding,
	normalizeGroupClaim,
	normalizeSamlCertificates,
	normalizeSsoDomain,
	normalizeSsoSloUrl,
	ssoProviderFieldErrors,
	ssoSamlAcsUrl,
	ssoSamlMetadataUrl,
	ssoVerificationRecord,
	verifiedDomainForEmail,
	type SsoProtocol,
	type SsoSamlFields,
	type SsoSamlSloBinding
} from '../../../../../packages/core/src/iam/sso.ts';
import { SsoPresetError, resolveSsoPreset, type SsoPresetValues } from '../sso-presets';
import { core } from './core';
import { platformOrigin } from './config';
import { SsoSpKeyStore, type SsoSpKeyView } from './sso-sp';
import { syncSsoProviders } from './sso-sync';

/**
 * SSO providers and verified email domains (IAM.md I19, §8.3).
 *
 * `sso_providers` is the source of truth for configuration (issuer, sealed client secret, SAML
 * certificate and endpoints, claim mapping, enabled flag); `sso_domains` proves ownership with a
 * `skiff-verify=` TXT record. `sso-sync.ts` copies the enabled rows into Better Auth's
 * boot-migrated `ssoProvider` table, which `@better-auth/sso` reads for the actual sign-in. Settings
 * never writes that table directly.
 *
 * What is real here: provider configuration, OIDC discovery at save time, SAML metadata import,
 * domain TXT ownership checks re-run daily, permission checks, email→provider routing for `/login`,
 * the callback/ACS URLs to register at the IdP, and the IdP-group → Skiff-group mapping used by JIT
 * provisioning. Sign-in and JIT provisioning run through Better Auth for both protocols; SCIM lives
 * in `auth.ts`/`core.scim`.
 */

const MAX_NAME = 80;
const MAX_URL = 500;
const MAX_SECRET = 4000;
const MAX_CLAIM = 100;
/** An IdP metadata document is small; refuse anything larger rather than parse it. */
const MAX_SAML_METADATA_BYTES = 1_000_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** At most this many domains are re-checked in one visit, oldest first. */
const RECHECK_BATCH = 25;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const DEFAULT_CLAIMS = { email: 'email', name: 'name', groups: 'groups' };
/** SAML attributes are attribute names; `displayName` is the common default for a person's name. */
const DEFAULT_SAML_CLAIMS = { email: 'email', name: 'displayName', groups: 'groups' };
const SAML_REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

interface ProviderRow {
	id: string;
	org_id: string;
	name: string;
	protocol: string;
	issuer: string;
	client_id: string;
	client_secret_sealed: string;
	discovery_url: string | null;
	authorization_endpoint: string | null;
	token_endpoint: string | null;
	jwks_endpoint: string | null;
	scopes_json: string;
	claim_email: string;
	claim_name: string;
	claim_groups: string;
	entry_point: string | null;
	cert: string | null;
	/** Additional IdP signing certificates (a JSON array of PEM blocks), for a rollover. */
	certs_json?: string | null;
	/** The IdP Single Logout Service URL. */
	slo_url?: string | null;
	/** `redirect` or `post`; the binding the IdP advertises for its SLO endpoint. */
	slo_binding?: string | null;
	callback_url: string | null;
	sp_entity_id: string | null;
	audience: string | null;
	want_assertions_signed: number;
	identifier_format: string | null;
	enabled: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface DomainRow {
	org_id: string;
	domain: string;
	txt_token: string;
	verified_at: number | null;
	last_checked_at: number | null;
}

interface GroupMappingRow {
	id: string;
	org_id: string;
	provider_id: string;
	claim_value: string;
	group_id: string;
	created_at: number;
}

export interface SsoClaims {
	email: string;
	name: string;
	groups: string;
}

export interface SsoProviderView {
	id: string;
	name: string;
	protocol: SsoProtocol;
	/** OIDC issuer, or the SAML IdP entity id. */
	issuer: string;
	clientId: string;
	discoveryUrl: string | null;
	authorizationEndpoint: string | null;
	tokenEndpoint: string | null;
	jwksEndpoint: string | null;
	scopes: readonly string[];
	claims: SsoClaims;
	enabled: boolean;
	/** The OIDC secret is write-only; the UI only needs to know one is stored. */
	hasClientSecret: boolean;
	/** The SAML certificate is public; the UI only needs to know one is stored. */
	hasCertificate: boolean;
	/** How many IdP signing certificates are trusted (one or more; two during a rollover). */
	certificateCount: number;
	/**
	 * The URL to register at the IdP: the OIDC redirect URI, or the SAML ACS URL. Kept as one field
	 * so the existing provider row can show whichever applies without a protocol branch in the table.
	 */
	callbackUrl: string;
	/** SAML only: the SP metadata document an IdP can import. */
	spMetadataUrl: string | null;
	/** SAML only: the Assertion Consumer Service URL. */
	acsUrl: string | null;
	saml: {
		entityId: string;
		entryPoint: string | null;
		spEntityId: string | null;
		audience: string | null;
		wantAssertionsSigned: boolean;
		identifierFormat: string | null;
		/** IdP signing certificates, public. The first is the primary; the rest are rollover. */
		certificates: string[];
		/** The IdP Single Logout Service URL, when configured. */
		sloUrl: string | null;
		sloBinding: SsoSamlSloBinding;
		/**
		 * SP request signing (IAM.md §8.3). The certificate is public; the private key stays sealed
		 * on the server. `previousCertificate` is a rotated-out certificate still inside its
		 * rollover window.
		 */
		spSigning: SsoSpKeyView | null;
	} | null;
	createdAt: number;
	updatedAt: number;
}

export interface SsoProviderInput {
	name: string;
	/** Defaults to `oidc`. A SAML provider cannot change protocol after creation. */
	protocol?: SsoProtocol;
	/** Required for OIDC unless `preset` is given; the SAML IdP entity id may live in `saml`. */
	issuer?: string;
	/**
	 * A ready-made OIDC set-up (`sso-presets.ts`, D180). It supplies the issuer and discovery URL,
	 * and the scopes and claims when the caller leaves those out.
	 */
	preset?: { id: string; values?: SsoPresetValues };
	clientId?: string;
	clientSecret?: string;
	discoveryUrl?: string | null;
	scopes?: readonly string[];
	claims?: Partial<SsoClaims>;
	enabled?: boolean;
	/** SAML configuration. `metadataUrl` is fetched at save time; the rest is manual entry. */
	saml?: SsoSamlFields;
}

/** Where a SAML sign-out should send the browser, once the local session is gone. */
export interface SsoLogoutTarget {
	providerId: string | null;
	/** The IdP Single Logout Service URL, when one is configured. */
	sloUrl: string | null;
	sloBinding: SsoSamlSloBinding;
}

export interface SsoGroupMappingView {
	id: string;
	providerId: string;
	/** The normalised IdP claim value. */
	claimValue: string;
	groupId: string;
	groupName: string;
	createdAt: number;
}

export interface SsoGroupMappingInput {
	providerId: string;
	claimValue: string;
	groupId: string;
}

export interface SsoDomainView {
	domain: string;
	/** Where the TXT record goes (the domain itself) and the value to publish there. */
	txtRecordName: string;
	txtRecordValue: string;
	verified: boolean;
	verifiedAt: number | null;
	lastCheckedAt: number | null;
}

interface OidcDiscovery {
	/** The issuer exactly as the IdP publishes it, trailing slash included. */
	issuer: string;
	discoveryUrl: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksEndpoint: string;
}

const PROVIDER_ID = /^sso_[0-9a-f]{32}$/;

/** SP signing keys (IAM.md §8.3): sealed in `settings`, public certificate shown in Settings. */
const spKeys = new SsoSpKeyStore({
	sqlite: core.ctx.sqlite,
	secrets: core.ctx.secrets,
	now: () => core.ctx.now()
});

/** The redirect URI to register at the IdP for a provider id (Better Auth's OIDC callback). */
export function ssoCallbackUrl(providerId: string): string {
	return `${platformOrigin}/api/auth/sso/callback/${providerId}`;
}

/** The SAML ACS URL, and the SP metadata URL an IdP can import, for a provider id. */
export function ssoSamlAcs(providerId: string): string {
	return ssoSamlAcsUrl(platformOrigin, providerId);
}

export function ssoSamlMetadata(providerId: string): string {
	return ssoSamlMetadataUrl(platformOrigin, providerId);
}

/** A fresh provider id, so the dashboard can show the redirect URI before the provider exists. */
export function reserveSsoProviderId(): string {
	return newId('sso_');
}

/**
 * Fold a preset into the input: its issuer and discovery URL always, its scopes and claims only
 * where the caller gave none. A bad preset value is a validation error naming the field.
 */
function applyPreset<T extends Partial<SsoProviderInput>>(input: T): T {
	if (!input.preset) return input;
	let config;
	try {
		config = resolveSsoPreset(input.preset.id, input.preset.values ?? {});
	} catch (cause) {
		if (cause instanceof SsoPresetError) throw new ValidationError(cause.message, [cause]);
		throw cause;
	}
	return {
		...input,
		issuer: config.issuer,
		discoveryUrl: config.discoveryUrl,
		scopes: input.scopes ?? config.scopes,
		claims: { ...config.claims, ...input.claims }
	};
}

function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** A bare https issuer (http is allowed only for a loopback development IdP). */
function normalizeIssuer(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new ValidationError(
			'The issuer must be a full URL, for example https://example.okta.com.'
		);
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
		throw new ValidationError('The issuer must use https (http is allowed only for localhost).');
	url.hash = '';
	url.search = '';
	url.pathname = url.pathname.replace(/\/+$/, '');
	return url.toString().replace(/\/$/, '');
}

function optionalUrl(raw: string | null | undefined, label: string): string | null {
	const value = raw?.trim();
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ValidationError(`${label} must be a full URL.`);
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
		throw new ValidationError(`${label} must use https (http is allowed only for localhost).`);
	if (value.length > MAX_URL) throw new ValidationError(`${label} is too long.`);
	return url.toString();
}

function cleanScopes(scopes: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const raw of scopes ?? DEFAULT_SCOPES) {
		const scope = raw.trim();
		if (!scope) continue;
		if (!/^[A-Za-z0-9._:-]{1,100}$/.test(scope))
			throw new ValidationError(`The scope “${scope}” is not a valid OAuth scope.`);
		if (!out.includes(scope)) out.push(scope);
	}
	if (!out.includes('openid')) out.unshift('openid');
	return out.slice(0, 20);
}

function cleanClaims(
	claims: Partial<SsoClaims> | undefined,
	base: SsoClaims = DEFAULT_CLAIMS
): SsoClaims {
	const pick = (value: string | undefined, fallback: string, label: string): string => {
		const claim = (value ?? fallback).trim();
		if (!claim) throw new ValidationError(`The ${label} claim cannot be empty.`);
		if (claim.length > MAX_CLAIM) throw new ValidationError(`The ${label} claim is too long.`);
		return claim;
	};
	return {
		email: pick(claims?.email, base.email, 'email'),
		name: pick(claims?.name, base.name, 'name'),
		groups: pick(claims?.groups, base.groups, 'groups')
	};
}

function cleanName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new ValidationError('Give the provider a name.');
	if (name.length > MAX_NAME)
		throw new ValidationError(`Keep the name under ${MAX_NAME} characters.`);
	return name;
}

function cleanClientId(raw: string): string {
	const clientId = raw.trim();
	if (!clientId) throw new ValidationError('The client id is required.');
	if (clientId.length > MAX_URL) throw new ValidationError('The client id is too long.');
	return clientId;
}

function cleanSecret(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const secret = raw.trim();
	if (!secret) return undefined;
	if (secret.length > MAX_SECRET) throw new ValidationError('The client secret is too long.');
	return secret;
}

/** Refuse the form input with the first protocol-aware field error (pure checks in `@skiff/core`). */
function assertProviderFields(
	input: SsoProviderInput,
	options: { requireSecret?: boolean } = {}
): void {
	const errors = ssoProviderFieldErrors(input, options);
	const first = Object.entries(errors)[0];
	if (first) throw new ValidationError(first[1], [{ field: first[0] }]);
}

/** A SAML entity id is an opaque URI, not necessarily an http(s) URL (Okta and ADFS use odd ones). */
function cleanEntityId(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	if (value.length > MAX_URL) throw new ValidationError('The IdP entity id is too long.');
	if (/[\s<>"']/.test(value))
		throw new ValidationError('The IdP entity id cannot contain spaces, quotes or angle brackets.');
	return value;
}

function cleanOptionalText(raw: string | null | undefined, label: string): string | null {
	const value = raw?.trim();
	if (!value) return null;
	if (value.length > MAX_URL) throw new ValidationError(`${label} is too long.`);
	return value;
}

/** One SAML value from an IdP metadata document, tolerant of prefixes and attribute order. */
function xmlAttribute(tag: string, name: string): string | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
	return pattern.exec(tag)?.[1]?.trim() || null;
}

interface SamlMetadata {
	entityId: string | null;
	entryPoint: string | null;
	/** Every signing certificate the document publishes; the first is the primary. */
	certs: string[];
}

/**
 * Read the parts of an IdP metadata document the plugin needs. This is deliberately a small
 * extractor rather than a full XML parser: it only ever sees an admin-supplied document, and the
 * values are re-checked (URL shape, certificate format) before they are stored.
 */
function parseSamlMetadata(xml: string): SamlMetadata {
	const entityDescriptor = /<(?:[\w-]+:)?EntityDescriptor\b[^>]*>/i.exec(xml)?.[0] ?? '';
	const entityId = xmlAttribute(entityDescriptor, 'entityID');

	let entryPoint: string | null = null;
	const ssoServices = xml.match(/<(?:[\w-]+:)?SingleSignOnService\b[^>]*>/gi) ?? [];
	for (const service of ssoServices) {
		const binding = xmlAttribute(service, 'Binding');
		const location = xmlAttribute(service, 'Location');
		if (!location) continue;
		if (binding === SAML_REDIRECT_BINDING) {
			entryPoint = location;
			break;
		}
		entryPoint ??= location;
	}

	const certificates =
		xml.match(
			/<(?:[\w-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?X509Certificate>/gi
		) ?? [];
	const certs = normalizeSamlCertificates(
		certificates.map(
			(block) =>
				/<(?:[\w-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?X509Certificate>/i.exec(
					block
				)?.[1] ?? ''
		)
	);

	return { entityId, entryPoint, certs };
}

/** The IdP signing certificates on a stored row: `cert` first, then the rollover extras. */
function providerCertificates(row: {
	cert: string | null;
	certs_json?: string | null;
}): string[] {
	let extras: unknown = [];
	try {
		extras = row.certs_json ? JSON.parse(row.certs_json) : [];
	} catch {
		extras = [];
	}
	return normalizeSamlCertificates([
		row.cert ?? '',
		...(Array.isArray(extras) ? extras.filter((value): value is string => typeof value === 'string') : [])
	]);
}

async function fetchSamlMetadata(url: string): Promise<SamlMetadata> {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: 'error',
			headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
	} catch (cause) {
		throw new ValidationError(
			`Could not read the IdP metadata at ${url}. Check the URL and that the identity provider allows this server to reach it.`,
			[cause]
		);
	}
	if (!response.ok)
		throw new ValidationError(`The IdP metadata at ${url} answered ${response.status}.`);
	const xml = await response.text();
	if (new TextEncoder().encode(xml).length > MAX_SAML_METADATA_BYTES)
		throw new ValidationError('The IdP metadata document is too large.');
	const metadata = parseSamlMetadata(xml);
	if (!metadata.entityId || !metadata.entryPoint || metadata.certs.length === 0)
		throw new ValidationError(
			'The IdP metadata document is missing its entity id, single sign-on URL or signing certificate.'
		);
	return metadata;
}

/**
 * Resolve the SAML fields for a create or an update. A metadata URL wins over manual values for
 * the fields it supplies; a blank certificate on update keeps the stored one. SLO is optional: an
 * omitted `sloUrl` keeps the stored endpoint, and an explicit blank disables it.
 */
async function resolveSaml(
	input: { issuer?: string; saml?: SsoSamlFields },
	id: string,
	existing?: ProviderRow
): Promise<{
	entityId: string;
	entryPoint: string;
	certs: string[];
	spEntityId: string;
	audience: string | null;
	wantAssertionsSigned: boolean;
	identifierFormat: string | null;
	sloUrl: string | null;
	sloBinding: SsoSamlSloBinding;
	metadataUrl: string | null;
}> {
	const saml = input.saml ?? {};
	const metadataUrlInput =
		saml.metadataUrl === undefined ? undefined : cleanOptionalText(saml.metadataUrl, 'The metadata URL');
	const metadataUrl =
		metadataUrlInput === undefined ? (existing?.discovery_url ?? null) : metadataUrlInput;
	const fetched = metadataUrlInput ? await fetchSamlMetadata(metadataUrlInput) : null;

	const entityId =
		fetched?.entityId ??
		cleanEntityId(saml.entityId) ??
		cleanEntityId(input.issuer) ??
		existing?.issuer ??
		null;
	if (!entityId) throw new ValidationError('The IdP entity id is required, or import a metadata URL.');

	const entryPointRaw =
		fetched?.entryPoint ??
		cleanOptionalText(saml.entryPoint, 'The entry point') ??
		existing?.entry_point ??
		null;
	const entryPoint = entryPointRaw ? optionalUrl(entryPointRaw, 'The entry point') : null;
	if (!entryPoint)
		throw new ValidationError('The entry point (IdP SSO URL) is required, or import a metadata URL.');

	// A form that submits the full certificate textarea wins; otherwise `cert` and the additional
	// certificates are combined. A blank field on update keeps what is stored, so a provider can be
	// edited without re-pasting its certificates. Metadata import supplies the whole set when the
	// document publishes several certificates (an IdP mid-rollover).
	const supplied =
		saml.certs !== undefined
			? normalizeSamlCertificates(saml.certs)
			: normalizeSamlCertificates([
					saml.cert ?? '',
					...(typeof saml.secondaryCerts === 'string'
						? [saml.secondaryCerts]
						: (saml.secondaryCerts ?? []))
				]);
	const fetchedCerts = fetched?.certs ?? [];
	const certs = supplied.length
		? supplied
		: fetchedCerts.length
			? fetchedCerts
			: existing
				? providerCertificates(existing)
				: [];
	if (certs.length === 0)
		throw new ValidationError(
			'The IdP signing certificate is required, or import a metadata URL.'
		);

	// SLO is optional. A blank value on update disables it; omitting the field keeps the stored one.
	const sloUrl =
		saml.sloUrl === undefined
			? (existing?.slo_url ?? null)
			: saml.sloUrl === null || saml.sloUrl.trim() === ''
				? null
				: normalizeSsoSloUrl(saml.sloUrl);
	if (saml.sloUrl !== undefined && saml.sloUrl !== null && saml.sloUrl.trim() !== '' && !sloUrl)
		throw new ValidationError(
			'The SLO URL must use https (http is allowed only for localhost).'
		);
	const sloBindingInput = saml.sloBinding ?? existing?.slo_binding ?? 'redirect';
	if (!isSsoSamlSloBinding(sloBindingInput))
		throw new ValidationError('Choose the redirect or POST binding for single logout.');
	const sloBinding: SsoSamlSloBinding = sloBindingInput;

	const spEntityId =
		saml.spEntityId === undefined
			? (existing?.sp_entity_id ?? ssoSamlMetadata(id))
			: (cleanOptionalText(saml.spEntityId, 'The SP entity id') ?? ssoSamlMetadata(id));

	const audience =
		saml.audience === undefined
			? (existing?.audience ?? null)
			: cleanOptionalText(saml.audience, 'The audience');
	const identifierFormat =
		saml.identifierFormat === undefined
			? (existing?.identifier_format ?? null)
			: cleanOptionalText(saml.identifierFormat, 'The identifier format');
	const wantAssertionsSigned =
		saml.wantAssertionsSigned === undefined
			? existing
				? existing.want_assertions_signed === 1
				: true
			: saml.wantAssertionsSigned;

	return {
		entityId,
		entryPoint,
		certs,
		spEntityId,
		audience,
		wantAssertionsSigned,
		identifierFormat,
		sloUrl,
		sloBinding,
		metadataUrl
	};
}

/**
 * Read the provider's discovery document and keep the endpoints. A provider whose document is
 * unreachable or names a different issuer is refused at save time: a typo in the issuer would
 * otherwise send every sign-in to the wrong IdP.
 */
async function discover(issuer: string, discoveryUrl: string | null): Promise<OidcDiscovery> {
	const url = discoveryUrl ?? `${issuer}/.well-known/openid-configuration`;
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: 'error',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
	} catch (cause) {
		throw new ValidationError(
			`Could not read ${url}. Check the issuer and that the identity provider allows this server to reach it.`,
			[cause]
		);
	}
	if (!response.ok)
		throw new ValidationError(`The discovery document at ${url} answered ${response.status}.`);
	let document: Record<string, unknown>;
	try {
		document = (await response.json()) as Record<string, unknown>;
	} catch {
		throw new ValidationError(`The discovery document at ${url} is not JSON.`);
	}
	const discoveredIssuer = typeof document.issuer === 'string' ? document.issuer : null;
	let sameIssuer = false;
	try {
		sameIssuer = discoveredIssuer !== null && normalizeIssuer(discoveredIssuer) === issuer;
	} catch {
		sameIssuer = false;
	}
	if (!discoveredIssuer || !sameIssuer)
		throw new ValidationError(
			`The discovery document names the issuer ${discoveredIssuer ?? '(none)'}, not ${issuer}.`
		);
	const endpoint = (key: string): string => {
		const value = document[key];
		if (typeof value !== 'string' || !value)
			throw new ValidationError(`The discovery document has no ${key}.`);
		return optionalUrl(value, key)!;
	};
	return {
		// Kept verbatim: Better Auth checks each ID token's `iss` against it byte for byte, and
		// Auth0, JumpCloud and authentik publish theirs with a trailing slash.
		issuer: discoveredIssuer,
		discoveryUrl: url,
		authorizationEndpoint: endpoint('authorization_endpoint'),
		tokenEndpoint: endpoint('token_endpoint'),
		jwksEndpoint: endpoint('jwks_uri')
	};
}

function view(row: ProviderRow): SsoProviderView {
	const protocol: SsoProtocol = row.protocol === 'saml' ? 'saml' : 'oidc';
	const acsUrl = protocol === 'saml' ? ssoSamlAcs(row.id) : null;
	const certificates = protocol === 'saml' ? providerCertificates(row) : [];
	const sloBinding = isSsoSamlSloBinding(row.slo_binding) ? row.slo_binding : 'redirect';
	return {
		id: row.id,
		name: row.name,
		protocol,
		issuer: row.issuer,
		clientId: row.client_id,
		discoveryUrl: row.discovery_url,
		authorizationEndpoint: row.authorization_endpoint,
		tokenEndpoint: row.token_endpoint,
		jwksEndpoint: row.jwks_endpoint,
		scopes: JSON.parse(row.scopes_json) as string[],
		claims: { email: row.claim_email, name: row.claim_name, groups: row.claim_groups },
		enabled: row.enabled === 1,
		hasClientSecret: row.client_secret_sealed.length > 0,
		hasCertificate: certificates.length > 0,
		certificateCount: certificates.length,
		callbackUrl: acsUrl ?? ssoCallbackUrl(row.id),
		spMetadataUrl: protocol === 'saml' ? ssoSamlMetadata(row.id) : null,
		acsUrl,
		saml:
			protocol === 'saml'
				? {
						entityId: row.issuer,
						entryPoint: row.entry_point,
						spEntityId: row.sp_entity_id,
						audience: row.audience,
						wantAssertionsSigned: row.want_assertions_signed === 1,
						identifierFormat: row.identifier_format,
						certificates,
						sloUrl: row.slo_url ?? null,
						sloBinding,
						// Never generates: the key is created by the sync that writes the plugin row.
						spSigning: spKeys.view(row.id)
					}
				: null,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function domainView(row: DomainRow): SsoDomainView {
	return {
		domain: row.domain,
		txtRecordName: row.domain,
		txtRecordValue: ssoVerificationRecord(row.txt_token),
		verified: row.verified_at !== null,
		verifiedAt: row.verified_at,
		lastCheckedAt: row.last_checked_at
	};
}

function mappingView(row: GroupMappingRow & { group_name: string }): SsoGroupMappingView {
	return {
		id: row.id,
		providerId: row.provider_id,
		claimValue: row.claim_value,
		groupId: row.group_id,
		groupName: row.group_name,
		createdAt: row.created_at
	};
}

export class SsoService {
	#now(): number {
		return core.ctx.now();
	}

	#requireRead(principal: Principal): void {
		core.iam.require(principal, 'sso:read', { type: 'org' });
	}

	#requireManage(principal: Principal): void {
		core.iam.require(principal, 'sso:manage', { type: 'org' });
	}

	#provider(orgId: string, id: string): ProviderRow {
		const row = core.ctx.sqlite
			.query<ProviderRow, [string, string]>(
				'SELECT * FROM sso_providers WHERE org_id = ? AND id = ?'
			)
			.get(orgId, id);
		if (!row) throw new NotFoundError('SSO provider');
		return row;
	}

	#domain(orgId: string, domain: string): DomainRow {
		const row = core.ctx.sqlite
			.query<DomainRow, [string, string]>(
				'SELECT * FROM sso_domains WHERE org_id = ? AND domain = ?'
			)
			.get(orgId, domain);
		if (!row) throw new NotFoundError('SSO domain');
		return row;
	}

	#audit(principal: Principal, action: string, resourceId: string, args: unknown): void {
		core.ctx.audit.record({
			principal,
			action,
			resource: 'sso',
			resourceId,
			args,
			result: 'ok'
		});
	}

	listProviders(principal: Principal): SsoProviderView[] {
		this.#requireRead(principal);
		return core.ctx.sqlite
			.query<ProviderRow, [string]>(
				'SELECT * FROM sso_providers WHERE org_id = ? ORDER BY name COLLATE NOCASE'
			)
			.all(principal.orgId)
			.map(view);
	}

	getProvider(principal: Principal, id: string): SsoProviderView {
		this.#requireRead(principal);
		return view(this.#provider(principal.orgId, id));
	}

	/** Whether a provider is enabled, for the management toggle (needs manage, not just read). */
	providerEnabled(principal: Principal, id: string): boolean {
		this.#requireManage(principal);
		return this.#provider(principal.orgId, id).enabled === 1;
	}

	/**
	 * The IdP sign-out endpoint for a member's SAML session. A specific provider id is honoured only
	 * inside the caller's organisation; otherwise the provider the user last signed in with is used
	 * (`account.providerId`, written by the plugin). Any member can sign out, so this deliberately
	 * needs no `sso:read` grant.
	 */
	resolveLogoutTarget(principal: Principal, providerId?: string): SsoLogoutTarget {
		let row: ProviderRow | null = null;
		if (providerId) {
			row = core.ctx.sqlite
				.query<ProviderRow, [string, string]>(
					'SELECT * FROM sso_providers WHERE org_id = ? AND id = ?'
				)
				.get(principal.orgId, providerId);
		} else {
			row = core.ctx.sqlite
				.query<ProviderRow, [string, string]>(
					`SELECT p.* FROM sso_providers p
					 JOIN account a ON a.providerId = p.id AND a.userId = ?
					 WHERE p.org_id = ? AND p.protocol = 'saml' AND p.enabled = 1
					 ORDER BY a.updatedAt DESC LIMIT 1`
				)
				.get(principal.userId, principal.orgId);
		}
		if (!row || row.protocol !== 'saml')
			return { providerId: row?.id ?? null, sloUrl: null, sloBinding: 'redirect' };
		return {
			providerId: row.id,
			sloUrl: row.slo_url ? normalizeSsoSloUrl(row.slo_url) : null,
			sloBinding: isSsoSamlSloBinding(row.slo_binding) ? row.slo_binding : 'redirect'
		};
	}

	/**
	 * `reservedId` is the id `reserveSsoProviderId` handed the dashboard, so the redirect URI an
	 * admin already registered at the IdP stays right. The REST API does not take one.
	 */
	async createProvider(
		principal: Principal,
		rawInput: SsoProviderInput,
		reservedId?: string
	): Promise<SsoProviderView> {
		this.#requireManage(principal);
		const protocol = rawInput.protocol ?? 'oidc';
		if (!isSsoProtocol(protocol)) throw new ValidationError('Choose either OIDC or SAML.');
		if (protocol === 'saml' && rawInput.preset)
			throw new ValidationError('A preset is an OIDC configuration; choose OIDC or remove the preset.');
		const input = protocol === 'oidc' ? applyPreset(rawInput) : rawInput;
		assertProviderFields({ ...input, protocol }, { requireSecret: protocol === 'oidc' });
		if (reservedId !== undefined && !PROVIDER_ID.test(reservedId))
			throw new ValidationError(
				'The reserved provider id is not valid. Reload the page and try again.'
			);
		// One provider per organisation in this slice: `sso_domains` has no provider id, so routing
		// must be unambiguous. The plugin supports several; adding that needs a domain→provider link.
		const existing = core.ctx.sqlite
			.query<{ count: number }, [string]>(
				'SELECT count(*) AS count FROM sso_providers WHERE org_id = ?'
			)
			.get(principal.orgId);
		if ((existing?.count ?? 0) > 0)
			throw new ConflictError('This organisation already has an SSO provider. Edit it instead.');
		const name = cleanName(input.name);
		const now = this.#now();
		const id = reservedId ?? newId('sso_');

		if (protocol === 'saml') {
			const saml = await resolveSaml(input, id);
			const claims = cleanClaims(input.claims, DEFAULT_SAML_CLAIMS);
			try {
				core.ctx.sqlite.run(
					`INSERT INTO sso_providers
					 (id, org_id, name, protocol, issuer, client_id, client_secret_sealed, discovery_url,
					  authorization_endpoint, token_endpoint, jwks_endpoint, scopes_json,
					  claim_email, claim_name, claim_groups, entry_point, cert, certs_json, slo_url,
					  slo_binding, callback_url, sp_entity_id, audience, want_assertions_signed,
					  identifier_format, enabled, created_by, created_at, updated_at)
					 VALUES (?, ?, ?, 'saml', ?, '', '', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						principal.orgId,
						name,
						saml.entityId,
						saml.metadataUrl,
						JSON.stringify(DEFAULT_SCOPES),
						claims.email,
						claims.name,
						claims.groups,
						saml.entryPoint,
						saml.certs[0]!,
						JSON.stringify(saml.certs.slice(1)),
						saml.sloUrl,
						saml.sloBinding,
						ssoSamlAcs(id),
						saml.spEntityId,
						saml.audience,
						saml.wantAssertionsSigned ? 1 : 0,
						saml.identifierFormat,
						input.enabled === false ? 0 : 1,
						principal.userId,
						now,
						now
					]
				);
			} catch (cause) {
				if (String(cause).includes('UNIQUE'))
					throw new ConflictError('This organisation already has a provider for that issuer.');
				throw cause;
			}
			syncSsoProviders();
			this.#audit(principal, 'sso.provider.create', id, {
				name,
				protocol,
				issuer: saml.entityId,
				entryPoint: saml.entryPoint,
				spEntityId: saml.spEntityId,
				metadataUrl: saml.metadataUrl,
				certificateCount: saml.certs.length,
				sloUrl: saml.sloUrl,
				sloBinding: saml.sloBinding,
				hasCertificate: true
			});
			return view(this.#provider(principal.orgId, id));
		}

		const issuer = normalizeIssuer(input.issuer!);
		const clientId = cleanClientId(input.clientId!);
		const clientSecret = cleanSecret(input.clientSecret);
		if (!clientSecret) throw new ValidationError('The client secret is required.');
		const discoveryUrl = optionalUrl(input.discoveryUrl, 'The discovery URL');
		const scopes = cleanScopes(input.scopes);
		const claims = cleanClaims(input.claims);
		const endpoints = await discover(issuer, discoveryUrl);
		try {
			core.ctx.sqlite.run(
				`INSERT INTO sso_providers
				 (id, org_id, name, protocol, issuer, client_id, client_secret_sealed, discovery_url,
				  authorization_endpoint, token_endpoint, jwks_endpoint, scopes_json,
				  claim_email, claim_name, claim_groups, enabled, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, 'oidc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					principal.orgId,
					name,
					endpoints.issuer,
					clientId,
					core.ctx.secrets.seal(principal.orgId, clientSecret),
					endpoints.discoveryUrl,
					endpoints.authorizationEndpoint,
					endpoints.tokenEndpoint,
					endpoints.jwksEndpoint,
					JSON.stringify(scopes),
					claims.email,
					claims.name,
					claims.groups,
					input.enabled === false ? 0 : 1,
					principal.userId,
					now,
					now
				]
			);
		} catch (cause) {
			if (String(cause).includes('UNIQUE'))
				throw new ConflictError('This organisation already has a provider for that issuer.');
			throw cause;
		}
		syncSsoProviders();
		this.#audit(principal, 'sso.provider.create', id, {
			name,
			protocol,
			issuer: endpoints.issuer,
			clientId,
			scopes,
			preset: rawInput.preset?.id ?? null
		});
		return view(this.#provider(principal.orgId, id));
	}

	async updateProvider(
		principal: Principal,
		id: string,
		rawInput: Partial<SsoProviderInput>
	): Promise<SsoProviderView> {
		this.#requireManage(principal);
		const existing = this.#provider(principal.orgId, id);
		const protocol: SsoProtocol = existing.protocol === 'saml' ? 'saml' : 'oidc';
		if (rawInput.protocol !== undefined && rawInput.protocol !== protocol)
			throw new ValidationError(
				'Remove the provider and add a new one to change its protocol. Existing sign-ins keep working until then.'
			);
		const input = protocol === 'oidc' ? applyPreset(rawInput) : rawInput;
		const name = input.name === undefined ? existing.name : cleanName(input.name);

		if (protocol === 'saml') {
			if (input.preset)
				throw new ValidationError('A preset is an OIDC configuration; choose OIDC instead.');
			const saml = await resolveSaml(input, id, existing);
			const claims = cleanClaims(input.claims, {
				email: existing.claim_email,
				name: existing.claim_name,
				groups: existing.claim_groups
			});
			try {
				core.ctx.sqlite.run(
					`UPDATE sso_providers SET
					   name = ?, issuer = ?, discovery_url = ?, claim_email = ?, claim_name = ?,
					   claim_groups = ?, entry_point = ?, cert = ?, certs_json = ?, slo_url = ?,
					   slo_binding = ?, callback_url = ?, sp_entity_id = ?, audience = ?,
					   want_assertions_signed = ?, identifier_format = ?, enabled = ?, updated_at = ?
					 WHERE org_id = ? AND id = ?`,
					[
						name,
						saml.entityId,
						saml.metadataUrl,
						claims.email,
						claims.name,
						claims.groups,
						saml.entryPoint,
						saml.certs[0]!,
						JSON.stringify(saml.certs.slice(1)),
						saml.sloUrl,
						saml.sloBinding,
						ssoSamlAcs(id),
						saml.spEntityId,
						saml.audience,
						saml.wantAssertionsSigned ? 1 : 0,
						saml.identifierFormat,
						input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
						this.#now(),
						principal.orgId,
						id
					]
				);
			} catch (cause) {
				if (String(cause).includes('UNIQUE'))
					throw new ConflictError('This organisation already has a provider for that issuer.');
				throw cause;
			}
			syncSsoProviders();
			this.#audit(principal, 'sso.provider.update', id, {
				name,
				protocol,
				issuer: saml.entityId,
				entryPoint: saml.entryPoint,
				spEntityId: saml.spEntityId,
				metadataUrl: saml.metadataUrl,
				certificateCount: saml.certs.length,
				sloUrl: saml.sloUrl,
				sloBinding: saml.sloBinding
			});
			return view(this.#provider(principal.orgId, id));
		}

		const issuer = normalizeIssuer(input.issuer ?? existing.issuer);
		const clientId =
			input.clientId === undefined ? existing.client_id : cleanClientId(input.clientId);
		const secret = cleanSecret(input.clientSecret);
		const discoveryUrl =
			input.discoveryUrl === undefined
				? existing.discovery_url
				: optionalUrl(input.discoveryUrl, 'The discovery URL');
		const scopes =
			input.scopes === undefined
				? (JSON.parse(existing.scopes_json) as string[])
				: cleanScopes(input.scopes);
		const claims = cleanClaims(input.claims, {
			email: existing.claim_email,
			name: existing.claim_name,
			groups: existing.claim_groups
		});

		// Discovery is only re-fetched when the identity boundary changes, so editing a name or a
		// claim mapping does not need the IdP to be reachable.
		// The stored issuer is verbatim (maybe with a trailing slash); compare it the way input is.
		const rediscover =
			issuer !== normalizeIssuer(existing.issuer) ||
			discoveryUrl !== existing.discovery_url ||
			!existing.authorization_endpoint ||
			!existing.token_endpoint ||
			!existing.jwks_endpoint;
		const endpoints = rediscover
			? await discover(issuer, discoveryUrl)
			: {
					issuer: existing.issuer,
					discoveryUrl: existing.discovery_url,
					authorizationEndpoint: existing.authorization_endpoint!,
					tokenEndpoint: existing.token_endpoint!,
					jwksEndpoint: existing.jwks_endpoint!
				};

		try {
			core.ctx.sqlite.run(
				`UPDATE sso_providers SET
				   name = ?, issuer = ?, client_id = ?, client_secret_sealed = ?, discovery_url = ?,
				   authorization_endpoint = ?, token_endpoint = ?, jwks_endpoint = ?, scopes_json = ?,
				   claim_email = ?, claim_name = ?, claim_groups = ?, enabled = ?, updated_at = ?
				 WHERE org_id = ? AND id = ?`,
				[
					name,
					endpoints.issuer,
					clientId,
					secret ? core.ctx.secrets.seal(principal.orgId, secret) : existing.client_secret_sealed,
					endpoints.discoveryUrl,
					endpoints.authorizationEndpoint,
					endpoints.tokenEndpoint,
					endpoints.jwksEndpoint,
					JSON.stringify(scopes),
					claims.email,
					claims.name,
					claims.groups,
					input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
					this.#now(),
					principal.orgId,
					id
				]
			);
		} catch (cause) {
			if (String(cause).includes('UNIQUE'))
				throw new ConflictError('This organisation already has a provider for that issuer.');
			throw cause;
		}
		syncSsoProviders();
		this.#audit(principal, 'sso.provider.update', id, {
			name,
			protocol,
			issuer: endpoints.issuer,
			clientId,
			scopes,
			preset: rawInput.preset?.id ?? null
		});
		return view(this.#provider(principal.orgId, id));
	}

	/**
	 * Rotate a SAML provider's SP signing key (IAM.md §8.3). The new key signs from now on; the
	 * previous certificate stays in the published metadata for the rollover window so the IdP can
	 * be updated without rejecting requests in the meantime.
	 */
	rotateSpSigningKey(principal: Principal, id: string): SsoProviderView {
		this.#requireManage(principal);
		const row = this.#provider(principal.orgId, id);
		if (row.protocol !== 'saml')
			throw new ValidationError('Only a SAML provider signs requests with an SP key.');
		const key = spKeys.rotate(id);
		syncSsoProviders();
		this.#audit(principal, 'sso.provider.sp_key.rotate', id, {
			name: row.name,
			certificate: key.certificatePem,
			previousCertificatePublishedUntil: key.previousPublishedUntil
		});
		return view(this.#provider(principal.orgId, id));
	}

	removeProvider(principal: Principal, id: string): void {
		this.#requireManage(principal);
		const row = this.#provider(principal.orgId, id);
		core.ctx.sqlite.run('DELETE FROM sso_providers WHERE org_id = ? AND id = ?', [
			principal.orgId,
			id
		]);
		this.removeGroupMappingsForProvider(principal.orgId, id);
		// The SP key belongs to this provider only; a replacement provider gets a fresh one.
		spKeys.remove(id);
		syncSsoProviders();
		this.#audit(principal, 'sso.provider.delete', id, { name: row.name, issuer: row.issuer });
	}

	listDomains(principal: Principal): SsoDomainView[] {
		this.#requireRead(principal);
		return core.ctx.sqlite
			.query<DomainRow, [string]>(
				'SELECT * FROM sso_domains WHERE org_id = ? ORDER BY domain COLLATE NOCASE'
			)
			.all(principal.orgId)
			.map(domainView);
	}

	/** Re-check at most one batch of domains whose last check is a day old (IAM.md §8.3). */
	async recheckDueDomains(principal: Principal): Promise<SsoDomainView[]> {
		this.#requireRead(principal);
		const now = this.#now();
		const due = core.ctx.sqlite
			.query<DomainRow, [string, number, number]>(
				`SELECT * FROM sso_domains
				 WHERE org_id = ? AND (last_checked_at IS NULL OR last_checked_at <= ?)
				 ORDER BY COALESCE(last_checked_at, 0) ASC LIMIT ?`
			)
			.all(principal.orgId, now - SSO_RECHECK_MS, RECHECK_BATCH);
		for (const row of due) await this.#check(row);
		if (due.length > 0) syncSsoProviders();
		return this.listDomains(principal);
	}

	async addDomain(principal: Principal, raw: string): Promise<SsoDomainView> {
		this.#requireManage(principal);
		const domain = normalizeSsoDomain(raw);
		if (!domain) throw new ValidationError('Enter a bare domain, for example example.com.');
		const claimed = core.ctx.sqlite
			.query<{ org_id: string }, [string]>('SELECT org_id FROM sso_domains WHERE domain = ?')
			.get(domain);
		if (claimed)
			throw new ConflictError(
				claimed.org_id === principal.orgId
					? `${domain} is already listed for this organisation.`
					: `${domain} is already claimed by another organisation.`
			);
		const token = randomToken(24);
		core.ctx.sqlite.run(
			'INSERT INTO sso_domains (org_id, domain, txt_token, verified_at, last_checked_at) VALUES (?, ?, ?, NULL, NULL)',
			[principal.orgId, domain, token]
		);
		this.#audit(principal, 'sso.domain.create', domain, { domain });
		const row = this.#domain(principal.orgId, domain);
		await this.#check(row);
		syncSsoProviders();
		return domainView(this.#domain(principal.orgId, domain));
	}

	async verifyDomain(principal: Principal, raw: string): Promise<SsoDomainView> {
		this.#requireManage(principal);
		const domain = normalizeSsoDomain(raw);
		if (!domain) throw new ValidationError('Enter a bare domain, for example example.com.');
		const row = this.#domain(principal.orgId, domain);
		await this.#check(row);
		syncSsoProviders();
		const current = this.#domain(principal.orgId, domain);
		this.#audit(principal, 'sso.domain.verify', domain, {
			domain,
			verified: current.verified_at !== null
		});
		return domainView(current);
	}

	removeDomain(principal: Principal, raw: string): void {
		this.#requireManage(principal);
		const domain = normalizeSsoDomain(raw);
		if (!domain) throw new ValidationError('Enter a bare domain, for example example.com.');
		this.#domain(principal.orgId, domain);
		core.ctx.sqlite.run('DELETE FROM sso_domains WHERE org_id = ? AND domain = ?', [
			principal.orgId,
			domain
		]);
		syncSsoProviders();
		this.#audit(principal, 'sso.domain.delete', domain, { domain });
	}

	// ------------------------------------------------------------ group mapping (I19, §8.3)

	listGroupMappings(principal: Principal): SsoGroupMappingView[] {
		this.#requireRead(principal);
		try {
			return core.ctx.sqlite
				.query<GroupMappingRow & { group_name: string }, [string]>(
					`SELECT m.*, g.name AS group_name
					 FROM sso_group_mappings m
					 JOIN iam_groups g ON g.id = m.group_id AND g.org_id = m.org_id
					 WHERE m.org_id = ?
					 ORDER BY m.claim_value COLLATE NOCASE`
				)
				.all(principal.orgId)
				.map(mappingView);
		} catch (error) {
			// The migration may not be embedded in this build yet; the page still renders.
			if (String(error).includes('no such table')) return [];
			throw error;
		}
	}

	/** Map one IdP group claim value to one Skiff group. A re-save updates the target group. */
	saveGroupMapping(principal: Principal, input: SsoGroupMappingInput): SsoGroupMappingView {
		this.#requireManage(principal);
		this.#provider(principal.orgId, input.providerId);
		const claimValue = normalizeGroupClaim(input.claimValue);
		if (!claimValue)
			throw new ValidationError(
				`Enter an IdP group name (at most ${MAX_GROUP_CLAIM_LENGTH} characters).`
			);
		const group = core.ctx.sqlite
			.query<{ id: string; source: string }, [string, string]>(
				'SELECT id, source FROM iam_groups WHERE id = ? AND org_id = ?'
			)
			.get(input.groupId, principal.orgId);
		if (!group)
			throw new ValidationError('Choose a group in this organisation, or create one first.');
		if (group.source === 'scim')
			throw new ValidationError(
				'That group is managed by SCIM. Map the IdP claim to a local group instead.'
			);
		const now = this.#now();
		const existing = core.ctx.sqlite
			.query<GroupMappingRow, [string, string, string]>(
				'SELECT * FROM sso_group_mappings WHERE org_id = ? AND provider_id = ? AND claim_value = ?'
			)
			.get(principal.orgId, input.providerId, claimValue);
		const id = existing?.id ?? newId('sgm_');
		core.ctx.sqlite.run(
			`INSERT INTO sso_group_mappings (id, org_id, provider_id, claim_value, group_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (org_id, provider_id, claim_value)
			 DO UPDATE SET group_id = excluded.group_id`,
			[id, principal.orgId, input.providerId, claimValue, input.groupId, now]
		);
		this.#audit(principal, 'sso.group_mapping.save', id, {
			providerId: input.providerId,
			claimValue,
			groupId: input.groupId
		});
		return mappingView(
			core.ctx.sqlite
				.query<GroupMappingRow & { group_name: string }, [string, string]>(
					`SELECT m.*, g.name AS group_name
					 FROM sso_group_mappings m JOIN iam_groups g ON g.id = m.group_id
					 WHERE m.id = ? AND m.org_id = ?`
				)
				.get(id, principal.orgId)!
		);
	}

	removeGroupMapping(principal: Principal, id: string): void {
		this.#requireManage(principal);
		const row = core.ctx.sqlite
			.query<GroupMappingRow, [string, string]>(
				'SELECT * FROM sso_group_mappings WHERE id = ? AND org_id = ?'
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('SSO group mapping');
		core.ctx.sqlite.run('DELETE FROM sso_group_mappings WHERE id = ? AND org_id = ?', [
			id,
			principal.orgId
		]);
		this.#audit(principal, 'sso.group_mapping.delete', id, {
			providerId: row.provider_id,
			claimValue: row.claim_value,
			groupId: row.group_id
		});
	}

	/**
	 * Remove every mapping for a provider. Called when the provider is deleted so a later provider
	 * that reuses the id cannot inherit old access rules.
	 */
	removeGroupMappingsForProvider(orgId: string, providerId: string): number {
		return core.ctx.sqlite.run(
			'DELETE FROM sso_group_mappings WHERE org_id = ? AND provider_id = ?',
			[orgId, providerId]
		).changes;
	}

	/**
	 * The provider an email address routes to, for `/login`'s email-first step. Only a verified
	 * domain routes, and a provider can be disabled without deleting its configuration. The plugin
	 * is then asked to sign in by provider id, so its own domain matching is not relied on.
	 */
	resolveProviderForEmail(
		email: string
	): { orgId: string; domain: SsoDomainView; provider: SsoProviderView } | null {
		const rows = core.ctx.sqlite
			.query<DomainRow, []>('SELECT * FROM sso_domains WHERE verified_at IS NOT NULL')
			.all();
		const match = verifiedDomainForEmail(
			email,
			rows.map((row) => ({ domain: row.domain, verifiedAt: row.verified_at, row }))
		);
		if (!match) return null;
		const provider = core.ctx.sqlite
			.query<ProviderRow, [string]>(
				'SELECT * FROM sso_providers WHERE org_id = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1'
			)
			.get(match.row.org_id);
		if (!provider) return null;
		return { orgId: match.row.org_id, domain: domainView(match.row), provider: view(provider) };
	}

	/** Look up the TXT record and update the row. DNS failure is "not verified", not an exception. */
	async #check(row: DomainRow): Promise<boolean> {
		let verified = false;
		try {
			const records = await nodeDnsResolver.resolveTxt(row.domain);
			verified = hasSsoVerificationRecord(records, row.txt_token);
		} catch {
			// NXDOMAIN, a timeout or no TXT record all mean "not proven yet".
			verified = false;
		}
		const now = this.#now();
		core.ctx.sqlite.run(
			'UPDATE sso_domains SET verified_at = ?, last_checked_at = ? WHERE org_id = ? AND domain = ?',
			[verified ? (row.verified_at ?? now) : null, now, row.org_id, row.domain]
		);
		return verified;
	}
}

export const sso = new SsoService();
