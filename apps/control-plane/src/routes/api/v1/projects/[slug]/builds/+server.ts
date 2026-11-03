import type { RequestHandler } from './$types';
import { buildCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Build history and manual build triggers for a project. */
const handler: RequestHandler = async (event) => {
	const principal = requirePrincipal(event);
	const project = core.projects.requireRow(principal, event.params.slug);

	return route(async () => {
		if (event.request.method === 'GET') {
			const raw = Number(event.url.searchParams.get('limit') ?? 50);
			const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
			const full = event.url.searchParams.get('log') === 'full';
			return { builds: core.builds.list(principal, project, { limit, full }) };
		}
		if (event.request.method === 'POST') {
			const input = await readJson(event.request, buildCreateSchema);
			return json(core.builds.enqueue(principal, project, input), 201);
		}
		return json({ error: 'method_not_allowed' }, 405);
	});
};

export const GET = handler;
export const POST = handler;
