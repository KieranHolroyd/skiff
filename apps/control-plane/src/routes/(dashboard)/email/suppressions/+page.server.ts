import { fail } from '@sveltejs/kit';
import { emailSuppressionCreateSchema, type EmailSuppressionView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** The core caps a list at this many rows. */
const LIMIT = 1000;

/** The org's suppression list (docs/EMAIL.md §7.1). */
export const load: PageServerLoad = ({ locals }) => {
	let suppressions: EmailSuppressionView[] = [];
	let denied = false;
	try {
		suppressions = core.email.listSuppressions(locals.principal!, { limit: LIMIT });
	} catch {
		denied = true;
	}
	return { denied, suppressions, truncated: suppressions.length >= LIMIT, limit: LIMIT };
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const data = await request.formData();
		const values = {
			address: formString(data, 'address'),
			reason: formString(data, 'reason') || 'manual'
		};
		const parsed = emailSuppressionCreateSchema.safeParse(values);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		try {
			const added = core.email.addSuppression(locals.principal!, parsed.data);
			return { success: `${added.address} is suppressed. Sends to it are dropped.` };
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), values });
		}
	},

	remove: async ({ request, locals }) => {
		const address = formString(await request.formData(), 'address');
		if (!address) return fail(400, { message: 'An address is required.' });
		try {
			core.email.removeSuppression(locals.principal!, address);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `${address} removed from the suppression list.` };
	}
};
