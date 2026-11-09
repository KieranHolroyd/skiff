import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Remove a platform role binding (IAM.md I24, §10). The service requires a platform admin. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.platformIam.unbind(principal, event.params.id!);
		return { deleted: true };
	});
