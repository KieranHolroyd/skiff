import { error } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { policyState, savePolicies } from '../_lib/policies.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !core.ctx.platformIam.can(principal, 'platform:ha'))
		error(403, 'High availability is for platform operators and admins.');
	return {
		...policyState(),
		status: core.ingress.status(principal),
		failover: core.failover.status(principal),
		/** The policy editor writes platform settings, which is admin-only. */
		canEditPolicies: core.ctx.platformIam.canAdminister(principal)
	};
};

/** The ingress driver and hold-downs are platform policies, edited here. */
export const actions: Actions = { savePolicies };
