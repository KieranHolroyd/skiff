import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Download one pool as a versioned JSON export (IAM.md I29, §11.2). Users include their password
 * hashes, so this needs `userPool:manage-users`; client and provider secrets are never present.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const exported = core.userPools.exportPool(principal, event.params.id);
		const filename = `${exported.pool.name || 'user-pool'}-${exported.pool.id}.json`;
		return new Response(JSON.stringify(exported, null, 2), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}"`,
				'cache-control': 'no-store'
			}
		});
	});
