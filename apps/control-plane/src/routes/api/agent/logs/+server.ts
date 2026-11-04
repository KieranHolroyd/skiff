import type { RequestHandler } from './$types';
import { runtimeLogBatchSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function nodeToken(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

/**
 * Runtime log drain (DESIGN §8). Agents read journald through the privileged helper and POST
 * ordered batches here with their node token. The workload id resolves the project and deployment;
 * an agent can never write into another node's workload.
 */
const handler: RequestHandler = async ({ request }) =>
	route(async () => {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		const node = core.nodes.authenticate(nodeToken(request));
		const batch = await readJson(request, runtimeLogBatchSchema);
		const stored = core.logs.appendRuntime(node.id, batch);
		return { ok: true, stored };
	});

export const POST = handler;
