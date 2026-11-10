import { error, fail } from '@sveltejs/kit';
import type { WhatsNewDecision } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * What’s new after an update (docs/WHATS-NEW.md, D212).
 *
 * Only platform admins see the flow. Platform viewers can read it, but decisions are reserved
 * for principals that can change the setting; the service enforces both, this page only mirrors
 * the result.
 */

function principal(locals: App.Locals) {
	const current = locals.principal;
	if (!current || !core.ctx.platformIam.canView(current))
		error(403, 'Only platform admins can review what changed.');
	return current;
}

export const load: PageServerLoad = ({ locals }) => {
	return { whatsNew: core.whatsNew.view(principal(locals)) };
};

const DECISIONS: ReadonlySet<WhatsNewDecision> = new Set(['acknowledged', 'enabled', 'declined']);

export const actions: Actions = {
	decide: async ({ request, locals }) => {
		const current = principal(locals);
		const data = await request.formData();
		const itemId = String(data.get('itemId') ?? '');
		const decision = String(data.get('decision') ?? '') as WhatsNewDecision;
		if (!itemId || !DECISIONS.has(decision))
			return fail(400, { message: 'Choose a valid decision for that change.' });
		try {
			core.whatsNew.decide(current, itemId, decision);
			return { success: 'Decision saved.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	acknowledge: async ({ locals }) => {
		const current = principal(locals);
		try {
			core.whatsNew.acknowledge(current);
			return { success: 'All caught up.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}
};
