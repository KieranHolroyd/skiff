import {
	ConflictError,
	NotFoundError,
	ValidationError,
	newId,
	nodeDnsResolver,
	randomToken
} from '@skiff/core';
import type { Principal } from '@skiff/contracts';
// The pure domain/TXT helpers live in core so they can be tested without SvelteKit or a database.
// `@skiff/core` does not export this module yet: IAM.md's SSO slice keeps the engine out of the
// core index until the Better Auth plugin lands, and this deep import is the one consumer.
import {
	SSO_RECHECK_MS,
	hasSsoVerificationRecord,
	normalizeSsoDomain,
	ssoVerificationRecord,
	verifiedDomainForEmail
} from '../../../../../packages/core/src/iam/sso.ts';
import { SsoPresetError, resolveSsoPreset, type SsoPresetValues } from '../sso-presets';
import { core } from './core';
import { platformOrigin } from './config';
import { syncSsoProviders } from './sso-sync';

/**
 * SSO providers and verified email domains (IAM.md I19, §8.3).
 *
 * `sso_providers` is the source of truth for configuration (issuer, sealed client secret, claim
 * mapping, enabled flag); `sso_domains` proves ownership with a `skiff-verify=` TXT record.
 * `sso-sync.ts` copies the enabled rows into Better Auth's boot-migrated `ssoProvider` table, which
 * `@better-auth/sso` reads for the actual OIDC sign-in. Settings never writes that table directly.
 *
 * What is real here: provider configuration, OIDC discovery at save time, domain TXT ownership
 * checks re-run daily, permission checks, email→provider routing for `/login`, and the callback URL
 * to register at the IdP. Sign-in and JIT provisioning run through Better Auth; group mapping, SAML
 * and SCIM are still to come.
 */

const MAX_NAME = 80;
const MAX_URL = 500;
const MAX_SECRET = 4000;
const MAX_CLAIM = 100;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** At most this many domains are re-checked in one visit, oldest first. */
const RECHECK_BATCH = 25;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const DEFAULT_CLAIMS = { email: 'email', name: 'name', groups: 'groups' };

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

export interface SsoClaims {
	email: string;
	name: string;
	groups: string;
}

export interface SsoProviderView {
	id: string;
	name: string;
	protocol: string;
	issuer: string;
	clientId: string;
	discoveryUrl: string | null;
	authorizationEndpoint: string | null;
	tokenEndpoint: string | null;
	jwksEndpoint: string | null;
	scopes: readonly string[];
	claims: SsoClaims;
	enabled: boolean;
	/** The secret is write-only; the UI only needs to know one is stored. */
	hasClientSecret: boolean;
	/** Register this with the IdP as the OIDC redirect URI. */
	callbackUrl: string;
	createdAt: number;
	updatedAt: number;
}

export interface SsoProviderInput {
	name: string;
	/** Required unless `preset` is given; a preset's issuer wins over this one. */
	issuer?: string;
	/**
	 * A ready-made set-up (`sso-presets.ts`, D180). It supplies the issuer and discovery URL, and
	 * the scopes and claims when the caller leaves those out.
	 */
	preset?: { id: string; values?: SsoPresetValues };
	clientId: string;
	clientSecret?: string;
	discoveryUrl?: string | null;
	scopes?: readonly string[];
	claims?: Partial<SsoClaims>;
	enabled?: boolean;
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

/** The redirect URI to register at the IdP for a provider id (Better Auth's OIDC callback). */
export function ssoCallbackUrl(providerId: string): string {
	return `${platformOrigin}/api/auth/sso/callback/${providerId}`;
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
	return {
		id: row.id,
		name: row.name,
		protocol: row.protocol,
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
		callbackUrl: ssoCallbackUrl(row.id),
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
	 * `reservedId` is the id `reserveSsoProviderId` handed the dashboard, so the redirect URI an
	 * admin already registered at the IdP stays right. The REST API does not take one.
	 */
	async createProvider(
		principal: Principal,
		rawInput: SsoProviderInput,
		reservedId?: string
	): Promise<SsoProviderView> {
		this.#requireManage(principal);
		const input = applyPreset(rawInput);
		if (!input.issuer) throw new ValidationError('The issuer is required, or choose a preset.');
		if (reservedId !== undefined && !PROVIDER_ID.test(reservedId))
			throw new ValidationError('The reserved provider id is not valid. Reload the page and try again.');
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
		const issuer = normalizeIssuer(input.issuer);
		const clientId = cleanClientId(input.clientId);
		const clientSecret = cleanSecret(input.clientSecret);
		if (!clientSecret) throw new ValidationError('The client secret is required.');
		const discoveryUrl = optionalUrl(input.discoveryUrl, 'The discovery URL');
		const scopes = cleanScopes(input.scopes);
		const claims = cleanClaims(input.claims);
		const endpoints = await discover(issuer, discoveryUrl);
		const now = this.#now();
		const id = reservedId ?? newId('sso_');
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
		const input = applyPreset(rawInput);
		const existing = this.#provider(principal.orgId, id);
		const name = input.name === undefined ? existing.name : cleanName(input.name);
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
			issuer: endpoints.issuer,
			clientId,
			scopes,
			preset: rawInput.preset?.id ?? null
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
