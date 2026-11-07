import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import type { EmailDomainView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, toFormFailure } from '../../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	let domain: EmailDomainView;
	try {
		domain = core.email.getDomain(locals.principal!, params.name);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	// The breadcrumb shows the name as typed (mono), not capitalised.
	return { domain, crumbLabel: null };
};

export const actions: Actions = {
	check: async ({ locals, params }) => {
		try {
			const domain = await core.email.checkDomain(locals.principal!, params.name);
			const missing = domain.records.filter((record) => record.required && !record.ok).length;
			return {
				success:
					domain.status === 'verified'
						? `${domain.name} is verified.`
						: `${missing} required ${missing === 1 ? 'record is' : 'records are'} still missing. DNS can take a few minutes to update.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	sending: async ({ request, locals, params }) => {
		const sending = formBoolean(await request.formData(), 'sending');
		try {
			core.email.updateDomain(locals.principal!, params.name, { sending });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: sending
				? `Sending from ${params.name} is on.`
				: `Sending from ${params.name} is off; sends from it are refused with from_not_verified.`
		};
	},

	delete: async ({ locals, params }) => {
		try {
			await core.email.deleteDomain(locals.principal!, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/email/domains');
	}
};
