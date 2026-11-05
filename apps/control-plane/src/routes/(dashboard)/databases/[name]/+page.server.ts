import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import {
	databaseAttachSchema,
	databaseEngineRegistry,
	databaseUpdateSchema,
	hasPermission,
	type DatabaseMetricPoint,
	type DatabaseView,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { databaseCan, fieldErrorsFrom, optionalNumber } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	let database;
	try {
		database = core.databases.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	// Same presets as the traffic page: minute buckets up to a day, hourly rollups beyond 48 h.
	const range = parseTrafficRange(url.searchParams.get('range'));
	let metrics: DatabaseMetricPoint[] = [];
	try {
		metrics = await core.databases.metrics(principal, params.name, {
			from: range.from,
			to: range.to,
			interval: range.interval
		});
	} catch {
		// Charts are a nicety; the page still works without them.
	}
	const rangeLinks = Object.fromEntries(
		trafficRanges.map((item) => [item.key, trafficRangeHref(url, item.key)])
	);

	const attached = new Set(database.attachments.map((item) => item.projectSlug));
	let projects: Array<{ slug: string; name: string; runtime: string }> = [];
	if (hasPermission(principal, 'project:update')) {
		try {
			projects = core.projects
				.list(principal)
				.filter((project) => project.runtime !== 'static' && !attached.has(project.slug))
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }));
		} catch {
			// Attaching is optional.
		}
	}

	return {
		database,
		metrics,
		telemetryAvailable: core.ctx.telemetry?.available ?? false,
		range,
		ranges: trafficRanges,
		rangeLinks,
		projects,
		engine: databaseEngineRegistry[database.engine],
		dbCan: databaseCan(principal)
	};
};

function projectRow(principal: Principal, slug: string) {
	return core.projects.requireRow(principal, slug);
}

export const actions: Actions = {
	credentials: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const credentials = core.databases.credentials(principal, params.name);
			return { credentials };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		let current: DatabaseView;
		try {
			current = core.databases.get(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		const next = {
			memoryMb: optionalNumber(formString(data, 'memoryMb')),
			cpus: optionalNumber(formString(data, 'cpus')),
			storageMb: optionalNumber(formString(data, 'storageMb'))
		};
		// Only send what changed, so an unchanged field never re-runs admission.
		const patch: Record<string, number> = {};
		if (next.memoryMb !== undefined && next.memoryMb !== current.memoryMb)
			patch.memoryMb = next.memoryMb;
		if (next.cpus !== undefined && next.cpus !== current.cpus) patch.cpus = next.cpus;
		if (next.storageMb !== undefined && next.storageMb !== current.storageMb)
			patch.storageMb = next.storageMb;
		if (Object.keys(patch).length === 0) return { success: 'Nothing changed.' };

		const parsed = databaseUpdateSchema.safeParse(patch);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the resources.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			core.databases.update(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Resources saved. The node restarts the database with the new limits on its next reconcile.'
		};
	},

	attach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		const envPrefix = formString(data, 'envPrefix').toUpperCase() || 'DATABASE';
		if (!slug)
			return fail(400, {
				message: 'Choose a project.',
				fieldErrors: { project: 'Choose a project.' }
			});
		const parsed = databaseAttachSchema.safeParse({ database: params.name, envPrefix });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the env prefix.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const { attachment, warning } = core.databases.attach(
				principal,
				projectRow(principal, slug),
				parsed.data
			);
			return {
				success: `Attached to ${attachment.projectSlug} as ${attachment.envPrefix}_URL. The app restarts with the new env.`,
				warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const slug = formString(await request.formData(), 'project');
		if (!slug) return fail(400, { message: 'Missing project.' });
		try {
			core.databases.detach(principal, projectRow(principal, slug), params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Detached from ${slug}. The app restarts without the database env.` };
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.delete(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: `“${params.name}” moved to the trash. Its data stays on the node for 7 days.`
		};
	},

	restore: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.restore(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `“${params.name}” restored. Its node starts it on the next reconcile.` };
	},

	purge: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.purgeNow(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/databases?view=trash');
	}
};
