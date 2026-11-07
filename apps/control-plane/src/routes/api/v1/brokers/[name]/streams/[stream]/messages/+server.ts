import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Read messages without consuming them: `?limit=` (≤ 50) from `?from=<seq>` or the oldest (D124). */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const limit = event.url.searchParams.get('limit');
		const from = event.url.searchParams.get('from');
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.stream.peek', {
			stream: event.params.stream,
			...(limit ? { limit: Number(limit) } : {}),
			...(from ? { fromSeq: Number(from) } : {})
		});
		return nodeTaskResponse(principal, task, event.url);
	});
