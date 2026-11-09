import type { RequestHandler } from './$types';
import { appVolumeRestoreSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Restore a snapshot into a new volume of the same project; never over the source. */

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeRestoreSchema);
		return json(
			{
				volume: core.appVolumes.lifecycle.restore(
					principal,
					project,
					event.params.name,
					event.params.snapshotId,
					input,
				),
			},
			202,
		);
	});
