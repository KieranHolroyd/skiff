import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { nodeTaskDone } from '@skiff/contracts';

/** One queue or function tool task (D124); `?wait=<seconds>` (≤ 25) holds until it finishes. */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const task = core.nodeTasks.get(principal, event.params.id);
		const wait = Math.min(Math.max(Number(event.url.searchParams.get('wait') ?? 0) || 0, 0), 25);
		const current = wait > 0 && !nodeTaskDone(task) ? await core.nodeTasks.wait(principal, task, wait * 1000) : task;
		return json({ task: current });
	});
