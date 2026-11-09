import type { RequestHandler } from './$types';
import { appVolumeAttachSchema, appVolumeDetachSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Attach/detach an app volume. A read-write attachment is refused when a single-writer volume is in use. */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeAttachSchema);
		return json(core.appVolumes.attach(principal, project, event.params.name, input), 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeDetachSchema);
		return { volume: core.appVolumes.detach(principal, project, event.params.name, input) };
	});
