import type {
	EmailAccessRequestView,
	EmailOrgView,
	EmailSandboxAddressView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { canRequestAccess, sandboxActions } from '../_lib/sandbox.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The sandbox (docs/EMAIL.md §4.3, §7.3): the single addresses an org in the sandbox may send to,
 * each confirmed by its owner through a link, and the request to leave the sandbox.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let emailOrg: EmailOrgView | null = null;
	let addresses: EmailSandboxAddressView[] = [];
	let request: EmailAccessRequestView | null = null;
	let denied = false;
	try {
		emailOrg = core.email.orgView(principal);
		addresses = core.email.listSandboxAddresses(principal);
		request = core.email.accessRequest(principal);
	} catch {
		denied = true;
	}
	return { denied, emailOrg, addresses, request, canRequest: canRequestAccess(principal) };
};

export const actions: Actions = sandboxActions;
