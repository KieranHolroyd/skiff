import type { RequestHandler } from './$types';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { sso } from '#lib/server/sso.js';
import { providerUpdateSchema } from '../../_schema.js';

/** One provider: read, edit or remove it. A blank `clientSecret` keeps the stored one. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return sso.getProvider(principal, event.params.id);
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, providerUpdateSchema);
		return sso.updateProvider(principal, event.params.id, input);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		sso.removeProvider(principal, event.params.id);
		return { ok: true };
	});
