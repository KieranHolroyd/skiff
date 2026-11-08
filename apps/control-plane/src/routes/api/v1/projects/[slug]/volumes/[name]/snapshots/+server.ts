import type { RequestHandler } from './$types';
import { appVolumeSnapshotCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Snapshots of one app volume (docs/VOLUMES.md). A snapshot is queued here and run by the
 * volume's node, which streams a gzip tar to the backup target recorded on the snapshot.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { snapshots: core.appVolumes.lifecycle.listSnapshots(principal, project, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, appVolumeSnapshotCreateSchema);
		const snapshot = core.appVolumes.lifecycle.createSnapshot(principal, project, event.params.name, input);
		return json(
			{
				snapshot,
				...(snapshot.quiesce
					? {}
					: { warning: 'quiesce is off: a running writer is not paused, so the copy may be inconsistent.' }),
			},
			202,
		);
	});
