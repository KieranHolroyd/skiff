import { error, fail } from '@sveltejs/kit';
import { canAdministerPlatform, canViewPlatform, type Principal } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	failStatus,
	formOptionalPositiveInt,
	formOptionalString,
	formString,
	toFormFailure
} from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Production access requests (docs/EMAIL.md §7.3): every org's request to leave the sandbox,
 * pending first. A platform admin approves (the org becomes active with the limits picked here) or
 * denies with a reason; `core.email` re-checks the caller and mails the requester either way.
 */

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!canViewPlatform(principal))
		error(403, 'Only a platform admin can see production access requests.');
	return {
		requests: core.email.listAccessRequests(principal, { limit: 200 }),
		canDecide: canAdministerPlatform(principal)
	};
};

function requireDecider(locals: App.Locals): Principal {
	if (!locals.principal || !canAdministerPlatform(locals.principal))
		error(403, 'Only a platform admin can decide production access requests.');
	return locals.principal;
}

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		const principal = requireDecider(locals);
		const data = await request.formData();
		const id = formString(data, 'id');
		const perDay = formOptionalPositiveInt(data, 'perDay');
		const perSecond = formOptionalPositiveInt(data, 'perSecond');
		const note = formOptionalString(data, 'note');
		const fieldErrors: Record<string, string> = {};
		if (perDay === null) fieldErrors.perDay = 'A whole number of at least 1.';
		if (perSecond === null) fieldErrors.perSecond = 'A whole number of at least 1.';
		if (!id) return fail(400, { message: 'Pick a request.' });
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors });
		try {
			const decided = await core.email.decideAccessRequest(principal, id, {
				decision: 'approve',
				...(perDay ? { perDay } : {}),
				...(perSecond ? { perSecond } : {}),
				...(note ? { note } : {})
			});
			return {
				success: `${decided.orgName ?? 'The organisation'} is out of the sandbox: ${decided.perDay?.toLocaleString('en')} a day, ${decided.perSecond} a second. The requester was emailed.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deny: async ({ request, locals }) => {
		const principal = requireDecider(locals);
		const data = await request.formData();
		const id = formString(data, 'id');
		const note = formOptionalString(data, 'note');
		if (!id) return fail(400, { message: 'Pick a request.' });
		if (!note)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: { note: 'Say why; the requester sees it.' }
			});
		try {
			const decided = await core.email.decideAccessRequest(principal, id, {
				decision: 'deny',
				note
			});
			return {
				success: `Request from ${decided.orgName ?? 'the organisation'} denied. The requester was emailed the reason.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}
};
