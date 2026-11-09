import { error, fail, redirect } from '@sveltejs/kit';
import { getAppTemplate } from '@skiff/contracts';
import { CoreError, ValidationError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let template: ReturnType<typeof core.templates.get>;
	try {
		template = core.templates.get(principal, params.template);
	} catch (cause) {
		if (cause instanceof CoreError && cause.status === 403) error(403, cause.message);
		error(404, 'There is no template with that name.');
	}

	// Node capacity drives the placement picker's fit check; only platform admins may see it.
	let capacity: ReturnType<typeof core.workloads.capacity> = [];
	if (core.ctx.platformIam.canView(principal)) {
		try {
			capacity = core.workloads.capacity(principal);
		} catch {
			// Placement still works without the numbers.
		}
	}

	// Organisation secrets a template can reference instead of a pasted credential. A new project
	// has no secrets of its own yet, so these are the only names that can resolve.
	let secretNames: string[] = [];
	try {
		secretNames = [
			...new Set(
				core.secrets
					.list(principal, { projectId: null })
					.filter((secret) => secret.type === 'secret')
					.map((secret) => secret.name)
			)
		].sort();
	} catch {
		// No secret:read-metadata; suggestions and the existence check are skipped.
	}

	return { template, capacity, secretNames: secretNames.length > 0 ? secretNames : null };
};

export const actions: Actions = {
	/** Create, configure and deploy a project from the template in one audited operation. */
	default: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const template = getAppTemplate(params.template);
		if (!template) return fail(404, { message: 'There is no template with that name.' });
		const data = await request.formData();
		// Only the template's own fields (plus slug and placement) are read; anything else is ignored.
		const values: Record<string, unknown> = { placement: formString(data, 'placement') || 'auto' };
		const slug = formString(data, 'slug');
		if (slug) values.slug = slug;
		for (const field of template.fields) {
			const raw = data.get(field.key);
			if (typeof raw !== 'string') continue;
			// Keep a PEM's line breaks; trim everything else.
			values[field.key] = field.kind === 'textarea' ? raw : raw.trim();
		}

		let created: Awaited<ReturnType<typeof core.templates.instantiate>>;
		try {
			created = await core.templates.instantiate(principal, template.id, values);
		} catch (cause) {
			const failure = toFormFailure(cause);
			const fieldErrors: Record<string, string> = {};
			if (cause instanceof ValidationError) {
				for (const issue of cause.issues) {
					if (typeof issue !== 'string') continue;
					const [key, ...rest] = issue.split(': ');
					if (key && rest.length > 0 && !fieldErrors[key]) fieldErrors[key] = rest.join(': ');
				}
			}
			// A taken slug comes back as a conflict with suggestions; show it on the slug field.
			if (failure.code === 'conflict' && failure.suggestions?.length && !fieldErrors.slug)
				fieldErrors.slug = failure.message;
			// Never echo credentials back into the page.
			return fail(failStatus(cause), { ...failure, fieldErrors });
		}

		redirect(303, `/projects/${created.project.slug}`);
	}
};
