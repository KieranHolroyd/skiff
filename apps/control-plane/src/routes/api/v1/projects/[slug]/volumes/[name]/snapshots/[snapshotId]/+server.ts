import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One snapshot. Deleting it removes the archive from its recorded target, then the row. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return {
			snapshot: core.appVolumes.lifecycle.getSnapshot(principal, project, event.params.name, event.params.snapshotId),
		};
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		await core.appVolumes.lifecycle.deleteSnapshot(principal, project, event.params.name, event.params.snapshotId);
		return { ok: true };
	});
