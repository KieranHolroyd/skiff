import { core } from '#lib/server/core.js';
import { summariseResources } from '../resources.js';
import type { RequestHandler } from './$types';

/**
 * Polled by the overview so CPU, memory and disk follow heartbeats without re-running the whole
 * page load (traffic queries and all). Same permission as the Nodes panel: a principal that may
 * not list nodes gets a 403 and the page stops polling.
 */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.principal) return Response.json({ message: 'Unauthorized' }, { status: 401 });
	let nodes;
	try {
		nodes = core.nodes.list(locals.principal);
	} catch {
		return Response.json({ message: 'Forbidden' }, { status: 403 });
	}
	return Response.json(summariseResources(nodes), { headers: { 'cache-control': 'no-store' } });
};
