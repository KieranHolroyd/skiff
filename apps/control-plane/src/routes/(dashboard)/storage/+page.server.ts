import { fail, redirect } from '@sveltejs/kit';
import {
	hasPermission,
	storageCreateSchema,
	storageEngineRegistry,
	type NodeCapacityView,
	type StorageView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../databases/_lib/forms.server.js';
import { bucketList, storageCan } from './_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view = url.searchParams.get('view') === 'trash' ? ('trash' as const) : ('live' as const);

	let all: StorageView[] = [];
	let denied = false;
	try {
		all = core.storage.list(principal, { includeDeleted: true });
	} catch {
		denied = true;
	}

	// Node choices come from capacity, which only platform admins can read (same as databases).
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
		instances: all.filter((item) => !item.deletedAt),
		trash: all.filter((item) => item.deletedAt),
		capacity,
		projects,
		engine: storageEngineRegistry.rustfs,
		storageCan: storageCan(principal)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			buckets: formString(data, 'buckets'),
			public: formBoolean(data, 'public'),
			placement: formString(data, 'placement') || 'auto',
			memoryMb: formString(data, 'memoryMb'),
			cpus: formString(data, 'cpus'),
			storageMb: formString(data, 'storageMb'),
			project: formString(data, 'project'),
			envPrefix: formString(data, 'envPrefix').toUpperCase()
		};

		const input = {
			name: values.name,
			engine: 'rustfs' as const,
			placement: values.placement,
			memoryMb: optionalNumber(values.memoryMb),
			cpus: optionalNumber(values.cpus),
			storageMb: optionalNumber(values.storageMb),
			public: values.public,
			buckets: bucketList(values.buckets),
			project: values.project || undefined,
			envPrefix: values.project ? values.envPrefix || 'S3' : undefined
		};
		const parsed = storageCreateSchema.safeParse(input);
		if (!parsed.success) {
			const fieldErrors = fieldErrorsFrom(parsed.error.issues);
			// Per-bucket issues arrive as `buckets.0`; show them on the one buckets field.
			for (const [key, message] of Object.entries(fieldErrors)) {
				if (key.startsWith('buckets.') && !fieldErrors.buckets) {
					const index = Number(key.split('.')[1]);
					fieldErrors.buckets = `${input.buckets[index] ?? 'Bucket'}: ${message}`;
				}
			}
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors, values });
		}

		let created: StorageView;
		try {
			created = core.storage.create(principal, input);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/storage/${created.name}?created=1`);
	},

	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing storage name.' });
		try {
			core.storage.restore(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `“${name}” restored. Its node starts it again on the next reconcile.` };
	},

	purge: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing storage name.' });
		try {
			core.storage.purgeNow(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `“${name}” is being deleted permanently. Its node removes the data, then it disappears from the trash.`
		};
	}
};
