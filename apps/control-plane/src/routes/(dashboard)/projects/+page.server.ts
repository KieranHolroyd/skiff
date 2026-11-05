import { fail, redirect } from '@sveltejs/kit';
import { accessModes, getAppTemplate, runtimes, type OperationView } from '@skiff/contracts';
import { ValidationError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view =
		url.searchParams.get('view') === 'trash' ? ('trash' as const) : ('projects' as const);
	let capacity: Awaited<ReturnType<typeof core.workloads.capacity>> = [];
	if (principal.platformAdmin === true) {
		try {
			capacity = core.workloads.capacity(principal);
		} catch {
			// Platform capacity is a nicety for admins; project creation still works without it.
		}
	}
	// Bulk actions come from the registry, already filtered to what this viewer may run.
	const actions = core.operations
		.actions(principal)
		.filter((action) => action.appliesTo === 'projects' || action.appliesTo === 'trash');
	// Resume the progress card if the viewer reloads while one of their bulk actions runs.
	let activeBulk: OperationView | null = null;
	try {
		activeBulk =
			core.operations
				.list(principal, { kind: 'bulk', status: 'applying', limit: 10 })
				.find((operation) => operation.actor.id === principal.userId) ?? null;
	} catch {
		// History needs project:read; without it there is nothing to resume.
	}
	let templates: ReturnType<typeof core.templates.list> = [];
	try {
		templates = core.templates.list(principal);
	} catch {
		// No project:read; the catalog is simply hidden.
	}
	return {
		view,
		templates,
		projects: core.projects.list(principal),
		trash: core.projects.list(principal, { onlyDeleted: true }),
		capacity,
		actions,
		activeBulk
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			slug: formString(data, 'slug'),
			runtime: formString(data, 'runtime') || 'static',
			placement: formString(data, 'placement') || 'edge',
			productionAccess: formString(data, 'productionAccess') || 'public',
			previewAccess: formString(data, 'previewAccess') || 'platform'
		};

		const fieldErrors: Record<string, string> = {};
		if (!values.name) fieldErrors.name = 'Give the project a name.';
		else if (values.name.length > 120)
			fieldErrors.name = 'Keep the name to 120 characters or fewer.';
		if (values.slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(values.slug)) {
			fieldErrors.slug =
				'Use 3–40 lowercase letters, digits and single hyphens; start and end with a letter or digit.';
		}
		if (!(accessModes as readonly string[]).includes(values.productionAccess)) {
			fieldErrors.productionAccess = 'Choose a valid production access mode.';
		}
		if (!(accessModes as readonly string[]).includes(values.previewAccess)) {
			fieldErrors.previewAccess = 'Choose a valid preview access mode.';
		}
		if (!(runtimes as readonly string[]).includes(values.runtime)) {
			fieldErrors.runtime = 'Choose a valid runtime.';
		}
		if (!values.placement) fieldErrors.placement = 'Choose a placement.';

		if (Object.keys(fieldErrors).length > 0) {
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors, values });
		}

		let project: Awaited<ReturnType<typeof core.projects.create>>;
		try {
			project = await core.projects.create(principal, {
				name: values.name,
				slug: values.slug || undefined,
				runtime: values.runtime as (typeof runtimes)[number],
				placement: values.placement,
				productionAccess: values.productionAccess as (typeof accessModes)[number],
				previewAccess: values.previewAccess as (typeof accessModes)[number]
			});
		} catch (error) {
			const failure = toFormFailure(error);
			return fail(failStatus(error), { ...failure, values });
		}

		redirect(303, `/projects/${project.slug}`);
	},

	/** Plan 21: create, configure and deploy a project from a first-party template. */
	fromTemplate: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'template');
		const template = getAppTemplate(id);
		if (!template) return fail(400, { message: 'Choose a template.' });
		// Only the template's own fields (plus placement) are read; anything else is ignored.
		const values: Record<string, unknown> = { placement: formString(data, 'placement') || 'auto' };
		for (const field of template.fields) {
			const raw = data.get(field.key);
			if (typeof raw !== 'string') continue;
			// Keep a PEM's line breaks; trim everything else.
			values[field.key] = field.kind === 'textarea' ? raw : raw.trim();
		}

		let slug: string;
		try {
			const created = await core.templates.instantiate(principal, id, values);
			slug = created.project.slug;
		} catch (error) {
			const failure = toFormFailure(error);
			const fieldErrors: Record<string, string> = {};
			if (error instanceof ValidationError) {
				for (const issue of error.issues) {
					if (typeof issue !== 'string') continue;
					const [key, ...rest] = issue.split(': ');
					if (key && rest.length > 0 && !fieldErrors[key]) fieldErrors[key] = rest.join(': ');
				}
			}
			// Never echo credentials back into the page.
			return fail(failStatus(error), { ...failure, template: id, fieldErrors });
		}

		redirect(303, `/projects/${slug}`);
	},

	delete: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'slug');
		if (!slug) return fail(400, { message: 'Missing project slug.' });

		try {
			await core.projects.softDelete(principal, slug);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}

		return {
			success: `“${slug}” moved to the trash. It is kept for 7 days before permanent deletion.`
		};
	},

	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'slug');
		if (!slug) return fail(400, { message: 'Missing project slug.' });

		try {
			await core.projects.restore(principal, slug);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}

		return { success: `“${slug}” restored.` };
	}
};
