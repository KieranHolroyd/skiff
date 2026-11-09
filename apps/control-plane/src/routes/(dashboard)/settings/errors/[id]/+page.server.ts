import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../../../_lib/errors.js';
import { actorNames } from '../../../_lib/operations/actors.server.js';
import { canChangeErrors, formStatus, requireErrorViewer } from '../_lib/access.server.js';
import type { Actions, PageServerLoad } from './$types';

/** One server error issue: counts over time, its newest events and their stacks (D171). */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = requireErrorViewer(locals);
	try {
		const detail = core.serverErrors.get(principal, params.id);
		const users = actorNames([
			detail.issue.resolvedBy,
			...detail.events.map((event) => event.userId)
		]);
		return { ...detail, users, canChange: canChangeErrors(principal), now: Date.now() };
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
};

export const actions: Actions = {
	status: async ({ request, locals, params }) => {
		const principal = requireErrorViewer(locals);
		const status = formStatus((await request.formData()).get('status'));
		if (!status) return fail(400, { message: 'Choose resolved, ignored or unresolved.' });
		try {
			core.serverErrors.setStatus(principal, [params.id], status);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Marked ${status}.` };
	},

	delete: ({ locals, params }) => {
		const principal = requireErrorViewer(locals);
		try {
			core.serverErrors.delete(principal, [params.id]);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/settings/errors');
	}
};
