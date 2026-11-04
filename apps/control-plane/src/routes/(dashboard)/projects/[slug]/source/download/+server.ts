import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { SOURCE_SECURITY_HEADERS } from '#lib/server/source.js';

/** The original release artifact, as deployed. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const deployment = event.url.searchParams.get('deployment') ?? undefined;
		const { deployment: view, zip } = await core.source.artifact(principal, project, deployment);
		const name = `${project.slug}-${view.shortId}.zip`;
		return new Response(zip as unknown as BodyInit, {
			headers: {
				...SOURCE_SECURITY_HEADERS,
				'content-type': 'application/zip',
				'content-length': String(zip.byteLength),
				'content-disposition': `attachment; filename="${name}"`,
				'cache-control': 'private, max-age=3600'
			}
		});
	});
