import type { RequestHandler } from './$types.js';
import { appErrorSettingsUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { settings: core.appErrors.settings(principal, project) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appErrorSettingsUpdateSchema);
		return { settings: core.appErrors.updateSettings(principal, project, input) };
	});
