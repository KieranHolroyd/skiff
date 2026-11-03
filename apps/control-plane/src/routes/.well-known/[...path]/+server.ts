import { auth } from '#lib/server/auth.js';
import type { RequestHandler } from './$types';

/**
 * MCP clients discover OAuth metadata at the origin root (RFC 8414 / RFC 9728), including
 * path-inserted variants such as /.well-known/oauth-protected-resource/mcp and
 * /.well-known/oauth-authorization-server/api/auth. Try Better Auth with the original root
 * path first (the mcp plugin serves root-level aliases), then under its base path.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const direct = await auth.handler(request.clone());
	if (direct.status !== 404) return direct;
	const target = new URL(url);
	target.pathname = `/api/auth${url.pathname}`;
	return auth.handler(new Request(target, request));
};
