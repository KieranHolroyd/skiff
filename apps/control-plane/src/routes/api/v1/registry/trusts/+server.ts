import type { RequestHandler } from './$types';
import { registryOidcTrustCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * CI identities that may use the platform registry with their OIDC token (docs/REGISTRY.md G3):
 * a GitHub repository (and optional ref glob) → a repository or `<org>/*`, pull or push.
 */
export const GET: RequestHandler = (event) => route(() => ({ trusts: core.registry.listOidcTrusts(requirePrincipal(event)) }));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, registryOidcTrustCreateSchema);
		return json({ trust: core.registry.createOidcTrust(principal, input) }, 201);
	});
