import type { RequestHandler } from './$types';
import { databaseAttachSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Databases attached to a project (D56). The project receives `<PREFIX>_URL` and friends at
 * activation and is placed on the database's node at its next deploy.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { attachments: core.databases.attachments(principal, project) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, databaseAttachSchema);
		return json(core.databases.attach(principal, project, input), 201);
	});
