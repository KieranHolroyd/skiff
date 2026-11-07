import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { nodeTaskResponse } from '#lib/server/node-tasks.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Run the function's `scheduled()` handler now for one of its crons (`{ cron }`, D124). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, z.unknown());
		const project = core.projects.requireRow(principal, event.params.slug);
		const task = core.nodeTasks.functionTask(principal, project, 'function.scheduled', body);
		return nodeTaskResponse(principal, task, event.url);
	});
