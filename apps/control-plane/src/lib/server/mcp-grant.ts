import { createResourceServerChallenge } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';

/**
 * The answer `/mcp` gives a valid JWT whose grant was revoked under Settings → Connected apps.
 * It is the same RFC 9728 challenge an unauthenticated call gets, so an MCP client throws the
 * token away and starts authorization again; the user sees the consent screen.
 */
export function grantRevokedResponse(resource: string): Response {
	const message = 'This app was disconnected from Yoal. Connect it again to continue.';
	const challenge = createResourceServerChallenge(new APIError('UNAUTHORIZED', { message }), resource);
	const headers = new Headers({ 'content-type': 'application/json' });
	const authenticate = (challenge?.headers as Record<string, string> | Headers | undefined) ?? undefined;
	const value = authenticate instanceof Headers ? authenticate.get('WWW-Authenticate') : authenticate?.['WWW-Authenticate'];
	if (value) headers.set('WWW-Authenticate', value);
	return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
		status: 401,
		headers,
	});
}
