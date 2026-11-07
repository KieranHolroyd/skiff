import { fail } from '@sveltejs/kit';
import {
	emailCredentialCreateSchema,
	hasPermission,
	type EmailCredentialSecret,
	type EmailCredentialView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** SMTP credentials (docs/EMAIL.md §5.4). The password is shown once, from the create action. */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let credentials: EmailCredentialView[] = [];
	let domains: string[] = [];
	let denied = false;
	try {
		credentials = core.email.listCredentials(principal);
		domains = core.email.listDomains(principal).map((domain) => domain.name);
	} catch {
		denied = true;
	}

	let projects: Array<{ slug: string; name: string }> = [];
	if (hasPermission(principal, 'email:credentials')) {
		try {
			projects = core.projects
				.list(principal)
				.map((project) => ({ slug: project.slug, name: project.name }));
		} catch {
			// Project scope is optional.
		}
	}

	return { denied, credentials, domains, projects };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			project: formString(data, 'project'),
			allowedFromDomains: data
				.getAll('allowedFromDomains')
				.filter((value): value is string => typeof value === 'string' && value !== '')
		};
		const input = {
			name: values.name,
			project: values.project || undefined,
			allowedFromDomains: values.allowedFromDomains
		};
		const parsed = emailCredentialCreateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		let created: EmailCredentialSecret;
		try {
			created = core.email.createCredential(locals.principal!, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), values });
		}
		return { created };
	},

	revoke: async ({ request, locals }) => {
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing credential id.' });
		try {
			core.email.revokeCredential(locals.principal!, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Credential revoked. SMTP logins with it are refused from now on.' };
	}
};
