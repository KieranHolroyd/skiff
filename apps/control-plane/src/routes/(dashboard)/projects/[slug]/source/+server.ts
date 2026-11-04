import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Manifest for the source viewer: deployment metadata plus every canonical file path. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const deployment = event.url.searchParams.get('deployment') ?? undefined;
		const view = await core.source.view(principal, project, deployment);
		return new Response(JSON.stringify(view), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	});
