import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError, entriesFromZip } from '@skiff/core';
import { accessModes, hasPermission, type NodeCapacityView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!features.FUNCTIONS) error(404, 'Functions are not enabled on this platform.');
	if (!hasPermission(principal, 'project:create'))
		error(403, 'Your role cannot create functions in this organisation.');
	let capacity: NodeCapacityView[] = [];
	if (principal.platformAdmin === true) {
		try {
			capacity = core.workloads.capacity(principal);
		} catch {
			// Auto and edge placement still work.
		}
	}
	return { capacity, canDeploy: hasPermission(principal, 'deployment:create') };
};

export const actions: Actions = {
	/**
	 * Create a function (stored as a `runtime: "function"` project, D110) and, when a bundle is
	 * attached, deploy and promote it in the same step.
	 */
	default: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			slug: formString(data, 'slug'),
			placement: formString(data, 'placement') || 'auto',
			productionAccess: formString(data, 'productionAccess') || 'public',
			previewAccess: formString(data, 'previewAccess') || 'platform'
		};
		const bundle = data.get('bundle');
		const hasBundle = bundle instanceof File && bundle.size > 0;

		const fieldErrors: Record<string, string> = {};
		if (!values.name) fieldErrors.name = 'Give the function a name.';
		else if (values.name.length > 120)
			fieldErrors.name = 'Keep the name to 120 characters or fewer.';
		if (values.slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(values.slug))
			fieldErrors.slug =
				'Use 3–40 lowercase letters, digits and single hyphens; start and end with a letter or digit.';
		if (!(accessModes as readonly string[]).includes(values.productionAccess))
			fieldErrors.productionAccess = 'Choose a valid access mode.';
		if (!(accessModes as readonly string[]).includes(values.previewAccess))
			fieldErrors.previewAccess = 'Choose a valid access mode.';
		if (hasBundle && !bundle.name.toLowerCase().endsWith('.zip'))
			fieldErrors.bundle = 'Upload the bundle as a .zip archive.';

		let entries: ReturnType<typeof entriesFromZip> | null = null;
		if (hasBundle && !fieldErrors.bundle) {
			try {
				entries = entriesFromZip(new Uint8Array(await bundle.arrayBuffer()));
			} catch (caught) {
				fieldErrors.bundle =
					caught instanceof CoreError ? caught.message : 'That file could not be read as a zip.';
			}
		}
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors, values });

		let slug: string;
		try {
			const project = await core.projects.create(principal, {
				name: values.name,
				slug: values.slug || undefined,
				runtime: 'function',
				placement: values.placement,
				productionAccess: values.productionAccess as (typeof accessModes)[number],
				previewAccess: values.previewAccess as (typeof accessModes)[number]
			});
			slug = project.slug;
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), values });
		}

		if (entries) {
			try {
				const row = core.projects.requireRow(principal, slug);
				await core.deployments.deployEntries(principal, row, entries, {
					promote: true,
					environment: 'production',
					message: 'Initial deploy',
					precompress: true
				});
			} catch (caught) {
				// The function exists; send the user to it with the reason the bundle was refused.
				const reason = caught instanceof Error ? caught.message : 'The bundle was rejected.';
				redirect(
					303,
					`/functions/${encodeURIComponent(slug)}?tab=deployments&rejected=${encodeURIComponent(reason)}`
				);
			}
		}
		redirect(303, `/functions/${encodeURIComponent(slug)}`);
	}
};
