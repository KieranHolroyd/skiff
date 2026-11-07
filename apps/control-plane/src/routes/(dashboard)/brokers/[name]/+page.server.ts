import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import {
	brokerAttachSchema,
	brokerUpdateSchema,
	hasPermission,
	type BrokerMetricPoint,
	type BrokerQueuesView,
	type BrokerView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../../databases/_lib/forms.server.js';
import { brokerCan } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	let broker: BrokerView;
	try {
		broker = core.brokers.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const attached = new Set(broker.attachments.map((item) => item.projectSlug));
	let projects: Array<{ slug: string; name: string; runtime: string }> = [];
	if (hasPermission(principal, 'project:update')) {
		try {
			projects = core.projects
				.list(principal)
				.filter(
					(project) =>
						(project.runtime === 'process' || project.runtime === 'container' || project.runtime === 'function') &&
						!attached.has(project.slug)
				)
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }));
		} catch {
			// Attaching is optional.
		}
	}

	// Same presets as the storage and traffic pages: minute buckets up to a day, hourly beyond 48 h.
	const range = parseTrafficRange(url.searchParams.get('range'));
	let metrics: BrokerMetricPoint[] = [];
	try {
		metrics = await core.brokers.metrics(principal, params.name, {
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

	// The newest stream listing lives in SQLite, so it shows even without ClickHouse (D123).
	let queues: BrokerQueuesView | null = null;
	try {
		queues = core.brokers.queues(principal, params.name);
	} catch {
		queues = null;
	}

	return {
		broker,
		projects,
		brokerCan: brokerCan(principal),
		metrics,
		queues,
		telemetryAvailable: (await core.ctx.telemetry?.ready()) ?? false,
		telemetryInstalled: core.ctx.telemetry?.installed ?? false,
		telemetryReason: core.ctx.telemetry?.error?.message ?? null,
		range,
		ranges: trafficRanges,
		rangeLinks
	};
};

export const actions: Actions = {
	/** Revealed on demand and audited; never part of page data (as D58). */
	credentials: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			return { credentials: core.brokers.credentials(principal, params.name) };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			version: formString(data, 'version'),
			memoryMb: formString(data, 'memoryMb'),
			cpus: formString(data, 'cpus'),
			storageMb: formString(data, 'storageMb')
		};
		const parsed = brokerUpdateSchema.safeParse({
			version: values.version || undefined,
			memoryMb: optionalNumber(values.memoryMb),
			cpus: optionalNumber(values.cpus),
			storageMb: optionalNumber(values.storageMb)
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		try {
			core.brokers.update(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), values });
		}
		return { success: `${params.name} updated. Its node restarts it with the new settings; streams are kept.` };
	},

	attach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const project = formString(data, 'project');
		const envPrefix = formString(data, 'envPrefix').toUpperCase();
		const parsed = brokerAttachSchema.safeParse({ broker: params.name, envPrefix: envPrefix || undefined });
		if (!parsed.success)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors: fieldErrorsFrom(parsed.error.issues) });
		if (!project) return fail(400, { message: 'Pick a project.', fieldErrors: { project: 'Pick a project.' } });
		try {
			const { attachment, warning } = core.brokers.attach(
				principal,
				core.projects.requireRow(principal, project),
				parsed.data
			);
			return {
				success: `Attached to ${attachment.projectSlug} as ${attachment.envPrefix}. A running app restarts with the new variables.`,
				warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const project = formString(await request.formData(), 'project');
		if (!project) return fail(400, { message: 'Missing project.' });
		try {
			core.brokers.detach(principal, core.projects.requireRow(principal, project), params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Detached from ${project}. The app restarts without its broker variables.` };
	},

	restart: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.brokers.restart(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Restarting ${params.name}. Clients reconnect; streams and consumers are kept.` };
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.brokers.delete(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/brokers?view=trash');
	},

	restore: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.brokers.restore(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `“${params.name}” restored. Its node starts it again on the next reconcile.` };
	},

	purge: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.brokers.purgeNow(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/brokers?view=trash');
	}
};
