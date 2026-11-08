import { mailServerActions } from './_lib/mail-server.server.js';
import { sandboxActions } from './_lib/sandbox.server.js';
import { domainSetupActions, loadEmailHome } from './_lib/setup.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Email overview (docs/EMAIL.md §7, §9): the setup checklist until every step is done, then the
 * org's sending state, limits, reputation, domains and recent mail. The checklist's steps act in
 * place, so this page carries their actions too; each is the same code its own page runs.
 */
export const load: PageServerLoad = ({ locals }) => loadEmailHome(locals.principal!);

export const actions: Actions = {
	node: mailServerActions.node,
	...domainSetupActions,
	request: sandboxActions.request
};
