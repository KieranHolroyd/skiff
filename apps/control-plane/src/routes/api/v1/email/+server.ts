import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Email (docs/EMAIL.md, D114–D120): the org's sending state and, for platform admins, the mail
 * node settings and the platform records it needs. Every check lives in `core.email`.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const org = core.email.orgView(principal);
		const settings = core.ctx.platformIam.canView(principal)
			? { ...core.email.settings(), platformRecords: core.email.platformRecords() }
			: null;
		return { org, settings };
	});
