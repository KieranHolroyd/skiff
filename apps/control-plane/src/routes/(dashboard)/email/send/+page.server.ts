import { fail, redirect } from '@sveltejs/kit';
import type { EmailDomainView, EmailOrgView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formRawString, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Compose and send one message from the dashboard (docs/EMAIL.md §5): the same `EmailService.send`
 * as REST, so policy, suppression and the sandbox apply. Meant for checking a domain end to end.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	let domains: EmailDomainView[] = [];
	let org: EmailOrgView | null = null;
	try {
		domains = core.email.listDomains(principal).filter((domain) => domain.status === 'verified' && domain.sending);
		org = core.email.orgView(principal);
	} catch {
		// The page explains what is missing.
	}
	return {
		domains: domains.map((domain) => domain.name),
		org,
		/** `?domain=` preselects a domain, e.g. from its detail page. */
		preferred: url.searchParams.get('domain'),
		me: locals.user?.email ?? null
	};
};

/** `a@x.com, B <b@y.com>` → addresses; the core validates each. */
function addresses(text: string): string[] {
	return text
		.split(/[,;\n]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => /<([^>]+)>/.exec(item)?.[1]?.trim() ?? item);
}

export const actions: Actions = {
	send: async ({ request, locals }) => {
		const data = await request.formData();
		const values = {
			fromName: formString(data, 'fromName'),
			fromLocal: formString(data, 'fromLocal'),
			domain: formString(data, 'domain'),
			to: formRawString(data, 'to'),
			subject: formString(data, 'subject'),
			format: formString(data, 'format') || 'text',
			body: formRawString(data, 'body')
		};
		const from = `${values.fromLocal}@${values.domain}`;
		let id: string;
		try {
			const result = await core.email.send(locals.principal!, {
				from: values.fromName ? { name: values.fromName, address: from } : from,
				to: addresses(values.to),
				subject: values.subject,
				...(values.format === 'html' ? { html: values.body } : { text: values.body }),
				tags: { source: 'dashboard-test' }
			});
			id = result.id;
			if (result.accepted.length === 0)
				return fail(422, { message: 'Every recipient is on the suppression list, so nothing was sent.', values });
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), values });
		}
		redirect(303, `/email/activity/${encodeURIComponent(id)}?sent=1`);
	}
};
