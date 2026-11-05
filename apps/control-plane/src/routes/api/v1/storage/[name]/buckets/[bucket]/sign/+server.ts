import type { RequestHandler } from './$types';
import { storageShareLinkSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Mint a share link for one object. The key is signed server-side with the instance's root key;
 * the response never contains a key. A download limit (GET only) is enforced by the platform
 * gateway, so those links point at `/share/storage/<token>` even for a public instance.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, storageShareLinkSchema);
		return core.storageObjects.share(principal, event.params.name, event.params.bucket, input);
	});
