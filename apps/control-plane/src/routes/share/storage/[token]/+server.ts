import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';

/**
 * Redeem a platform share token. This route is intentionally unauthenticated: the opaque,
 * high-entropy token in the URL is the capability. It proxies only the method, bucket and key the
 * link was minted for, and GET links with a download limit are counted atomically before reading.
 */
export const GET: RequestHandler = (event) =>
	route(async () => core.storageObjects.redeem(event.params.token, event.request));

export const PUT: RequestHandler = (event) =>
	route(async () => core.storageObjects.redeem(event.params.token, event.request));
