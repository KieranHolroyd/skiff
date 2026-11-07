import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Delete one message by stream sequence (D124). */
export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.stream.deleteMessage', {
			stream: event.params.stream,
			seq: Number(event.params.seq)
		});
		return nodeTaskResponse(principal, task, event.url);
	});
