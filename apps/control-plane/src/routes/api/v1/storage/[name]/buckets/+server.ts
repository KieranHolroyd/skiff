import type { RequestHandler } from './$types';
import { bucketCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Buckets in one storage instance. The agent converges them over the S3 API with the root key. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { buckets: core.storage.get(principal, event.params.name).buckets };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, bucketCreateSchema);
		return json({ bucket: core.storage.createBucket(principal, event.params.name, input) }, 201);
	});
