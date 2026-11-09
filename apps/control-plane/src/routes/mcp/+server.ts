import { requireMcpAuth } from '@better-auth/mcp';
import { WORKLOAD_IDENTITY_AUDIENCE } from '@yoal/contracts';
import { auth } from '#lib/server/auth.js';
import { mcpResource } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import { mcpHandler } from '#lib/server/mcp.js';
import { grantRevokedResponse } from '#lib/server/mcp-grant.js';
import { principalFromYoalBearer } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/**
 * Remote MCP endpoint (Streamable HTTP). requireMcpAuth verifies the bearer JWT against
 * our JWKS (signature, issuer, audience = mcpResource, expiry) and answers unauthenticated
 * calls with an RFC 9728 WWW-Authenticate challenge so clients can start OAuth.
 *
 * The JWT alone outlives a revoked grant (it is never stored), so each call also checks that the
 * user's grant for this client still stands (Settings → Connected apps): a revoked one gets the
 * same challenge, and the client has to ask for consent again.
 */
const handle = requireMcpAuth(
	auth,
	(request, claims) => {
		const clientId = String(claims.azp ?? claims.client_id ?? '');
		const userId = typeof claims.sub === 'string' ? claims.sub : '';
		if (userId && clientId) {
			const issuedAt = typeof claims.iat === 'number' ? claims.iat : undefined;
			if (!core.connectedApps.grantActive(userId, clientId, issuedAt)) return grantRevokedResponse(mcpResource);
			try {
				core.connectedApps.touch(userId, clientId);
			} catch (error) {
				console.warn('[mcp] could not record client use:', error);
			}
		}
		return mcpHandler.fetch(request, {
			authInfo: {
				token: request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
				clientId,
				scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
				expiresAt: claims.exp,
				extra: { sub: claims.sub },
			},
		});
	},
	{ resource: mcpResource },
);

/**
 * OAuth first (better-auth verifies the audience-bound user JWT). A workload or STS token is not
 * one of those, so a 401 from that path falls back to Yoal's ring: it must carry `aud` `yoal`
 * (or this MCP resource) and names a service account, whose bindings and token restriction become
 * the principal. Anything else keeps the original OAuth challenge so clients can start sign-in.
 */
async function handleWithYoalToken(request: Request): Promise<Response> {
	const response = await handle(request);
	if (response.status !== 401) return response;
	const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
	if (!token) return response;
	const principal = await principalFromYoalBearer(token, request, {
		workloadAudiences: [WORKLOAD_IDENTITY_AUDIENCE],
		stsAudiences: [WORKLOAD_IDENTITY_AUDIENCE, mcpResource],
	});
	if (!principal) return response;
	return mcpHandler.fetch(request, {
		authInfo: {
			token,
			clientId: `service-account:${principal.userId}`,
			scopes: [...principal.permissions],
			extra: { principal },
		},
	});
}

export const POST: RequestHandler = ({ request }) => handleWithYoalToken(request);
export const GET: RequestHandler = ({ request }) => handleWithYoalToken(request);
export const DELETE: RequestHandler = ({ request }) => handleWithYoalToken(request);
