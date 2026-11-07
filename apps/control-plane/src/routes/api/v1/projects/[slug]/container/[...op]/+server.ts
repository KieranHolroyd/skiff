import type { RequestHandler } from './$types';
import { handleContainerConsole } from '#lib/server/container-console.js';
import { containerConsoleDeps } from '#lib/server/container-console-deps.js';

/**
 * Container console over REST (D127), for `skif container …` and scripts: the same calls as the
 * dashboard, authenticated by an API key or the session cookie.
 *
 *   GET    targets | inspect                        container:inspect
 *   GET    files?path= | files/preview | files/download   container:files
 *   POST   exec · GET exec/:id/stream (SSE) · POST exec/:id/input|resize · DELETE exec/:id
 *                                                    container:exec (people and API keys only)
 *   POST   restart                                  project:update
 *
 * Every call takes `?replica=<n>` for a multi-copy workload.
 */
const handle: RequestHandler = (event) =>
	handleContainerConsole(containerConsoleDeps, {
		principal: event.locals.principal,
		slug: event.params.slug,
		op: event.params.op,
		request: event.request,
		url: event.url
	});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
