import type { RequestHandler } from './$types';
import { bucketNameSchema, storageObjectDeleteSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Delete up to 1000 objects in one S3 DeleteObjects call. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketNameSchema.parse(event.url.searchParams.get('bucket') ?? '');
		const input = await readJson(event.request, storageObjectDeleteSchema);
		return core.storageObjects.remove(principal, event.params.name, bucket, input);
	});
