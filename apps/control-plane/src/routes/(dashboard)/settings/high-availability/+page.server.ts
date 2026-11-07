import { core } from '#lib/server/core.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireOwnerPage(locals);
	return { status: core.ingress.status(principal), failover: core.failover.status(principal) };
};
