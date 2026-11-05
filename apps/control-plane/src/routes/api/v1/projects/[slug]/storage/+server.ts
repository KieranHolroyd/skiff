import type { RequestHandler } from './$types';
import { storageAttachSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Storage instances attached to a project (S4). The project receives a scoped key as
 * `<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` and friends at activation; a
 * private instance also places the project on its node at the next deploy.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { attachments: core.storage.attachments(principal, project) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, storageAttachSchema);
		return json(core.storage.attach(principal, project, input), 201);
	});
