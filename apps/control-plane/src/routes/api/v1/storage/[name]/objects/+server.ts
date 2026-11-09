import type { RequestHandler } from './$types';
import { bucketNameSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * List a bucket's objects (D81). `prefix` + `delimiter=/` give the folder view the dashboard uses;
 * `token` is S3's continuation token. Paths are never accepted: the key travels in the query so a
 * slash in an object key cannot be confused with a route segment.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const bucket = bucketNameSchema.parse(params.get('bucket') ?? '');
		const limit = Number(params.get('limit') ?? 100);
		return core.storageObjects.list(principal, event.params.name, {
			bucket,
			prefix: params.get('prefix') ?? '',
			delimiter: params.get('delimiter') ?? '/',
			token: params.get('token') ?? undefined,
			limit: Number.isFinite(limit) ? limit : 100
		});
	});
