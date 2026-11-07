import type { RequestHandler } from './$types';
import { handleContainerConsole } from '#lib/server/container-console.js';
import { containerConsoleDeps } from '#lib/server/container-console-deps.js';

/**
 * Container console calls (D127): inspect, files and shells for a container project. The
 * dashboard session authenticates; the console token is added on the gateway hop and never
 * reaches the browser.
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
