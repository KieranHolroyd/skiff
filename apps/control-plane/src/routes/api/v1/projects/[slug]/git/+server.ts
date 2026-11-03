import type { RequestHandler } from './$types';
import { gitSourceSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Per-project git source: one repository, branch, build command and output directory (D2). */
const handler: RequestHandler = async (event) => {
	const principal = requirePrincipal(event);
	const project = core.projects.requireRow(principal, event.params.slug);

	return route(async () => {
		if (event.request.method === 'GET') return core.builds.gitSource(principal, project);
		if (event.request.method === 'PUT' || event.request.method === 'POST') {
			const input = await readJson(event.request, gitSourceSchema);
			return core.builds.upsertGitSource(principal, project, input);
		}
		if (event.request.method === 'DELETE') {
			core.builds.removeGitSource(principal, project);
			return { ok: true };
		}
		return json({ error: 'method_not_allowed' }, 405);
	});
};

export const GET = handler;
export const PUT = handler;
export const POST = handler;
export const DELETE = handler;
