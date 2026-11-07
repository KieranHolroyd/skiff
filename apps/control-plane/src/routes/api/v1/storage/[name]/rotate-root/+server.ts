import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Stage a new root key (§5). RustFS restarts with it; once the node proves it works the key is
 * promoted, otherwise (refused, or no confirmation within 10 minutes) the previous key comes back.
 * Attached apps use scoped keys and do not restart.
 */
export const POST: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return json({ storage: core.storage.rotateRootKey(principal, event.params.name) }, 202);
	});

/** Cancel a staged rotation; the instance restarts with its current key. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { storage: core.storage.cancelRootKeyRotation(principal, event.params.name) };
	});
