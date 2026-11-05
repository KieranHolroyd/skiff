import type { RequestHandler } from './$types';
import { backupTargetUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { target: core.backupTargets.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, backupTargetUpdateSchema);
		return core.backupTargets.update(principal, event.params.id, input);
	});

export const PUT = PATCH;

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.backupTargets.delete(principal, event.params.id);
		return { deleted: true };
	});
