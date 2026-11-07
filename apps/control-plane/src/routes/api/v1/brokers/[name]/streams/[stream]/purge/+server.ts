import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Remove every message from a stream; the stream and its consumers stay (D124). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.stream.purge', { stream: event.params.stream });
		return nodeTaskResponse(principal, task, event.url);
	});
