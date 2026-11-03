import type { RequestHandler } from './$types';
import { sqlite } from '#lib/server/db.js';
import { contentDomain, objectStoreKind, platformOrigin, sharedDomain, smtp } from '#lib/server/config.js';
import { json } from '#lib/server/api.js';

/**
 * Public bootstrap status for the setup wizard (DESIGN §12). Exposes only non-sensitive facts:
 * whether an owner exists, the configured domains and the storage/email mode. The first user is
 * allowed to sign up; afterwards the platform is invite-only (D10).
 */
export const GET: RequestHandler = async () => {
	const count = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user').get();
	const nodes = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM nodes').get();
	return json({
		needsSetup: (count?.count ?? 0) === 0,
		platformOrigin,
		contentDomain,
		sharedDomain,
		objectStore: objectStoreKind,
		email: smtp ? 'smtp' : 'console',
		nodes: nodes?.count ?? 0,
	});
};
