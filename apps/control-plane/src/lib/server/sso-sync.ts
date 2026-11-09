/**
 * Copies Skiff's SSO provider rows into the table Better Auth's `@better-auth/sso` plugin reads.
 *
 * `sso_providers` stays the source of truth: it is what Settings → SSO edits, what the sealed
 * secret belongs to, and what is scoped to the organisation. The plugin's `ssoProvider` row is a
 * derived, boot-migrated copy (`organizationId`, `providerId`, `issuer`, OIDC config or SAML
 * config, `domain`). Nothing writes the plugin row except this sync:
 *
 * - enabled provider -> upsert the plugin row;
 * - disabled or removed provider -> delete it, so sign-in fails closed;
 * - an OIDC client secret is opened with the organisation key here and copied in the clear,
 *   because that is the shape the plugin's OIDC client reads. It never leaves the server;
 * - a SAML provider copies its public certificate list, entry point, SP entity id and (when set)
 *   the IdP Single Logout Service, plus the sealed SP signing key that lets the plugin sign
 *   AuthnRequests and logout messages. SP key material lives in `settings` (`sso-sp.ts`), not in
 *   the plugin row: the row is rebuilt from it on every sync;
 *
 * `domainVerification` stays off in the plugin: Skiff proves domain ownership itself
 * (`sso_domains`, the daily `skiff-verify=` TXT check) and only routes a verified domain to an IdP.
 * The plugin's `domain` is therefore the org's preferred verified domain, used only as a fallback
 * when a caller has no provider id.
 */
import { SQLiteError } from 'bun:sqlite';
import {
	isSsoSamlSloBinding,
	normalizeSamlCertificates,
	ssoSamlAcsUrl,
	ssoSamlMetadataUrl,
	ssoSamlSloBindingUri,
	ssoSamlSloUrl,
	ssoSamlSpMetadataXml
} from '../../../../../packages/core/src/iam/sso.ts';
import { sqlite } from './db';
import { core } from './core';
import { platformOrigin } from './config';
import { SsoSpKeyStore } from './sso-sp';

/** SP key material for the SAML plugin: sealed in `settings`, opened only for the derived config. */
const spKeys = new SsoSpKeyStore({
	sqlite,
	secrets: core.ctx.secrets,
	now: () => core.ctx.now()
});

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
	/** Additional IdP signing certificates (JSON array of PEM blocks). */
	certs_json?: string | null;
	/** The IdP Single Logout Service URL and binding. */
	slo_url?: string | null;
	slo_binding?: string | null;
	callback_url: string | null;
	sp_entity_id: string | null;
	audience: string | null;
	want_assertions_signed: number;
	identifier_format: string | null;
	enabled: number;
	created_by: string;
}

function preferredDomain(orgId: string): string {
	const row = sqlite
		.query<{ domain: string }, [string]>(
			`SELECT domain FROM sso_domains
			 WHERE org_id = ?
			 ORDER BY verified_at IS NULL, verified_at DESC, domain COLLATE NOCASE
			 LIMIT 1`
		)
		.get(orgId);
	return row?.domain ?? '';
}

