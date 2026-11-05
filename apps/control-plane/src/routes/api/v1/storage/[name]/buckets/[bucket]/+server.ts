import type { RequestHandler } from './$types';
import { bucketUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One bucket. PATCH sets its anonymous access. DELETE asks the node to remove it: an empty bucket
 * goes, a non-empty one is refused unless `?force=1` (needs `storage:delete`), which empties it first.
 */

const truthy = (value: string | null) => value === '1' || value === 'true';

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, bucketUpdateSchema);
		return {
			bucket: core.storage.updateBucket(principal, event.params.name, event.params.bucket, input)
		};
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const force = truthy(event.url.searchParams.get('force'));
		return {
			bucket: core.storage.deleteBucket(principal, event.params.name, event.params.bucket, {
				force
			})
		};
	});
