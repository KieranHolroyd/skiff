import { core } from '#lib/server/core.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return { status: core.ingress.status(locals.principal!) };
};
