import { docs } from '#lib/server/docs.js';
import type { RequestHandler } from './$types';

/**
 * The docs search index, fetched once by the search box when it is first used. The content is
 * baked into the build, so it only changes with a new release.
 */
export const GET: RequestHandler = async () =>
	Response.json(await docs.searchIndex(), {
		headers: { 'cache-control': 'private, max-age=3600' }
	});
