import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Restart the RustFS container (D82). The data dir, buckets and keys stay; the node re-applies
 * the unit on its next pull, so expect a short window of failed S3 requests.
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ storage: core.storage.restart(principal, event.params.name) }, 202);
	});
