import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Move messages from this dead-letter queue back into `to` (D124). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = (await readJson(event.request, z.record(z.string(), z.unknown()))) as Record<string, unknown>;
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.queue.redrive', {
			...body,
			from: event.params.queue
		});
		return nodeTaskResponse(principal, task, event.url);
	});
