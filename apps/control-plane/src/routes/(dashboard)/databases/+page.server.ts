import { fail, redirect } from '@sveltejs/kit';
import {
	databaseCreateSchema,
	databaseEngineRegistry,
	databaseEngines,
	databaseVariants,
	type DatabaseEngine,
	type DatabaseVariant,
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
	if (core.ctx.platformIam.canView(principal)) {
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
		/** Storage targets the create form offers (docs/STORAGE.md §2.2). */
		storageChoices: core.disks.choices('databases'),
		view,
		denied,
		databases: all.filter((database) => !database.deletedAt),
		trash: all.filter((database) => database.deletedAt),
		capacity,
		projects,
		engine: databaseEngineRegistry.postgres,
		/** Every engine the create form offers, in registry order (Postgres first). */
		engines: databaseEngines.map((engine) => databaseEngineRegistry[engine]),
		dbCan: databaseCan(principal)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			engine: formString(data, 'engine') || 'postgres',
			version: formString(data, 'version'),
			variant: formString(data, 'variant'),
			placement: formString(data, 'placement') || 'auto',
			memoryMb: formString(data, 'memoryMb'),
			storageMb: formString(data, 'storageMb'),
			storage: formString(data, 'storage'),
			project: formString(data, 'project'),
			envPrefix: formString(data, 'envPrefix').toUpperCase()
		};

		const engine = (databaseEngines as readonly string[]).includes(values.engine)
			? (values.engine as DatabaseEngine)
			: 'postgres';
		const input = {
			name: values.name,
			engine,
			version: values.version || undefined,
			variant: (databaseVariants as readonly string[]).includes(values.variant)
				? (values.variant as DatabaseVariant)
				: undefined,
			placement: values.placement,
			memoryMb: optionalNumber(values.memoryMb),
			storageMb: optionalNumber(values.storageMb),
			storage: values.storage || undefined,
			project: values.project || undefined,
			// Empty: the engine's default prefix (DATABASE, MONGODB or REDIS).
			envPrefix: values.project ? values.envPrefix || databaseEngineRegistry[engine].defaultEnvPrefix : undefined
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

	restart: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'A database name is required.' });
		try {
			core.databases.restart(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `Restarting ${name}. The node restarts the container and its pooler; data and credentials are kept.`
		};
	},

	'restart-all': async ({ locals }) => {
		const principal = locals.principal!;
		try {
			const result = core.serviceActions.restart(principal, { scope: 'databases' });
			return {
				success: `Restarting ${result.restarted.databases.length} database${result.restarted.databases.length === 1 ? '' : 's'}.`,
				warning:
					result.skipped.length > 0
						? `${result.skipped.length} skipped: ${result.skipped.map((item) => item.name).join(', ')}.`
						: null
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	'restart-all-services': async ({ locals }) => {
		const principal = locals.principal!;
		try {
			const result = core.serviceActions.restart(principal, { scope: 'all' });
			return {
				success: `Restarting ${result.restarted.databases.length} database${result.restarted.databases.length === 1 ? '' : 's'} and ${result.restarted.storage.length} storage instance${result.restarted.storage.length === 1 ? '' : 's'}.`,
				warning:
					result.skipped.length > 0
						? `${result.skipped.length} skipped: ${result.skipped.map((item) => item.name).join(', ')}.`
						: null
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	'backup-all': async ({ locals }) => {
		const principal = locals.principal!;
		try {
			const result = core.serviceActions.backupAllDatabases(principal);
			return {
				success: `Queued ${result.queued.length} backup${result.queued.length === 1 ? '' : 's'}.`,
				warning:
					result.skipped.length > 0
						? `${result.skipped.length} skipped: ${result.skipped.map((item) => item.name).join(', ')}.`
						: null
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
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