function oidcConfig(row: ProviderRow, clientSecret: string): string {
	return JSON.stringify({
		issuer: row.issuer,
		pkce: true,
		clientId: row.client_id,
		clientSecret,
		authorizationEndpoint: row.authorization_endpoint ?? undefined,
		discoveryEndpoint:
			row.discovery_url ?? `${row.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
		jwksEndpoint: row.jwks_endpoint ?? undefined,
		tokenEndpoint: row.token_endpoint ?? undefined,
		tokenEndpointAuthentication: 'client_secret_basic',
		scopes: JSON.parse(row.scopes_json) as string[],
		// The plugin maps email/name itself; the groups claim is exposed under `extraFields` for
		// `provisionUser`, which applies `sso_group_mappings` (IAM.md I19, §8.3).
		mapping: {
			email: row.claim_email,
			name: row.claim_name,
			emailVerified: 'email_verified',
			image: 'picture',
			extraFields: { groups: row.claim_groups }
		}
	});
}

/** The trusted IdP signing certificates: `cert` first, then the rollover extras. */
function certificateList(row: ProviderRow): string[] {
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

/**
 * The plugin's SAML shape. `issuer` here is the *SP* entity id (not the IdP's), so it defaults to
 * the metadata URL this server serves. The IdP's authority is `idpMetadata.entityID`, stored in
 * `sso_providers.issuer`.
 *
 * SP signing: the private key is sealed in `settings` (`sso-sp.ts`) and copied here because that
 * is the only shape the plugin reads. The certificate is public and also appears in the SP
 * metadata. `authnRequestsSigned` makes the plugin sign AuthnRequests and logout messages; the
 * plugin rejects that setting without a private key, so the key is generated before this config is
 * written. `spMetadata.metadata` is built by Skiff rather than the plugin because the plugin's
 * generator has no certificate input. IdP certificates are public; a rollover keeps the old and new
 * IdP certificates trusted at the same time, and the previous SP certificate is published in the
 * metadata for its overlap window.
 */
function samlConfig(row: ProviderRow): string {
	const spEntityId = row.sp_entity_id?.trim() || ssoSamlMetadataUrl(platformOrigin, row.id);
	const certificates = certificateList(row);
	const sloBinding = isSsoSamlSloBinding(row.slo_binding) ? row.slo_binding : 'redirect';
	const sloUrl = row.slo_url?.trim() || null;
	const spKey = spKeys.ensure(row.id);
	const spCertificates = spKey.previousCertificate
		? [spKey.certificatePem, spKey.previousCertificate]
		: [spKey.certificatePem];
	const spMetadata = ssoSamlSpMetadataXml({
		entityId: spEntityId,
		acsUrl: ssoSamlAcsUrl(platformOrigin, row.id),
		sloUrl: ssoSamlSloUrl(platformOrigin, row.id),
		certificates: spCertificates,
		wantAssertionsSigned: row.want_assertions_signed === 1,
		identifierFormat: row.identifier_format
	});
	return JSON.stringify({
		issuer: spEntityId,
		entryPoint: row.entry_point ?? undefined,
		cert: certificates,
		audience: row.audience ?? undefined,
		wantAssertionsSigned: row.want_assertions_signed === 1,
		identifierFormat: row.identifier_format ?? undefined,
		// Requests, including logout messages, are signed with this SP key. The plugin validates
		// that a private key exists whenever this is true.
		authnRequestsSigned: true,
		privateKey: spKey.privateKeyPem,
		idpMetadata: {
			entityID: row.issuer,
			cert: certificates,
			singleSignOnService: row.entry_point
				? [
						{
							Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
							Location: row.entry_point
						}
					]
				: undefined,
			// The plugin reads this when its `saml.enableSingleLogout` option is turned on.
			singleLogoutService: sloUrl
				? [{ Binding: ssoSamlSloBindingUri(sloBinding), Location: sloUrl }]
				: undefined
		},
		// Custom metadata: entity id, ACS URL, signing certificate and SLO endpoint in one document.
		spMetadata: { entityID: spEntityId, metadata: spMetadata },
		mapping: {
			email: row.claim_email,
			name: row.claim_name,
			// The plugin exposes SAML attributes under the canonical `groups` key, which
			// `sso-provision.ts` reads before falling back to the raw attribute name.
			extraFields: { groups: row.claim_groups }
		}
	});
}

function deletePluginRow(providerId: string): void {
	sqlite.run('DELETE FROM "ssoProvider" WHERE providerId = ?', [providerId]);
}

/** Rebuild the plugin's provider table from Skiff's rows. Safe to call after every mutation. */
export function syncSsoProviders(): number {
	let providers: ProviderRow[];
	try {
		providers = sqlite.query<ProviderRow, []>('SELECT * FROM sso_providers').all();
	} catch {
		return 0; // migration 0087 not applied yet
	}

	let written = 0;
	const keep = new Set<string>();
	for (const row of providers) {
		if (row.enabled !== 1) {
			deletePluginRow(row.id);
			continue;
		}
		const isSaml = row.protocol === 'saml';
		let oidc: string | null = null;
		let saml: string | null = null;
		if (isSaml) {
			if (!row.issuer) {
				console.error(`[sso] SAML provider ${row.id} has no IdP entity id; skipping it.`);
				deletePluginRow(row.id);
				continue;
			}
			if (certificateList(row).length === 0) {
				console.error(`[sso] SAML provider ${row.id} has no IdP signing certificate; skipping it.`);
				deletePluginRow(row.id);
				continue;
			}
			try {
				saml = samlConfig(row);
			} catch (error) {
				// Never let a broken key material or metadata document half-enable a provider: without
				// the derived config the plugin has nothing safe to read.
				console.error(`[sso] could not build the SAML config for provider ${row.id}:`, error);
				deletePluginRow(row.id);
				continue;
			}
		} else {
			let secret: string;
			try {
				secret = core.ctx.secrets.open(row.org_id, row.client_secret_sealed);
			} catch (error) {
				// Fail closed: a provider whose secret cannot be opened must not keep a live plugin row.
				console.error(`[sso] could not open the client secret for provider ${row.id}:`, error);
				deletePluginRow(row.id);
				continue;
			}
			oidc = oidcConfig(row, secret);
		}
		try {
			sqlite.run(
				`INSERT INTO "ssoProvider"
				   (id, issuer, domain, oidcConfig, samlConfig, userId, providerId, organizationId)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(providerId) DO UPDATE SET
				   issuer = excluded.issuer,
				   domain = excluded.domain,
				   oidcConfig = excluded.oidcConfig,
				   samlConfig = excluded.samlConfig,
				   userId = excluded.userId,
				   organizationId = excluded.organizationId`,
				[
					row.id,
					row.issuer,
					preferredDomain(row.org_id),
					oidc,
					saml,
					row.created_by,
					row.id,
					row.org_id
				]
			);
			keep.add(row.id);
			written += 1;
		} catch (error) {
			// The plugin's table is boot-migrated after Skiff's; a first boot can race the hook that
			// created it. Report without taking sign-in down.
			if (error instanceof SQLiteError && /no such table/i.test(error.message)) return written;
			console.error(`[sso] could not sync provider ${row.id} to Better Auth:`, error);
		}
	}

	// A provider deleted in Settings has no row above; remove its plugin copy too.
	try {
		const existing = sqlite
			.query<{ providerId: string }, []>('SELECT providerId FROM "ssoProvider"')
			.all();
		for (const row of existing) if (!keep.has(row.providerId)) deletePluginRow(row.providerId);
	} catch {
		// No plugin table yet.
	}
	return written;
}
