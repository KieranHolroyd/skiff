import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The newest JetStream stream listing the broker's node reported (D123). */
export const GET: RequestHandler = (event) =>
	route(() => core.brokers.queues(requirePrincipal(event), event.params.name));

/** Create a function queue's stream now instead of on first use (D124). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, z.unknown());
		const task = core.nodeTasks.brokerTask(principal, event.params.name, 'broker.queue.create', body);
		return nodeTaskResponse(principal, task, event.url);
	});
