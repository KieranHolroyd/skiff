import { requireMcpAuth } from '@better-auth/mcp';
import { auth } from '#lib/server/auth.js';
import { mcpResource } from '#lib/server/config.js';
import { mcpHandler } from '#lib/server/mcp.js';
import type { RequestHandler } from './$types';

/**
 * Remote MCP endpoint (Streamable HTTP). requireMcpAuth verifies the bearer JWT against
 * our JWKS (signature, issuer, audience = mcpResource, expiry) and answers unauthenticated
 * calls with an RFC 9728 WWW-Authenticate challenge so clients can start OAuth.
 */
const handle = requireMcpAuth(
	auth,
	(request, claims) =>
		mcpHandler.fetch(request, {
			authInfo: {
				token: request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
				clientId: String(claims.azp ?? claims.client_id ?? ''),
				scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
				expiresAt: claims.exp,
				extra: { sub: claims.sub },
			},
		}),
	{ resource: mcpResource },
);

export const POST: RequestHandler = ({ request }) => handle(request);
export const GET: RequestHandler = ({ request }) => handle(request);
export const DELETE: RequestHandler = ({ request }) => handle(request);
