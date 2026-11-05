import type { RequestHandler } from './$types';
import { storageAttachmentUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One storage attachment. PATCH replaces its bucket grants (the key's policy follows without a
 * restart); DELETE detaches, and the app re-activates without its `<PREFIX>_*` variables.
 */

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, storageAttachmentUpdateSchema);
		return {
			attachment: core.storage.updateAttachment(principal, project, event.params.name, input)
		};
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		core.storage.detach(principal, project, event.params.name);
		return { ok: true };
	});
