import { core } from '#lib/server/core.js';
import { policyState, savePolicies } from '../_lib/policies.server.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireOwnerPage(locals);
	return {
		...policyState(),
		status: core.ingress.status(principal),
		failover: core.failover.status(principal)
	};
};

/** The ingress driver and hold-downs are platform policies, edited here. */
export const actions: Actions = { savePolicies };
