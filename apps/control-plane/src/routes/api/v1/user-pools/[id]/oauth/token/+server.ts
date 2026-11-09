import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * OIDC token endpoint for one pool. Accepts the ordinary `application/x-www-form-urlencoded`
 * body (or JSON for tests), and client credentials either in the body or HTTP Basic. Public
 * clients use PKCE and send no secret.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const body = await readTokenRequest(event.request);
		const basic = basicCredentials(event.request.headers.get('authorization'));
		const result = await core.userPoolEngine.token({
			poolId: event.params.id,
			grantType: body.get('grant_type') ?? '',
			code: body.get('code'),
			redirectUri: body.get('redirect_uri'),
			clientId: body.get('client_id') ?? basic?.clientId ?? '',
			clientSecret: body.get('client_secret') ?? basic?.clientSecret ?? null,
			codeVerifier: body.get('code_verifier')
		});
		return json(result, 200, {
			'cache-control': 'no-store',
			pragma: 'no-cache'
		});
	});

async function readTokenRequest(request: Request): Promise<URLSearchParams> {
	const type = request.headers.get('content-type') ?? '';
	if (type.includes('application/json')) {
		const value = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const params = new URLSearchParams();
		for (const [key, entry] of Object.entries(value))
			if (entry !== null && entry !== undefined) params.set(key, String(entry));
		return params;
	}
	return new URLSearchParams(await request.text());
}

function basicCredentials(header: string | null): { clientId: string; clientSecret: string } | null {
	if (!header?.startsWith('Basic ')) return null;
	try {
		const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
		const separator = decoded.indexOf(':');
		if (separator < 0) return null;
		return {
			clientId: decodeURIComponent(decoded.slice(0, separator)),
			clientSecret: decodeURIComponent(decoded.slice(separator + 1))
		};
	} catch {
		return null;
	}
}
