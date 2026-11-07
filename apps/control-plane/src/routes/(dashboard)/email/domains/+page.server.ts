import { fail, redirect } from '@sveltejs/kit';
import { emailDomainCreateSchema, type EmailDomainView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Sending domains (docs/EMAIL.md §4). Every check lives in `core.email`. */
export const load: PageServerLoad = ({ locals }) => {
	let domains: EmailDomainView[] = [];
	let denied = false;
	try {
		domains = core.email.listDomains(locals.principal!);
	} catch {
		denied = true;
	}
	return { denied, domains };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name').toLowerCase(),
			sending: formBoolean(data, 'sending'),
			autoDns: formBoolean(data, 'autoDns')
		};
		const parsed = emailDomainCreateSchema.safeParse(values);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});

		let created: EmailDomainView;
		try {
			created = await core.email.createDomain(principal, values);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/email/domains/${encodeURIComponent(created.name)}?created=1`);
	},

	check: async ({ request, locals }) => {
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'A domain name is required.' });
		try {
			const domain = await core.email.checkDomain(locals.principal!, name);
			return {
				success:
					domain.status === 'verified'
						? `${domain.name} is verified.`
						: `Checked ${domain.name}: ${domain.records.filter((record) => record.required && !record.ok).length} required record(s) still missing.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	}
};
