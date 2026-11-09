import type { RequestHandler } from './$types';
import { bucketUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One bucket's desired configuration. GET returns what the control plane wants plus the agent's
 * last convergence report; PATCH changes only the fields sent. Object lock is create-only, so it
 * is rejected here even when the client sends it.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { config: core.storage.getBucketConfig(principal, event.params.name, event.params.bucket) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, bucketUpdateSchema);
		return { config: core.storage.updateBucket(principal, event.params.name, event.params.bucket, input) };
	});
