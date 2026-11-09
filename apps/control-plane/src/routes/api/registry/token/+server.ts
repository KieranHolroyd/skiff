import type { RequestHandler } from './$types';
import { CoreError, type RegistryClient } from '@yoal/core';
import { WORKLOAD_IDENTITY_AUDIENCE } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { principalFromRequest, principalFromYoalBearer } from '#lib/server/principal.js';

/**
 * The registry's Docker token realm (docs/REGISTRY.md §4.1). zot answers an unauthenticated
 * request with `WWW-Authenticate: Bearer realm=<this>`; Docker, Podman and buildah then ask here
 * with Basic auth. The password is a Yoal API key (`yoal_…`, any username), a node's per-workload
 * pull login (`workload.<id>`), a pipeline job's token (`job.<id>`), a GitHub Actions OIDC token
 * (username `github-oidc`, G3), or — new in I16/I18 — a Yoal workload or STS token, which can
 * also arrive as `Authorization: Bearer`. The answer grants only what the caller's `image:*`
 * permissions allow, in its own org, narrowed by the token's `scope`/`resources`.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const client = await clientFrom(request);
	try {
		const token = await core.registry.authorize(client, url.searchParams.get('service'), url.searchParams.getAll('scope'));
		return Response.json(token, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		const status = error instanceof CoreError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Token request failed.';
		return Response.json(
			{ errors: [{ code: status === 401 ? 'UNAUTHORIZED' : 'DENIED', message }] },
			{
				status,
				headers: status === 401 ? { 'www-authenticate': 'Basic realm="Yoal registry"' } : {},
			},
		);
	}
};

async function clientFrom(request: Request): Promise<RegistryClient> {
	const header = request.headers.get('authorization') ?? '';
	if (header.startsWith('Basic ')) {
		const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
		const colon = decoded.indexOf(':');
		const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
		const password = colon >= 0 ? decoded.slice(colon + 1) : '';
		if (password.startsWith('yoal_')) {
			// Verify the API key exactly as the REST API does, then hand core a principal.
			const principal = await principalFromRequest(
				new Request(request.url, { headers: { authorization: `Bearer ${password}` } }),
			);
			return principal ? { kind: 'principal', principal } : { kind: 'anonymous' };
		}
		if (password.split('.').length === 3) {
			// Docker always sends Basic auth, so a workload/STS token may arrive as the password.
			// It names a service account in its own org; `issueToken` never crosses namespaces.
			const principal = await principalFromYoalBearer(password, request, {
				workloadAudiences: [WORKLOAD_IDENTITY_AUDIENCE],
				stsAudiences: [WORKLOAD_IDENTITY_AUDIENCE, core.ctx.config.platformOrigin],
			});
			if (principal) return { kind: 'principal', principal };
		}
		return { kind: 'login', username, password };
	}
	if (header.startsWith('Bearer ')) {
		const principal = await principalFromRequest(request);
		return principal ? { kind: 'principal', principal } : { kind: 'anonymous' };
	}
	return { kind: 'anonymous' };
}
