import type { RequestHandler } from './$types';
import { backupTargetUpdateSchema } from '@yoal/contracts';
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
		// `?force=1` deletes a target that still holds backups; they stay listed as unavailable.
		const force = ['1', 'true'].includes(event.url.searchParams.get('force') ?? '');
		const { unavailableBackups } = core.backupTargets.delete(principal, event.params.id, { force });
		return { deleted: true, unavailableBackups };
	});
