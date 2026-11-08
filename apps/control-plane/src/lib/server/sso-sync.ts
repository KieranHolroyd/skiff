/**
 * Copies Skiff's SSO provider rows into the table Better Auth's `@better-auth/sso` plugin reads.
 *
 * `sso_providers` stays the source of truth: it is what Settings → SSO edits, what the sealed
 * secret belongs to, and what is scoped to the organisation. The plugin's `ssoProvider` row is a
 * derived, boot-migrated copy (`organizationId`, `providerId`, `issuer`, OIDC config, `domain`).
 * Nothing writes the plugin row except this sync:
 *
 * - enabled provider -> upsert the plugin row;
 * - disabled or removed provider -> delete it, so sign-in fails closed;
 * - the client secret is opened with the organisation key here and copied in the clear, because
 *   that is the shape the plugin's OIDC client reads. It never leaves the server.
 *
 * `domainVerification` stays off in the plugin: Skiff proves domain ownership itself
 * (`sso_domains`, the daily `skiff-verify=` TXT check) and only routes a verified domain to an IdP.
 * The plugin's `domain` is therefore the org's preferred verified domain, used only as a fallback
 * when a caller has no provider id.
 *
 * TODO(I19/SAML): copy `samlConfig` from the Skiff row when the provider protocol is `saml`; the
 * plugin already accepts it, and `sso_providers.protocol` reserves the value.
 */
import { SQLiteError } from 'bun:sqlite';
import { sqlite } from './db';
import { core } from './core';

interface ProviderRow {
	id: string;
	org_id: string;
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
		// `provisionUser` and the future group mapping (IAM.md I19, §8.3).
		mapping: {
			email: row.claim_email,
			name: row.claim_name,
			emailVerified: 'email_verified',
			image: 'picture',
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
		let secret: string;
		try {
			secret = core.ctx.secrets.open(row.org_id, row.client_secret_sealed);
		} catch (error) {
			// Fail closed: a provider whose secret cannot be opened must not keep a live plugin row.
			console.error(`[sso] could not open the client secret for provider ${row.id}:`, error);
			deletePluginRow(row.id);
			continue;
		}
		try {
			sqlite.run(
				`INSERT INTO "ssoProvider"
				   (id, issuer, domain, oidcConfig, samlConfig, userId, providerId, organizationId)
				 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
				 ON CONFLICT(providerId) DO UPDATE SET
				   issuer = excluded.issuer,
				   domain = excluded.domain,
				   oidcConfig = excluded.oidcConfig,
				   userId = excluded.userId,
				   organizationId = excluded.organizationId`,
				[
					row.id,
					row.issuer,
					preferredDomain(row.org_id),
					oidcConfig(row, secret),
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
		const existing = sqlite.query<{ providerId: string }, []>('SELECT providerId FROM "ssoProvider"').all();
		for (const row of existing) if (!keep.has(row.providerId)) deletePluginRow(row.providerId);
	} catch {
		// No plugin table yet.
	}
	return written;
}
