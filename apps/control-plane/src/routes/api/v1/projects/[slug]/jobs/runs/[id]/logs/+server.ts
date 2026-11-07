import type { RequestHandler } from './$types';
import { logLevels, type LogLevel } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** A run's output: the newest page, or everything after `?after=<cursor>`; `limit`, `level`, `q`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const params = event.url.searchParams;
		const after = params.get('after');
		const level = params.get('level');
		return core.jobs.runLogs(principal, project, event.params.id, {
			...(after !== null && Number.isFinite(Number(after)) ? { after: Number(after) } : {}),
			...(params.get('limit') ? { limit: Number(params.get('limit')) } : {}),
			...(level && (logLevels as readonly string[]).includes(level) ? { level: level as LogLevel } : {}),
			...(params.get('q') ? { q: params.get('q')! } : {}),
		});
	});
