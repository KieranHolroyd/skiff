import { policyState, savePolicies } from '../_lib/policies.server.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Policies: retention windows and new-database defaults. The other platform policies
 * are edited where they apply (see settings/_lib/policy-groups.ts).
 */

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return policyState();
};

export const actions: Actions = { savePolicies };
