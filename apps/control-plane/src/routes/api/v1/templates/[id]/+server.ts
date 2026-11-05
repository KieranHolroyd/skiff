import type { RequestHandler } from './$types';
import { templateInstantiateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One template's form definition. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { template: core.templates.get(principal, event.params.id) };
	});

/**
 * Create a project from a template: `{ "values": { ... } }`. Credential values in `values` are
 * stored as project secrets; the response names them but never returns a value.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, templateInstantiateSchema);
		return core.templates.instantiate(principal, event.params.id, input.values);
	});
