import { requireMcpAuth } from '@better-auth/mcp';
import { auth } from '#lib/server/auth.js';
import { mcpResource } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import { mcpHandler } from '#lib/server/mcp.js';
import { grantRevokedResponse } from '#lib/server/mcp-grant.js';
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

export const POST: RequestHandler = ({ request }) => handle(request);
export const GET: RequestHandler = ({ request }) => handle(request);
export const DELETE: RequestHandler = ({ request }) => handle(request);
