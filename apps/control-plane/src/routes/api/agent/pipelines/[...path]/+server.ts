import type { RequestHandler } from './$types';
import { pipelineClaimRequestSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function bearer(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

/**
 * Pipeline runner protocol for build nodes (docs/PIPELINES.md W4). The node token only claims
 * work; everything a claimed job does afterwards uses that job's own token (`/api/pipeline/*`).
 */
export const POST: RequestHandler = async (event) => {
	const action = event.params.path?.replace(/^\/+/, '') ?? '';
	const token = bearer(event.request);
	return route(async () => {
		const node = core.nodes.authenticate(token);
		if (action === 'claim') {
			const input = await readJson(event.request, pipelineClaimRequestSchema);
			return (await core.pipelines.engine.claim(node.id, input)) ?? null;
		}
		return json({ error: 'not_found', action }, 404);
	});
};
