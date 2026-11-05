import { fail, redirect } from '@sveltejs/kit';
import {
	databaseCreateSchema,
	databaseEngineRegistry,
	hasPermission,
	type DatabaseView,
	type NodeCapacityView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { databaseCan, fieldErrorsFrom, optionalNumber } from './_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view = url.searchParams.get('view') === 'trash' ? ('trash' as const) : ('live' as const);

	let all: DatabaseView[] = [];
	let denied = false;
	try {
		all = core.databases.list(principal, { includeDeleted: true });
	} catch {
		denied = true;
	}

	// Node choices come from capacity, which only platform admins can read (same as projects).
	let capacity: NodeCapacityView[] = [];
	if (principal.platformAdmin === true) {
		try {
			capacity = core.workloads.capacity(principal);
		} catch {
			// Creating still works with `auto` / `edge`.
		}
	}

	let projects: Array<{ slug: string; name: string; runtime: string }> = [];
	if (hasPermission(principal, 'project:update')) {
		try {
			projects = core.projects
				.list(principal)
				.filter((project) => project.runtime !== 'static')
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }));
		} catch {
			// Attach-on-create is optional.
		}
	}

	return {
		view,
		denied,
		databases: all.filter((database) => !database.deletedAt),
		trash: all.filter((database) => database.deletedAt),
		capacity,
		projects,
		engine: databaseEngineRegistry.postgres,
		dbCan: databaseCan(principal)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			version: formString(data, 'version'),
			placement: formString(data, 'placement') || 'auto',
			memoryMb: formString(data, 'memoryMb'),
			storageMb: formString(data, 'storageMb'),
			project: formString(data, 'project'),
			envPrefix: formString(data, 'envPrefix').toUpperCase()
		};

		const input = {
			name: values.name,
			engine: 'postgres' as const,
			version: values.version || undefined,
			placement: values.placement,
			memoryMb: optionalNumber(values.memoryMb),
			storageMb: optionalNumber(values.storageMb),
			project: values.project || undefined,
			envPrefix: values.project ? values.envPrefix || 'DATABASE' : undefined
		};
		const parsed = databaseCreateSchema.safeParse(input);
		if (!parsed.success) {
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		}

		let created: DatabaseView;
		try {
			created = core.databases.create(principal, input);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/databases/${created.name}?created=1`);
	},

	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing database name.' });
		try {
			core.databases.restore(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `“${name}” restored. Its node starts it again on the next reconcile.` };
	},

	purge: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing database name.' });
		try {
			core.databases.purgeNow(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `“${name}” is being deleted permanently. Its node removes the data, then it disappears from the trash.`
		};
	}
};
