import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Pool end users. Reading the list needs `userPool:manage-users` (IAM.md §11.2). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { users: core.userPools.listUsers(principal, event.params.id) };
	});
