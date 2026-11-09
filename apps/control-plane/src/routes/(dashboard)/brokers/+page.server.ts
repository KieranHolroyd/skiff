import { fail, redirect } from '@sveltejs/kit';
import {
	brokerCreateSchema,
	brokerEngineRegistry,
	hasPermission,
	type BrokerView,
	type NodeCapacityView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../databases/_lib/forms.server.js';
import { brokerCan } from './_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Managed queue brokers (docs/BROKERS.md, D111). Every check lives in `core.brokers`. */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view = url.searchParams.get('view') === 'trash' ? ('trash' as const) : ('live' as const);

	let all: BrokerView[] = [];
	let denied = false;
	try {
		all = core.brokers.list(principal, { includeDeleted: true });
	} catch {
		denied = true;
	}

	// Node choices come from capacity, which only platform admins can read (same as databases).
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
				.filter((project) => project.runtime === 'process' || project.runtime === 'container' || project.runtime === 'function')
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }));
		} catch {
			// Attach-on-create is optional.
		}
	}

	return {
		/** Storage targets the create form offers (docs/STORAGE.md §2.2). */
		storageChoices: core.disks.choices('brokers'),
		view,
		denied,
		enabled: features.BROKERS,
		brokers: all.filter((item) => !item.deletedAt),
		trash: all.filter((item) => item.deletedAt),
		capacity,
		projects,
		engine: brokerEngineRegistry.nats,
		brokerCan: brokerCan(principal)
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
			cpus: formString(data, 'cpus'),
			storageMb: formString(data, 'storageMb'),
			storage: formString(data, 'storage'),
			project: formString(data, 'project'),
			envPrefix: formString(data, 'envPrefix').toUpperCase()
		};
		const input = {
			name: values.name,
			engine: 'nats' as const,
			version: values.version || undefined,
			placement: values.placement,
			memoryMb: optionalNumber(values.memoryMb),
			cpus: optionalNumber(values.cpus),
			storageMb: optionalNumber(values.storageMb),
			storage: values.storage || undefined,
			project: values.project || undefined,
			envPrefix: values.project ? values.envPrefix || undefined : undefined
		};
		const parsed = brokerCreateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});

		let created: BrokerView;
		try {
			created = core.brokers.create(principal, input);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/brokers/${created.name}?created=1`);
	},

	restart: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'A broker name is required.' });
		try {
			core.brokers.restart(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Restarting ${name}. Clients reconnect; streams and consumers are kept.` };
	},

	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing broker name.' });
		try {
			core.brokers.restore(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `“${name}” restored. Its node starts it again on the next reconcile.` };
	},

	purge: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'Missing broker name.' });
		try {
			core.brokers.purgeNow(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: `“${name}” is being deleted permanently. Its node removes the data, then it disappears from the trash.`
		};
	}
};
