import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Delete a stream and every message in it (D124). A function queue's stream comes back on its next use. */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.stream.delete', { stream: event.params.stream });
		return nodeTaskResponse(principal, task, event.url);
	});
